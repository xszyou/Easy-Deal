"""EasyDeal Scheduler — stdio MCP server.

Owns all task storage (SQLite) and exposes CRUD tools to MCP clients.
The tools all return a uniform envelope::

    {"ok": true,  "data": ...}
    {"ok": false, "error": "..."}

so any caller (Claude Code, the Electron UI via its MCP client, etc.) sees
the same shape.

Storage: SQLite at ``$EASYDEAL_SCHEDULER_DB`` (default
``~/.easydeal/scheduler.db``). WAL mode is enabled so multiple processes
(e.g. the Electron sidecar and a Claude Code session) can read/write
concurrently without corruption.

This server is intentionally CRUD-only. The actual cron firing loop lives
in the Electron main process, which polls ``list_due_tasks`` and spawns
``claude --print`` for each fired task.
"""

import asyncio
import json
import logging
import os
import re
import sqlite3
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from croniter import croniter
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# ----------------------------------------------------------------------------
# Logging — to stderr only (stdout is reserved for MCP framing).
# ----------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s [scheduler_mcp] %(levelname)s %(message)s",
)
log = logging.getLogger("scheduler_mcp")

# ----------------------------------------------------------------------------
# DB
# ----------------------------------------------------------------------------

DEFAULT_DB = str(Path.home() / ".easydeal" / "scheduler.db")
DB_PATH = os.getenv("EASYDEAL_SCHEDULER_DB", DEFAULT_DB)
TZ = os.getenv("EASYDEAL_TZ", "Asia/Shanghai")

VALID_MODES = ("tool_only", "llm_inject", "llm_headless")
RUN_HISTORY_CAP = 500


def _db():
    """Open a SQLite connection with WAL mode + row-factory dicts."""
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


