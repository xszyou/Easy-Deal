"""EasyDeal Settings MCP Server — 让 Claude 改 EasyDeal 客户端的设置项。

跟主 easydeal MCP（交易 / 监控）分开：本进程只负责读写
``<userData>/data/settings.json``。改完之后主 MCP 会在下一次工具调用时通过
mtime 检测自动 reload —— Claude 不用重启会话也不用重启客户端。

典型用法：

  用户：「请连接到 D:\\Projects\\easy_deal_agent\\MetaTrader 5 EXNESS」
    → Claude 调 connect_mt5(install_dir="D:\\...\\MetaTrader 5 EXNESS")
    → 此 MCP 写 settings.mt5.installDir / dataDir
    → 下次用户问账户信息，主 MCP 自动 mt5.shutdown() + 重连，拿到新账号

  用户：「添加交易品种 xauusd.c」
    → Claude 调 add_monitor_symbol(symbol="xauusd.c")
    → 此 MCP 写 settings.monitor.symbols
    → 下次主 MCP 调用时 self.symbols / self.symbol 自动同步

读 / 写路径：

  EASYDEAL_SETTINGS_PATH 环境变量（Electron 启动 MCP 时注入）。
  没设 → 服务器以只读模式启动，所有 setter 返回 ok=false。

返回格式统一 ``{"ok": bool, "data" | "error"}``，跟 scheduler_mcp.py 一致。
"""

import asyncio
import json
import logging
import os
import sys
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent


logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s [easydeal_settings_mcp] %(levelname)s %(message)s",
)
log = logging.getLogger("easydeal_settings_mcp")


SETTINGS_PATH = os.getenv("EASYDEAL_SETTINGS_PATH")


def _ok(data: Any) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps({"ok": True, "data": data}, ensure_ascii=False))]


def _err(msg: str) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps({"ok": False, "error": msg}, ensure_ascii=False))]


def _ensure_writable() -> str | None:
    """返回错误信息，None 表示可写。"""
    if not SETTINGS_PATH:
        return "EASYDEAL_SETTINGS_PATH 未设置 —— 此 MCP 必须由 EasyDeal 客户端启动才能写设置"
    return None


def _read_settings() -> dict:
    if not SETTINGS_PATH or not os.path.isfile(SETTINGS_PATH):
        return {}
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception as e:
        log.warning("读 settings.json 失败：%s", e)
        return {}


def _write_settings(data: dict) -> None:
    """原子写：先写 .tmp 再 rename。Electron 同时读不会拿到半截 JSON。"""
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SETTINGS_PATH)


def _norm_dir(p: str) -> str:
    """归一化为 install dir 形式。"""
    s = str(p or "").replace("/", "\\")
    if s.lower().endswith(".exe"):
        s = os.path.dirname(s)
    return s.rstrip("\\")


def _detect_data_dir(install_dir: str) -> tuple[str | None, str]:
    """猜数据目录。返回 (path, source)。

    1. 便携模式：``<install_dir>/MQL5`` 存在 → install_dir 自己就是 dataDir
       （MetaTrader 5 EXNESS 这种用户自己解压到 D:\\Projects\\... 的副本就是
       这种情况）
    2. 否则 None —— 让用户自己设或者让 Electron 端走 registry / appdata 检测
    """
    try:
        if os.path.isdir(os.path.join(install_dir, "MQL5")):
            return install_dir, "portable"
    except Exception:
        pass
    return None, "unknown"


