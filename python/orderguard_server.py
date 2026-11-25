"""EasyDeal OrderGuard — HTTP + MCP dual-mode server.

Provides:
  - HTTP API on 127.0.0.1:9527 for EA WebRequest() calls
  - MCP stdio tools for Claude Code to query/manage guard rules

All tools return uniform envelope:
    {"ok": true,  "data": ...}
    {"ok": false, "error": "..."}

Storage: SQLite at $EASYDEAL_ORDERGUARD_DB (default
<userData>/data/orderguard.db). WAL mode for concurrent access.
"""

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
import sys
import time
import uuid
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Flask for HTTP
from flask import Flask, request as flask_request, jsonify

# The bundled Windows embeddable Python uses an isolated ._pth file, which
# omits the executed script's directory.  Shared sibling modules must be made
# importable explicitly so packaged launches work from every working dir.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import mt5_lifecycle as _mt5_lifecycle
import news_gate as _news_gate

# MetaTrader5 — optional. Monitor mode needs it; if unavailable, monitor task
# logs a warning and noops. /check / MCP path still works without it.
try:
    import MetaTrader5 as mt5
    _MT5_AVAILABLE = True
except ImportError:
    mt5 = None
    _MT5_AVAILABLE = False

# ----------------------------------------------------------------------------
# Logging — to stderr only (stdout is reserved for MCP framing).
# ----------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s [orderguard] %(levelname)s %(message)s",
)
log = logging.getLogger("orderguard")

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
DEFAULT_DB = str(Path.home() / ".easydeal" / "orderguard.db")
DB_PATH = os.getenv("EASYDEAL_ORDERGUARD_DB", DEFAULT_DB)
# 0.3.65: 端口候选列表 + 自动回退。9527 在中文 Windows 上常被 WUDFHost.exe（用户
# 驱动框架）占住，硬绑会让 Flask 启动后返回非 HTTP 响应，客户端报 Parse Error。
# Python 启动时按顺序试，能 bind 就用；最终选定的端口写到 `<data>/orderguard.port`，
# Node 端读这文件知道实际端口。
HTTP_HOST = "127.0.0.1"
# 0.3.191 Phase 3: 多 OrderGuard 实例 — Electron 通过 env 注入候选端口段 (避免
# pool 里几个进程抢同款端口) + port file 路径 (每个实例独立 orderguard-<id>.port).
# 老单实例路径仍兼容: env 不传时回 fallback 默认值, 跟 0.3.190 之前行为一致.
_PORT_CANDIDATES_ENV = (os.getenv("EASYDEAL_ORDERGUARD_PORT_CANDIDATES", "") or "").strip()
if _PORT_CANDIDATES_ENV:
    try:
        _PORT_CANDIDATES = [int(p.strip()) for p in _PORT_CANDIDATES_ENV.split(",") if p.strip()]
    except Exception:
        _PORT_CANDIDATES = [19527, 28737, 35279, 47139, 51827]
else:
    _PORT_CANDIDATES = [
        int(os.getenv("EASYDEAL_ORDERGUARD_PORT", "0") or 0),   # env override 优先 (legacy)
        19527, 28737, 35279, 47139, 51827,                        # 不常见端口
    ]
HTTP_PORT: int = 0    # 启动时填实际端口
PORT_FILE = os.getenv("EASYDEAL_ORDERGUARD_PORT_FILE", "").strip() or \
            str(Path(os.getenv("EASYDEAL_ORDERGUARD_DB", DEFAULT_DB)).parent / "orderguard.port")
# 0.3.191: 实例标识 (log + diagnostic 用, 不影响逻辑)
INSTANCE_ID = (os.getenv("EASYDEAL_ORDERGUARD_INSTANCE_ID", "") or "").strip()
INSTANCE_NAME = (os.getenv("EASYDEAL_ORDERGUARD_INSTANCE_NAME", "") or "").strip()


# 0.3.205: kill-flag — main.js 的 mt5-instances:kill IPC 写 userData/data/
# mt5-killed-<hash>.flag, OG 读这个判断「用户主动关了别 attach」. 比 psutil 检查
# 更可靠 — 即使 mt5.initialize 检测进程在 dying 状态会 launch 新 terminal, 这条
# 路径完全跳过 init.
def _killed_flag_present(install_dir: str) -> bool:
    if not install_dir:
        return False
    # 0.3.228: 跟 _launching_recent 一致 — 先 EASYDEAL_DATA_DIR 再 EASYDEAL_USER_DATA_DIR
    # 两个 env 名都支持避免 Node 端 spawn 时 env injection 漏给 OG.
    try:
        import hashlib
        h = hashlib.md5(install_dir.lower().encode("utf-8")).hexdigest()[:12]
        fname = f"mt5-killed-{h}.flag"
        data_dir = os.getenv("EASYDEAL_DATA_DIR") or ""
        if data_dir and os.path.isfile(os.path.join(data_dir, fname)):
            return True
        user_data = os.getenv("EASYDEAL_USER_DATA_DIR") or ""
        if user_data and os.path.isfile(os.path.join(user_data, "data", fname)):
            return True
        return False
    except Exception:
        return False


# 0.3.209: launch-flag — main.js launch IPC 写 userData/data/
# mt5-launching-<hash>.flag, 内 OG 全部跳过 mt5.initialize. 修「点启动 MT5 后
# SDK 在 MT5 boot 期间被叫去 init 时误判 'terminal not running' 再 launch 一个」.
# 跟 kill-flag 互斥 (kill IPC 清掉 launch-flag, launch IPC 清掉 kill-flag).
# Lifecycle v2: use a 300s crash fallback. Python (easydeal_mcp_server
# 老的重启挂载) 也会在 kill+spawn+attach 整段流程内显式 write+clear flag,
# 慢机器整段可能超过 120s; 300s 只作为 Python 子进程崩溃时的兜底 (正常 Python
# finally 清 flag 不依赖时间过期, 跨进程协调用 Node `global._isLaunchingRecent`
# 的同款 300s 默认值对齐).
# 0.3.228: 也支持 EASYDEAL_DATA_DIR (Python MCP 用) 作为 fallback, 这样 OG
# 不必依赖 EASYDEAL_USER_DATA_DIR 也能找到同款 flag file.
def _launching_recent(install_dir: str, grace_sec: float = 300.0) -> bool:
    if not install_dir:
        return False
    # 先看 EASYDEAL_DATA_DIR (= <userData>/data/), 再回退 EASYDEAL_USER_DATA_DIR
    # (= <userData>/) + 拼 /data/. 两者最终指向同款 file path.
    try:
        import hashlib
        h = hashlib.md5(install_dir.lower().encode("utf-8")).hexdigest()[:12]
        fname = f"mt5-launching-{h}.flag"
        candidates = []
        data_dir = os.getenv("EASYDEAL_DATA_DIR") or ""
        if data_dir:
            candidates.append(os.path.join(data_dir, fname))
        user_data = os.getenv("EASYDEAL_USER_DATA_DIR") or ""
        if user_data:
            candidates.append(os.path.join(user_data, "data", fname))
        for flag in candidates:
            if not os.path.isfile(flag):
                continue
            age = time.time() - os.path.getmtime(flag)
            if age < grace_sec:
                return True
            # 过期 → 删掉防累积
            try: os.unlink(flag)
            except Exception: pass
        return False
    except Exception:
        return False


# 0.3.211: 进程存在 + 已经跑了 >= N 秒 (stable). MT5 boot 期间进程是有的, 但
# SDK IPC 没就绪, 这时调 mt5.initialize SDK 会误判「not running」再 launch 一个
# (用户实测「开了很多个 mt5」根因). 用 psutil.create_time 等 60 秒确保 SDK IPC
# 已就绪再 init.
def _terminal_running_age_sec(install_dir: str):
    """返回该 install_dir 下 terminal64.exe 进程的运行时长 (秒). 不在跑返 -1."""
    if not install_dir:
        return -1
    try:
        import psutil
    except Exception:
        return -1       # lifecycle v2: 无法证明目标进程存在就拒绝 attach
    try:
        norm_install = os.path.normpath(install_dir).lower()
        max_age = -1
        for p in psutil.process_iter(['name', 'exe', 'create_time']):
            try:
                name = (p.info.get('name') or '').lower()
                if name not in ('terminal64.exe', 'terminal.exe'):
                    continue
                exe = p.info.get('exe') or ''
                if not exe:
                    continue
                exe_dir = os.path.dirname(os.path.normpath(exe)).lower()
                if exe_dir == norm_install:
                    ct = p.info.get('create_time') or 0
                    age = time.time() - ct
                    if age > max_age:
                        max_age = age
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return max_age
    except Exception:
        return -1


# 0.3.199: 防 mt5.initialize 把刚被用户「关闭 MT5」按钮关掉的 MT5 自动拉起.
# MetaTrader5 Python SDK 的 initialize(path=...) 文档明确写「If the terminal is
# not running, the function launches it」. 我们 attach / re-init 之前先用 psutil
# 看那个 install_dir 下的 terminal64.exe 实际在不在跑, 不在跑就跳过 init.
def _terminal_is_running(install_dir: str) -> bool:
    """只在能证明指定目录的 terminal 进程存在时返回 True。"""
    return bool(_mt5_lifecycle.exact_terminal_pids(install_dir))


def _norm_path(p: str) -> str:
    """归一化路径(正斜杠→反斜杠, 去尾分隔符, 小写)供跨来源比较 —— 同 Node launchMt5 的 _np。"""
    return str(p or "").replace("/", "\\").rstrip("\\").lower()


def _data_dir_terminal_fresh(data_dir: str, max_age_sec: int = 180) -> bool:
    """判断「一个 terminal 正绑在这个 **data_dir** 上活着」—— 多实例共享同一 install_dir 时,
    光看 install_dir 下有 terminal64.exe 在跑无法区分是哪个账户实例的(实盘4账户 case)。
    运行中的 MT5 会持续往 <data_dir>\\logs\\YYYYMMDD.log 写日志, 用今天日志的 mtime 新鲜度
    (默认<180s)判定「有 terminal 真的绑在这个 data_dir 上」。data_dir 空 / 无 logs → 返 True
    (退回旧行为不误杀)。1.5.1: OG 的自动 init 门控用它, 只对「自己 data_dir 上真有 terminal
    在跑」的实例放行 init, 杜绝共享 install_dir 时 OG 连带把别的实例 mt5.initialize 拉起来。"""
    if not data_dir:
        return True
    try:
        logs_dir = os.path.join(data_dir, "logs")
        if not os.path.isdir(logs_dir):
            return True   # 没有 logs 目录 → 无从判定, 不误杀
        newest = -1.0
        for fn in os.listdir(logs_dir):
            if fn.lower().endswith(".log"):
                try:
                    mt = os.path.getmtime(os.path.join(logs_dir, fn))
                    if mt > newest:
                        newest = mt
                except OSError:
                    continue
        if newest < 0:
            return True   # logs 目录空 → 不误杀
        return (time.time() - newest) <= max_age_sec
    except Exception:
        return True


def _detect_portable_mode(install_dir: str) -> bool:
    """只按显式 launchMode（或完整 install/data 路径对）判断便携模式。"""
    return _mt5_lifecycle.portable_for(install_dir)


def _mt5_init_safe(kwargs: dict):
    """统一 OG 侧 attach-only SDK 入口；配置或实例身份不明即拒绝。"""
    params = dict(kwargs or {})
    p = params.pop("path", None)
    ok = _mt5_lifecycle.initialize_checked(mt5, path=p, retries=0, **params)
    if not ok:
        log.info("MT5 attach blocked: %s", _mt5_lifecycle.LAST_ERROR)
    return ok
# 0.3.67: 去掉 token 鉴权 —— 服务 bind 在 127.0.0.1，外部进程根本访问不到，
# token 是多余的复杂度。EA 直接调 /check 不带任何 auth 头。

# Risk level ordering
RISK_LEVELS = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# Default fallback: if OrderGuard server is unreachable, EA should pass
# (never block on infrastructure failure).
DEFAULT_FALLBACK = "pass"

# AI check timeout (seconds) — if AI doesn't respond in time, fall back.
AI_TIMEOUT_SEC = 3.0

# 0.3.66 (P1-C): AI 异步评估 + cache 配置
AI_WORKERS = int(os.getenv("EASYDEAL_OG_AI_WORKERS", "5"))
AI_CACHE_TTL_SEC = int(os.getenv("EASYDEAL_OG_AI_CACHE_TTL", "300"))     # 5 min default
AI_CACHE_MAX_ROWS = 5000                                                  # 防爆容量
_ai_queue: "asyncio.Queue | None" = None
_ai_inflight: set = set()      # cache_key 正在异步处理中的集合，去重避免重复入队
_ai_workers_loop = None         # main loop 引用，给 sync 线程入队用