# 0.3.55: scheduler.db 损坏自愈。背景：作者本机扫到过 `PRAGMA integrity_check`
# 报错（Tree 5 page 28-32 SQLITE_CORRUPT、Tree 6 cell 2nd-reference、Rowid 乱序、
# 孤儿 page）。损坏后 INSERT 看似成功但读不出来 → AI 排的 cron 任务全部丢失 →
# 用户的回测自动轮询永远不 fire → 用户看不到结果。
#
# 自愈策略：scheduler_mcp 启动调 _init_db 之前，先跑 `PRAGMA integrity_check`：
#   - 结果 == 'ok' → 正常继续
#   - 任何其它 → quarantine 当前 db（含 wal/shm）到 .corrupt.<ts>，让 _init_db
#     创建全新的空库。tasks 表的 sys_* 系统 ticker 行不需要手工种 — Electron
#     主进程每分钟 record_system_run 会自动 INSERT OR IGNORE 进来。task_runs
#     历史会丢，但这是损坏的代价；备份文件保留给需要的话事后捞。
def _check_integrity_and_recover() -> dict:
    """Return {ok: bool, action: 'noop'|'recovered'|'fresh', detail: str|None}.

    Safe to call before _init_db. Does NOT raise — any error path falls back
    to letting _init_db create a fresh db on top of whatever's there.
    """
    if not os.path.isfile(DB_PATH):
        return {"ok": True, "action": "fresh", "detail": "no existing db"}
    try:
        conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
        try:
            rows = conn.execute("PRAGMA integrity_check").fetchall()
        finally:
            conn.close()
    except Exception as exc:
        # 连不上就当损坏处理 (file-level corruption / locked / 等)。
        log.warning("[integrity] open-failed: %s — treating as corrupt", exc)
        rows = [("open_failed",)]

    if rows and len(rows) == 1 and rows[0][0] == "ok":
        return {"ok": True, "action": "noop", "detail": None}

    # 损坏 — quarantine 后重建。每个文件最多 5 份历史备份；超过删最老的。
    summary = "; ".join(str(r[0])[:80] for r in (rows or [])[:5])
    ts = time.strftime("%Y%m%d_%H%M%S")
    backup_base = DB_PATH + ".corrupt." + ts
    moved = []
    for suffix in ("", "-wal", "-shm"):
        src = DB_PATH + suffix
        if os.path.isfile(src):
            dst = backup_base + suffix
            try:
                os.replace(src, dst)
                moved.append(os.path.basename(dst))
            except Exception as e:
                log.warning("[integrity] backup-move failed for %s: %s", src, e)
                # 移不动就 unlink 让 _init_db 能 mkdir/create
                try: os.unlink(src)
                except Exception: pass

    # 老备份兜底：保留最近 5 份 .corrupt.* 套件
    try:
        parent = Path(DB_PATH).parent
        prefix = Path(DB_PATH).name + ".corrupt."
        backups = sorted(
            (p for p in parent.iterdir() if p.name.startswith(prefix)),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        # 一份备份其实是 3 个文件，按 timestamp 分组保留最新 5 个 timestamp
        seen = set()
        for p in backups:
            parts = p.name[len(prefix):].split(".", 1)
            ts_key = parts[0] if parts else p.name
            if ts_key in seen:
                continue
            seen.add(ts_key)
            if len(seen) > 5:
                try: p.unlink()
                except Exception: pass
    except Exception:
        pass

    log.warning(
        "[integrity] CORRUPT detected — quarantined to %s; integrity_check said: %s",
        backup_base, summary[:200],
    )
    return {"ok": False, "action": "recovered", "detail": summary[:200]}


def _init_db():
    # 0.3.55: 损坏自愈 — schema 建表前先 integrity_check。撞坏的话 quarantine
    # 整套 db/wal/shm 到 .corrupt.<ts>，让下面 CREATE TABLE IF NOT EXISTS 直接
    # 建一份全新的库。sys_* ticker 行不需要手工 seed，Electron 主进程每分钟
    # record_system_run 会 INSERT OR IGNORE 自动补回。
    chk = _check_integrity_and_recover()
    if chk["action"] == "recovered":
        log.warning(
            "[init] scheduler.db rebuilt fresh after corruption recovery "
            "(detail: %s)", chk.get("detail") or "?"
        )
    with _db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                schedule      TEXT NOT NULL,
                kind          TEXT NOT NULL,            -- 'cron' or 'once'
                prompt        TEXT NOT NULL,
                mode          TEXT NOT NULL,            -- llm_headless / tool_only / llm_inject
                enabled       INTEGER NOT NULL DEFAULT 1,
                created_at    INTEGER NOT NULL,
                next_fire_at  INTEGER,
                last_fire_at  INTEGER,
                last_status   TEXT,
                notify        TEXT                      -- JSON array, e.g. '["chat","wechat"]'; NULL = silent
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_next_fire ON tasks(next_fire_at) WHERE enabled = 1;

            CREATE TABLE IF NOT EXISTS task_runs (
                id              TEXT PRIMARY KEY,
                task_id         TEXT NOT NULL,
                task_name       TEXT,
                started_at      INTEGER NOT NULL,
                finished_at     INTEGER,
                status          TEXT NOT NULL,
                result_summary  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_runs_task_started ON task_runs(task_id, started_at DESC);
            """
        )
        # Idempotent column add for existing DBs (CREATE TABLE IF NOT EXISTS
        # above does NOT add new columns to existing tables).
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
        if "notify" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN notify TEXT")
        # 1.4.x: 任务↔策略关联 — ea_name 归属某个策略(EA 文件名 stem)。
        # 关联后: ①fire 时策略未运行 → Node 侧自动跳过(自愈式暂停) ②llm_inject
        # 路由到该策略的独立会话。NULL = 不关联(全局任务, 行为不变)。
        if "ea_name" not in cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN ea_name TEXT")

        # 0.4.21: 僵尸 task_run 回收 — begin_run 写一条 status='running' 的 run,
        # 由 Node fireTask 跑完调 finish_run 改终态。若 Node 进程在两者之间被杀/
        # 重启 (EasyDeal 崩溃 / 升级重启 / headless claude 卡死被 OS 清理), 这条 run
        # 永远卡在 'running' (finished_at=NULL), 污染历史面板 + 让"该任务是否在跑"
        # 的判断误判。这里在 sidecar 启动时把**超过 30 分钟还 running** 的 run 标成
        # interrupted —— 30min 远超 headless 单次 fire 的 15min 上限, 不会误伤真正
        # 在飞的 fire (那种最多 15min 就会被 finish_run 收尾)。实测撞过: 用户机
        # 11:55 一条回测 poll run 卡 running 几十分钟没人收尾。
        try:
            cutoff = _now_ms() - 30 * 60 * 1000
            cur = conn.execute(
                "UPDATE task_runs SET status='interrupted', finished_at=?, "
                "result_summary=COALESCE(result_summary,'')||'[启动时回收: 进程在 finish_run 前退出]' "
                "WHERE status='running' AND finished_at IS NULL AND started_at < ?",
                (_now_ms(), cutoff),
            )
            if cur.rowcount:
                log.warning("[init] 回收 %d 条僵尸 running task_run (>30min 未收尾)", cur.rowcount)
        except Exception as _e:
            log.warning("[init] 僵尸 run 回收失败 (忽略): %s", _e)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def _gen_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000):x}_{uuid.uuid4().hex[:5]}"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _is_once_schedule(s: str) -> bool:
    if not isinstance(s, str):
        return False
    if not s[:5].count("-") >= 2 or "T" not in s[:13]:
        return False
    try:
        datetime.fromisoformat(s.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _parse_once_ms(s: str) -> int | None:
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def _next_cron_ms(expr: str) -> int | None:
    try:
        # cron 表达式按用户配置的 TZ（默认 Asia/Shanghai）解读，避免 host
        # 是 UTC 容器时把「每天 9:00」错误地理解成 UTC 9:00（北京 17:00）。
        try:
            from zoneinfo import ZoneInfo
            now = datetime.now(ZoneInfo(TZ))
        except Exception:
            import pytz as _pytz
            now = datetime.now(_pytz.timezone(TZ))
        it = croniter(expr, now)
        return int(it.get_next(datetime).timestamp() * 1000)
    except Exception:
        return None


def _row_to_task(row: sqlite3.Row | dict) -> dict:
    d = dict(row)
    d["enabled"] = bool(d.get("enabled"))
    # notify is stored as a JSON string; expose as a list to consumers.
    n = d.get("notify")
    if n:
        try: d["notify"] = json.loads(n)
        except Exception: d["notify"] = []
    else:
        d["notify"] = []
    # 1.4.x: ea_name 存 JSON 数组字符串, 暴露成 list。老行(升级前写的是裸字符串
    # 如 "GMarket", 非合法 JSON) → json.loads 抛异常 → 自动当单元素数组处理,
    # 读一次就完成迁移, 不需要额外的 DB migration 脚本。
    e = d.get("ea_name")
    if e:
        try:
            parsed = json.loads(e)
            d["ea_name"] = parsed if isinstance(parsed, list) else [str(parsed)]
        except Exception:
            d["ea_name"] = [e]
    else:
        d["ea_name"] = []
    return d


def _row_to_run(row: sqlite3.Row | dict) -> dict:
    return dict(row)


def _ok(data: Any) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps({"ok": True, "data": data}, ensure_ascii=False))]


def _err(msg: str) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))]


# ----------------------------------------------------------------------------
# Tool implementations
# ----------------------------------------------------------------------------

VALID_NOTIFY_CHANNELS = {"chat", "wechat"}


def _normalize_notify(raw) -> str | None:
    """Accept list[str] | str | None → return JSON-string or NULL.
    Invalid channels are silently dropped."""
    if raw is None or raw == "" or raw == []:
        return None
    if isinstance(raw, str):
        raw = [s.strip() for s in raw.split(",") if s.strip()]
    if not isinstance(raw, list):
        return None
    cleaned = sorted({c for c in (str(x).strip().lower() for x in raw) if c in VALID_NOTIFY_CHANNELS})
    return json.dumps(cleaned) if cleaned else None


def _normalize_ea_names(raw) -> str | None:
    """Accept list[str] | str | None → JSON array string or NULL.
    1.4.x 多策略关联: ea_name 列存 JSON 数组(如 '["GMarket","GMarket_v2"]')。
    str 输入按逗号分隔(兼容旧单值调用, 如 main.js 迁移脚本传单个 stem)。
    去重、去空白、保序。"""
    if raw is None or raw == "" or raw == []:
        return None
    if isinstance(raw, str):
        raw = [s.strip() for s in raw.split(",") if s.strip()]
    if not isinstance(raw, list):
        return None
    cleaned: list[str] = []
    seen: set[str] = set()
    for x in raw:
        s = str(x).strip()
        if s and s not in seen:
            seen.add(s)
            cleaned.append(s)
    return json.dumps(cleaned) if cleaned else None


def schedule_task(args: dict) -> list[TextContent]:
    name = (args.get("name") or "").strip()
    schedule = (args.get("schedule") or "").strip()
    prompt = args.get("prompt") or ""
    mode = args.get("mode") or "llm_headless"
    notify = _normalize_notify(args.get("notify"))
    # 1.4.x 任务↔策略关联(多对多): 优先取 ea_names(数组); 兼容旧调用传单值 ea_name(字符串)。
    ea_input = args.get("ea_names")
    if ea_input is None:
        ea_input = args.get("ea_name")
    ea_name = _normalize_ea_names(ea_input)   # 存进 tasks.ea_name 列的 JSON 数组字符串
    if not name or not schedule or not prompt:
        return _err("name / schedule / prompt are required")
    if mode not in VALID_MODES:
        return _err(f"unknown mode '{mode}', expected one of {'/'.join(VALID_MODES)}")

    once = _is_once_schedule(schedule)
    kind = "once" if once else "cron"
    next_fire = _parse_once_ms(schedule) if once else _next_cron_ms(schedule)
    if next_fire is None:
        return _err(
            f"invalid schedule '{schedule}': use a 5-field cron (e.g. '0 * * * *') or ISO datetime"
        )
    if once and next_fire <= _now_ms():
        return _err(f"one-shot schedule '{schedule}' is in the past")

    task = {
        "id":           _gen_id("t"),
        "name":         name[:200],
        "schedule":     schedule,
        "kind":         kind,
        "prompt":       prompt,
        "mode":         mode,
        "enabled":      1,
        "created_at":   _now_ms(),
        "next_fire_at": next_fire,
        "last_fire_at": None,
        "last_status":  None,
        "notify":       notify,
        "ea_name":      ea_name,
    }
    with _db() as conn:
        conn.execute(
            """INSERT INTO tasks
               (id, name, schedule, kind, prompt, mode, enabled, created_at,
                next_fire_at, last_fire_at, last_status, notify, ea_name)
               VALUES (:id, :name, :schedule, :kind, :prompt, :mode, :enabled,
                       :created_at, :next_fire_at, :last_fire_at, :last_status, :notify, :ea_name)""",
            task,
        )
    task["enabled"] = bool(task["enabled"])
    task["notify"] = json.loads(notify) if notify else []
    task["ea_name"] = json.loads(ea_name) if ea_name else []
    return _ok({"task": task})


def list_tasks(args: dict) -> list[TextContent]:
    enabled_only = bool(args.get("enabled_only"))
    # LEFT JOIN against the latest run per task — surfaces last_summary on
    # each task row so the UI can show "what did the last fire produce?"
    # inline without making N extra calls.
    sql = (
        "SELECT t.*, "
        "       lr.result_summary AS last_summary, "
        "       lr.started_at     AS last_run_started_at "
        "  FROM tasks t "
        "  LEFT JOIN ("
        "    SELECT r1.* FROM task_runs r1 "
        "    JOIN (SELECT task_id, MAX(started_at) AS max_started "
        "          FROM task_runs GROUP BY task_id) latest "
        "      ON r1.task_id = latest.task_id "
        "     AND r1.started_at = latest.max_started "
        "  ) lr ON lr.task_id = t.id"
    )
    if enabled_only:
        sql += " WHERE t.enabled = 1"
    sql += " ORDER BY (t.next_fire_at IS NULL), t.next_fire_at ASC"
    with _db() as conn:
        rows = conn.execute(sql).fetchall()
    return _ok({"tasks": [_row_to_task(r) for r in rows], "count": len(rows)})


def get_task(args: dict) -> list[TextContent]:
    tid = args.get("task_id")
    if not tid:
        return _err("task_id is required")
    with _db() as conn:
        # JOIN latest run so caller gets last_summary in one call (mirrors
        # list_tasks behaviour). System task rows often have NULL run history
        # until the first record_system_run, in which case last_summary stays NULL.
        row = conn.execute(
            "SELECT t.*, "
            "       lr.result_summary AS last_summary, "
            "       lr.started_at     AS last_run_started_at "
            "  FROM tasks t "
            "  LEFT JOIN ("
            "    SELECT r1.* FROM task_runs r1 "
            "    JOIN (SELECT task_id, MAX(started_at) AS max_started "
            "          FROM task_runs WHERE task_id = ? GROUP BY task_id) latest "
            "      ON r1.task_id = latest.task_id "
            "     AND r1.started_at = latest.max_started "
            "  ) lr ON lr.task_id = t.id "
            " WHERE t.id = ?",
            (tid, tid),
        ).fetchone()
    if not row:
        return _err(f"task not found: {tid}")
    return _ok({"task": _row_to_task(row)})


def cancel_task(args: dict) -> list[TextContent]:
    tid = args.get("task_id")
    force = bool(args.get("force"))   # 用户主动操作时可以加 force=True 绕过 guard
    if not tid:
        return _err("task_id is required")
    with _db() as conn:
        # 0.3.5 起：技术 guard —— 如果是自动注册的「回测进度 X bt_yyy」cron，
        # 在底层回测仍 queued/running 时拒绝 cancel。AI 偶尔会犯「status=running
        # 也调 cancel」的错（prompt 已经强化警告但 LLM 不百分百听话），
        # 这里在 SQL 删之前用 backtests.json 状态二次确认。
        # force=True 时绕过（用户在「我的策略」面板手动取消按钮调用）。
        if not force:
            row = conn.execute(
                "SELECT name FROM tasks WHERE id = ?", (tid,)
            ).fetchone()
            if row:
                name = row["name"] or ""
                # name 形如 "回测进度 GMarket bt_19e146715c5"
                m = re.match(r"^回测进度\s+\S+\s+(bt_[A-Za-z0-9]+)\s*$", name)
                if m:
                    bt_id = m.group(1)
                    bt_status = _peek_backtest_status(bt_id)
                    if bt_status in ("queued", "running"):
                        return _err(
                            f"refused: backtest {bt_id} status={bt_status} (non-terminal). "
                            f"this poll cron must stay alive until backtest reaches "
                            f"terminal state (ok / error / finished_no_report / config_error). "
                            f"if you really need to cancel, pass force=true"
                        )
        cur = conn.execute("DELETE FROM tasks WHERE id = ?", (tid,))
    return _ok({"removed": cur.rowcount > 0, "task_id": tid})


def _peek_backtest_status(bt_id: str) -> str | None:
    """0.3.5: 从 backtests.json 读某 bt 的最新 status。scheduler 在这里
    读取时只看持久化文件（不依赖 easydeal MCP 实例），轻量且安全。读不到
    返 None（视为未知，cancel guard 不挡）。"""
    bt_file = os.getenv("EASYDEAL_BACKTESTS_FILE")
    if not bt_file:
        # 兜底：scheduler.db 旁边
        bt_file = os.path.join(os.path.dirname(DB_PATH), "backtests.json")
    if not bt_file or not os.path.isfile(bt_file):
        return None
    try:
        with open(bt_file, "r", encoding="utf-8") as f:
            j = json.load(f)
        for ea, lst in (j.get("by_ea") or {}).items():
            for r in lst or []:
                if r.get("id") == bt_id:
                    return r.get("status")
    except Exception:
        return None
    return None


def clear_task_runs(args: dict) -> list[TextContent]:
    """清空某个 task 的全部 task_runs（保留 task 本身）— 用户在客户端
    点「清空历史」时调。AI 之后查 get_task_history 也拿不到这批了。"""
    tid = args.get("task_id")
    if not tid:
        return _err("task_id is required")
    with _db() as conn:
        cur = conn.execute("DELETE FROM task_runs WHERE task_id = ?", (tid,))
    return _ok({"removed": cur.rowcount, "task_id": tid})


def delete_task_run(args: dict) -> list[TextContent]:
    """删除单条 task_run — 用户在客户端历史面板删某一行时调。"""
    rid = args.get("run_id")
    if not rid:
        return _err("run_id is required")
    with _db() as conn:
        cur = conn.execute("DELETE FROM task_runs WHERE id = ?", (rid,))
    return _ok({"removed": cur.rowcount > 0, "run_id": rid})


def set_enabled(args: dict, enabled: bool) -> list[TextContent]:
    tid = args.get("task_id")
    if not tid:
        return _err("task_id is required")
    with _db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
        if not row:
            return _err(f"task not found: {tid}")
        new_enabled = 1 if enabled else 0
        new_next = row["next_fire_at"]
        if enabled and row["kind"] == "cron":
            new_next = _next_cron_ms(row["schedule"])
        conn.execute(
            "UPDATE tasks SET enabled = ?, next_fire_at = ? WHERE id = ?",
            (new_enabled, new_next, tid),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
    return _ok({"task": _row_to_task(row)})


def update_task(args: dict) -> list[TextContent]:
    """Update one or more mutable fields. Recomputes next_fire_at when
    schedule changes.

    notify 字段特殊处理：
      - 不传 (key 不在 args) → 不动 DB 里的旧值
      - 传 None / [] / 空字符串 → 写 NULL（静默：不通知任何通道）
      - 传 ["chat"] / ["wechat"] / ["chat","wechat"] → 写对应 JSON
    其他字段（name / schedule / prompt / mode）按 sqlite UPDATE 覆盖。
    """
    tid = args.get("task_id")
    if not tid:
        return _err("task_id is required")
    fields_in = {k: v for k, v in args.items() if k in ("name", "schedule", "prompt", "mode")}
    notify_supplied = "notify" in args
    # 1.4.x: 同 notify 三态 — 不传不动, 传空清关联; ea_names(数组, 优先) / ea_name(兼容单值)
    ea_supplied = ("ea_names" in args) or ("ea_name" in args)
    if not fields_in and not notify_supplied and not ea_supplied:
        return _err("no updatable fields supplied")
    if "mode" in fields_in and fields_in["mode"] not in VALID_MODES:
        return _err(f"unknown mode '{fields_in['mode']}'")
    with _db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
        if not row:
            return _err(f"task not found: {tid}")
        new = dict(row)
        new.update(fields_in)
        if notify_supplied:
            new["notify"] = _normalize_notify(args.get("notify"))
        if ea_supplied:
            ea_input = args.get("ea_names")
            if ea_input is None:
                ea_input = args.get("ea_name")
            new["ea_name"] = _normalize_ea_names(ea_input)
        if "schedule" in fields_in:
            once = _is_once_schedule(new["schedule"])
            new["kind"] = "once" if once else "cron"
            nf = _parse_once_ms(new["schedule"]) if once else _next_cron_ms(new["schedule"])
            if nf is None:
                return _err(f"invalid schedule '{new['schedule']}'")
            new["next_fire_at"] = nf
        conn.execute(
            """UPDATE tasks SET name=:name, schedule=:schedule, kind=:kind,
                                prompt=:prompt, mode=:mode, next_fire_at=:next_fire_at,
                                notify=:notify, ea_name=:ea_name
               WHERE id=:id""",
            new,
        )
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
    return _ok({"task": _row_to_task(row)})


def get_task_history(args: dict) -> list[TextContent]:
    tid = args.get("task_id")
    if not tid:
        return _err("task_id is required")
    limit = int(args.get("limit") or 20)
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?",
            (tid, limit),
        ).fetchall()
    return _ok({"runs": [_row_to_run(r) for r in rows], "count": len(rows)})


def list_due_tasks(args: dict) -> list[TextContent]:
    """Return tasks whose next_fire_at <= now and enabled=1.

    Used by the Electron daemon to know what to fire. Not particularly useful
    for an LLM agent, but kept here so all task state goes through one tool
    surface.
    """
    now = _now_ms()
    with _db() as conn:
        rows = conn.execute(
            """SELECT * FROM tasks
               WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
               ORDER BY next_fire_at ASC""",
            (now,),
        ).fetchall()
    return _ok({"tasks": [_row_to_task(r) for r in rows], "count": len(rows), "now_ms": now})


def record_system_run(args: dict) -> list[TextContent]:
    """Record one tick of an internal system ticker (stats-collector,
    backtest-reconciler, scheduler-poll, etc.) into the same tasks +
    task_runs tables that user-created tasks use. This unifies UI display
    + lets Claude query system task history via get_task_history.

    Args:
      task_id     — stable identifier (e.g. 'sys_stats_collector')
      name        — human-readable name shown in UI
      status      — 'ok' | 'error' | 'skipped' | 'mt5_unreachable' | ...
      summary     — short text describing what happened
      duration_ms — how long the tick took (for finished_at calculation)
      tick_ms     — interval in ms (so UI can show 间隔; only stored on
                    first INSERT OR IGNORE — updates won't change it)
      kind        — defaults to 'system' (stored in tasks.kind so UI can
                    distinguish from cron/once)
    """
    tid = (args.get("task_id") or "").strip()
    name = (args.get("name") or "").strip()
    if not tid or not name:
        return _err("task_id and name required")
    status = args.get("status") or "ok"
    summary = (args.get("summary") or "")[:4000]
    duration_ms = int(args.get("duration_ms") or 0)
    now_ms = _now_ms()
    started_at = now_ms - max(0, duration_ms)
    with _db() as conn:
        # 1) Idempotently ensure the parent task row exists. We use
        #    INSERT OR IGNORE so subsequent calls don't overwrite the row;
        #    we then UPDATE last_fire_at / last_status separately.
        conn.execute(
            """INSERT OR IGNORE INTO tasks
               (id, name, schedule, kind, prompt, mode, enabled, created_at,
                next_fire_at, last_fire_at, last_status, notify)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, NULL)""",
            (tid, name[:200], '@system', 'system',
             '(internal ticker — see Electron main.js)', 'tool_only', now_ms),
        )
        # Update last_fire / last_status (and refresh display name in case it changed)
        conn.execute(
            "UPDATE tasks SET name = ?, last_fire_at = ?, last_status = ? WHERE id = ?",
            (name[:200], now_ms, status, tid),
        )
        # 2) Insert the run row.
        run_id = _gen_id("r")
        conn.execute(
            """INSERT INTO task_runs
               (id, task_id, task_name, started_at, finished_at, status, result_summary)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (run_id, tid, name[:200], started_at, now_ms, status, summary),
        )
        # 3) Per-task prune: keep last 50 runs for this system task.
        conn.execute(
            """DELETE FROM task_runs WHERE task_id = ? AND id NOT IN (
                 SELECT id FROM task_runs WHERE task_id = ?
                 ORDER BY started_at DESC LIMIT 50
               )""",
            (tid, tid),
        )
    return _ok({"run_id": run_id, "task_id": tid})


def reset_system_tasks(args: dict) -> list[TextContent]:
    """0.3.120: 清空所有 kind='system' 的任务行（含 task_runs 历史），
    让客户端下次启动时由 stats-collector / scheduler-poll / record_system_run
    重新自动 seed 到最新版本定义的状态。

    背景（作者反馈）：「目前经历多个版本迭代之后，系统任务和用户任务已经
    变得混乱了，每台机看到的都不一样」。根因是不同版本 seed 的系统任务集合
    不同 + 升级时不会补 seed 新增的系统任务 + 长期不调用 record_system_run
    的功能导致 DB 里没该行。这个工具一键清空 → 重启 → 各组件自动用最新代码
    重新写入 = 恢复成「干净安装」的状态。

    用户任务（kind='cron' / 'once'）完全不受影响。

    需要 confirm=true 防误调。
    """
    if not args.get("confirm"):
        return _err("需要 confirm=true 确认 — 会删除所有系统任务定义 + 历史")
    with _db() as conn:
        # 拿到所有 kind='system' 的 id，先删 task_runs 再删 tasks 主表
        sys_ids = [r["id"] for r in conn.execute(
            "SELECT id FROM tasks WHERE kind = ?", ('system',)
        ).fetchall()]
        runs_deleted = 0
        if sys_ids:
            placeholders = ",".join("?" * len(sys_ids))
            cur = conn.execute(
                f"DELETE FROM task_runs WHERE task_id IN ({placeholders})", sys_ids
            )
            runs_deleted = cur.rowcount or 0
        cur = conn.execute("DELETE FROM tasks WHERE kind = ?", ('system',))
        tasks_deleted = cur.rowcount or 0
    return _ok({
        "tasks_deleted":  tasks_deleted,
        "runs_deleted":   runs_deleted,
        "detail":         "系统任务已清空。重启 EasyDeal 后各组件会自动用当前版本重新 seed。用户任务未受影响。",
    })


def begin_run(args: dict) -> list[TextContent]:
    """Caller (the daemon) tells us a task started running. Returns run_id."""
    tid = args.get("task_id")
    if not tid:
        return _err("task_id is required")
    with _db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
        if not row:
            return _err(f"task not found: {tid}")
        run = {
            "id":             _gen_id("r"),
            "task_id":        tid,
            "task_name":      row["name"],
            "started_at":     _now_ms(),
            "finished_at":    None,
            "status":         "running",
            "result_summary": None,
        }
        conn.execute(
            """INSERT INTO task_runs (id, task_id, task_name, started_at, finished_at, status, result_summary)
               VALUES (:id, :task_id, :task_name, :started_at, :finished_at, :status, :result_summary)""",
            run,
        )
        # Trim old runs to cap memory
        conn.execute(
            """DELETE FROM task_runs WHERE id IN (
                 SELECT id FROM task_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?
               )""",
            (RUN_HISTORY_CAP,),
        )
    return _ok({"run": run})


def finish_run(args: dict) -> list[TextContent]:
    """Caller updates run status + summary, and we advance the task's
    next_fire_at / last_status accordingly."""
    run_id = args.get("run_id")
    status = args.get("status")  # 'ok' | 'error' | 'skipped'
    summary = args.get("summary") or ""
    if not run_id or status not in ("ok", "error", "skipped"):
        return _err("run_id and status (ok|error|skipped) are required")
    finished = _now_ms()
    with _db() as conn:
        run = conn.execute("SELECT * FROM task_runs WHERE id = ?", (run_id,)).fetchone()
        if not run:
            return _err(f"run not found: {run_id}")
        conn.execute(
            "UPDATE task_runs SET finished_at = ?, status = ?, result_summary = ? WHERE id = ?",
            (finished, status, summary[:8000], run_id),
        )
        task = conn.execute("SELECT * FROM tasks WHERE id = ?", (run["task_id"],)).fetchone()
        if task:
            new_next: int | None
            new_enabled = task["enabled"]
            if task["kind"] == "cron":
                new_next = _next_cron_ms(task["schedule"])
            else:
                new_next = None
                new_enabled = 0  # one-shot disables itself after firing
            conn.execute(
                """UPDATE tasks SET last_fire_at = ?, last_status = ?,
                                    next_fire_at = ?, enabled = ? WHERE id = ?""",
                (run["started_at"], status, new_next, new_enabled, run["task_id"]),
            )
    return _ok({"run_id": run_id})


# ----------------------------------------------------------------------------
# MCP server wiring
# ----------------------------------------------------------------------------

server = Server("easydeal-scheduler")


@server.list_tools()
async def _list_tools():
    return [
        Tool(
            name="schedule_task",
            description=(
                "创建一个定时任务。schedule 可以是 5 字段 cron（如 '0 * * * *' 每小时整点）或 "
                "ISO 8601 datetime（如 '2026-04-30T08:00:00' 一次性）。"
                "mode：llm_headless（推荐）/tool_only/llm_inject。"
                "notify：触发后把执行结果推送到哪些通道。["
                "\"chat\"=客户端对话, \"wechat\"=微信]。空数组/未填 = 静默（默认）。"
                "用户说\"发到微信\"等明确意图时务必带上 [\"wechat\"]；想本地+微信都收 → [\"chat\",\"wechat\"]。"
                "ea_names：任务是针对某个/某几个策略(EA)的监控/巡检时**务必填**这些策略的文件名"
                "(不带扩展名, 如 [\"GMarket\", \"GMarket_v2\"])。关联后: 绑定的策略**全部**未运行时"
                "任务自动跳过(不白烧token, 任一策略启动后自动恢复); 有**至少一个**在运行就执行, 且"
                "触发时会在 prompt 里自动附上「当前实际运行中的是哪几个」, 你只需处理正在运行的那些、"
                "忽略未运行的。一个任务可以同时关联多个相似策略(如同一 EA 挂在不同账户), 不用为每个"
                "策略单独建同名任务。llm_inject 模式下若关联的策略里恰好只有 1 个在运行, 会路由到该"
                "策略的独立会话。跟具体策略无关的任务(账户日报等)不填。返回 {ok, data:{task}}。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "name":     {"type": "string", "description": "人类可读任务名"},
                    "schedule": {"type": "string", "description": "5 字段 cron 或 ISO 8601"},
                    "prompt":   {"type": "string", "description": "触发时的指令"},
                    "mode":     {"type": "string", "enum": list(VALID_MODES), "default": "llm_headless"},
                    "notify":   {
                        "type": "array",
                        "items": {"type": "string", "enum": ["chat", "wechat"]},
                        "description": "推送通道；不填 = 静默",
                        "default": [],
                    },
                    "ea_names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "关联的策略文件名 stem 列表(如 [\"GMarket\",\"GMarket_v2\"]); 全部未运行时任务自动跳过, 任一运行就执行(触发时只处理运行中的那些)",
                    },
                    "ea_name":  {"type": "string", "description": "(兼容旧版单值写法, 建议用 ea_names) 单个策略 stem"},
                },
                "required": ["name", "schedule", "prompt"],
            },
        ),
        Tool(
            name="list_tasks",
            description="列出所有定时任务。返回 {ok, data:{tasks, count}}。",
            inputSchema={
                "type": "object",
                "properties": {"enabled_only": {"type": "boolean", "default": False}},
            },
        ),
        Tool(
            name="get_task",
            description="按 id 取单个任务。返回 {ok, data:{task}}。",
            inputSchema={
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        ),
        Tool(
            name="cancel_task",
            description="永久删除一个任务。返回 {ok, data:{removed, task_id}}。",
            inputSchema={
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        ),
        Tool(
            name="pause_task",
            description="暂停（disable）一个任务。返回 {ok, data:{task}}。",
            inputSchema={
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        ),
        Tool(
            name="resume_task",
            description="恢复（enable）一个任务，自动重新计算 next_fire_at。返回 {ok, data:{task}}。",
            inputSchema={
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        ),
        Tool(
            name="update_task",
            description=(
                "修改任务字段。可改：name / schedule / prompt / mode / notify / ea_names。"
                "改 schedule 自动重算 next_fire_at。"
                "notify 用法："
                "传 [] 或 null = 静默（不通知）；"
                "传 [\"chat\"] = 推到客户端对话；"
                "传 [\"wechat\"] = 推到微信；"
                "传 [\"chat\",\"wechat\"] = 两个都推。"
                "不传 notify 字段 = 保持原值不动。"
                "ea_names 同理三态：不传=不动；传 [] / null = 解除全部策略关联；"
                "传 [\"GMarket\",\"GMarket_v2\"] = 覆盖成这些策略(全部未运行才跳过, 任一运行就执行)。"
                "用户说『把 X 任务改成静默 / 也推到微信 / 不要发微信了 / 也加到 Y 策略上』时调本工具。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "task_id":  {"type": "string"},
                    "name":     {"type": "string"},
                    "schedule": {"type": "string"},
                    "prompt":   {"type": "string"},
                    "mode":     {"type": "string", "enum": list(VALID_MODES)},
                    "notify":   {
                        "type": "array",
                        "items": {"type": "string", "enum": ["chat", "wechat"]},
                        "description": "推送通道：[] = 静默；[\"chat\"] / [\"wechat\"] / 两者皆有",
                    },
                    "ea_names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "关联策略 stem 列表；[] = 解除全部关联；覆盖式(不是追加, 要保留旧的需连同新的一起传)",
                    },
                    "ea_name":  {"type": "string", "description": "(兼容旧版单值写法, 建议用 ea_names) 单个策略 stem；空串=解除关联"},
                },
                "required": ["task_id"],
            },
        ),
        Tool(
            name="get_task_history",
            description="取某任务最近 N 次触发记录。返回 {ok, data:{runs, count}}。",
            inputSchema={
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "limit":   {"type": "integer", "default": 20, "minimum": 1, "maximum": 200},
                },
                "required": ["task_id"],
            },
        ),
        Tool(
            name="list_due_tasks",
            description=(
                "返回当前到时应该触发的任务列表。Electron 的调度守护进程用此工具拿待跑任务。"
                "返回 {ok, data:{tasks, count, now_ms}}。"
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="begin_run",
            description=(
                "调度守护进程开始跑某任务前调用，记录一条 status=running 的执行记录。"
                "返回 {ok, data:{run}}。"
            ),
            inputSchema={
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"],
            },
        ),
        Tool(
            name="finish_run",
            description=(
                "调度守护进程跑完任务后调用，写回 status/summary 并推进任务的 next_fire_at。"
                "status: ok | error | skipped。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "run_id":  {"type": "string"},
                    "status":  {"type": "string", "enum": ["ok", "error", "skipped"]},
                    "summary": {"type": "string"},
                },
                "required": ["run_id", "status"],
            },
        ),
        Tool(
            name="record_system_run",
            description=(
                "记录一次内置系统任务（stats-collector / 回测通知巡检 / 偏好学习 等）"
                "的执行历史，写到跟用户任务同一个 tasks + task_runs 表里。Claude 可以"
                "用 get_task_history 查询历史，UI 也跟普通任务一样能展开历史。"
                "task_id 形如 'sys_stats_collector'。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "task_id":     {"type": "string", "description": "稳定的系统任务 id"},
                    "name":        {"type": "string", "description": "UI 显示名"},
                    "status":      {"type": "string", "description": "ok | error | skipped | mt5_unreachable | ..."},
                    "summary":     {"type": "string", "description": "本次执行的简要描述"},
                    "duration_ms": {"type": "integer", "description": "本次耗时毫秒"},
                },
                "required": ["task_id", "name"],
            },
        ),
        Tool(
            name="reset_system_tasks",
            description=(
                "0.3.120: 一键清空所有 kind='system' 的任务行（含 task_runs 历史），"
                "让 EasyDeal 重启时由 stats-collector / scheduler-poll / 各 ticker"
                "重新自动 seed 到当前版本定义的状态。用户任务（kind=cron/once）"
                "不受影响。修「跨版本升级后系统任务列表不一致」的问题。"
                "需要 confirm=true 防误调。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "confirm": {"type": "boolean", "description": "必须传 true"},
                },
                "required": ["confirm"],
            },
        ),
    ]


_HANDLERS = {
    "schedule_task":    schedule_task,
    "list_tasks":       list_tasks,
    "get_task":         get_task,
    "cancel_task":      cancel_task,
    "clear_task_runs":  clear_task_runs,
    "delete_task_run":  delete_task_run,
    "pause_task":       lambda a: set_enabled(a, False),
    "resume_task":      lambda a: set_enabled(a, True),
    "update_task":      update_task,
    "get_task_history": get_task_history,
    "list_due_tasks":   list_due_tasks,
    "begin_run":        begin_run,
    "finish_run":       finish_run,
    "record_system_run": record_system_run,
    "reset_system_tasks": reset_system_tasks,
}


@server.call_tool()
async def _call_tool(name: str, arguments: dict | None):
    handler = _HANDLERS.get(name)
    if handler is None:
        return _err(f"unknown tool: {name}")
    try:
        return handler(arguments or {})
    except Exception as e:
        log.exception("tool %s failed", name)
        return _err(f"{type(e).__name__}: {e}")


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

async def main():
    _init_db()
    log.info("DB at %s", DB_PATH)
    log.info("scheduler MCP server listening on stdio")
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