def _has_terminal_exe(install_dir: str) -> bool:
    for cand in ("terminal64.exe", "terminal.exe"):
        if os.path.isfile(os.path.join(install_dir, cand)):
            return True
    return False


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def connect_mt5(args: dict) -> list[TextContent]:
    """改 MT5 安装目录（+ 数据目录）。常见用法：
        connect_mt5(install_dir="D:\\Projects\\easy_deal_agent\\MetaTrader 5 EXNESS")
    """
    err = _ensure_writable()
    if err:
        return _err(err)
    install_dir = (args.get("install_dir") or "").strip()
    if not install_dir:
        return _err("install_dir is required（MT5 安装目录的绝对路径）")
    install_dir = install_dir.rstrip("\\/")
    if not os.path.isdir(install_dir):
        return _err(f"install_dir 不存在或不是目录：{install_dir}")
    if not _has_terminal_exe(install_dir):
        return _err(f"目录里找不到 terminal64.exe / terminal.exe：{install_dir}")

    data_dir = (args.get("data_dir") or "").strip().rstrip("\\/") or None
    data_dir_source = "user"
    if not data_dir:
        guess, src = _detect_data_dir(install_dir)
        if guess:
            data_dir = guess
            data_dir_source = src

    settings = _read_settings()
    settings.setdefault("mt5", {})
    prev_install = settings["mt5"].get("installDir")
    prev_data = settings["mt5"].get("dataDir")
    install_changed = (install_dir != prev_install)

    # 0.3.286: 只在 active instance 真"切"到这次的 install_dir 时, 才更新 settings.mt5
    # 老字段. 不然连 active 都不是这个 install, 跟着改 settings.mt5 等于把 active
    # 实例的字段污染掉.
    #
    # 用户 case: 实盘 D:\MetaTrader 5 是 active, 用户跑回测 → AI 调 connect_mt5
    # (install_dir=回测副本路径) → 老逻辑无脑 settings.mt5.installDir=回测副本 +
    # settings.mt5.dataDir=None → 老 mt5 老字段被回测副本污染, dataDir 清空 → 升级
    # 后 refreshDetection 走 detected = AppData scan → 实盘 dataDir 错落到 backtest
    # 副本 AppData hash 路径上. 回测栏在新 dataDir 找不到自己历史 → 显示丢.
    #
    # 修: 检查 activeMt5InstanceId. 如果 active 不是这次的 install_dir, 这次调用
    # 仅 add instance 到 mt5Instances[] (在下面 line 167+), 不动 settings.mt5.
    cur_active_id = settings.get("activeMt5InstanceId")
    cur_instances = settings.get("mt5Instances") or []
    cur_active = next((i for i in cur_instances if i.get("id") == cur_active_id), None) if cur_active_id else None
    _norm = lambda p: (p or "").replace("/", "\\").rstrip("\\").lower()
    active_matches_new = bool(cur_active) and _norm(cur_active.get("installDir")) == _norm(install_dir)
    should_update_mt5_legacy = (not cur_active) or active_matches_new

    if should_update_mt5_legacy:
        settings["mt5"]["installDir"] = install_dir
        if data_dir:
            settings["mt5"]["dataDir"] = data_dir
        elif install_changed:
            # 用户切到新 MT5 但没显式指定 dataDir，且我们的 portable 检测也没命中
            # → 必须把旧的 user-set dataDir 清掉。否则它在 getResolved 里仍然
            # 优先于「自动检测」的新值，下游所有读 dataDir 的功能（EA 徽章 / 日志 /
            # 回测）会拿着旧 broker 的目录。Electron watcher 看到 installDir 变了
            # 且 dataDir 空着会自动跑 refreshDetection 用 origin.txt 把对的填上。
            settings["mt5"]["dataDir"] = None
    # else: active 不是这个 install — 只 add 实例, settings.mt5 老字段保留指向 active

    # 0.3.223: 同步建/更新 mt5Instances[] 让 MT5 tab 看到. settings.js init()
    # migration 只在首次启动跑一次, AI 引导 / 用户后续调 connect_mt5 不会再触发
    # → 新装用户跑完 AI 引导 MT5 tab 仍空白. 这里 inline 处理:
    # 1. mt5Instances 空 → 新建 "默认实例" (跟 init migration 同款逻辑)
    # 2. 已有但路径不匹配 → 新建一个 ("默认实例-2" 之类), 不覆盖现有
    # 3. 已有且路径匹配 → 仅更新 dataDir (如果变了)
    instances = settings.get("mt5Instances") or []
    norm_path = install_dir.replace("/", "\\").rstrip("\\").lower()
    matching_idx = None
    for i, inst in enumerate(instances):
        inst_path = (inst.get("installDir") or "").replace("/", "\\").rstrip("\\").lower()
        if inst_path == norm_path:
            matching_idx = i
            break
    import time as _t, secrets as _sec
    instances_changed = False
    if matching_idx is not None:
        # 同路径实例已存在 → 同步 dataDir (如果新值不空)
        inst = instances[matching_idx]
        if data_dir and inst.get("dataDir") != data_dir:
            inst["dataDir"] = data_dir
            inst["updatedAt"] = _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime())
            instances_changed = True
    else:
        # 新加 instance
        new_id = "inst_" + _sec.token_urlsafe(9).replace("-","_").replace("=","").lower()
        new_inst = {
            "id":         new_id,
            "name":       "默认实例" if not instances else f"实例-{len(instances)+1}",
            "installDir": install_dir,
            "dataDir":    data_dir or install_dir,
            "createdAt":  _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime()),
            "notes":      "通过 AI 引导 / connect_mt5 工具添加",
        }
        instances.append(new_inst)
        settings["mt5Instances"] = instances
        # 第一个实例自动设为 active
        if not settings.get("activeMt5InstanceId"):
            settings["activeMt5InstanceId"] = new_id
        instances_changed = True

    _write_settings(settings)

    return _ok({
        "install_dir": install_dir,
        "data_dir": data_dir,
        "data_dir_source": data_dir_source,
        "previous": {"installDir": prev_install, "dataDir": prev_data},
        "mt5_instances_updated": instances_changed,
        "mt5_instances_count": len(settings.get("mt5Instances") or []),
        "note": (
            "已写入 settings.json + 同步到 mt5Instances[] (新装用户的 MT5 tab "
            "现在能看到这个实例). 下次调用 mcp__easydeal__get_account_info / "
            "get_positions 等工具时会自动 mt5.shutdown() + 重新绑定到新 MT5。"
            "如果是非便携式安装且没显式给 data_dir，客户端会跑注册表 + APPDATA "
            "origin.txt 匹配自动补上 dataDir，无需 Claude 操心。"
        ),
    })