# ----------------------------------------------------------------------------
# DB
# ----------------------------------------------------------------------------
def _db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _init_db():
    conn = _db()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS decisions (
                decision_id   TEXT PRIMARY KEY,
                ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                ea_name       TEXT NOT NULL,
                risk_level    TEXT NOT NULL,
                intent        TEXT NOT NULL,
                symbol        TEXT NOT NULL,
                side          TEXT NOT NULL,
                requested_volume REAL NOT NULL,
                approved_volume  REAL,
                approved      INTEGER NOT NULL DEFAULT 1,
                reason        TEXT,
                ai_checked    INTEGER NOT NULL DEFAULT 0,
                ai_confidence REAL,
                context_json  TEXT,
                latency_ms    INTEGER
            );

            CREATE TABLE IF NOT EXISTS orders (
                decision_id   TEXT PRIMARY KEY,
                ticket        INTEGER,
                open_price    REAL,
                open_time     TEXT,
                close_price   REAL,
                close_time    TEXT,
                pnl           REAL,
                holding_sec   INTEGER,
                close_reason  TEXT,
                FOREIGN KEY (decision_id) REFERENCES decisions(decision_id)
            );

            CREATE TABLE IF NOT EXISTS rules (
                ea_name       TEXT NOT NULL,
                risk_level    TEXT NOT NULL,
                intent        TEXT NOT NULL DEFAULT '',
                rule_json     TEXT NOT NULL,
                updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                PRIMARY KEY (ea_name, risk_level, intent)
            );

            CREATE INDEX IF NOT EXISTS idx_decisions_ea ON decisions(ea_name);
            CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
            CREATE INDEX IF NOT EXISTS idx_decisions_intent ON decisions(ea_name, intent);
            CREATE INDEX IF NOT EXISTS idx_orders_ticket ON orders(ticket);

            -- 0.3.141: 每只 EA 启用护航的时间戳锚点。decision log / 统计聚合都按
            -- 这个 anchor 过滤掉「启用前的历史 deals」。用户反馈：「只有开启护航
            -- 后的订单才加入，顶部的统计也是基于加入后的订单的」。enable endpoint
            -- 每次启用都 INSERT OR REPLACE → reset anchor 到 now (用户 disable+
            -- enable = 清掉旧 stale 数据的方式)。
            CREATE TABLE IF NOT EXISTS ea_anchors (
                ea_name      TEXT PRIMARY KEY,
                enabled_at   TEXT NOT NULL
            );

            -- 0.3.66 P1-C: AI 决策结果 cache。
            -- cache_key = 离散化后上下文的 sha256 prefix（_ai_cache_key），
            -- 同一 EA 在「相近上下文桶」里复用同一条 AI 评估，
            -- 5 分钟 TTL（盘面变化敏感时段不能复用太久）。
            CREATE TABLE IF NOT EXISTS ai_cache (
                cache_key   TEXT PRIMARY KEY,
                ea_name     TEXT NOT NULL,
                decision    TEXT NOT NULL,
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                expires_at  TEXT NOT NULL,
                hit_count   INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_ai_cache_exp ON ai_cache(expires_at);
            CREATE INDEX IF NOT EXISTS idx_ai_cache_ea  ON ai_cache(ea_name);

            -- 0.3.74 P3: 自学习生成的规则调整建议。
            -- 状态机：pending → applied (用户应用，可后续 rolled_back) / dismissed (用户忽略)
            -- 每条建议都基于 ≥30 单样本 + 7 天 cooldown，所有变更都有 old_value 可回滚。
            CREATE TABLE IF NOT EXISTS rule_adjustments (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                ea_name         TEXT NOT NULL,
                rule_key        TEXT NOT NULL,
                old_value       TEXT NOT NULL,
                new_value       TEXT NOT NULL,
                reason          TEXT NOT NULL,
                sample_n        INTEGER NOT NULL,
                win_rate        REAL,
                metric_value    REAL,
                status          TEXT NOT NULL DEFAULT 'pending',
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                applied_at      TEXT,
                dismissed_at    TEXT,
                rolled_back_at  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_rule_adj_ea     ON rule_adjustments(ea_name);
            CREATE INDEX IF NOT EXISTS idx_rule_adj_status ON rule_adjustments(status);
            CREATE INDEX IF NOT EXISTS idx_rule_adj_key    ON rule_adjustments(ea_name, rule_key);
        """)
    finally:
        conn.close()


# ----------------------------------------------------------------------------
# Rule engine
# ----------------------------------------------------------------------------
def _get_rules_for_ea(ea_name: str) -> list[dict]:
    """Load all rules for an EA from DB."""
    conn = _db()
    try:
        rows = conn.execute(
            "SELECT * FROM rules WHERE ea_name = ? ORDER BY risk_level",
            (ea_name,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# 0.3.141: ea_anchors helpers — 每只 EA 启用护航时间戳，post_hoc + 统计都按它过滤
# 0.3.141: 从 monitor json 反推 EA name fallback
# 用户场景：填了 .easydeal-ea-monitor.json 的 magic_numbers 但还没点 UI「启用护航」按钮
# 之前 _ea_magic_map 为空 → 所有 deal 反推为 __unknown__ + UI「在跑订单」全标「否 / __unknown__」
# fix：fallback 读 monitor json 拿 multi-magic 配置反推 ea_name；显示对的名字，但
# 「护航」列仍按 _ea_enabled 判（用户得显式点过启用按钮才显「是」）。
_monitor_config_cache = {"loaded_at": 0, "magic_to_ea": {}}

def _resolve_workspace_dir() -> str:
    """推 workspace 路径：优先 EASYDEAL_WORKSPACE_DIR env，否则从 EASYDEAL_USER_DATA_DIR/workspace 算"""
    ws = os.getenv("EASYDEAL_WORKSPACE_DIR") or ""
    if ws and os.path.isdir(ws):
        return ws
    udd = os.getenv("EASYDEAL_USER_DATA_DIR") or ""
    if udd:
        ws2 = os.path.join(udd, "workspace")
        if os.path.isdir(ws2):
            return ws2
    return ""


def _load_monitor_magic_map() -> dict:
    """读 <workspace>/.easydeal-ea-monitor.json，返回 {magic_int: ea_name} 全量映射。
    cache 5s 减少 IO（tracker 每 5s poll 一次，命中率高）。"""
    now = int(time.time())
    if now - _monitor_config_cache["loaded_at"] < 5:
        return _monitor_config_cache["magic_to_ea"]

    ws = _resolve_workspace_dir()
    if not ws:
        _monitor_config_cache["loaded_at"] = now
        _monitor_config_cache["magic_to_ea"] = {}
        return {}
    cfg_path = os.path.join(ws, ".easydeal-ea-monitor.json")
    if not os.path.isfile(cfg_path):
        _monitor_config_cache["loaded_at"] = now
        _monitor_config_cache["magic_to_ea"] = {}
        return {}
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        _monitor_config_cache["loaded_at"] = now
        return _monitor_config_cache["magic_to_ea"]

    magic_to_ea = {}
    for ea_name, raw in (data or {}).items():
        if not isinstance(raw, dict) or not ea_name:
            continue
        # 剥 .mq5/.ex5 后缀
        stem = ea_name.replace(".mq5", "").replace(".ex5", "").strip()
        # 0.3.123+ 多值 magic_numbers 优先
        magic_nums = []
        if isinstance(raw.get("magic_numbers"), list):
            for v in raw["magic_numbers"]:
                try:
                    m = int(v)
                    if m > 0:
                        magic_nums.append(m)
                except (TypeError, ValueError):
                    pass
        # 老 single magic fallback
        elif raw.get("magic") is not None:
            try:
                m = int(raw["magic"])
                if m > 0:
                    magic_nums.append(m)
            except (TypeError, ValueError):
                pass
        for m in magic_nums:
            magic_to_ea[m] = stem

    _monitor_config_cache["loaded_at"] = now
    _monitor_config_cache["magic_to_ea"] = magic_to_ea
    return magic_to_ea


def _resolve_ea_name(magic: int) -> str:
    """先查 _ea_magic_map (用户在 UI 点过「启用护航」的)，没匹配 fallback 到
    monitor json (用户在「监控配置」对话框填过 magic 的)。最终都没匹配返 __unknown__。"""
    if not magic:
        return "__unknown__"
    ea = _ea_magic_map.get(int(magic))
    if ea is not None:
        return ea
    mm = _load_monitor_magic_map()
    return mm.get(int(magic), "__unknown__")


def _get_ea_anchor(ea_name: str) -> str | None:
    """返回该 EA 当前的 anchor (ISO 字符串)。None = 没设过 (= 不过滤，等价于 0)。"""
    if not ea_name or ea_name == "__unknown__":
        return None
    conn = _db()
    try:
        row = conn.execute(
            "SELECT enabled_at FROM ea_anchors WHERE ea_name=?", (ea_name,)
        ).fetchone()
        return row["enabled_at"] if row else None
    finally:
        conn.close()


def _set_ea_anchor(ea_name: str, anchor_iso: str | None = None):
    """每次 enable EA 调一次。INSERT OR REPLACE → 老 anchor 会被覆盖。"""
    if not ea_name or ea_name == "__unknown__":
        return
    if anchor_iso is None:
        anchor_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    conn = _db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO ea_anchors (ea_name, enabled_at) VALUES (?, ?)",
            (ea_name, anchor_iso),
        )
    finally:
        conn.close()


def _migrate_decisions_notified_at():
    """0.3.151 step 3: decisions 表加 notified_at 列 (TEXT NULL).
    用来标记一条 warning 类 alert 是否已推送过微信, 避免重复发.
    """
    conn = _db()
    try:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(decisions)").fetchall()]
        if "notified_at" not in cols:
            conn.execute("ALTER TABLE decisions ADD COLUMN notified_at TEXT")
            log.info("[migration] decisions table: added notified_at column")
    except Exception as e:
        log.warning("notified_at migration failed (ignored): %s", e)
    finally:
        conn.close()


def _migrate_guarded_account_login():
    """0.3.170: decisions 表加 guarded + account_login 两列.

    用户反馈: 「每个单都应该有标记是否加入护航, 开启护航后这个 EA 的订单都应
    该是标记护航状态的. 护航栏目的统计只统计标记为护航的订单. 切户后只统计和
    显示新户的数据」.

    新设计: decisions 行自身带 guarded (1/0) + account_login (int). 所有 UI
    查询 WHERE guarded=1 AND account_login=<current>. 不依赖 ea_anchors JOIN
    gate (老路径保留作为「重置统计」按钮的兜底).

    Backfill 老 row:
      guarded = 1 if exists(ea_anchors where ea_name=row.ea_name AND row.ts >= enabled_at) else 0
      account_login = NULL (老 row 没记, SQL 后续 WHERE 用 IS NOT NULL 隐式过滤掉,
                            或 fallback 不过滤 — 见 _build_account_filter)
    """
    conn = _db()
    try:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(decisions)").fetchall()]
        added = []
        if "guarded" not in cols:
            conn.execute("ALTER TABLE decisions ADD COLUMN guarded INTEGER DEFAULT 0")
            added.append("guarded")
        if "account_login" not in cols:
            conn.execute("ALTER TABLE decisions ADD COLUMN account_login INTEGER")
            added.append("account_login")
        if added:
            log.info("[migration] decisions table: added columns %s", added)
            # Backfill guarded 一次. 用 ea_anchors 表反推: 该 EA 历史曾启用过 →
            # ts >= enabled_at 的 row 是护航期内的. 等价于老 anchor JOIN 过滤效果.
            cur = conn.execute("""
                UPDATE decisions SET guarded = 1
                WHERE guarded = 0
                  AND EXISTS (
                      SELECT 1 FROM ea_anchors a
                       WHERE a.ea_name = decisions.ea_name
                         AND decisions.ts >= a.enabled_at
                  )
            """)
            log.info("[migration] backfilled %d rows decisions.guarded=1", cur.rowcount or 0)
        # 1.0.6: 覆盖索引必须在 guarded/account_login 两列存在之后再建 —— 初始 executescript 的
        # CREATE TABLE decisions 没这俩列 (是本 migration ALTER 出来的), 在那建会 "no such column".
        # 放这儿、列已确保存在; 在 try 内即使建失败也被 except 吞掉不致 OG 起不来. 护航「整体战绩」
        # 3 个 COUNT 都 WHERE guarded=1 + account_login + ea_name + ts>=anchor, 海量决策时每 5s poll
        # 全表 heap scan → 「审批/拦截订单数量更新好慢好慢」(用户) 根因. 做成 COVERING 索引 (含
        # SUM(CASE) 用到的 approved/approved_volume/requested_volume), 让 SQLite 走 index-only scan
        # 不回表读宽行, 单账户海量决策也快.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_decisions_overview "
            "ON decisions(guarded, account_login, ea_name, ts, "
            "             approved, approved_volume, requested_volume)"
        )
    except Exception as e:
        log.warning("guarded/account_login migration failed (ignored): %s", e)
    finally:
        conn.close()


def _migrate_close_modify_columns():
    """1.0.7: 给「平仓 / 改单」学习 + 拦截做数据底座 (Phase 1).
      - decisions 加 op (open|close|modify) —— 让平仓/改单成为一等决策, 不再只回填开仓单.
        用 DEFAULT 'open' 让 SQLite 自动把存量 row 填 'open' (无需单独 backfill UPDATE).
      - orders 加 sl_open/tp_open/sl_close/tp_close —— 采集 SL/TP, 学「SL 外扩」「平仓偏早」用.
      - 新表 modify_events —— 每次 SL/TP 改动一行 (含是否往亏损方向外扩 sl_widened).
    索引必须建在本 migration 内 (op 等列是这里 ALTER 出来的, 进 _init_db 的 executescript
    会 "no such column" 崩 init); 整体 try/except 吞错, 建不出来也不致 OG 起不来.
    """
    conn = _db()
    try:
        dcols = [r["name"] for r in conn.execute("PRAGMA table_info(decisions)").fetchall()]
        if "op" not in dcols:
            # DEFAULT 'open' → 存量 row 自动变 'open'; 新开仓不显式传 op 也默认 open;
            # 只有平仓/改单决策显式写 op='close'/'modify'.
            conn.execute("ALTER TABLE decisions ADD COLUMN op TEXT DEFAULT 'open'")
            log.info("[migration] decisions table: added op column (default 'open')")
        ocols = [r["name"] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
        for col in ("sl_open", "tp_open", "sl_close", "tp_close"):
            if col not in ocols:
                conn.execute(f"ALTER TABLE orders ADD COLUMN {col} REAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS modify_events (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                decision_id     TEXT,
                ea_name         TEXT NOT NULL,
                account_login   INTEGER,
                ticket          INTEGER,
                symbol          TEXT,
                side            TEXT,
                ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                old_sl          REAL,
                new_sl          REAL,
                old_tp          REAL,
                new_tp          REAL,
                ref_price       REAL,
                sl_widened      INTEGER NOT NULL DEFAULT 0,
                sl_delta_points REAL,
                guarded         INTEGER NOT NULL DEFAULT 0,
                source          TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_decisions_op ON decisions(ea_name, op, ts)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_modify_ticket ON modify_events(ticket)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_modify_ea ON modify_events(ea_name, ts)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_modify_widen ON modify_events(ea_name, sl_widened)")
        log.info("[migration] close/modify columns + modify_events table ready")
    except Exception as e:
        log.warning("close/modify migration failed (ignored): %s", e)
    finally:
        conn.close()


def _build_account_filter(login: int | None) -> tuple[str, list]:
    """构造 SQL WHERE 片段过滤当前 MT5 账户.
    login=None (启动早期 mt5 还没 attach) → 不过滤, 返「1=1」让 UI 不空白.
    login=<int> → 「(d.account_login = ? OR d.account_login IS NULL)」
                  IS NULL 兼容 backfill 的老 row (没记 account_login 的).
    切户后旧户 row.account_login=<旧 int> 不再 match → 自动过滤掉. ✓
    """
    if login is None:
        return "1=1", []
    return "(d.account_login = ? OR d.account_login IS NULL)", [int(login)]


def _build_enabled_ea_filter() -> tuple[str, list]:
    """0.3.173: 构造 SQL WHERE 片段过滤当前 _ea_enabled 里的 EA.
    用户实测 case: SimpleBTC 因 0.3.168 之前的 _ea_magic_map 撞号 bug 残留了
    guarded=1 的 row, 但 SimpleBTC 现在已不在 _ea_enabled. GMarket 的「↻ 重置统计」
    按钮只清 GMarket 的 row, 清不到 SimpleBTC 这种"孤儿数据".
    解: 查询时加 d.ea_name IN <_ea_enabled> 实时过滤 — 任何不在当前护航列表
    的 EA 数据立刻从 UI 隐藏 (跟用户预期"只统计标记为护航的订单"一致).
    _ea_enabled 空 → 返「1=0」让 UI 全空 (没启用任何 EA, 自然没护航数据).
    """
    enabled = [ea for ea in _ea_enabled if ea and ea != "__unknown__"]
    if not enabled:
        return "1=0", []
    placeholders = ",".join("?" * len(enabled))
    return f"d.ea_name IN ({placeholders})", enabled


def _migrate_ea_anchors():
    """启动时一次性 migration：给所有已 enabled 但还没 anchor 的 EA，把 anchor 设成
    **当前时刻** (升级 0.3.141 即「重新开始计数」)。
    用户反馈：「这个 ea 是刚上护航功能的，为什么历史的单都跑进来了」—— 之前用
    MIN(ts) 保留全部历史，但用户语义是「升级 = 清零」。数据不删 (decisions / orders
    表仍在)，只是被 anchor filter 过滤掉，将来在 UI 上能加「查看历史」展开看。"""
    conn = _db()
    try:
        rows = conn.execute(
            "SELECT DISTINCT ea_name FROM rules WHERE intent='_meta'"
        ).fetchall()
        eas = [r["ea_name"] for r in rows]
        existing = {r["ea_name"] for r in conn.execute(
            "SELECT ea_name FROM ea_anchors"
        ).fetchall()}
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        for ea in eas:
            if ea in existing or ea == "__unknown__":
                continue
            conn.execute(
                "INSERT OR REPLACE INTO ea_anchors (ea_name, enabled_at) VALUES (?, ?)",
                (ea, now_iso),
            )
            log.info("[anchor migration] %s anchor=%s (now — 重新开始计数)", ea, now_iso)
    finally:
        conn.close()


def _default_rules_for_ea(ea_name: str) -> dict:
    """Return default rule profile (created on first check from unknown EA)."""
    return {
        "enabled": True,
        "mode": "observe",  # "observe" = log only, "enforce" = actually block
        "risk_policy": {
            "low":      {"action": "pass",  "ai_check": False},
            "medium":   {"action": "pass",  "ai_check": True},
            "high":     {"action": "check", "ai_check": True},
            "critical": {"action": "block", "ai_check": False},
        },
        "fast_rules": {
            "max_volume": 0.5,
            "max_positions": 20,
            "max_drawdown_pct": 50,
            "blocked_hours": [],
            "martin_max_level": 5,
            "min_atr_pct": 0.1,
            "max_atr_pct": 3.0,
            "max_boll_deviation": 3.0,
            "news_block_minutes_before": 30,
            "news_block_minutes_after": 30,
            # 1.0.7: 改单拦截 (Phase2 用; observe 模式只记 would-block 不真拦).
            # block_sl_widen 默认 True —— enforce 时拦「SL 往亏损方向外扩」(爆仓经典动作),
            # 安全方向, UI 可关. SL 收紧 / 改 TP 永远放行.
            "modify_guard": {
                "block_sl_widen": True,
                "max_sl_widen_points": 0,         # >0 时额外拦超过这么多点的外扩
                "max_modifies_per_position": 0,    # >0 时单仓改单次数上限
            },
            # 1.0.7: 平仓拦截 —— 默认关 (拦平仓 = 强制扛单, 危险). 显式开才生效, 且
            # 永不拦止损平仓 (浮亏<=0 一律放行, 见 _fast_rule_check_close).
            "close_guard": {
                "enabled": False,
                "min_hold_sec": 0,
                "min_profit_pct": 0,
            },
        },
    }


def _save_rules(ea_name: str, rules: dict):
    """Save rule profile for an EA."""
    conn = _db()
    try:
        for risk_level, policy in rules.get("risk_policy", {}).items():
            conn.execute(
                """INSERT OR REPLACE INTO rules (ea_name, risk_level, intent, rule_json)
                   VALUES (?, ?, '', ?)""",
                (ea_name, risk_level, json.dumps(policy))
            )
        if "fast_rules" in rules:
            conn.execute(
                """INSERT OR REPLACE INTO rules (ea_name, risk_level, intent, rule_json)
                   VALUES (?, ?, '_fast', ?)""",
                (ea_name, "global", json.dumps(rules["fast_rules"]))
            )
        if "mode" in rules:
            # 0.3.73: 把 magic 一并存到 _meta。之前只有 mode+enabled，重启后 _ea_magic_map
            # 丢失 → 所有 deal 都归 __unknown__。现在 magic 跟着 _meta 走，启动时还原。
            meta_blob = {
                "mode": rules["mode"],
                "enabled": rules.get("enabled", True),
            }
            if "magic" in rules and rules["magic"] is not None:
                try:
                    meta_blob["magic"] = int(rules["magic"])
                except (TypeError, ValueError):
                    pass
            # 0.3.151 step 2: 把护航阈值一并存到 _meta, 重启后还原
            if "thresholds" in rules and rules["thresholds"]:
                meta_blob["thresholds"] = rules["thresholds"]
            conn.execute(
                """INSERT OR REPLACE INTO rules (ea_name, risk_level, intent, rule_json)
                   VALUES (?, ?, '_meta', ?)""",
                (ea_name, "global", json.dumps(meta_blob))
            )
    finally:
        conn.close()


def _load_rules(ea_name: str) -> dict:
    """Load full rule profile for an EA, creating defaults if none exist."""
    conn = _db()
    try:
        rows = conn.execute(
            "SELECT * FROM rules WHERE ea_name = ?",
            (ea_name,)
        ).fetchall()
    finally:
        conn.close()

    if not rows:
        defaults = _default_rules_for_ea(ea_name)
        _save_rules(ea_name, defaults)
        return defaults

    # Reconstruct from stored rows
    profile = {"enabled": True, "mode": "observe", "risk_policy": {}, "fast_rules": {}}
    for r in rows:
        rdict = dict(r)
        rule = json.loads(rdict["rule_json"])
        if rdict["intent"] == "_fast":
            profile["fast_rules"] = rule
        elif rdict["intent"] == "_meta":
            profile["mode"] = rule.get("mode", "observe")
            profile["enabled"] = rule.get("enabled", True)
            if "magic" in rule:
                profile["magic"] = rule["magic"]    # 0.3.73
        else:
            profile["risk_policy"][rdict["risk_level"]] = rule
    return profile


def _fast_rule_check(check_req: dict, profile: dict, positions: list = None,
                     market: dict = None) -> dict:
    """Evaluate fast rules. Returns {approved, reason, adjusted_volume}."""
    fast = profile.get("fast_rules", {})
    risk_policy = profile.get("risk_policy", {})
    mode = profile.get("mode", "observe")

    risk_level = check_req.get("risk_level", "low")
    volume = check_req.get("volume", 0)

    # 1. Risk level policy
    policy = risk_policy.get(risk_level, {})
    action = policy.get("action", "pass")
    ai_check = policy.get("ai_check", False)

    if action == "block" and mode == "enforce":
        return {"approved": False, "reason": f"risk_level={risk_level} blocked by policy", "adjusted_volume": 0, "ai_check": False}

    # 2. Max volume
    max_vol = fast.get("max_volume", 999)
    if volume > max_vol and mode == "enforce":
        return {"approved": False, "reason": f"volume {volume} > max_volume {max_vol}", "adjusted_volume": max_vol, "ai_check": False}

    # 3. Max positions
    max_pos = fast.get("max_positions", 999)
    if positions is not None and len(positions) >= max_pos and mode == "enforce":
        return {"approved": False, "reason": f"positions {len(positions)} >= max {max_pos}", "adjusted_volume": 0, "ai_check": False}

    # 4. Max drawdown
    max_dd = fast.get("max_drawdown_pct", 100)
    if market and market.get("drawdown_pct", 0) > max_dd and mode == "enforce":
        return {"approved": False, "reason": f"drawdown {market['drawdown_pct']:.1f}% > max {max_dd}%", "adjusted_volume": 0, "ai_check": False}

    # 5. Blocked hours (server time)
    blocked = fast.get("blocked_hours", [])
    if blocked:
        hour = datetime.utcnow().hour
        if hour in blocked and mode == "enforce":
            return {"approved": False, "reason": f"hour {hour} blocked", "adjusted_volume": 0, "ai_check": False}

    # 6. Martin level check (from intent like "martin_level_3")
    intent = check_req.get("intent", "")
    if "martin" in intent.lower():
        import re
        m = re.search(r'level[_ ]?(\d+)', intent)
        level = int(m.group(1)) if m else 1
        max_martin = fast.get("martin_max_level", 5)
        if level > max_martin and mode == "enforce":
            return {"approved": False, "reason": f"martin level {level} > max {max_martin}", "adjusted_volume": 0, "ai_check": False}

    # Pass fast rules — should we do AI check?
    if ai_check and mode == "enforce":
        return {"approved": True, "reason": "fast_rules passed, AI check required", "adjusted_volume": None, "ai_check": True}

    return {"approved": True, "reason": "fast_rules passed", "adjusted_volume": None, "ai_check": False}


def _fast_rule_check_modify(check_req: dict, profile: dict) -> dict:
    """1.0.7: 改单 fast-rule —— 只拦「SL 往亏损方向外扩」(+ 单仓改单次数上限)。
    收紧 SL / 加 SL / 任何 TP 改动一律放行。返 block 决策(mode-agnostic), observe 由
    handle_check 翻成 would-block 预览。外扩判定跟 monitor 端一致:
      有旧 SL 才谈; 删 SL(set→0)=外扩; 离 ref_price 更远=外扩; 收紧/加SL→放行。"""
    mg = (profile.get("fast_rules", {}) or {}).get("modify_guard", {}) or {}
    cur_sl = float(check_req.get("cur_sl") or 0)
    new_sl = float(check_req.get("new_sl") or 0)
    ref    = float(check_req.get("ref_price") or 0)
    widened = False
    if cur_sl:
        if not new_sl:
            widened = True                       # 删掉 SL = 最危险的外扩
        elif ref and abs(ref - new_sl) > abs(ref - cur_sl):
            widened = True                       # 离当前价更远 = 外扩
    if widened and mg.get("block_sl_widen", True):
        return {"approved": False,
                "reason": "拦截: SL 往亏损方向外扩 (爆仓经典动作)。收紧 SL / 改 TP 不受限。"}
    cap = int(mg.get("max_modifies_per_position", 0) or 0)
    if cap > 0 and check_req.get("ticket"):
        try:
            cnt = _db().execute(
                "SELECT COUNT(*) AS n FROM modify_events WHERE ticket = ?",
                (check_req.get("ticket"),)
            ).fetchone()["n"] or 0
            if cnt >= cap:
                return {"approved": False, "reason": f"拦截: 单仓改单已达上限 {cap} 次"}
        except Exception:
            pass
    return {"approved": True, "reason": "改单放行"}


def _fast_rule_check_close(check_req: dict, profile: dict) -> dict:
    """1.0.7: 平仓 fast-rule —— 默认放行 (close_guard.enabled=False), 且**永不拦止损**
    (floating_pnl<=0 一律放行)。只有用户显式开启 + 盈利单 + 盈利% 低于 min_profit_pct
    时才拦 (提醒晚点平)。min_hold 因平仓 hook 没传开仓时刻, 暂不做。"""
    cg = (profile.get("fast_rules", {}) or {}).get("close_guard", {}) or {}
    if not cg.get("enabled", False):
        return {"approved": True, "reason": "平仓放行 (未开启平仓拦截)"}
    if float(check_req.get("floating_pnl") or 0) <= 0:
        return {"approved": True, "reason": "平仓放行 (止损/浮亏单永不拦)"}
    min_profit_pct = float(cg.get("min_profit_pct", 0) or 0)
    if min_profit_pct > 0:
        op_price = float(check_req.get("open_price") or 0)
        cur_price = float(check_req.get("cur_price") or 0)
        if op_price > 0 and cur_price > 0:
            if check_req.get("side") == "buy":
                profit_pct = (cur_price - op_price) / op_price * 100
            else:
                profit_pct = (op_price - cur_price) / op_price * 100
            if profit_pct < min_profit_pct:
                return {"approved": False,
                        "reason": (f"拦截: 盈利 {profit_pct:.2f}% < 最低 {min_profit_pct:.2f}% — "
                                   f"建议晚点平 (护航设置里可关「平仓拦截」)")}
    return {"approved": True, "reason": "平仓放行"}


def _record_decision(check_req: dict, result: dict, context: dict = None,
                     latency_ms: int = 0, op: str = "open") -> str:
    """Record a decision to DB. Returns decision_id.
    1.0.7: op = open|close|modify —— 平仓/改单决策传 'close'/'modify', 开仓默认 'open'."""
    decision_id = f"dg_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    conn = _db()
    try:
        # 1.0.2: 实时 /check 路径补 guarded + account_login 两列。之前漏写 →
        # 走 ALTER TABLE 的 DEFAULT 0 / NULL → 被「WHERE guarded=1 AND approved=0」
        # 的护航统计漏掉，EA 实时拦截的单子进不了统计、拦截数显示 0（用户报的 bug）。
        # 复用事后审计 tracker 同一套判定逻辑：guarded=1 当且仅当该 EA 当前在 _ea_enabled。
        _ea = check_req.get("ea_name") or "__unknown__"
        is_guarded = 1 if (_ea in _ea_enabled and _ea != "__unknown__") else 0
        _cur_login = _tracker_state.get("account_login")
        account_login_val = int(_cur_login) if _cur_login else None
        conn.execute(
            """INSERT INTO decisions
               (decision_id, ea_name, risk_level, intent, symbol, side,
                requested_volume, approved_volume, approved, reason,
                ai_checked, ai_confidence, context_json, latency_ms,
                guarded, account_login, op)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (decision_id,
             check_req.get("ea_name", ""),
             check_req.get("risk_level", "low"),
             check_req.get("intent", ""),
             check_req.get("symbol", ""),
             check_req.get("side", ""),
             check_req.get("volume", 0),
             result.get("adjusted_volume"),
             1 if result.get("approved", True) else 0,
             result.get("reason", ""),
             1 if result.get("ai_check", False) else 0,
             result.get("ai_confidence"),
             json.dumps(context or {}),
             latency_ms,
             is_guarded,
             account_login_val,
             op or "open")
        )
    finally:
        conn.close()
    return decision_id


def _record_order_event(decision_id: str, event: dict):
    """Record or update order lifecycle event."""
    conn = _db()
    try:
        existing = conn.execute(
            "SELECT decision_id FROM orders WHERE decision_id = ?",
            (decision_id,)
        ).fetchone()

        if existing:
            # Update
            sets = []
            vals = []
            for k in ("ticket", "open_price", "open_time", "close_price",
                       "close_time", "pnl", "holding_sec", "close_reason"):
                if k in event:
                    sets.append(f"{k} = ?")
                    vals.append(event[k])
            if sets:
                vals.append(decision_id)
                conn.execute(f"UPDATE orders SET {', '.join(sets)} WHERE decision_id = ?", vals)
        else:
            conn.execute(
                """INSERT OR IGNORE INTO orders
                   (decision_id, ticket, open_price, open_time,
                    close_price, close_time, pnl, holding_sec, close_reason)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (decision_id,
                 event.get("ticket"),
                 event.get("open_price"),
                 event.get("open_time"),
                 event.get("close_price"),
                 event.get("close_time"),
                 event.get("pnl"),
                 event.get("holding_sec"),
                 event.get("close_reason"))
            )
    finally:
        conn.close()


# ----------------------------------------------------------------------------
# 0.3.66 P1-C: AI cache + async worker pool
# ----------------------------------------------------------------------------
def _ai_cache_key(ea_name: str, check_req: dict, context: dict | None) -> str:
    """把请求离散化成 cache 桶。
    精确字段：ea/intent/risk/symbol/side
    桶字段：volume → 0.1 步、drawdown → 5% 步、position_count → 3 单步
    sha256 截前 32 字符避免太长。"""
    ctx = context or {}
    vol = float(check_req.get("volume", 0) or 0)
    dd  = float(ctx.get("drawdown_pct", 0) or 0)
    pos = int(ctx.get("position_count", 0) or 0)
    bucket = {
        "ea":      ea_name,
        "intent":  (check_req.get("intent") or "").lower(),
        "risk":    (check_req.get("risk_level") or "low").lower(),
        "symbol":  (check_req.get("symbol") or "").upper(),
        "side":    (check_req.get("side") or "").lower(),
        "vol_b":   round(vol * 10) / 10,
        "dd_b":    int(dd // 5) * 5,
        "pos_b":   min(int(pos // 3) * 3, 30),
    }
    raw = json.dumps(bucket, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def _get_ai_cache(cache_key: str) -> dict | None:
    """命中 → 返回 decision dict 并 hit_count++；过期 / miss → 返回 None。"""
    conn = _db()
    try:
        row = conn.execute(
            "SELECT decision, expires_at FROM ai_cache WHERE cache_key = ?",
            (cache_key,)
        ).fetchone()
        if not row:
            return None
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if row["expires_at"] < now_iso:
            # 过期 — 顺手删
            conn.execute("DELETE FROM ai_cache WHERE cache_key = ?", (cache_key,))
            return None
        try:
            decision = json.loads(row["decision"])
        except Exception:
            return None
        conn.execute(
            "UPDATE ai_cache SET hit_count = hit_count + 1 WHERE cache_key = ?",
            (cache_key,)
        )
        return decision
    finally:
        conn.close()


def _save_ai_cache(cache_key: str, ea_name: str, decision: dict,
                   ttl_sec: int = AI_CACHE_TTL_SEC) -> None:
    """写入 / 覆盖 cache。超 AI_CACHE_MAX_ROWS 时按 created_at 删最旧 20%."""
    now = datetime.now(timezone.utc)
    expires = now + timedelta(seconds=ttl_sec)
    conn = _db()
    try:
        conn.execute(
            """INSERT OR REPLACE INTO ai_cache
               (cache_key, ea_name, decision, expires_at)
               VALUES (?, ?, ?, ?)""",
            (cache_key, ea_name, json.dumps(decision, ensure_ascii=False),
             expires.strftime("%Y-%m-%dT%H:%M:%SZ"))
        )
        # 容量护栏
        cnt = conn.execute("SELECT COUNT(*) AS c FROM ai_cache").fetchone()["c"]
        if cnt > AI_CACHE_MAX_ROWS:
            evict_n = max(int(cnt * 0.2), 100)
            conn.execute(
                "DELETE FROM ai_cache WHERE cache_key IN "
                "(SELECT cache_key FROM ai_cache ORDER BY created_at LIMIT ?)",
                (evict_n,)
            )
            log.info("ai_cache evicted oldest %d rows (count was %d)", evict_n, cnt)
    finally:
        conn.close()


def _llm_stub_decision(check_req: dict) -> dict:
    """fallback 启发式 — 没配 LLM 时用。"""
    intent = (check_req.get("intent") or "").lower()
    risk_level = (check_req.get("risk_level") or "low").lower()
    if risk_level == "critical":
        return {"approved": False, "confidence": 0.85,
                "reason": "AI(stub): critical risk — 默认拦截",
                "adjusted_volume": 0}
    if risk_level == "high":
        return {"approved": True, "confidence": 0.70,
                "reason": f"AI(stub): high-risk {intent} pass — 监控密切关注",
                "adjusted_volume": None}
    return {"approved": True, "confidence": 0.90,
            "reason": "AI(stub): rules consistent with EA strategy",
            "adjusted_volume": None}


def _call_anthropic_llm(prompt: str, max_tokens: int = 300,
                        timeout: float = 8.0) -> str | None:
    """调 Anthropic 兼容协议（Anthropic / Fay 代理 / 用户 custom 代理 都行）。

    0.3.99: 跟主 AI 通道统一 — Electron 端 orderguard.js spawn 时把
    `token-store.spawnEnvOverrides()` 返回的 env 注入进来：
      - Fay 模式 → ANTHROPIC_AUTH_TOKEN=<Fay token> + ANTHROPIC_BASE_URL=<Fay 代理>
                  + ANTHROPIC_MODEL=<Fay 模型别名>
      - custom 模式 → 用户在「Token」tab 填的三个值
      - system 模式 → 空，回落到 OS env 里 ANTHROPIC_API_KEY（老用户）
    没 token / 没 key 就返 None，外层回落 stub。
    """
    import urllib.request
    auth_token = os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip()
    api_key    = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not (auth_token or api_key):
        return None
    base_url = (os.getenv("ANTHROPIC_BASE_URL", "") or "https://api.anthropic.com").rstrip("/")
    # ANTHROPIC_MODEL 是 spawnEnvOverrides 注入的（主通道用的 model 别名）
    # EASYDEAL_OG_LLM_MODEL 是老的 env 覆盖（向前兼容，没动它）
    model = (os.getenv("ANTHROPIC_MODEL", "").strip()
             or os.getenv("EASYDEAL_OG_LLM_MODEL", "").strip()
             or "claude-haiku-4-5")
    url = f"{base_url}/v1/messages"
    body = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
    }
    # AUTH_TOKEN 优先（Fay / custom 代理走 Bearer）；
    # 没有则退到 x-api-key（直连 Anthropic 官方 API 的标准头）
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    else:
        headers["x-api-key"] = api_key
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
            blocks = data.get("content") or []
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "text":
                    return b.get("text", "")
            return None
    except Exception as e:
        log.warning("Anthropic LLM call failed (url=%s model=%s): %s", url, model, e)
        return None


async def _call_llm_for_decision(ea_name: str, check_req: dict, context: dict) -> dict:
    """0.3.74 P2-A: 真 LLM hook。优先调 Anthropic 兼容端点（主 AI 通道注入的
    ANTHROPIC_AUTH_TOKEN / API_KEY），失败 / 没凭据 → 回退 stub 启发式。
    0.3.99: 凭据来源不再限 ANTHROPIC_API_KEY，AUTH_TOKEN 也算（Fay / custom 代理）。
    LLM 必须返回 JSON: {approved, confidence, reason, adjusted_volume}"""
    if not (os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip()
            or os.getenv("ANTHROPIC_API_KEY", "").strip()):
        # 没配 key/token → 维持 stub 行为
        await asyncio.sleep(0.1)
        return _llm_stub_decision(check_req)

    # 构 prompt：EA 上下文 + 决策上下文 + 输出格式约束
    profile_brief = ""
    try:
        profile = _load_rules(ea_name)
        profile_brief = (f"fast_rules={profile.get('fast_rules',{})}, "
                         f"risk_policy={profile.get('risk_policy',{})}")
    except Exception:
        pass

    prompt = (
        f"你是 MT5 交易 EA 的风控审计员。给定一笔即将下单的请求 + EA 已有规则 + 市场上下文，"
        f"判断这笔单是放行 / 拦截 / 调整手数。\n\n"
        f"EA: {ea_name}\n"
        f"已有规则: {profile_brief}\n"
        f"请求: {json.dumps(check_req, ensure_ascii=False)}\n"
        f"市场上下文: {json.dumps(context, ensure_ascii=False)}\n\n"
        f"输出**仅 JSON**（不要其他文字），格式严格：\n"
        f'{{"approved": true/false, "confidence": 0.0~1.0, '
        f'"reason": "<一句话原因 50 字内>", '
        f'"adjusted_volume": <number or null>}}\n\n'
        f"判据：critical 风险 + 高回撤 + 持仓密集时倾向 block；"
        f"low 风险 + 规则范围内倾向 approve；中间地带降手数 (adjusted_volume)。"
    )

    # 在 thread executor 里跑 sync HTTP（避免阻塞 event loop）
    loop = asyncio.get_event_loop()
    text = await loop.run_in_executor(None, _call_anthropic_llm, prompt, 300, 8.0)
    if not text:
        return _llm_stub_decision(check_req)

    # 解析 JSON 输出
    try:
        # 容错：LLM 可能在 JSON 外包 ```json ... ```
        s = text.strip()
        if s.startswith("```"):
            s = s.split("```", 2)[1]
            if s.startswith("json"):
                s = s[4:].strip()
            else:
                s = s.strip()
        # 取第一个 { 到最后一个 }
        i, j = s.find("{"), s.rfind("}")
        if i < 0 or j <= i:
            raise ValueError("no JSON block in LLM output")
        parsed = json.loads(s[i:j+1])
        return {
            "approved":        bool(parsed.get("approved", True)),
            "confidence":      float(parsed.get("confidence", 0.7)),
            "reason":          str(parsed.get("reason", "AI: ok"))[:200],
            "adjusted_volume": parsed.get("adjusted_volume"),
        }
    except Exception as e:
        log.warning("LLM JSON parse failed: %s; raw=%s", e, text[:200])
        return _llm_stub_decision(check_req)


async def _ai_worker(worker_id: int):
    """异步 worker — 从 _ai_queue 拿 job，调 LLM，写 cache。
    job = {cache_key, ea_name, check_req, context}"""
    log.info("AI worker #%d started", worker_id)
    while True:
        try:
            job = await _ai_queue.get()
        except asyncio.CancelledError:
            log.info("AI worker #%d cancelled", worker_id)
            break
        if job is None:
            _ai_queue.task_done()
            break
        try:
            cache_key = job["cache_key"]
            ea_name   = job["ea_name"]
            decision  = await _call_llm_for_decision(
                ea_name, job["check_req"], job["context"]
            )
            _save_ai_cache(cache_key, ea_name, decision)
        except Exception as e:
            log.exception("AI worker #%d job failed: %s", worker_id, e)
        finally:
            _ai_inflight.discard(job.get("cache_key"))
            _ai_queue.task_done()
    log.info("AI worker #%d exited", worker_id)


def _enqueue_ai_eval(cache_key: str, ea_name: str,
                      check_req: dict, context: dict) -> bool:
    """从 sync 线程（Flask request handler）入队到 asyncio.Queue。
    返回 True = 已入队 / False = 队列没准备好或已有同 key 在跑。"""
    if _ai_queue is None or _ai_workers_loop is None:
        return False
    if cache_key in _ai_inflight:
        return False
    _ai_inflight.add(cache_key)
    job = {
        "cache_key": cache_key,
        "ea_name":   ea_name,
        "check_req": check_req,
        "context":   context,
    }
    try:
        # Flask 线程 → asyncio.Queue.put_nowait 不安全，必须用 call_soon_threadsafe
        _ai_workers_loop.call_soon_threadsafe(_ai_queue.put_nowait, job)
        return True
    except Exception as e:
        log.warning("enqueue_ai_eval failed: %s", e)
        _ai_inflight.discard(cache_key)
        return False


# ----------------------------------------------------------------------------
# 0.3.74 P3: Rule learning loop — 反馈自学习
# ----------------------------------------------------------------------------
# 每 24h 跑一次（可调）。规则：
#   - ≥30 单的统计才考虑调整
#   - 单条 rule_key 7 天 cooldown（applied / dismissed 后都算重置）
#   - 默认 dry_run=pending — 用户必须显式 apply
#   - 所有变更保留 old_value 可一键 rollback
# ----------------------------------------------------------------------------
RULE_LEARNING_INTERVAL_SEC = int(os.getenv("EASYDEAL_OG_LEARNING_INTERVAL", "86400"))  # 24h
RULE_LEARNING_MIN_SAMPLES = 30


def _generate_rule_suggestions_for_ea(ea_name: str) -> int:
    """扫描 EA 近 30 天 closed orders，生成 pending 建议。返回新增建议数。
    跳过已 cooldown 中的 rule_key（最近 7 天 applied/dismissed/pending 过的）。"""
    from collections import defaultdict
    import re

    if ea_name == "__unknown__":
        return 0

    cd_iso = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn = _db()
    try:
        # 1) 最近 7 天动过 / 还在 pending 的 rule_key（cooldown 集合）
        cd_rows = conn.execute(
            """SELECT DISTINCT rule_key FROM rule_adjustments
               WHERE ea_name = ? AND (
                   (status='applied'    AND applied_at >= ?) OR
                   (status='dismissed'  AND dismissed_at >= ?) OR
                   (status='rolled_back' AND rolled_back_at >= ?) OR
                   (status='pending')
               )""",
            (ea_name, cd_iso, cd_iso, cd_iso)
        ).fetchall()
        cooldown_keys = {r["rule_key"] for r in cd_rows}

        # 2) 拉 closed orders + decisions
        rows = conn.execute(
            """SELECT d.risk_level, d.intent, d.requested_volume, d.context_json,
                      d.approved, o.pnl, o.close_time
               FROM decisions d
               LEFT JOIN orders o ON o.decision_id = d.decision_id
               WHERE d.ea_name = ? AND d.ts >= ? AND o.close_time IS NOT NULL""",
            (ea_name, since)
        ).fetchall()
        if not rows:
            return 0

        profile = _load_rules(ea_name)
        fast = profile.get("fast_rules", {}) or {}
        risk_pol = profile.get("risk_policy", {}) or {}
        suggestions = []

        # 3) Martin level cap — 找 win_rate < 30% 的最低 level
        martin_by_lvl = defaultdict(lambda: {"win": 0, "tot": 0, "pnl_sum": 0.0})
        for r in rows:
            intent = (r["intent"] or "").lower()
            if "martin" not in intent:
                continue
            m = re.search(r'level[_ ]?(\d+)', intent)
            level = int(m.group(1)) if m else 1
            b = martin_by_lvl[level]
            b["tot"] += 1
            b["pnl_sum"] += (r["pnl"] or 0)
            if (r["pnl"] or 0) > 0:
                b["win"] += 1

        if "fast_rules.martin_max_level" not in cooldown_keys:
            current_cap = int(fast.get("martin_max_level", 5) or 5)
            for level in sorted(martin_by_lvl):
                b = martin_by_lvl[level]
                if b["tot"] < RULE_LEARNING_MIN_SAMPLES:
                    continue
                wr = b["win"] / b["tot"]
                if wr < 0.30 and (level - 1) < current_cap and (level - 1) >= 1:
                    avg_pnl = b["pnl_sum"] / b["tot"]
                    suggestions.append({
                        "rule_key": "fast_rules.martin_max_level",
                        "old_value": current_cap,
                        "new_value": level - 1,
                        "reason": (f"近 30 天 martin level={level} 的 {b['tot']} 单胜率仅 "
                                   f"{wr*100:.1f}%（avg PnL {avg_pnl:+.2f}），建议把 "
                                   f"martin_max_level 从 {current_cap} 降到 {level-1}"),
                        "sample_n": b["tot"],
                        "win_rate": round(wr, 4),
                        "metric_value": float(level),
                    })
                    break       # 一个 rule_key 一轮只生成一条

        # 4) per-risk action policy
        by_risk = defaultdict(lambda: {"win": 0, "tot": 0, "pnl_sum": 0.0})
        for r in rows:
            rl = (r["risk_level"] or "low").lower()
            b = by_risk[rl]
            b["tot"] += 1
            b["pnl_sum"] += (r["pnl"] or 0)
            if (r["pnl"] or 0) > 0:
                b["win"] += 1

        for rl, b in by_risk.items():
            if b["tot"] < 50:        # action 调整门槛比 martin 高一些
                continue
            key = f"risk_policy.{rl}.action"
            if key in cooldown_keys:
                continue
            wr = b["win"] / b["tot"]
            avg_pnl = b["pnl_sum"] / b["tot"]
            current_action = (risk_pol.get(rl, {}) or {}).get("action", "pass")

            if wr < 0.40 and current_action == "pass":
                suggestions.append({
                    "rule_key": key,
                    "old_value": current_action,
                    "new_value": "check",
                    "reason": (f"risk={rl} 近 30 天 {b['tot']} 单胜率 {wr*100:.1f}%"
                               f"（avg PnL {avg_pnl:+.2f}）— 建议从 pass 升级到 check"
                               f"（每单走 AI 评估）"),
                    "sample_n": b["tot"],
                    "win_rate": round(wr, 4),
                    "metric_value": wr,
                })
            elif wr < 0.30 and current_action == "check":
                suggestions.append({
                    "rule_key": key,
                    "old_value": current_action,
                    "new_value": "block",
                    "reason": (f"risk={rl} 近 30 天 {b['tot']} 单胜率 {wr*100:.1f}%"
                               f" 持续低于 30% — 建议从 check 升级到 block 直接拦"),
                    "sample_n": b["tot"],
                    "win_rate": round(wr, 4),
                    "metric_value": wr,
                })
            elif wr > 0.75 and current_action == "block" and b["tot"] >= 100:
                suggestions.append({
                    "rule_key": key,
                    "old_value": current_action,
                    "new_value": "check",
                    "reason": (f"risk={rl} 近 30 天 {b['tot']} 单胜率 {wr*100:.1f}%"
                               f" 表现良好，建议从 block 放宽到 check"),
                    "sample_n": b["tot"],
                    "win_rate": round(wr, 4),
                    "metric_value": wr,
                })

        # 5) max_drawdown_pct tighten — 检测高回撤下交易表现
        # 提取 decision.context_json.drawdown_pct，分两桶（above/below current threshold）
        max_dd_current = float(fast.get("max_drawdown_pct", 50) or 50)
        above = {"win": 0, "tot": 0, "pnl_sum": 0.0}
        below = {"win": 0, "tot": 0, "pnl_sum": 0.0}
        for r in rows:
            try:
                ctx = json.loads(r["context_json"] or "{}")
            except Exception:
                continue
            dd = float(ctx.get("drawdown_pct", 0) or 0)
            bucket = above if dd >= max_dd_current * 0.6 else below
            bucket["tot"] += 1
            bucket["pnl_sum"] += (r["pnl"] or 0)
            if (r["pnl"] or 0) > 0:
                bucket["win"] += 1
        if (above["tot"] >= RULE_LEARNING_MIN_SAMPLES
                and below["tot"] >= RULE_LEARNING_MIN_SAMPLES
                and "fast_rules.max_drawdown_pct" not in cooldown_keys):
            wr_above = above["win"] / above["tot"]
            wr_below = below["win"] / below["tot"]
            # 高回撤胜率显著差 → 建议把阈值收紧到 0.6 * current（即在更低 dd 就拦）
            if wr_above < wr_below * 0.7 and wr_above < 0.40:
                new_threshold = round(max_dd_current * 0.6, 1)
                if 0 < new_threshold < max_dd_current:
                    suggestions.append({
                        "rule_key": "fast_rules.max_drawdown_pct",
                        "old_value": max_dd_current,
                        "new_value": new_threshold,
                        "reason": (f"drawdown ≥ {max_dd_current*0.6:.1f}% 时 {above['tot']} 单胜率 "
                                   f"{wr_above*100:.1f}%，低回撤时 {below['tot']} 单胜率 "
                                   f"{wr_below*100:.1f}% — 建议把 max_drawdown_pct 从 "
                                   f"{max_dd_current} 收紧到 {new_threshold}"),
                        "sample_n": above["tot"],
                        "win_rate": round(wr_above, 4),
                        "metric_value": max_dd_current * 0.6,
                    })

        # 6) blocked_hours — 按下单 UTC 小时分桶找低胜率时段
        # context_json.hour 由 _record_post_hoc_decision 写入（0.3.75+）；老数据没这字段
        if "fast_rules.blocked_hours" not in cooldown_keys:
            by_hour = defaultdict(lambda: {"win": 0, "tot": 0})
            for r in rows:
                try:
                    ctx = json.loads(r["context_json"] or "{}")
                except Exception:
                    continue
                h = ctx.get("hour")
                if not isinstance(h, int) or h < 0 or h > 23:
                    continue
                b = by_hour[h]
                b["tot"] += 1
                if (r["pnl"] or 0) > 0:
                    b["win"] += 1
            current_blocked = set(int(x) for x in (fast.get("blocked_hours") or []) if isinstance(x, int))
            # 找该加 block 的小时（胜率 < 25% + ≥30 单 + 还没被 block）
            add_hours = []
            for h, b in by_hour.items():
                if b["tot"] < 30 or h in current_blocked:
                    continue
                if b["win"] / b["tot"] < 0.25:
                    add_hours.append((h, b["win"] / b["tot"], b["tot"]))
            # 找该解 block 的小时（已 block 但胜率 > 60% + ≥30 单 — 可能是误 block）
            remove_hours = []
            for h in list(current_blocked):
                b = by_hour.get(h)
                if not b or b["tot"] < 30:
                    continue
                if b["win"] / b["tot"] > 0.60:
                    remove_hours.append((h, b["win"] / b["tot"], b["tot"]))
            if add_hours:
                # 一轮只加最差的一个小时（保守）
                add_hours.sort(key=lambda x: x[1])
                h, wr, n = add_hours[0]
                new_blocked = sorted(current_blocked | {h})
                suggestions.append({
                    "rule_key": "fast_rules.blocked_hours",
                    "old_value": sorted(current_blocked),
                    "new_value": new_blocked,
                    "reason": (f"UTC {h}:00 时段近 30 天 {n} 单胜率 {wr*100:.1f}%（远低于其他时段）"
                               f"— 建议加入 blocked_hours 不让交易"),
                    "sample_n": n,
                    "win_rate": round(wr, 4),
                    "metric_value": float(h),
                })
            elif remove_hours:
                remove_hours.sort(key=lambda x: -x[1])
                h, wr, n = remove_hours[0]
                new_blocked = sorted(current_blocked - {h})
                suggestions.append({
                    "rule_key": "fast_rules.blocked_hours",
                    "old_value": sorted(current_blocked),
                    "new_value": new_blocked,
                    "reason": (f"UTC {h}:00 时段近 30 天 {n} 单胜率 {wr*100:.1f}% 表现良好"
                               f"— 建议从 blocked_hours 移除"),
                    "sample_n": n,
                    "win_rate": round(wr, 4),
                    "metric_value": float(h),
                })

        # 7) max_volume — 找高 volume 桶低胜率的边界
        if "fast_rules.max_volume" not in cooldown_keys:
            current_max_vol = float(fast.get("max_volume", 0.5) or 0.5)
            by_vol = defaultdict(lambda: {"win": 0, "tot": 0})
            for r in rows:
                v = r["requested_volume"]
                if v is None:
                    continue
                vol_bucket = round(float(v) * 20) / 20.0   # 0.05 步
                b = by_vol[vol_bucket]
                b["tot"] += 1
                if (r["pnl"] or 0) > 0:
                    b["win"] += 1
            # 找最大的、胜率 < 30%、样本足够的 volume
            bad_high_vol = None
            for vol in sorted(by_vol.keys(), reverse=True):
                b = by_vol[vol]
                if b["tot"] < 30 or vol > current_max_vol:
                    continue
                if b["win"] / b["tot"] < 0.30:
                    bad_high_vol = (vol, b["win"] / b["tot"], b["tot"])
                    break
            if bad_high_vol:
                vol, wr, n = bad_high_vol
                new_max = round(max(vol - 0.05, 0.01), 2)
                if new_max > 0 and new_max < current_max_vol:
                    suggestions.append({
                        "rule_key": "fast_rules.max_volume",
                        "old_value": current_max_vol,
                        "new_value": new_max,
                        "reason": (f"volume={vol} 单子近 30 天 {n} 单胜率仅 {wr*100:.1f}%"
                                   f" — 建议 max_volume 从 {current_max_vol} 收紧到 {new_max}"),
                        "sample_n": n,
                        "win_rate": round(wr, 4),
                        "metric_value": vol,
                    })

        # 8) max_positions — 看并发持仓 ≥ K 时胜率下降的拐点
        if "fast_rules.max_positions" not in cooldown_keys:
            current_max_pos = int(fast.get("max_positions", 20) or 20)
            by_posct = defaultdict(lambda: {"win": 0, "tot": 0})
            for r in rows:
                try:
                    ctx = json.loads(r["context_json"] or "{}")
                except Exception:
                    continue
                pc = ctx.get("position_count")
                if not isinstance(pc, int) or pc < 0:
                    continue
                bucket = (pc // 3) * 3   # 3-step 桶
                b = by_posct[bucket]
                b["tot"] += 1
                if (r["pnl"] or 0) > 0:
                    b["win"] += 1
            # 找最低的 bucket K，使得 K 和 K+ 的总胜率 < 30%
            sorted_buckets = sorted(by_posct.keys())
            for K in sorted_buckets:
                # 聚合 >= K 的所有桶
                agg_w = sum(by_posct[k]["win"] for k in sorted_buckets if k >= K)
                agg_t = sum(by_posct[k]["tot"] for k in sorted_buckets if k >= K)
                if agg_t < 30 or K <= 0:
                    continue
                wr = agg_w / agg_t
                if wr < 0.30 and K < current_max_pos:
                    suggestions.append({
                        "rule_key": "fast_rules.max_positions",
                        "old_value": current_max_pos,
                        "new_value": K,
                        "reason": (f"持仓数 ≥ {K} 时近 30 天 {agg_t} 单胜率 {wr*100:.1f}%"
                                   f" — 建议 max_positions 从 {current_max_pos} 收紧到 {K}"),
                        "sample_n": agg_t,
                        "win_rate": round(wr, 4),
                        "metric_value": float(K),
                    })
                    break

        # 10) [1.0.7] SL 外扩 ↔ 亏损 — 有外扩改单的仓 vs 没有的, 比胜率/avg pnl.
        # block_sl_widen 默认 True, 这条只在用户手动关了之后、且数据证明外扩确实更差时再建议开回来.
        if "fast_rules.modify_guard.block_sl_widen" not in cooldown_keys:
            mg = (fast.get("modify_guard") or {})
            if not mg.get("block_sl_widen", True):
                widen_rows = conn.execute(
                    """SELECT o.pnl AS pnl,
                              EXISTS(SELECT 1 FROM modify_events m
                                     WHERE m.ticket = o.ticket AND m.sl_widened = 1) AS widened
                       FROM orders o JOIN decisions d ON d.decision_id = o.decision_id
                       WHERE d.ea_name = ? AND d.ts >= ? AND o.close_time IS NOT NULL
                         AND (d.op = 'open' OR d.op IS NULL)""",
                    (ea_name, since)
                ).fetchall()
                w_tot = w_win = 0; w_pnl = 0.0; n_tot = n_win = 0; n_pnl = 0.0
                for r in widen_rows:
                    pnl = r["pnl"] or 0
                    if r["widened"]:
                        w_tot += 1; w_pnl += pnl; w_win += 1 if pnl > 0 else 0
                    else:
                        n_tot += 1; n_pnl += pnl; n_win += 1 if pnl > 0 else 0
                if w_tot >= 10 and n_tot >= 10:
                    w_wr = w_win / w_tot; n_wr = n_win / n_tot
                    w_avg = w_pnl / w_tot; n_avg = n_pnl / n_tot
                    if w_wr < n_wr - 0.10 or w_avg < n_avg:
                        suggestions.append({
                            "rule_key": "fast_rules.modify_guard.block_sl_widen",
                            "old_value": False, "new_value": True,
                            "reason": (f"近 30 天「SL 往亏损方向外扩」过的 {w_tot} 单胜率 {w_wr*100:.1f}%"
                                       f"(avg {w_avg:+.2f}), 没外扩的 {n_tot} 单胜率 {n_wr*100:.1f}%"
                                       f"(avg {n_avg:+.2f}) — 建议开启「拦截 SL 外扩」"),
                            "sample_n": w_tot, "win_rate": round(w_wr, 4),
                            "metric_value": round(w_avg, 2),
                        })

        # 11) [1.0.7] 平仓偏早 — 盈利单离 TP 还很远就平 (建议开 close_guard 提醒晚点平; 永不拦止损)
        if "fast_rules.close_guard.min_profit_pct" not in cooldown_keys:
            close_rows = conn.execute(
                "SELECT context_json FROM decisions WHERE ea_name = ? AND op = 'close' AND ts >= ?",
                (ea_name, since)
            ).fetchall()
            early_tot = early_far = 0
            for r in close_rows:
                try:
                    c = json.loads(r["context_json"] or "{}")
                except Exception:
                    continue
                if (c.get("pnl") or 0) > 0 and c.get("dist_to_tp_pct") is not None and c.get("tp_open"):
                    early_tot += 1
                    if c["dist_to_tp_pct"] > 0.5:
                        early_far += 1
            if early_tot >= RULE_LEARNING_MIN_SAMPLES and early_far / early_tot > 0.6:
                cg = (fast.get("close_guard") or {})
                if not cg.get("enabled"):
                    suggestions.append({
                        "rule_key": "fast_rules.close_guard.min_profit_pct",
                        "old_value": cg.get("min_profit_pct", 0), "new_value": 0.5,
                        "reason": (f"近 30 天 {early_far}/{early_tot} 笔盈利平仓在离 TP 还有 >0.5% 时就平了"
                                   f"(偏早平). 可开「平仓拦截」+ min_profit_pct=0.5% 提醒晚点平 "
                                   f"(⚠ 平仓拦截默认关、需你确认; 永不拦止损平仓)"),
                        "sample_n": early_tot, "win_rate": None,
                        "metric_value": round(early_far / early_tot, 4),
                    })

        # 12) [1.0.7] 改单频率 ↔ 亏损 — 单仓改单 ≥3 次的是否明显更差
        if "fast_rules.modify_guard.max_modifies_per_position" not in cooldown_keys:
            freq_rows = conn.execute(
                """SELECT o.pnl AS pnl,
                          (SELECT COUNT(*) FROM modify_events m WHERE m.ticket = o.ticket) AS mods
                   FROM orders o JOIN decisions d ON d.decision_id = o.decision_id
                   WHERE d.ea_name = ? AND d.ts >= ? AND o.close_time IS NOT NULL
                     AND (d.op = 'open' OR d.op IS NULL)""",
                (ea_name, since)
            ).fetchall()
            HI = 3; hi_tot = hi_win = lo_tot = lo_win = 0
            for r in freq_rows:
                pnl = r["pnl"] or 0
                if (r["mods"] or 0) >= HI:
                    hi_tot += 1; hi_win += 1 if pnl > 0 else 0
                else:
                    lo_tot += 1; lo_win += 1 if pnl > 0 else 0
            if hi_tot >= 10 and lo_tot >= 10:
                hi_wr = hi_win / hi_tot; lo_wr = lo_win / lo_tot
                cur_cap = int((fast.get("modify_guard") or {}).get("max_modifies_per_position", 0) or 0)
                if hi_wr < 0.30 and hi_wr < lo_wr - 0.15 and (cur_cap == 0 or cur_cap > HI):
                    suggestions.append({
                        "rule_key": "fast_rules.modify_guard.max_modifies_per_position",
                        "old_value": cur_cap, "new_value": HI,
                        "reason": (f"近 30 天单仓改单 ≥{HI} 次的 {hi_tot} 单胜率仅 {hi_wr*100:.1f}%, "
                                   f"改单少的 {lo_tot} 单胜率 {lo_wr*100:.1f}% — 建议单仓改单上限 {HI} 次"),
                        "sample_n": hi_tot, "win_rate": round(hi_wr, 4),
                        "metric_value": float(HI),
                    })

        # 9) Insert
        for s in suggestions:
            conn.execute(
                """INSERT INTO rule_adjustments
                   (ea_name, rule_key, old_value, new_value, reason,
                    sample_n, win_rate, metric_value, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')""",
                (ea_name, s["rule_key"],
                 json.dumps(s["old_value"]), json.dumps(s["new_value"]),
                 s["reason"], s["sample_n"],
                 s.get("win_rate"), s.get("metric_value"))
            )
        if suggestions:
            log.info("Generated %d rule suggestions for %s",
                     len(suggestions), ea_name)
        return len(suggestions)
    finally:
        conn.close()


async def _rule_learning_loop():
    """每 RULE_LEARNING_INTERVAL_SEC 跑一次。启动延迟 5 min 避免冷启冲突。"""
    log.info("Rule learning loop 启动 — interval=%ds, min_samples=%d",
             RULE_LEARNING_INTERVAL_SEC, RULE_LEARNING_MIN_SAMPLES)
    await asyncio.sleep(300)
    while True:
        try:
            total = 0
            for ea_name in list(_ea_enabled):
                try:
                    total += _generate_rule_suggestions_for_ea(ea_name)
                except Exception as e:
                    log.exception("learning loop EA=%s failed: %s", ea_name, e)
            if total:
                log.info("Learning loop pass done — %d new suggestions across %d EAs",
                         total, len(_ea_enabled))
        except asyncio.CancelledError:
            log.info("Rule learning loop cancelled")
            break
        except Exception as e:
            log.exception("learning loop error: %s", e)
        try:
            await asyncio.sleep(RULE_LEARNING_INTERVAL_SEC)
        except asyncio.CancelledError:
            break


def _apply_rule_value(profile: dict, rule_key: str, value) -> bool:
    """按 dotted rule_key 把 value 写进 profile（in-place）。返回是否成功。"""
    parts = rule_key.split(".")
    if parts[0] == "fast_rules" and len(parts) == 2:
        profile.setdefault("fast_rules", {})[parts[1]] = value
        return True
    # 1.0.7: fast_rules.modify_guard.<sub> / fast_rules.close_guard.<sub> 嵌套 (len3),
    # 否则平仓/改单学习建议 apply 时静默 no-op.
    if parts[0] == "fast_rules" and len(parts) == 3:
        profile.setdefault("fast_rules", {}).setdefault(parts[1], {})[parts[2]] = value
        return True
    if parts[0] == "risk_policy" and len(parts) == 3:
        profile.setdefault("risk_policy", {}).setdefault(parts[1], {})[parts[2]] = value
        return True
    return False


def _update_fast_rule(ea_name: str, key: str, value):
    """1.0.8: 只更新 fast_rules (写 _fast 行), 不碰 _meta / risk_policy。
    —— 不能走 _load_rules → 改 → _save_rules 全量回写: loader 不读 _meta.thresholds,
    saver 见 profile 里没有 thresholds 就重写 _meta → **会把护航阈值 (单笔浮亏/持仓时长/
    整体浮亏/锁仓) 抹掉**。所以这里只 INSERT OR REPLACE _fast 那一行。
    key 形如 'fast_rules.close_guard.enabled' (len3 嵌套) 或 'fast_rules.<k>' (len2)。
    返回更新后的 fast_rules dict; key 非法返回 None。"""
    parts = key.split(".")
    if parts[0] != "fast_rules" or len(parts) not in (2, 3):
        return None
    profile = _load_rules(ea_name)            # 确保 defaults 已落库 (含 modify_guard/close_guard)
    fast = dict(profile.get("fast_rules", {}) or {})
    if len(parts) == 2:
        fast[parts[1]] = value
    else:
        sub = dict(fast.get(parts[1], {}) or {})
        sub[parts[2]] = value
        fast[parts[1]] = sub
    conn = _db()
    try:
        conn.execute(
            """INSERT OR REPLACE INTO rules (ea_name, risk_level, intent, rule_json)
               VALUES (?, 'global', '_fast', ?)""",
            (ea_name, json.dumps(fast)),
        )
    finally:
        conn.close()
    return fast


# ----------------------------------------------------------------------------
# Core check handler
# ----------------------------------------------------------------------------
def handle_check(check_req: dict, context: dict | None = None) -> dict:
    """Process an order check request. Returns the full decision result.

    0.3.66 P1-A/C 升级：
      - enforce 模式真正 block；observe 仍然 approve + 标 would-block
      - AI 走 cache 命中（如果有的话）+ 异步入队预热（miss 时）
      - 同步 AI 调用被砍掉 — 任何阻塞 EA 超 100ms 的路径都不可接受
    """
    t0 = time.time()
    ea_name = check_req.get("ea_name", "unknown")
    context = context or {}

    # Load or create rules for this EA
    profile = _load_rules(ea_name)
    mode = profile.get("mode", "observe")

    if not profile.get("enabled", True):
        return {
            "approved": True,
            "reason": "OrderGuard disabled for this EA",
            "adjusted_volume": None,
            "decision_id": None,
        }

    # 1.0.7: 按 op 分发 —— 平仓/改单走各自 fast-rule (不走 AI cache / 手数调整那套).
    # 决策 mode-agnostic 返回; observe 模式把 would-block 翻成 approve+预览 reason.
    op = (check_req.get("op") or "open").lower()
    if op in ("modify", "close"):
        res = (_fast_rule_check_modify(check_req, profile) if op == "modify"
               else _fast_rule_check_close(check_req, profile))
        if mode != "enforce" and not res.get("approved", True):
            res = {"approved": True,
                   "reason": f"⚠ would-block (监控模式仅记录): {res.get('reason','')}"}
        latency_ms = int((time.time() - t0) * 1000)
        res.setdefault("ai_check", False)
        decision_id = _record_decision(check_req, res, context=context,
                                        latency_ms=latency_ms, op=op)
        return {
            "approved":        res["approved"],
            "reason":          res.get("reason", ""),
            "adjusted_volume": None,
            "decision_id":     decision_id,
            "latency_ms":      latency_ms,
            "mode":            mode,
            "ai_cached":       False,
        }

    # 1) Fast rule check（profile.mode 已经在 _fast_rule_check 里看了 enforce/observe）
    result = _fast_rule_check(check_req, profile,
                              positions=context.get("positions") or [],
                              market=context)

    # 2) AI cache 查询（仅当 fast rule 标了 ai_check 时）
    ai_cached = False
    cache_key = None
    if result.get("ai_check"):
        cache_key = _ai_cache_key(ea_name, check_req, context)
        cached = _get_ai_cache(cache_key)
        if cached is not None:
            ai_cached = True
            # AI 命中 → 用 AI 的决定覆盖（enforce 模式下才会真 block）
            ai_approved = bool(cached.get("approved", True))
            if mode == "enforce" and not ai_approved:
                result["approved"] = False
                result["reason"] = f"AI(cached): {cached.get('reason','')}"
                result["adjusted_volume"] = cached.get("adjusted_volume", 0)
            else:
                # observe / AI approve — 接受 AI 的 reason 但不动 approved
                result["reason"] = f"AI(cached): {cached.get('reason','')}"
                if cached.get("adjusted_volume") is not None and mode == "enforce":
                    result["adjusted_volume"] = cached["adjusted_volume"]
            result["ai_confidence"] = cached.get("confidence")
        else:
            # AI miss → 异步入队，本次走 fast-rule 决定（不阻塞 EA）
            _enqueue_ai_eval(cache_key, ea_name, check_req, context)
            result["reason"] = (result.get("reason", "") +
                                " | AI eval queued (this decision used fast rules only)").strip(" |")

    # 3) observe 模式下任何 would-block 都翻成 approve（但 reason 标出来）
    if mode == "observe" and not result.get("approved", True):
        original_reason = result.get("reason", "")
        result["approved"] = True
        result["reason"] = f"⚠ would-block (监控模式仅记录): {original_reason}"
        result["adjusted_volume"] = None     # observe 模式不调仓

    # 4) Record decision
    latency_ms = int((time.time() - t0) * 1000)
    result.setdefault("ai_check", False)
    decision_id = _record_decision(check_req, result, context=context, latency_ms=latency_ms)

    return {
        "approved":        result["approved"],
        "reason":          result.get("reason", ""),
        "adjusted_volume": result.get("adjusted_volume"),
        "decision_id":     decision_id,
        "latency_ms":      latency_ms,
        "mode":            mode,
        "ai_cached":       ai_cached,
        "ai_confidence":   result.get("ai_confidence"),
    }


# ----------------------------------------------------------------------------
# Monitor mode: Order Tracker (post-hoc audit of MT5 deals)
# ----------------------------------------------------------------------------
# P0a 核心：用 MT5 SDK 每 2 秒 poll positions + history_deals，diff 跟上次比，
# 识别「新开仓 / 平仓 / 改 SL/TP」事件，自动写到 decisions/orders 表。
# 不需要 EA 改源码，零侵入。
# Magic → EA 名映射从 _ea_magic_map 全局变量拿（HTTP /enable 时塞进去）。
# Magic 没注册的 deals 标 ea_name='__unknown__'，UI 可选展示让用户补登记。

# 全局：magic (int) → ea_name (str)。HTTP /enable 时 client 提供 magic 列表。
_ea_magic_map: dict[int, str] = {}
_ea_enabled: set[str] = set()        # 哪些 EA 启用了监控（默认全开发模式中是 None=空 set）
# 0.3.151 step 2: per-EA 护航阈值, /enable 时塞进来, tracker_loop 用它判定触发警报
# schema per ea_name: {
#   "single_loss_usd": -100,
#   "single_loss_pct": -5.0,
#   "max_holding_hours": 24,
#   "max_account_loss_pct": -8.0,
#   "max_locked_positions": 4,
# }
_ea_thresholds: dict[str, dict] = {}
# 去重 cache: alert key (ticket, alert_type) → last fire ts. 30min cool-down 同笔不重发.
_alert_cooldown: dict[tuple, float] = {}
ALERT_COOLDOWN_SEC = 30 * 60
_tracker_state = {
    "running":         False,
    "last_poll_ts":    0,
    "last_deal_check": 0,            # epoch sec — history_deals_get 起点
    "positions_cache": {},           # ticket → last seen pos dict
    "errors":          [],
    "boot_ts":         int(time.time()),  # 0.3.155: 启动时刻 — /health grace period 用
    # 0.3.168: 跟踪 MT5 当前账户 login. tracker 每 poll 都拿 account_info 一并刷.
    # 检测到 login 变化 → 把所有 ea_anchors reset 到 now → 旧户的 decisions/orders
    # 从 UI 视角自动隐藏 (SQL 不删). 用户切户 = 该 license 的 EA 统计从新户重新开始,
    # 跟客户端 stats-collector accountSwitched archive+reset 流程语义对齐.
    "account_login":   None,
}


def _handle_account_switch(old_login, new_login):
    """0.3.168: MT5 登录账号切换 → 对所有 enabled EA reset anchor 到 now.
    旧户的 decisions / orders SQL row 保留, 但所有「在 anchor 之前」的 row 走
    JOIN ea_anchors gate 会被排除 → 「整体战绩」/ 「决策日志」/「已平仓订单」
    section 在 UI 上立刻清空, 从新户首笔 deal 重新累积. 跟用户要求「现有 EA
    的统计就以登录新账户重新开始」一致.
    """
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    reset_eas = []
    # _ea_enabled 是 set 直接遍历, 没 enabled 的 EA 也没 anchor 影响 — 跳过
    for ea in list(_ea_enabled):
        if ea == "__unknown__":
            continue
        try:
            _set_ea_anchor(ea, now_iso)
            reset_eas.append(ea)
        except Exception as e:
            log.warning("account_switch: reset anchor for %s failed: %s", ea, e)
    log.warning(
        "MT5 account switched: %s → %s. Reset anchors for %d enabled EA(s): %s",
        old_login, new_login, len(reset_eas), reset_eas,
    )
    # 同时把 alert cooldown 也清掉 — 旧户的 ticket cool-down 不再适用
    _alert_cooldown.clear()
    # last_deal_check 推到 now, 不再去刷新户切户之前的 deals
    _tracker_state["last_deal_check"] = int(time.time())


def _infer_intent_from_deal(deal: dict, positions: list[dict]) -> tuple[str, str]:
    """监控模式下没 EA 主动声明 intent / risk_level 时的启发式推断。
    返回 (intent, risk_level)。

    规则：
      - 首笔（账户该 symbol+magic 没其他仓位）   → ('initial',         'low')
      - 跟现有仓位同方向加仓                       → ('add_position',   'medium')
      - 跟现有仓位反方向                           → ('hedge',          'medium')
      - 同 symbol 大量仓位（≥5）+ 同方向            → ('martin',         'high')
      - 短期内反复开关同 symbol                    → ('scalp',          'low')
      - 其他                                       → ('unknown',        'medium')
    用户视角：分类不准没关系，先有数据流；后面手工 / AI 改 intent。
    """
    sym = (deal.get("symbol") or "").lower()
    side = deal.get("type")           # 0 = BUY, 1 = SELL
    magic = deal.get("magic") or 0

    # 同 EA 同 symbol 的现存持仓
    same = [p for p in positions if (p.get("magic") or 0) == magic
            and (p.get("symbol") or "").lower() == sym
            and p.get("ticket") != deal.get("position_id")]
    if not same:
        return ("initial", "low")

    same_side = [p for p in same if p.get("type") == side]
    opp_side  = [p for p in same if p.get("type") != side]

    # 同方向 ≥5 张 = 马丁式
    if len(same_side) >= 5:
        return ("martin", "high")
    if same_side and opp_side:
        return ("hedge", "medium")
    if same_side:
        return ("add_position", "medium")
    if opp_side:
        return ("hedge", "medium")
    return ("unknown", "medium")


# 0.3.75: 采集 spread / ATR / 跨 EA 总持仓，喂给 fast_rules + 学习中心
def _snapshot_market_context(symbol: str | None, positions: list[dict]) -> dict:
    """从 MT5 SDK 拉一份决策时刻的市场快照。MT5 不可用时返空 dict。
    返回字段：
      - spread_pips: 当前点差（已换算成 pips，1 pip = 10 points 常规外汇 / 1 point 金属）
      - atr_pct: ATR(14) H1 占当前价格的百分比，反映波动率
      - account_total_positions: 全账户持仓数（跨所有 EA）
      - account_buy_positions / account_sell_positions: 多空分布
      - account_buy_pct: buy 占比 (0..1)，>0.8 = 单边裸奔
    """
    ctx: dict[str, float | int] = {}

    # 跨 EA 持仓（已经从 caller 拿到 positions 快照，零成本）
    total = len(positions)
    buy   = sum(1 for p in positions if p.get("type") == 0)
    sell  = sum(1 for p in positions if p.get("type") == 1)
    ctx["account_total_positions"] = total
    ctx["account_buy_positions"]   = buy
    ctx["account_sell_positions"]  = sell
    if total > 0:
        ctx["account_buy_pct"] = round(buy / total, 2)

    if not _MT5_AVAILABLE or not symbol:
        return ctx

    # spread
    try:
        tick = mt5.symbol_info_tick(symbol)
        sinfo = mt5.symbol_info(symbol)
        if tick and sinfo:
            point = float(sinfo.point or 0)
            if point > 0:
                # 通常 forex 1 pip = 10 points (5-digit broker)，金属 / 指数 1 pip = 1 point。
                # 这里统一用 points / 10 来近似 pips；用户读 reason 时会理解为「点差」即可。
                spread_points = (tick.ask - tick.bid) / point
                ctx["spread_pips"] = round(spread_points / 10, 1)
                ctx["spread_points"] = round(spread_points, 0)
    except Exception:
        pass

    # ATR(14) H1
    try:
        rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_H1, 0, 16)
        if rates is not None and len(rates) >= 15:
            trs = []
            for i in range(1, len(rates)):
                prev_close = rates[i-1]["close"]
                h, l = rates[i]["high"], rates[i]["low"]
                tr = max(h - l, abs(h - prev_close), abs(l - prev_close))
                trs.append(tr)
            atr = sum(trs[-14:]) / 14
            price = rates[-1]["close"]
            if price > 0:
                ctx["atr_pct"] = round(atr / price * 100, 3)
    except Exception:
        pass

    return ctx


def _record_post_hoc_decision(deal: dict, positions: list[dict],
                              account: dict | None = None) -> str:
    """监控模式：从 MT5 deal 反推一个 decision 记录。
    用 deal 自身的 ticket / time / price 填 orders.open_price/time，
    跟下面 _track_position_close 配对完成生命周期。"""
    magic = int(deal.get("magic") or 0)
    # 0.3.141: 改用 _resolve_ea_name —— monitor json fallback 让用户填过 magic 但
    # 没显式启用 OrderGuard 的 EA 也能被正确归属（而不是全 __unknown__）
    ea_name = _resolve_ea_name(magic)

    # 0.3.141: anchor gate — deal.time 早于该 EA 启用护航时刻 → 不入库
    # 用户反馈：「只有开启护航后的订单才加入，顶部的统计也是基于加入后的订单的」
    # __unknown__ 不过滤 (没注册 magic 时 anchor 还不存在，让它先进库；启用该 EA
    # 时 backfill __unknown__ 那段已有过滤路径)
    if ea_name != "__unknown__":
        anchor = _get_ea_anchor(ea_name)
        if anchor:
            try:
                deal_ts_iso = datetime.fromtimestamp(
                    int(deal.get("time") or 0), timezone.utc
                ).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
                if deal_ts_iso < anchor:
                    return ""    # 早于 anchor，跳过
            except Exception:
                pass

    intent, risk_level = _infer_intent_from_deal(deal, positions)
    side_name = "buy" if deal.get("type") == 0 else "sell"
    volume = float(deal.get("volume") or 0)
    decision_id = f"dg_mon_{int(time.time())}_{deal.get('ticket', 0)}"

    # 0.3.170: 入口去重 — 同一 deal.ticket 已记过 decision 就跳过.
    # 双保险: tracker_loop last_deal_check 已改单调递增不回退, 但如果 OG 重启
    # / migrate / boot grace period 等边界 case 让同 deal 再被扫到, 这里兜底.
    # 注意: 用 context_json $.deal_ticket 索引最准 (orders.ticket 存的是
    # position_id, 不是 deal.ticket — 多 deal 共享同 position 时不能区分).
    deal_ticket = int(deal.get("ticket") or 0)
    if deal_ticket > 0:
        try:
            existing = _db().execute(
                "SELECT decision_id FROM decisions WHERE json_extract(context_json, '$.deal_ticket') = ? LIMIT 1",
                (deal_ticket,)
            ).fetchone()
            if existing:
                return existing["decision_id"]
        except Exception:
            pass    # JSON extract 失败 / DB busy 等异常静默继续, 不阻塞主流程

    # 跑一次 fast rules（不 enforce — 只为了得到 reason 给 UI 看）
    # 0.3.73: __unknown__ 用默认 rules 但**不写库** — 之前 _load_rules 会落地默认
    # rules + _meta 行，导致 __unknown__ 出现在 enabled-eas 列表 + rules 表污染。
    if ea_name == "__unknown__":
        profile = _default_rules_for_ea(ea_name)
    else:
        profile = _load_rules(ea_name)
    check_req = {
        "ea_name": ea_name,
        "risk_level": risk_level,
        "intent": intent,
        "symbol": deal.get("symbol"),
        "side": side_name,
        "volume": volume,
    }
    market_ctx = {}
    if account:
        bal = account.get("balance", 0)
        equity = account.get("equity", 0)
        if bal > 0:
            market_ctx["drawdown_pct"] = round((bal - equity) / bal * 100, 2)
    result = _fast_rule_check(check_req, profile, positions=positions, market=market_ctx)
    # 监控模式下，所有单都 approved=True；但若 would_block，reason 标出来给 UI 看
    if not result.get("approved", True):
        post_hoc_reason = f"⚠ would-block (监控模式仅记录): {result.get('reason', '')}"
    else:
        post_hoc_reason = result.get("reason", "monitor: passed fast rules")

    # 0.3.170: 入库时打 per-row guarded + account_login 标记.
    #   guarded = 1 iff 该 EA 当前在 _ea_enabled (= 用户启用了护航);
    #   account_login = 当前 MT5 账户 login (启动早期 None 时存 NULL).
    # 这两个字段化让 UI 查询 WHERE guarded=1 AND account_login=<current> 直接过滤,
    # 不再依赖 ea_anchors JOIN gate (老路径保留作为「重置统计」按钮的兜底).
    is_guarded = 1 if (ea_name in _ea_enabled and ea_name != "__unknown__") else 0
    cur_login = _tracker_state.get("account_login")
    account_login_val = int(cur_login) if cur_login else None

    # 直接写 SQL，跳过 _record_decision（因为我们自己 generate decision_id）
    conn = _db()
    try:
        conn.execute(
            """INSERT OR IGNORE INTO decisions
               (decision_id, ea_name, risk_level, intent, symbol, side,
                requested_volume, approved_volume, approved, reason,
                ai_checked, ai_confidence, context_json, latency_ms,
                guarded, account_login)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (decision_id, ea_name, risk_level, intent,
             deal.get("symbol") or "", side_name, volume,
             volume,            # post-hoc: approved_volume = requested
             1,                  # post_hoc 默认 approved=1
             post_hoc_reason,
             0, None,
             json.dumps({
                 "post_hoc": True,
                 "magic": magic,
                 "deal_ticket": deal.get("ticket"),
                 "position_id": deal.get("position_id"),
                 # 0.3.75: 给学习中心 algorithms 用 — 当时账户的持仓数 + 下单小时（UTC）
                 "position_count": len(positions),
                 "hour": datetime.fromtimestamp(deal.get("time") or 0, timezone.utc).hour,
                 **market_ctx,
             }),
             0,
             is_guarded, account_login_val)
        )
        # 同时建 orders 行 — 1.0.7: 顺带采集开仓时的 SL/TP (从当前持仓快照按 position_id 找,
        # sl/tp=0.0 表示没设 → 存 None). 供「SL 外扩」「平仓偏早」学习用.
        _pos_id = deal.get("position_id") or deal.get("ticket")
        _sl_open = _tp_open = None
        for _p in positions:
            if _p.get("ticket") == _pos_id:
                _sl_open = _p.get("sl") or None
                _tp_open = _p.get("tp") or None
                break
        conn.execute(
            """INSERT OR IGNORE INTO orders
               (decision_id, ticket, open_price, open_time, sl_open, tp_open)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (decision_id,
             _pos_id,
             deal.get("price"),
             datetime.fromtimestamp(deal.get("time") or 0, timezone.utc)
                 .strftime("%Y-%m-%dT%H:%M:%SZ"),
             _sl_open, _tp_open)
        )
    finally:
        conn.close()
    return decision_id


# ============================================================
# 0.3.151 step 2: 护航阈值警报
# ============================================================
def _alert_can_fire(alert_key: tuple, now_ts: float) -> bool:
    """30 min 内同 ticket + 同类型不重发 — 避免每 5s tracker poll 一次重复推."""
    last = _alert_cooldown.get(alert_key, 0)
    if now_ts - last < ALERT_COOLDOWN_SEC:
        return False
    _alert_cooldown[alert_key] = now_ts
    return True


def _write_alert_decision(ea_name: str, alert_type: str, position: dict,
                          context: dict, reason: str) -> None:
    """把警报写到 decisions 表 (risk_level='warning'), UI 「决策日志」能看, 也可推微信."""
    try:
        decision_id = str(uuid.uuid4())
        ts_iso = datetime.now(timezone.utc).isoformat()
        conn = _db()
        try:
            conn.execute(
                """INSERT INTO decisions
                   (decision_id, ts, ea_name, risk_level, intent,
                    symbol, side, requested_volume, approved_volume,
                    approved, reason, ai_checked, ai_confidence,
                    context_json, latency_ms)
                   VALUES (?, ?, ?, 'warning', ?, ?, ?, ?, NULL,
                           1, ?, 0, NULL, ?, 0)""",
                (
                    decision_id, ts_iso, ea_name, alert_type,
                    position.get("symbol"),
                    "buy" if position.get("type") == 0 else "sell",
                    float(position.get("volume") or 0),
                    reason,
                    json.dumps({
                        "ticket": position.get("ticket"),
                        "magic": position.get("magic"),
                        "alert_type": alert_type,
                        **context,
                    }),
                ),
            )
        finally:
            conn.close()
        log.warning("[alert] %s/%s ticket=%s — %s",
                    ea_name, alert_type, position.get("ticket"), reason)
    except Exception as e:
        log.exception("Failed to write alert decision: %s", e)


def _check_threshold_alerts(positions: list[dict], account: dict,
                            now_sec: int) -> None:
    """每轮 tracker poll 后调一次. 对每条 position check 阈值, 触发 → 写 decision."""
    bal = float(account.get("balance") or 0)
    if bal <= 0:
        return  # 没账户数据, 无法算 %, 跳过

    # 账户级: 整体浮亏 / 锁仓数 (per EA)
    by_ea: dict[str, list[dict]] = {}
    for p in positions:
        ea = _resolve_ea_name(int(p.get("magic") or 0))
        by_ea.setdefault(ea, []).append(p)

    for ea_name, ea_positions in by_ea.items():
        if ea_name == "__unknown__":
            continue
        if ea_name not in _ea_enabled:
            continue
        thr = _ea_thresholds.get(ea_name)
        if not thr:
            continue

        single_loss_usd_thr   = float(thr.get("single_loss_usd",      -100))
        single_loss_pct_thr   = float(thr.get("single_loss_pct",      -5.0))
        max_holding_hours_thr = float(thr.get("max_holding_hours",    24))
        max_acc_loss_pct_thr  = float(thr.get("max_account_loss_pct", -8.0))
        max_locked_thr        = int(thr.get("max_locked_positions",   4))

        # --- per-position 阈值 ---
        for p in ea_positions:
            ticket = int(p.get("ticket") or 0)
            if not ticket:
                continue
            floating_usd = float(p.get("profit") or 0) + float(p.get("swap") or 0)
            floating_pct = (floating_usd / bal * 100) if bal > 0 else 0
            open_ts = int(p.get("time") or 0)
            hold_hours = (now_sec - open_ts) / 3600.0 if open_ts > 0 else 0

            # 单笔浮亏 USD
            if floating_usd < single_loss_usd_thr:
                key = (ticket, "single_loss_usd")
                if _alert_can_fire(key, now_sec):
                    _write_alert_decision(
                        ea_name, "floating_loss_usd_alert", p,
                        {"floating_usd": floating_usd,
                         "threshold_usd": single_loss_usd_thr},
                        f"单笔浮亏 ${floating_usd:.2f} 超阈值 ${single_loss_usd_thr:.2f}",
                    )

            # 单笔浮亏 %
            if floating_pct < single_loss_pct_thr:
                key = (ticket, "single_loss_pct")
                if _alert_can_fire(key, now_sec):
                    _write_alert_decision(
                        ea_name, "floating_loss_pct_alert", p,
                        {"floating_pct": floating_pct,
                         "threshold_pct": single_loss_pct_thr,
                         "balance": bal},
                        f"单笔浮亏 {floating_pct:.2f}% 超阈值 {single_loss_pct_thr:.2f}%",
                    )

            # 持仓时长
            if hold_hours > max_holding_hours_thr:
                key = (ticket, "holding_hours")
                if _alert_can_fire(key, now_sec):
                    _write_alert_decision(
                        ea_name, "holding_too_long_alert", p,
                        {"hold_hours": hold_hours,
                         "threshold_hours": max_holding_hours_thr,
                         "open_ts": open_ts},
                        f"持仓 {hold_hours:.1f}h 超阈值 {max_holding_hours_thr:.1f}h",
                    )

        # --- 账户级 (per-EA) ---
        total_floating = sum(
            float(p.get("profit") or 0) + float(p.get("swap") or 0)
            for p in ea_positions
        )
        total_floating_pct = (total_floating / bal * 100) if bal > 0 else 0
        if total_floating_pct < max_acc_loss_pct_thr:
            key = (f"ea_{ea_name}", "account_loss")
            if _alert_can_fire(key, now_sec):
                # 拿第一条 position 作 context 占位
                p0 = ea_positions[0] if ea_positions else {}
                _write_alert_decision(
                    ea_name, "account_loss_alert", p0,
                    {"total_floating_usd": total_floating,
                     "total_floating_pct": total_floating_pct,
                     "threshold_pct": max_acc_loss_pct_thr,
                     "balance": bal,
                     "positions_count": len(ea_positions)},
                    f"EA {ea_name} 整体浮亏 {total_floating_pct:.2f}% (${total_floating:.2f}) 超阈值 {max_acc_loss_pct_thr:.2f}%",
                )

        # --- 锁仓 ---
        long_count  = sum(1 for p in ea_positions if int(p.get("type") or 0) == 0)
        short_count = sum(1 for p in ea_positions if int(p.get("type") or 0) == 1)
        locked_pairs = min(long_count, short_count)
        if locked_pairs > max_locked_thr:
            key = (f"ea_{ea_name}", "locked")
            if _alert_can_fire(key, now_sec):
                p0 = ea_positions[0] if ea_positions else {}
                _write_alert_decision(
                    ea_name, "locked_alert", p0,
                    {"long_count": long_count,
                     "short_count": short_count,
                     "locked_pairs": locked_pairs,
                     "threshold": max_locked_thr},
                    f"EA {ea_name} 锁仓 {locked_pairs} 对 (多 {long_count} 空 {short_count}) 超阈值 {max_locked_thr}",
                )


def _track_position_close(close_deal: dict, positions: list[dict]) -> None:
    """监控模式：成交里发现 entry=1 (close) → 找之前对应的 open decision，回填 close_price/time/pnl。
    用 position_id 串联开-平仓。
    1.0.7: 同时把平仓记成一等 op='close' 决策 (供「平仓偏早」学习 + 平仓拦截统计), 并采集
    sl_close/tp_close —— 平仓瞬间持仓已不在当前快照里, 但 positions_cache 本轮还没被覆盖
    (覆盖在 deal loop 之后), 仍存着平仓前最后一眼的 SL/TP。"""
    pos_id = close_deal.get("position_id") or close_deal.get("ticket")
    if not pos_id:
        return
    last_pos = (_tracker_state.get("positions_cache") or {}).get(pos_id) or {}
    sl_close = last_pos.get("sl") or None
    tp_close = last_pos.get("tp") or None
    ea_name = None
    sl_open = tp_open = None
    conn = _db()
    try:
        row = conn.execute(
            """SELECT o.decision_id, o.open_time, o.sl_open, o.tp_open, d.ea_name
               FROM orders o JOIN decisions d ON d.decision_id = o.decision_id
               WHERE o.ticket = ? AND o.close_time IS NULL LIMIT 1""",
            (pos_id,)
        ).fetchone()
        if not row:
            return       # 没记开仓 record（probably daemon 启动前就开的单）
        decision_id = row["decision_id"]
        open_t_str = row["open_time"]
        ea_name = row["ea_name"]
        sl_open, tp_open = row["sl_open"], row["tp_open"]
        # 算持仓秒数
        try:
            open_ts = datetime.strptime(open_t_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        except Exception:
            open_ts = 0
        close_ts = close_deal.get("time") or time.time()
        holding_sec = int(close_ts - open_ts) if open_ts else None
        pnl = (close_deal.get("profit") or 0) + (close_deal.get("swap") or 0) + (close_deal.get("commission") or 0)
        conn.execute(
            """UPDATE orders
               SET close_price = ?, close_time = ?, pnl = ?, holding_sec = ?,
                   sl_close = COALESCE(?, sl_close), tp_close = COALESCE(?, tp_close)
               WHERE decision_id = ?""",
            (close_deal.get("price"),
             datetime.fromtimestamp(close_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             round(pnl, 2),
             holding_sec,
             sl_close, tp_close,
             decision_id)
        )
    finally:
        conn.close()
    # 1.0.7: 平仓记成一等决策 (orders 回填之后; _record_close_decision 自己开 conn)
    try:
        _record_close_decision(close_deal, ea_name, round(pnl, 2), holding_sec,
                               sl_open, tp_open, sl_close, tp_close)
    except Exception as e:
        log.debug("record close decision failed (ignored): %s", e)


def _record_close_decision(close_deal: dict, ea_name, pnl: float, holding_sec,
                           sl_open, tp_open, sl_close, tp_close) -> None:
    """1.0.7: 把一次平仓记成 op='close' 决策, 供平仓学习/拦截统计。dedup by deal_ticket。
    intent: entry=3 (out_by_stop) → close_sl; 否则 close (deal 层面无法可靠区分手平/TP)。"""
    if not ea_name or ea_name == "__unknown__":
        return
    deal_ticket = int(close_deal.get("ticket") or 0)
    if deal_ticket > 0:
        try:
            existing = _db().execute(
                "SELECT 1 FROM decisions WHERE op='close' "
                "AND json_extract(context_json,'$.deal_ticket')=? LIMIT 1",
                (deal_ticket,)
            ).fetchone()
            if existing:
                return
        except Exception:
            pass
    intent = "close_sl" if int(close_deal.get("entry") or 0) == 3 else "close"
    dist_to_tp_pct = None
    try:
        cp = float(close_deal.get("price") or 0)
        if tp_open and cp > 0:
            dist_to_tp_pct = round(abs(float(tp_open) - cp) / cp * 100, 3)
    except Exception:
        pass
    side_name = "buy" if int(close_deal.get("type") or 0) == 0 else "sell"
    check_req = {
        "ea_name": ea_name, "risk_level": "low", "intent": intent,
        "symbol": close_deal.get("symbol") or "", "side": side_name,
        "volume": float(close_deal.get("volume") or 0),
    }
    ctx = {
        "post_hoc": True, "op": "close", "deal_ticket": deal_ticket,
        "position_id": close_deal.get("position_id"),
        "pnl": pnl, "holding_sec": holding_sec,
        "sl_open": sl_open, "tp_open": tp_open,
        "sl_close": sl_close, "tp_close": tp_close,
        "dist_to_tp_pct": dist_to_tp_pct,
        "hour": datetime.fromtimestamp(close_deal.get("time") or 0, timezone.utc).hour,
    }
    _record_decision(check_req, {"approved": True, "reason": f"平仓 pnl={pnl:.2f}"},
                     context=ctx, op="close")


# 1.0.7: 改单检测 epsilon — SL/TP 变动绝对值小于这个视为噪声不记
_MODIFY_EPS = 1e-9


def _detect_modify_events(prev_cache: dict, cur_positions: list[dict]) -> None:
    """1.0.7: 监控模式改单检测 —— history deals 不含 SL/TP 编辑, 只能 diff 持仓快照.
    比上一轮 cache 与本轮 positions 同 ticket 的 sl/tp; 变了 → 记 modify_events +
    op='modify' 决策。判「SL 是否往亏损方向外扩」(爆仓经典动作):
      离 ref_price 更远 = 外扩 (BUY 的 SL 下移 / SELL 的 SL 上移, 统一用「距离变大」判);
      删掉 SL (set→0) = 最危险的外扩; 加 SL (0→set, 减险) 不算外扩。
    去抖: cache 本身就是 last-seen, sl/tp 没变下轮不会重复记; 首次出现(不在 prev)≠改单
    (开仓自带 SL); 只 diff sl/tp (volume 变=部分平, 不在此处理)。"""
    if not prev_cache or not cur_positions:
        return
    acct = _tracker_state.get("account_login")
    acct = int(acct) if acct else None
    for p in cur_positions:
        tk = p.get("ticket")
        prev = prev_cache.get(tk)
        if not prev:
            continue                       # 首次出现, 不是改单
        old_sl = float(prev.get("sl") or 0); new_sl = float(p.get("sl") or 0)
        old_tp = float(prev.get("tp") or 0); new_tp = float(p.get("tp") or 0)
        sl_changed = abs(new_sl - old_sl) > _MODIFY_EPS
        tp_changed = abs(new_tp - old_tp) > _MODIFY_EPS
        if not sl_changed and not tp_changed:
            continue
        ea_name = _resolve_ea_name(int(p.get("magic") or 0))
        symbol = p.get("symbol") or ""
        side = "buy" if int(p.get("type") or 0) == 0 else "sell"
        ref_price = 0.0; point = 0.0
        if _MT5_AVAILABLE and symbol:
            try:
                tick = mt5.symbol_info_tick(symbol)
                sinfo = mt5.symbol_info(symbol)
                if tick:
                    ref_price = float((tick.bid if side == "buy" else tick.ask) or 0)
                if sinfo:
                    point = float(sinfo.point or 0)
            except Exception:
                pass
        if not ref_price:
            ref_price = float(p.get("price_open") or 0)
        # 外扩判定 (只在有旧 SL 时谈; 0→设 SL 是减险不算外扩)
        sl_widened = 0
        sl_delta_points = None
        if sl_changed and old_sl:
            if not new_sl:
                sl_widened = 1             # 删掉 SL = 最危险的外扩
            elif ref_price:
                old_dist = abs(ref_price - old_sl)
                new_dist = abs(ref_price - new_sl)
                if point > 0:
                    sl_delta_points = round((new_dist - old_dist) / point, 1)
                if new_dist > old_dist + (point or 0):
                    sl_widened = 1
        guarded = 1 if (ea_name in _ea_enabled and ea_name != "__unknown__") else 0
        try:
            conn = _db()
            try:
                conn.execute(
                    """INSERT INTO modify_events
                       (ea_name, account_login, ticket, symbol, side,
                        old_sl, new_sl, old_tp, new_tp, ref_price,
                        sl_widened, sl_delta_points, guarded, source)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'monitor')""",
                    (ea_name, acct, tk, symbol, side,
                     old_sl or None, new_sl or None, old_tp or None, new_tp or None,
                     ref_price or None, sl_widened, sl_delta_points, guarded)
                )
            finally:
                conn.close()
        except Exception as e:
            log.debug("insert modify_event failed (ignored): %s", e)
        if ea_name and ea_name != "__unknown__":
            intent = "modify_sltp" if (sl_changed and tp_changed) else ("modify_sl" if sl_changed else "modify_tp")
            reason = ("⚠ SL 往亏损方向外扩" if sl_widened else ("改 SL" if sl_changed else "改 TP"))
            check_req = {
                "ea_name": ea_name, "risk_level": "high" if sl_widened else "low",
                "intent": intent, "symbol": symbol, "side": side,
                "volume": float(p.get("volume") or 0),
            }
            ctx = {
                "post_hoc": True, "op": "modify", "ticket": tk,
                "old_sl": old_sl or None, "new_sl": new_sl or None,
                "old_tp": old_tp or None, "new_tp": new_tp or None,
                "sl_widened": sl_widened, "sl_delta_points": sl_delta_points,
                "ref_price": ref_price or None,
                "hour": datetime.now(timezone.utc).hour,
            }
            try:
                _record_decision(check_req, {"approved": True, "reason": reason},
                                 context=ctx, op="modify")
            except Exception as e:
                log.debug("record modify decision failed (ignored): %s", e)


# 0.3.79: tracker poll 间隔从 2s 放宽到默认 5s（DB 已是 source of truth，
# UI 也是 5s 刷新，再快没必要 + 省 MT5 IPC 成本）。env `EASYDEAL_OG_TRACKER_POLL_SEC`
# 可调，老用户想要 2s 实时感继续设 2 即可。
TRACKER_POLL_SEC = max(0.5, float(os.getenv("EASYDEAL_OG_TRACKER_POLL_SEC", "5")))


async def _order_tracker_loop():
    """P0a 监控模式主循环。默认每 5s poll MT5，记录新 deal 事件。
    0.3.89: mt5.initialize() 失败不再静默退出 — 改成每 30s 重试，直到成功才进 poll 循环。
    根因：之前 EasyDeal 启动时若 MT5 还没启动 / MT5 还没登录 → initialize 失败 → tracker
    永远死掉，positions_cache 永远空。用户加护航后看不到在跑订单，必须重启 EasyDeal。
    """
    if not _MT5_AVAILABLE:
        log.warning("MetaTrader5 SDK 不可用 — Order Tracker 不启动（监控模式失效）")
        return

    log.info("Order Tracker 启动 — 监控所有 MT5 EA 订单事件 (poll=%.1fs)",
             TRACKER_POLL_SEC)
    _tracker_state["running"] = True
    # 启动时 lookback 30s 以防错过刚发生的 deal
    _tracker_state["last_deal_check"] = int(time.time()) - 30

    # MT5 attach — 由 EasyDeal main 进程通过 env 提供 install_dir
    install_dir = os.getenv("EASYDEAL_MT5_INSTALL_DIR") or ""
    data_dir = os.getenv("EASYDEAL_MT5_DATA_DIR") or ""
    # 1.5.1 多实例修复: 多个账户实例共享同一 install_dir 时(实盘4账户), 光按 install_dir
    # 判"terminal 在跑"会让每个 OG 都以为自己该 init → 连带把别的实例 mt5.initialize 拉起。
    # 只在 data_dir 显式配了且 ≠ install_dir(= 非便携多实例场景)时启用 data_dir 精确门控;
    # 便携/单实例(data_dir 缺省或 == install_dir)保持旧行为不变, 零回归。
    _multi_gate = bool(data_dir) and _norm_path(data_dir) != _norm_path(install_dir)
    kwargs = {}
    if install_dir:
        exe = os.path.join(install_dir, "terminal64.exe")
        if os.path.isfile(exe):
            kwargs["path"] = exe

    # 0.3.89: 重试 attach — MT5 可能还没启动或还没登录，等它就绪
    # 0.3.199: attach 前先用 psutil 看 install_dir 下的 terminal64.exe 在不在跑.
    # 不在跑就跳过 mt5.initialize — 否则 SDK 会自动把 MT5 拉起来 (用户「关闭 MT5」
    # 按钮关掉后又被 OG 拉回来的根因).
    # 0.3.205: 加 kill-flag 双重保险 — 即使 mt5.initialize 因为 SDK 内部 race 检测
    # 不到 dying process 还是去 launch 新的, kill-flag 存在时根本不调 initialize.
    attach_attempt = 0
    # 0.3.212: 曾简化为「进程存在 → init」, 去掉 60s age 检查。
    # 1.4.8 重新加回 age>=60 守卫(改用 _terminal_running_age_sec): 0.3.212 的假设
    # 「进程存在就能 init」在"一实例挂 ≥2 EA"的慢启动 MT5 上不成立 —— 进程已在但
    # SDK IPC 还没就绪, mt5.initialize 判"未运行"又拉起一个不带 /portable 的 C 盘
    # 幽灵 MT5(用户实测: 重挂后冒出第二个 MT5、关了又开)。launch-flag 只罩 attach
    # 那段, flag 清除后到 MT5 boot 完这段空档正是竞态窗口, 需 age 守卫补上。
    while True:
        attach_attempt += 1
        try:
            if install_dir and _killed_flag_present(install_dir):
                if attach_attempt == 1 or attach_attempt % 10 == 0:
                    log.info("MT5 (install=%s) kill-flag 在 — 用户主动关了, 不自动拉起", install_dir)
            elif install_dir and _launching_recent(install_dir):
                # launch-flag (120s grace, 0.3.228): Node IPC
                # 写了 flag, 正在 boot/attach 全程不要碰 mt5.initialize. 正常 Python
                # 显式 clear flag 不依赖时间过期, 120s 是子进程崩溃兜底.
                if attach_attempt == 1 or attach_attempt % 10 == 0:
                    log.info("MT5 (install=%s) launch-flag 在 — Node/Python 正在 spawn/attach, 等 flag 清除", install_dir)
            elif install_dir and _terminal_running_age_sec(install_dir) < 60:
                # 1.4.8: 进程不存在(age<0) 或 刚启动不足 60s(SDK IPC 未就绪) 都跳过 init.
                # 老逻辑只判 _terminal_is_running(进程存在即放行), 但"一实例挂两 EA"的 MT5
                # boot 明显更久, 进程已在、IPC 还没起 → SDK 判"未运行"又拉起一个不带 /portable
                # 的 C 盘 MT5(问题1根因)。改用 age>=60 确保 SDK 真就绪再 init。
                if attach_attempt == 1 or attach_attempt % 10 == 0:
                    log.info("MT5 (install=%s) 进程不存在或 boot 未满 60s — 暂不 init(防 SDK 拉起幽灵), 等就绪", install_dir)
            elif _multi_gate and not _data_dir_terminal_fresh(data_dir):
                # 1.5.1: 非便携多实例 —— install_dir 下确实有 terminal 在跑(上面 age 门过了),
                # 但**不是我这个 data_dir 的**(该 data_dir 的 logs 没在新鲜写)。此时绝不 init,
                # 否则 SDK 会为我这个(portable/dataDir 组合不同的)实例又拉起一个新 terminal
                # → "点一个实例启动、其余仨被连带拉起并落错数据目录"的根因。只等我自己那个
                # terminal 被用户/Node 真正启动(logs 开始新鲜写)再放行 init。
                if attach_attempt == 1 or attach_attempt % 10 == 0:
                    log.info("MT5 (data=%s) 本实例 terminal 未在跑(共享 install_dir 的是别的实例) — 不自动 init 防连带拉起, 等本实例被启动", data_dir)
            elif _mt5_init_safe(kwargs):
                log.info("MT5 attach 成功 (attempt=%d)", attach_attempt)
                break
            else:
                err = mt5.last_error()
                if attach_attempt == 1 or attach_attempt % 10 == 0:
                    # 第一次 + 每 10 次 (5 min) 才打 log，避免刷屏
                    log.warning("mt5.initialize 失败 (attempt=%d): %s — 30s 后重试",
                                attach_attempt, err)
        except Exception as e:
            if attach_attempt == 1 or attach_attempt % 10 == 0:
                log.exception("MT5 attach 异常 (attempt=%d): %s", attach_attempt, e)
        try:
            await asyncio.sleep(30.0)
        except asyncio.CancelledError:
            log.info("Order Tracker 在 attach 阶段被取消")
            _tracker_state["running"] = False
            return

    error_streak = 0
    while True:
        try:
            await asyncio.sleep(TRACKER_POLL_SEC)
            now = int(time.time())
            _tracker_state["last_poll_ts"] = now

            # 0.3.128: 检测 MT5 连接死/重启 — terminal_info() 是最权威的健康检查
            # 重挂 EA 时 EasyDeal 会 kill MT5 + restart 新进程，旧 SDK handle 还
            # 指向已死的旧进程。positions_get/history_deals_get 此时静默返
            # None/empty 不抛异常 → positions_cache 被清空 → 「在跑订单」永远 0，
            # 必须重启 EasyDeal 才恢复。每轮 poll 前先 ping，挂了立刻 re-init。
            try:
                _ti = mt5.terminal_info()
                _connected = bool(_ti and getattr(_ti, "connected", False))
            except Exception:
                _connected = False
            if not _connected:
                # 0.3.212: 简化守护 — kill-flag / launch-flag / 进程存在 三个 gate
                # 全过了才 init. 不再用 60s age 硬编码 — 信任进程检测足够: SDK 只
                # 在 mt5.initialize 时才有机会 launch, 不调它就不会启动新 MT5.
                if install_dir and _killed_flag_present(install_dir):
                    if int(now) % 60 < TRACKER_POLL_SEC:
                        log.info("MT5 (install=%s) kill-flag 在 — 用户主动关了, 跳过 re-init", install_dir)
                    await asyncio.sleep(25.0)
                    continue
                if install_dir and _launching_recent(install_dir):
                    # 0.3.228: launch-flag 在 (120s grace) — Node IPC / Python attach
                    # 正在 spawn/attach 全程, 跳过 re-init. 正常 flow Python finally
                    # 显式 clear flag (远早于 120s), 这里是子进程崩溃的兜底.
                    if int(now) % 30 < TRACKER_POLL_SEC:
                        log.info("MT5 (install=%s) launch-flag 在 — 等 Node/Python 清除 flag", install_dir)
                    await asyncio.sleep(3.0)
                    continue
                if install_dir and _terminal_running_age_sec(install_dir) < 60:
                    # 1.4.8: 同 attach — 进程不存在或 boot 未满 60s(SDK IPC 未就绪)跳过 re-init.
                    # 重挂空档里 MT5 刚拉起还在 boot(两 EA 更慢), 这里若 re-init 会让 SDK 拉起
                    # 幽灵 C 盘 MT5 → 问题1"关了又开"。age>=60 确保就绪。
                    if int(now) % 60 < TRACKER_POLL_SEC:
                        log.info("MT5 (install=%s) 进程不存在或 boot 未满 60s — 跳过 re-init, 等就绪", install_dir)
                    await asyncio.sleep(25.0)
                    continue
                if _multi_gate and not _data_dir_terminal_fresh(data_dir):
                    # 1.5.1: 同 attach 门控 — 非便携多实例, 本 data_dir 的 terminal 没在跑
                    # (共享 install_dir 的是别的实例), re-init 会连带拉起我这个实例。跳过。
                    if int(now) % 60 < TRACKER_POLL_SEC:
                        log.info("MT5 (data=%s) 本实例 terminal 未在跑 — 跳过 re-init 防连带拉起", data_dir)
                    await asyncio.sleep(25.0)
                    continue
                try:
                    if _mt5_init_safe(kwargs):
                        log.info("MT5 重连成功 (检测到旧 handle 已断 — 通常是重挂 EA 后)")
                    else:
                        _err = mt5.last_error()
                        log.warning(
                            "MT5 connection lost + re-init 失败：%s — 30s 后再试",
                            _err)
                        await asyncio.sleep(25.0)  # 5s + 25s ≈ 30s 总间隔
                        continue
                except Exception as _re:
                    log.warning("MT5 re-init 异常：%s", _re)
                    await asyncio.sleep(25.0)
                    continue

            # 0.3.141: 第三道防线 — tick freshness 检查
            # 0.3.128/0.3.138 的 terminal_info().connected 检查在「SDK IPC 半死」
            # 场景下会返 stale cached True：MT5 GUI 进程还活，positions_get 返
            # 对象，但 p.profit 永远是几小时前的值（broker datafeed 已死或 SDK
            # 跟 MT5 进程间 IPC 死锁）。用户反馈截图：XAUUSDm BUY/SELL PnL 一整
            # 中午不变（24/5 市场不可能真不变）。
            # 拿当前任一持仓 symbol 的 tick.time，> 60s 没刷新就强制 re-init。
            try:
                _pos_cache = _tracker_state.get("positions_cache") or {}
                if _pos_cache:
                    _any_pos = next(iter(_pos_cache.values()), None)
                    _any_sym = (_any_pos or {}).get("symbol")
                    if _any_sym:
                        _tick = mt5.symbol_info_tick(_any_sym)
                        _tick_time = int(getattr(_tick, "time", 0) or 0) if _tick else 0
                        _tick_age = now - _tick_time if _tick_time > 0 else 9999
                        if _tick_age > 60:
                            log.warning(
                                "SDK datafeed stale (tick %s age %ds) — 强制 shutdown + re-init",
                                _any_sym, _tick_age)
                            try:
                                mt5.shutdown()
                            except Exception:
                                pass
                            await asyncio.sleep(5.0)
                            continue
            except Exception as _tf:
                log.debug("tick freshness 检查异常 (忽略): %s", _tf)

            # 拉新 deals — 用 last_deal_check 作为起点
            # 0.3.79: until 留 +poll_sec 的余量（确保新成交不会卡在窗口外）
            since = datetime.fromtimestamp(_tracker_state["last_deal_check"], timezone.utc)
            until = datetime.fromtimestamp(now + max(5, int(TRACKER_POLL_SEC)), timezone.utc)
            try:
                raw_deals = mt5.history_deals_get(since, until) or []
            except Exception as e:
                log.warning("history_deals_get 异常: %s", e)
                error_streak += 1
                # 0.3.137: 不再 5 次失败就 break 退出 loop (作者反馈：「这个数据也
                # 没有定时更新」—— 大概率是 tracker 早期版本撞 5-fail 退出后永远
                # 不恢复)。改成长 sleep + 强制下一轮 re-init MT5 attach 重试。
                # MT5 偶发抖动 / 临时断连 / Defender 扫描时这些临时错误不应该让
                # tracker 永久死掉。
                if error_streak >= 5:
                    log.warning("tracker 连续 %d 次拉 deals 失败，sleep 30s + 强制下轮 re-init", error_streak)
                    error_streak = 0
                    # 触发下一轮 re-init 路径：终止当前 SDK handle，下轮 terminal_info()
                    # 必返 disconnected → 走 mt5.initialize() 重连分支
                    try:
                        mt5.shutdown()
                    except Exception:
                        pass
                    await asyncio.sleep(30.0)
                continue
            error_streak = 0

            # 当前持仓快照
            # 0.3.141: positions_get 异常 / 返 None 不再用空 list 覆盖 cache
            # 之前异常 → positions=[] → cache 被覆盖成空 → UI「在跑订单 0」误报
            # 标记 positions_fetch_ok=False 跳过下面 cache 覆盖那行
            positions = []
            positions_fetch_ok = False
            try:
                raw_pos = mt5.positions_get()
                if raw_pos is not None:
                    positions = [{
                        "ticket": p.ticket, "magic": int(p.magic or 0),
                        "symbol": p.symbol, "type": p.type, "volume": p.volume,
                        "price_open": p.price_open, "profit": p.profit,
                        "swap": p.swap, "sl": p.sl, "tp": p.tp,
                        "time": int(p.time or 0),
                    } for p in raw_pos]
                    positions_fetch_ok = True
                else:
                    log.debug("positions_get 返 None — 保留上一轮 cache")
            except Exception as _pe:
                log.warning("positions_get 异常 (保留上一轮 cache): %s", _pe)

            try:
                ai = mt5.account_info()
                account = {
                    "balance": float(ai.balance) if ai else 0,
                    "equity":  float(ai.equity)  if ai else 0,
                } if ai else None
                # 0.3.168: 检测账户切换 — 第一次拿到 login 时只记不动 (baseline);
                # 之后看到 login 变化 → reset 所有 ea_anchors 到 now
                if ai is not None:
                    new_login = int(getattr(ai, "login", 0) or 0)
                    if new_login > 0:
                        cur_login = _tracker_state.get("account_login")
                        if cur_login is None:
                            _tracker_state["account_login"] = new_login
                        elif cur_login != new_login:
                            _handle_account_switch(cur_login, new_login)
                            _tracker_state["account_login"] = new_login
            except Exception:
                account = None

            # 处理 deals
            for d in raw_deals:
                deal = {
                    "ticket":     d.ticket,
                    "position_id": getattr(d, 'position_id', None) or d.ticket,
                    "magic":      int(d.magic or 0),
                    "symbol":     d.symbol or "",
                    "volume":     float(d.volume or 0),
                    "price":      float(d.price or 0),
                    "profit":     float(d.profit or 0),
                    "swap":       float(d.swap or 0),
                    "commission": float(d.commission or 0),
                    "time":       int(d.time or 0),
                    "type":       int(d.type or 0),
                    "entry":      int(d.entry or 0),    # 0=in, 1=out, 2=inout, 3=out_by
                }
                # entry=0 (open) → 新开仓，记 post-hoc decision
                if deal["entry"] == 0:
                    _record_post_hoc_decision(deal, positions, account)
                # entry=1 (close) → 平仓，回填 orders
                elif deal["entry"] == 1:
                    _track_position_close(deal, positions)
                # entry=2 (inout reversal) / 3 (out by stop) — 当 close 处理
                elif deal["entry"] in (2, 3):
                    _track_position_close(deal, positions)

            # 更新检查点 — 下次从这次最大 deal time + 1s 开始.
            # 0.3.170: **去掉「没新 deals 时窗口回退 now-30」** —— 原意是「保留
            # overlap 以防漏」, 实际反而让同一笔 deal 被反复扫到 + INSERT 多遍
            # (orders 表 PRIMARY KEY 是 decision_id 不是 ticket, 每次都生成新
            # decision_id `dg_mon_{ts}_{ticket}` → 不去重 → 用户实测 1 笔单显 4 次).
            # 现在策略: last_deal_check 严格单调递增, 没新 deals 时不动, 下次窗口
            # [上次 +1, now] 自然往前推, 不会漏也不会重.
            if raw_deals:
                max_deal_time = max(int(d.time) for d in raw_deals)
                _tracker_state["last_deal_check"] = max_deal_time + 1
            # else: 不动, 保持单调递增

            # 0.3.141: 只在 positions_get 成功时覆盖 cache —— None/异常时保留上轮
            if positions_fetch_ok:
                # 1.0.7: 覆盖前先 diff 出改单事件 (SL/TP 变动) — cache 还是上一轮快照
                try:
                    _detect_modify_events(_tracker_state.get("positions_cache") or {}, positions)
                except Exception as _me:
                    log.warning("modify detect failed: %s", _me)
                _tracker_state["positions_cache"] = {p["ticket"]: p for p in positions}

            # 0.3.151 step 2: per-position 阈值检查 — 浮亏过大 / 持仓过久 / 整体浮亏 / 锁仓
            # 触发 → 写 decision 表 (risk_level='warning', intent='*_alert') + 30min cool-down 去重
            if positions_fetch_ok and account and positions:
                try:
                    _check_threshold_alerts(positions, account, now)
                except Exception as _e:
                    log.warning("Threshold alert check failed: %s", _e)

        except asyncio.CancelledError:
            log.info("Order Tracker 收到取消信号")
            break
        except Exception as e:
            log.exception("Order Tracker loop 异常: %s", e)
            error_streak += 1
            # 0.3.141: 不再 break — 用户反馈截图「2139s 未更新」即此 case：
            # 旧逻辑 10 次顶层异常就 break 退出 tracker 永远死。改成跟 0.3.137
            # 的 history_deals_get 5 次失败同款：sleep 30s + mt5.shutdown() 强制
            # 下一轮 re-init MT5 attach 重试，**永远不 break**。tracker 永远活。
            if error_streak >= 10:
                log.warning(
                    "tracker 连续 %d 次循环异常，sleep 30s + 强制下轮 re-init",
                    error_streak)
                error_streak = 0
                try:
                    mt5.shutdown()
                except Exception:
                    pass
                await asyncio.sleep(30.0)

    try:
        mt5.shutdown()
    except Exception:
        pass
    _tracker_state["running"] = False
    log.info("Order Tracker 退出")


# ----------------------------------------------------------------------------
# HTTP API (Flask)
# ----------------------------------------------------------------------------
flask_app = Flask(__name__)


@flask_app.route("/check", methods=["POST"])
def http_check():
    """EA calls this before placing an order. 服务 bind 127.0.0.1，无 auth。"""
    try:
        data = flask_request.get_json(force=True)
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400

    # 1.0.7: 必填字段按 op 区分 —— open 要 5 个 (老 EA 不传 op → 默认 open, 行为不变);
    # modify/close hook 不传 risk_level/volume, 只要 ea_name+symbol+side.
    op = (data.get("op") or "open").lower()
    required = (["ea_name", "symbol", "side"] if op in ("modify", "close")
                else ["ea_name", "risk_level", "symbol", "side", "volume"])
    for k in required:
        if k not in data:
            return jsonify({"ok": False, "error": f"missing field: {k}"}), 400

    # 拆出 context（market/positions snapshot），传给 handle_check 用于 fast rule + AI 桶
    context = data.pop("context", None) or {}
    result = handle_check(data, context=context)
    return jsonify({"ok": True, "data": result})


@flask_app.route("/precheck-async", methods=["POST"])
def http_precheck_async():
    """0.3.66 P1-C：EA 在分析阶段（决定下单前几百毫秒）调一次，给 AI 预热 cache。
    body 跟 /check 一样，但只入队 AI 评估（如果 cache miss），立刻返回。
    EA 之后真下单调 /check 时大概率 AI cache 已命中。"""
    try:
        data = flask_request.get_json(force=True)
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400

    ea_name = data.get("ea_name") or "unknown"
    context = data.pop("context", None) or {}
    cache_key = _ai_cache_key(ea_name, data, context)
    if _get_ai_cache(cache_key) is not None:
        return jsonify({"ok": True, "data": {"cache_key": cache_key, "status": "cached"}})
    queued = _enqueue_ai_eval(cache_key, ea_name, data, context)
    return jsonify({"ok": True, "data": {
        "cache_key": cache_key,
        "status": "queued" if queued else "inflight_or_disabled",
    }})


# ----------------------------------------------------------------------------
# 消息面护航 (news gate) — EA 开马丁单前问一次, 逻辑见 news_gate.py
# ----------------------------------------------------------------------------
def _migrate_news_gate_tables():
    conn = _db()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS news_gate_clients (
                ea_name     TEXT PRIMARY KEY,
                magic       INTEGER,
                symbol      TEXT,
                ea_version  TEXT,
                last_seen   TEXT NOT NULL
            )
        """)
    finally:
        conn.close()


def _news_gate_resolve_ea(raw_name: str, magic: int) -> str | None:
    """EA 上报的程序名 / magic → 护航里启用的 EA 名。没启用护航 → None (只读, 不建 rules 行)。"""
    if raw_name and raw_name in _ea_enabled:
        return raw_name
    if magic:
        ea = _ea_magic_map.get(int(magic))
        if ea and ea in _ea_enabled:
            return ea
    return None


def _news_guard_config(ea_name: str) -> dict:
    """只读取 fast_rules.news_guard —— 不走 _load_rules (它会给陌生 EA 自动建默认规则)。"""
    conn = _db()
    try:
        row = conn.execute(
            "SELECT rule_json FROM rules WHERE ea_name = ? AND intent = '_fast'", (ea_name,)
        ).fetchone()
    finally:
        conn.close()
    try:
        fast = json.loads(row["rule_json"]) if row else {}
    except Exception:
        fast = {}
    return _news_gate.normalize_config((fast or {}).get("news_guard"))


def _news_gate_touch(ea_name: str, magic: int, data: dict) -> None:
    if not ea_name:
        return
    try:
        conn = _db()
        try:
            conn.execute(
                """INSERT OR REPLACE INTO news_gate_clients
                   (ea_name, magic, symbol, ea_version, last_seen) VALUES (?, ?, ?, ?, ?)""",
                (ea_name, int(magic or 0), str(data.get("symbol") or "")[:32],
                 str(data.get("ea_version") or "")[:32],
                 datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")),
            )
        finally:
            conn.close()
    except Exception as e:
        log.warning("[news-gate] touch failed: %s", e)


def _news_gate_clients() -> list[dict]:
    try:
        conn = _db()
        try:
            return [dict(r) for r in conn.execute(
                "SELECT * FROM news_gate_clients ORDER BY last_seen DESC").fetchall()]
        finally:
            conn.close()
    except Exception:
        return []


def _news_gate_client_info(clients: list[dict], ea_name: str, magic) -> dict:
    hit = next((c for c in clients if c.get("ea_name") == ea_name), None)
    if hit is None and magic:
        hit = next((c for c in clients if c.get("magic") == magic), None)
    return {
        "news_gate_last_seen": hit.get("last_seen") if hit else None,
        "news_gate_ea_version": hit.get("ea_version") if hit else None,
    }


def _news_gate_llm_available() -> bool:
    return bool(os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip()
                or os.getenv("ANTHROPIC_API_KEY", "").strip())


def _news_gate_fetch_server_calendar() -> list:
    """服务端 /v1/calendar (公开) — 只作 EA 本地日历的补充。失败返回 []。"""
    import urllib.request
    base = (os.getenv("EASYDEAL_API_URL") or "https://easydeal.fay-agent.com").rstrip("/")
    try:
        with urllib.request.urlopen(base + "/v1/calendar", timeout=5) as r:
            data = json.loads(r.read())
        events = data.get("events") if isinstance(data, dict) else None
        return events if isinstance(events, list) else []
    except Exception as e:
        log.info("[news-gate] server calendar unavailable: %s", e)
        return []


def _news_gate_record(req: dict, result: dict, context: dict, latency_ms: int) -> str:
    return _record_decision(req, result, context=context, latency_ms=latency_ms, op="news_gate")


def _news_buffer_path() -> str | None:
    p = (os.getenv("EASYDEAL_NEWS_BUFFER_FILE") or "").strip()
    if p:
        return p
    ud = (os.getenv("EASYDEAL_USER_DATA_DIR") or "").strip()
    return os.path.join(ud, "data", "news-buffer.json") if ud else None


def _news_gate_json(payload: dict):
    """EA 端用 CP_UTF8 解码 + 极简 JSON 解析, 认不了 unicode 转义 —— 这里直接回 UTF-8 原文。"""
    return flask_app.response_class(json.dumps(payload, ensure_ascii=False),
                                    mimetype="application/json; charset=utf-8")


_NEWS_GATE = _news_gate.NewsGate(
    llm_call=_call_anthropic_llm,
    llm_available=_news_gate_llm_available,
    calendar_fetch=_news_gate_fetch_server_calendar,
    record_decision=_news_gate_record,
    news_buffer_path=_news_buffer_path(),
)


@flask_app.route("/news-gate", methods=["POST"])
def http_news_gate():
    """消息面护航。EA 开马丁单前调 (op=check), 或定期心跳 (op=hello)。
    任何异常都回 allow —— EA 端 HTTP 失败也按放行处理。

    check body: {op, ea_name, magic, symbol, side(buy|sell), level, volume,
                 calendar_ok, calendar:[{ts_utc, currency, title, importance, actual, forecast, previous}]}
    返回 data: {verdict: allow|deny|pending|disabled, mode, reason, retry_after_sec,
               decision_id, fail_open, shadow}"""
    try:
        data = flask_request.get_json(force=True) or {}
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400
    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400
    raw_name = str(data.get("ea_name") or "").strip()
    try:
        magic = int(data.get("magic") or 0)
    except (TypeError, ValueError):
        magic = 0
    ea = _news_gate_resolve_ea(raw_name, magic)
    _news_gate_touch(ea or raw_name, magic, data)
    cfg = _news_guard_config(ea) if ea else _news_gate.normalize_config(None)

    if (data.get("op") or "check").lower() == "hello":
        return _news_gate_json({"ok": True, "data": {
            "mode": cfg["mode"], "ea_name": ea or raw_name, "guarded": bool(ea),
        }})

    side = str(data.get("side") or "").lower()
    if side not in ("buy", "sell"):
        return jsonify({"ok": False, "error": "side must be buy|sell"}), 400
    try:
        req = {
            "ea_name": ea or raw_name,
            "magic": magic,
            "symbol": str(data.get("symbol") or ""),
            "side": side,
            "level": int(data.get("level") or 0),
            "volume": float(data.get("volume") or 0),
            "calendar": data.get("calendar") if isinstance(data.get("calendar"), list) else None,
            "calendar_ok": bool(data.get("calendar_ok")),
        }
        res = _NEWS_GATE.check(req, cfg)
    except Exception as e:
        log.exception("[news-gate] check failed: %s", e)
        res = {"verdict": "allow", "mode": cfg["mode"], "reason": "护航内部错误，默认放行",
               "retry_after_sec": 0, "decision_id": "", "fail_open": True, "shadow": False}
    if res.get("verdict") != "disabled":
        log.info("[news-gate] %s %s L%s → %s (%s)", req["ea_name"], side, req["level"],
                 res.get("verdict"), res.get("reason"))
    return _news_gate_json({"ok": True, "data": res})


@flask_app.route("/local-rules", methods=["GET"])
def http_local_rules():
    """0.3.66 P1-A: 给 EA / Electron 拿到一份 fast rules JSON 用于离线回测 / 服务挂时 fallback。
    Electron 启用拦截模式时拷一份到 MT5/MQL5/Files/OrderGuard/<ea>.rules.json。

    Query: ?ea=<ea_name> （必填）
    """
    ea_name = flask_request.args.get("ea")
    if not ea_name:
        return jsonify({"ok": False, "error": "missing ea param"}), 400
    profile = _load_rules(ea_name)
    # 给 EA 用的精简版（去掉 _meta / mode etc.）
    out = {
        "ea_name":  ea_name,
        "version":  int(time.time()),
        "enabled":  profile.get("enabled", True),
        "mode":     profile.get("mode", "observe"),
        "fast_rules":   profile.get("fast_rules", {}),
        "risk_policy":  profile.get("risk_policy", {}),
    }
    return jsonify({"ok": True, "data": out})


@flask_app.route("/set-guard-rule", methods=["POST"])
def http_set_guard_rule():
    """1.0.8: UI 直接开关 per-EA 拦截规则 (护航视图「平仓拦截」/「拦 SL 外扩」开关用)。
    Body: {ea_name, key, value(bool)}。key 走白名单, 避免 UI 把别的 profile 字段写坏。
    只动 _fast 行 (见 _update_fast_rule), 不会误删护航阈值。"""
    try:
        data = flask_request.get_json(force=True)
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400
    ea_name = (data.get("ea_name") or "").strip()
    key = (data.get("key") or "").strip()
    if not ea_name or not key:
        return jsonify({"ok": False, "error": "missing ea_name/key"}), 400
    BOOL_KEYS = {
        "fast_rules.close_guard.enabled",
        "fast_rules.modify_guard.block_sl_widen",
    }
    if key in BOOL_KEYS:
        value = bool(data.get("value"))
    elif key == "fast_rules.news_guard.mode":
        # 消息面护航三档: off(默认) / shadow(仅记录) / enforce(拦截)
        value = str(data.get("value") or "").lower()
        if value not in _news_gate.MODES:
            return jsonify({"ok": False, "error": f"invalid news_guard mode: {value}"}), 400
    else:
        return jsonify({"ok": False, "error": f"key not allowed: {key}"}), 400
    fast = _update_fast_rule(ea_name, key, value)
    if fast is None:
        return jsonify({"ok": False, "error": "apply failed"}), 500
    log.info("[set-guard-rule] %s %s=%s", ea_name, key, value)
    return jsonify({"ok": True, "data": {
        "ea_name": ea_name, "key": key, "value": value, "fast_rules": fast,
    }})


@flask_app.route("/notify", methods=["POST"])
def http_notify():
    """EA notifies about order lifecycle events."""
    try:
        data = flask_request.get_json(force=True)
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400

    decision_id = data.get("decision_id")
    if not decision_id:
        return jsonify({"ok": False, "error": "missing decision_id"}), 400

    _record_order_event(decision_id, data)
    return jsonify({"ok": True})


@flask_app.route("/status", methods=["GET"])
def http_status():
    """Get OrderGuard system status."""
    conn = _db()
    try:
        total = conn.execute("SELECT COUNT(*) as c FROM decisions").fetchone()["c"]
        blocked = conn.execute("SELECT COUNT(*) as c FROM decisions WHERE approved = 0").fetchone()["c"]
        ea_rows = conn.execute(
            "SELECT DISTINCT ea_name FROM decisions"
        ).fetchall()
    finally:
        conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "enabled": True,
            "port": HTTP_PORT,
            "ea_profiles": [r["ea_name"] for r in ea_rows],
            "total_decisions": total,
            "total_blocked": blocked,
            "block_rate": round(blocked / max(total, 1), 4),
        },
    })


@flask_app.route("/stats", methods=["GET"])
def http_stats():
    """Get stats for a specific EA and/or intent.
    0.3.170: 加 guarded + account_login 过滤跟 UI 三个 section 对齐."""
    ea = flask_request.args.get("ea")
    intent = flask_request.args.get("intent")
    cur_login = _tracker_state.get("account_login")
    acc_filter, acc_params = _build_account_filter(cur_login)
    ea_filter_layer4, ea_layer4_params = _build_enabled_ea_filter()    # 0.3.173: layer 4
    # 注意: 老 where 字段是不带表别名的 (ea_name / intent), 这里要保持兼容 —
    # decisions 单表查询时不用别名;JOIN orders 时给 decisions 别名 d, ea_name/intent
    # 仍是 decisions 列, 用 d.ea_name / d.intent 也行 (统一加 d.)
    conn = _db()
    try:
        where_parts = ["d.guarded = 1", acc_filter, ea_filter_layer4]
        params: list = list(acc_params) + list(ea_layer4_params)
        if ea:
            where_parts.append("d.ea_name = ?")
            params.append(ea)
        if intent:
            where_parts.append("d.intent LIKE ?")
            params.append(f"%{intent}%")

        where = " AND ".join(where_parts)

        total = conn.execute(
            f"SELECT COUNT(*) as c FROM decisions d WHERE {where}", params
        ).fetchone()["c"]

        blocked = conn.execute(
            f"SELECT COUNT(*) as c FROM decisions d WHERE {where} AND d.approved = 0", params
        ).fetchone()["c"]

        executed = total - blocked

        # Win rate from closed orders
        win_row = conn.execute(
            f"""SELECT
                COUNT(*) as total_closed,
                SUM(CASE WHEN o.pnl > 0 THEN 1 ELSE 0 END) as wins,
                AVG(o.pnl) as avg_pnl
            FROM orders o
            JOIN decisions d ON o.decision_id = d.decision_id
            WHERE o.close_price IS NOT NULL AND {where}""",
            params
        ).fetchone()

        total_closed = win_row["total_closed"] or 0
        wins = win_row["wins"] or 0
        avg_pnl = win_row["avg_pnl"]
    finally:
        conn.close()

    return jsonify({
        "ok": True,
        "data": {
            "intent": intent,
            "total": total,
            "blocked": blocked,
            "executed": executed,
            "win_rate": round(wins / max(total_closed, 1), 4),
            "avg_pnl": round(avg_pnl, 2) if avg_pnl is not None else None,
            "total_closed": total_closed,
        },
    })


@flask_app.route("/health", methods=["GET"])
def http_health():
    """0.3.155: health 检查 tracker_loop staleness — Flask HTTP 还活但 tracker 卡死时
    (mt5.* 调用死锁 / asyncio task 卡), 返 503 让 Electron 端 watchdog (orderguard.js
    _startHealthCheck, 3 次失败 = 90s 不可达 → 自动 restart child) 触发重启.
    grace period 90s — 启动 init 期 last_poll_ts=0 时不算 stale 防启动死循环."""
    now = int(time.time())
    last_poll = int(_tracker_state.get("last_poll_ts") or 0)
    boot_ts = int(_tracker_state.get("boot_ts") or now)
    boot_age = now - boot_ts
    if last_poll <= 0:
        # tracker 还没 poll 过 — boot grace period 内 OK, 否则 stale
        is_healthy = boot_age < 90
        stale_sec = boot_age
    else:
        stale_sec = now - last_poll
        is_healthy = stale_sec < 120  # tracker 2min 内 polled = OK
    return (jsonify({
        "ok": is_healthy,
        "status": "running" if is_healthy else "tracker_stale",
        "port": HTTP_PORT,
        "tracker_stale_sec": stale_sec,
        "last_poll_ts": last_poll,
        "boot_age_sec": boot_age,
    }), 200 if is_healthy else 503)


@flask_app.route("/reset-anchor", methods=["POST"])
def http_reset_anchor():
    """0.3.141: 让用户一键把某 EA 的 anchor 重置到 now（清零统计）。
    用户反馈：「这个 ea 是刚上护航功能的，为什么历史的单都跑进来了」—— 跟
    0.3.130「重置基准余额到当前」同款诉求：「从现在开始重新计数」。
    数据不删 (decisions / orders 表仍在)，只是 query 时被 anchor filter 过滤掉。

    0.3.171: 跟新 guarded 字段架构对齐 — 把该 EA 历史 guarded=1 的 row 全部清零,
    让 UI layer 1 (guarded=1 filter) 直接过滤掉. 之前只更新 ea_anchors 让 layer
    3 (ts >= anchor) 兜底过滤虽也能 work, 但跟「启用护航→guarded=1, 重置统计→
    guarded=0」对称设计不一致. 现在两个状态机口径一致.
    """
    try:
        data = flask_request.get_json(force=True) or {}
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400
    ea_name = (data.get("ea_name") or "").strip()
    if not ea_name or ea_name == "__unknown__":
        return jsonify({"ok": False, "error": "missing/invalid ea_name"}), 400
    _set_ea_anchor(ea_name)   # 默认 anchor = now (兜底 layer 3 + 后续 INSERT 时间起点)
    # 0.3.171: 同步清掉该 EA 历史 guarded=1, 走 layer 1 过滤 (跟新架构对齐)
    cleared = 0
    try:
        conn = _db()
        try:
            cur = conn.execute(
                "UPDATE decisions SET guarded = 0 WHERE ea_name = ? AND guarded = 1",
                (ea_name,)
            )
            cleared = cur.rowcount or 0
        finally:
            conn.close()
        log.info("[reset-anchor] %s: cleared guarded on %d decision row(s)", ea_name, cleared)
    except Exception as e:
        log.warning("[reset-anchor] clear guarded failed (anchor 仍已 reset, layer 3 兜底): %s", e)
    return jsonify({"ok": True, "data": {
        "ea_name": ea_name,
        "anchor": _get_ea_anchor(ea_name),
        "decisions_unmarked": cleared,
    }})


# 0.3.151 step 3: 微信推送 — main.js 端 60s 拉一次 pending alerts → 推微信
@flask_app.route("/alerts/pending", methods=["GET"])
def http_alerts_pending():
    """返回还没推送过微信的 alerts (risk_level='warning' AND notified_at IS NULL).
    最多 limit 条 (防 boot 后大堆积).
    """
    limit = min(int(flask_request.args.get("limit", 20)), 100)
    conn = _db()
    try:
        rows = conn.execute(
            """SELECT decision_id, ts, ea_name, intent, symbol, side,
                      requested_volume, reason, context_json
                 FROM decisions
                WHERE risk_level='warning' AND notified_at IS NULL
                ORDER BY ts DESC LIMIT ?""",
            (limit,)
        ).fetchall()
        items = [dict(r) for r in rows]
    finally:
        conn.close()
    return jsonify({"ok": True, "data": {"items": items, "count": len(items)}})


@flask_app.route("/alerts/mark-notified", methods=["POST"])
def http_alerts_mark_notified():
    """标记 decision_ids 已推送, 不再 pending. Body: {decision_ids: [...]}."""
    try:
        data = flask_request.get_json(force=True) or {}
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON"}), 400
    ids = data.get("decision_ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"ok": False, "error": "decision_ids required"}), 400
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%fZ")
    conn = _db()
    try:
        # SQLite 不支持 IN (?) bulk, 拼 placeholder
        placeholders = ",".join("?" for _ in ids)
        cur = conn.execute(
            f"UPDATE decisions SET notified_at=? WHERE decision_id IN ({placeholders})",
            (now_iso, *ids)
        )
        updated = cur.rowcount or 0
    finally:
        conn.close()
    return jsonify({"ok": True, "data": {"updated": updated}})


@flask_app.route("/closed-orders", methods=["GET"])
def http_closed_orders():
    """0.3.141: 显示「累计盈亏」组成 — 已平仓订单明细。
    用户反馈：「这个亏损是怎么来的？」需要能看到哪几笔合计 -40.20。
    用 ea_anchors 过滤跟顶部「累计盈亏」保持一致，避免数字对不上。
    0.3.170: 加 guarded + account_login 过滤. 已平仓订单 section 只显当前账户 +
    护航期间的 row, 跟「整体战绩」三个数完全对齐."""
    limit = min(int(flask_request.args.get("limit", 50)), 200)
    cur_login = _tracker_state.get("account_login")
    acc_filter, acc_params = _build_account_filter(cur_login)
    ea_filter, ea_params = _build_enabled_ea_filter()    # 0.3.173: layer 4
    conn = _db()
    try:
        rows = conn.execute(
            f"""SELECT o.ticket, o.open_price, o.open_time, o.close_price, o.close_time,
                      o.pnl, o.holding_sec, o.close_reason,
                      d.ea_name, d.symbol, d.side, d.requested_volume, d.approved_volume,
                      d.decision_id, d.ts AS decision_ts
               FROM orders o
               JOIN decisions d ON d.decision_id = o.decision_id
               LEFT JOIN ea_anchors a ON a.ea_name = d.ea_name
               WHERE o.close_time IS NOT NULL
                 AND d.guarded = 1
                 AND {acc_filter}
                 AND {ea_filter}
                 AND d.ts >= COALESCE(a.enabled_at, '0000')
               ORDER BY o.close_time DESC LIMIT ?""",
            acc_params + ea_params + [limit]
        ).fetchall()
    finally:
        conn.close()
    items = [dict(r) for r in rows]
    return jsonify({"ok": True, "data": {"orders": items, "count": len(items)}})


@flask_app.route("/force-poll", methods=["POST", "GET"])
def http_force_poll():
    """0.3.141: 让 UI「⟳ 刷新」按钮真的拉新数据，不是显「更新于 4s 前」cached 值。
    同步调一次 positions_get / account_info 立刻刷新 positions_cache + last_poll_ts。
    不调用 history_deals_get (那是 tracker loop 自己的 schedule，不需要每次 UI 刷新都拉)。
    返回成功 / 失败 / 当前 cache 大小。"""
    try:
        # 走跟 tracker loop 同款的 SDK 半死检查
        try:
            ti = mt5.terminal_info()
            connected = bool(ti and getattr(ti, "connected", False))
        except Exception:
            connected = False
        if not connected:
            # 0.3.199: 验 MT5 真在跑再 init — 防用户「关闭 MT5」后被 SDK 自动拉回来
            # 0.3.205: 加 kill-flag 检查 — 用户主动关了 → 不要 reattach
            # 0.3.206: mt5.initialize 必须传 path — 不带 path 会让 SDK 随机抓 OS 默认那个,
            # 用户多 MT5 (XM + Exness) 时撞错 broker (用户: 选 XM 却读到 Exness 数据).
            _install_dir = os.getenv("EASYDEAL_MT5_INSTALL_DIR") or ""
            if _install_dir and _killed_flag_present(_install_dir):
                return jsonify({"ok": False, "error": "MT5 已被用户主动关闭, 请到 MT5 tab 重新启动后再试"}), 503
            if _install_dir and _terminal_running_age_sec(_install_dir) < 60:
                # 1.4.8: 进程不存在或 boot 未满 60s 都拒 — 防 SDK 拉起幽灵 C 盘 MT5
                return jsonify({"ok": False, "error": "MT5 未运行或刚启动(未就绪) — 请在 MT5 tab 启动后稍等再试"}), 503
            try:
                _init_kwargs = {}
                if _install_dir:
                    for _cand in ("terminal64.exe", "terminal.exe"):
                        _p = os.path.join(_install_dir, _cand)
                        if os.path.isfile(_p):
                            _init_kwargs["path"] = _p
                            break
                _mt5_init_safe(_init_kwargs)   # 1.4.8: 带 portable
            except Exception as _re:
                return jsonify({"ok": False, "error": f"mt5 reinit failed: {_re}"}), 500

        raw_pos = mt5.positions_get()
        if raw_pos is None:
            return jsonify({"ok": False, "error": "positions_get returned None"}), 500
        positions = [{
            "ticket": p.ticket, "magic": int(p.magic or 0),
            "symbol": p.symbol, "type": p.type, "volume": p.volume,
            "price_open": p.price_open, "profit": p.profit,
            "swap": p.swap, "sl": p.sl, "tp": p.tp,
            "time": int(p.time or 0),
        } for p in raw_pos]
        now = int(time.time())
        _tracker_state["positions_cache"] = {p["ticket"]: p for p in positions}
        _tracker_state["last_poll_ts"] = now
        return jsonify({"ok": True, "data": {
            "positions_count": len(positions),
            "polled_at": now,
        }})
    except Exception as e:
        log.warning("force-poll failed: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 500


@flask_app.route("/positions", methods=["GET"])
def http_positions():
    """护航专栏「在跑订单」用 — 返回当前 MT5 持仓 + 每个 position 的 decision 详情。

    Response: {ok: true, data: {positions: [{ticket, ea_name, intent, risk_level,
                                              symbol, side, volume, open_price,
                                              open_time, pnl, decision: {...}}]}}
    """
    out = []
    pos_cache = _tracker_state.get("positions_cache", {})
    conn = _db()
    try:
        for ticket, p in pos_cache.items():
            magic = p.get("magic") or 0
            # 0.3.141: 改用 _resolve_ea_name — _ea_magic_map 没匹配 fallback monitor json
            # 用户填过「监控配置」的 magic 即使没点「启用护航」按钮，UI 也能显对 EA 名
            ea_name = _resolve_ea_name(magic)
            # 0.3.75: guarded 标记 — magic 已注册 AND ea 当前 enabled，则视为「在护航」
            # 0.3.141: guarded 仍按 _ea_enabled 判 — 用户得显式点过启用按钮才显「是」
            guarded = (ea_name != "__unknown__") and (ea_name in _ea_enabled)
            # 找该 position 的 decision
            row = conn.execute(
                """SELECT d.decision_id, d.ea_name, d.intent, d.risk_level,
                          d.requested_volume, d.approved_volume, d.approved,
                          d.reason, d.ai_checked, d.ai_confidence, d.context_json, d.ts,
                          o.open_price, o.open_time, o.pnl
                   FROM orders o JOIN decisions d ON o.decision_id = d.decision_id
                   WHERE o.ticket = ? AND o.close_time IS NULL
                   ORDER BY d.ts DESC LIMIT 1""",
                (ticket,)
            ).fetchone()
            decision = dict(row) if row else None
            if decision:
                decision["approved"] = bool(decision["approved"])
                decision["ai_checked"] = bool(decision["ai_checked"])
            # 0.3.151 step 2: per-ticket 最近 30min 警报 (intent ending _alert),
            # 客户端 UI 在 position 行加 ⚠ 标记 + tooltip
            alert_rows = conn.execute(
                """SELECT intent, reason, ts FROM decisions
                   WHERE risk_level='warning'
                     AND json_extract(context_json, '$.ticket') = ?
                     AND ts >= datetime('now', '-30 minutes')
                   ORDER BY ts DESC LIMIT 5""",
                (ticket,)
            ).fetchall()
            alerts = [
                {"intent": r["intent"], "reason": r["reason"], "ts": r["ts"]}
                for r in alert_rows
            ]
            out.append({
                "ticket": ticket,
                "ea_name": ea_name,
                "magic": magic,
                "guarded": guarded,
                "symbol": p.get("symbol"),
                "side": "buy" if p.get("type") == 0 else "sell",
                "volume": p.get("volume"),
                "open_price": p.get("price_open"),
                "open_time": datetime.fromtimestamp(p.get("time") or 0, timezone.utc)
                    .strftime("%Y-%m-%dT%H:%M:%SZ"),
                "current_pnl": (p.get("profit") or 0) + (p.get("swap") or 0),
                "sl": p.get("sl"), "tp": p.get("tp"),
                "decision": decision,
                "alerts": alerts,   # 0.3.151 step 2
            })
    finally:
        conn.close()
    return jsonify({"ok": True, "data": {
        "positions": out,
        "count": len(out),
        "tracker_running": _tracker_state.get("running", False),
        "last_poll_ts": _tracker_state.get("last_poll_ts"),
    }})


@flask_app.route("/decisions", methods=["GET"])
def http_decisions():
    """护航专栏「最近 24h 决策日志」用。
    0.3.170: 加 guarded + account_login 过滤. 跟「整体战绩 / 已平仓订单」section
    三个数完全对齐, 切户后旧户决策自动从 UI 隐藏."""
    ea_name = flask_request.args.get("ea")
    limit = min(int(flask_request.args.get("limit", 100)), 500)
    since = flask_request.args.get("since")    # ISO timestamp 可选
    cur_login = _tracker_state.get("account_login")
    acc_filter, acc_params = _build_account_filter(cur_login)
    ea_filter, ea_params = _build_enabled_ea_filter()    # 0.3.173: layer 4

    conn = _db()
    try:
        # 0.3.170: 三层 + 0.3.173: 四层过滤
        where_parts = [
            "d.guarded = 1",
            acc_filter,
            ea_filter,
            "d.ts >= COALESCE(a.enabled_at, '0000')",
        ]
        params: list = list(acc_params) + list(ea_params)
        if ea_name:
            where_parts.append("d.ea_name = ?")
            params.append(ea_name)
        if since:
            where_parts.append("d.ts >= ?")
            params.append(since)
        params.append(limit)

        rows = conn.execute(
            f"""SELECT d.* FROM decisions d
                LEFT JOIN ea_anchors a ON a.ea_name = d.ea_name
                WHERE {' AND '.join(where_parts)}
                ORDER BY d.ts DESC LIMIT ?""",
            params
        ).fetchall()
    finally:
        conn.close()

    decisions = []
    for r in rows:
        d = dict(r)
        d["approved"] = bool(d["approved"])
        d["ai_checked"] = bool(d["ai_checked"])
        decisions.append(d)
    return jsonify({"ok": True, "data": {"decisions": decisions, "count": len(decisions)}})


@flask_app.route("/enable", methods=["POST"])
def http_enable():
    """启用某 EA 的护航 — UI「🛡 护航」按钮调。

    Body: {ea_name, magic (int, 必传 — 让 monitor mode 能归属订单到这只 EA), mode='observe'|'enforce'}
    """
    try:
        data = flask_request.get_json(force=True)
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400
    ea_name = data.get("ea_name")
    magic = data.get("magic")
    mode = data.get("mode", "observe")
    if not ea_name:
        return jsonify({"ok": False, "error": "missing ea_name"}), 400
    if ea_name == "__unknown__":
        return jsonify({"ok": False, "error": "__unknown__ 是 post-hoc 占位，不能直接启用"}), 400
    if magic is None:
        return jsonify({"ok": False, "error": "missing magic — 监控模式需要 magic 把 deal 归到这只 EA"}), 400

    magic_int = int(magic)
    _ea_magic_map[magic_int] = ea_name
    _ea_enabled.add(ea_name)
    profile = _load_rules(ea_name)
    profile["enabled"] = True
    profile["mode"] = mode
    profile["magic"] = magic_int     # 0.3.73: 持久化 magic，重启后能还原 _ea_magic_map

    # 0.3.151 step 2: 接收阈值参数, 内存 + SQLite 持久化
    # body 可选: { thresholds: { single_loss_usd, single_loss_pct,
    #                            max_holding_hours, max_account_loss_pct, max_locked_positions } }
    thresholds_in = data.get("thresholds") or {}
    if isinstance(thresholds_in, dict) and thresholds_in:
        thr = {
            "single_loss_usd":      float(thresholds_in.get("single_loss_usd", -100)),
            "single_loss_pct":      float(thresholds_in.get("single_loss_pct", -5.0)),
            "max_holding_hours":    float(thresholds_in.get("max_holding_hours", 24)),
            "max_account_loss_pct": float(thresholds_in.get("max_account_loss_pct", -8.0)),
            "max_locked_positions": int(thresholds_in.get("max_locked_positions", 4)),
        }
        _ea_thresholds[ea_name] = thr
        profile["thresholds"] = thr
    _save_rules(ea_name, profile)

    # 0.3.141: 每次 enable 都 reset anchor 到 now —— 用户「停用 + 重新启用」
    # 即可清掉旧 stale 数据（query 过滤效果）
    _set_ea_anchor(ea_name)
    anchor_iso = _get_ea_anchor(ea_name) or ""

    # 0.3.73: 把历史上 magic 匹配的 __unknown__ decision 回填给这只 EA。
    # 用户之前可能因为 magic 没注册 / 服务重启丢映射 → 一堆 __unknown__ 记录，
    # 现在用 context_json 里的 magic 字段反查，自动重新归属。
    # 0.3.141: backfill 也按 anchor 过滤 — 早于 anchor 的 __unknown__ 不回填
    # 0.3.170: backfill 时同步标 guarded=1 — 这些 row 是该 EA 实际成交, enable 时刻
    # 用户确认要护航, 当作护航期数据.
    backfilled = 0
    try:
        conn = _db()
        if anchor_iso:
            cur = conn.execute(
                """UPDATE decisions SET ea_name = ?, guarded = 1
                   WHERE ea_name = '__unknown__'
                     AND json_extract(context_json, '$.magic') = ?
                     AND ts >= ?""",
                (ea_name, magic_int, anchor_iso)
            )
        else:
            cur = conn.execute(
                """UPDATE decisions SET ea_name = ?, guarded = 1
                   WHERE ea_name = '__unknown__'
                     AND json_extract(context_json, '$.magic') = ?""",
                (ea_name, magic_int)
            )
        backfilled = cur.rowcount or 0
        conn.close()
    except Exception as e:
        log.warning("Backfill __unknown__ decisions failed: %s", e)

    log.info("Enabled OrderGuard for EA=%s magic=%s mode=%s backfilled=%d",
             ea_name, magic, mode, backfilled)
    return jsonify({"ok": True, "data": {
        "ea_name": ea_name, "magic": magic, "mode": mode,
        "backfilled_decisions": backfilled,
    }})


@flask_app.route("/disable", methods=["POST"])
def http_disable():
    """暂停某 EA 的护航。保留历史数据，只停记录新 deal。
    0.3.173: 同时把该 EA 的 guarded=1 row 清零 — UI layer 4 (ea_name IN
    _ea_enabled) 已经自动隐藏 disable 后的 EA, 但 DB 字段也清零做持久化双保险,
    防止重启后 _ea_enabled 加载顺序变化等边界 case 让数据又冒出来.
    """
    try:
        data = flask_request.get_json(force=True)
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON body"}), 400
    ea_name = data.get("ea_name")
    if not ea_name:
        return jsonify({"ok": False, "error": "missing ea_name"}), 400
    _ea_enabled.discard(ea_name)
    # 从 magic_map 反查删
    for m, e in list(_ea_magic_map.items()):
        if e == ea_name:
            del _ea_magic_map[m]
    profile = _load_rules(ea_name)
    profile["enabled"] = False
    _save_rules(ea_name, profile)
    # 0.3.173: 持久化清掉 guarded
    cleared = 0
    try:
        conn = _db()
        try:
            cur = conn.execute(
                "UPDATE decisions SET guarded = 0 WHERE ea_name = ? AND guarded = 1",
                (ea_name,)
            )
            cleared = cur.rowcount or 0
        finally:
            conn.close()
    except Exception as e:
        log.warning("disable clear guarded failed: %s", e)
    log.info("Disabled OrderGuard for EA=%s, cleared guarded on %d rows", ea_name, cleared)
    return jsonify({"ok": True, "data": {
        "ea_name": ea_name,
        "enabled": False,
        "decisions_unmarked": cleared,
    }})


@flask_app.route("/enabled-eas", methods=["GET"])
def http_enabled_eas():
    """返回已启用护航的 EA 列表（给 UI「我的策略」按钮 query 用）。
    0.3.73: 过滤 __unknown__ — 它是 post-hoc 占位，不应该出现在「已护航 EA」列表里。"""
    out = []
    ng_clients = _news_gate_clients()
    for ea_name in _ea_enabled:
        if ea_name == "__unknown__":
            continue
        profile = _load_rules(ea_name)
        magic = next((m for m, e in _ea_magic_map.items() if e == ea_name), None)
        if magic is None and isinstance(profile.get("magic"), int):
            magic = profile["magic"]
        # 1.0.8: 带上平仓/改单拦截开关现状, 给护航视图 per-EA toggle 直接渲染 (免额外 fetch)。
        # 缺 key 时给默认: block_sl_widen 默认 True (安全方向默认开) / close_guard 默认 False。
        _fr = profile.get("fast_rules", {}) or {}
        _mg = _fr.get("modify_guard", {}) or {}
        _cg = _fr.get("close_guard", {}) or {}
        out.append({
            "ea_name": ea_name,
            "magic": magic,
            "mode": profile.get("mode", "observe"),
            "enabled": profile.get("enabled", True),
            "block_sl_widen": bool(_mg.get("block_sl_widen", True)),
            "close_guard_enabled": bool(_cg.get("enabled", False)),
            # 消息面护航: 开关 + EA 最近一次心跳 (没心跳 = EA 不支持或连不上护航服务)
            "news_guard_mode": _news_gate.normalize_config(_fr.get("news_guard"))["mode"],
            **_news_gate_client_info(ng_clients, ea_name, magic),
        })
    return jsonify({"ok": True, "data": {"eas": out, "count": len(out)}})


@flask_app.route("/rule-suggestions", methods=["GET"])
def http_rule_suggestions():
    """0.3.74 P3: 列学习中心生成的规则建议（pending/applied/dismissed/all）。"""
    ea = flask_request.args.get("ea")
    status_filter = flask_request.args.get("status") or "pending"
    limit = min(int(flask_request.args.get("limit", 100)), 500)
    conn = _db()
    try:
        where_parts = ["1=1"]
        params: list = []
        if ea:
            where_parts.append("ea_name = ?")
            params.append(ea)
        if status_filter != "all":
            where_parts.append("status = ?")
            params.append(status_filter)
        params.append(limit)
        rows = conn.execute(
            f"""SELECT * FROM rule_adjustments
                WHERE {' AND '.join(where_parts)}
                ORDER BY created_at DESC LIMIT ?""",
            params
        ).fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        d = dict(r)
        for k in ("old_value", "new_value"):
            try:
                d[k] = json.loads(d[k])
            except Exception:
                pass
        out.append(d)
    return jsonify({"ok": True, "data": {"suggestions": out, "count": len(out)}})


@flask_app.route("/rule-suggestions/<int:sid>/apply", methods=["POST"])
def http_rule_suggestions_apply(sid: int):
    """应用一条 pending 建议 — 写入 rules 表 + 标 applied_at。
    可后续 rollback 还原到 old_value。"""
    conn = _db()
    try:
        r = conn.execute("SELECT * FROM rule_adjustments WHERE id = ?", (sid,)).fetchone()
        if not r:
            return jsonify({"ok": False, "error": "suggestion not found"}), 404
        if r["status"] != "pending":
            return jsonify({"ok": False, "error": f"suggestion status={r['status']}, not pending"}), 400
        ea_name = r["ea_name"]
        rule_key = r["rule_key"]
        new_val = json.loads(r["new_value"])
        profile = _load_rules(ea_name)
        if not _apply_rule_value(profile, rule_key, new_val):
            return jsonify({"ok": False, "error": f"unsupported rule_key {rule_key}"}), 400
        _save_rules(ea_name, profile)
        conn.execute(
            """UPDATE rule_adjustments
               SET status='applied',
                   applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = ?""",
            (sid,)
        )
        log.info("Applied rule adjustment id=%d ea=%s key=%s val=%s",
                 sid, ea_name, rule_key, new_val)
    finally:
        conn.close()
    return jsonify({"ok": True, "data": {"applied": sid}})


@flask_app.route("/rule-suggestions/<int:sid>/dismiss", methods=["POST"])
def http_rule_suggestions_dismiss(sid: int):
    """忽略一条 pending 建议。"""
    conn = _db()
    try:
        conn.execute(
            """UPDATE rule_adjustments
               SET status='dismissed',
                   dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = ? AND status = 'pending'""",
            (sid,)
        )
    finally:
        conn.close()
    return jsonify({"ok": True, "data": {"dismissed": sid}})


@flask_app.route("/rule-suggestions/<int:sid>/rollback", methods=["POST"])
def http_rule_suggestions_rollback(sid: int):
    """回滚 applied 建议 — 改回 old_value。"""
    conn = _db()
    try:
        r = conn.execute("SELECT * FROM rule_adjustments WHERE id = ?", (sid,)).fetchone()
        if not r:
            return jsonify({"ok": False, "error": "suggestion not found"}), 404
        if r["status"] != "applied":
            return jsonify({"ok": False, "error": f"status={r['status']}, can only rollback applied"}), 400
        ea_name = r["ea_name"]
        rule_key = r["rule_key"]
        old_val = json.loads(r["old_value"])
        profile = _load_rules(ea_name)
        if not _apply_rule_value(profile, rule_key, old_val):
            return jsonify({"ok": False, "error": f"unsupported rule_key {rule_key}"}), 400
        _save_rules(ea_name, profile)
        conn.execute(
            """UPDATE rule_adjustments
               SET status='rolled_back',
                   rolled_back_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = ?""",
            (sid,)
        )
        log.info("Rolled back rule adjustment id=%d ea=%s key=%s val=%s",
                 sid, ea_name, rule_key, old_val)
    finally:
        conn.close()
    return jsonify({"ok": True, "data": {"rolled_back": sid}})


@flask_app.route("/ai-accuracy", methods=["GET"])
def http_ai_accuracy():
    """0.3.75: AI 校准统计 — AI 评估过的决策跟实际 outcome 对比，
    分 confidence 桶看实际 win rate。
    用来评估 AI 是不是过度乐观 / 悲观（暂时不自动调，只展示给用户）。"""
    ea = flask_request.args.get("ea")
    conn = _db()
    try:
        where = ["d.ai_checked = 1", "o.close_time IS NOT NULL"]
        params: list = []
        if ea:
            where.append("d.ea_name = ?")
            params.append(ea)
        rows = conn.execute(
            f"""SELECT d.ai_confidence, d.approved, o.pnl
                FROM decisions d JOIN orders o ON o.decision_id = d.decision_id
                WHERE {' AND '.join(where)}""",
            params
        ).fetchall()
    finally:
        conn.close()

    buckets = {"low (0.0-0.6)": [0, 0, 0.0],     # [win, tot, pnl_sum]
               "mid (0.6-0.8)": [0, 0, 0.0],
               "high (0.8-1.0)": [0, 0, 0.0]}
    for r in rows:
        c = r["ai_confidence"]
        if c is None:
            continue
        bk = "low (0.0-0.6)" if c < 0.6 else ("mid (0.6-0.8)" if c < 0.8 else "high (0.8-1.0)")
        b = buckets[bk]
        b[1] += 1
        b[2] += (r["pnl"] or 0)
        if (r["pnl"] or 0) > 0:
            b[0] += 1

    out = {}
    for k, (w, t, p) in buckets.items():
        out[k] = {
            "sample_n":   t,
            "win_rate":   round(w / t, 4) if t else None,
            "avg_pnl":    round(p / t, 2) if t else None,
        }
    total_n = sum(t for _, (_, t, _) in buckets.items())
    return jsonify({"ok": True, "data": {
        "ea": ea,
        "total_ai_decisions_closed": total_n,
        "by_confidence_bucket": out,
        "hint": "AI 校准良好：confidence 越高 → 实际 win_rate 越高。如果 high 桶 win_rate 反而比 mid/low 低 → AI 过度乐观。",
    }})


@flask_app.route("/rule-suggestions/scan-now", methods=["POST"])
def http_rule_suggestions_scan_now():
    """手动触发学习扫描（不等 24h 周期）。"""
    ea = (flask_request.get_json(silent=True) or {}).get("ea_name") if flask_request.is_json else None
    targets = [ea] if ea else list(_ea_enabled)
    total = 0
    for ea_name in targets:
        try:
            total += _generate_rule_suggestions_for_ea(ea_name)
        except Exception as e:
            log.exception("manual scan EA=%s failed: %s", ea_name, e)
    return jsonify({"ok": True, "data": {"new_suggestions": total, "eas_scanned": len(targets)}})


@flask_app.route("/overview-stats", methods=["GET"])
def http_overview_stats():
    """护航专栏「整体战绩」面板用 — 全局聚合统计。
    0.3.170: 改用 per-row guarded + account_login 字段过滤. 旧 ea_anchors JOIN
    作为「↻ 重置统计」按钮的兜底保留 (anchor 推到 now → 这之后再 INSERT 的 row 仍
    guarded=1, 但 ts 落入 anchor 之前的 row 走 anchor gate 被排除).
    切户后旧户 row.account_login != current → 自动过滤掉. 跟客户端 stats-collector
    accountSwitched archive+reset 语义对齐."""
    conn = _db()
    try:
        # 0.3.170: 三层过滤 — guarded=1 + 当前账户 + ts >= anchor (兜底)
        # 0.3.173: 加 layer 4 — d.ea_name IN <_ea_enabled> 实时反映护航列表,
        # 让 disable / 历史孤儿 EA (如 0.3.168 之前 _ea_magic_map 撞号 bug 残留的
        # SimpleBTC) 立刻从 UI 隐藏.
        cur_login = _tracker_state.get("account_login")
        acc_filter, acc_params = _build_account_filter(cur_login)
        ea_filter, ea_params = _build_enabled_ea_filter()
        # 1.0.7: 加 d.op='open' —— 平仓/改单现在也记成决策(op=close/modify), 不加这层
        # 过滤会把它们灌进「审批总数/拦截」把数字撑大. 这三个计数只算开仓决策; 平仓/改单
        # 单独计数 (close_decisions/modify_decisions/sl_widen_events).
        base_filter = f"""
            LEFT JOIN ea_anchors a ON a.ea_name = d.ea_name
            WHERE d.guarded = 1
              AND d.op = 'open'
              AND {acc_filter}
              AND {ea_filter}
              AND d.ts >= COALESCE(a.enabled_at, '0000')
        """
        common_params = acc_params + ea_params
        # 总审批 / 拦截 / 调整
        row = conn.execute(
            f"""SELECT
                 COUNT(*) AS total,
                 SUM(CASE WHEN d.approved = 0 THEN 1 ELSE 0 END) AS blocked,
                 SUM(CASE WHEN d.approved_volume IS NOT NULL AND d.approved_volume != d.requested_volume THEN 1 ELSE 0 END) AS adjusted
               FROM decisions d
               {base_filter}""",
            common_params
        ).fetchone()
        # 已平仓订单的累计盈亏 + 胜率 (按 orders→decisions→四层过滤)
        closed = conn.execute(
            f"""SELECT COUNT(*) AS n,
                      SUM(CASE WHEN o.pnl > 0 THEN 1 ELSE 0 END) AS wins,
                      SUM(o.pnl) AS total_pnl
               FROM orders o
               JOIN decisions d ON d.decision_id = o.decision_id
               LEFT JOIN ea_anchors a ON a.ea_name = d.ea_name
               WHERE o.close_time IS NOT NULL
                 AND d.guarded = 1
                 AND {acc_filter}
                 AND {ea_filter}
                 AND d.ts >= COALESCE(a.enabled_at, '0000')""",
            common_params
        ).fetchone()
        # 24h 决策数
        day_ago = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
        last_24h = conn.execute(
            f"""SELECT COUNT(*) AS n FROM decisions d
                LEFT JOIN ea_anchors a ON a.ea_name = d.ea_name
                WHERE d.ts >= ?
                  AND d.guarded = 1
                  AND d.op = 'open'
                  AND {acc_filter}
                  AND {ea_filter}
                  AND d.ts >= COALESCE(a.enabled_at, '0000')""",
            [day_ago] + common_params
        ).fetchone()["n"]
        # 1.0.7: 平仓/改单计数 (op 区分, 同样 guarded+账户+启用EA+anchor 过滤)
        close_n = conn.execute(
            f"""SELECT COUNT(*) AS n FROM decisions d
                LEFT JOIN ea_anchors a ON a.ea_name = d.ea_name
                WHERE d.guarded = 1 AND d.op = 'close'
                  AND {acc_filter} AND {ea_filter}
                  AND d.ts >= COALESCE(a.enabled_at, '0000')""",
            common_params
        ).fetchone()["n"] or 0
        modify_n = conn.execute(
            f"""SELECT COUNT(*) AS n FROM decisions d
                LEFT JOIN ea_anchors a ON a.ea_name = d.ea_name
                WHERE d.guarded = 1 AND d.op = 'modify'
                  AND {acc_filter} AND {ea_filter}
                  AND d.ts >= COALESCE(a.enabled_at, '0000')""",
            common_params
        ).fetchone()["n"] or 0
        # SL 外扩事件数 — modify_events.sl_widened=1, 复用 acc/ea 过滤 (把 d. 别名换成 m.)
        sl_widen_n = 0
        try:
            me_acc = acc_filter.replace("d.account_login", "m.account_login")
            me_ea = ea_filter.replace("d.ea_name", "m.ea_name")
            sl_widen_n = conn.execute(
                f"SELECT COUNT(*) AS n FROM modify_events m WHERE m.sl_widened = 1 "
                f"AND {me_acc} AND {me_ea}",
                common_params
            ).fetchone()["n"] or 0
        except Exception:
            pass
    finally:
        conn.close()

    total_closed = closed["n"] or 0
    return jsonify({"ok": True, "data": {
        "total_decisions":    row["total"] or 0,
        "blocked":            row["blocked"] or 0,
        "adjusted":           row["adjusted"] or 0,
        "decisions_24h":      last_24h,
        "closed_orders":      total_closed,
        "winning_orders":     closed["wins"] or 0,
        "win_rate":           round((closed["wins"] or 0) / max(total_closed, 1), 4),
        "cumulative_pnl":     round(closed["total_pnl"] or 0, 2),
        # 1.0.7: 平仓/改单/SL外扩 计数
        "close_decisions":    close_n,
        "modify_decisions":   modify_n,
        "sl_widen_events":    sl_widen_n,
    }})


@flask_app.route("/modify-events", methods=["GET"])
def http_modify_events():
    """1.0.7: 改单事件列表 (SL/TP 变动). UI「持仓/决策日志」展示 + 调试用。
    ?ea=<name> 过滤单 EA; ?limit=N (默认 50, 最多 500); 按当前账户过滤。"""
    ea = request.args.get("ea")
    try:
        limit = max(1, min(500, int(request.args.get("limit", 50))))
    except Exception:
        limit = 50
    conn = _db()
    try:
        cur_login = _tracker_state.get("account_login")
        where = "1=1"; params: list = []
        if ea:
            where += " AND ea_name = ?"; params.append(ea)
        if cur_login:
            where += " AND (account_login = ? OR account_login IS NULL)"; params.append(int(cur_login))
        rows = conn.execute(
            f"""SELECT id, ea_name, ticket, symbol, side, ts, old_sl, new_sl,
                       old_tp, new_tp, ref_price, sl_widened, sl_delta_points, source
                FROM modify_events WHERE {where}
                ORDER BY id DESC LIMIT ?""",
            params + [limit]
        ).fetchall()
        items = [dict(r) for r in rows]
    finally:
        conn.close()
    return jsonify({"ok": True, "items": items, "count": len(items)})


# ----------------------------------------------------------------------------
# MCP Server
# ----------------------------------------------------------------------------
server = Server("orderguard")


@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="orderguard_status",
            description="Get OrderGuard system status (total decisions, block rate, enabled EAs)",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="orderguard_stats",
            description="Get order guard stats for a specific EA and/or intent. Returns win rate, block rate, avg PnL.",
            inputSchema={
                "type": "object",
                "properties": {
                    "ea": {"type": "string", "description": "EA name (e.g. GMarket)"},
                    "intent": {"type": "string", "description": "Intent substring filter (e.g. martin)"},
                },
            },
        ),
        Tool(
            name="orderguard_rules_get",
            description="Get current guard rules for an EA. If EA has no rules, returns defaults.",
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA name"},
                },
                "required": ["ea_name"],
            },
        ),
        Tool(
            name="orderguard_rules_set",
            description="Set guard rules for an EA. Creates or updates the full rule profile.",
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA name"},
                    "rules": {"type": "object", "description": "Full rule profile JSON (risk_policy, fast_rules, mode, enabled)"},
                },
                "required": ["ea_name", "rules"],
            },
        ),
        Tool(
            name="orderguard_mode_set",
            description="Switch OrderGuard mode for an EA: 'observe' (log only) or 'enforce' (actually block).",
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA name"},
                    "mode": {"type": "string", "enum": ["observe", "enforce"], "description": "observe=log only, enforce=actually block"},
                },
                "required": ["ea_name", "mode"],
            },
        ),
        Tool(
            name="orderguard_decisions",
            description="List recent decisions (optionally filtered by EA). Returns latest N records.",
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "Filter by EA name"},
                    "limit": {"type": "integer", "description": "Max records (default 20, max 100)", "default": 20},
                },
            },
        ),
        Tool(
            name="orderguard_generate_rules",
            description="Auto-generate guard rules for an EA by analyzing its source code. Returns a suggested rule profile for user confirmation.",
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA name (must have source in strategies/ directory)"},
                    "conversation": {"type": "string", "description": "Optional conversation context for rule generation"},
                },
                "required": ["ea_name"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "orderguard_status":
        conn = _db()
        try:
            total = conn.execute("SELECT COUNT(*) as c FROM decisions").fetchone()["c"]
            blocked = conn.execute("SELECT COUNT(*) as c FROM decisions WHERE approved = 0").fetchone()["c"]
            ea_rows = conn.execute("SELECT DISTINCT ea_name FROM decisions").fetchall()
            mode_rows = conn.execute("SELECT ea_name, rule_json FROM rules WHERE intent = '_meta'").fetchall()
        finally:
            conn.close()

        ea_modes = {}
        for r in mode_rows:
            try:
                meta = json.loads(r["rule_json"])
                ea_modes[r["ea_name"]] = meta.get("mode", "observe")
            except:
                pass

        result = {
            "enabled": True,
            "port": HTTP_PORT,
            "ea_profiles": {
                r["ea_name"]: {"mode": ea_modes.get(r["ea_name"], "observe")}
                for r in ea_rows
            },
            "total_decisions": total,
            "total_blocked": blocked,
            "block_rate": f"{round(blocked / max(total, 1) * 100, 1)}%",
        }
        return [TextContent(type="text", text=json.dumps({"ok": True, "data": result}, indent=2))]

    elif name == "orderguard_stats":
        ea = arguments.get("ea")
        intent = arguments.get("intent")
        conn = _db()
        try:
            where_parts = []
            params = []
            if ea:
                where_parts.append("d.ea_name = ?")
                params.append(ea)
            if intent:
                where_parts.append("d.intent LIKE ?")
                params.append(f"%{intent}%")
            where = " AND ".join(where_parts) if where_parts else "1=1"

            total = conn.execute(
                f"SELECT COUNT(*) as c FROM decisions d WHERE {where}", params
            ).fetchone()["c"]
            blocked = conn.execute(
                f"SELECT COUNT(*) as c FROM decisions d WHERE {where} AND d.approved = 0", params
            ).fetchone()["c"]

            win_row = conn.execute(
                f"""SELECT
                    COUNT(*) as total_closed,
                    SUM(CASE WHEN o.pnl > 0 THEN 1 ELSE 0 END) as wins,
                    AVG(o.pnl) as avg_pnl
                FROM orders o
                JOIN decisions d ON o.decision_id = d.decision_id
                WHERE o.close_price IS NOT NULL AND {where}""",
                params
            ).fetchone()
        finally:
            conn.close()

        total_closed = win_row["total_closed"] or 0
        wins = win_row["wins"] or 0
        avg_pnl = win_row["avg_pnl"]

        result = {
            "ea": ea,
            "intent": intent,
            "total_decisions": total,
            "blocked": blocked,
            "executed": total - blocked,
            "win_rate": f"{round(wins / max(total_closed, 1) * 100, 1)}%",
            "avg_pnl": round(avg_pnl, 2) if avg_pnl is not None else None,
            "total_closed": total_closed,
        }
        return [TextContent(type="text", text=json.dumps({"ok": True, "data": result}, indent=2))]

    elif name == "orderguard_rules_get":
        ea_name = arguments["ea_name"]
        profile = _load_rules(ea_name)
        return [TextContent(type="text", text=json.dumps({"ok": True, "data": profile}, indent=2))]

    elif name == "orderguard_rules_set":
        ea_name = arguments["ea_name"]
        rules = arguments["rules"]
        if isinstance(rules, str):
            rules = json.loads(rules)
        _save_rules(ea_name, rules)
        return [TextContent(type="text", text=json.dumps({"ok": True, "data": {"ea_name": ea_name, "saved": True}}))]

    elif name == "orderguard_mode_set":
        ea_name = arguments["ea_name"]
        mode = arguments["mode"]
        profile = _load_rules(ea_name)
        profile["mode"] = mode
        _save_rules(ea_name, profile)
        return [TextContent(type="text", text=json.dumps({"ok": True, "data": {"ea_name": ea_name, "mode": mode}}))]

    elif name == "orderguard_decisions":
        ea_name = arguments.get("ea_name")
        limit = min(arguments.get("limit", 20), 100)
        conn = _db()
        try:
            if ea_name:
                rows = conn.execute(
                    "SELECT * FROM decisions WHERE ea_name = ? ORDER BY ts DESC LIMIT ?",
                    (ea_name, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM decisions ORDER BY ts DESC LIMIT ?",
                    (limit,)
                ).fetchall()
        finally:
            conn.close()

        decisions = []
        for r in rows:
            d = dict(r)
            d["approved"] = bool(d["approved"])
            d["ai_checked"] = bool(d["ai_checked"])
            decisions.append(d)

        return [TextContent(type="text", text=json.dumps({"ok": True, "data": {"decisions": decisions, "count": len(decisions)}}, indent=2, default=str))]

    elif name == "orderguard_generate_rules":
        # P2 placeholder: in full implementation this would read EA source
        # and generate rules. For now return a prompt template.
        ea_name = arguments["ea_name"]
        conversation = arguments.get("conversation", "")
        profile = _default_rules_for_ea(ea_name)
        return [TextContent(type="text", text=json.dumps({
            "ok": True,
            "data": {
                "ea_name": ea_name,
                "generated_rules": profile,
                "note": "P2: Auto-generation from EA source code not yet implemented. Default rules returned. Use orderguard_rules_set to customize.",
            },
        }, indent=2))]

    else:
        return [TextContent(type="text", text=json.dumps({"ok": False, "error": f"unknown tool: {name}"}))]


# ----------------------------------------------------------------------------
# Flask in background thread
# ----------------------------------------------------------------------------
def _pick_port() -> int:
    """0.3.65: 试 _PORT_CANDIDATES 里的端口，返回第一个能 bind 的。
    所有都失败 → 抛异常（OrderGuard 无法启动）。"""
    import socket
    for port in _PORT_CANDIDATES:
        if not port or port <= 0:
            continue
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((HTTP_HOST, port))
            sock.close()
            log.info("Selected port %d for HTTP server", port)
            return port
        except OSError as e:
            log.warning("Port %d unavailable (%s) — trying next", port, e)
            continue
        finally:
            try: sock.close()
            except: pass
    raise RuntimeError(f"OrderGuard: 所有候选端口都不可用 ({_PORT_CANDIDATES})")


def _write_port_file(port: int) -> None:
    """把实际选定的端口写到 PORT_FILE，给 Node 端读。"""
    try:
        Path(PORT_FILE).parent.mkdir(parents=True, exist_ok=True)
        with open(PORT_FILE, "w", encoding="utf-8") as f:
            f.write(str(port))
        log.info("Wrote port %d to %s", port, PORT_FILE)
    except Exception as e:
        log.warning("Failed to write port file %s: %s", PORT_FILE, e)


def _run_flask():
    """Run Flask HTTP server in a daemon thread."""
    flask_app.run(host=HTTP_HOST, port=HTTP_PORT, threaded=True, use_reloader=False)


# ============================================================================
# Copy-trade (0.4.10) — A 端推信号 + B 端消费信号执行
# ============================================================================
#
# 角色复用：orderguard_server 既给 OrderGuard 拦截模式服务，也给跟单服务。
# 复用动机：本进程已经有 Flask localhost HTTP（EA 同款 WebRequest）+ mt5 SDK 句柄
# + 长驻 asyncio loop。再开第 N 个 Python 子进程没必要。
#
# A 端（作者）：
#   EA hook (EasyDealCopyTrade.mqh) → POST 127.0.0.1:<port>/copy-trade/signal
#   → 本进程 forward 给 easydeal-server POST /v1/copy-trade/signal
# B 端（follower）：
#   启动时连 easydeal-server SSE GET /v1/copy-trade/stream
#   收到 signal → compute_size → mt5.order_send → POST /v1/copy-trade/ack
#
# 鉴权：从 EASYDEAL_SESSION_TOKEN env 拿 token（main.js spawn 时塞）。
# server base URL：EASYDEAL_API_URL（fallback https://easydeal.fay-agent.com）

import urllib.request as _urllib_request

_COPY_TRADE_SERVER_BASE = (os.getenv("EASYDEAL_API_URL")
                            or "https://easydeal.fay-agent.com").rstrip("/")
_COPY_TRADE_SESSION_TOKEN_ENV = "EASYDEAL_SESSION_TOKEN"


def _get_session_token() -> str:
    """读 token。先看 env，再看 token-store 缓存文件（fallback）。"""
    tok = (os.getenv(_COPY_TRADE_SESSION_TOKEN_ENV, "") or "").strip()
    if tok:
        return tok
    # fallback：读 electron 的 userData/token.json（如果有）
    try:
        user_data = os.getenv("EASYDEAL_USER_DATA_DIR", "")
        if user_data:
            p = Path(user_data) / "session.json"
            if p.is_file():
                data = json.loads(p.read_text(encoding="utf-8"))
                tok = data.get("token") or ""
                return tok.strip()
    except Exception:
        pass
    return ""


# ---- A 端 EA hook → forward to server ----

@flask_app.route("/copy-trade/signal", methods=["POST"])
def http_copy_trade_signal():
    """EA MQH 推 OnTradeTransaction 信号到这里。本进程做 fire-and-forget forward
    给 easydeal-server，立即回 EA 解阻塞 (EA WebRequest timeout 200ms)。

    Body (来自 EasyDealCopyTrade.mqh)：
      {ea_hash, ea_name, signal_type, symbol, side, volume, price, sl, tp,
       ticket_author, author_balance}
    """
    try:
        data = flask_request.get_json(force=True, silent=True) or {}
    except Exception:
        return jsonify({"ok": False, "error": "invalid JSON"}), 400

    ea_hash = (data.get("ea_hash") or "").strip()
    if not ea_hash:
        return jsonify({"ok": False, "error": "ea_hash required"}), 400

    token = _get_session_token()
    if not token:
        return jsonify({"ok": False, "error": "no_session_token (客户端未登录)"}), 200

    payload = {
        "token":           token,
        "ea_hash":         ea_hash,
        "signal_type":     data.get("signal_type") or "open",
        "symbol":          data.get("symbol"),
        "side":            data.get("side"),
        "volume":          data.get("volume"),
        "price":           data.get("price"),
        "sl":              data.get("sl"),
        "tp":              data.get("tp"),
        "ticket_author":   data.get("ticket_author"),
        "author_balance":  data.get("author_balance"),
    }

    # fire-and-forget — 在线程池里转发，立即返 EA 不阻塞
    def _forward():
        try:
            body = json.dumps(payload).encode("utf-8")
            req = _urllib_request.Request(
                f"{_COPY_TRADE_SERVER_BASE}/v1/copy-trade/signal",
                data=body, method="POST",
                headers={"Content-Type": "application/json"},
            )
            with _urllib_request.urlopen(req, timeout=3.0) as r:
                resp = json.loads(r.read())
                log.info("[copy-trade] forwarded signal ea_hash=%s fan_out=%s dropped=%s",
                         ea_hash[:12], resp.get("fan_out_count"), resp.get("dropped_count"))
        except Exception as e:
            log.warning("[copy-trade] forward signal failed: %s", e)

    threading.Thread(target=_forward, daemon=True).start()
    return jsonify({"ok": True, "queued": True}), 200


# ---- B 端（follower）SSE consumer + 执行 mt5.order_send ----

_copy_trade_sse_task: asyncio.Task | None = None


async def _copy_trade_sse_consume_loop():
    """连 easydeal-server SSE stream，收 signal 后调 mt5.order_send。
    无限重连 — 断了 5s 后重连。"""
    # httpx + httpx_sse 在 bundled runtime 里
    try:
        import httpx
        from httpx_sse import aconnect_sse
    except ImportError as e:
        log.warning("[copy-trade] httpx_sse not available: %s — copy-trade follower disabled", e)
        return

    while True:
        token = _get_session_token()
        if not token:
            # 没 token 等 30s 再查（用户可能刚装上没登录）
            await asyncio.sleep(30)
            continue

        url = f"{_COPY_TRADE_SERVER_BASE}/v1/copy-trade/stream?token={token}"
        log.info("[copy-trade] SSE connecting to %s", url.replace(token, '<token>'))
        try:
            timeout = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with aconnect_sse(client, "GET", url) as event_source:
                    async for sse in event_source.aiter_sse():
                        try:
                            payload = json.loads(sse.data)
                        except Exception:
                            continue
                        msg_type = payload.get("type")
                        if msg_type == "hello":
                            log.info("[copy-trade] SSE connected, license=%s",
                                     payload.get("license_key"))
                        elif msg_type == "signal":
                            # 在线程池里跑（mt5.order_send 是 sync IPC）
                            asyncio.get_running_loop().run_in_executor(
                                None, _copy_trade_execute_signal, payload)
                        # 其他 type 暂忽略
        except Exception as e:
            log.warning("[copy-trade] SSE connection broke: %s", e)
        # 5s backoff 重连
        await asyncio.sleep(5)


def _copy_trade_execute_signal(payload: dict):
    """收到 server fan-out 的 signal → 算手数 → mt5.order_send → 回 ack。
    在线程池里跑（mt5 SDK 是 sync），避免阻塞 asyncio loop。"""
    if not _MT5_AVAILABLE or mt5 is None:
        _copy_trade_ack(payload, ok=False, err="mt5_sdk_unavailable")
        return

    signal_type = payload.get("signal_type")
    author_symbol = (payload.get("symbol") or "").strip()
    # 0.4.13: follower 端 broker 上的对应品种名（申请跟单时填的）。留空走 fuzzy。
    symbol_override = (payload.get("symbol_override") or "").strip() or None
    side = (payload.get("side") or "").strip().lower()
    author_vol = float(payload.get("volume") or 0)
    sl = float(payload.get("sl") or 0)
    tp = float(payload.get("tp") or 0)
    price = float(payload.get("price") or 0)
    author_balance = payload.get("author_balance")
    size_mode = payload.get("size_mode") or "proportional"
    size_value = payload.get("size_value")

    if signal_type != "open":
        # 0.4.10 MVP：先只镜像「开仓」。close/modify 后续版本（要 follower 端记录
        # 一一对应的 ticket 映射）。
        _copy_trade_ack(payload, ok=False, err=f"signal_type {signal_type} not supported in MVP")
        return

    if not author_symbol or side not in ("buy", "sell") or author_vol <= 0:
        _copy_trade_ack(payload, ok=False,
                        err=f"invalid signal: symbol={author_symbol} side={side} vol={author_vol}")
        return

    # 0.4.13: 决定 follower 端用哪个 symbol —— 优先 symbol_override（follower 申请时
    # 明确指定的本地 broker 品种名），没填再走 fuzzy fallback。给明确的错误提示让用户
    # 知道是 broker 不支持还是没在 MT5 里打开图表窗口。
    if symbol_override:
        info = mt5.symbol_info(symbol_override)
        if info is None:
            _copy_trade_ack(payload, ok=False, err=(
                f"symbol_override_not_found_on_your_broker: '{symbol_override}'. "
                f"请检查拼写，或换一个 broker 实际存在的品种名 "
                f"（去 MT5 Market Watch 右键添加该品种），然后到「跟单」tab 重新申请。"))
            return
        symbol = symbol_override
    else:
        # 没 override → fuzzy fallback (XAUUSD → XAUUSDm / .c / # 等)
        info = mt5.symbol_info(author_symbol)
        if info is None:
            info = _copy_trade_resolve_symbol(author_symbol)
            if info is None:
                _copy_trade_ack(payload, ok=False, err=(
                    f"symbol_not_available_on_this_broker: '{author_symbol}'. "
                    f"作者用 {author_symbol}，你 broker 上找不到对应品种。"
                    f"请到「跟单」tab 重新申请并填上「我的 broker 对应品种名」"
                    f"（如 XAUUSDm / XAUUSD.c），先在 MT5 Market Watch 里加好并打开图表窗口。"))
                return
            symbol = info.name
        else:
            symbol = author_symbol

    # 0.4.13: visible=False 时 MT5 SDK 拿不到行情。先尝试 symbol_select 激活，
    # 失败再向用户报需要打开图表窗口。
    if not getattr(info, "visible", False):
        try: mt5.symbol_select(symbol, True)
        except Exception: pass
        # 重新拿一次 info 确认 visible
        info = mt5.symbol_info(symbol) or info
        if not getattr(info, "visible", False):
            _copy_trade_ack(payload, ok=False, err=(
                f"symbol_not_visible: '{symbol}' 在 MT5 Market Watch 里不可见，"
                f"无法拿到行情数据。请在 MT5 里右键 Market Watch → 添加 / 显示该品种，"
                f"或直接打开它的图表窗口，然后等下次信号过来 自动重试。"))
            return

    acc = mt5.account_info()
    follower_balance = float(getattr(acc, "balance", 0) or 0) if acc else 0
    contract_size = float(getattr(info, "trade_contract_size", 0) or 0)
    sl_distance = abs(price - sl) if (price and sl) else 0

    # 调 util.compute_size 等价物（本地复制公式，跟服务端 util.py:compute_size 同款）
    follower_lot, err = _copy_trade_compute_size(
        mode=size_mode, size_value=size_value,
        author_lot=author_vol, author_balance=author_balance,
        follower_balance=follower_balance,
        sl_distance_price=sl_distance, contract_size=contract_size,
        volume_min=float(getattr(info, "volume_min", 0.01) or 0.01),
        volume_max=float(getattr(info, "volume_max", 100.0) or 100.0),
        volume_step=float(getattr(info, "volume_step", 0.01) or 0.01),
    )
    if follower_lot is None:
        _copy_trade_ack(payload, ok=False, err=err or "compute_size_failed")
        return

    # max_concurrent 风控：当前对该 symbol 的持仓数
    max_concurrent = int(payload.get("max_concurrent") or 999)
    try:
        positions = mt5.positions_get(symbol=symbol) or []
        if len(positions) >= max_concurrent:
            _copy_trade_ack(payload, ok=False,
                            err=f"max_concurrent_reached ({len(positions)}/{max_concurrent})")
            return
    except Exception:
        pass

    # 实际下单
    order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
    tick = mt5.symbol_info_tick(symbol)
    actual_price = (tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid) if tick else price

    # 0.4.14: 跟单镜像单也走 OrderGuard 风控（跟 follower 自己的 EA 一视同仁）—
    # 在 order_send 之前调本机 /check。BLOCKED → 不下单 + ack；ADJUSTED → 用 OG
    # 调整后的手数；APPROVED → 按原计划。OG 服务挂了 / 调用失败 → fail-open
    # （继续下单 + log warn，避免 OG 故障把跟单全停）。
    # 用 ea_name = `__copy_trade_sub_<id>__`（跟 0.3.107 register 同款名），让用户
    # 可以在 OG 「策略 → 已护航」面板单独给这个跟单关系配 fast rules，比给自己 EA
    # 不同的规则（如：跟单 sub_42 每天最多 5 单 / 总持仓 ≤ 0.3 手 / 09-15 不下单 等）。
    og_decision_note = None
    try:
        sub_id_for_og = int(payload.get("subscription_id") or 0)
        og_result = _copy_trade_call_orderguard_check(
            ea_name=f"__copy_trade_sub_{sub_id_for_og}__",
            risk_level="medium",
            intent=f"copy_open_{side}",
            symbol=symbol,
            side=side,
            volume=follower_lot,
        )
        if og_result is not None:
            if not og_result.get("approved", True):
                reason = og_result.get("reason") or "blocked by OrderGuard"
                log.info("[copy-trade] OG blocked sub=%s reason=%s", sub_id_for_og, reason)
                _copy_trade_ack(payload, ok=False,
                                err=f"orderguard_blocked: {reason}")
                return
            adj = og_result.get("adjusted_volume")
            if adj and adj > 0 and abs(float(adj) - follower_lot) > 1e-6:
                old_lot = follower_lot
                follower_lot = float(adj)
                og_decision_note = f"OG adjusted {old_lot}→{follower_lot}"
                log.info("[copy-trade] OG adjusted sub=%s lot %.3f→%.3f",
                         sub_id_for_og, old_lot, follower_lot)
    except Exception as _og_e:
        log.warning("[copy-trade] OG check raised (fail-open): %s", _og_e)

    # 0.4.13 修：magic = subscription_id（每个跟单关系一个固定 magic）。
    # 之前用 `int(time.time()*1000)` 每次镜像 magic 都不一样 — 后果：
    #   1. 同一作者多次开仓 → follower 端孤立的多笔单，没法聚成一只虚拟 EA
    #   2. 未来 close signal 来时按 magic 找仓 → 找不到（每次 magic 不同）
    #   3. max_concurrent 风控统计「这个跟单关系当前持仓数」也算错
    # subscription_id 是 follow_subscriptions.id（SQLite ROWID, 全局唯一），
    # 一个 follower 对一个 (author, ea_name) 只一条 sub → 完美 1:1 magic 映射。
    # 同时跟 N 个作者 → N 个 magic 互不干扰。
    sub_id = int(payload.get("subscription_id") or 0)
    if sub_id <= 0:
        _copy_trade_ack(payload, ok=False, err="missing_subscription_id (server bug?)")
        return
    magic = sub_id & 0x7FFFFFFF
    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       follower_lot,
        "type":         order_type,
        "price":        actual_price,
        "sl":           sl,
        "tp":           tp,
        "deviation":    20,
        "magic":        magic,
        # 0.4.13: comment 也带 sub_id + ea hash 前缀，让用户翻 MT5 history 一眼看出是哪关系的镜像
        "comment":      f"ed:sub{sub_id}:{payload.get('ea_hash','?')[:6]}",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
    ticket = getattr(result, "order", None) if ok else None
    if ok:
        log.info("[copy-trade] mirrored sub=%s ea=%s side=%s lot=%s magic=%s ticket=%s",
                 sub_id, payload.get("ea_hash", "?")[:8], side, follower_lot, magic, ticket)
        # 0.4.13: 第一次镜像该 subscription 时，把这个 magic 注册到 OrderGuard
        # 的 `__copy_trade__` pseudo-EA（idempotent — OrderGuard /enable 已存在不重复建）。
        # 这样「策略 → 已护航」面板能看到一只虚拟 EA「跟单关系 sub_id」，统一管理跟单单。
        try:
            _orderguard_register_copy_trade(sub_id, magic, symbol, side, follower_lot)
        except Exception as _og_e:
            log.debug("[copy-trade] OG enroll failed (non-fatal): %s", _og_e)
    else:
        log.warning("[copy-trade] order_send failed: sub=%s retcode=%s",
                    sub_id, getattr(result, "retcode", "?"))
    _copy_trade_ack(payload, ok=ok, ticket=ticket,
                    err=None if ok else f"retcode={getattr(result, 'retcode', '?')}")


def _copy_trade_call_orderguard_check(*, ea_name: str, risk_level: str,
                                       intent: str, symbol: str, side: str,
                                       volume: float, timeout: float = 0.5) -> dict | None:
    """0.4.14: 跟单镜像单下单前调本机 OrderGuard /check 走风控。
    走本机 HTTP 而不是直接 import OG 函数 — 跟 OrderGuard.mqh 那条路径完全一致，
    保证 fast rules / AI cache / decisions DB 落库行为统一。
    HTTP 服务挂了 / port file 丢了 / 超时 → 返 None（fail-open，调用方继续下单）。
    """
    port_file = os.getenv("EASYDEAL_ORDERGUARD_PORT_FILE", "").strip()
    port = HTTP_PORT  # 本进程自己的 OG Flask 端口（理论上跟 port_file 一致）
    if port_file and os.path.isfile(port_file):
        try:
            with open(port_file, "r", encoding="utf-8") as _f:
                port = int(_f.read().strip()) or port
        except Exception:
            pass
    if port <= 0:
        return None

    import urllib.request as _ureq
    body = json.dumps({
        "ea_name":    ea_name,
        "risk_level": risk_level,
        "intent":     intent,
        "symbol":     symbol,
        "side":       side,
        "volume":     float(volume),
    }).encode("utf-8")
    try:
        req = _ureq.Request(
            f"http://127.0.0.1:{port}/check",
            data=body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        with _ureq.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read())
    except Exception as e:
        log.debug("[copy-trade] OG /check call failed (fail-open): %s", e)
        return None
    # OG /check 返 {"ok":true,"data":{"approved":bool,"adjusted_volume":num|null,"reason":str,...}}
    # 也兼容直接返 {"approved":...} 的 shape
    return resp.get("data") if isinstance(resp.get("data"), dict) else resp


def _orderguard_register_copy_trade(sub_id: int, magic: int, symbol: str,
                                     side: str, volume: float) -> None:
    """0.4.13: 把跟单镜像单的 magic 注册到 OrderGuard 监控（pseudo-EA `__copy_trade__`）。
    复用 _orderguard_register_ai_manual 的同款机制 — 走 localhost HTTP POST 给本进程
    自己的 /enable Flask route，避免直接操 OG 内部 state。"""
    port_file = os.getenv("EASYDEAL_ORDERGUARD_PORT_FILE", "").strip()
    if not port_file or not os.path.isfile(port_file):
        return    # OG 没起来 / 没配 — 静默
    try:
        with open(port_file, "r", encoding="utf-8") as _f:
            port = int(_f.read().strip())
    except Exception:
        return
    if port <= 0:
        return
    import urllib.request
    body = json.dumps({
        "ea_name": f"__copy_trade_sub_{sub_id}__",
        "magic":   int(magic),
        "mode":    "observe",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/enable",
        data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=2.0).read()
    except Exception:
        pass


def _copy_trade_compute_size(*, mode, size_value, author_lot, author_balance,
                              follower_balance, sl_distance_price, contract_size,
                              volume_min, volume_max, volume_step):
    """跟 server util.compute_size 同款公式。复制一份在 client 是为了 client-side
    quantize + 风控判断（不需要 round-trip server 算手数）。"""
    # 0.4.15: same_as_author —— follower 1:1 复用 author 原始手数（不换算）。
    # 最简单也最直觉的跟单语义，适合 author/follower 账户规模相近 OR follower 想严格
    # 等量跟单的场景。author_lot 来自 signal payload 的 volume 字段。
    if mode == "same_as_author":
        if not (author_lot and author_lot > 0):
            return (None, "author_lot missing for same_as_author")
        lot = float(author_lot)
    elif mode == "fixed_lot":
        if not (size_value and size_value > 0):
            return (None, "size_value missing for fixed_lot")
        lot = float(size_value)
    elif mode == "proportional":
        if not (author_lot and author_lot > 0):
            return (None, "author_lot missing")
        if not (author_balance and author_balance > 0):
            return (None, "author_balance missing (作者端未上报)")
        if not (follower_balance and follower_balance > 0):
            return (None, "follower_balance missing")
        lot = float(author_lot) * (float(follower_balance) / float(author_balance))
    elif mode == "percent_balance":
        if not (size_value and size_value > 0):
            return (None, "size_value (%) missing")
        if not (follower_balance and follower_balance > 0):
            return (None, "follower_balance missing")
        if not (sl_distance_price and sl_distance_price > 0):
            return (None, "SL 未设，percent_balance 需 SL 算手数")
        if not (contract_size and contract_size > 0):
            return (None, "contract_size missing")
        risk_amt = float(follower_balance) * (float(size_value) / 100.0)
        lot = risk_amt / (float(sl_distance_price) * float(contract_size))
    else:
        return (None, f"unknown size_mode: {mode}")
    if volume_step > 0:
        steps = round(lot / volume_step)
        lot = round(steps * volume_step, 8)
    if lot < volume_min:
        return (None, f"computed lot {lot} < broker min {volume_min}")
    if lot > volume_max:
        lot = volume_max
    return (lot, None)


def _copy_trade_resolve_symbol(symbol: str):
    """broker A 的 XAUUSD 在 broker B 叫 XAUUSDm 之类的 fuzzy 匹配。先全名命中，
    再带常见后缀尝试。返回 SymbolInfo 或 None。"""
    if not mt5: return None
    candidates = [symbol, f"{symbol}m", f"{symbol}.m", f"{symbol}c",
                  f"{symbol}#", f"{symbol}.", symbol.rstrip("m.#c")]
    for s in candidates:
        info = mt5.symbol_info(s)
        if info is not None:
            return info
    return None


def _copy_trade_ack(payload: dict, *, ok: bool, ticket: int | None = None,
                     err: str | None = None):
    """POST /v1/copy-trade/ack 回报结果。fire-and-forget。"""
    token = _get_session_token()
    if not token:
        return
    body = json.dumps({
        "token":           token,
        "signal_event_id": payload.get("signal_event_id"),
        "subscription_id": payload.get("subscription_id"),
        "ok":              ok,
        "ticket":          ticket,
        "err":             err,
    }).encode("utf-8")
    def _send():
        try:
            req = _urllib_request.Request(
                f"{_COPY_TRADE_SERVER_BASE}/v1/copy-trade/ack",
                data=body, method="POST",
                headers={"Content-Type": "application/json"},
            )
            _urllib_request.urlopen(req, timeout=3.0).read()
        except Exception as e:
            log.debug("[copy-trade] ack failed: %s", e)
    threading.Thread(target=_send, daemon=True).start()


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
async def main():
    global HTTP_PORT, _ai_queue, _ai_workers_loop
    _init_db()
    log.info("OrderGuard DB initialized at %s", DB_PATH)

    # 0.3.141: 一次性 anchor migration — 已 enabled 但没 anchor 的 EA 用最早 decision ts 兜底
    try:
        _migrate_ea_anchors()
        _migrate_decisions_notified_at()
        # 0.3.170: decisions 加 guarded + account_login 列 + backfill (per-row 护航标记 / 当前账户)
        _migrate_guarded_account_login()
        # 1.0.7: 平仓/改单 Phase1 — decisions.op + orders SL/TP + modify_events 表 + 索引
        _migrate_close_modify_columns()
        # 消息面护航: EA 心跳登记表 (护航页据此判断 EA 是否支持 / 是否连得上)
        _migrate_news_gate_tables()
    except Exception as _me:
        log.warning("ea_anchors migration failed (非致命): %s", _me)

    # 0.3.65: 选端口 + 写文件给 Node 读
    HTTP_PORT = _pick_port()
    _write_port_file(HTTP_PORT)

    # 0.3.66 P1-C: AI worker pool — main loop 上跑 N 个 coroutine 消费 _ai_queue
    _ai_queue = asyncio.Queue(maxsize=200)
    _ai_workers_loop = asyncio.get_running_loop()
    ai_worker_tasks = [
        asyncio.create_task(_ai_worker(i)) for i in range(AI_WORKERS)
    ]
    log.info("Spawned %d AI workers, cache TTL=%ds", AI_WORKERS, AI_CACHE_TTL_SEC)

    # 恢复 enabled EAs 状态（启动时把过往 enable 过的 EA 还原到内存）
    # 0.3.73: 同时还原 magic 映射 — 之前只还原 _ea_enabled，magic 丢了导致重启后
    # 所有 deal 都归 __unknown__。__unknown__ 这种伪 EA 不放回 enabled set。
    try:
        conn = _db()
        # 一次性清理过往版本残留的 __unknown__ rule 行（其他 EA 的不动）
        try:
            cur = conn.execute("DELETE FROM rules WHERE ea_name = '__unknown__'")
            log.info("Cleanup: removed %d rule rows for __unknown__", cur.rowcount or 0)
        except Exception:
            pass
        rows = conn.execute(
            "SELECT ea_name, rule_json FROM rules WHERE intent = '_meta'"
        ).fetchall()
        conn.close()
        for r in rows:
            ea_name = r["ea_name"]
            if ea_name == "__unknown__":
                continue   # 0.3.73: __unknown__ 是 fallback 占位，不该走 enable 流程
            try:
                meta = json.loads(r["rule_json"])
                enabled = bool(meta.get("enabled", True))
                if enabled:
                    _ea_enabled.add(ea_name)
                # 0.3.168: 只有 enabled=True 的 EA 才写 magic_map。disabled EA 的
                # magic 不该 hijack 解析逻辑 —— 否则用户实测撞过的 bug:
                #   enable A(magic=999) → disable A → enable B(magic=999) → OG 重启
                #   → A 的 meta.magic=999 又把 _ea_magic_map[999] 覆盖回 A.
                # 表现: 已护航 EA section 显 B (因为 _ea_enabled 正确), 但「在跑订单」
                # section ea_name 解析返 A (因为 _ea_magic_map 错). 数据对不上.
                if enabled and isinstance(meta.get("magic"), int):
                    _ea_magic_map[meta["magic"]] = ea_name
                # 0.3.151 step 2: 还原阈值 (跟 enabled 状态独立, disabled EA 阈值也保留)
                t = meta.get("thresholds")
                if isinstance(t, dict):
                    _ea_thresholds[ea_name] = t
            except Exception:
                pass
        log.info("Restored enabled EAs: %s; magic map: %s; thresholds for: %s",
                 sorted(_ea_enabled), dict(_ea_magic_map), sorted(_ea_thresholds.keys()))
    except Exception as e:
        log.warning("Failed to restore enabled EAs: %s", e)

    # Start Flask in background
    flask_thread = threading.Thread(target=_run_flask, daemon=True)
    flask_thread.start()
    log.info("OrderGuard HTTP server starting on %s:%d", HTTP_HOST, HTTP_PORT)

    # 启动 Order Tracker async task (监控模式核心)
    # 0.3.142: watchdog 改成独立 polling 不 await tracker_loop —— 用户反馈
    # 「还是不稳, ⚠ 886s 未更新」根因：MT5 SDK 内部可能死锁（重挂 EA 时 SDK handle
    # 跟死掉的 MT5 进程通信永不 return），整个 tracker_task await 卡住，原来的
    # `await t` watchdog 也跟着卡，永远不进 catch 分支。
    # 改成：watchdog 每 30s 检查 last_poll_ts 是否 stale > 120s，stale → 强制
    # tracker_task.cancel() + mt5.shutdown() + 5s 后重启新 task。这样即便 SDK
    # 死锁，watchdog 也能从外面打断 + 重启。
    async def _tracker_watchdog():
        nonlocal_state = {"task": None}
        STALE_THRESHOLD_SEC = 60  # 0.3.144: 120s → 60s 更激进 (用户反馈 278s 仍未恢复)

        def _spawn():
            nonlocal_state["task"] = asyncio.create_task(_order_tracker_loop())
            log.info("[watchdog] Order Tracker task spawned")

        _spawn()
        while True:
            try:
                # 0.3.144: sleep 缩到 15s 让 watchdog 反应更快 (老 30s 太长，
                # 实际 staleness=119s 时刚错过 check window 要等到 149s 才发现)
                await asyncio.sleep(15.0)
                t = nonlocal_state["task"]
                last_poll = int(_tracker_state.get("last_poll_ts") or 0)
                now = int(time.time())
                age = now - last_poll if last_poll > 0 else 9999

                # case 1: task 死了 (done + exception 或 done + 正常退出)
                if t is None or t.done():
                    if t and t.done():
                        exc = None
                        try: exc = t.exception()
                        except Exception: pass
                        log.error("[watchdog] tracker task done (exc=%s) — 重启", exc)
                    _spawn()
                    continue

                # case 2: task 活着但 last_poll_ts stale > 60s — SDK 死锁
                # 0.3.144: 阈值从 120s → 60s + mt5.shutdown() 用 run_in_executor +
                # timeout 包装，避免 watchdog 自己也被 sync 调用卡死。用户反馈
                # 「⚠ 278s 未更新」还没恢复，说明老 watchdog 自己 stuck 在
                # mt5.shutdown() sync 调用上（SDK 死锁时 shutdown 也 hang）。
                if age > STALE_THRESHOLD_SEC:
                    log.error(
                        "[watchdog] tracker stale %ds > %ds — 强制 cancel + mt5.shutdown + 重启",
                        age, STALE_THRESHOLD_SEC)
                    t.cancel()
                    try:
                        await asyncio.wait_for(t, timeout=3.0)
                    except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                        pass
                    # mt5.shutdown() 包成 executor task + timeout，防自己卡死
                    loop = asyncio.get_running_loop()
                    try:
                        await asyncio.wait_for(
                            loop.run_in_executor(None, mt5.shutdown),
                            timeout=3.0,
                        )
                    except (asyncio.TimeoutError, Exception) as _se:
                        log.warning("[watchdog] mt5.shutdown 卡住/异常 (忽略继续): %s", _se)
                    await asyncio.sleep(3.0)
                    _spawn()
                    continue
            except asyncio.CancelledError:
                log.info("[watchdog] 收到取消信号")
                t = nonlocal_state["task"]
                if t and not t.done():
                    t.cancel()
                return
            except Exception as e:
                log.exception("[watchdog] 自身异常 — 5s 后继续: %s", e)
                await asyncio.sleep(5.0)
    tracker_task = asyncio.create_task(_tracker_watchdog())
    # 0.3.74 P3: 启动学习中心 loop（每 24h 扫一次）
    learning_task = asyncio.create_task(_rule_learning_loop())
    # 0.4.10: 跟单 follower 角色 — SSE consumer 长连接服务端拿 fan-out 信号。
    # ⚠ 2026-06-16: 跟单功能已隐藏(client 0.3.345) → 不再启动这个 SSE consumer。
    #   旧实现无条件连 /v1/copy-trade/stream, 无活跃订阅被服务端 409 拒后每 5s 空转
    #   重连(纯噪音 + 占服务端连接槽)。跟单恢复时把下面 create_task 那行解注释即可
    #   (loop 函数 _copy_trade_sse_consume_loop 原样保留)。A 端(作者)信号 forward 的
    #   Flask 路由 /copy-trade/signal 不受影响(本来就只在 EA 推时才走)。
    global _copy_trade_sse_task
    _copy_trade_sse_task = None  # asyncio.create_task(_copy_trade_sse_consume_loop())

    try:
        # Run MCP stdio server — 主任务，主进程退出时 cancels tracker + AI workers
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())
    finally:
        tracker_task.cancel()
        learning_task.cancel()
        if _copy_trade_sse_task:
            _copy_trade_sse_task.cancel()
        for t in ai_worker_tasks:
            t.cancel()
        for t in [tracker_task, learning_task, _copy_trade_sse_task, *ai_worker_tasks]:
            if not t:
                continue
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:
                pass


if __name__ == "__main__":
    asyncio.run(main())