def set_mt5_data_dir(args: dict) -> list[TextContent]:
    err = _ensure_writable()
    if err:
        return _err(err)
    data_dir = (args.get("data_dir") or "").strip().rstrip("\\/")
    if not data_dir:
        return _err("data_dir is required")
    if not os.path.isdir(data_dir):
        return _err(f"data_dir 不存在：{data_dir}")
    settings = _read_settings()
    settings.setdefault("mt5", {})
    prev = settings["mt5"].get("dataDir")
    settings["mt5"]["dataDir"] = data_dir
    # 0.3.223: 同步到 mt5Instances[] — 找匹配 installDir 的 entry 更新 dataDir,
    # 或者 active 实例 dataDir 也跟着改 (大概率是当前活动实例的 data_dir)
    instances = settings.get("mt5Instances") or []
    cur_install = settings["mt5"].get("installDir") or ""
    norm_install = cur_install.replace("/", "\\").rstrip("\\").lower()
    updated_inst_ids = []
    import time as _t
    now_iso = _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime())
    active_id = settings.get("activeMt5InstanceId")
    for inst in instances:
        inst_path = (inst.get("installDir") or "").replace("/", "\\").rstrip("\\").lower()
        if inst_path == norm_install or inst.get("id") == active_id:
            if inst.get("dataDir") != data_dir:
                inst["dataDir"] = data_dir
                inst["updatedAt"] = now_iso
                updated_inst_ids.append(inst.get("id"))
    _write_settings(settings)
    return _ok({"data_dir": data_dir, "previous": prev,
                "mt5_instances_updated": updated_inst_ids})


def _get_symbols(settings: dict) -> list[str]:
    return list((settings.get("monitor") or {}).get("symbols") or [])


def _set_symbols(settings: dict, symbols: list[str]) -> None:
    settings.setdefault("monitor", {})
    settings["monitor"]["symbols"] = symbols


def add_monitor_symbol(args: dict) -> list[TextContent]:
    err = _ensure_writable()
    if err:
        return _err(err)
    sym = (args.get("symbol") or "").strip()
    if not sym:
        return _err("symbol is required（如 'xauusd.c'）")
    settings = _read_settings()
    syms = _get_symbols(settings)
    # 大小写敏感保留用户输入；去重看大小写
    if sym in syms:
        return _ok({"symbols": syms, "added": False, "note": f"{sym} 已存在"})
    syms.append(sym)
    _set_symbols(settings, syms)
    _write_settings(settings)
    return _ok({"symbols": syms, "added": True})


def remove_monitor_symbol(args: dict) -> list[TextContent]:
    err = _ensure_writable()
    if err:
        return _err(err)
    sym = (args.get("symbol") or "").strip()
    if not sym:
        return _err("symbol is required")
    settings = _read_settings()
    syms = _get_symbols(settings)
    if sym not in syms:
        return _ok({"symbols": syms, "removed": False, "note": f"{sym} 不在监控列表"})
    syms = [s for s in syms if s != sym]
    _set_symbols(settings, syms)
    _write_settings(settings)
    return _ok({"symbols": syms, "removed": True})


def set_monitor_symbols(args: dict) -> list[TextContent]:
    err = _ensure_writable()
    if err:
        return _err(err)
    syms = args.get("symbols")
    if not isinstance(syms, list) or not all(isinstance(x, str) for x in syms):
        return _err("symbols 必须是字符串数组")
    syms = [s.strip() for s in syms if s.strip()]
    if not syms:
        return _err("symbols 不能为空，要清空请调 reset_setting('monitor.symbols')")
    settings = _read_settings()
    _set_symbols(settings, syms)
    _write_settings(settings)
    return _ok({"symbols": syms})


def set_monitor_magic_numbers(args: dict) -> list[TextContent]:
    err = _ensure_writable()
    if err:
        return _err(err)
    raw = args.get("magic_numbers")
    if not isinstance(raw, list):
        return _err("magic_numbers 必须是整数数组")
    cleaned: list[int] = []
    for x in raw:
        try:
            cleaned.append(int(x))
        except (TypeError, ValueError):
            return _err(f"非法 magic number：{x!r}（必须可转为 int）")
    settings = _read_settings()
    settings.setdefault("monitor", {})
    settings["monitor"]["magicNumbers"] = cleaned
    _write_settings(settings)
    return _ok({"magic_numbers": cleaned})


def set_monitor_comment_contains(args: dict) -> list[TextContent]:
    err = _ensure_writable()
    if err:
        return _err(err)
    raw = args.get("values")
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        return _err("values 必须是字符串数组")
    settings = _read_settings()
    settings.setdefault("monitor", {})
    settings["monitor"]["commentContains"] = raw
    _write_settings(settings)
    return _ok({"comment_contains": raw})


def set_monitor_comment_excludes(args: dict) -> list[TextContent]:
    err = _ensure_writable()
    if err:
        return _err(err)
    raw = args.get("values")
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        return _err("values 必须是字符串数组")
    settings = _read_settings()
    settings.setdefault("monitor", {})
    settings["monitor"]["commentExcludes"] = raw
    _write_settings(settings)
    return _ok({"comment_excludes": raw})


def set_trading_write_enabled(args: dict) -> list[TextContent]:
    """⚠ 危险开关：开了之后 AI 可以直接平仓 / 改单。改完需要重启 EasyDeal
    （workspace .mcp.json 启动时定型）才会真把 close_position / modify_position
    工具暴露给 Claude —— 仅写 settings.json 不够。"""
    err = _ensure_writable()
    if err:
        return _err(err)
    enabled = args.get("enabled")
    if not isinstance(enabled, bool):
        return _err("enabled 必须是 boolean")
    settings = _read_settings()
    settings["tradingWriteEnabled"] = enabled
    _write_settings(settings)
    return _ok({
        "trading_write_enabled": enabled,
        "note": (
            "已写入。注意：close_position / modify_position 工具是否真注入到 "
            "Claude，由客户端启动时把 EASYDEAL_TRADING_WRITE 注 .mcp.json 决定 —— "
            "你需要让用户重启 EasyDeal 客户端才能彻底生效。"
        ),
    })


def get_settings(args: dict) -> list[TextContent]:
    """读当前 settings.json 全文（按需可只取 mt5/monitor 子树）。

    0.3.215: section='mt5' 时同时返回 mt5Instances 列表 + activeMt5InstanceId
    (Phase 1+ 多 MT5 实例数据), 让 AI 工具能感知多 MT5 配置. 老 section='mt5'
    返的 {installDir, dataDir} 是默认实例的镜像 (向后兼容老代码读 settings.mt5.*).
    """
    if not SETTINGS_PATH:
        return _err("EASYDEAL_SETTINGS_PATH 未设置")
    settings = _read_settings()
    section = args.get("section")
    if section:
        # 0.3.215: mt5 section 特殊处理 — 多带 instances + active_id, AI 能看到多 MT5
        if section == "mt5":
            return _ok({
                "section": "mt5",
                "value": settings.get("mt5"),
                "mt5_instances": settings.get("mt5Instances") or [],
                "active_mt5_instance_id": settings.get("activeMt5InstanceId"),
                "note": (
                    "0.3.188+ 客户端支持多 MT5 实例并行. "
                    "value 是「默认实例」的 installDir/dataDir 镜像 (老代码兼容). "
                    "mt5_instances 是完整列表 (id/name/installDir/dataDir/user_intent), "
                    "active_mt5_instance_id 指默认承接未绑定 EA 的那只. "
                    "操作单个实例 (启动/关闭/绑 EA) 要用 mt5-instances:* IPC, AI 当前没暴露 — "
                    "让用户去 EasyDeal MT5 tab 操作."
                ),
            })
        return _ok({"section": section, "value": settings.get(section)})
    return _ok({"path": SETTINGS_PATH, "settings": settings})


def _read_mounted_state_for_instance(install_dir: str) -> dict | None:
    """0.3.339: 读 mounted-state.json 拿该 install_dir 上次成功挂的 EA 信息.
    跟主 MCP 的 _load_mounted_state 同款语义 — 这里独立实现避免跨进程 import.
    返 dict {ea_name, symbol, period, login, server, mounted_at} 或 None."""
    data_dir = os.getenv("EASYDEAL_DATA_DIR")
    if not data_dir or not install_dir:
        return None
    fp = os.path.join(data_dir, "mounted-state.json")
    if not os.path.isfile(fp):
        return None
    try:
        with open(fp, "r", encoding="utf-8") as f:
            state = json.load(f) or {}
        # 跟 _norm_install_key 同款: lower + / → \\ + 去末尾 \\
        key = str(install_dir).replace("/", "\\").rstrip("\\").lower()
        return state.get(key)
    except Exception as e:
        log.warning("读 mounted-state.json 失败：%s", e)
        return None


def list_mt5_instances(args: dict) -> list[TextContent]:
    """0.3.215: 给 AI 一个专门的多 MT5 实例列表 tool. 不需要解析 get_settings.
    0.3.339: 加 mounted_ea_name / mounted_symbol 字段, 让 AI 知道每个 instance
    实际挂的是哪个 EA — 不然 AI 会把全局 EA 列表喂给每个 instance."""
    if not SETTINGS_PATH:
        return _err("EASYDEAL_SETTINGS_PATH 未设置")
    settings = _read_settings()
    instances = settings.get("mt5Instances") or []
    active_id = settings.get("activeMt5InstanceId")
    out = []
    any_mounted = False
    for inst in instances:
        item = {
            "id":           inst.get("id"),
            "name":         inst.get("name"),
            "installDir":   inst.get("installDir"),
            "dataDir":      inst.get("dataDir"),
            "user_intent":  inst.get("user_intent") or "running",
            "is_default":   inst.get("id") == active_id,
            "notes":        inst.get("notes") or "",
            "createdAt":    inst.get("createdAt"),
        }
        mst = _read_mounted_state_for_instance(inst.get("installDir") or "")
        if mst:
            any_mounted = True
            item["mounted_ea_name"] = mst.get("ea_name")
            item["mounted_symbol"]  = mst.get("symbol")
            item["mounted_period"]  = mst.get("period")
            item["mounted_at"]      = mst.get("mounted_at")
            item["mounted_login"]   = mst.get("login")
            item["mounted_server"]  = mst.get("server")
        else:
            item["mounted_ea_name"] = None
            item["mounted_symbol"]  = None
        out.append(item)
    if not out:
        note = "用户当前没有配置任何 MT5 实例. 让用户去 EasyDeal MT5 tab 点「+ 添加实例」."
    else:
        base = (
            "is_default=true 的实例是「默认承接所有未绑定 EA」的那个. "
            "user_intent='stopped' 表示用户主动关了 MT5 (跨重启保留状态). "
            "操作 (启动/关闭/暂停交易/绑 EA) 走 EasyDeal MT5 tab 的按钮 UI."
        )
        if any_mounted:
            base += (
                " ⚠ mounted_ea_name / mounted_symbol 字段告诉你该 instance 实际挂的 "
                "EA 名和该 broker 上的 symbol —— 调 get_ea_realtime_stats / "
                "get_profit_history / get_klines / get_market_info 时, "
                "用对应 instance 的 mounted_ea_name 作 ea_name, mounted_symbol 作 "
                "symbol. 不要把全局 EA 列表都喂给某个 instance, 别的 instance 上没挂的 "
                "EA 在该 broker 上查不到 trades; 也不要用 strategy.symbol (XAUUSDm) "
                "去查另一 broker (XAUUSD) — 用每个 instance 自己的 mounted_symbol."
            )
        else:
            base += " mounted_ea_name=null 表示该 instance 还没成功挂载过 EA."
        note = base
    return _ok({
        "count": len(out),
        "active_id": active_id,
        "instances": out,
        "note": note,
    })


def reset_setting(args: dict) -> list[TextContent]:
    """把 dotted_key 对应的字段设为 null（生效后 Electron 走 detected / env
    fallback）。例：reset_setting('mt5.installDir')。"""
    err = _ensure_writable()
    if err:
        return _err(err)
    key = (args.get("key") or "").strip()
    if not key:
        return _err("key is required（dotted path 形式，如 'mt5.installDir'）")
    settings = _read_settings()
    parts = key.split(".")
    obj = settings
    for p in parts[:-1]:
        if not isinstance(obj.get(p), dict):
            return _err(f"路径不存在：{key}")
        obj = obj[p]
    last = parts[-1]
    if last not in obj:
        return _ok({"key": key, "removed": False, "note": "字段本来就不存在"})
    obj[last] = None
    _write_settings(settings)
    return _ok({"key": key, "removed": True})


# ---------------------------------------------------------------------------
# MCP wiring
# ---------------------------------------------------------------------------


server = Server("easydeal-settings")


@server.list_tools()
async def _list_tools():
    return [
        Tool(
            name="connect_mt5",
            description=(
                "切换 EasyDeal 绑定的 MT5 实例。改 settings.mt5.installDir + dataDir，"
                "主 easydeal MCP 在下次工具调用时自动 mt5.shutdown() + 重新绑定到新 MT5。"
                "用户说『请连接到 D:\\xxx\\MetaTrader 5 EXNESS』时调本工具。"
                "data_dir 不传时优先尝试便携模式（install_dir/MQL5 存在则 dataDir=installDir）。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "install_dir": {"type": "string", "description": "MT5 安装目录绝对路径（含 terminal64.exe）"},
                    "data_dir":    {"type": "string", "description": "可选；不传则尝试便携模式自动推断"},
                },
                "required": ["install_dir"],
            },
        ),
        Tool(
            name="set_mt5_data_dir",
            description="单独改 settings.mt5.dataDir（一般 connect_mt5 一并设了，本工具用于事后修正）。",
            inputSchema={
                "type": "object",
                "properties": {"data_dir": {"type": "string"}},
                "required": ["data_dir"],
            },
        ),
        Tool(
            name="add_monitor_symbol",
            description=(
                "把一个交易品种加进 EasyDeal 的监控列表（settings.monitor.symbols）。"
                "用户说『添加交易品种 xauusd.c』时调本工具。"
                "已存在则幂等（不报错，返回 added=false）。"
            ),
            inputSchema={
                "type": "object",
                "properties": {"symbol": {"type": "string", "description": "如 'XAUUSD'、'xauusd.c'"}},
                "required": ["symbol"],
            },
        ),
        Tool(
            name="remove_monitor_symbol",
            description="从监控列表里移除一个品种。不在列表里则幂等。",
            inputSchema={
                "type": "object",
                "properties": {"symbol": {"type": "string"}},
                "required": ["symbol"],
            },
        ),
        Tool(
            name="set_monitor_symbols",
            description="整体替换监控品种列表。要清空请改用 reset_setting('monitor.symbols')。",
            inputSchema={
                "type": "object",
                "properties": {"symbols": {"type": "array", "items": {"type": "string"}}},
                "required": ["symbols"],
            },
        ),
        Tool(
            name="set_monitor_magic_numbers",
            description="替换 EA 监控的 magic number 列表（settings.monitor.magicNumbers）。",
            inputSchema={
                "type": "object",
                "properties": {"magic_numbers": {"type": "array", "items": {"type": "integer"}}},
                "required": ["magic_numbers"],
            },
        ),
        Tool(
            name="set_monitor_comment_contains",
            description="替换 settings.monitor.commentContains（订单评论包含关键字过滤）。",
            inputSchema={
                "type": "object",
                "properties": {"values": {"type": "array", "items": {"type": "string"}}},
                "required": ["values"],
            },
        ),
        Tool(
            name="set_monitor_comment_excludes",
            description="替换 settings.monitor.commentExcludes（订单评论排除关键字）。",
            inputSchema={
                "type": "object",
                "properties": {"values": {"type": "array", "items": {"type": "string"}}},
                "required": ["values"],
            },
        ),
        Tool(
            name="set_trading_write_enabled",
            description=(
                "⚠ 危险开关：是否允许 AI 直接平仓 / 改单（close_position / modify_position 工具）。"
                "改完需要用户重启 EasyDeal 才能让工具列表真正生效。"
            ),
            inputSchema={
                "type": "object",
                "properties": {"enabled": {"type": "boolean"}},
                "required": ["enabled"],
            },
        ),
        Tool(
            name="get_settings",
            description=(
                "读当前 settings.json。section 不填返回全文；填 'mt5' / 'monitor' 等只返回子树。"
                "section='mt5' 时还返 mt5_instances 列表 + active_mt5_instance_id (多实例数据). "
            ),
            inputSchema={
                "type": "object",
                "properties": {"section": {"type": "string", "description": "可选；如 'mt5' 或 'monitor'"}},
            },
        ),
        Tool(
            name="list_mt5_instances",
            description=(
                "0.3.215: 列出用户当前配置的所有 MT5 实例 (0.3.188+ 客户端多 MT5 支持). "
                "每个实例: { id, name, installDir, dataDir, user_intent('running'/'stopped'), "
                "is_default(默认承接未绑定 EA), notes, mounted_ea_name, mounted_symbol, "
                "mounted_period, mounted_at }. "
                "⚠ 多 MT5 工具调用 (get_ea_realtime_stats / get_profit_history / "
                "get_klines / get_market_info / get_status) 之前**必须**先调本工具拿到每个 "
                "instance 实际挂的 EA + symbol —— 不要把全局策略列表的 EA 都喂给同一 "
                "instance, 也不要用 strategy.symbol (例 XAUUSDm) 去查另一 broker (XAUUSD). "
                "每个 instance 只查它自己 mounted_ea_name 上的数据, symbol 用它的 mounted_symbol."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="reset_setting",
            description=(
                "把指定字段重置为 null。dotted path 形式，如 'mt5.installDir'、'monitor.symbols'。"
                "生效后 Electron 客户端会走 detected / env 自动检测的回落值。"
            ),
            inputSchema={
                "type": "object",
                "properties": {"key": {"type": "string"}},
                "required": ["key"],
            },
        ),
    ]


_HANDLERS = {
    "connect_mt5":                  connect_mt5,
    "set_mt5_data_dir":             set_mt5_data_dir,
    "add_monitor_symbol":           add_monitor_symbol,
    "remove_monitor_symbol":        remove_monitor_symbol,
    "set_monitor_symbols":          set_monitor_symbols,
    "set_monitor_magic_numbers":    set_monitor_magic_numbers,
    "set_monitor_comment_contains": set_monitor_comment_contains,
    "set_monitor_comment_excludes": set_monitor_comment_excludes,
    "set_trading_write_enabled":    set_trading_write_enabled,
    "get_settings":                 get_settings,
    "list_mt5_instances":           list_mt5_instances,
    "reset_setting":                reset_setting,
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


async def main():
    log.info("settings MCP starting; SETTINGS_PATH=%s", SETTINGS_PATH or "<unset, read-only>")
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
