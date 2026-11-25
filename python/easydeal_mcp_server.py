"""
EasyDeal MCP Server - 交易监控MCP服务器（统一入口）
整合了监控服务、MCP协议接口及告警通知
"""

import asyncio
import base64
import json
import logging
import logging.handlers
import os
import re
import sys

import shutil
import subprocess
import time
import threading
import requests
import functools
import statistics
from datetime import datetime, timedelta, date
from typing import Any, Callable
from functools import wraps

import MetaTrader5 as mt5
import pytz
from flask import Flask, jsonify, request, Response

# Python's Windows embeddable runtime is isolated by python312._pth and does
# not automatically add the executed script's directory to sys.path.  The
# packaged client keeps shared modules beside this entrypoint, so make that
# location importable before loading them.  Keep this bootstrap in every
# standalone MT5 Python entrypoint; callers may launch from any working dir.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import mt5_lifecycle as _mt5_lifecycle
import mt5_profile as _mt5_profile
import mt5_windows as _mt5_windows
import board_kline as _board_kline


# 0.3.199: 防 mt5.initialize 自动 launch 用户刚关掉的 MT5. 用 psutil 看 install_dir
# 下的 terminal64.exe 进程在不在跑, 不在跑就跳过 init. 跟 orderguard_server.py 同款 helper.
def _ezd_terminal_is_running(install_dir: str) -> bool:
    return bool(_mt5_lifecycle.exact_terminal_pids(install_dir))


def _any_mt5_running() -> bool:
    """系统里有没有任意 MT5 终端(terminal64.exe/terminal.exe)在跑。
    用于无 install_dir(没配实例)时: 有在跑的 → path-less initialize 可 attach;
    一个都没有 → 跳过, 否则 path-less mt5.initialize() 会拉起「默认安装」的 MT5
    (落 %APPDATA% 默认档案、没登录), 即用户反馈的「装完启动自动开默认 MT5」。
    psutil 拿不到 → 宁可返 False(跳过 init), 不冒拉默认的险。"""
    return _mt5_lifecycle.any_terminal_running()


def _mt5_killed_recently(install_dir: str, grace_sec: float = 30.0) -> bool:
    """1.2.41: 用户在 EasyDeal 点「关闭」该实例后会写 kill-flag(mt5-killed-<md5>.flag)。
    grace_sec 内视为「刚关」→ 一律不 init。防 psutil race: 关闭瞬间进程还没死透,
    psutil 仍报 running → init 守卫放行 → mt5.initialize 此刻进程已死 → SDK 自动拉起
    新的(用户实测「在 EasyDeal 关了又自动重开」)。老 flag(>grace)不挡, 不影响读外部
    在跑的实例。跟 Node / OG 同款 md5 hash 路径。"""
    # Lifecycle v2: the flag is a persistent desired-stop state.  It is
    # cleared only by an explicit launch/adopt action, never by elapsed time.
    return _mt5_lifecycle.stopped_by_user(install_dir)


def _mt5_init(path=None, data_dir=None, launch_mode=None, **extra):
    """统一、attach-only 的 MT5 SDK 入口。

    公共 lifecycle 层验证显式 launchMode、进程稳定时间、停止/启动旗标，以及
    terminal_info.path + data_path。后台调用绝不把 SDK 的自动拉起能力当正常路径。
    """
    ok = _mt5_lifecycle.initialize_checked(
        mt5,
        path=path,
        retries=0,
        data_dir=data_dir,
        launch_mode=launch_mode,
        **extra,
    )
    if not ok:
        logging.warning("MT5 attach blocked: %s", _mt5_lifecycle.LAST_ERROR)
    return ok

# ============== 时区 ==============
# 全系统对外展示统一用北京时区。MT5 历史查询的边界（start/end）按 broker
# 服务器 TZ 决定，但用户看到的所有「时间字符串」都是 Asia/Shanghai。
# 之前混用 datetime.now()（裸的，依赖 host TZ）和 pytz Etc/UTC 导致微信
# 推送的时间错位。
BJ_TZ = pytz.timezone("Asia/Shanghai")


def _now_bj() -> datetime:
    """当前北京时间（aware datetime，tzinfo=Asia/Shanghai）。"""
    return datetime.now(BJ_TZ)


def _now_bj_str(fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    """当前北京时间的字符串表示，默认 'YYYY-MM-DD HH:MM:SS'。"""
    return _now_bj().strftime(fmt)


def _bj_date_str() -> str:
    """今天的北京日期 YYYY-MM-DD（用于日志文件名 / log 过滤）。"""
    return _now_bj().strftime("%Y-%m-%d")


# ============== 券商服务器时区偏移 ==============
# ⚠ MT5 所有时间戳 (copy_rates['time'] / tick.time / deal.time / position.time) 都是
# 「券商服务器墙上时间，按 UTC 编码的 epoch」—— datetime.fromtimestamp(t, tz=utc) 还原的
# 是服务器时钟，不是真 UTC。要转成真北京时间必须先知道券商相对 UTC 的偏移。
# 历史 bug: get_klines 用裸 datetime.fromtimestamp(t)（按本机 TZ 解释）→ 得到「服务器时间
# +本机偏移」的杂交值，比 market_data.time(_now_bj 真北京) 超前一个券商偏移 → AI 误判出
# 「未来 K 线」。这里用新鲜 tick 反推偏移并按券商缓存：tick.time(server epoch) - 真UTC = 偏移。
_BROKER_OFFSET_CACHE: dict = {}   # broker server name -> 偏移秒数 (server - utc)
_BROKER_OFFSET_LAST: dict = {}    # broker server name -> 上次成功探测的真 UTC 时刻


def _broker_server_key() -> str:
    """当前 SDK 连接的券商标识 — 偏移按券商缓存（多 MT5 各自时区可能不同）。"""
    try:
        ai = mt5.account_info()
        if ai and getattr(ai, "server", None):
            return str(ai.server)
    except Exception:
        pass
    try:
        ti = mt5.terminal_info()
        if ti and getattr(ti, "path", None):
            return str(ti.path)
    except Exception:
        pass
    return "_default"


def _refresh_broker_offset(symbol):
    """用新鲜 tick 反推券商 UTC 偏移（秒，取整到 30 分钟）。tick stale(休市,|raw|>15h)
    或拿不到 → 返回上次缓存（可能 None）。不主动扫 symbol，调用方传当前有行情的 symbol。"""
    key = _broker_server_key()
    if symbol:
        try:
            tick = mt5.symbol_info_tick(symbol)
            if tick and getattr(tick, "time", 0):
                raw = int(tick.time) - time.time()
                if abs(raw) <= 15 * 3600:          # 真实券商偏移不会超过 ±15h
                    off = int(round(raw / 1800.0) * 1800)
                    _BROKER_OFFSET_CACHE[key] = off
                    _BROKER_OFFSET_LAST[key] = time.time()
                    return off
        except Exception:
            pass
    return _BROKER_OFFSET_CACHE.get(key)


def _broker_offset_sec(symbol=None):
    """拿券商偏移（秒，server-utc）。缓存 <1h 直接用；过期且给了 symbol 则刷新；
    都没有 → None（调用方退回显示服务器墙上时间）。"""
    key = _broker_server_key()
    last = _BROKER_OFFSET_LAST.get(key, 0)
    if key in _BROKER_OFFSET_CACHE and (time.time() - last) < 3600:
        return _BROKER_OFFSET_CACHE[key]
    return _refresh_broker_offset(symbol)


# 数据大屏 K 线自己探偏移(get_board_klines): 上面的 |raw|≤15h 认不出刚休市的旧 tick, K 线时间错了会整段错位。
_BOARD_TICK_OFFSET = _board_kline.TickOffset(mt5, _broker_server_key)


def _mt5_epoch_to_bj_str(epoch, offset_sec, fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    """MT5 server-epoch → 真北京时间字符串。offset_sec=券商相对 UTC 偏移秒数；
    None=偏移未知 → 退回显示服务器墙上时间（仍比裸 fromtimestamp 更接近真值）。"""
    if epoch is None:
        return ""
    try:
        ep = int(epoch)
        if not ep:
            return ""
        if offset_sec is None:
            return datetime.fromtimestamp(ep, tz=pytz.utc).strftime(fmt)   # 服务器墙上时间
        return datetime.fromtimestamp(ep - int(offset_sec), tz=BJ_TZ).strftime(fmt)
    except Exception:
        return ""


# 0.3.119: per-EA 监控配置 — 客户端 setMonitorConfig 写到
# <workspace>/.easydeal-ea-monitor.json。MCP 工具按 ea_name 取 cfg：
#   { "GMarket": { symbols: ["XAUUSDm"], magic: 999, commentContains: [], commentExcludes: [] }, ... }
# 拿不到则返 None，caller fallback 全局 self.* filter。
def _load_ea_monitor_config(ea_name: str) -> dict | None:
    """读 <workspace>/.easydeal-ea-monitor.json 取指定 EA 的监控配置。
    返回标准化 dict (symbols / magic_numbers / comment_contains / comment_excludes) 或 None。"""
    if not ea_name:
        return None
    ws = os.getenv("EASYDEAL_WORKSPACE_DIR") or ""
    if not ws:
        return None
    cfg_path = os.path.join(ws, ".easydeal-ea-monitor.json")
    if not os.path.isfile(cfg_path):
        return None
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    # ea_name 可能带后缀，剥一下
    stem = ea_name.replace(".mq5", "").replace(".ex5", "").strip()
    raw = data.get(stem) or data.get(ea_name)
    if not raw:
        return None
    # 标准化字段名跟 self.* 对齐
    # 0.3.123: magic 改成支持多值 — 优先读 raw.magic_numbers 数组（客户端 0.3.123+ 写），
    # 退而读老 raw.magic 单值（客户端 0.3.119-0.3.122 写）
    magic_nums: list[int] = []
    if isinstance(raw.get("magic_numbers"), list):
        for v in raw["magic_numbers"]:
            try:
                n = int(v)
                if n >= 0:
                    magic_nums.append(n)
            except (TypeError, ValueError):
                continue
    if not magic_nums and raw.get("magic"):
        try:
            n = int(raw["magic"])
            if n > 0:
                magic_nums = [n]
        except (TypeError, ValueError):
            pass
    cfg = {
        "symbols":          [str(s).strip() for s in (raw.get("symbols") or []) if str(s).strip()],
        "magic_numbers":    magic_nums,
        "comment_contains": [str(s).strip() for s in (raw.get("commentContains") or []) if str(s).strip()],
        "comment_excludes": [str(s).strip() for s in (raw.get("commentExcludes") or []) if str(s).strip()],
    }
    # 全空 = 等于没配；返 None 走 fallback
    if not (cfg["symbols"] or cfg["magic_numbers"] or cfg["comment_contains"] or cfg["comment_excludes"]):
        return None
    return cfg


# 0.3.120: 加载所有 EA 配置 — 让任意持仓/订单都能反推归属 EA（即使没在 OrderGuard 注册）
# 作者反馈：「每个 ea 都已经有了魔术数和品种了，没有添加护航的订单也应该由此可以推断出是属于那个 ea 了」
def _load_all_ea_monitor_configs() -> dict:
    """读 <workspace>/.easydeal-ea-monitor.json 取所有 EA 的监控配置。
    返回 { ea_name: {symbols, magic_numbers, comment_contains, comment_excludes} } 或 {}。"""
    ws = os.getenv("EASYDEAL_WORKSPACE_DIR") or ""
    if not ws:
        return {}
    cfg_path = os.path.join(ws, ".easydeal-ea-monitor.json")
    if not os.path.isfile(cfg_path):
        return {}
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    out: dict = {}
    if not isinstance(data, dict):
        return out
    for ea_name, raw in data.items():
        if not isinstance(raw, dict):
            continue
        # 0.3.123: 同 _load_ea_monitor_config — 优先读 magic_numbers 数组兼容多 magic EA
        magic_nums_all: list[int] = []
        if isinstance(raw.get("magic_numbers"), list):
            for v in raw["magic_numbers"]:
                try:
                    n = int(v)
                    if n >= 0:
                        magic_nums_all.append(n)
                except (TypeError, ValueError):
                    continue
        if not magic_nums_all and raw.get("magic"):
            try:
                n = int(raw["magic"])
                if n > 0:
                    magic_nums_all = [n]
            except (TypeError, ValueError):
                pass
        cfg = {
            "symbols":          [str(s).strip() for s in (raw.get("symbols") or []) if str(s).strip()],
            "magic_numbers":    magic_nums_all,
            "comment_contains": [str(s).strip() for s in (raw.get("commentContains") or []) if str(s).strip()],
            "comment_excludes": [str(s).strip() for s in (raw.get("commentExcludes") or []) if str(s).strip()],
        }
        # 仅当至少一个字段非空时才有效
        if cfg["symbols"] or cfg["magic_numbers"] or cfg["comment_contains"] or cfg["comment_excludes"]:
            out[ea_name] = cfg
    return out


def _match_ea_for_order(item, all_configs: dict) -> "str | None":
    """根据持仓 / 成交记录的 magic + symbol + comment 反推归属哪个 EA。
    遍历 all_configs（_load_all_ea_monitor_configs 返回），按可信度排序：
      Pass 1 — magic 精确匹配（最可靠）：cfg.magic_numbers 含 item.magic
                  + symbol 若 cfg 配了也要匹配 + comment_excludes 排除
      Pass 2 — symbol-only 匹配（cfg 没配 magic 时退而求其次）：
                  cfg.symbols 含 item.symbol + comment 过滤通过
    都没命中 → None
    """
    if not all_configs:
        return None
    magic = int(getattr(item, "magic", 0) or 0)
    symbol = getattr(item, "symbol", "") or ""
    comment = (getattr(item, "comment", "") or "").lower()
    # Pass 1: magic 匹配
    for ea, cfg in all_configs.items():
        if not cfg["magic_numbers"]:
            continue
        if magic not in cfg["magic_numbers"]:
            continue
        if cfg["symbols"] and symbol not in cfg["symbols"]:
            continue
        if cfg["comment_excludes"] and any(t.lower() in comment for t in cfg["comment_excludes"]):
            continue
        if cfg["comment_contains"] and not any(t.lower() in comment for t in cfg["comment_contains"]):
            continue
        return ea
    # Pass 2: symbol-only（仅未配 magic 的 EA 参与，避免覆盖 magic 精确匹配）
    for ea, cfg in all_configs.items():
        if cfg["magic_numbers"]:
            continue
        if not cfg["symbols"]:
            continue
        if symbol not in cfg["symbols"]:
            continue
        if cfg["comment_excludes"] and any(t.lower() in comment for t in cfg["comment_excludes"]):
            continue
        if cfg["comment_contains"] and not any(t.lower() in comment for t in cfg["comment_contains"]):
            continue
        return ea
    return None


_BROKER_SUFFIX_RE = re.compile(r"[mcpzZ_.]+$", re.IGNORECASE)


def _normalize_symbol(s: str) -> str:
    """去 broker 单字母 / `.` 后缀 (XAUUSDm → XAUUSD, XAUUSD.c → XAUUSD, GOLD# → GOLD).
    0.3.150: 修「monitor_config 填 'XAUUSDm' 但 broker 实际 'XAUUSD' 严格比对失败」case.
    """
    if not s:
        return ""
    s = str(s).strip().upper()
    s = _BROKER_SUFFIX_RE.sub("", s)
    # 也去 # 后缀 (GOLD# 之类)
    return s.rstrip("#").rstrip(".")


def _symbol_match_any(deal_sym: str, allowed_syms) -> bool:
    """deal.symbol 跟 allowed 列表里任一比对 — normalized form (broker 后缀无关)."""
    if not deal_sym or not allowed_syms:
        return False
    dn = _normalize_symbol(deal_sym)
    return any(_normalize_symbol(s) == dn for s in allowed_syms)


def _ts_to_bj_str(ts, fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    """把 MT5 时间戳（秒；券商服务器时间编码）格式化成真北京时间字符串。
    None / 0 / 不可解析 → 空字符串。
    ⚠ 之前裸 fromtimestamp(ts, tz=BJ_TZ) 等于「服务器墙上时间+8h」，多算了一个券商偏移；
    现在统一走 _mt5_epoch_to_bj_str（探测券商偏移→真北京）。"""
    if ts is None:
        return ""
    try:
        if isinstance(ts, (int, float)):
            return _mt5_epoch_to_bj_str(int(ts), _broker_offset_sec(), fmt)
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                ts = pytz.utc.localize(ts)
            return ts.astimezone(BJ_TZ).strftime(fmt)
    except Exception:
        return ""
    return ""
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool,
    TextContent,
    Resource,
    Prompt,
    PromptMessage,
    GetPromptResult,
)

# ============== 日志配置 ==============

log_directory = "logs"
if not os.path.exists(log_directory):
    os.makedirs(log_directory)

# 主日志文件配置 (按天轮转)
log_file = os.path.join(log_directory, "easydeal.log")
logger = logging.getLogger()
logger.setLevel(logging.INFO)

class _SuppressListToolsFilter(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        return "Processing request of type ListToolsRequest" not in message

# 避免重复添加 Handler
if not logger.handlers:
    # 按天轮转，保留最近30天
    daily_handler = logging.handlers.TimedRotatingFileHandler(
        log_file,
        when="midnight",
        interval=1,
        backupCount=30,
        encoding="utf-8"
    )
    daily_handler.suffix = "%Y-%m-%d" # 切割后的后缀格式
    daily_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    daily_handler.addFilter(_SuppressListToolsFilter())
    logger.addHandler(daily_handler)

# API请求日志配置
api_logger = logging.getLogger('api_logger')
api_logger.setLevel(logging.INFO)
api_log_file = os.path.join(log_directory, "api_requests.log")
handler = logging.handlers.RotatingFileHandler(
    api_log_file,
    maxBytes=10*1024*1024,  # 10MB
    backupCount=5
)
handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
api_logger.addHandler(handler)

# 监控日志
monitor_logger = logging.getLogger('monitor')
monitor_logger.setLevel(logging.INFO)

# ============== Flask 应用 ==============

app = Flask(__name__)

# ============== MCP 服务器 ==============

server = Server("easydeal-trading")

# ============== 全局变量 ==============

strategy_instance = None
monitor_instance = None



# ============== 交易上下文类 ==============

class TradingContext:
    def __init__(self):
        logging.info("初始化交易上下文")

        # 监控配置
        profile_path = os.getenv("EA_PROFILE_PATH")
        self.profile_path = profile_path if profile_path else "monitor_profile.json"
        self.profile = {}
        self.symbols = ["GOLD", "GOLD#", "XAUUSDm", "XAUUSDc", "XAUUSD"]
        self.symbol = self.symbols[0]
        # 0.3.97: 默认空 list = 不按 magic 过滤（is_tracked_deal 的 `if self.magic_numbers:`
        # 短路）。之前 hardcode [999] 把所有真实 EA 的 deal 都 filter 掉 → get_profit_history
        # 返 0 笔（用户撞过，截图里 magic=107094107 也撞）。用户在 monitor_profile.json
        # 显式配 magic_numbers 时才走过滤；否则 show all deals。
        self.magic_numbers = []
        self.magic_number = 0
        self.max_loss = 3000
        self.comment_contains = []
        self.comment_excludes = []
        self.set_parameters = {}

        # 设置有效期（可选）
        self.expiry_date = None
        self.running = True

        # 运行状态
        self.is_open_position = False

        # Initialize MT5 connection — must happen before loading set/profile
        # so that mt5.terminal_info() and mt5.symbol_info() are available.
        #
        # 多实例消歧：用户开了几个 MT5（实盘 + 副本回测）时，
        # mt5.initialize() 不带 path 会随机抓一个 — 命中错的话查盘 / 下单
        # 都会落到错的账号上。显式把 EASYDEAL_MT5_INSTALL_DIR 里的
        # terminal64.exe 路径传进去就锁定了客户端「实盘 MT5」配置项指向
        # 的那个实例。
        # 候选名：terminal64.exe 普通名 / 32 位老版 terminal.exe。
        # （旧版本曾把副本改名成 terminal64_backtest.exe，但 MT5 自检不允许
        # 改名启动会立即 ExitCode 10001 退出，客户端已经反向迁移回原名。）
        init_kwargs = {}
        install_dir = os.getenv("EASYDEAL_MT5_INSTALL_DIR")
        if install_dir:
            for cand in ("terminal64.exe", "terminal.exe"):
                p = os.path.join(install_dir, cand)
                if os.path.isfile(p):
                    init_kwargs["path"] = p
                    logging.info(f"MT5 initialize 锁定到 {p}")
                    break
        # 0.3.199: MetaTrader5 SDK 的 initialize(path=...) 会自动 launch 终端,
        # 这条路径让用户「关闭 MT5」按钮关掉的 MT5 又被 MCP 拉起来. 这里先用 psutil
        # 验证 install_dir 下的 terminal64.exe 实际在跑, 不在跑就不调 initialize,
        # 让 MCP 标记成 running=False 等用户启动后再说.
        if install_dir and _mt5_killed_recently(install_dir):
            logging.warning(f"MT5 (install={install_dir}) 刚被用户关闭(kill-flag 新鲜) — "
                            f"跳过 initialize, 防 psutil race 把死掉的进程又拉起.")
            self.running = False
            return
        if install_dir and not _ezd_terminal_is_running(install_dir):
            logging.warning(f"MT5 (install={install_dir}) 未运行 — 跳过 initialize, "
                            f"MCP 启动后用户可手动启动 MT5")
            self.running = False
            return
        # 1.2.46: 没解析到具体实例路径(EASYDEAL_MT5_INSTALL_DIR 未配/未传给本 MCP)时,
        # 不要无脑 mt5.initialize() —— 无 path 的 initialize 在没 MT5 在跑时会自动拉起
        # 「默认安装」的 MT5(落 %APPDATA% 默认档案、没登录), 即用户反馈的「装完启动
        # 自动开默认 MT5(非配置数据目录)」。仅当系统已有 MT5 在跑时才 path-less attach;
        # 一个都没跑就跳过, 等用户配置 / 启动实例后再连。
        if not init_kwargs.get("path") and not _any_mt5_running():
            logging.warning("未配置 MT5 实例路径且系统无 MT5 在跑 — 跳过 initialize, "
                            "避免拉起默认安装的 MT5; 等用户配置/启动实例后再连。")
            self.running = False
            return
        if not _mt5_init(**init_kwargs):
            err = mt5.last_error() if hasattr(mt5, "last_error") else "unknown"
            logging.error(f"MT5初始化失败 path={init_kwargs.get('path')} err={err}")
            print(f"MT5初始化失败 path={init_kwargs.get('path')} err={err}")
            self.running = False
            return

        # 多 MT5 场景 SDK 不一定听 path — attach 后验证 terminal_info().path
        # 跟我们要求的一致没。不一致就 shutdown + retry，最多 5 次。
        # 注意：mt5.terminal_info().path 返回的是 install 目录（无 .exe），
        # 我们的 init_kwargs['path'] 是 install_dir/terminal64.exe — 比较前
        # 必须把 .exe 剥掉，否则永远不相等 → 触发 self.running=False 死锁。
        requested_path = init_kwargs.get("path")
        if requested_path:
            import time as _time
            def _norm_dir(p):
                """归一化为目录形式 — 全小写、反斜杠、剥 .exe、去末尾分隔符。
                terminal_info().path 是 install dir；我们的 path 是 .exe 全路径，
                必须先剥成同一形式才能比对。"""
                s = str(p or "").lower().replace("/", "\\")
                if s.endswith(".exe"):
                    s = os.path.dirname(s)
                return s.rstrip("\\")
            expected_dir = _norm_dir(requested_path)
            for attempt in range(6):
                try:
                    ti = mt5.terminal_info()
                    actual = ti.path if ti else None
                except Exception:
                    actual = None
                if _norm_dir(actual) == expected_dir:
                    if attempt > 0:
                        logging.info(f"MT5 SDK 绑到正确实例（重试 {attempt} 次后）")
                    break
                logging.warning(
                    f"MT5 SDK attached dir={actual} but expected dir={expected_dir} "
                    f"(attempt {attempt+1}/6)"
                )
                if attempt < 5:
                    try:
                        mt5.shutdown()
                    except Exception:
                        pass
                    _time.sleep(0.5)
                    if not _mt5_init(**init_kwargs):
                        logging.error(f"MT5 重试 init 失败：{mt5.last_error()}")
                        # 这里不能 self.running=False — 重试 init 失败可能是
                        # 暂时的，让 SDK 当前的连接（虽然可能绑错）保持。后面的
                        # symbol_info / account_info 走 SDK 自己处理。
                        break
            else:
                # 6 次都没绑对 — log + warning 但不杀 MCP。多 MT5 + SDK 路径绑定
                # 不可靠是真问题，但即使绑到「错的」MT5（同 broker 同账号的另一个
                # 实例）大部分功能仍能用。强行 self.running=False 会让所有查账号 /
                # 持仓 / 行情都炸，副作用比绑错本身大得多。让 Claude 看到具体
                # symbol_info=None 错误时再引导用户处理。
                logging.warning(
                    f"MT5 SDK 绑路径不一致：期望 {expected_dir}，实际 {_norm_dir(actual)}。"
                    f"继续用 SDK 当前连接（可能是用户多 MT5 导致的），如果后续 symbol_info "
                    f"等查询失败，会在那里给具体错误。"
                )

        # Baseline params: prefer MT5 chart profile (.chr), fallback to EA source defaults
        chart_params = _load_params_from_chart_profiles()
        if chart_params:
            self.set_parameters = {k: self._coerce_set_value(v) for k, v in chart_params.items()}
            logging.info(f"Loaded {len(chart_params)} runtime params from chart profile")
        else:
            try:
                ea_path = _get_strategy_file_path()
                if os.path.isfile(ea_path):
                    with open(ea_path, "r", encoding="utf-8") as f:
                        ea_content = f.read()
                    parsed = _parse_input_params(ea_content)
                    if parsed:
                        self.set_parameters = {p["name"]: self._coerce_set_value(p["value"]) for p in parsed}
                        logging.info(f"Loaded {len(parsed)} default params from EA source: {ea_path}")
            except Exception as exc:
                logging.warning(f"EA source param fallback failed: {exc}")

        ok, msg = self.load_profile(self.profile_path)
        if not ok:
            logging.warning(f"配置文件加载失败: {msg}")

        env_ok, env_msg = self.apply_env_profile()
        if env_ok:
            logging.info(f"已应用环境变量配置: {env_msg}")
        elif env_msg != "未设置环境变量配置":
            logging.warning(f"环境变量配置无效: {env_msg}")

        # 验证币对是否存在
        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info is None:
            logging.error(f"错误: MT5中不存在币对 {self.symbol}")
            print(f"错误: MT5中不存在币对 {self.symbol}")
            self.running = False
            return

        self.refresh_position_state()
        logging.info(f"载入交易上下文，交易币对: {self.symbol}")

    def get_config_info(self):
        """获取配置信息。set_parameters 按优先级合并 runtime_json > config_set > source_default。"""
        runtime_params = _load_params_from_runtime_json() or {}
        config_params = _load_params_from_config_set() or {}
        effective = dict(self.set_parameters)
        for k, v in config_params.items():
            effective[k] = self._coerce_set_value(v) if isinstance(v, str) else v
        for k, v in runtime_params.items():
            effective[k] = self._coerce_set_value(v) if isinstance(v, str) else v

        runtime_source = (
            "runtime_json" if runtime_params
            else ("config_set" if config_params else "baseline")
        )

        return {
            "parameters": {
                "symbols": self.symbols,
                "symbol": self.symbol,
                "magic_numbers": self.magic_numbers,
                "magic_number": self.magic_number,
                "max_loss": self.max_loss,
                "comment_contains": self.comment_contains,
                "comment_excludes": self.comment_excludes
            },
            "profile_path": self.profile_path,
            "set_parameters": effective,
            "set_parameters_source": runtime_source,
            "config_set_path": _get_config_set_path(),
            "ea_file_path": _get_strategy_file_path(),
            "metaeditor_path": _get_metaeditor_path(),
            "expiry_date": self.expiry_date.strftime("%Y-%m-%d %H:%M:%S") if self.expiry_date else None,
            "days_remaining": (self.expiry_date - datetime.now()).days if self.expiry_date else None,
            "is_expired": datetime.now() > self.expiry_date if self.expiry_date else False
        }

    def _to_list(self, value):
        if value is None:
            return None
        if isinstance(value, list):
            return value
        return [value]

    def _split_env_list(self, value: str):
        if value is None:
            return None
        items = [item.strip() for item in value.replace(";", ",").split(",")]
        return [item for item in items if item]

    def apply_profile(self, profile: dict, source: str = None) -> tuple[bool, str]:
        if not isinstance(profile, dict):
            return False, "配置文件格式不正确"

        errors = []
        updated = []

        symbols = self._to_list(profile.get("symbols"))
        if symbols is None and "symbol" in profile:
            symbols = self._to_list(profile.get("symbol"))
        if symbols is not None:
            valid_symbols = []
            for sym in symbols:
                if not isinstance(sym, str):
                    errors.append(f"无效品种: {sym}")
                    continue
                if mt5.symbol_info(sym) is None:
                    errors.append(f"品种不存在: {sym}")
                    continue
                valid_symbols.append(sym)
            if valid_symbols:
                self.symbols = valid_symbols
                self.symbol = valid_symbols[0]
                updated.append("symbols")
            else:
                errors.append("未找到可用的品种配置")

        magics = self._to_list(profile.get("magic_numbers"))
        if magics is None and "magic_number" in profile:
            magics = self._to_list(profile.get("magic_number"))
        if magics is not None:
            cleaned = []
            for value in magics:
                try:
                    cleaned.append(int(value))
                except (TypeError, ValueError):
                    errors.append(f"无效魔术号: {value}")
            self.magic_numbers = cleaned
            self.magic_number = cleaned[0] if cleaned else 0
            updated.append("magic_numbers")

        if "max_loss" in profile:
            try:
                self.max_loss = float(profile["max_loss"])
                updated.append("max_loss")
            except (TypeError, ValueError):
                errors.append(f"无效 max_loss: {profile['max_loss']}")

        comment_contains = self._to_list(profile.get("comment_contains"))
        if comment_contains is not None:
            self.comment_contains = [str(item) for item in comment_contains]
            updated.append("comment_contains")

        comment_excludes = self._to_list(profile.get("comment_excludes"))
        if comment_excludes is not None:
            self.comment_excludes = [str(item) for item in comment_excludes]
            updated.append("comment_excludes")

        if source:
            self.profile_path = source
        self.profile = profile

        # 0.3.206: 至少有一个 valid_symbols 命中就算 ok — 之前一律返 False 让 log 显
        # 「环境变量配置无效」吓人但其实正常工作 (用户 XM 撞过: 4 候选只 GOLD# 通过,
        # log 警告说 4 个全不存在但 broker 实际选中了 GOLD#).
        if errors and not updated:
            return False, "; ".join(errors)
        if errors and updated:
            return True, ("已应用配置: " + ", ".join(updated)
                          + "; 部分候选跳过 (broker 不提供): " + "; ".join(errors))
        return True, "已应用配置: " + ", ".join(updated) if updated else "未更新任何配置"

    def _coerce_set_value(self, value: str):
        raw = value.strip()
        if not raw:
            return ""
        lower = raw.lower()
        if lower in ("true", "false"):
            return lower == "true"
        try:
            if "." in raw or "e" in lower:
                return float(raw)
            return int(raw)
        except ValueError:
            return raw

    def load_profile(self, path: str) -> tuple[bool, str]:
        if not path:
            return False, "配置文件路径为空"
        if not os.path.exists(path):
            return False, f"找不到配置文件: {path}"
        try:
            with open(path, "r", encoding="utf-8") as f:
                profile = json.load(f)
        except Exception as e:
            return False, f"读取配置文件失败: {e}"
        return self.apply_profile(profile, source=path)

    def apply_env_profile(self) -> tuple[bool, str]:
        profile = {}

        symbols_env = os.getenv("EA_SYMBOLS", "GOLD,GOLD#,XAUUSD,XAUUSDm,XAUUSDc")
        profile["symbols"] = self._split_env_list(symbols_env)

        magics_env = os.getenv("EA_MAGIC_NUMBERS")
        if magics_env is not None:
            profile["magic_numbers"] = self._split_env_list(magics_env)
        else:
            magic_env = os.getenv("EA_MAGIC_NUMBER")
            if magic_env is not None:
                profile["magic_number"] = magic_env

        max_loss_env = os.getenv("EA_MAX_LOSS")
        if max_loss_env is not None:
            profile["max_loss"] = max_loss_env

        comment_contains_env = os.getenv("EA_COMMENT_CONTAINS")
        if comment_contains_env is not None:
            profile["comment_contains"] = self._split_env_list(comment_contains_env)

        comment_excludes_env = os.getenv("EA_COMMENT_EXCLUDES")
        if comment_excludes_env is not None:
            profile["comment_excludes"] = self._split_env_list(comment_excludes_env)

        if not profile:
            return False, "未设置环境变量配置"

        return self.apply_profile(profile, source=self.profile_path)

    def is_tracked_position(self, pos, ea_cfg: dict | None = None) -> bool:
        # 0.3.119: 如传 ea_cfg（per-EA 监控配置 from .easydeal-ea-monitor.json），
        # 用 per-EA filter；不传则 fallback 到全局 self.* filter（老行为）
        symbols    = ea_cfg.get("symbols") if ea_cfg else self.symbols
        magic_nums = ea_cfg.get("magic_numbers") if ea_cfg else self.magic_numbers
        cc         = ea_cfg.get("comment_contains") if ea_cfg else self.comment_contains
        ce         = ea_cfg.get("comment_excludes") if ea_cfg else self.comment_excludes
        if symbols and pos.symbol not in symbols:
            return False
        if magic_nums:
            if pos.magic not in magic_nums:
                return False
        comment = (pos.comment or "").lower()
        if cc:
            if not any(token.lower() in comment for token in cc):
                return False
        if ce:
            if any(token.lower() in comment for token in ce):
                return False
        return True

    def is_tracked_deal(self, deal, ea_cfg: dict | None = None) -> bool:
        # 0.3.119: 同 is_tracked_position 注释 — 加 ea_cfg 参数支持 per-EA filter
        symbols    = ea_cfg.get("symbols") if ea_cfg else self.symbols
        magic_nums = ea_cfg.get("magic_numbers") if ea_cfg else self.magic_numbers
        cc         = ea_cfg.get("comment_contains") if ea_cfg else self.comment_contains
        ce         = ea_cfg.get("comment_excludes") if ea_cfg else self.comment_excludes
        # 0.3.150: symbol 比较宽容化 — 去 broker 后缀 (m/c/p/z/. 等) 再比对.
        # 用户 case 暴露: monitor_config 填 "XAUUSDm" 但 broker 实际 deal.symbol="XAUUSD",
        # 严格相等比对 filter 掉所有 deal → get_profit_history 返 0.
        if symbols and not _symbol_match_any(deal.symbol, symbols):
            return False
        if magic_nums:
            if deal.magic not in magic_nums:
                return False
        comment = (deal.comment or "").lower()
        if cc:
            if not any(token.lower() in comment for token in cc):
                return False
        if ce:
            if any(token.lower() in comment for token in ce):
                return False
        return True

    def _get_tracked_positions(self):
        if self.symbols and len(self.symbols) == 1:
            positions = mt5.positions_get(symbol=self.symbols[0])
        else:
            positions = mt5.positions_get()
        if positions is None:
            return None
        return [pos for pos in positions if self.is_tracked_position(pos)]

    def get_status(self):
        """获取交易状态数据"""
        # 0.3.335: 多 MT5 切实例时, self.symbol 是 active strategy 的 (跟 user active
        # EA 绑死). SDK 已经切到别的 instance, 但 self.symbol 还是 active 的, 不对.
        # 优先从 mounted-state.json 查当前 SDK 连的 install_dir 上挂的 EA 的 symbol.
        # 例: EasyDeal MT5 3 挂 SimpleBTC + monitor_config.symbols=[XAUUSD] (无后缀,
        # MetaQuotes-Demo broker), self.symbol=XAUUSDm (active=GMarket on Exness)
        # → mounted-state.json[install_dir mt5_3].symbol=XAUUSD → 用这个.
        # 这比 _pick_chartable_symbol fuzzy match 更准 — 直接拿用户挂载时确定的 symbol.
        effective_symbol = self.symbol
        try:
            _ti = mt5.terminal_info()
            if _ti:
                _install_dir = getattr(_ti, "path", None)
                if _install_dir:
                    _mstate = _load_mounted_state(_install_dir)
                    if _mstate and _mstate.get("symbol"):
                        effective_symbol = _mstate["symbol"]
                        if effective_symbol != self.symbol:
                            logging.info(f"[get_status] override symbol: self.symbol={self.symbol} → mounted-state[{_install_dir}].symbol={effective_symbol}")
        except Exception as _e:
            logging.debug(f"[get_status] override symbol from mounted-state failed: {_e}")

        # 0.3.329: 不再 early return error 当 symbol_info=None.
        # 0.3.330: symbol_info=None 时 _pick_chartable_symbol fuzzy match fallback.
        # 0.3.335: 优先用 mounted-state.json 的 symbol (上面 effective_symbol), 不行再 fuzzy match.
        resolved_symbol = effective_symbol
        symbol_info = mt5.symbol_info(effective_symbol)
        if symbol_info is None:
            try:
                _picked, _cands = _pick_chartable_symbol([effective_symbol])
                if _picked:
                    resolved_symbol = _picked
                    symbol_info = mt5.symbol_info(resolved_symbol)
                    logging.info(f"[get_status] effective_symbol={effective_symbol} 在 broker 上没匹配, fuzzy match → {resolved_symbol}")
            except Exception as _e:
                logging.debug(f"[get_status] _pick_chartable_symbol fallback err: {_e}")

        # 获取账户和终端信息
        account_info = mt5.account_info()
        terminal_info = mt5.terminal_info()

        positions = self.refresh_position_state()
        buy_orders = []
        sell_orders = []

        # 0.3.120: 加载所有 EA 配置 — 给每条持仓打上 `_ea` 标签
        # 让 AI 能直接看出某条订单属于哪个 EA（哪怕没在 OrderGuard 注册）
        all_ea_configs = _load_all_ea_monitor_configs()

        def _decorate(pos):
            return {
                "ticket": pos.ticket,
                "volume": pos.volume,
                "price_open": pos.price_open,
                "price_current": pos.price_current,
                "profit": pos.profit,
                "comment": pos.comment,
                "symbol": pos.symbol,
                "magic": int(getattr(pos, "magic", 0) or 0),
                "time": pos.time,
                "sl": pos.sl,
                "tp": pos.tp,
                "side": "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL",
                "_ea": _match_ea_for_order(pos, all_ea_configs),
            }

        if positions:
            for pos in positions:
                order_info = _decorate(pos)
                if pos.type == mt5.ORDER_TYPE_BUY:
                    buy_orders.append(order_info)
                else:
                    sell_orders.append(order_info)

        buy_volume = sum(order["volume"] for order in buy_orders)
        sell_volume = sum(order["volume"] for order in sell_orders)
        total_profit = sum(pos.profit for pos in positions) if positions else 0

        # 0.3.120: 同时返「所有 MT5 持仓（不限 self.* 全局过滤）」+ 各自 _ea 标签
        # 这样 AI 能看到「未护航但属于某 EA」的订单 — 作者反馈：「没有添加护航的订单
        # 也应该由此可以推断出是属于那个 ea 了」
        all_positions = mt5.positions_get() or []
        tracked_tickets = {p.ticket for p in positions} if positions else set()
        positions_by_ea: dict = {}
        untracked_positions = []
        for pos in all_positions:
            info = _decorate(pos)
            ea_label = info["_ea"] or "_unknown"
            positions_by_ea.setdefault(ea_label, []).append(info)
            if pos.ticket not in tracked_tickets:
                untracked_positions.append(info)

        # 券商服务器时区: 探测偏移, 给 AI 一个明确的「券商交易时段时钟」+ 偏移小时数.
        # market_data.time 仍是真北京 now (_now_bj), server_time 是券商墙上时钟.
        _mkt_offset = _broker_offset_sec(resolved_symbol) if symbol_info else None
        _mkt_offset_hours = round(_mkt_offset / 3600.0, 1) if _mkt_offset is not None else None
        _mkt_server_time = None
        if symbol_info:
            try:
                _mkt_stick = mt5.symbol_info_tick(resolved_symbol)
                if _mkt_stick and getattr(_mkt_stick, "time", 0):
                    _mkt_server_time = datetime.fromtimestamp(int(_mkt_stick.time), tz=pytz.utc).strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass

        status = {
            # 0.3.134: 顶层 as_of —— 让 AI 一眼看到「这份数据是哪个时刻拍的」，汇报
            # 给用户时必须显式引用（如「截至 10:28:00 持有...」），避免 cron 推的
            # 报告被用户误解为「就是当下状态」（用户 case：报告说持有 -$28，5
            # 分钟后已平仓，用户觉得「统计错了」）。
            "as_of": _now_bj_str(),
            "account": {
                "login": account_info.login if account_info else 0,
                "balance": account_info.balance if account_info else 0,
                "equity": account_info.equity if account_info else 0,
                "leverage": account_info.leverage if account_info else 0,   # 1.2.13: app 账户卡显「杠杆」
                "margin_level": account_info.margin_level if account_info else 0,
                "currency": account_info.currency if account_info else "USD",
                # 0.3.328: account-level trade_allowed (跟 terminal.trade_allowed 是两回事:
                # terminal 是工具栏「算法交易」开关, account 是 broker server 给该账户的
                # trade 权限). 任一为 false 都不能交易 — AI 要看两个字段综合判断.
                "trade_allowed": account_info.trade_allowed if account_info else False,
            },
            "terminal": {
                "connected": terminal_info.connected if terminal_info else False,
                # ping_last 来自 MT5 Python API，单位是微秒；统一转成毫秒以匹配 MT5 界面显示
                "ping": int(terminal_info.ping_last / 1000) if terminal_info else -1,
                "trade_allowed": terminal_info.trade_allowed if terminal_info else False,
                # 0.3.328: 加 path 让 AI 看 SDK 当前连接的 MT5 install dir.
                # 多 MT5 场景下 trade_allowed=False 可能是 SDK cache 错实例,
                # 用 path 跟用户当前操作的 MT5 install_dir 对比即可发现.
                "path": getattr(terminal_info, "path", None) if terminal_info else None,
            },
            "market_data": ({
                # 0.3.330: 用 resolved_symbol 而非 self.symbol — 当 fuzzy match
                # 后用的是 broker 实际有的 symbol (如 XAUUSD 替代 XAUUSDm), AI 能
                # 看出 EasyDeal 已经做过 symbol mapping.
                "symbol": resolved_symbol,
                "original_symbol": self.symbol if resolved_symbol != self.symbol else None,
                "bid": symbol_info.bid,
                "ask": symbol_info.ask,
                "spread": symbol_info.spread,
                "time": _now_bj_str(),
                "server_time": _mkt_server_time,
                "broker_offset_hours": _mkt_offset_hours,
            } if symbol_info else {
                # 0.3.329: symbol_info=None (broker 没此 symbol + fuzzy match 也没找到)
                "symbol": self.symbol,
                "unavailable": True,
                "hint": f"当前 broker 上没找到 {self.symbol} 这个 symbol (即使 fuzzy match 也没匹配到). 其他字段 (账户/持仓/最近活跃度) 仍可信."
            }),
            "strategy_state": {
                "running": self.running,
                "is_open_position": self.is_open_position
            },
            "orders": {
                "buy_orders": buy_orders,
                "sell_orders": sell_orders,
                "summary": {
                    "positions_total": len(buy_orders) + len(sell_orders),
                    "buy_count": len(buy_orders),
                    "sell_count": len(sell_orders),
                    "buy_volume": buy_volume,
                    "sell_volume": sell_volume,
                    "net_volume": buy_volume - sell_volume
                },
                "total_profit": total_profit,
                # 0.3.120: 额外字段 — 全部持仓按 EA 分组 + 未护航持仓单独列出
                # AI 用这两个字段判断「哪些订单虽未在 OrderGuard 但属于已配置的 EA」
                "all_positions_by_ea": positions_by_ea,
                "untracked_positions": untracked_positions,
                "untracked_count":     len(untracked_positions),
                # 0.4.41 防御: 过滤掉 strategies/<EA>.mq5 已被删的 EA — MCP 端 ea_configs
                # cache 不会主动失效 (重启才清), 用户从客户端 UI 删 EA 后这 list 还会带着
                # ghost EA → AI tool_result 看到以为还挂着. 这里实时 file-existence check
                # 兜底, 跟 Electron 主进程的 cascade-delete + mt5-instances:list 抹掉 mount_*
                # 字段配套. workspace 路径拿不到 (env 没设) 时不过滤, 防止全清.
                "ea_configs_loaded":   (lambda: (
                    [_n for _n in all_ea_configs.keys()
                     if (not os.getenv("EASYDEAL_WORKSPACE_DIR"))
                        or os.path.isfile(os.path.join(os.getenv("EASYDEAL_WORKSPACE_DIR"), "strategies", f"{_n}.mq5"))]
                ))(),
            }
        }

        # 0.3.328: 加 recent_activity 字段 — 最近 5 分钟 broker 端确认的 deal 数.
        # 用来交叉验证 trade_allowed 字段是否可信. 如果 trade_allowed=False 但
        # recent_activity > 0, 说明 SDK 字段值跟实际状态不一致 (cache stale /
        # SDK 连错实例 / MT5 build 5836 字段语义变了等), AI 应该按 recent_activity
        # 实际状况判断, 不要相信 trade_allowed=False.
        import datetime as _dt
        try:
            _now = _dt.datetime.now()
            _5min_ago = _now - _dt.timedelta(minutes=5)
            _recent_deals = mt5.history_deals_get(_5min_ago, _now)
            _recent_count = len(_recent_deals) if _recent_deals else 0
        except Exception as _e:
            _recent_count = -1
            logging.debug(f"[get_status] history_deals_get failed: {_e}")

        status["recent_activity"] = {
            "deals_last_5min": _recent_count,
            "hint": (
                "deals_last_5min > 0 表示 broker 端确认了 EA 触发的 trade, "
                "即使 terminal.trade_allowed=False 也可信 EA 实际在交易 — "
                "SDK 字段在多实例 / build 5836 场景下可能 cache 错或语义变."
            ),
        }

        # 0.3.328: 顶层 trade_allowed_consistency hint — AI 一眼看出字段是否可信.
        _term_allow = bool(terminal_info.trade_allowed) if terminal_info else False
        _acct_allow = bool(account_info.trade_allowed) if account_info else False
        _has_recent = _recent_count > 0
        if _term_allow != _acct_allow or (not _term_allow and _has_recent):
            status["trade_allowed_consistency"] = {
                "consistent": False,
                "terminal": _term_allow,
                "account": _acct_allow,
                "recent_activity": _has_recent,
                "hint": (
                    f"⚠ trade_allowed 字段不一致 (terminal={_term_allow}, account={_acct_allow}, "
                    f"recent_5min_deals={_recent_count}). 不要直接相信 terminal.trade_allowed=False, "
                    "按 recent_activity 实际状况判断 — 如果有最近 deals, EA 实际在交易, "
                    "字段值不可信, 不要告诉用户「算法交易关闭」误导."
                ),
            }
        else:
            status["trade_allowed_consistency"] = {"consistent": True}

        return status

    def refresh_position_state(self):
        """刷新持仓状态（仅用于监控与展示）"""
        positions = self._get_tracked_positions()
        if positions is None:
            logging.error("无法获取持仓信息")
            self.is_open_position = False
            return []

        self.is_open_position = bool(positions)
        return positions

    def close_all_orders(self):
        """平掉所有订单"""
        positions = self._get_tracked_positions()
        if positions is None:
            return {"error": "无法获取持仓信息"}

        success = True
        error_messages = []

        for pos in positions:
            order_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
            price = mt5.symbol_info(pos.symbol).bid if order_type == mt5.ORDER_TYPE_SELL else mt5.symbol_info(pos.symbol).ask

            result = mt5.order_send({
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": pos.symbol,
                "volume": pos.volume,
                "type": order_type,
                "position": pos.ticket,
                "price": price,
                "magic": pos.magic,
                "comment": "Close all",
                "type_filling": mt5.ORDER_FILLING_IOC
            })

            if result.retcode != mt5.TRADE_RETCODE_DONE:
                success = False
                error_messages.append(f"订单 #{pos.ticket} 平仓失败: {result.retcode}")

        if success:
            self.is_open_position = False
            return {"message": "所有订单已平仓"}
        else:
            return {"error": "部分订单平仓失败", "details": error_messages}

    def get_profit_history(self, start_time=None, end_time=None, magic_filter=None, ea_name=None):
        """获取指定时间段的收益历史。
        0.3.97: magic_filter 可选 — list of int，限定到这些 magic 的 deal；
        不传 / 空 = 拿所有 magic 的 deal（之前 hardcode self.magic_numbers=[999] 把
        所有真实 EA 的 deal filter 掉，用户 / 截图里 magic=107094107 用户都撞过）。
        0.3.119: ea_name 可选 — 给了就从客户端 .easydeal-ea-monitor.json 读 per-EA
        监控配置（symbols + magic + comment 过滤器），按 EA 精准过滤；同时显式
        magic_filter 优先级最高（覆盖 per-EA 的 magic）。AI 现在能直接传 ea_name
        而不用记 magic。
        0.3.290: history_deals_get 返 None 时 retry 一次 + 详细 last_error code 反馈
        (用户 0.3.284 多实例反复撞 profit_history 报错, 但具体 last_error code
        看不到; 加 retry 抵抗 rebind race condition + 返 error code 给 AI 调试)。"""
        try:
            if start_time:
                start_dt = datetime.strptime(start_time, "%Y-%m-%d %H:%M:%S")
            else:
                start_dt = datetime(1970, 1, 1)

            if end_time:
                end_dt = datetime.strptime(end_time, "%Y-%m-%d %H:%M:%S")
            else:
                end_dt = datetime.now()

            timezone = pytz.timezone("Etc/UTC")
            start_dt = timezone.localize(start_dt)
            end_dt = timezone.localize(end_dt)

            # 0.3.290: history_deals_get 偶发返 None (SDK 刚 rebind 完 / broker 短暂断
            # 连等). 重试 1 次, 间隔 200ms — 大部分 race condition 这一下就过去了.
            deals = mt5.history_deals_get(start_dt, end_dt)
            if deals is None:
                err1 = mt5.last_error()
                logging.warning(f"[get_profit_history] history_deals_get returned None first try, retry. last_error={err1}")
                import time as _time
                _time.sleep(0.2)
                deals = mt5.history_deals_get(start_dt, end_dt)

            if deals is None:
                error = mt5.last_error()
                # 0.3.290: 返 error code + 时间窗口 + 实例 path 给 AI / 用户调试
                ti = None
                try: ti = mt5.terminal_info()
                except Exception: pass
                return {
                    "error": f"无法获取历史成交: code={error}",
                    "error_code": error,
                    "period": {"start": start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                               "end": end_dt.strftime("%Y-%m-%d %H:%M:%S")},
                    "terminal_path": (ti.path if ti else None),
                    "hint": "如果 error_code=(-10005,)... 表示 history not synced; 重启该 MT5 实例或等几秒重试.",
                }

            # 0.3.119: 优先级 — magic_filter > ea_name > 全局
            #   magic_filter 显式 → 用它（AI 已知具体 magic）
            #   ea_name 给 → 从 .easydeal-ea-monitor.json 读 per-EA cfg，按 cfg 过滤
            #   都没 → fallback 全局 self.is_tracked_deal
            if magic_filter:
                magic_set = set(int(m) for m in magic_filter)
                strategy_deals = [d for d in deals if int(d.magic or 0) in magic_set]
            elif ea_name:
                ea_cfg = _load_ea_monitor_config(ea_name)
                if ea_cfg:
                    strategy_deals = [d for d in deals if self.is_tracked_deal(d, ea_cfg)]
                else:
                    # ea_name 给了但本机没存 per-EA 配置 → fallback 全局
                    strategy_deals = [deal for deal in deals if self.is_tracked_deal(deal)]
            else:
                strategy_deals = [deal for deal in deals if self.is_tracked_deal(deal)]

            total_profit = sum(deal.profit for deal in strategy_deals)
            total_volume = sum(deal.volume for deal in strategy_deals)
            deal_count = len(strategy_deals)

            profit_deals = [deal for deal in strategy_deals if deal.profit > 0]
            loss_deals = [deal for deal in strategy_deals if deal.profit < 0]

            profit_factor = abs(sum(deal.profit for deal in profit_deals)) / abs(sum(deal.profit for deal in loss_deals)) if loss_deals else float('inf')

            hourly_profits = {}
            for deal in strategy_deals:
                # 把 MT5 deal.time（unix 秒）按北京时间分桶到小时；
                # 用户在「3 点的盈亏」里看到的「3 点」就是北京时间的 3 点。
                hour = _ts_to_bj_str(deal.time, "%Y-%m-%d %H:00:00")
                if hour not in hourly_profits:
                    hourly_profits[hour] = 0
                hourly_profits[hour] += deal.profit

            result = {
                "summary": {
                    "total_profit": total_profit,
                    "total_volume": total_volume,
                    "deal_count": deal_count,
                    "profit_deals": len(profit_deals),
                    "loss_deals": len(loss_deals),
                    "profit_factor": profit_factor,
                    "average_profit": total_profit / deal_count if deal_count > 0 else 0
                },
                "period": {
                    "start": start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    "end": end_dt.strftime("%Y-%m-%d %H:%M:%S")
                },
                "hourly_profits": [{"time": k, "profit": v} for k, v in hourly_profits.items()],
                "deals": [{
                    "ticket": deal.ticket,
                    "time": _ts_to_bj_str(deal.time),
                    "type": "BUY" if deal.type == mt5.DEAL_TYPE_BUY else "SELL",
                    "volume": deal.volume,
                    "price": deal.price,
                    "profit": deal.profit,
                    "comment": deal.comment
                } for deal in strategy_deals]
            }

            return result

        except Exception as e:
            return {"error": f"分析失败: {str(e)}"}

    def infer_strategy(self, days: int = 7, max_deals: int = 1000, hedge_window_sec: int = 5) -> dict:
        """Infer likely EA behavior from observed trades (heuristic)."""
        try:
            if days <= 0:
                days = 7
            if max_deals <= 0:
                max_deals = 1000
            end_dt = datetime.now()
            start_dt = end_dt - timedelta(days=days)

            timezone = pytz.timezone("Etc/UTC")
            start_dt = timezone.localize(start_dt)
            end_dt = timezone.localize(end_dt)

            deals = mt5.history_deals_get(start_dt, end_dt)
            if deals is None:
                error = mt5.last_error()
                return {"error": f"unable to get deal history: {error}"}

            tracked_deals = [deal for deal in deals if self.is_tracked_deal(deal)]
            if not tracked_deals:
                return {
                    "window": {
                        "start": start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                        "end": end_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    },
                    "metrics": {"deal_count": 0},
                    "hypotheses": [],
                    "notes": "no tracked deals"
                }

            entries = []
            for deal in tracked_deals:
                entry_flag = getattr(deal, "entry", None)
                if entry_flag is None or entry_flag == mt5.DEAL_ENTRY_IN:
                    entries.append(deal)

            if not entries:
                return {
                    "window": {
                        "start": start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                        "end": end_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    },
                    "metrics": {"deal_count": len(tracked_deals), "entry_count": 0},
                    "hypotheses": [],
                    "notes": "no entry deals"
                }

            entries.sort(key=lambda d: getattr(d, "time_msc", d.time))
            if len(entries) > max_deals:
                entries = entries[-max_deals:]

            buy_entries = [d for d in entries if d.type == mt5.DEAL_TYPE_BUY]
            sell_entries = [d for d in entries if d.type == mt5.DEAL_TYPE_SELL]

            # Hedging detection: opposite-direction entries within a short window.
            hedge_pairs = 0
            used = set()
            for i, deal in enumerate(entries):
                if deal.ticket in used:
                    continue
                t0 = getattr(deal, "time_msc", deal.time)
                for j in range(i + 1, len(entries)):
                    other = entries[j]
                    t1 = getattr(other, "time_msc", other.time)
                    dt = (t1 - t0) / 1000.0 if isinstance(t1, int) and isinstance(t0, int) and t1 > 1e12 else (t1 - t0)
                    if dt > hedge_window_sec:
                        break
                    if deal.type == other.type:
                        continue
                    vol_diff = abs(deal.volume - other.volume)
                    vol_tol = max(deal.volume, other.volume) * 0.1
                    if vol_diff <= vol_tol:
                        hedge_pairs += 1
                        used.add(deal.ticket)
                        used.add(other.ticket)
                        break

            hedge_ratio = (hedge_pairs * 2) / len(entries) if entries else 0

            def build_sequences(direction_entries, gap_minutes: int = 60):
                seqs = []
                current = []
                gap_sec = gap_minutes * 60
                for deal in sorted(direction_entries, key=lambda d: getattr(d, "time_msc", d.time)):
                    if not current:
                        current = [deal]
                        continue
                    prev = current[-1]
                    t_prev = getattr(prev, "time", None)
                    t_curr = getattr(deal, "time", None)
                    if isinstance(t_prev, int):
                        t_prev = datetime.fromtimestamp(t_prev)
                    if isinstance(t_curr, int):
                        t_curr = datetime.fromtimestamp(t_curr)
                    if t_prev and t_curr and (t_curr - t_prev).total_seconds() <= gap_sec:
                        current.append(deal)
                    else:
                        seqs.append(current)
                        current = [deal]
                if current:
                    seqs.append(current)
                return seqs

            def safe_median(values):
                try:
                    return statistics.median(values)
                except statistics.StatisticsError:
                    return None

            def safe_mean(values):
                if not values:
                    return None
                return sum(values) / len(values)

            def safe_pstdev(values):
                if len(values) < 2:
                    return 0.0
                try:
                    return statistics.pstdev(values)
                except statistics.StatisticsError:
                    return 0.0

            sequences = build_sequences(entries)
            grid_spacings = []
            grid_seq_count = 0
            for seq in sequences:
                if len(seq) < 3:
                    continue
                prices = [d.price for d in seq]
                spacings = [abs(prices[i] - prices[i - 1]) for i in range(1, len(prices)) if prices[i] and prices[i - 1]]
                if len(spacings) < 2:
                    continue
                mean_spacing = safe_mean(spacings)
                if not mean_spacing or mean_spacing == 0:
                    continue
                cv = safe_pstdev(spacings) / mean_spacing
                if cv <= 0.3:
                    grid_seq_count += 1
                    grid_spacings.extend(spacings)

            grid_spacing_median = safe_median(grid_spacings) or 0
            grid_like_ratio = grid_seq_count / len(sequences) if sequences else 0

            # Martingale detection: size increases on adverse moves.
            martin_seq_count = 0
            martin_ratios = []
            for seq in sequences:
                if len(seq) < 2:
                    continue
                ratios = []
                adverse = 0
                for i in range(1, len(seq)):
                    prev = seq[i - 1]
                    curr = seq[i]
                    if prev.volume > 0:
                        ratios.append(curr.volume / prev.volume)
                    if prev.type == mt5.DEAL_TYPE_BUY and curr.price < prev.price:
                        adverse += 1
                    if prev.type == mt5.DEAL_TYPE_SELL and curr.price > prev.price:
                        adverse += 1
                if ratios:
                    median_ratio = safe_median(ratios) or 0
                    adverse_ratio = adverse / len(ratios)
                    if median_ratio >= 1.5 and adverse_ratio >= 0.6:
                        martin_seq_count += 1
                        martin_ratios.append(median_ratio)

            martin_ratio_median = safe_median(martin_ratios) or 0
            martin_like_ratio = martin_seq_count / len(sequences) if sequences else 0

            # Holding time inference
            pos_map = {}
            for deal in tracked_deals:
                pos_id = getattr(deal, "position_id", None)
                if pos_id is None:
                    continue
                entry_flag = getattr(deal, "entry", None)
                t = deal.time
                if isinstance(t, int):
                    t = datetime.fromtimestamp(t)
                if pos_id not in pos_map:
                    pos_map[pos_id] = {"entry": None, "exit": None}
                if entry_flag == mt5.DEAL_ENTRY_IN:
                    if pos_map[pos_id]["entry"] is None or t < pos_map[pos_id]["entry"]:
                        pos_map[pos_id]["entry"] = t
                elif entry_flag == mt5.DEAL_ENTRY_OUT:
                    if pos_map[pos_id]["exit"] is None or t > pos_map[pos_id]["exit"]:
                        pos_map[pos_id]["exit"] = t

            hold_seconds = []
            for item in pos_map.values():
                if item["entry"] and item["exit"]:
                    hold_seconds.append((item["exit"] - item["entry"]).total_seconds())

            median_hold = safe_median(hold_seconds) or 0

            # Time-of-day concentration
            hour_counts = {}
            _off_hc = _broker_offset_sec()   # 时段集中度按真北京小时(之前裸 fromtimestamp 偏一个券商 offset)
            for deal in entries:
                t = deal.time
                if isinstance(t, int):
                    t = (datetime.fromtimestamp(t - _off_hc, tz=BJ_TZ) if _off_hc is not None
                         else datetime.fromtimestamp(t, tz=pytz.utc))
                hour = t.hour
                hour_counts[hour] = hour_counts.get(hour, 0) + 1
            top_hours = sorted(hour_counts.items(), key=lambda x: x[1], reverse=True)[:3]
            top_hour_ratio = (sum(c for _, c in top_hours) / len(entries)) if entries else 0

            hypotheses = []
            if hedge_ratio >= 0.3:
                hypotheses.append({
                    "name": "hedged_entries",
                    "confidence": round(min(1.0, hedge_ratio / 0.6), 2),
                    "evidence": [f"{hedge_pairs} paired entries within {hedge_window_sec}s", f"hedge_ratio={hedge_ratio:.2f}"]
                })

            if grid_like_ratio >= 0.3 and grid_spacing_median > 0:
                hypotheses.append({
                    "name": "grid_like_spacing",
                    "confidence": round(min(1.0, grid_like_ratio / 0.6), 2),
                    "evidence": [f"grid_sequences={grid_seq_count}/{len(sequences)}", f"median_spacing={grid_spacing_median:.5f}"]
                })

            if martin_like_ratio >= 0.2 and martin_ratio_median > 0:
                hypotheses.append({
                    "name": "martingale_like_sizing",
                    "confidence": round(min(1.0, martin_like_ratio / 0.5), 2),
                    "evidence": [f"martin_sequences={martin_seq_count}/{len(sequences)}", f"median_ratio={martin_ratio_median:.2f}"]
                })

            if median_hold > 0 and median_hold <= 300:
                hypotheses.append({
                    "name": "scalping_like_holds",
                    "confidence": 0.4,
                    "evidence": [f"median_hold_seconds={int(median_hold)}"]
                })

            if top_hour_ratio >= 0.6 and top_hours:
                hours = ", ".join(str(h) for h, _ in top_hours)
                hypotheses.append({
                    "name": "time_window_bias",
                    "confidence": round(min(1.0, top_hour_ratio / 0.8), 2),
                    "evidence": [f"top_hours={hours}", f"top_hour_ratio={top_hour_ratio:.2f}"]
                })

            next_hints = []
            if grid_spacing_median > 0:
                positions = self._get_tracked_positions() or []
                if positions:
                    latest_buy = None
                    latest_sell = None
                    for pos in positions:
                        t = pos.time
                        if isinstance(t, int):
                            t = datetime.fromtimestamp(t)
                        if pos.type == mt5.ORDER_TYPE_BUY:
                            if latest_buy is None or t > latest_buy["time"]:
                                latest_buy = {"time": t, "price": pos.price_open, "volume": pos.volume}
                        else:
                            if latest_sell is None or t > latest_sell["time"]:
                                latest_sell = {"time": t, "price": pos.price_open, "volume": pos.volume}

                    if latest_buy:
                        next_hints.append({
                            "type": "BUY",
                            "trigger_price": round(latest_buy["price"] - grid_spacing_median, 5),
                            "note": "grid-like spacing inference",
                            "confidence": 0.3
                        })
                    if latest_sell:
                        next_hints.append({
                            "type": "SELL",
                            "trigger_price": round(latest_sell["price"] + grid_spacing_median, 5),
                            "note": "grid-like spacing inference",
                            "confidence": 0.3
                        })

            return {
                "window": {
                    "start": start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    "end": end_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    "days": days
                },
                "metrics": {
                    "deal_count": len(tracked_deals),
                    "entry_count": len(entries),
                    "buy_entries": len(buy_entries),
                    "sell_entries": len(sell_entries),
                    "hedge_ratio": round(hedge_ratio, 3),
                    "grid_spacing_median": grid_spacing_median,
                    "martin_ratio_median": martin_ratio_median,
                    "median_hold_seconds": int(median_hold) if median_hold else 0,
                    "top_hour_ratio": round(top_hour_ratio, 3)
                },
                "hypotheses": hypotheses,
                "next_action_hints": next_hints
            }

        except Exception as e:
            return {"error": f"inference failed: {e}"}

    def get_market_info(self):
        """获取当前行情信息字符串"""
        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info:
            return f"[{self.symbol} Bid:{symbol_info.bid:.5f} Ask:{symbol_info.ask:.5f}]"
        return ""

# ============== 监控服务类 ==============

class TradingMonitor:
    """交易监控器"""

    def __init__(self, strategy):
        self.strategy = strategy
        self.callbacks = []
        self.last_alert_time = {}
        self.alert_cooldown = 300

        self.config = {
            "loss_warning_pct": 30,
            "loss_danger_pct": 50,
            "loss_critical_pct": 70,
            "risk_check_interval": 60,
            "status_check_interval": 30,
        }
        self.indicator_config = {
            "timeframe": mt5.TIMEFRAME_H1,
            "atr_period": 14,
            "atr_pct_threshold": 1.5,
            "boll_period": 20,
            "boll_deviation_threshold": 2.0,
            "rsi_period": 14,
            "rsi_overbought": 70,
            "rsi_oversold": 30,
            "macd_fast": 12,
            "macd_slow": 26,
            "macd_signal": 9
        }

        self.last_status = None

        # 新增追踪变量
        self.last_orders_map = {}  # ticket -> order_info
        self.orders_map_primed = False  # 首次快照前不触发 order_change 预警
        self.last_terminal_connected = True
        self.last_equity_log_time = 0
        self.equity_log_interval = 3600  # 每小时记录一次资金快照
        self.is_in_error_state = False
        self.last_indicator_state = {
            "atr_high": False,
            "boll_high": False,
            "rsi_overbought": False,
            "rsi_oversold": False,
            "macd_state": "neutral"
        }

    def add_callback(self, callback: Callable):
        """添加回调函数"""
        self.callbacks.append(callback)

    def notify(self, event_type: str, level: str, message: str, data: dict = None, alert_key: str = None):
        """发送通知"""
        alert_key = alert_key or f"{event_type}:{level}"
        now = time.time()
        if alert_key in self.last_alert_time:
            if now - self.last_alert_time[alert_key] < self.alert_cooldown:
                return

        self.last_alert_time[alert_key] = now

        event = {
            "timestamp": _now_bj().isoformat(),
            "event_type": event_type,
            "level": level,
            "message": message,
            "data": data or {},
            "alert_key": alert_key,
        }

        monitor_logger.log(
            logging.CRITICAL if level == "critical" else
            logging.WARNING if level in ["warning", "danger"] else
            logging.INFO,
            f"[{level.upper()}] {event_type}: {message}"
        )

        for callback in self.callbacks:
            try:
                callback(event)
            except Exception as e:
                monitor_logger.error(f"回调执行失败: {e}")

    def check_risk(self) -> dict:
        """检查风险状况"""
        status = self.strategy.get_status()
        config = self.strategy.get_config_info()

        total_profit = status["orders"]["total_profit"]
        max_loss = config["parameters"]["max_loss"]

        alerts = []
        loss_pct = abs(total_profit) / max_loss * 100 if total_profit < 0 else 0

        if total_profit < 0:
            if loss_pct >= self.config["loss_critical_pct"]:
                self.notify("risk_loss", "critical",
                    f"浮亏已达 {loss_pct:.1f}%，接近止损线！",
                    {"loss": total_profit, "loss_pct": loss_pct})
                alerts.append("loss_critical")
            elif loss_pct >= self.config["loss_danger_pct"]:
                self.notify("risk_loss", "danger",
                    f"浮亏达到 {loss_pct:.1f}%，请注意风险",
                    {"loss": total_profit, "loss_pct": loss_pct})
                alerts.append("loss_danger")
            elif loss_pct >= self.config["loss_warning_pct"]:
                self.notify("risk_loss", "warning",
                    f"浮亏达到 {loss_pct:.1f}%",
                    {"loss": total_profit, "loss_pct": loss_pct})
                alerts.append("loss_warning")

        indicator_result = self.check_indicator_report()
        if indicator_result.get("alerts"):
            alerts.extend(indicator_result["alerts"])

        return {
            "total_profit": total_profit,
            "loss_pct": loss_pct,
            "alerts": alerts,
            "indicator_report": indicator_result
        }

    def _capture_market_snapshot(self) -> str:
        """捕获当前市场快照（价格与点差）"""
        try:
            info = mt5.symbol_info(self.strategy.symbol)
            if not info:
                return "[无法获取行情]"
            return f"[{self.strategy.symbol} Bid:{info.bid:.5f} Ask:{info.ask:.5f} Spread:{info.spread}]"
        except Exception as e:
            return f"[快照计算错误: {e}]"

    def _order_change_summary(self, previous: dict, current: dict) -> list[str]:
        changes = []

        def is_diff(a, b):
            if a is None and b is None:
                return False
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                return abs(a - b) > 1e-8
            return a != b

        def fmt(value):
            if isinstance(value, float):
                return f"{value:.5f}"
            return str(value)

        for field in ("volume", "price_open", "sl", "tp", "comment"):
            if is_diff(previous.get(field), current.get(field)):
                changes.append(f"{field}: {fmt(previous.get(field))} -> {fmt(current.get(field))}")

        return changes

    def _get_mid_price(self):
        tick = mt5.symbol_info_tick(self.strategy.symbol)
        if tick is None:
            return None
        bid = getattr(tick, "bid", 0.0)
        ask = getattr(tick, "ask", 0.0)
        if bid and ask:
            return (bid + ask) / 2.0
        last = getattr(tick, "last", 0.0)
        return last or None

    def _get_rates(self, timeframe, count):
        rates = mt5.copy_rates_from_pos(self.strategy.symbol, timeframe, 0, count)
        if rates is None or len(rates) < count:
            return None
        return rates

    def _calc_atr_pct(self, period=14, timeframe=mt5.TIMEFRAME_H1):
        rates = self._get_rates(timeframe, period + 1)
        if rates is None:
            return None
        tr_values = []
        for i in range(1, len(rates)):
            high = rates[i]["high"]
            low = rates[i]["low"]
            prev_close = rates[i - 1]["close"]
            tr_values.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
        if not tr_values:
            return None
        atr = sum(tr_values) / len(tr_values)
        price = self._get_mid_price() or rates[-1]["close"]
        if not price:
            return None
        return atr / price * 100

    def _calc_boll_deviation(self, period=20, timeframe=mt5.TIMEFRAME_H1):
        rates = self._get_rates(timeframe, period)
        if rates is None:
            return None
        closes = [rate["close"] for rate in rates]
        if len(closes) < 2:
            return None
        middle = sum(closes) / len(closes)
        std = statistics.pstdev(closes)
        if std <= 0:
            return None
        price = self._get_mid_price() or closes[-1]
        if not price:
            return None
        return abs(price - middle) / std

    def _calc_rsi(self, period=14, timeframe=mt5.TIMEFRAME_H1):
        rates = self._get_rates(timeframe, period + 1)
        if rates is None:
            return None
        closes = [rate["close"] for rate in rates]
        if len(closes) < period + 1:
            return None
        gains = []
        losses = []
        for i in range(1, len(closes)):
            delta = closes[i] - closes[i - 1]
            if delta >= 0:
                gains.append(delta)
                losses.append(0)
            else:
                gains.append(0)
                losses.append(-delta)
        avg_gain = sum(gains[-period:]) / period
        avg_loss = sum(losses[-period:]) / period
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return 100 - (100 / (1 + rs))

    def _calc_ema_series(self, values, period):
        if not values or period <= 0 or len(values) < period:
            return None
        k = 2 / (period + 1)
        ema_values = []
        ema = sum(values[:period]) / period
        ema_values.extend([None] * (period - 1))
        ema_values.append(ema)
        for value in values[period:]:
            ema = (value - ema) * k + ema
            ema_values.append(ema)
        return ema_values

    def _calc_macd(self, fast=12, slow=26, signal=9, timeframe=mt5.TIMEFRAME_H1):
        bars_needed = slow + signal + 5
        rates = self._get_rates(timeframe, bars_needed)
        if rates is None:
            return None
        closes = [rate["close"] for rate in rates]
        fast_ema = self._calc_ema_series(closes, fast)
        slow_ema = self._calc_ema_series(closes, slow)
        if fast_ema is None or slow_ema is None:
            return None
        macd_series = []
        for i in range(len(closes)):
            if fast_ema[i] is None or slow_ema[i] is None:
                macd_series.append(None)
            else:
                macd_series.append(fast_ema[i] - slow_ema[i])
        macd_values = [value for value in macd_series if value is not None]
        if len(macd_values) < signal + 2:
            return None
        signal_series = self._calc_ema_series(macd_values, signal)
        if signal_series is None or len(signal_series) < 2:
            return None
        current_macd = macd_values[-1]
        prev_macd = macd_values[-2]
        current_signal = signal_series[-1]
        prev_signal = signal_series[-2]
        hist = current_macd - current_signal
        return {
            "macd": current_macd,
            "signal": current_signal,
            "hist": hist,
            "prev_macd": prev_macd,
            "prev_signal": prev_signal
        }

    def check_indicator_report(self) -> dict:
        cfg = self.indicator_config
        timeframe = cfg["timeframe"]
        results = {"alerts": []}

        atr_pct = self._calc_atr_pct(cfg["atr_period"], timeframe)
        if atr_pct is not None:
            results["atr_pct"] = round(atr_pct, 4)
            results["atr_threshold"] = cfg["atr_pct_threshold"]
            if atr_pct > cfg["atr_pct_threshold"] and not self.last_indicator_state["atr_high"]:
                self.last_indicator_state["atr_high"] = True
            elif atr_pct <= cfg["atr_pct_threshold"]:
                self.last_indicator_state["atr_high"] = False

        boll_dev = self._calc_boll_deviation(cfg["boll_period"], timeframe)
        if boll_dev is not None:
            results["boll_dev"] = round(boll_dev, 4)
            results["boll_threshold"] = cfg["boll_deviation_threshold"]
            if boll_dev > cfg["boll_deviation_threshold"] and not self.last_indicator_state["boll_high"]:
                self.last_indicator_state["boll_high"] = True
            elif boll_dev <= cfg["boll_deviation_threshold"]:
                self.last_indicator_state["boll_high"] = False

        rsi_value = self._calc_rsi(cfg["rsi_period"], timeframe)
        if rsi_value is not None:
            results["rsi"] = round(rsi_value, 2)
            results["rsi_overbought"] = cfg["rsi_overbought"]
            results["rsi_oversold"] = cfg["rsi_oversold"]
            if rsi_value >= cfg["rsi_overbought"] and not self.last_indicator_state["rsi_overbought"]:
                self.last_indicator_state["rsi_overbought"] = True
                self.last_indicator_state["rsi_oversold"] = False
            elif rsi_value <= cfg["rsi_oversold"] and not self.last_indicator_state["rsi_oversold"]:
                self.last_indicator_state["rsi_oversold"] = True
                self.last_indicator_state["rsi_overbought"] = False
            else:
                if rsi_value < cfg["rsi_overbought"]:
                    self.last_indicator_state["rsi_overbought"] = False
                if rsi_value > cfg["rsi_oversold"]:
                    self.last_indicator_state["rsi_oversold"] = False

        macd_data = self._calc_macd(cfg["macd_fast"], cfg["macd_slow"], cfg["macd_signal"], timeframe)
        if macd_data is not None:
            results["macd"] = round(macd_data["macd"], 6)
            results["macd_signal"] = round(macd_data["signal"], 6)
            results["macd_hist"] = round(macd_data["hist"], 6)
            prev_macd = macd_data["prev_macd"]
            prev_signal = macd_data["prev_signal"]
            current_state = "bull" if macd_data["macd"] > macd_data["signal"] else "bear" if macd_data["macd"] < macd_data["signal"] else "neutral"
            if prev_macd <= prev_signal and macd_data["macd"] > macd_data["signal"]:
                self.last_indicator_state["macd_state"] = "bull"
            elif prev_macd >= prev_signal and macd_data["macd"] < macd_data["signal"]:
                self.last_indicator_state["macd_state"] = "bear"
            else:
                self.last_indicator_state["macd_state"] = current_state

        return results

    def check_status(self) -> dict:
        """检查策略状态（核心监控逻辑）"""
        status = self.strategy.get_status()
        alerts = []
        now = time.time()

        # 1. 错误处理与连接监控
        if "error" in status:
            error_msg = status["error"]
            if not self.is_in_error_state:
                monitor_logger.error(f"无法获取策略状态: {error_msg}")
                self.notify("status", "danger", f"监控异常: {error_msg}")
                self.is_in_error_state = True
            return {"error": error_msg}

        # 如果恢复正常，重置错误标志
        if self.is_in_error_state:
            monitor_logger.info("策略状态获取已恢复正常")
            self.is_in_error_state = False

        # 检查终端连接状态
        connected = status.get("terminal", {}).get("connected", False)
        if connected != self.last_terminal_connected:
            if connected:
                monitor_logger.info(f"MT5终端已重新连接 (Ping: {status['terminal']['ping']}ms)")
            else:
                monitor_logger.error("MT5终端已断开连接！")
                self.notify("connection", "critical", "MT5终端连接断开")
            self.last_terminal_connected = connected

        # 2. 资金健康度快照 (每小时)
        if now - self.last_equity_log_time >= self.equity_log_interval:
            acct = status.get("account", {})
            monitor_logger.info(
                f"[资金快照] Balance: {acct.get('balance', 0):.2f} | "
                f"Equity: {acct.get('equity', 0):.2f} | "
                f"Margin: {acct.get('margin_level', 0):.2f}%"
            )
            self.last_equity_log_time = now

        # 3. 订单变动精细追踪
        current_orders = {}
        for order in status["orders"]["buy_orders"] + status["orders"]["sell_orders"]:
            current_orders[order["ticket"]] = order

        current_tickets = set(current_orders.keys())
        last_tickets = set(self.last_orders_map.keys())

        # 首次检查：仅对齐缓存，避免把已存在的持仓误报为新开仓
        if not self.orders_map_primed:
            self.last_orders_map = current_orders
            self.last_status = status
            self.orders_map_primed = True
            monitor_logger.info(
                f"订单缓存初始化完成，当前持仓 {len(current_orders)} 笔，跳过首次 order_change 预警"
            )
            return {
                "positions": len(current_tickets),
                "profit": status["orders"]["total_profit"],
                "alerts": alerts,
            }

        # 检测新开仓
        new_tickets = current_tickets - last_tickets
        if new_tickets:
            # 只有当有新订单时，才去计算一次市场快照（节省资源）
            market_snapshot = self._capture_market_snapshot()
            for ticket in new_tickets:
                order = current_orders[ticket]
                order_type = "BUY" if order in status["orders"]["buy_orders"] else "SELL"
                comment = order.get("comment") or ""
                comment_part = f" comment={comment}" if comment else ""

                # 日志记录包含市场快照
                monitor_logger.info(
                    f"[OPEN] #{ticket} {order_type} {order['volume']} @ {order['price_open']}{comment_part} || {market_snapshot}"
                )
                self.notify(
                    "order_change",
                    "info",
                    f"OPEN #{ticket} {order_type} {order['volume']} @ {order['price_open']}",
                    {
                        "ticket": ticket,
                        "type": order_type,
                        "volume": order["volume"],
                        "price_open": order["price_open"],
                        "comment": comment,
                        "market": market_snapshot
                    },
                    alert_key=f"order_change:open:{ticket}"
                )


        # 检测平仓
        closed_tickets = last_tickets - current_tickets
        if closed_tickets:
            market_snapshot = self._capture_market_snapshot() # 平仓时也记录环境，分析止盈/止损逻辑
            for ticket in closed_tickets:
                last_order = self.last_orders_map[ticket]
                order_type = "BUY" if ticket in [o["ticket"] for o in self.last_status.get("orders", {}).get("buy_orders", [])] else "SELL"
                comment = last_order.get("comment") or ""
                comment_part = f" comment={comment}" if comment else ""
                monitor_logger.info(
                    f"[CLOSE] #{ticket} (原持仓: {last_order['volume']} {order_type} @ {last_order['price_open']}{comment_part}) || {market_snapshot}"
                )
                self.notify(
                    "order_change",
                    "info",
                    f"CLOSE #{ticket} {order_type} {last_order.get('volume')} @ {last_order.get('price_open')}",
                    {
                        "ticket": ticket,
                        "type": order_type,
                        "volume": last_order.get("volume"),
                        "price_open": last_order.get("price_open"),
                        "comment": comment,
                        "market": market_snapshot
                    },
                    alert_key=f"order_change:close:{ticket}"
                )


        updated_tickets = current_tickets & last_tickets
        updated_events = []
        for ticket in updated_tickets:
            previous = self.last_orders_map[ticket]
            current = current_orders[ticket]
            changes = self._order_change_summary(previous, current)
            if changes:
                updated_events.append((ticket, changes))

        if updated_events:
            market_snapshot = self._capture_market_snapshot()
            for ticket, changes in updated_events:
                current = current_orders[ticket]
                monitor_logger.info(
                    f"[UPDATE] #{ticket} " + "; ".join(changes) + f" || {market_snapshot}"
                )
                self.notify(
                    "order_change",
                    "info",
                    f"UPDATE #{ticket} " + "; ".join(changes),
                    {
                        "ticket": ticket,
                        "changes": changes,
                        "comment": current.get("comment"),
                        "market": market_snapshot
                    },
                    alert_key=f"order_change:update:{ticket}"
                )


        # 更新状态缓存
        self.last_orders_map = current_orders
        self.last_status = status

        return {
            "positions": len(current_tickets),
            "profit": status["orders"]["total_profit"],
            "alerts": alerts
        }

    def run(self):
        """启动监控循环"""
        monitor_logger.info("监控服务启动")

        last_risk_check = 0
        last_status_check = 0

        while True:
            now_ts = time.time()

            try:
                # 状态检查（最频繁）
                if now_ts - last_status_check >= self.config["status_check_interval"]:
                    self.check_status()
                    last_status_check = now_ts

                # 风险检查
                if now_ts - last_risk_check >= self.config["risk_check_interval"]:
                    self.check_risk()
                    last_risk_check = now_ts

            except Exception as e:
                monitor_logger.error(f"监控检查失败: {e}")

            time.sleep(10)


class FileCallback:
    """文件记录回调"""

    def __init__(self, filepath: str = "logs/monitor_events.jsonl"):
        self.filepath = filepath

    def __call__(self, event: dict):
        with open(self.filepath, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")


class AgentCallback:
    """Agent 终端回调

    - danger / critical → 透传给 Fay，触发对话回复
    - info / warning    → 记录为 Fay 观察记忆，不触发回复
    """

    # 需要透传（触发 Fay 回复）的级别
    PASSTHROUGH_LEVELS = {"danger", "critical"}

    def __init__(self, url: str = "http://127.0.0.1:5000/transparent-pass",
                 api_key: str = "YOUR_API_KEY",
                 model: str = "fay-streming",
                 role: str = "安监",
                 cooldown: int = 1800,
                 user: str = "User"):
        self.url = url
        self.api_key = api_key
        self.model = model
        self.role = role
        self.cooldown = cooldown
        self.user = user
        self.last_alert_time = {}
        # 从透传 URL 推导 Fay 基地址（用于观察记忆接口）
        self.fay_base_url = url.rsplit("/", 1)[0] if "/" in url else url

    def __call__(self, event: dict):
        # 优先使用 notify 传入的细粒度 alert_key（如 order_change:open:12345）
        alert_key = event.get("alert_key") or f"{event['event_type']}:{event['level']}"
        now = time.time()
        if alert_key in self.last_alert_time:
            if now - self.last_alert_time[alert_key] < self.cooldown:
                return
        self.last_alert_time[alert_key] = now

        level = event.get("level", "info")
        level_emoji = {"info": "ℹ️", "warning": "⚠️", "danger": "🚨", "critical": "🆘"}
        emoji = level_emoji.get(level, "📢")

        text = f"""{emoji} 交易预警通知

类型: {event['event_type']}
级别: {level.upper()}
时间: {event['timestamp']}
消息: {event['message']}
数据: {json.dumps(event.get('data', {}), ensure_ascii=False)}"""

        if level in self.PASSTHROUGH_LEVELS:
            self._send_passthrough(text)
        else:
            self._send_observation(text)

    def _send_passthrough(self, text: str):
        """重要告警 → 透传给 Fay，触发对话回复"""
        try:
            payload = {"user": self.user, "text": text}
            response = requests.post(self.url, json=payload, timeout=10)
            if response.status_code != 200:
                monitor_logger.error(f"Agent透传失败，状态码：{response.status_code}")
        except Exception as e:
            monitor_logger.error(f"Agent透传执行失败: {e}")

    def _send_observation(self, text: str):
        """一般告警 → 记录为 Fay 观察记忆，不触发回复"""
        try:
            obs_url = f"{self.fay_base_url}/api/send"
            payload = {
                "user": self.user,
                "content": text,
                "observation": text,
                "no_reply": True,
            }
            response = requests.post(obs_url, json=payload, timeout=10)
            if response.status_code != 200:
                monitor_logger.error(f"Agent观察记录失败，状态码：{response.status_code}")
            else:
                monitor_logger.info(f"告警已记录为观察记忆: {text[:80]}")
        except Exception as e:
            monitor_logger.error(f"Agent观察记录失败: {e}")


# ============== Flask API 路由 ==============

def log_request():
    """记录API请求的装饰器"""
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            api_logger.info(f"Request: {request.method} {request.url}")
            response = f(*args, **kwargs)
            return response
        return wrapped
    return decorator








class _BannerSuppressor:
    """包装 stdout，过滤 Werkzeug/Flask 启动横幅，避免污染 MCP stdio 通道。"""
    _BANNER_KEYWORDS = ("Serving Flask", "Debug mode", "Running on", "Restarting with", "Debugger is")

    def __init__(self, real):
        self._real = real

    def write(self, s):
        stripped = s.strip()
        if stripped.startswith("*") and any(kw in stripped for kw in self._BANNER_KEYWORDS):
            return len(s)
        return self._real.write(s)

    def flush(self):
        self._real.flush()

    def __getattr__(self, name):
        return getattr(self._real, name)


def run_flask():
    """运行Flask服务器（静默启动，避免污染 MCP stdio 通道）"""
    import sys
    werkzeug_log = logging.getLogger("werkzeug")
    werkzeug_log.setLevel(logging.WARNING)
    sys.stdout = _BannerSuppressor(sys.stdout)
    app.run(host='0.0.0.0', port=8888, debug=False, use_reloader=False)


# ============== 辅助函数 ==============

def get_file_content(file_path: str) -> str:
    """读取文件内容"""
    try:
        if not os.path.exists(file_path):
            return f"# 文件不存在: {file_path}"
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"# 无法读取文件: {str(e)}"


def get_strategy():
    """获取交易上下文实例"""
    global strategy_instance
    if strategy_instance is None:
        raise RuntimeError("交易上下文未初始化")
    return strategy_instance


# ---------------------------------------------------------------------------
# 设置热重载
#
# easydeal_settings_mcp_server 改 settings.json 后，这边在下一次工具调用前
# 通过 mtime 检测 reload —— Claude / 用户不用重启会话也不用重启客户端。
#
# 触发条件：EASYDEAL_SETTINGS_PATH 环境变量已注 + 文件 mtime 变了。
# 副作用：
#   1. monitor.symbols / magicNumbers / commentContains / commentExcludes
#      → 同步到 strategy_instance（self.symbols / self.magic_numbers / ...）
#   2. mt5.installDir 跟当前 SDK 绑的 install dir 不一致 →
#      mt5.shutdown() + 重新 initialize(path=新 .exe) + 重试绑定循环
# ---------------------------------------------------------------------------

_settings_path = os.getenv("EASYDEAL_SETTINGS_PATH")
_settings_last_mtime = 0.0


def _norm_install_dir(p) -> str:
    """terminal_info().path 是 install dir（无 .exe）；我们的 path 是 exe 全路径。
    比对前都剥成 install dir 形式，参考 mt5_probe.py / TradingContext.__init__。"""
    s = str(p or "").lower().replace("/", "\\")
    if s.endswith(".exe"):
        s = os.path.dirname(s)
    return s.rstrip("\\")


def _rebind_mt5(new_install_dir: str) -> bool:
    """对应 settings 改了 installDir 后调一次：mt5.shutdown() + initialize(path=新)
    + 6 次绑定校验。返回是否最终绑到了 new_install_dir。"""
    init_kwargs = {}
    for cand in ("terminal64.exe", "terminal.exe"):
        p = os.path.join(new_install_dir, cand)
        if os.path.isfile(p):
            init_kwargs["path"] = p
            break
    if "path" not in init_kwargs:
        logging.warning(f"[settings reload] {new_install_dir} 下没有 terminal64.exe / terminal.exe，跳过 rebind")
        return False
    # The process env always describes the default instance.  Resolve the
    # target's own dataDir/launchMode before lifecycle validation; otherwise a
    # perfectly valid secondary portable instance is checked against the
    # default data directory and every rebind fails closed.
    target_data_dir = None
    target_launch_mode = None
    try:
        instances, _active_id = _read_mt5_instances_from_settings()
    except Exception:
        instances = []
    for inst in instances:
        if _norm_install_dir(inst.get("installDir")) != _norm_install_dir(new_install_dir):
            continue
        target_data_dir = (inst.get("dataDir") or "").strip() or None
        target_launch_mode = (inst.get("launchMode") or "").strip().lower() or None
        break
    if target_data_dir is None:
        env_install = os.getenv("EASYDEAL_MT5_INSTALL_DIR", "")
        if _norm_install_dir(env_install) == _norm_install_dir(new_install_dir):
            target_data_dir = os.getenv("EASYDEAL_MT5_DATA_DIR", "").strip() or None
            target_launch_mode = (
                os.getenv("EASYDEAL_MT5_LAUNCH_MODE", "").strip().lower() or None
            )
    if target_launch_mode not in ("portable", "standard") and target_data_dir:
        target_launch_mode = (
            "portable"
            if _norm_install_dir(target_data_dir) == _norm_install_dir(new_install_dir)
            else "standard"
        )
    # 0.3.199: 新 install dir 下的 MT5 没在跑就不 rebind. 否则 SDK 会自动 launch
    # 用户没主动打开的 MT5 — 在「用户切活动实例但不想立刻开 MT5」场景下很烦人.
    if not _ezd_terminal_is_running(new_install_dir):
        logging.info(f"[settings reload] MT5 (install={new_install_dir}) 未运行 — 跳过 rebind, 等用户启动 MT5 后再生效")
        return False
    try:
        mt5.shutdown()
    except Exception:
        pass
    if not _mt5_init(
        **init_kwargs,
        data_dir=target_data_dir,
        launch_mode=target_launch_mode,
    ):
        logging.error(
            f"[settings reload] mt5.initialize 失败 path={init_kwargs['path']} "
            f"lifecycle={_mt5_lifecycle.LAST_ERROR} err={mt5.last_error()}"
        )
        return False
    expected = _norm_install_dir(init_kwargs["path"])
    import time as _time
    for attempt in range(6):
        try:
            ti = mt5.terminal_info()
            actual = ti.path if ti else None
        except Exception:
            actual = None
        if _norm_install_dir(actual) == expected:
            logging.info(f"[settings reload] MT5 已绑到 {new_install_dir}（attempt {attempt}）")
            return True
        if attempt < 5:
            try:
                mt5.shutdown()
            except Exception:
                pass
            _time.sleep(0.5)
            if not _mt5_init(
                **init_kwargs,
                data_dir=target_data_dir,
                launch_mode=target_launch_mode,
            ):
                logging.error(
                    f"[settings reload] retry init 失败: "
                    f"lifecycle={_mt5_lifecycle.LAST_ERROR} err={mt5.last_error()}"
                )
                return False
    logging.warning(
        f"[settings reload] 6 次重试后仍未绑到 {new_install_dir}（actual={actual}），"
        "保持 SDK 当前连接 —— 后续 symbol_info 失败时再让 Claude 引导处理"
    )
    return False


def _read_mt5_instances_from_settings() -> tuple[list[dict], str | None]:
    """0.3.235: 共用 helper — 读 settings.json 拿 mt5Instances 列表 + active_id.
    返回 ([] , None) 表示 settings 不可用 / 无实例配置 (老单 MT5 用户)."""
    if not _settings_path or not os.path.isfile(_settings_path):
        return [], None
    try:
        with open(_settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f) or {}
    except Exception as e:
        logging.warning(f"[read_mt5_instances] settings 读取失败: {e}")
        return [], None
    instances = settings.get("mt5Instances") or []
    active_id = settings.get("activeMt5InstanceId")
    return instances, active_id


def _resolve_instance_install_dir(instance_id: str | None) -> tuple[str | None, dict | None]:
    """0.3.235: 解析 instance_id → install_dir + instance metadata.

    - instance_id 不传 / 为空 / 等于 active_id → 返默认 (None, None) 让 caller
      跳过 rebind 用当前 SDK 连接.
    - 找不到对应 instance → 抛 ValueError, caller 应返错误给 AI.
    - 找到非默认 instance → 返 (install_dir, inst_dict).
    """
    if not instance_id:
        return None, None
    instances, active_id = _read_mt5_instances_from_settings()
    if not instances:
        # 老单 MT5 用户没配 instances → 默认走当前 SDK, 不强制 rebind
        return None, None
    if instance_id == active_id:
        return None, None  # 已经在默认实例上, 不必 rebind
    for inst in instances:
        if inst.get("id") == instance_id:
            install_dir = inst.get("installDir")
            if not install_dir:
                raise ValueError(f"instance_id={instance_id} 找到但 installDir 为空")
            return install_dir, inst
    raise ValueError(f"instance_id={instance_id} 不存在. 调 list_mt5_instances 看有效 ID.")


class _Mt5InstanceContext:
    """0.3.235: with-block 让工具 handler 透明切到指定 MT5 instance, 结束时
    rebind 回 active. 用法:
        with _Mt5InstanceContext(instance_id):
            data = mt5.account_info()   # 已切到 instance 的 SDK 上下文
    instance_id=None / 跟 active 相同 → no-op (跳过 rebind 省时).
    """
    def __init__(self, instance_id: str | None):
        self.instance_id = instance_id
        self.target_install_dir = None
        self.original_active_install_dir = None
        self.instance_meta = None

    def __enter__(self):
        if not self.instance_id:
            return self
        try:
            install_dir, meta = _resolve_instance_install_dir(self.instance_id)
        except ValueError as e:
            # caller 拿到 ValueError 后应返错误给 AI
            raise
        self.target_install_dir = install_dir
        self.instance_meta = meta
        if not install_dir:
            return self  # active 或 settings 不可用 → no-op
        # 记原 active 用于退出时 restore
        _instances, active_id = _read_mt5_instances_from_settings()
        for inst in _instances:
            if inst.get("id") == active_id:
                self.original_active_install_dir = inst.get("installDir")
                break
        # 先 check 该 install_dir 的 MT5 在跑没
        if not _ezd_terminal_is_running(install_dir):
            raise RuntimeError(
                f"instance {self.instance_meta.get('name') or self.instance_id} 的 MT5 未启动. "
                "去 EasyDeal MT5 tab 点该实例的「启动 MT5」按钮再试."
            )
        ok = _rebind_mt5(install_dir)
        if not ok:
            raise RuntimeError(
                f"切换到 instance {self.instance_meta.get('name') or self.instance_id} 失败 (rebind 没成功)."
            )
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if not self.target_install_dir:
            return False  # no-op 场景, 没切过, 不用 rebind 回
        if self.original_active_install_dir:
            try:
                _rebind_mt5(self.original_active_install_dir)
            except Exception as e:
                logging.warning(f"[Mt5InstanceContext exit] rebind 回 active 失败: {e}")
        return False  # 不吞异常


def _resolve_instance_for_ticket(ticket: int) -> str | None:
    """0.3.235: 给定 ticket 反查它在哪个 MT5 instance — close/modify_position
    没传 instance_id 时自动查. 实现: 遍历所有 instances rebind SDK 后调
    positions_get(ticket=...), 找到了就返该 instance_id. 完了 rebind 回 active.
    成本: O(N) instance rebind, 但只在 AI 偷懒不传 instance_id 时才跑.
    """
    if not ticket:
        return None
    instances, active_id = _read_mt5_instances_from_settings()
    if not instances or len(instances) <= 1:
        return None  # 单 MT5 用户没必要查
    # 先在当前 SDK 连的找一次, 不用 rebind
    try:
        pos = mt5.positions_get(ticket=int(ticket))
        if pos and len(pos) > 0:
            return active_id  # 在 active 找到了
    except Exception:
        pass
    # 在其它 instance 找
    original_active_install_dir = None
    for inst in instances:
        if inst.get("id") == active_id:
            original_active_install_dir = inst.get("installDir")
            break
    found_id = None
    for inst in instances:
        if inst.get("id") == active_id:
            continue  # 上面已经查过 active
        install_dir = inst.get("installDir")
        if not install_dir or not _ezd_terminal_is_running(install_dir):
            continue
        try:
            ok = _rebind_mt5(install_dir)
            if not ok:
                continue
            pos = mt5.positions_get(ticket=int(ticket))
            if pos and len(pos) > 0:
                found_id = inst.get("id")
                break
        except Exception as e:
            logging.warning(f"[_resolve_instance_for_ticket] rebind/query {install_dir} 失败: {e}")
    # rebind 回 active
    if original_active_install_dir:
        try: _rebind_mt5(original_active_install_dir)
        except Exception: pass
    return found_id


def _resolve_instance_for_login(login) -> str | None:
    """给定 MT5 账户 login 反查它在哪个 instance — 绑定多账户手机端「开仓」路由用
    (open_position 没传 instance_id 时). 遍历 instances rebind + account_info().login 比对,
    完了 rebind 回 active. 仿 _resolve_instance_for_ticket。单 MT5 用户直接返 None 走默认。"""
    try:
        login = int(login)
    except (TypeError, ValueError):
        return None
    if not login:
        return None
    instances, active_id = _read_mt5_instances_from_settings()
    if not instances or len(instances) <= 1:
        return None
    try:
        acc = mt5.account_info()
        if acc and int(getattr(acc, "login", 0) or 0) == login:
            return active_id                    # active 就是它
    except Exception:
        pass
    original_install = None
    for inst in instances:
        if inst.get("id") == active_id:
            original_install = inst.get("installDir")
            break
    found_id = None
    for inst in instances:
        if inst.get("id") == active_id:
            continue
        install_dir = inst.get("installDir")
        if not install_dir or not _ezd_terminal_is_running(install_dir):
            continue
        try:
            if _rebind_mt5(install_dir):
                acc = mt5.account_info()
                if acc and int(getattr(acc, "login", 0) or 0) == login:
                    found_id = inst.get("id")
                    break
        except Exception as e:
            logging.warning(f"[_resolve_instance_for_login] rebind/query {install_dir} 失败: {e}")
    if original_install:
        try: _rebind_mt5(original_install)
        except Exception: pass
    return found_id


def _resolve_data_path_for_instance(instance_id: str | None) -> str | None:
    """0.3.235: 拿指定 instance 的 data_path (MT5 data dir 用于读 Logs/MQL5/Files 等).
    日志读文件不需要 SDK rebind, 直接从 settings.mt5Instances[].dataDir 拿即可.
    instance_id 不传 / 为空 → 走当前默认实例 (老行为 _get_mt5_data_path 拿 terminal_info().data_path).
    """
    if not instance_id:
        return _get_mt5_data_path()
    instances, _active_id = _read_mt5_instances_from_settings()
    for inst in instances:
        if inst.get("id") == instance_id:
            data_dir = inst.get("dataDir") or inst.get("installDir")
            return data_dir
    return None


# 账户首次入金(数据大屏实例卡「首次入金」): (券商, 账户号) → 最早一笔入金成交的 deal.time(券商墙上时间 epoch)。
# 首次入金不会再变 → 查到就一直缓存; 没查到(无入金 / 查询失败)隔 1 小时再查, 免得每次探测都拉全量历史。
# 缓存原始 epoch 而不是换算后的 UTC: 券商偏移是上报时才换算的, 当时还不知道偏移的, 之后能自动纠正。
_FIRST_DEPOSIT_CACHE: dict = {}
_FIRST_DEPOSIT_MISS: dict = {}


def _first_deposit_epoch(server, login):
    """当前绑定账户的首次入金 deal.time(券商墙上时间 epoch); 没有入金记录 → None。调用方须已 rebind 到该账户。"""
    key = (server, login)
    if key in _FIRST_DEPOSIT_CACHE:
        return _FIRST_DEPOSIT_CACHE[key]
    if time.time() - _FIRST_DEPOSIT_MISS.get(key, 0) < 3600:
        return None
    try:
        # date_to 按券商墙上时间解释, 多给一天防券商时区比本机快
        deals = mt5.history_deals_get(datetime(2000, 1, 1), datetime.now() + timedelta(days=1)) or []
    except Exception:
        deals = []
    balance_type = getattr(mt5, "DEAL_TYPE_BALANCE", 2)
    times = [int(d.time) for d in deals
             if d.type == balance_type and (d.profit or 0) > 0 and d.time]
    if not times:
        _FIRST_DEPOSIT_MISS[key] = time.time()
        return None
    _FIRST_DEPOSIT_CACHE[key] = min(times)
    return _FIRST_DEPOSIT_CACHE[key]


def _list_all_mt5_status_impl(only_ids=None) -> dict:
    """0.3.235: 多 MT5 聚合状态 — 遍历 settings.mt5Instances, 对每个 rebind +
    拉 account_info / positions / terminal_info, 完了 rebind 回 active 防其它
    工具受影响. 没在跑的 instance 跳过 init 但仍返回 instance 元信息.
    only_ids: 只看这些实例 id(数据大屏详情关注的加报: 只 rebind 被关注的实例), 其余实例不返回.
    """
    out_instances = []
    total_balance = 0.0
    total_floating = 0.0
    if not _settings_path or not os.path.isfile(_settings_path):
        return {"error": "settings.json 未找到 — EASYDEAL_SETTINGS_PATH 没注入"}
    try:
        with open(_settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f) or {}
    except Exception as e:
        return {"error": f"读 settings.json 失败: {e}"}
    instances = settings.get("mt5Instances") or []
    active_id = settings.get("activeMt5InstanceId")
    active_install_dir = None
    for inst in instances:
        if inst.get("id") == active_id:
            active_install_dir = inst.get("installDir")
            break
    for inst in instances:
        inst_id = inst.get("id")
        if only_ids and inst_id not in only_ids:
            continue
        inst_name = inst.get("name") or inst_id
        install_dir = inst.get("installDir")
        user_intent = inst.get("user_intent") or "running"
        is_default = (inst_id == active_id)
        # 1.2.51: 每实例补 mounted_ea_name(从 mounted-state.json 读"这个实例上挂的是哪个 EA"),
        # 让中继/app 能把策略+订单按账户归属。之前中继靠二次 join list_mt5_instances 拿这字段,
        # 但那个工具的 item 用 instance_id(非 id)且不返 mounted_ea_name → join 永远空 →
        # 多账户用户(用户 4 账户)app 显不出账户对应策略。直接在本聚合里带上, 中继无需 join。
        _mst_ea = None
        try:
            if install_dir:
                _mst_ea = (_load_mounted_state(install_dir) or {}).get("ea_name")
        except Exception:
            _mst_ea = None
        item = {
            "instance_id": inst_id,
            "instance_name": inst_name,
            "install_dir": install_dir,
            "is_default": is_default,
            "user_intent": user_intent,
            "mounted_ea_name": _mst_ea,
            "running": False,
            "account": None,
            "first_deposit_at": None,   # 账户首次入金时间(ISO UTC), 见 _first_deposit_epoch
            "terminal": None,
            "positions_count": 0,
            "positions": [],
            "error": None,
        }
        if not install_dir:
            item["error"] = "no install_dir 配置"
            out_instances.append(item)
            continue
        # check 进程在不在跑 — 不在跑 SDK init 会自动 launch, 这里跳过
        if not _ezd_terminal_is_running(install_dir):
            item["error"] = "MT5 未启动 (跳过 SDK init 防自动拉起). 让用户去 EasyDeal MT5 tab 点启动."
            out_instances.append(item)
            continue
        item["running"] = True
        # rebind SDK 到这个 install_dir
        try:
            rebound = _rebind_mt5(install_dir)
        except Exception as e:
            item["error"] = f"rebind failed: {e}"
            out_instances.append(item)
            continue
        if not rebound:
            item["error"] = (
                "rebind failed: "
                + (_mt5_lifecycle.LAST_ERROR or "target identity not verified")
            )
            out_instances.append(item)
            continue
        try:
            acc = mt5.account_info()
            ti = mt5.terminal_info()
            positions = mt5.positions_get() or []
            if acc is not None:
                item["account"] = {
                    "login": acc.login,
                    "balance": float(acc.balance),
                    "equity": float(acc.equity),
                    "profit": float(acc.profit),
                    "margin": float(getattr(acc, "margin", 0) or 0),
                    "leverage": int(getattr(acc, "leverage", 0) or 0),  # 1.2.14: app 多账户卡显杠杆
                    "currency": acc.currency,
                    "server": acc.server,
                }
                total_balance += float(acc.balance or 0)
                total_floating += float(acc.profit or 0)
            if ti is not None:
                item["terminal"] = {
                    "connected": bool(getattr(ti, "connected", False)),
                    "trade_allowed": bool(getattr(ti, "trade_allowed", False)),
                    "ping_ms": int((getattr(ti, "ping_last", 0) or 0) / 1000),
                }
            all_ea_configs = _load_all_ea_monitor_configs()
            item["positions_count"] = len(positions)
            # 每品种小数位(MT5 symbol_info.digits) — app 行情按 broker 真实位数显示(含末尾0)。
            _dig_cache: dict = {}
            def _sym_digits(sym):
                if sym not in _dig_cache:
                    try:
                        _si = mt5.symbol_info(sym)
                        _dig_cache[sym] = int(getattr(_si, "digits", 0) or 0) if _si is not None else None
                    except Exception:
                        _dig_cache[sym] = None
                return _dig_cache[sym]
            item["positions"] = [
                {
                    "ticket": p.ticket, "symbol": p.symbol, "volume": p.volume,
                    "type": "buy" if p.type == 0 else "sell",
                    "price_open": p.price_open, "price_current": p.price_current,
                    "profit": p.profit, "magic": int(getattr(p, "magic", 0) or 0),
                    "sl": p.sl, "tp": p.tp,   # app 持仓卡显止盈止损 + 改单预填(之前漏 → app 显 '—')
                    "comment": p.comment, "_ea": _match_ea_for_order(p, all_ea_configs),
                    "digits": _sym_digits(p.symbol),
                }
                for p in positions
            ]
            # 1.2.35: 每实例点差(app 多账户卡每账户显自己的点差)。用该实例持仓的品种;
            # 没持仓就跳过(给 None)。symbol_info().spread 是当前点差(points)。
            try:
                _sym = positions[0].symbol if positions else None
                if _sym:
                    _si = mt5.symbol_info(_sym)
                    if _si is not None:
                        item["spread"] = int(getattr(_si, "spread", 0) or 0)
            except Exception:
                pass
            # 账户首次入金(数据大屏实例卡): deal.time 是券商墙上时间, 有偏移就换成真 UTC;
            # 偏移未知 → 按 UTC 直接用(同 deals_history 上传口径)
            try:
                if acc is not None:
                    _fd = _first_deposit_epoch(acc.server, acc.login)
                    if _fd is not None:
                        _off = _broker_offset_sec(positions[0].symbol if positions else None) or 0
                        item["first_deposit_at"] = datetime.fromtimestamp(
                            _fd - int(_off), tz=pytz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            except Exception:
                pass
            # 0.3.347: trade_allowed 一致性检查 (跟 0.3.328 get_trading_status 同款).
            # SDK 的 terminal.trade_allowed 在 build 5836+ / 多实例 rebind 后可能 cache
            # 错值 (false 但 EA 实际在交易, 用户:「拿不到开关状态」). 不只信 SDK 字段,
            # 用 (a) recent_5min deals + (b) 当前持仓数 双信号 cross-check, 任一为真且
            # SDK 报 false → 加 effective_trade_allowed=True + hint 告诉 AI 不要误导用户.
            try:
                import datetime as _dt
                _now = _dt.datetime.now()
                _recent = mt5.history_deals_get(_now - _dt.timedelta(minutes=5), _now)
                _recent_count = len(_recent) if _recent else 0
            except Exception:
                _recent_count = -1
            _term_allow = bool(getattr(ti, "trade_allowed", False)) if ti is not None else False
            _has_recent = _recent_count > 0
            # ⚠ 2026-06-24 修正: 仅用 recent_5min_deals 交叉验证, **不再用 has_positions**。
            # 原逻辑 (_has_recent or _has_positions) 在「算法交易关 + 盈利篮子卡住平不掉」
            # 这一真实场景下误判: 有持仓 → effective=True → 反而告诉 AI「别说关闭、EA 运行中」,
            # 把"该平没平的裸露风险"掩盖掉 (斯宇 GMarket 4752 刷屏即此). 持仓只是"有单",
            # 不能证明开关开着(卡住的旧篮子就是反例)。只有近 5min 有 broker 确认的 deal
            # 才说明实际在交易 → 才覆盖 SDK 的 false。无 deal + SDK false → 如实当"关"。
            if item.get("terminal"):
                if _term_allow:
                    item["terminal"]["effective_trade_allowed"] = True
                elif _has_recent:
                    item["terminal"]["effective_trade_allowed"] = True
                    item["terminal"]["trade_allowed_hint"] = (
                        f"⚠ SDK terminal.trade_allowed=False 但近 5min 有 {_recent_count} 笔成交 "
                        "→ EA 实际在交易, SDK 字段在多实例下 cache 错值, 不要说「算法交易关闭」."
                    )
                else:
                    # SDK false 且近 5min 无成交 → 大概率真关(或没成交)。如实标 False, 别误判"开着"。
                    item["terminal"]["effective_trade_allowed"] = False
                    if len(positions) > 0:
                        item["terminal"]["trade_allowed_hint"] = (
                            f"算法交易疑似**关闭**: terminal.trade_allowed=False 且近 5min 无成交, "
                            f"但有 {len(positions)} 笔持仓 — 警惕「该平没平」(篮子卡住平不掉, "
                            "查日志是否刷 4752/retcode=10027 AutoTrading disabled by client)."
                        )
                item["terminal"]["recent_5min_deals"] = _recent_count
        except Exception as e:
            item["error"] = f"query failed: {e}"
        out_instances.append(item)
    # rebind 回 active 防后续工具撞错 instance
    if active_install_dir:
        try: _rebind_mt5(active_install_dir)
        except Exception: pass
    return {
        "as_of": _now_bj_str(),
        "summary": {
            "instance_count": len(out_instances),
            "running_count": sum(1 for x in out_instances if x.get("running")),
            "total_balance": round(total_balance, 2),
            "total_floating": round(total_floating, 2),
        },
        "instances": out_instances,
        "note": (
            "已 rebind 回默认实例 SDK 连接, 后续 get_trading_status / open_position 等"
            "工具走默认实例. 报告时请按实例分组明确说『默认实例 (XXX) 持仓 N 笔』,"
            "避免合并到一起让用户搞不清是哪个账户."
        ),
    }


def _maybe_reload_settings() -> None:
    """每次工具调用前 cheap check：settings.json 的 mtime 变了就重读。"""
    global _settings_last_mtime
    if not _settings_path or not os.path.isfile(_settings_path):
        return
    try:
        mtime = os.path.getmtime(_settings_path)
    except OSError:
        return
    if mtime <= _settings_last_mtime:
        return
    _settings_last_mtime = mtime

    try:
        with open(_settings_path, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
    except Exception as e:
        logging.warning(f"[settings reload] 读 {_settings_path} 失败：{e}")
        return

    s = strategy_instance
    if s is None:
        return  # init 还没跑完，先放过；等 init 完后下次调用再 reload

    # 1. MT5 install dir 变化 → 重新绑定 SDK
    new_install = ((data.get("mt5") or {}).get("installDir") or "").strip()
    if new_install:
        try:
            ti = mt5.terminal_info()
            cur = ti.path if ti else None
        except Exception:
            cur = None
        if _norm_install_dir(cur) != _norm_install_dir(new_install):
            logging.info(f"[settings reload] MT5 installDir 变了：{cur} → {new_install}，开始重绑")
            _rebind_mt5(new_install)

    # 2. monitor.* → strategy_instance 同步
    monitor = data.get("monitor") or {}
    syms = monitor.get("symbols")
    if isinstance(syms, list):
        cleaned = [x for x in syms if isinstance(x, str) and x.strip()]
        if cleaned and cleaned != s.symbols:
            s.symbols = cleaned
            s.symbol = cleaned[0]
            logging.info(f"[settings reload] 监控品种更新为：{cleaned}")
    magics = monitor.get("magicNumbers")
    if isinstance(magics, list):
        out = []
        for m in magics:
            try:
                out.append(int(m))
            except (TypeError, ValueError):
                pass
        if out and out != s.magic_numbers:
            s.magic_numbers = out
            s.magic_number = out[0]
            logging.info(f"[settings reload] magic numbers 更新为：{out}")
    cc = monitor.get("commentContains")
    if isinstance(cc, list):
        new_cc = [str(x) for x in cc]
        if new_cc != s.comment_contains:
            s.comment_contains = new_cc
            logging.info(f"[settings reload] commentContains 更新为：{new_cc}")
    ce = monitor.get("commentExcludes")
    if isinstance(ce, list):
        new_ce = [str(x) for x in ce]
        if new_ce != s.comment_excludes:
            s.comment_excludes = new_ce
            logging.info(f"[settings reload] commentExcludes 更新为：{new_ce}")


def _get_strategy_doc_path(date: datetime | None = None) -> str:
    path = os.getenv("EA_STRATEGY_DOC_PATH")
    if path:
        return path
    # Single, read-only strategy doc by default (no date-scoped rotation).
    base_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_dir, "strategy_doc_latest.md")


def _get_latest_strategy_doc_path(max_lookback_days: int = 30) -> str:
    """Compatibility helper: strategy doc is now a single path."""
    _ = max_lookback_days
    return _get_strategy_doc_path()


def _read_strategy_doc(path: str) -> str:
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except Exception:
        return ""


def get_strategy_documentation_base() -> str:
    """Return the last inferred strategy documentation, if any."""
    return _read_strategy_doc(_get_strategy_doc_path())


def _read_recent_lines(file_path: str, limit: int = 200, date_prefix: str = None, keywords: list = None) -> list:
    if not file_path or not os.path.exists(file_path):
        return []
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return []
    if date_prefix:
        lines = [line for line in lines if line.startswith(date_prefix)]
    if keywords:
        lines = [line for line in lines if any(keyword in line for keyword in keywords)]
    if limit and len(lines) > limit:
        lines = lines[-limit:]
    return [line.strip() for line in lines if line.strip()]


def _read_monitor_events(date_prefix: str = None, limit: int = 100) -> list:
    events = []
    events_path = os.path.join(log_directory, "monitor_events.jsonl")
    if not os.path.exists(events_path):
        return events
    try:
        with open(events_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return events

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except Exception:
            continue
        ts = str(data.get("timestamp", ""))
        if date_prefix and not ts.startswith(date_prefix):
            continue
        events.append({
            "timestamp": ts,
            "event_type": data.get("event_type"),
            "level": data.get("level"),
            "message": data.get("message"),
            "data": data.get("data", {})
        })
    if limit and len(events) > limit:
        events = events[-limit:]
    return events


def _read_conversation_context(date_prefix: str, limit: int = 50, override_path: str = None) -> list:
    path = override_path or os.getenv("EA_CONVERSATION_PATH")
    if path and os.path.exists(path):
        return _read_recent_lines(path, limit=limit)
    return _read_recent_lines(log_file, limit=limit, date_prefix=date_prefix, keywords=["\u6536\u5230\u5de5\u5177\u8c03\u7528\u8bf7\u6c42", "Tool call"])


def _fetch_chat_history(date_prefix: str = None, limit: int = 200) -> list:
    url = os.getenv("FAY_MSG_API_URL", "http://127.0.0.1:5000/api/get-msg")
    try:
        payload = {"limit": int(limit) if limit else 200}
    except (TypeError, ValueError):
        payload = {"limit": 200}
    try:
        response = requests.post(url, json=payload, timeout=10)
    except Exception:
        return []
    if response.status_code != 200:
        return []
    try:
        data = response.json()
    except Exception:
        return []
    items = data.get("list", [])
    if not isinstance(items, list):
        return []
    if date_prefix:
        filtered = []
        for item in items:
            timetext = str(item.get("timetext", ""))
            if timetext.startswith(date_prefix):
                filtered.append(item)
        items = filtered
    lines = []
    for item in items[-payload["limit"]:]:
        content = str(item.get("content", "")).strip()
        if not content:
            continue
        timetext = str(item.get("timetext", "")).strip()
        username = str(item.get("username", "")).strip()
        msg_type = str(item.get("type", "")).strip()
        way = str(item.get("way", "")).strip()
        prefix_parts = [part for part in [timetext, username, msg_type, way] if part]
        prefix = " ".join(prefix_parts)
        if prefix:
            lines.append(f"{prefix}: {content}")
        else:
            lines.append(content)
    return lines


def _build_strategy_prompt(strategy, context: dict, base_doc: str) -> str:
    status = context.get("status", {})
    summary = status.get("orders", {}).get("summary", {})
    account = status.get("account", {})
    config = context.get("config", {})

    prompt_sections = [
        "你是交易策略分析师，请基于 EA 源码和运行数据分析策略逻辑。",
        "优先依据源码理解策略设计，日志和订单作为运行验证。",
        "注意：参数不等于规则；仅在有直接证据时引用。不要臆造指标或条件。",
        "请输出以下内容：",
        "1) 策略核心逻辑摘要（基于源码）",
        "2) 开仓/加仓/平仓规则",
        "3) 风控机制",
        "4) 运行参数与源码默认值的偏差分析",
        "5) 日志验证（实际行为是否与源码逻辑一致）",
        "6) 未确定项或需补充的数据",
    ]

    # EA source code (highest priority)
    ea_params = context.get("ea_params", [])
    if ea_params:
        prompt_sections.append("## EA 源码参数定义")
        prompt_sections.append(json.dumps(ea_params, ensure_ascii=False, indent=2))

    param_diff = context.get("param_diff", [])
    if param_diff:
        prompt_sections.append("## 运行时参数偏差（源码默认值 vs 实际运行值）")
        prompt_sections.append(json.dumps(param_diff, ensure_ascii=False, indent=2))

    ea_source = context.get("ea_source_summary", "")
    if ea_source:
        prompt_sections.append("## EA 核心逻辑（源码摘要）")
        prompt_sections.append(ea_source)

    # Account & config
    prompt_sections.append("## 账户与持仓")
    prompt_sections.append(json.dumps({
        "balance": account.get("balance"),
        "equity": account.get("equity"),
        "margin_level": account.get("margin_level"),
        "positions": summary
    }, ensure_ascii=False, indent=2))
    prompt_sections.append("## 监控配置")
    prompt_sections.append(json.dumps(config, ensure_ascii=False, indent=2))

    # Logs (validation evidence)
    order_logs = context.get("order_logs", [])
    if order_logs:
        prompt_sections.append("## 今日订单变化")
        prompt_sections.append("\n".join(order_logs))

    log_lines = context.get("log_lines", [])
    if log_lines:
        prompt_sections.append("## 今日关键日志")
        prompt_sections.append("\n".join(log_lines))

    events = context.get("events", [])
    if events:
        prompt_sections.append("## 今日监控事件")
        prompt_sections.append(json.dumps(events, ensure_ascii=False, indent=2))

    conversation = context.get("conversation", [])
    if conversation:
        prompt_sections.append("## 今日对话/工具调用")
        prompt_sections.append("\n".join(conversation))

    chat_records = context.get("chat_records", [])
    if chat_records:
        prompt_sections.append("## 最近聊天记录")
        prompt_sections.append("\n".join(chat_records))

    if base_doc:
        prompt_sections.append("## 历史策略文档")
        prompt_sections.append(base_doc)

    return "\n".join(prompt_sections)


def _extract_fay_content(payload: dict) -> str:
    if not isinstance(payload, dict):
        return ""
    choices = payload.get("choices") or []
    if choices:
        choice = choices[0]
        message = choice.get("message") or {}
        content = message.get("content")
        if content:
            return content
        delta = choice.get("delta") or {}
        if delta.get("content"):
            return delta["content"]
    if payload.get("text"):
        return payload["text"]
    return ""


def _query_fay(prompt: str, observation: str = "") -> tuple:
    url = os.getenv("FAY_API_URL", "http://127.0.0.1:5000/v1/chat/completions")
    api_key = os.getenv("FAY_API_KEY", "YOUR_API_KEY")
    model = os.getenv("FAY_MODEL", "llm")
    username = "user"

    payload = {
        "model": model,
        "messages": [{"role": username, "content": prompt}],
        "stream": True,
        "observation": observation or ""
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    try:
        response = requests.post(url, headers=headers, data=json.dumps(payload), stream=True, timeout=30)
    except Exception as exc:
        return False, f"Fay request failed: {exc}"

    if response.status_code != 200:
        return False, f"Fay request failed: {response.status_code}"

    content_chunks = []
    try:
        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            line = line.strip()
            payload_text = line
            if line.startswith("data:"):
                payload_text = line[5:].strip()
            if payload_text == "[DONE]":
                break
            try:
                data = json.loads(payload_text)
            except Exception:
                continue
            content = _extract_fay_content(data)
            if content:
                content_chunks.append(content)
    except Exception:
        content_chunks = []

    if content_chunks:
        return True, "".join(content_chunks)

    try:
        data = response.json()
        content = _extract_fay_content(data)
        if content:
            return True, content
    except Exception:
        pass

    text = (response.text or "").strip()
    if text:
        return True, text

    return False, "Empty Fay response"


def _persist_strategy_doc(content: str, date: datetime | None = None) -> None:
    if not content:
        return
    path = _get_strategy_doc_path(date)
    dir_path = os.path.dirname(path)
    if dir_path and not os.path.exists(dir_path):
        os.makedirs(dir_path, exist_ok=True)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as exc:
        logging.warning("Failed to persist strategy doc: %s", exc)


def _seconds_until_next_doc_update(now: datetime | None = None) -> float:
    current = now or datetime.now()
    target = current.replace(hour=0, minute=15, second=0, microsecond=0)
    if current >= target:
        target += timedelta(days=1)
    seconds = (target - current).total_seconds()
    return max(seconds, 1.0)


def _previous_day_window(now: datetime | None = None) -> tuple[date, str, str, str]:
    """Return (review_date, date_prefix, start_time, end_time) for the previous day."""
    current = now or datetime.now()
    review_date = (current - timedelta(days=1)).date()
    date_prefix = review_date.strftime("%Y-%m-%d")
    start_dt = datetime(review_date.year, review_date.month, review_date.day, 0, 0, 0)
    end_dt = start_dt + timedelta(days=1) - timedelta(seconds=1)
    return review_date, date_prefix, start_dt.strftime("%Y-%m-%d %H:%M:%S"), end_dt.strftime("%Y-%m-%d %H:%M:%S")


def _build_consistency_review_context(
    strategy: TradingContext,
    date_prefix: str,
    start_time: str,
    end_time: str,
    base_doc_path: str,
) -> dict:
    order_logs = _read_recent_lines(
        log_file,
        limit=400,
        date_prefix=date_prefix,
        keywords=["[OPEN]", "[CLOSE]", "[UPDATE]"],
    )
    log_lines = _read_recent_lines(
        log_file,
        limit=200,
        date_prefix=date_prefix,
        keywords=["WARNING", "ERROR", "indicator_report", "risk_loss", "order_change"],
    )
    events = _read_monitor_events(date_prefix=date_prefix, limit=100)

    try:
        msg_limit = int(os.getenv("FAY_MSG_LIMIT", "200"))
    except (TypeError, ValueError):
        msg_limit = 200
    chat_records = _fetch_chat_history(date_prefix=date_prefix, limit=msg_limit)

    profit_history = strategy.get_profit_history(start_time=start_time, end_time=end_time)
    deals = profit_history.get("deals") if isinstance(profit_history, dict) else None
    if isinstance(deals, list) and len(deals) > 200:
        profit_history["deals"] = deals[-200:]
        profit_history["notes"] = "deals truncated to last 200 items"

    # EA logs (direct trading decisions from Print())
    ea_logs = []
    data_path = _get_mt5_data_path()
    if data_path:
        ea_log_dir = os.path.join(data_path, "MQL5", "Logs")
        ea_log_result = _read_mt5_log(ea_log_dir, date_prefix, page_size=200, page=1)
        if "lines" in ea_log_result:
            ea_logs = ea_log_result["lines"]

    # Parameter diff (source vs runtime)
    param_diff = _get_param_diff()

    return {
        "review_date": date_prefix,
        "window": {"start": start_time, "end": end_time},
        "base_doc_path": base_doc_path,
        "status": strategy.get_status(),
        "config": strategy.get_config_info(),
        "order_logs": order_logs,
        "log_lines": log_lines,
        "ea_logs": ea_logs,
        "events": events,
        "chat_records": chat_records,
        "profit_history": profit_history,
        "param_diff": param_diff,
    }


def _build_consistency_review_prompt(review_date: date, base_doc: str) -> str:
    review_day = review_date.strftime("%Y-%m-%d")
    prompt_sections = [
        "You are a trading-strategy auditor.",
        f"Review date: {review_day} (use only this day's observations).",
        "Tasks:",
        "1. Judge whether the observed trading behavior is consistent with the strategy description.",
        "2. Check whether runtime parameters (in param_diff) deviate from the strategy doc.",
        "3. Cross-reference EA logs (ea_logs) with monitor logs for evidence.",
        "Do not rewrite the strategy description and do not auto-update any documentation.",
        "Return strict JSON only (no extra text):",
        "{\"consistent\": true|false|null, \"summary\": \"\", \"mismatches\": [], \"param_mismatches\": [], \"evidence\": []}",
        "consistent=false means clear mismatch; true means broadly consistent; null means insufficient evidence or no trades.",
        "param_mismatches: list of {param, doc_value, actual_value, impact} for parameters that differ from the strategy doc.",
        "Strategy description:",
        base_doc or "(empty)",
    ]
    return "\n".join(prompt_sections)


def _extract_json_object(text: str) -> dict | None:
    if not text:
        return None
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except Exception:
        pass
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _parse_consistency_assessment(text: str) -> dict:
    payload = _extract_json_object(text)
    consistent = None
    summary = (text or "").strip()
    mismatches: list[str] = []
    param_mismatches: list = []
    evidence: list[str] = []

    # Chinese keywords written with unicode escapes to avoid encoding issues.
    zh_consistent = "\u4e00\u81f4"          # 一致
    zh_inconsistent = "\u4e0d\u4e00\u81f4"  # 不一致
    zh_not_match = "\u4e0d\u7b26"           # 不符
    zh_conflict = "\u51b2\u7a81"            # 冲突
    zh_contradiction = "\u77db\u76fe"       # 矛盾
    zh_match = "\u7b26\u5408"               # 符合
    zh_fit = "\u543b\u5408"                 # 吻合

    if payload:
        raw_consistent = payload.get("consistent")
        if isinstance(raw_consistent, bool) or raw_consistent is None:
            consistent = raw_consistent
        elif isinstance(raw_consistent, str):
            lowered = raw_consistent.strip().lower()
            if lowered in ("true", "yes", zh_consistent, "consistent"):
                consistent = True
            elif lowered in ("false", "no", zh_inconsistent, "inconsistent"):
                consistent = False
            else:
                consistent = None
        if payload.get("summary"):
            summary = str(payload.get("summary")).strip()
        if isinstance(payload.get("mismatches"), list):
            mismatches = [str(item) for item in payload["mismatches"] if str(item).strip()]
        if isinstance(payload.get("evidence"), list):
            evidence = [str(item) for item in payload["evidence"] if str(item).strip()]
        if isinstance(payload.get("param_mismatches"), list):
            param_mismatches = payload["param_mismatches"]
    else:
        lowered = summary.lower()
        inconsistent_hits = [
            zh_inconsistent,
            zh_not_match,
            zh_contradiction,
            zh_conflict,
            "inconsistent",
            "mismatch",
            "conflict",
        ]
        consistent_hits = [
            zh_consistent,
            zh_match,
            zh_fit,
            "consistent",
            "match",
        ]
        if any(token in lowered for token in inconsistent_hits):
            consistent = False
        elif any(token in lowered for token in consistent_hits):
            consistent = True

    return {
        "consistent": consistent,
        "summary": summary,
        "mismatches": mismatches,
        "param_mismatches": param_mismatches,
        "evidence": evidence,
        "raw": text,
        "payload": payload,
    }


def _notify_strategy_review(level: str, message: str, data: dict, alert_key: str) -> None:
    global monitor_instance
    if monitor_instance:
        monitor_instance.notify(
            event_type="strategy_consistency_review",
            level=level,
            message=message,
            data=data,
            alert_key=alert_key,
        )
        return
    logging.warning("Strategy review notification skipped (monitor not ready): %s", message)


def _strategy_consistency_review_loop() -> None:
    while True:
        try:
            wait_seconds = _seconds_until_next_doc_update()
            logging.info("Strategy consistency review scheduled in %s seconds", int(wait_seconds))
            time.sleep(wait_seconds)

            try:
                strategy = get_strategy()
            except Exception as exc:
                logging.warning("Strategy consistency review skipped: %s", exc)
                continue

            review_date, date_prefix, start_time, end_time = _previous_day_window()
            base_doc_path = _get_strategy_doc_path()
            base_doc = _read_strategy_doc(base_doc_path)

            if not base_doc:
                _notify_strategy_review(
                    level="warning",
                    message=(
                        f"\u672a\u627e\u5230\u7b56\u7565\u8bf4\u660e\u6587\u6863\uff0c"
                        f"\u65e0\u6cd5\u590d\u76d8 {date_prefix} \u7684\u4e00\u81f4\u6027\u3002"
                        "\u8bf7\u751f\u6210\u6216\u63d0\u4f9b\u7b56\u7565\u8bf4\u660e\u3002"
                    ),
                    data={
                        "review_date": date_prefix,
                        "doc_path": base_doc_path,
                        "window": {"start": start_time, "end": end_time},
                    },
                    alert_key=f"strategy_consistency_review:missing_doc:{date_prefix}",
                )
                continue

            context = _build_consistency_review_context(
                strategy=strategy,
                date_prefix=date_prefix,
                start_time=start_time,
                end_time=end_time,
                base_doc_path=base_doc_path,
            )

            prompt = _build_consistency_review_prompt(review_date, base_doc)
            observation = json.dumps(context, ensure_ascii=False)
            ok, result = _query_fay(prompt, observation)
            if not ok:
                logging.warning("Strategy consistency review failed for %s: %s", date_prefix, result)
                _notify_strategy_review(
                    level="warning",
                    message=f"{date_prefix} \u4e00\u81f4\u6027\u590d\u76d8\u5931\u8d25\uff1a{result}",
                    data={"review_date": date_prefix, "doc_path": base_doc_path},
                    alert_key=f"strategy_consistency_review:error:{date_prefix}",
                )
                continue

            assessment = _parse_consistency_assessment(result)
            consistent = assessment.get("consistent")

            if consistent is False:
                _notify_strategy_review(
                    level="warning",
                    message=(
                        f"{date_prefix} \u4ea4\u6613\u4e0e\u7b56\u7565\u63cf\u8ff0"
                        "\u53ef\u80fd\u4e0d\u4e00\u81f4\uff0c\u8bf7\u68c0\u67e5\u7b56\u7565"
                        "\u6216\u66f4\u6b63\u63cf\u8ff0\u3002"
                    ),
                    data={
                        "review_date": date_prefix,
                        "doc_path": base_doc_path,
                        "window": {"start": start_time, "end": end_time},
                        "assessment": {
                            "summary": assessment.get("summary"),
                            "mismatches": assessment.get("mismatches"),
                            "param_mismatches": assessment.get("param_mismatches"),
                            "evidence": assessment.get("evidence"),
                        },
                    },
                    alert_key=f"strategy_consistency_review:mismatch:{date_prefix}",
                )
            elif consistent is True:
                logging.info("Strategy consistency review: consistent for %s", date_prefix)
            else:
                logging.info(
                    "Strategy consistency review inconclusive for %s: %s",
                    date_prefix,
                    assessment.get("summary"),
                )
        except Exception as exc:
            logging.warning("Strategy consistency review loop error: %s", exc)
            time.sleep(60)


def generate_strategy_documentation(strategy, arguments: dict = None) -> tuple:
    arguments = arguments or {}
    date_prefix = _bj_date_str()

    order_logs = _read_recent_lines(
        log_file,
        limit=200,
        date_prefix=date_prefix,
        keywords=["[OPEN]", "[CLOSE]", "[UPDATE]"]
    )
    log_lines = _read_recent_lines(
        log_file,
        limit=100,
        date_prefix=date_prefix,
        keywords=["WARNING", "ERROR", "indicator_report", "risk_loss", "order_change"]
    )
    events = _read_monitor_events(date_prefix=date_prefix, limit=50)

    conversation = []
    conversation_text = arguments.get("conversation")
    conversation_path = arguments.get("conversation_path")
    if conversation_text:
        if isinstance(conversation_text, list):
            conversation = [str(item) for item in conversation_text]
        else:
            conversation = [str(conversation_text)]
    else:
        conversation = _read_conversation_context(date_prefix, limit=50, override_path=conversation_path)

    try:
        msg_limit = int(os.getenv("FAY_MSG_LIMIT", "200"))
    except (TypeError, ValueError):
        msg_limit = 200
    chat_records = _fetch_chat_history(date_prefix=date_prefix, limit=msg_limit)

    # EA source code analysis
    ea_source_summary = _read_ea_source_summary(max_lines=200)
    ea_filepath = _get_strategy_file_path()
    ea_params = []
    if os.path.isfile(ea_filepath):
        try:
            with open(ea_filepath, "r", encoding="utf-8") as f:
                ea_params = _parse_input_params(f.read())
        except Exception:
            pass
    param_diff = _get_param_diff()

    context = {
        "status": strategy.get_status(),
        "config": strategy.get_config_info(),
        "order_logs": order_logs,
        "log_lines": log_lines,
        "events": events,
        "conversation": conversation,
        "chat_records": chat_records,
        "ea_params": ea_params,
        "param_diff": param_diff,
        "ea_source_summary": ea_source_summary,
    }

    base_doc = get_strategy_documentation_base()
    prompt = _build_strategy_prompt(strategy, context, base_doc)
    observation = json.dumps(context, ensure_ascii=False)
    ok, result = _query_fay(prompt, observation)
    if ok:
        return True, result
    if base_doc:
        return False, base_doc + "\n\n[LLM推测失败] " + str(result)
    return False, "[LLM推测失败] " + str(result)


def _get_or_generate_strategy_doc(strategy, arguments: dict | None = None) -> tuple:
    doc_path = _get_strategy_doc_path()
    doc = _read_strategy_doc(doc_path)
    if doc:
        return True, doc
    # Auto-generate when doc doesn't exist
    logging.info("Strategy doc not found, generating from source + logs...")
    ok, result = generate_strategy_documentation(strategy, arguments)
    if ok:
        _persist_strategy_doc(result)
        logging.info("Strategy doc generated and saved to %s", doc_path)
    return ok, result


TIMEFRAME_MAP = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
    "W1": mt5.TIMEFRAME_W1,
    "MN1": mt5.TIMEFRAME_MN1,
}


# ============== Strategy script helpers ==============

def _detect_ea_from_charts() -> str | None:
    """Detect the EA name currently loaded on a chart by scanning .chr files.

    Looks for <expert> blocks in chart profiles and extracts the EA .ex5 name.
    Returns the .mq5 source filename (e.g. 'YourEA.mq5') or None.
    """
    try:
        info = mt5.terminal_info()
        if not info or not info.data_path:
            return None
    except Exception:
        return None

    charts_dir = os.path.join(info.data_path, "MQL5", "Profiles", "Charts")
    if not os.path.isdir(charts_dir):
        return None

    for root, _dirs, files in os.walk(charts_dir):
        for fname in files:
            if not fname.lower().endswith(".chr"):
                continue
            chr_path = os.path.join(root, fname)
            try:
                with open(chr_path, "r", encoding="utf-16-le", errors="replace") as f:
                    content = f.read()
            except Exception:
                try:
                    with open(chr_path, "r", encoding="utf-8", errors="replace") as f:
                        content = f.read()
                except Exception:
                    continue

            # Find expert name=XXX.ex5 in <expert> block
            expert_match = re.search(
                r'<expert>\s*\n(.*?)\n\s*</expert>',
                content, re.DOTALL | re.IGNORECASE
            )
            if not expert_match:
                continue
            name_match = re.search(r'^name=(.+\.ex5)\s*$', expert_match.group(1), re.MULTILINE | re.IGNORECASE)
            if name_match:
                ex5_name = name_match.group(1).strip()
                # Convert .ex5 -> .mq5
                mq5_name = os.path.splitext(ex5_name)[0] + ".mq5"
                logging.info(f"Auto-detected EA from chart profile: {mq5_name}")
                return mq5_name

    return None


# Cache to avoid scanning .chr files on every call
_cached_ea_filename: str | None = None

# Legacy default — kept ONLY for backward compatibility when chart auto-detect
# fails AND EA_FILENAME env var is unset. New deployments should rely on
# auto-detection or set EA_FILENAME / EA_FILE_PATH explicitly.
_DEFAULT_EA_FILENAME = "GMarket.mq5"


def _resolve_ea_filename() -> str:
    """Return the active EA's .mq5 filename.

    Resolution order:
      1. Cached value from MT5 chart .chr auto-detection (set by
         _detect_ea_from_charts on first call to _get_strategy_file_path).
      2. EA_FILENAME environment variable.
      3. Legacy default _DEFAULT_EA_FILENAME.
    """
    return _cached_ea_filename or os.getenv("EA_FILENAME") or _DEFAULT_EA_FILENAME


def _get_strategy_file_path(ea_name: str = None, data_path: str = None) -> str:
    """Return the absolute path to the EA .mq5 strategy file.

    ea_name / data_path 显式传入时(参数对话框按 EA + 绑定实例调用)优先用它们,
    不再退回"默认/激活 EA"和默认实例 —— 否则多 EA / 多实例下读到的是别的 EA,
    保存后重开会"还原"(实为读错对象)。

    无显式入参时的解析顺序:
    1. EA_FILE_PATH env var (full path to .mq5 file)
    2. Auto-detect from MT5 chart profile (.chr)
    3. EA_FILENAME env var
    4. Fallback to project directory
    """
    global _cached_ea_filename

    # 1. Explicit env override —— 仅在没显式指定 ea_name 时生效(指定了就以它为准)
    if not ea_name:
        env_path = os.getenv("EA_FILE_PATH")
        if env_path and os.path.isfile(env_path):
            return env_path

    if data_path is None:
        try:
            info = mt5.terminal_info()
            data_path = info.data_path if info else None
        except Exception:
            data_path = None

    # Determine filename to search for
    if ea_name:
        ea_filename = ea_name if ea_name.lower().endswith(".mq5") else (ea_name + ".mq5")
    else:
        # 2. Auto-detect EA name from chart profiles (cached)
        if _cached_ea_filename is None:
            detected = _detect_ea_from_charts()
            if detected:
                _cached_ea_filename = detected
        ea_filename = _resolve_ea_filename()

    # 3. Look in MT5 data directory
    if data_path:
        # Try direct path under Experts/
        ea_path = os.path.join(data_path, "MQL5", "Experts", ea_filename)
        if os.path.isfile(ea_path):
            return ea_path
        # Try recursive search under Experts/ (EA may be in a subfolder)
        experts_dir = os.path.join(data_path, "MQL5", "Experts")
        if os.path.isdir(experts_dir):
            for dirpath, _dirnames, filenames in os.walk(experts_dir):
                if ea_filename in filenames:
                    return os.path.join(dirpath, ea_filename)

    # 4. Fallback: same directory as this script
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ea_filename)


def _parse_input_params(content: str) -> list[dict]:
    """Parse all 'input' parameter declarations from MQ5 source code."""
    params = []
    pattern = re.compile(
        r'^input\s+'
        r'(?P<type>\w+)\s+'
        r'(?P<name>\w+)\s*=\s*'
        r'(?P<value>[^;]+?)\s*;\s*'
        r'(?://\s*(?P<comment>.*))?$',
        re.MULTILINE
    )
    for m in pattern.finditer(content):
        value_str = m.group("value").strip()
        params.append({
            "type": m.group("type"),
            "name": m.group("name"),
            "value": value_str,
            "comment": (m.group("comment") or "").strip(),
        })
    return params


def _load_params_from_runtime_json(ea_name: str = None, data_path: str = None) -> dict | None:
    """Read EA-dumped runtime parameters from MQL5/Files/<EA>_runtime.json.

    The EA's OnInit writes this file, so it always reflects the true current
    input values (unlike .chr which MT5 only flushes on save/close).
    Returns {param_name: value_as_string} or None if file missing/invalid.
    data_path 显式传入(绑定实例)时按它解析, 否则回退 SDK 当前实例。
    """
    if ea_name is None:
        ea_name = _resolve_ea_filename()
    ea_base = os.path.splitext(ea_name)[0]

    if data_path is None:
        try:
            info = mt5.terminal_info()
            data_path = info.data_path if info else None
        except Exception:
            data_path = None
    if not data_path:
        return None

    runtime_path = os.path.join(data_path, "MQL5", "Files", f"{ea_base}_runtime.json")
    if not os.path.isfile(runtime_path):
        return None

    try:
        with open(runtime_path, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
    except Exception as exc:
        logging.warning(f"runtime json parse failed ({runtime_path}): {exc}")
        return None

    params_raw = data.get("params")
    if not isinstance(params_raw, dict):
        return None

    # Normalize all values to strings to match .chr output shape
    return {k: ("true" if v is True else "false" if v is False else str(v))
            for k, v in params_raw.items()}


def _get_runtime_json_info(ea_name: str = None) -> dict | None:
    """Return metadata about the runtime JSON file for diagnostics."""
    if ea_name is None:
        ea_name = _resolve_ea_filename()
    ea_base = os.path.splitext(ea_name)[0]

    try:
        info = mt5.terminal_info()
        if not info or not info.data_path:
            return None
    except Exception:
        return None

    runtime_path = os.path.join(info.data_path, "MQL5", "Files", f"{ea_base}_runtime.json")
    result = {"path": runtime_path, "exists": os.path.isfile(runtime_path)}
    if result["exists"]:
        try:
            result["mtime"] = datetime.fromtimestamp(
                os.path.getmtime(runtime_path)
            ).strftime("%Y-%m-%d %H:%M:%S")
            with open(runtime_path, "r", encoding="utf-8", errors="replace") as f:
                result["content"] = json.load(f)
        except Exception as exc:
            result["read_error"] = str(exc)
    return result


def _get_config_set_path(ea_name: str = None, data_path: str = None) -> str | None:
    """Return path to MQL5/Files/<EA>_config.set (MCP-written runtime overrides).
    data_path 显式传入(绑定实例)时按它解析, 否则回退默认实例。"""
    if ea_name is None:
        ea_name = _resolve_ea_filename()
    ea_base = os.path.splitext(ea_name)[0]
    if data_path is None:
        data_path = _get_mt5_data_path()
    if not data_path:
        return None
    return os.path.join(data_path, "MQL5", "Files", f"{ea_base}_config.set")


def _get_runtime_json_path(ea_name: str = None, data_path: str = None) -> str | None:
    """Path to MQL5/Files/<EA>_runtime.json, 按显式 data_path(绑定实例)解析。
    用于和 config.set 比 mtime 决定参数显示优先级。"""
    if ea_name is None:
        ea_name = _resolve_ea_filename()
    ea_base = os.path.splitext(ea_name)[0]
    if data_path is None:
        data_path = _get_mt5_data_path()
    if not data_path:
        return None
    return os.path.join(data_path, "MQL5", "Files", f"{ea_base}_runtime.json")


def _load_params_from_config_set(ea_name: str = None, data_path: str = None) -> dict | None:
    """Parse <EA>_config.set. Returns {param_name: value_str} or None."""
    path = _get_config_set_path(ea_name, data_path)
    if not path or not os.path.isfile(path):
        return None
    params: dict = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or s.startswith(";") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                k = k.strip()
                v = v.strip()
                if not k or k == "ts":
                    continue
                params[k] = v
    except Exception as exc:
        logging.warning(f"config.set parse failed ({path}): {exc}")
        return None
    return params or None


def _get_config_set_info(ea_name: str = None) -> dict | None:
    """Diagnostic snapshot of the config.set file."""
    path = _get_config_set_path(ea_name)
    if not path:
        return None
    result = {"path": path, "exists": os.path.isfile(path)}
    if result["exists"]:
        try:
            result["mtime"] = datetime.fromtimestamp(
                os.path.getmtime(path)
            ).strftime("%Y-%m-%d %H:%M:%S")
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                result["content"] = f.read()
        except Exception as exc:
            result["read_error"] = str(exc)
    return result


def _touch_reload_trigger(ea_name: str = None) -> dict:
    """Write current epoch to MQL5/Files/<EA>_reload.trigger so EA's OnTimer
    detects the bump and calls ChartSetSymbolPeriod to force reinit."""
    if ea_name is None:
        ea_name = _resolve_ea_filename()
    ea_base = os.path.splitext(ea_name)[0]
    data_path = _get_mt5_data_path()
    if not data_path:
        return {"ok": False, "error": "MT5 data_path unavailable"}
    trigger_path = os.path.join(data_path, "MQL5", "Files", f"{ea_base}_reload.trigger")
    try:
        os.makedirs(os.path.dirname(trigger_path), exist_ok=True)
        ts = int(time.time())
        with open(trigger_path, "w", encoding="ascii") as f:
            f.write(str(ts))
        return {"ok": True, "path": trigger_path, "ts": ts}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "path": trigger_path}


# ==================== 0.3.53: 参数设置 helpers ====================
#
# 配合「参数设置」UI 入口。原有的 update_strategy_param
# 只能一次改一个 key 到 config.set，UI 上让用户在表格里改 N 行参数后再调 N
# 次 MCP 不现实；新加 bulk write_ea_parameters 一次写一片。同时也要把同样
# 的值写到 MT5 canonical Presets/<EA>.set，让重新挂载 / 启动 Strategy Tester
# 时拿到的也是新值（不然热更 EA 关掉重开就回到老默认）。
# ================================================================================

_INPUT_RE = re.compile(
    r"^\s*s?input\s+([A-Za-z_]\w*(?:\s*\*)?)\s+([A-Za-z_]\w*)\s*"
    r"=\s*([^;]+?)\s*;\s*(?://\s*(.*?)\s*)?$"
)
_INPUT_GROUP_RE = re.compile(r"^\s*s?input\s+group\s+\"([^\"]+)\"\s*;?\s*$")


def _parse_ea_input_declarations(mq5_path: str) -> list[dict]:
    """Parse `input <type> <name> = <default>;` declarations from a .mq5 file.

    Returns a list of {name, type, default, comment, group, line} in declaration
    order. `group` tracks the most recent `input group "..."` annotation so the
    UI can render sections. `default` is the raw expression as written (string,
    e.g. "10", "0.5", "true", "\"hi\"", "PERIOD_H1"). The caller coerces.

    Returns empty list if file can't be read (caller falls back to .ex5-only
    manual-entry mode).
    """
    if not mq5_path or not os.path.isfile(mq5_path):
        return []
    text = _read_text_with_bom(mq5_path) if "_read_text_with_bom" in globals() else None
    if text is None:
        try:
            with open(mq5_path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except Exception:
            return []
    out: list[dict] = []
    cur_group = None
    for idx, raw in enumerate(text.splitlines(), start=1):
        gm = _INPUT_GROUP_RE.match(raw)
        if gm:
            cur_group = gm.group(1).strip()
            continue
        m = _INPUT_RE.match(raw)
        if not m:
            continue
        typ, name, default, comment = m.group(1), m.group(2), m.group(3), m.group(4)
        out.append({
            "name":     name,
            "type":     typ.replace(" ", "").replace("*", ""),
            "default":  default.strip(),
            "comment":  (comment or "").strip(),
            "group":    cur_group,
            "line":     idx,
        })
    return out


def _list_ea_inputs_tool(args: dict) -> list[TextContent]:
    """MCP tool: 解析 EA 源码，返回所有 input 声明的列表。供「参数设置」
    UI 自动填充参数表用。.ex5-only（无源码）场景返回 {ok:false, ex5_only:true}，
    让前端切到「手工填参数列表」分支。"""
    ea_arg = (args.get("ea_name") or "").strip()
    ea_filename = ea_arg if ea_arg else _resolve_ea_filename()
    if ea_filename and not ea_filename.lower().endswith(".mq5"):
        ea_filename += ".mq5"

    # 走跟 compile_strategy 同款的 EA .mq5 解析路径（workspace 优先，再 MT5 Experts/）
    mq5_path = None
    workspace_dir = os.getenv("EASYDEAL_WORKSPACE_DIR")
    if workspace_dir and ea_filename:
        cand = os.path.join(workspace_dir, "strategies", ea_filename)
        if os.path.isfile(cand):
            mq5_path = cand
    if not mq5_path:
        data_path = _get_mt5_data_path()
        if data_path and ea_filename:
            experts_root = os.path.join(data_path, "MQL5", "Experts")
            if os.path.isdir(experts_root):
                # flat 先看，再递归找
                flat = os.path.join(experts_root, ea_filename)
                if os.path.isfile(flat):
                    mq5_path = flat
                else:
                    target_lower = ea_filename.lower()
                    for root, _dirs, files in os.walk(experts_root):
                        for fn in files:
                            if fn.lower() == target_lower:
                                mq5_path = os.path.join(root, fn)
                                break
                        if mq5_path:
                            break
    # fallback：当前 EA 当前 chart 挂的
    if not mq5_path and not ea_arg:
        mq5_path = _get_strategy_file_path()

    if not mq5_path or not os.path.isfile(mq5_path):
        ea_base = os.path.splitext(ea_filename)[0] if ea_filename else "(unknown)"
        return [TextContent(type="text", text=json.dumps({
            "ok":        False,
            "ex5_only":  True,
            "ea_name":   ea_base,
            "error":     f"{ea_filename}.mq5 源码没找到 — .ex5-only 策略需要在 UI 手工填参数表",
        }, ensure_ascii=False))]

    inputs = _parse_ea_input_declarations(mq5_path)
    return [TextContent(type="text", text=json.dumps({
        "ok":         True,
        "ea_name":    os.path.splitext(os.path.basename(mq5_path))[0],
        "mq5_path":   mq5_path,
        "input_count": len(inputs),
        "inputs":     inputs,
    }, ensure_ascii=False, indent=2))]


def _detect_ea_hot_reload_support_tool(args: dict) -> list[TextContent]:
    """检测 EA 是否支持 MCP 热更新协议（轮询 <EA>_config.set + 写 <EA>_runtime.json）。
    判定证据：
      (a) runtime.json 文件存在且 mtime 在最近 30 分钟内（EA 正在跑 + 在主动写）
      (b) .mq5 源码里含「_config.set」或「_runtime.json」字符串（用了协议）
    任一命中即视为支持。两个都没命中 → 不支持，UI 写参数时需要弹「重新挂载」确认。"""
    ea_arg = (args.get("ea_name") or "").strip()
    ea_filename = ea_arg if ea_arg else _resolve_ea_filename()
    if ea_filename and not ea_filename.lower().endswith(".mq5"):
        ea_filename += ".mq5"
    ea_base = os.path.splitext(ea_filename)[0] if ea_filename else "(unknown)"

    evidence: list[str] = []
    supported = False

    # Evidence (a): runtime.json mtime
    data_path = _get_mt5_data_path()
    runtime_recent = False
    runtime_path = None
    if data_path:
        runtime_path = os.path.join(data_path, "MQL5", "Files", f"{ea_base}_runtime.json")
        if os.path.isfile(runtime_path):
            try:
                age_sec = time.time() - os.path.getmtime(runtime_path)
                if age_sec < 1800:  # 30 min
                    runtime_recent = True
                    supported = True
                    evidence.append(f"runtime.json 最近 {int(age_sec)}s 内被 EA 写过")
                else:
                    evidence.append(
                        f"runtime.json 存在但 mtime 已经 {int(age_sec/60)}min 前 — "
                        "EA 可能没在跑或已经摘了")
            except Exception:
                pass

    # Evidence (b): source code markers
    workspace_dir = os.getenv("EASYDEAL_WORKSPACE_DIR")
    src_path = None
    if workspace_dir:
        cand = os.path.join(workspace_dir, "strategies", ea_filename)
        if os.path.isfile(cand):
            src_path = cand
    if not src_path and data_path:
        flat = os.path.join(data_path, "MQL5", "Experts", ea_filename)
        if os.path.isfile(flat):
            src_path = flat
    if src_path:
        try:
            with open(src_path, "r", encoding="utf-8", errors="replace") as f:
                src_text = f.read()
            if "_config.set" in src_text or "_runtime.json" in src_text:
                supported = True
                evidence.append(f"源码引用了热更新协议文件名（{src_path}）")
        except Exception:
            pass

    return [TextContent(type="text", text=json.dumps({
        "ok":             True,
        "ea_name":        ea_base,
        "supported":      supported,
        "runtime_recent": runtime_recent,
        "runtime_path":   runtime_path,
        "src_path":       src_path,
        "evidence":       evidence,
        "advice": (
            "支持热更新 — 写 config.set 立刻生效，3 秒内 EA 会自己 reload + 刷 runtime.json"
            if supported else
            "不支持热更新 — 写 .set 后需要在 MT5 里把 EA 摘了重新挂（或重启 MT5），新参数才会生效"
        ),
    }, ensure_ascii=False, indent=2))]


def _write_ea_parameters_tool(args: dict) -> list[TextContent]:
    """批量写 EA 参数。
      params: {name: value} 字典，value 是字符串 / 数字 / bool。
      mode: "hot" (只写 config.set，假定 EA 支持热更新)
            "preset" (只写 Presets/<EA>.set，假定要重新挂载)
            "both" (两个都写，默认；EA 支持热更新时立刻生效 + 下次启动 / 重挂也用新值)

    .set 文件用 MT5 Presets/ 标准格式：`name=value` 每行一条。MCP 自己的
    config.set 用 `name=value` 同款格式（已有的 _load_params_from_config_set
    解析也是这个）。
    """
    ea_arg = (args.get("ea_name") or "").strip()
    ea_filename = ea_arg if ea_arg else _resolve_ea_filename()
    if ea_filename and not ea_filename.lower().endswith(".mq5"):
        ea_filename += ".mq5"
    ea_base = os.path.splitext(ea_filename)[0] if ea_filename else None
    if not ea_base:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "无法确定 EA name"}, ensure_ascii=False))]

    params = args.get("params") or {}
    if not isinstance(params, dict) or not params:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "params 必填且非空（{name: value} 字典）"},
            ensure_ascii=False))]

    mode = (args.get("mode") or "both").lower()
    if mode not in ("hot", "preset", "both"):
        mode = "both"

    # 1.2.26 多账户: 优先写到这只 EA 绑定实例的 data dir (main.js 注入 instance_id)。
    # _resolve_data_path_for_instance(None) 内部回退默认实例 = 老行为(没绑的 EA 零回归);
    # 传了 instance_id 但解析不出 → None → 再兜底默认实例, 不报错。
    data_path = _resolve_data_path_for_instance(args.get("instance_id")) or _get_mt5_data_path()
    if not data_path:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "MT5 data_path 未确定"}, ensure_ascii=False))]

    # 规范化 value 为字符串（bool → true/false，其它直接 str）
    def _fmt(v):
        if v is True:  return "true"
        if v is False: return "false"
        return str(v)
    serialized = {k: _fmt(v) for k, v in params.items()}

    written: list[dict] = []
    errors: list[str] = []

    # (a) config.set —— MCP 热更新通道
    if mode in ("hot", "both"):
        cfg_path = os.path.join(data_path, "MQL5", "Files", f"{ea_base}_config.set")
        try:
            existing: dict = {}
            if os.path.isfile(cfg_path):
                with open(cfg_path, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        s = line.strip()
                        if not s or s.startswith("#") or s.startswith(";") or "=" not in s:
                            continue
                        k, v = s.split("=", 1)
                        existing[k.strip()] = v.strip()
            existing.update(serialized)
            existing["ts"] = str(int(time.time()))
            os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
            with open(cfg_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(f"# auto-written by easydeal MCP write_ea_parameters @ {datetime.now().isoformat()}\n")
                for k, v in existing.items():
                    f.write(f"{k}={v}\n")
            written.append({"file": cfg_path, "kind": "config.set", "params": serialized})
            # 触发 reload — 已有助手
            try:
                _touch_reload_trigger(ea_filename)
            except Exception:
                pass
        except Exception as e:
            errors.append(f"写 config.set 失败: {e}")

    # (b) Presets/<EA>.set —— MT5 canonical .set，下次挂 EA + 启动 Strategy Tester 用
    if mode in ("preset", "both"):
        # Presets 目录可能有两份：MQL5/Presets/ (Strategy Tester) + MQL5/Profiles/Tester/
        # 但通用「右键挂 EA → Load」对话框默认看的是 MQL5/Presets/Tester/<EA>.set 或
        # MQL5/Presets/<EA>.set；这里写 MQL5/Presets/<EA>.set，覆盖率最高的位置。
        presets_dir = os.path.join(data_path, "MQL5", "Presets")
        preset_path = os.path.join(presets_dir, f"{ea_base}.set")
        try:
            # 读已有 .set merge 新值，保留没改的 key 不动
            existing_preset: dict = {}
            if os.path.isfile(preset_path):
                # MT5 .set 文件是 UTF-16 LE BOM。读的时候 utf-16 兼容
                try:
                    with open(preset_path, "rb") as f:
                        raw = f.read()
                    for enc in ("utf-16", "utf-8"):
                        try:
                            preset_text = raw.decode(enc)
                            break
                        except Exception:
                            preset_text = ""
                    for line in preset_text.splitlines():
                        s = line.strip().lstrip("﻿")
                        if not s or s.startswith(";") or s.startswith("#") or "=" not in s:
                            continue
                        k, v = s.split("=", 1)
                        # MT5 tester .set 里 value 可能形如 "10||1||1||100||N"
                        # —— 整段保留就行，下面只 override 用户改的那几条。
                        existing_preset[k.strip()] = v.strip()
                except Exception as e:
                    errors.append(f"读旧 preset 失败（保留新值覆盖）: {e}")
            existing_preset.update(serialized)
            # MT5 .set 标准是 UTF-16 LE BOM，CRLF line ending
            body_lines = [f"; auto-written by easydeal MCP write_ea_parameters @ {datetime.now().isoformat()}"]
            for k, v in existing_preset.items():
                body_lines.append(f"{k}={v}")
            body = "\r\n".join(body_lines) + "\r\n"
            os.makedirs(presets_dir, exist_ok=True)
            with open(preset_path, "wb") as f:
                f.write(b"\xff\xfe")
                f.write(body.encode("utf-16-le"))
            written.append({"file": preset_path, "kind": "preset.set", "params": serialized})
        except Exception as e:
            errors.append(f"写 Presets/.set 失败: {e}")

    return [TextContent(type="text", text=json.dumps({
        "ok":       not errors,
        "ea_name":  ea_base,
        "mode":     mode,
        "written":  written,
        "errors":   errors,
        "hint": (
            "config.set 已更新 + reload trigger 已触发，3s 内 EA 会自动 reload。"
            "Presets/.set 也写了，下次重启 / 重挂 EA 也用新值。"
            if not errors else
            "部分写入失败 — 看 errors 数组里的具体错误"
        ),
    }, ensure_ascii=False, indent=2))]


def _normalize_param_value(param_type: str, value: str) -> str:
    """Coerce new_value string to canonical representation based on MQL5 input type.
    Raises ValueError if value is malformed for the declared type."""
    v = (value or "").strip()
    t = (param_type or "").lower()
    if t == "bool":
        low = v.lower()
        if low in ("true", "1", "yes", "on"):
            return "true"
        if low in ("false", "0", "no", "off"):
            return "false"
        raise ValueError(f"bool param requires true/false, got '{value}'")
    if t in ("int", "long", "short", "uint", "ulong", "uchar", "char"):
        return str(int(v))
    if t in ("double", "float"):
        return str(float(v))
    return v


def _scan_chart_profiles_for_ea(ea_name: str = None) -> list[dict]:
    """Scan all .chr files that reference the given EA.

    Returns a list of {path, mtime, params} sorted by mtime descending (newest first).
    Used by both _load_params_from_chart_profiles (uses [0]) and diagnostics.
    """
    if ea_name is None:
        ea_name = _resolve_ea_filename()
    ea_ex5 = os.path.splitext(ea_name)[0] + ".ex5"

    try:
        info = mt5.terminal_info()
        if not info or not info.data_path:
            return []
    except Exception:
        return []

    charts_dir = os.path.join(info.data_path, "MQL5", "Profiles", "Charts")
    if not os.path.isdir(charts_dir):
        return []

    found = []
    for root, _dirs, files in os.walk(charts_dir):
        for fname in files:
            if not fname.lower().endswith(".chr"):
                continue
            chr_path = os.path.join(root, fname)
            content = None
            for enc in ("utf-16-le", "utf-16", "utf-8"):
                try:
                    with open(chr_path, "r", encoding=enc, errors="replace") as f:
                        content = f.read()
                    break
                except Exception:
                    continue
            if content is None or ea_ex5.lower() not in content.lower():
                continue

            inputs_match = re.search(
                r'<inputs>\s*\n(.*?)\n\s*</inputs>',
                content, re.DOTALL | re.IGNORECASE
            )
            if not inputs_match:
                continue

            params = {}
            for line in inputs_match.group(1).splitlines():
                line = line.strip()
                if not line or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if key:
                    params[key] = value
            if not params:
                continue

            try:
                mtime = os.path.getmtime(chr_path)
            except OSError:
                mtime = 0.0
            found.append({"path": chr_path, "mtime": mtime, "params": params})

    found.sort(key=lambda x: x["mtime"], reverse=True)
    return found


def _load_params_from_chart_profiles(ea_name: str = None) -> dict | None:
    """Return EA input params, preferring EA-dumped runtime JSON over .chr.

    Resolution order:
    1. MQL5/Files/<EA>_runtime.json (written by EA OnInit — always current)
    2. Newest .chr file under MQL5/Profiles/Charts (can be stale)
    """
    runtime = _load_params_from_runtime_json(ea_name)
    if runtime:
        logging.info(f"Loaded {len(runtime)} EA params from runtime JSON")
        return runtime

    candidates = _scan_chart_profiles_for_ea(ea_name)
    if not candidates:
        return None
    picked = candidates[0]
    logging.info(
        f"Loaded {len(picked['params'])} EA params from chart profile: {picked['path']} "
        f"(mtime={datetime.fromtimestamp(picked['mtime']).strftime('%Y-%m-%d %H:%M:%S')})"
    )
    return picked["params"]


def _get_mt5_data_path() -> str | None:
    """Get MT5 data_path from terminal_info, or None."""
    try:
        info = mt5.terminal_info()
        if info and info.data_path:
            return info.data_path
    except Exception:
        pass
    return None


def _read_mt5_log(log_dir: str, date_str: str, keyword: str = None,
                   page_size: int = 50, page: int = 1) -> dict:
    """Read an MT5 log file with reverse pagination.

    page=1 returns the latest page_size lines, page=2 the previous batch, etc.
    """
    date_compact = date_str.replace("-", "")
    log_path = os.path.join(log_dir, f"{date_compact}.log")

    if not os.path.isfile(log_path):
        available = []
        if os.path.isdir(log_dir):
            available = sorted(
                [f[:-4] for f in os.listdir(log_dir) if f.endswith(".log") and f[:-4].isdigit()],
                reverse=True
            )[:10]
        return {"error": f"Log file not found: {log_path}", "available_dates": available}

    # Read file with encoding detection. MT5 writes UTF-16 (often BE with BOM
    # 0xFE 0xFF, sometimes LE 0xFF 0xFE). Earlier impl assumed LE and only
    # rejected based on a NUL heuristic, which silently corrupted BE files.
    try:
        with open(log_path, "rb") as f:
            raw = f.read()
    except Exception as e:
        return {"error": f"Failed to read log file: {log_path}: {e}"}

    content = None
    if raw.startswith(b"\xff\xfe"):
        content = raw[2:].decode("utf-16-le", errors="replace")
    elif raw.startswith(b"\xfe\xff"):
        content = raw[2:].decode("utf-16-be", errors="replace")
    elif raw.startswith(b"\xef\xbb\xbf"):
        content = raw[3:].decode("utf-8", errors="replace")
    else:
        sample = raw[:1024]
        half = len(sample) // 2
        if half:
            zeros_even = sum(1 for i in range(0, half * 2, 2) if sample[i] == 0)
            zeros_odd = sum(1 for i in range(1, half * 2, 2) if sample[i] == 0)
            if zeros_even / half > 0.3:
                content = raw.decode("utf-16-be", errors="replace")
            elif zeros_odd / half > 0.3:
                content = raw.decode("utf-16-le", errors="replace")
        if content is None:
            for enc in ("utf-8", "gbk", "latin-1"):
                try:
                    content = raw.decode(enc, errors="replace")
                    break
                except Exception:
                    continue

    if content is None:
        return {"error": f"Failed to decode log file: {log_path}"}

    content = content.replace("\x00", "")
    lines = [l.strip() for l in content.splitlines() if l.strip()]

    if keyword:
        keyword_lower = keyword.lower()
        lines = [l for l in lines if keyword_lower in l.lower()]

    total = len(lines)
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = max(1, min(page, total_pages))

    # Reverse pagination: page 1 = tail, page 2 = before that, ...
    end_idx = total - (page - 1) * page_size
    start_idx = max(0, end_idx - page_size)
    page_lines = lines[start_idx:end_idx]

    return {
        "file": log_path,
        "date": date_str,
        "total_lines": total,
        "page": page,
        "total_pages": total_pages,
        "page_size": page_size,
        "lines": page_lines
    }


def _read_ea_source_summary(max_lines: int = 200) -> str:
    """Read EA source summary: input params section + first N lines of core logic.

    Returns a truncated source string suitable for LLM context.
    """
    filepath = _get_strategy_file_path()
    if not os.path.isfile(filepath):
        return ""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return ""

    # Collect input section (all lines starting with 'input ')
    input_lines = []
    for i, line in enumerate(lines):
        if line.strip().startswith("input "):
            input_lines.append(f"{i+1}: {line.rstrip()}")

    # Collect first max_lines of logic (after includes/properties)
    logic_start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith("//") and not stripped.startswith("#") and not stripped.startswith("input "):
            if "OnTick" in stripped or "OnInit" in stripped or "void " in stripped or "int " in stripped or "double " in stripped:
                logic_start = i
                break

    logic_lines = []
    for i in range(logic_start, min(logic_start + max_lines, len(lines))):
        logic_lines.append(f"{i+1}: {lines[i].rstrip()}")

    parts = []
    if input_lines:
        parts.append("=== Input Parameters ===\n" + "\n".join(input_lines))
    if logic_lines:
        parts.append(f"=== Core Logic (line {logic_start+1}-{logic_start+len(logic_lines)}) ===\n" + "\n".join(logic_lines))

    return "\n\n".join(parts)


def _get_param_diff() -> list[dict]:
    """Compare source code default params vs runtime params from chart profile.

    Returns list of {name, source_value, runtime_value} for differing params.
    """
    # Source defaults
    filepath = _get_strategy_file_path()
    if not os.path.isfile(filepath):
        return []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return []
    source_params = {p["name"]: p["value"] for p in _parse_input_params(content)}

    # Runtime params
    runtime = _load_params_from_chart_profiles()
    if not runtime:
        return []

    diffs = []
    for name, source_val in source_params.items():
        runtime_val = runtime.get(name)
        if runtime_val is not None and str(runtime_val).strip() != str(source_val).strip():
            diffs.append({
                "name": name,
                "source_default": source_val,
                "runtime_value": runtime_val,
            })
    return diffs


def _get_backup_dir() -> str:
    """Return the backup directory for strategy files."""
    src = _get_strategy_file_path()
    backup_dir = os.path.join(os.path.dirname(src), ".ea_backups")
    os.makedirs(backup_dir, exist_ok=True)
    return backup_dir


def _get_backup_manifest_path() -> str:
    return os.path.join(_get_backup_dir(), "manifest.json")


def _load_backup_manifest() -> list[dict]:
    path = _get_backup_manifest_path()
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_backup_manifest(entries: list[dict]) -> None:
    path = _get_backup_manifest_path()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)


def _backup_strategy(change_note: str = "") -> str:
    """Create a timestamped backup with optional change note. Returns backup path."""
    src = _get_strategy_file_path()
    ts = _now_bj().strftime("%Y%m%d_%H%M%S")
    backup_dir = _get_backup_dir()
    ea_basename = os.path.basename(src)
    dst = os.path.join(backup_dir, f"{ea_basename}.{ts}.bak")
    shutil.copy2(src, dst)

    # Update manifest
    manifest = _load_backup_manifest()
    manifest.append({
        "timestamp": _now_bj_str(),
        "file": os.path.basename(dst),
        "source": ea_basename,
        "change_note": change_note or "",
    })
    _save_backup_manifest(manifest)
    return dst


def _get_metaeditor_path() -> str:
    """Get MetaEditor64.exe path.

    Resolution order:
    1. METAEDITOR_PATH env var (manual override)
    2. EASYDEAL_MT5_INSTALL_DIR env var (set by easydeal-client) — works
       even when MT5 is not running, which is the common case for
       chat-driven EA creation.
    3. mt5.terminal_info().path (only if MT5 is currently initialised)
    """
    env_path = os.getenv("METAEDITOR_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path

    install_dir = os.getenv("EASYDEAL_MT5_INSTALL_DIR")
    if install_dir:
        for name in ("MetaEditor64.exe", "metaeditor64.exe", "MetaEditor.exe"):
            candidate = os.path.join(install_dir, name)
            if os.path.isfile(candidate):
                return candidate

    try:
        info = mt5.terminal_info()
        if info and info.path:
            candidate = os.path.join(info.path, "MetaEditor64.exe")
            if os.path.isfile(candidate):
                return candidate
    except Exception:
        pass

    return ""


# ============== MCP 工具定义 ==============

# ============== MCP tools ==============

def get_all_tools() -> list[Tool]:
    """Return all available MCP tools."""
    return [
        Tool(
            name="get_monitor_logs",
            description=(
                "获取 MCP 监控服务自身的日志（含持仓变动、告警、风控事件等）。从 logs/easydeal.log 读取。"
                "\n0.3.235: 此日志是 EasyDeal 客户端进程自身的（跨所有 MT5 实例），不需要 instance_id。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "Date in YYYY-MM-DD; defaults to today.",
                        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                    },
                    "type": {
                        "type": "string",
                        "description": "Log filter.",
                        "enum": ["ALL", "OPEN", "CLOSE", "UPDATE", "WARNING", "ERROR"],
                        "default": "ALL"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of lines from the end.",
                        "default": 100
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_mt5_logs",
            description=(
                "获取 MT5 终端日志（连接状态、订单执行回报等）。从 MT5 数据目录 Logs/ 读取，倒序分页（page=1 最新）。"
                "\n0.3.235: 多 MT5 用户传 instance_id 指定看哪个实例的日志（先 list_mt5_instances 拿 id）。"
                "不传 = 默认实例。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instance_id": {
                        "type": "string",
                        "description": "0.3.235: MT5 实例 ID（list_mt5_instances 拿到）。不传 = 默认实例。"
                    },
                    "date": {
                        "type": "string",
                        "description": "日期 YYYY-MM-DD，默认今天。",
                        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                    },
                    "keyword": {
                        "type": "string",
                        "description": "关键词过滤（如品种名、order、error），不填返回全部。"
                    },
                    "page": {
                        "type": "integer",
                        "description": "页码，1=最新一页，2=往前翻，默认 1。",
                        "default": 1
                    },
                    "page_size": {
                        "type": "integer",
                        "description": "每页行数，默认 50。",
                        "default": 50
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_ea_logs",
            description=(
                "获取 EA 策略的 Print() 输出日志（交易决策、开平仓、马丁触发等）。从 MT5 数据目录 MQL5/Logs/ 读取，倒序分页（page=1 最新）。"
                "\n0.3.235: 多 MT5 用户传 instance_id — 绑了非默认 instance 的 EA 必须传，否则只能看默认实例的 EA 日志。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instance_id": {
                        "type": "string",
                        "description": "0.3.235: MT5 实例 ID（list_mt5_instances 拿到）。不传 = 默认实例。"
                    },
                    "date": {
                        "type": "string",
                        "description": "日期 YYYY-MM-DD，默认今天。",
                        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                    },
                    "keyword": {
                        "type": "string",
                        "description": "关键词过滤（如 martin、ladder、breakeven、error），不填返回全部。"
                    },
                    "page": {
                        "type": "integer",
                        "description": "页码，1=最新一页，2=往前翻，默认 1。",
                        "default": 1
                    },
                    "page_size": {
                        "type": "integer",
                        "description": "每页行数，默认 50。",
                        "default": 50
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_trading_status",
            description=(
                "查看指定 MT5 实例的盘面情况：账户余额/净值、持仓订单明细、"
                "市场行情快照（价格/点差）、策略状态。用于回答『盘面怎么样』『持仓情况』"
                "『账户状态』等问题。不传 instance_id = 看默认实例。"
                "0.3.120: 每条持仓自动带 `_ea` 字段（按 magic+symbol 反推所属 EA）。返回新增 "
                "`orders.all_positions_by_ea` + `orders.untracked_positions` + `ea_configs_loaded`。"
                "\n\n0.3.134 ⚠ **重要 — 任何向用户报盘面/持仓状态前必须先 call 一次此工具**："
                "持仓状态 1 分钟内可能完全反转（SL/TP 触发、用户手动平仓、护航拦截）。"
                "**禁止**根据 5 分钟前的工具输出生成报告，更**禁止**根据对话历史里的旧持仓数据汇报。"
                "返回的 `market_data.time` 是**北京时间**快照（与顶层 as_of 同），**汇报时必须显式引用**"
                "（如『截至 10:28:00 持有 1 笔多单』），让用户清楚数据时效。另含 `server_time`"
                "（券商服务器交易时段时钟）与 `broker_offset_hours`（券商相对 UTC 偏移小时数）。"
                "⚠ get_klines 返回的 K 线 `bars[].time` 也是**北京时间**，可直接与 market_data.time / "
                "now_bj 比较判断新旧；每根另带 `closed`（是否已收盘）与 `time_server`（券商时间），"
                "**不会再出现「未来 K 线」假象**。"
                "\n\n0.3.235 ⚠ **多 MT5 用户**：要么用 list_all_mt5_status 一次拿全部聚合, "
                "要么按实例分别调此工具（传 instance_id）。**绝对不能**只调一次默认实例就当全局汇报。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instance_id": {"type": "string", "description": "0.3.235: MT5 实例 ID（list_mt5_instances 拿）。不传 = 默认实例。多 MT5 用户优先 list_all_mt5_status。"}
                },
                "required": []
            }
        ),
        Tool(
            name="list_all_mt5_status",
            description=(
                "0.3.235: 一次性返回所有 MT5 实例的盘面聚合 — 账户余额/净值/持仓 等. "
                "**多 MT5 用户回答账户状态时优先用此工具**, 而不是 get_trading_status "
                "(后者只看默认实例). 返回结构: `{instances: [{instance_id, instance_name, "
                "running, account, positions, error?}, ...], summary: {total_balance, "
                "total_floating, instance_count}}`. 单 MT5 用户也兼容 (instances 列表里只一项). "
                "如某实例 MT5 没在跑 (running=false), 该项 account=null 但 instance 元信息仍返."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instance_ids": {"type": "array", "items": {"type": "string"},
                                     "description": "只看这些实例 ID（list_mt5_instances 拿）。不传 = 全部实例。"}
                },
                "required": []
            }
        ),
        Tool(
            name="get_economic_calendar",
            description=(
                "查经济日历(财经数据日历) — MT5 内 EasyDealCalendar EA 直传到 EasyDeal 服务端的, "
                "含已发布 + 未来约一周的经济数据(CPI/非农/利率决议 等), 每条带 货币/国家/重要性/实际/预测/前值。"
                "回答『今晚/本周有什么重要数据』『XAUUSD/美元/我持仓品种 有什么消息』时用。"
                "\n\n**历史模式**: 传 from_date/to_date/days_back/query 任一 → 查服务端去重历史归档"
                "(窗口已滑走的过往数据也在), 回答『上个月非农数据是多少』『过去三个月美国CPI走势』时用。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "currencies": {"type": "array", "items": {"type": "string"}, "description": "只返这些货币(如 ['USD','EUR'])。不传=全部。"},
                    "symbol": {"type": "string", "description": "交易品种(如 XAUUSDm)→ 自动解析相关货币筛选(XAU/黄金→USD, EURUSD→EUR+USD)。"},
                    "importance": {"type": "string", "enum": ["low", "moderate", "high"], "description": "最低重要性, 只返 >= 此级别。"},
                    "hours_ahead": {"type": "integer", "description": "只返未来这么多小时内的(含过去 24h)。不传=全部窗口。仅临近模式。"},
                    "limit": {"type": "integer", "description": "最多返回条数(默认 60; 历史模式默认 200, 上限 1000)。"},
                    "from_date": {"type": "string", "description": "历史模式: 起始日期 'YYYY-MM-DD'(北京时间)。不传但给了其它历史参数=近90天。"},
                    "to_date": {"type": "string", "description": "历史模式: 截止日期 'YYYY-MM-DD'(含当天)。"},
                    "days_back": {"type": "integer", "description": "历史模式快捷: 查最近 N 天(与 from_date 二选一)。"},
                    "query": {"type": "string", "description": "历史模式: 事件标题子串过滤(如 '非农' / 'CPI' / '利率决议')。"}
                },
                "required": []
            }
        ),
        Tool(
            name="get_market_info",
            description=(
                "获取当前交易品种的实时行情数据：买卖价、点差、涨跌幅、波动率等。用于回答『行情如何』『价格多少』『市场波动』等问题。"
                "\n\n⚠ **多 MT5 必传 instance_id** — 同 symbol 在不同 broker 价格/点差差异大. "
                "用户问「mt5-2 / EasyDeal MT5 3 上 broker 行情」时必须传该实例 ID, 不传查的是默认实例."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instance_id": {"type": "string", "description": "⚠ 多 MT5 必传 — 实例 ID (list_mt5_instances 拿). 不传 = 默认实例."}
                },
                "required": []
            }
        ),
        Tool(
            name="get_retail_sentiment",
            description=(
                "查询某品种的散户情绪 —— myfxbook 社区的散户多空持仓占比(long%/short%)。"
                "symbol 支持**前缀匹配**: broker 符号带后缀(XAUUSDm / EURUSD.pro)也能命中干净名(XAUUSD/EURUSD)。"
                "用例: 用户问『XAU 散户怎么看 / 多空比』、或决策/复盘时把散户情绪当**反向指标**参考"
                "(散户极度一边倒时常是反向信号)。数据由服务端每 30min 抓一次。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "品种, 如 XAUUSD / XAUUSDm / EURUSD / BTCUSD / US30"}
                },
                "required": ["symbol"]
            }
        ),
        Tool(
            name="list_recent_news",
            description=(
                "拉取金十数据的实时金融快讯。EasyDeal 主进程每 30s 从 jin10.com 抓最新一批写到本地: "
                "近期 200 条在 ring buffer (快查), 全量按日 append 到 <data>/news/YYYY-MM-DD.jsonl "
                "(永久存档). 此工具自动判断: minutes_back <= 60 直接读 buffer; > 60 扫 daily files 跨日合并 + 去重. "
                "返回数组里每条含 time/important/content/tags/remark 等字段. 用例: 用户问『最近有什么新闻』、"
                "AI 决策前查 30 分钟内有没有 FOMC/CPI/突发地缘事件、回测分析对照异常时段的新闻、"
                "复盘几天/几周前某波行情背后的新闻驱动. 重要事件 important=1."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "minutes_back": {
                        "type": "integer",
                        "description": "回溯多少分钟（默认 30，最大 43200 = 30 天）。> 60 自动跨日扫 daily archive.",
                        "default": 30,
                    },
                    "keyword_filter": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选关键词数组（任一命中即返）；不传 = 全部返回",
                    },
                    "important_only": {
                        "type": "boolean",
                        "description": "true = 只返回 important=1 的高优先级快讯",
                        "default": False,
                    },
                    "max_items": {
                        "type": "integer",
                        "description": "最多返回多少条（默认 30，硬上限 500）",
                        "default": 30,
                    },
                },
                "required": [],
            },
        ),
        Tool(
            name="get_klines",
            description=(
                "获取 K 线 OHLC 数据。支持多种时图（M1/M5/M15/M30/H1/H4/D1/W1/MN1）和任意条数。"
                "默认从最近已收盘那根向前取。用于波动率分析、回放行情、判断趋势强弱等。"
                "\n\n⚠ **多 MT5 必传 instance_id** — 不同 broker 同 symbol 价格不一样, 不传查的是默认实例."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instance_id": {"type": "string", "description": "⚠ 多 MT5 必传 — 实例 ID (list_mt5_instances 拿). 不传 = 默认实例."},
                    "timeframe": {
                        "type": "string",
                        "description": "时图：M1/M5/M15/M30/H1/H4/D1/W1/MN1，默认 H1",
                        "default": "H1"
                    },
                    "count": {
                        "type": "integer",
                        "description": "返回的 K 线条数，默认 2，最大 500",
                        "default": 2
                    },
                    "include_current": {
                        "type": "boolean",
                        "description": "是否包含当前未收盘的那根 bar，默认 false（只返回已收盘 bar）",
                        "default": False
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_config",
            description="获取监控配置及 EA 运行参数。参数按优先级合并：runtime_json (EA 实际运行值) > config_set (MCP 写入的热更新覆盖) > 源码默认值。同时返回 EA 源码路径和 MetaEditor 路径。",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_strategy_documentation",
            description="基于日志/订单/参数/对话等信息推测并生成策略的判断与描述。",
            inputSchema={
                "type": "object",
                "properties": {
                    "conversation": {"type": "string", "description": "Optional conversation context."},
                    "conversation_path": {"type": "string", "description": "Optional path to a conversation log file."}
                },
                "required": []
            }
        ),
        Tool(
            name="get_profit_history",
            description=(
                "Get profit history and summary for a time window. "
                "0.3.97: 默认返回所有 EA 的 deal（之前 hardcode 只看 magic=999 → 大部分用户看到 0 笔）。"
                "0.3.119: 推荐传 ea_name — 客户端在「我的策略 → 📡 监控配置」存了每个 EA 的 "
                "magic + symbol，工具自动按 EA 精准过滤。可选 magic_filter 是更底层的覆盖，传了优先级最高。"
                "\n\n⚠ **多 MT5 必传 instance_id** — 每个 broker 一份独立成交历史. 不传查的是默认实例的, "
                "其他实例的 EA 表现全看不到."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instance_id": {"type": "string", "description": "⚠ 多 MT5 必传 — 实例 ID (list_mt5_instances 拿). 不传 = 默认实例的成交历史."},
                    "days": {"type": "integer", "description": "Lookback days", "default": 30},
                    "start_time": {"type": "string", "description": "YYYY-MM-DD HH:MM:SS"},
                    "end_time": {"type": "string", "description": "YYYY-MM-DD HH:MM:SS"},
                    "ea_name": {
                        "type": "string",
                        "description": "0.3.119: EA 名字（不带 .mq5/.ex5 后缀）。从客户端 .easydeal-ea-monitor.json 拿这只 EA 的 magic/symbol/comment 过滤器精准筛 deal。比记 magic 数字直接。",
                    },
                    "magic_filter": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "可选 magic 白名单 — 只统计这些 magic 的 deal。空 / 不传 = 所有 magic 或走 ea_name。优先级最高。",
                    },
                },
                "required": []
            }
        ),
        # ---------- OrderGuard 只读 proxy (1.0.11) — HTTP 读长驻护航服务, AI 廉价拿交易/拦截状态 ----------
        Tool(
            name="get_orderguard_status",
            description=(
                "读护航(OrderGuard)整体战绩：审批/拦截/调手数总数、拦截率、已平仓累计盈亏与胜率、"
                "24h 决策数、平仓/改单/SL外扩计数，外加当前启用护航的 EA 列表及模式。**只读**，走护航服务"
                "本地 HTTP 缓存，几乎零成本、不触发 MT5 IPC。用户问『护航拦了多少单 / 拦截率 / 护航战绩 / "
                "哪些 EA 在护航』时用这个。护航没启用会返 orderguard_available=false（这时引导用户去"
                "「策略 → 🛡 护航」启用）。"
            ),
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_orderguard_decisions",
            description=(
                "读护航最近的决策日志（每条含 EA、op=开/平/改、intent、放行/拦截、原因、请求/批准手数、时间）。"
                "**只读**、cheap。用户问『护航最近拦了啥 / 最近的决策 / 某 EA 被拦过吗』时用。可选按 EA 过滤、限制条数。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "返回最近多少条，默认 30，最大 500", "default": 30},
                    "ea_name": {"type": "string", "description": "可选：只看某个 EA 的决策"}
                },
                "required": []
            }
        ),
        Tool(
            name="get_orderguard_stats",
            description=(
                "读护航按 EA / intent 聚合的统计（各 EA 的胜率、平均盈亏、笔数等）。**只读**、cheap。"
                "用户问某 EA 在护航下的表现 / 各策略对比时用。"
            ),
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        # ---------- per-EA 经验笔记 (每日总结 + AI 主动记 + 远程同步) ----------
        Tool(
            name="record_experience",
            description=(
                "把某只 EA 的【经验】追加进它的经验笔记(<workspace>/strategies/<EA>.experience.md, 一只 EA 一份, "
                "append-only 带日期)。**发现值得长期记住的东西时主动调**: 人工介入(手动平/改单、暂停交易、改参数及原因)、"
                "运作规律(这只 EA 啥行情好/差、马丁到第几层危险、新闻前要不要停)、教训、用户偏好。"
                "下次挂载 / 护航分析 / 远程协助时会被读回当上下文, 让 AI 真正延续这只 EA 的操盘经验。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA 名(可带或不带后缀); 省略则用当前/默认 EA"},
                    "content": {"type": "string", "description": "要记的经验, 一两句话, 具体可执行(带数字/条件最好)"},
                    "category": {"type": "string", "description": "可选分类: 人工介入 / 运作 / 教训 / 偏好 / 其他"}
                },
                "required": ["content"]
            }
        ),
        Tool(
            name="read_experience",
            description=(
                "读某只 EA 的经验笔记(历史人工介入 + 运作规律 + 教训)。**分析该 EA / 做决策 / 挂载前 / 远程协助前先读一遍**, "
                "避免重复踩坑、延续之前的操盘经验。省略 ea_name 则读当前/默认 EA。"
            ),
            inputSchema={
                "type": "object",
                "properties": {"ea_name": {"type": "string", "description": "EA 名; 省略则当前/默认 EA"}},
                "required": []
            }
        ),
        Tool(
            name="get_floating_drawdown",
            description=(
                "读某只 EA 的【浮亏时序回撤】(本地存的, ~90 天 hourly): 当前浮亏 / 窗口内浮亏峰-谷 / 最深浮亏值 + 时刻。"
                "**评估某 EA 历史最大浮亏 / 马丁组扛单深度 / 风险敞口时用** — 比仅看当前持仓盈亏全面得多, 因为抓得到过去某次马丁扛到第几层、浮亏多深、何时发生。"
                "用户问『XX 历史最大浮亏 / 马丁组开出时风险』之类问题就调这个。省略 ea_name 则用当前 EA。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA 名(可带或不带后缀); 省略则用当前/默认 EA"},
                    "window": {
                        "type": "string",
                        "description": "时间窗: 24h / 7d / 30d / all (默认 all = 最近 ~90 天硬上限内全量)",
                        "enum": ["24h", "7d", "30d", "all"]
                    }
                },
                "required": []
            }
        ),
        # ---------- Strategy script improvement tools ----------
        Tool(
            name="read_strategy_source",
            description="读取当前 EA 的 .mq5 策略源码（带行号）。EA 文件由 chart auto-detect / EA_FILENAME / EA_FILE_PATH 解析。可指定行范围以减少输出量。",
            inputSchema={
                "type": "object",
                "properties": {
                    "start_line": {"type": "integer", "description": "起始行号（从1开始），默认1", "default": 1},
                    "end_line": {"type": "integer", "description": "结束行号（含），默认读到末尾"}
                },
                "required": []
            }
        ),
        Tool(
            name="get_strategy_params",
            description="获取 EA 所有 input 参数的完整视图：同时返回 runtime_json (EA OnInit/OnTimer 写入, 最准)、config_set (MCP 热更新覆盖) 与源码默认值，并标注当前生效值(effective_value)。参数读不准时首选此工具。不传 ea_name=用当前/默认 EA。多账户务必带 instance_id, 否则读到默认实例的旧值。",
            inputSchema={"type": "object", "properties": {
                "ea_name": {"type": "string", "description": "EA 文件名(可含/不含 .mq5)。不传=当前激活 EA"},
                "instance_id": {"type": "string", "description": "EA 绑定的 MT5 实例 id；多账户必带, 否则读默认实例"},
            }, "required": []}
        ),
        Tool(
            name="update_strategy_param",
            description=(
                "热更新 EA 运行时参数：向 MQL5/Files/<EA>_config.set 写入 k=v 覆盖项（<EA> 为当前 EA 文件名去掉后缀）。"
                "EA 每 3 秒轮询该文件，检测到 mtime 变化自动加载新值并刷新 runtime.json，"
                "无需重编译、无需重挂图表。param_name 必须是当前 EA .mq5 中 input 声明的变量名（如 InpFirstLots, InpIsPaused, InpMagicNumber）。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "param_name": {"type": "string", "description": "input 变量名（如 InpFirstLots, InpStep, InpIsPaused）"},
                    "new_value": {"type": "string", "description": "新值（字符串形式，如 \"0.02\", \"true\", \"5\"）"}
                },
                "required": ["param_name", "new_value"]
            }
        ),
        Tool(
            name="patch_strategy_code",
            description="在当前 EA 的 .mq5 源码中搜索替换代码。confirm=false 仅预览匹配，confirm=true 执行替换（自动备份）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "search": {"type": "string", "description": "要搜索的代码片段（精确匹配）"},
                    "replace": {"type": "string", "description": "替换为的代码片段"},
                    "confirm": {"type": "boolean", "description": "false=仅预览，true=执行替换", "default": False}
                },
                "required": ["search", "replace"]
            }
        ),
        Tool(
            name="compile_strategy",
            description=(
                "【开发期编译工具 · 非查询工具】调用 MetaEditor64 对指定 EA 的 .mq5 源码做语法编译，"
                "返回编译器 stderr/stdout。仅在『修改策略代码后需要重新编译』这一场景下使用。"
                "**强烈建议传 ea_name 参数指定要编译的 EA**——不传时回落到"
                "『chart 上挂的 EA』的旧行为，对刚创建、还没挂图表的新 EA 会编译错文件。"
                "禁止用于：查看行情/价格/点差/K线 → 请改用 get_market_info；"
                "查看账户/持仓/订单/盘面状态 → 请改用 get_trading_status；"
                "查看策略运行/信号 → 请改用 get_strategy_status。"
                "此工具无任何查询能力，调用它不会得到市场数据。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {
                        "type": "string",
                        "description": "要编译的 EA 名（不带 .ex5 / .mq5 后缀，如 'GoldTrendMartinV1'）。会先在 workspace/strategies/ 找源码、复制到 MQL5/Experts/，再编译。"
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_strategy_backups",
            description="获取 EA 策略的历史备份版本列表（含时间戳和变更说明）。可查看指定版本的源码内容。",
            inputSchema={
                "type": "object",
                "properties": {
                    "version_file": {
                        "type": "string",
                        "description": "指定备份文件名以查看其内容（从列表中选取）。不填则返回版本列表。"
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "查看备份内容时的起始行号，默认 1。",
                        "default": 1
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "查看备份内容时的结束行号，默认 50。",
                        "default": 50
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="diagnose_params_sources",
            description="诊断 EA 参数各来源的实际状态：runtime_json (EA 真实值)、config_set (MCP 覆盖)、源码默认值，以及仅供参考的 .chr 图表快照。当 get_strategy_params 读到的值和 MT5 图表上显示的不一致时，用此工具排查。",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="list_ea_inputs",
            description=(
                "0.3.53: 解析 EA 的 .mq5 源码，返回所有 `input` 声明列表（name/type/default/comment/group）。"
                "供「参数设置」UI 自动填充参数表用。.ex5-only 策略（无源码）返回 "
                "{ok:false, ex5_only:true}，前端切到手工填参数列表的分支。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA 名（不带 .mq5）；不传 = 当前 chart 挂的 EA"},
                },
                "required": [],
            },
        ),
        Tool(
            name="detect_ea_hot_reload_support",
            description=(
                "0.3.53: 检测 EA 是否支持 MCP 热更新协议（轮询 config.set + 写 runtime.json）。"
                "返回 {supported, evidence, advice}。supported=true → 写 config.set 立刻生效；"
                "false → 需要重新挂载 / 重启 MT5 新参数才生效。前端用这个决定保存参数后是否弹"
                "「请到 MT5 把 EA 摘了重新挂」的确认对话框。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA 名；不传 = 当前 chart 挂的 EA"},
                },
                "required": [],
            },
        ),
        Tool(
            name="write_ea_parameters",
            description=(
                "0.3.53: 批量写 EA 参数。比 update_strategy_param 一次只能改一个 key 快很多 —— "
                "UI 表格让用户改 N 行后一次提交。同时写两份：(a) MQL5/Files/<EA>_config.set（热更"
                "新通道，EA 支持的话立刻生效）；(b) MQL5/Presets/<EA>.set（MT5 canonical，下次"
                "重新挂载 / 启动 Strategy Tester 用）。mode 默认 both；可以 'hot' 只写 config.set、"
                "'preset' 只写 .set 来更精细控制。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name": {"type": "string", "description": "EA 名；不传 = 当前 chart 挂的 EA"},
                    "params":  {"type": "object", "description": "{参数名: 值} 字典；值可以是字符串 / 数字 / bool"},
                    "mode":    {"type": "string", "enum": ["hot", "preset", "both"], "default": "both",
                                 "description": "hot=只写 config.set；preset=只写 .set；both=两个都写"},
                },
                "required": ["params"],
            },
        ),
        Tool(
            name="panic_stop_all",
            description=(
                "🛑 **用户喊「停下来 / 全停 / cancel / stop all / 取消所有」时第一动作就调这个**。"
                "彻底停下：所有 running/queued 回测标 cancelled + kill spawn 进程树；"
                "删 scheduler.db 里全部 t_* 用户调度任务（轮询 cron 等）；置 30s panic.flag 防你立刻重启。"
                "**调完只汇报，不要再调任何工具**。30 秒内 run_backtest 会被 preflight 拒绝。"
                "用户明确说要重新跑某只再调 run_backtest（要等冷却期过）。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "可选 — 用户停下的原因（如 'too_many_iterations' / 'user_changed_mind'）",
                    },
                },
                "required": [],
            },
        ),
        Tool(
            name="run_backtest",
            description=(
                "使用 wind-tunnel-skill 对工作区 EA 的 Python 适配器做连续真实 Tick 回放。"
                "先按 Skill 移植源码，在 analysis/adapters/<EA>/<MQ5的SHA256>/strategy.py 保存该版本适配器。"
                "未指定日期时运行最近一个可用周。返回 backtest_id，可查状态、报告及实际指标。"
            ),
            inputSchema={
                "type": "object", "additionalProperties": False,
                "properties": {
                    "ea_name": {"type": "string", "description": "工作区 strategies 下的 EA 名"},
                    "symbol": {"type": "string", "description": "默认 XAUUSDm。其他品种从工作区 analysis/ticks/<symbol> 读取"},
                    "from_date": {"type": "string", "format": "date", "description": "含首尾，须与 to_date 同传"},
                    "to_date": {"type": "string", "format": "date"},
                    "deposit": {"type": "number", "exclusiveMinimum": 0, "default": 10000},
                    "contract": {"type": "number", "exclusiveMinimum": 0, "default": 100},
                    "trade_break": {"type": "string", "default": "21:30-23:00"},
                    "input_overrides": {"type": "object", "description": "覆盖适配器的同名 MQ5 inputs"},
                },
                "required": ["ea_name"],
            },
        ),
        Tool(
            name="get_backtest_status",
            description="查询回测状态、权益收益、期末余额、最差浮盈亏、Tick 数与风洞报告路径。",
            inputSchema={
                "type": "object",
                "properties": {
                    "backtest_id": {"type": "string", "description": "run_backtest 返回的 id"},
                },
                "required": ["backtest_id"],
            },
        ),
        Tool(
            name="cancel_backtest",
            description="取消指定回测或移出队列。",
            inputSchema={"type": "object", "properties": {"backtest_id": {"type": "string"}}, "required": ["backtest_id"]},
        ),
        Tool(
            name="list_backtests",
            description=(
                "按时间倒序列出回测记录，含 EA、实际区间、状态、指标和报告。可按 EA 过滤。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20,
                              "description": "返回最多 N 条，默认 20"},
                    "ea":    {"type": "string", "description": "（可选）只返回指定 EA 名的记录"},
                },
                "required": [],
            },
        ),
    ] + _trading_write_tools() + [   # 0.3.99: 内部按 _is_trading_write_enabled / _is_trading_write_open_enabled 各自决定
        # ---- Chart windows: list / open / close ----
        Tool(
            name="list_trade_charts",
            description=(
                "查询某个 MT5 实例当前打开了哪些图表窗口。MT5 在跑 → 实时枚举窗口"
                "（source=live，每项带 id / symbol / period）；MT5 没在跑 → 读 profile 文件，"
                "返回下次启动时会打开的图表（source=profile）。每项的 id 可直接传给 "
                "close_trade_charts。ea_name 来自上次落盘的 profile 快照，MT5 运行期间可能滞后。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instance_id": {"type": "string", "description": "MT5 实例 ID（list_mt5_instances 拿）。不传 = 默认实例。"},
                },
                "required": [],
            },
        ),
        Tool(
            name="open_trade_charts",
            description=(
                "在某个 MT5 实例里打开一个或多个 K 线图表窗口，每个窗口可以是不同品种/周期。"
                "只追加、不动已有图表，所以重复调用 = 继续追加。不能挂 EA（挂 EA 用 attach_eas_to_charts）。"
                "MT5 没在跑 → 直接写进 profile，下次启动该实例时出现。"
                "MT5 在跑 → 需要让 MT5 重新加载一次图表配置（不重启进程，约几秒）：所有图表会关闭再打开，"
                "图表上的 EA 会重新初始化。**所以 MT5 在跑时第一次调用只返回 stage=needs_user_confirm，"
                "AI 必须先把影响告诉用户并得到同意，再带 confirm_reload=true 调第二次。**"
                "以返回的 ok 和 opened 为准，ok=false 时不要说已经打开。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "charts": {
                        "type": "array",
                        "minItems": 1,
                        "description": "要打开的图表列表，一项一个窗口。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "symbol": {"type": "string", "description": "品种名，如 XAUUSD。券商带后缀（XAUUSDm）时会自动模糊匹配。"},
                                "period": {"type": "string", "enum": list(_mt5_profile.PERIODS),
                                           "description": "时间周期，默认 H1"},
                            },
                            "required": ["symbol"],
                        },
                    },
                    "instance_id": {"type": "string", "description": "MT5 实例 ID（list_mt5_instances 拿）。不传 = 默认实例。"},
                    "confirm_reload": {"type": "boolean",
                                       "description": "MT5 在跑时必须为 true 才真正执行（表示用户已同意重新加载图表配置）。默认 false。"},
                },
                "required": ["charts"],
            },
        ),
        Tool(
            name="close_trade_charts",
            description=(
                "关闭某个 MT5 实例里指定的一个或多个图表窗口。MT5 在跑 → 实时关闭，不重启、"
                "不影响其它图表；MT5 没在跑 → 从 profile 里删掉，下次启动不再打开。"
                "每个选择器要么给 id（list_trade_charts 返回的，精确到单个窗口），要么给 symbol"
                "（可加 period 收窄；同品种同周期有多个窗口时全部命中）。"
                "挂着 EA 的图表默认跳过并在 skipped 里列出 —— 关掉它 EA 就停了；确实要关再传 "
                "include_ea_charts=true（这不等于卸载策略，卸载请到「策略」栏操作）。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "charts": {
                        "type": "array",
                        "minItems": 1,
                        "description": "要关闭的图表选择器列表。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "list_trade_charts 返回的图表 id"},
                                "symbol": {"type": "string", "description": "品种名（精确匹配，不区分大小写）"},
                                "period": {"type": "string", "enum": list(_mt5_profile.PERIODS),
                                           "description": "可选：只关这个周期的"},
                            },
                        },
                    },
                    "instance_id": {"type": "string", "description": "MT5 实例 ID（list_mt5_instances 拿）。不传 = 默认实例。"},
                    "include_ea_charts": {"type": "boolean",
                                          "description": "是否连挂着 EA 的图表一起关。默认 false。"},
                },
                "required": ["charts"],
            },
        ),

        Tool(
            name="attach_eas_to_charts",
            description=(
                "把一个或多个 EA 分别挂到指定的图表窗口上，每个 EA 可单独指定输入参数（如魔法数）。"
                "assignments 每项: ea_name 必填；chart_id（list_trade_charts 返回的，精确到某个窗口）"
                "或 symbol+period（优先复用该品种周期上已挂同名 EA 的图表→更新参数，其次没挂 EA 的图表，"
                "都没有就新开一张）；inputs 可选，{参数名: 值}，只写要改的，其余用 EA 默认值；"
                "有源码时会校验参数名。目标图表已挂着别的 EA 时默认不动，传 replace=true 才替换。"
                "不重启 MT5 进程。MT5 没在跑 → 直接写进 profile，下次启动生效；"
                "MT5 在跑 → 需要让 MT5 重新加载一次图表配置（约几秒，所有图表上的 EA 会重新初始化），"
                "**第一次调用只返回 stage=needs_user_confirm，AI 必须先把影响告诉用户并得到同意，"
                "再带 confirm_reload=true 调第二次。** 以返回的 ok 和每项 results 为准。"
                "EA 必须已编译成 .ex5 放在 MQL5/Experts/ 下（没编译先 compile_strategy）。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "assignments": {
                        "type": "array",
                        "minItems": 1,
                        "description": "要挂的 EA 列表，一项一只 EA 对应一张图表。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "ea_name": {"type": "string", "description": "EA 文件名（不含 .ex5），如 'GMarket'；在子目录时写 'Advisors\\ExpertMACD'"},
                                "chart_id": {"type": "string", "description": "目标图表 id（list_trade_charts 返回）。给了就只挂这张。"},
                                "symbol": {"type": "string", "description": "没给 chart_id 时按品种选图表；券商带后缀（XAUUSDm）时会自动匹配"},
                                "period": {"type": "string", "enum": list(_mt5_profile.PERIODS),
                                           "description": "配合 symbol，默认 H1"},
                                "inputs": {"type": "object", "additionalProperties": True,
                                           "description": "要覆盖的输入参数 {参数名: 值}，如 {\"InpMagicNumber\": 1001}"},
                                "replace": {"type": "boolean", "description": "目标图表已挂着别的 EA 时是否替换，默认 false"},
                            },
                            "required": ["ea_name"],
                        },
                    },
                    "instance_id": {"type": "string", "description": "MT5 实例 ID（list_mt5_instances 拿）。不传 = 按 EA 绑定的实例，都没绑 = 默认实例。"},
                    "confirm_reload": {"type": "boolean",
                                       "description": "MT5 在跑时必须为 true 才真正执行（表示用户已同意重新加载图表配置）。默认 false。"},
                },
                "required": ["assignments"],
            },
        ),

        # 0.3.272: 给 Node 端 launchMt5 restore 路径用 —— mounted-state.json
        # 自动恢复 EA + ini 后, MT5 boot 完需要再 Ctrl+E 一次让算法交易开关
        # 自动开 + 弹的 EA 属性对话框自动勾「允许算法交易」+ 确定. 不能在 launchMt5
        # 里复刻 Python 那套 PowerShell + Win32 (Node 不方便), 所以 Node 起一个
        # 一次性 MCP child 调这个工具完成.
        Tool(
            name="post_launch_arm_ea",
            description=(
                "MT5 已 boot + EA 已挂 (通过 startup.ini) 之后调这个工具完成两件事: "
                "(1) 检查 + 开 MT5 工具栏算法交易全局开关 (Ctrl+E 注入), "
                "(2) 自动勾 EA 属性对话框「允许算法交易」+ 按确定. "
                "Node 端 launchMt5 走 mounted-state restore 路径时 fire-and-forget 调用. "
                "AI 一般不需要直接调."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "install_dir": {"type": "string",
                                     "description": "MT5 install dir (terminal64.exe 所在目录)"},
                    "ea_name":     {"type": "string",
                                     "description": "刚挂上的 EA 名 (用来 poll EA 属性对话框)"},
                    "boot_wait_sec": {"type": "number",
                                       "description": "等 MT5 boot 多少秒再开始 (默认 3.0)",
                                       "default": 3.0},
                },
                "required": ["install_dir"],
            },
        ),

        Tool(
            name="set_auto_trading",
            description=(
                "确定性切 MT5 全局「算法交易」开关(Ctrl+E 注入 + 回查验证)。"
                "enabled=false = 暂停(关算法交易, 手机端「暂停交易」走这个); enabled=true = 恢复(开)。"
                "遍历所有配置的 MT5 实例(没配则用默认安装目录)逐个切, 据实回报每实例结果 + 顶层 ok。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "enabled": {"type": "boolean",
                                 "description": "true=开启算法交易(恢复); false=关闭(暂停)。默认 false。",
                                 "default": False},
                    "instance_name": {"type": "string",
                                       "description": "可选。只切指定实例(按 settings 实例名)。不传=所有在跑实例。"},
                },
                "required": [],
            },
        ),

        # 0.3.49: 实时 per-EA 统计（替代 records-based 老路径）
        # Node 侧把已经解析好的 magic / symbols / load_at 一起塞进来（保留
        # runtime.json + .chr + log-activity 三路 heuristic），Python 只负责
        # 一次性 history_deals_get + positions_get + 算指标，不重复 heuristic。
        # 让「我的策略」UI 实时拿当前真值，不再依赖每小时 ticker 写盘 records。
        Tool(
            name="get_ea_realtime_stats",
            description=(
                "实时算每只 EA 的 trades / pnl / max_drawdown / 开仓数. "
                "一次拉一批 EA, Python 内只调一次 mt5.history_deals_get(lookback) "
                "+ mt5.positions_get(). EA spec 里 magic 必填; symbols 用来做仓位 / "
                "open-position 过滤; load_at_sec 是 deal-filter 起点 (默认 lookback 起算). "
                "返回每只 EA 的 trades/pnl/pnl_pct/max_drawdown_pct/today_*/open_*/last_deal_at."
                "\n\n⚠ **多 MT5 场景必传 instance_id** — 不传时查的是默认 (active) 实例的 EA 数据. "
                "用户问「mt5-2 / EasyDeal MT5 3 上的 EA 表现」时必须传该实例的 ID, 否则 stats 全错."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "eas": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "ea_name":      {"type": "string"},
                                "magic":        {"type": "integer", "description": "由 Node 解析（runtime.json / .chr / 仓位启发），>=0；缺 magic 的 EA 不传，Python 兜底从 symbols+deals 频次推断"},
                                "symbols":      {"type": "array", "items": {"type": "string"}, "description": "EA 当前挂的 symbol 列表（用于 open-position 过滤 + magic 缺失时的启发）"},
                                "load_at_sec":  {"type": "integer", "description": "deal-filter 起点 unix 秒；不传 → 用 lookback 起点"},
                            },
                            "required": ["ea_name"],
                        },
                    },
                    "lookback_days": {"type": "integer", "minimum": 1, "maximum": 365, "default": 30},
                    "instance_id": {"type": "string", "description": "⚠ 多 MT5 必传 — 该 EA 所属实例 ID (list_mt5_instances 拿). 不传 = 默认实例, 多 MT5 场景下 stats 全错."},
                },
                "required": ["eas"],
            },
        ),

        # 始终可见的诊断工具 — 用户在 chat 里说「调用 easydeal_debug_env」
        # 就能看到当前 MCP 进程里 EASYDEAL_TRADING_WRITE 等关键 env，
        # 用来定位「我开了开关但 Claude 还说没工具」之类的问题。
        Tool(
            name="easydeal_debug_env",
            description=(
                "诊断工具：返回当前 easydeal MCP 进程看到的关键环境变量 + 是否暴露平仓/改单工具。"
                "用户反馈「开了平仓改单权限但 Claude 看不到工具」时调用此工具，"
                "如果返回 trading_write_enabled=false 说明 .mcp.json 没正确注入 env，"
                "= true 但工具仍不可见说明问题在 Claude / MCP 端。"
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
    ]


def _is_trading_write_enabled() -> bool:
    """读环境变量决定是否暴露「平仓 / 改单」类工具（不含开仓）。
    客户端「设置 → 高级 → 允许 AI 直接平仓 / 改单」勾上时会注入
    EASYDEAL_TRADING_WRITE=1。默认关闭以防 LLM 在用户没明确授权时动实盘。
    0.3.99: 跟 _is_trading_write_open_enabled 拆开 —— 开仓权限独立 toggle。"""
    return os.getenv("EASYDEAL_TRADING_WRITE", "").strip() in ("1", "true", "yes", "on")


def _is_trading_write_open_enabled() -> bool:
    """0.3.99: 单独控 open_position 工具的暴露。开仓比平/改激进得多
    （凭空建仓的风险敞口完全不可控），用户经常想给 AI 平改权限但不给开仓权限。
    EASYDEAL_TRADING_WRITE_OPEN=1 才暴露 open_position。"""
    return os.getenv("EASYDEAL_TRADING_WRITE_OPEN", "").strip() in ("1", "true", "yes", "on")


def _debug_env_tool() -> list[TextContent]:
    """easydeal_debug_env 实现 — 把当前进程的几个 EASYDEAL_* env 摊开给 Claude。"""
    keys = [
        "EASYDEAL_TRADING_WRITE", "EASYDEAL_WORKSPACE_DIR",
        "EASYDEAL_MT5_INSTALL_DIR", "EASYDEAL_MT5_DATA_DIR",
        "EASYDEAL_BACKTESTS_FILE", "EASYDEAL_SCHEDULER_DB",
    ]
    env_view = {k: os.getenv(k, "") for k in keys}
    return [TextContent(type="text", text=json.dumps({
        "trading_write_enabled": _is_trading_write_enabled(),
        "env":                   env_view,
        "tools_visible_count":   len([1 for _ in _trading_write_tools()]) + 1,  # +1 = self
        "hint": (
            "如果 trading_write_enabled=false 但客户端开关已开 — "
            "1) 检查 %APPDATA%/EasyDeal/workspace/.mcp.json 里 mcpServers.easydeal.env "
            "    是否有 EASYDEAL_TRADING_WRITE=\"1\" "
            "2) 没有的话切到 设置 tab 把开关关一下再重新打开（强制 reapplyWorkspace）"
            "3) 重新打开聊天（claude --print 每次会重读 .mcp.json）"
        ),
    }, ensure_ascii=False, indent=2))]


def _trading_close_position(strategy, arguments: dict) -> list[TextContent]:
    """实现 close_position 工具：平 EA 全部持仓，或单笔平掉某 ticket。"""
    ticket = arguments.get("ticket")
    if ticket is None:
        try:
            r = strategy.close_all_orders()
        except Exception as exc:
            return [TextContent(type="text", text=json.dumps({
                "ok": False, "error": str(exc),
            }, ensure_ascii=False))]
        ok = "error" not in (r or {})
        return [TextContent(type="text", text=json.dumps({
            "ok": ok, "scope": "all_tracked", **(r or {}),
        }, ensure_ascii=False, indent=2))]

    try:
        ticket = int(ticket)
    except (TypeError, ValueError):
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"invalid ticket: {arguments.get('ticket')!r}",
        }, ensure_ascii=False))]

    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"position not found: {ticket}",
        }, ensure_ascii=False))]
    pos = positions[0]
    sym = pos.symbol
    info = mt5.symbol_info(sym)
    if info is None:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"symbol_info failed for {sym}",
        }, ensure_ascii=False))]

    order_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = info.bid if order_type == mt5.ORDER_TYPE_SELL else info.ask
    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       sym,
        "volume":       pos.volume,
        "type":         order_type,
        "position":     pos.ticket,
        "price":        price,
        "magic":        pos.magic,
        "comment":      "Close (AI)",
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
    return [TextContent(type="text", text=json.dumps({
        "ok":      ok,
        "ticket":  pos.ticket,
        "symbol":  sym,
        "volume":  pos.volume,
        "retcode": getattr(result, "retcode", None),
        "comment": getattr(result, "comment", None),
        "message": None if ok else f"order_send retcode={getattr(result, 'retcode', '?')}",
    }, ensure_ascii=False, indent=2))]


# 0.3.141: MT5 retcode 常见值 → 中文友好提示。用户反馈：「连续调用 modify_position
# 只有第一张改成功，下一轮对话依然如此」。根因诊断：order_send 失败时只返 retcode
# 数字（如 10016），AI 看不懂含义所以下次重试用同款不合规参数 → 仍失败。加详细诊断 +
# stops_level 校验后 AI 收到「SL 距离当前价仅 30 points，broker 要求 ≥ 100 points」
# 就知道该把 SL 拉远。
_MT5_RETCODE_TO_CN = {
    10004: "REQUOTE — 报价已变，需要拉新价重试",
    10006: "REJECT — broker 直接拒单",
    10007: "CANCEL — 客户端取消",
    10008: "PLACED — 挂单已就位",
    10009: "DONE — 成功",
    10010: "DONE_PARTIAL — 部分成交",
    10011: "ERROR — 通用错误",
    10012: "TIMEOUT — broker 端超时",
    10013: "INVALID — 请求无效",
    10014: "INVALID_VOLUME — 手数不合法（< min / > max / 非 step 倍数）",
    10015: "INVALID_PRICE — 价格不合法",
    10016: "INVALID_STOPS — SL/TP 离当前价距离不够（< trade_stops_level）",
    10017: "TRADE_DISABLED — 该 symbol 当前不允许交易",
    10018: "MARKET_CLOSED — 市场休市",
    10019: "NO_MONEY — 保证金不足",
    10020: "PRICE_CHANGED — 价格已变",
    10021: "PRICE_OFF — 无可用价（datafeed 死）",
    10022: "INVALID_EXPIRATION — 过期时间不合法",
    10023: "ORDER_CHANGED — 订单状态已变",
    10024: "TOO_MANY_REQUESTS — broker 限流",
    10025: "NO_CHANGES — 改单参数跟现有值相同（不算错）",
    10026: "SERVER_DISABLES_AT — broker 服务端关了 AT",
    10027: "CLIENT_DISABLES_AT — MT5 客户端「自动交易」按钮没开 (顶部红色 → 点成绿色)",
    10028: "LOCKED — 该订单被锁",
    10029: "FROZEN — 订单冻结（pending）",
    10030: "INVALID_FILL — filling 类型 broker 不支持（IOC/FOK/RETURN）",
    10031: "CONNECTION — SDK 跟 broker 断了",
    10032: "ONLY_REAL — 该 symbol 仅实盘可交易",
    10033: "LIMIT_ORDERS — 挂单数量到上限",
    10034: "LIMIT_VOLUME — 持仓量到上限",
    10038: "CLOSE_ORDER_EXIST — close-by 已存在",
    10039: "LIMIT_POSITIONS — 持仓数到上限",
    10044: "INVALID_ORDER — 订单不存在",
    10045: "POSITION_CLOSED — 仓位已平",
}


def _retcode_explain(retcode):
    """retcode → 中文解释 + mt5.last_error() 详细信息组合。"""
    cn = _MT5_RETCODE_TO_CN.get(retcode, "未知 retcode")
    try:
        le = mt5.last_error()
        return f"{retcode} {cn} | last_error={le}"
    except Exception:
        return f"{retcode} {cn}"


def _trading_modify_position(strategy, arguments: dict) -> list[TextContent]:
    """实现 modify_position 工具：修改一单的 SL / TP。"""
    raw_ticket = arguments.get("ticket")
    try:
        ticket = int(raw_ticket)
    except (TypeError, ValueError):
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"invalid ticket: {raw_ticket!r}",
        }, ensure_ascii=False))]

    sl = arguments.get("sl")
    tp = arguments.get("tp")
    if sl is None and tp is None:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": "must specify sl or tp",
        }, ensure_ascii=False))]

    # 0.3.141: 每次入口先 ping SDK 连接，挂了立刻 re-init 一次
    # 0.3.206: 必须传 path — 用户多 MT5 (XM + Exness 同机) 时, 不带 path 的 init
    # 会让 SDK 随机抓一个 (通常 OS 默认注册那个 = Exness), 不是用户实际选的 MT5.
    # 用户反馈: 选了 XM, 读到的账户是 Exness 的, 操作时 Exness 还弹出.
    try:
        ti = mt5.terminal_info()
        if not (ti and getattr(ti, "connected", False)):
            _init_kwargs = {}
            _install_dir = os.getenv("EASYDEAL_MT5_INSTALL_DIR")
            if _install_dir:
                for _cand in ("terminal64.exe", "terminal.exe"):
                    _p = os.path.join(_install_dir, _cand)
                    if os.path.isfile(_p):
                        _init_kwargs["path"] = _p
                        break
            # 0.3.205: 防自动 launch 用户主动关掉的 MT5
            if _install_dir and not _ezd_terminal_is_running(_install_dir):
                # MT5 未运行 → 不调 initialize (不让 SDK 自动 launch)
                pass
            else:
                _mt5_init(**_init_kwargs)
    except Exception:
        pass

    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"position not found: {ticket}",
            "hint": "ticket 可能刚被 broker 平仓了 (SL/TP 触发) 或 ticket 写错",
        }, ensure_ascii=False))]
    pos = positions[0]

    new_sl = float(sl) if sl is not None else float(pos.sl)
    new_tp = float(tp) if tp is not None else float(pos.tp)

    # 0.3.141: stops_level 距离 + 价方向 预检验。AI 算出来的 SL/TP 经常离当前价太近，
    # broker 直接返 10016 INVALID_STOPS。在这里检出来，给 AI 明确数字提示。
    pre_warnings = []
    try:
        info = mt5.symbol_info(pos.symbol)
        if info is not None:
            stops_lvl = int(getattr(info, "trade_stops_level", 0) or 0)
            point = float(getattr(info, "point", 0) or 0)
            tick = mt5.symbol_info_tick(pos.symbol)
            if tick and stops_lvl > 0 and point > 0:
                min_dist = stops_lvl * point
                bid = float(tick.bid); ask = float(tick.ask)
                # BUY (pos.type==0): SL < bid, TP > bid; SL/bid 距离 >= min_dist
                # SELL (pos.type==1): SL > ask, TP < ask; SL/ask 距离 >= min_dist
                if pos.type == 0:  # BUY
                    if new_sl > 0 and (bid - new_sl) < min_dist:
                        pre_warnings.append(
                            f"BUY 的 SL={new_sl} 离当前 bid={bid} 仅 {(bid-new_sl)/point:.0f} points，"
                            f"broker 要求 ≥ {stops_lvl} points（min_dist={min_dist}）"
                        )
                    if new_tp > 0 and (new_tp - bid) < min_dist:
                        pre_warnings.append(
                            f"BUY 的 TP={new_tp} 离当前 bid={bid} 仅 {(new_tp-bid)/point:.0f} points，"
                            f"broker 要求 ≥ {stops_lvl} points"
                        )
                elif pos.type == 1:  # SELL
                    if new_sl > 0 and (new_sl - ask) < min_dist:
                        pre_warnings.append(
                            f"SELL 的 SL={new_sl} 离当前 ask={ask} 仅 {(new_sl-ask)/point:.0f} points，"
                            f"broker 要求 ≥ {stops_lvl} points"
                        )
                    if new_tp > 0 and (ask - new_tp) < min_dist:
                        pre_warnings.append(
                            f"SELL 的 TP={new_tp} 离当前 ask={ask} 仅 {(ask-new_tp)/point:.0f} points，"
                            f"broker 要求 ≥ {stops_lvl} points"
                        )
    except Exception:
        pass  # 验证只是预警，不阻断 order_send（万一 broker 实际允许）

    req = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "symbol":   pos.symbol,
        "position": pos.ticket,
        "sl":       new_sl,
        "tp":       new_tp,
    }
    result = mt5.order_send(req)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
    retcode = getattr(result, "retcode", None)

    # 0.3.141: 失败时给 AI 明确诊断，AI 下次重试就能调整参数
    explained = _retcode_explain(retcode) if not ok else None

    out = {
        "ok":          ok,
        "ticket":      pos.ticket,
        "symbol":      pos.symbol,
        "side":        "buy" if pos.type == 0 else "sell",
        "old_sl":      pos.sl,
        "old_tp":      pos.tp,
        "new_sl":      new_sl,
        "new_tp":      new_tp,
        "retcode":     retcode,
        "retcode_explain": explained,
        "comment":     getattr(result, "comment", None),
        "request_id":  getattr(result, "request_id", None),
        "message":     None if ok else f"order_send 失败 — {explained}",
    }
    if pre_warnings:
        out["pre_validation_warnings"] = pre_warnings
        if not ok:
            out["hint"] = "预检验已提示 SL/TP 距离问题，请重算 SL/TP 离当前价 ≥ broker 要求的 points 数"
    return [TextContent(type="text", text=json.dumps(out, ensure_ascii=False, indent=2))]


def _trading_open_position(strategy, arguments: dict) -> list[TextContent]:
    """实现 open_position 工具：市价开一单（buy 或 sell）。
    跟 close / modify 共用同一个 `EASYDEAL_TRADING_WRITE` 开关 —— 用户必须
    在客户端「设置 → 高级」显式开启「允许 AI 直接平仓 / 改单 / 开仓」才会
    暴露该工具。"""
    symbol = (arguments.get("symbol") or "").strip()
    side = (arguments.get("side") or "").strip().lower()
    raw_vol = arguments.get("volume")

    if not symbol:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": "symbol 必填",
        }, ensure_ascii=False))]
    if side not in ("buy", "sell"):
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"side 必须是 'buy' 或 'sell'，收到 {side!r}",
        }, ensure_ascii=False))]
    # size_by_risk(信号跟单): 服务端不传手数, 下面用真实合约规格按风险金反算 → 这里允许无 volume。
    size_by_risk = bool(arguments.get("size_by_risk"))
    try:
        volume = float(raw_vol) if raw_vol not in (None, "") else 0.0
    except (TypeError, ValueError):
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"invalid volume: {raw_vol!r}",
        }, ensure_ascii=False))]
    if volume <= 0 and not size_by_risk:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"volume 必须 > 0，收到 {volume}",
        }, ensure_ascii=False))]

    info = mt5.symbol_info(symbol)
    if info is None:
        # broker symbol 命名差异(传 XAUUSD 但 broker 是 XAUUSDm / .c / # 等) → 模糊解析
        # 一次再试。复用 _pick_chartable_symbol(prefer=[symbol]) 的 broker 全表模糊匹配。
        # 这对手机「预测下单」尤其关键 —— server 只会传规范名 XAUUSD。
        try:
            picked, _cands = _pick_chartable_symbol([symbol])
        except Exception:
            picked = None
        if picked and picked != symbol:
            symbol = picked
            info = mt5.symbol_info(symbol)
    if info is None:
        return [TextContent(type="text", text=json.dumps({
            "ok":    False,
            "error": f"symbol_info 失败：{symbol} 在当前 broker 不存在",
            "hint":  "去 MT5 Market Watch 看实际可用 symbol 名（可能带后缀 m / # / .c）",
        }, ensure_ascii=False))]
    # 没在 Market Watch 里加过 → symbol_info_tick 可能返回不了。先 select 一下。
    if not getattr(info, "visible", False):
        try: mt5.symbol_select(symbol, True)
        except Exception: pass

    # ── 信号跟单 size_by_risk / 风险硬顶 ──
    # 用**真实合约规格**(trade_tick_value=每手每跳的$, trade_tick_size=最小跳)按风险金反算手数,
    # 任意品种/经纪商都算准, 服务端不必猜规格。size_by_risk=按风险算; 另外只要带了 max_risk_money,
    # 即便服务端传了 volume 也做「风险硬顶」(取 min), 防规格漂移把风险放大。
    _mrm = arguments.get("max_risk_money")
    try: _mrm = float(_mrm) if _mrm not in (None, "", 0) else None
    except (TypeError, ValueError): _mrm = None
    _raw_sl0 = arguments.get("sl")
    try: _sl0 = float(_raw_sl0) if _raw_sl0 not in (None, "", 0) else 0.0
    except (TypeError, ValueError): _sl0 = 0.0
    if (size_by_risk or _mrm) and _sl0 and _mrm:
        try:
            _tv = float(getattr(info, "trade_tick_value", 0) or 0)
            _ts = float(getattr(info, "trade_tick_size", 0) or 0)
            _tick0 = mt5.symbol_info_tick(symbol)
            _entry0 = (_tick0.ask if side == "buy" else _tick0.bid) if _tick0 else 0.0
            if not _entry0:
                _entry0 = float(arguments.get("entry_ref") or 0) or 0.0
            _dist = abs(_entry0 - _sl0)
            if _tv > 0 and _ts > 0 and _dist > 0:
                _loss_per_lot = (_dist / _ts) * _tv
                _vol_by_risk = _mrm / _loss_per_lot
                # size_by_risk 或没传手数 → 直接用; 否则风险硬顶(不许超)
                volume = _vol_by_risk if (size_by_risk or volume <= 0) else min(volume, _vol_by_risk)
        except Exception:
            pass
    if volume <= 0:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": "无法按风险算出手数(缺有效止损 / 取不到合约规格)",
        }, ensure_ascii=False))]

    # 量化到 broker 允许的 volume step / min / max，避免「Invalid volume」retcode。
    vmin = getattr(info, "volume_min", None) or 0.01
    vmax = getattr(info, "volume_max", None) or 100.0
    vstep = getattr(info, "volume_step", None) or 0.01
    if volume < vmin:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"volume {volume} < broker min {vmin}",
        }, ensure_ascii=False))]
    if volume > vmax:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"volume {volume} > broker max {vmax}",
        }, ensure_ascii=False))]
    # round 到 step 的整数倍
    try:
        steps = round(volume / vstep)
        volume = round(steps * vstep, 8)
    except Exception:
        pass

    order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
    price = info.ask if order_type == mt5.ORDER_TYPE_BUY else info.bid
    if not price:
        # 兜底 tick — symbol_info 偶尔 bid/ask 为 0（行情未到），再抓一次 tick
        try:
            tick = mt5.symbol_info_tick(symbol)
            price = tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid
        except Exception:
            price = 0
    if not price:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"无法获取 {symbol} 当前报价（bid/ask=0），市场未开盘 / 行情中断？",
        }, ensure_ascii=False))]

    raw_sl = arguments.get("sl")
    raw_tp = arguments.get("tp")
    sl = float(raw_sl) if raw_sl not in (None, "", 0) else 0.0
    tp = float(raw_tp) if raw_tp not in (None, "", 0) else 0.0

    raw_magic = arguments.get("magic")
    try:
        magic = int(raw_magic) if raw_magic is not None else 0
    except (TypeError, ValueError):
        magic = 0
    # 0.3.99: AI 没传 magic 时自动生成一个 ——「__ai_manual__」pseudo-EA 监控
    # 需要稳定 magic 才能把后续 deal 归属回来。用 time.time()*1000 取 31bit 范围内
    # （MT5 magic 是 ulong 但 OrderGuard 内部 cast int 也得是 signed 32bit 安全）。
    # 这样每笔 AI 开的单 magic 唯一，OrderGuard 能在 decisions 里分单记录。
    if magic == 0:
        magic = int(time.time() * 1000) & 0x7FFFFFFF

    # 魔术数不能与在跑策略(当前持仓的 magic)相同 —— 否则这单会被那个 EA / OrderGuard
    # 误当成自己的单去管理(平 / 改 / 统计)。撞了就换一个唯一安全 magic(时间戳基, 不为 0)。
    try:
        _used_magics = {int(getattr(_p, "magic", 0)) for _p in (mt5.positions_get() or [])}
    except Exception:
        _used_magics = set()
    if magic in _used_magics:
        _nm = int(time.time() * 1000) & 0x7FFFFFFF
        while _nm in _used_magics or _nm == 0:
            _nm = (_nm + 1) & 0x7FFFFFFF
        magic = _nm

    comment = arguments.get("comment") or "Open (AI)"
    try:
        deviation = int(arguments.get("deviation") or 20)
    except (TypeError, ValueError):
        deviation = 20

    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       volume,
        "type":         order_type,
        "price":        price,
        "sl":           sl,
        "tp":           tp,
        "deviation":    deviation,
        "magic":        magic,
        "comment":      str(comment)[:31],   # MT5 comment 上限 31 字符
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE

    # 0.3.99: 开仓成功 → best-effort 把这单的 magic 注册到 OrderGuard 的
    # `__ai_manual__` pseudo-EA。OrderGuard 没启动 / port file 不存在 / HTTP 报错
    # 都 silent skip 不影响开仓结果（开仓本身已经成了）。registered=True 时把
    # OrderGuard 的 enroll 信息塞回返回里让 AI 知道这单在 OG 监控下。
    og_registered = False
    og_error = None
    if ok:
        try:
            og_registered, og_error = _orderguard_register_ai_manual(magic, symbol, side, volume)
        except Exception as _og_e:
            og_error = f"OrderGuard enroll raised: {_og_e}"

    return [TextContent(type="text", text=json.dumps({
        "ok":         ok,
        "symbol":     symbol,
        "side":       side,
        "volume":     volume,
        "price":      price,
        "sl":         sl,
        "tp":         tp,
        "magic":      magic,
        "ticket":     getattr(result, "order", None) if ok else None,
        "deal":       getattr(result, "deal", None),
        "retcode":    getattr(result, "retcode", None),
        "comment":    getattr(result, "comment", None),
        "message":    None if ok else f"order_send retcode={getattr(result, 'retcode', '?')}",
        # 0.3.99: OrderGuard auto-enroll status — AI 看到 True 就可以告诉用户
        # 「这单已自动进 OrderGuard 的 __ai_manual__ 监控，去『策略 → 已护航』看」
        "orderguard_enrolled":     og_registered,
        "orderguard_enroll_error": og_error,
    }, ensure_ascii=False, indent=2))]


def _orderguard_http_get(path: str, params: dict = None, timeout: float = 3.0):
    """1.0.11: 只读 proxy 到长驻 OrderGuard HTTP server（读 EASYDEAL_ORDERGUARD_PORT_FILE
    拿端口，跟 _orderguard_register_ai_manual 同款）。给 AI 廉价拿护航战绩/决策/统计，
    不触发 MT5 IPC、不另起 OG 进程。返回 (ok: bool, data_or_error)。
    护航没启动 / file 不存在 / HTTP fail → (False, "<reason>")，绝不抛异常。"""
    port_file = os.getenv("EASYDEAL_ORDERGUARD_PORT_FILE", "").strip()
    if not port_file:
        return (False, "EASYDEAL_ORDERGUARD_PORT_FILE 未设置（客户端版本过旧？）")
    if not os.path.isfile(port_file):
        return (False, "护航服务未启动（port file 不存在）——用户需在「策略 → 🛡 护航」启用护航后才有数据")
    try:
        with open(port_file, "r", encoding="utf-8") as _f:
            port = int(_f.read().strip())
    except Exception as e:
        return (False, f"读护航 port file 失败: {e}")
    if port <= 0:
        return (False, f"护航 port 不合法: {port}")
    import urllib.request
    import urllib.parse
    url = f"http://127.0.0.1:{port}{path}"
    if params:
        qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        if qs:
            url += "?" + qs
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return (True, json.loads(r.read()))
    except Exception as e:
        return (False, f"HTTP GET {path} 失败: {e}")


def _orderguard_register_ai_manual(magic: int, symbol: str, side: str,
                                   volume: float) -> tuple[bool, str | None]:
    """0.3.99: AI 开仓成功后调 OrderGuard /enable 把这单 magic 注册到
    `__ai_manual__` pseudo-EA，独立于用户 EA 规则之外。

    路径：
      1. 读 EASYDEAL_ORDERGUARD_PORT_FILE（main.js 在 ensureWorkspace 时注入），
         拿 OrderGuard 当前监听的端口
      2. HTTP POST http://127.0.0.1:<port>/enable
         body = {ea_name: "__ai_manual__", magic, mode: "observe"}
      3. OrderGuard 把 magic → "__ai_manual__" 映射进 _ea_magic_map，monitor
         在后续 deal stream 里看到这个 magic 的成交会归到这只 pseudo-EA 上

    返回 (ok, error_str)。OrderGuard 没启动 / file 不存在 / HTTP fail 都返
    (False, "<reason>") —— 不抛异常，不阻碍 AI 收到开仓成功的回包。
    """
    port_file = os.getenv("EASYDEAL_ORDERGUARD_PORT_FILE", "").strip()
    if not port_file:
        return (False, "EASYDEAL_ORDERGUARD_PORT_FILE not set (client < 0.3.99?)")
    if not os.path.isfile(port_file):
        return (False, "OrderGuard 未启动（port file 不存在）")
    try:
        with open(port_file, "r", encoding="utf-8") as _f:
            port = int(_f.read().strip())
    except Exception as e:
        return (False, f"读 OrderGuard port file 失败: {e}")
    if port <= 0:
        return (False, f"OrderGuard port 不合法: {port}")

    import urllib.request
    body = json.dumps({
        "ea_name": "__ai_manual__",
        "magic":   int(magic),
        "mode":    "observe",   # 不拦截，只监控 + 记录 decision 历史
    }).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/enable",
        data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=3.0) as r:
            resp = json.loads(r.read())
    except Exception as e:
        return (False, f"HTTP /enable 失败: {e}")
    if not resp.get("ok"):
        return (False, f"OrderGuard 返 ok=False: {resp.get('error', resp)}")
    logging.info(
        "[trading] AI 开仓 → OrderGuard __ai_manual__ 注册 magic=%s symbol=%s side=%s vol=%s",
        magic, symbol, side, volume)
    return (True, None)


def _trading_write_tools() -> list[Tool]:
    """0.3.99: 拆成两个独立权限 ——
       - EASYDEAL_TRADING_WRITE=1     → close_position + modify_position
       - EASYDEAL_TRADING_WRITE_OPEN=1 → open_position（独立 toggle）
    两个开关互相独立，可以只开平/改不开开仓（最常见的「让 AI 帮我止损但不让它乱开新仓」）。"""
    tools: list[Tool] = []
    if _is_trading_write_enabled():
        tools.append(Tool(
            name="close_position",
            description=(
                "⚠ 实盘动作：平仓。可以平掉所有 EA 持仓（不传 ticket）或某一单（传 ticket）。"
                "需要用户在客户端「设置 → 高级」里显式开启「允许 AI 直接平仓 / 改单」才会暴露此工具，"
                "否则连工具列表里都没有。"
                "成功返回平掉的 ticket 列表 + retcode；失败返回 error。"
                "\n0.3.235: 多 MT5 用户传 instance_id 指定哪个实例的单。不传时自动按 ticket 反查"
                "（轮询所有实例找到这单所在的）— AI 偷懒不传也能用，但传了更快。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ticket": {
                        "type": "integer",
                        "description": "要平的具体单号（来自 get_trading_status / list_all_mt5_status 的 orders）；不传 = 平掉默认实例所有 EA 的持仓",
                    },
                    "instance_id": {
                        "type": "string",
                        "description": "0.3.235: MT5 实例 ID。不传 + ticket 已知 = 自动按 ticket 反查；不传 + 无 ticket = 默认实例。",
                    },
                },
                "required": [],
            },
        ))
        tools.append(Tool(
            name="modify_position",
            description=(
                "⚠ 实盘动作：修改一单的止盈 / 止损。同样需要在「设置 → 高级」里开启权限。"
                "至少要传 sl 或 tp 之一。传 0 表示清除该止损 / 止盈。"
                "\n0.3.235: 多 MT5 用户传 instance_id；不传时按 ticket 自动反查。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ticket": {"type": "integer", "description": "持仓单号"},
                    "sl": {"type": "number", "description": "新止损价；0 = 清除止损"},
                    "tp": {"type": "number", "description": "新止盈价；0 = 清除止盈"},
                    "instance_id": {
                        "type": "string",
                        "description": "0.3.235: MT5 实例 ID。不传 = 按 ticket 自动反查所在实例。",
                    },
                },
                "required": ["ticket"],
            },
        ))
    if _is_trading_write_open_enabled():
        tools.append(Tool(
            name="open_position",
            description=(
                "⚠⚠ 实盘动作：市价开仓（凭空建仓，最高风险）。**独立**的授权开关 ——"
                "用户必须在客户端「设置 → 高级」里勾上「允许 AI 直接开仓」（跟平/改是两个开关）才会暴露。"
                "开仓成功后会自动注册到 OrderGuard 的 `__ai_manual__` pseudo-EA 监控（独立于用户 EA 规则之外）。"
                "返回新单 ticket + 实际成交价；失败时 error 字段说明原因（symbol 不可用 / "
                "volume 越界 / 行情未开 / broker 拒单等）。"
                "\n0.3.235: 多 MT5 用户**必须**传 instance_id 指定哪个实例开仓；不传 = 默认实例。"
                "不同 broker 的 symbol 可能不同 (XAUUSD vs XAUUSDm), 开错实例会失败。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "symbol":    {"type": "string",  "description": "品种代码，跟当前 broker 一致（XAUUSD / XAUUSDm / ...）"},
                    "side":      {"type": "string",  "enum": ["buy", "sell"], "description": "方向"},
                    "volume":    {"type": "number",  "description": "手数；会自动 round 到 broker 允许的 volume_step 倍数"},
                    "sl":        {"type": "number",  "description": "止损价（绝对价位）；不传 / 传 0 = 不设止损"},
                    "tp":        {"type": "number",  "description": "止盈价（绝对价位）；不传 / 传 0 = 不设止盈"},
                    "magic":     {"type": "integer", "description": "magic number；不传 = 0（标记为 AI 手开，跟任何 EA 都不归属）"},
                    "comment":   {"type": "string",  "description": "订单备注（MT5 限制 31 字符）；不传 = 'Open (AI)'"},
                    "deviation": {"type": "integer", "description": "允许滑点（点）；不传 = 20"},
                    "instance_id": {"type": "string", "description": "0.3.235: MT5 实例 ID（list_mt5_instances 拿）。不传 = 默认实例。"},
                },
                "required": ["symbol", "side", "volume"],
            },
        ))
    return tools


# ── per-EA 经验笔记: <workspace>/strategies/<stem>.experience.md (一只 EA 一份) ──
# 每日定时总结 + AI 主动 record_experience + 操盘手远程 push_experience 都写它;
# read_experience 读回当 AI 上下文。append-only, 带北京日期, ~80KB 上限留最近。
def _experience_path(ea_name):
    ws = os.getenv("EASYDEAL_WORKSPACE_DIR")
    if not ws or not ea_name:
        return None
    stem = os.path.basename(str(ea_name)).strip()
    for ext in (".experience.md", ".mq5", ".ex5", ".mqh", ".set"):
        if stem.lower().endswith(ext):
            stem = stem[: -len(ext)]
            break
    if not stem:
        return None
    return os.path.join(ws, "strategies", stem + ".experience.md")

def _read_experience(ea_name, max_chars=20000):
    fp = _experience_path(ea_name)
    if not fp or not os.path.isfile(fp):
        return {"ok": True, "ea_name": ea_name, "content": "", "note": "该 EA 暂无经验笔记"}
    try:
        with open(fp, "r", encoding="utf-8") as f:
            txt = f.read()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    if len(txt) > max_chars:
        txt = "…(已截断, 下为最近内容)…\n" + txt[-max_chars:]
    return {"ok": True, "ea_name": ea_name, "file": fp, "content": txt}

def _append_experience(ea_name, content, category=""):
    fp = _experience_path(ea_name)
    if not fp:
        return {"ok": False, "error": "workspace 未配置 或 ea_name 为空"}
    content = (content or "").strip()
    if not content:
        return {"ok": False, "error": "content 为空"}
    try:
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        stem = os.path.basename(fp)[: -len(".experience.md")]
        existing = ""
        if os.path.isfile(fp):
            with open(fp, "r", encoding="utf-8") as f:
                existing = f.read()
        out = existing
        if not out.strip():
            out = ("# " + stem + " 经验笔记\n"
                   "> EasyDeal 每日自动总结 + AI 主动记录 + 操盘手远程同步。append-only, 最新在末尾。\n")
        today = _bj_date_str()
        if ("## " + today) not in out:
            out = out.rstrip() + "\n\n## " + today + "\n"
        tag = ("[" + category.strip() + "] ") if (category and category.strip()) else ""
        out = out.rstrip() + "\n- " + _now_bj_str("%H:%M") + " " + tag + content + "\n"
        if len(out) > 80000:
            out = "# " + stem + " 经验笔记 (已截断, 留最近)\n" + out[-78000:]
        tmp = fp + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(out)
        os.replace(tmp, fp)
        return {"ok": True, "file": fp, "appended": tag + content, "bytes": len(out)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── per-EA 浮亏时序 (stats-collector.js 每 tick 聚合 positions → JSON) ──
# 给 AI 离线问历史浮亏用 — "gmarket 开马丁组最大浮亏" / "VP 上周最深浮亏多少" 之类
# 不调 server / 不依赖 MT5 实时连接, 直接读本地文件 (滚动留 ~90 天 hourly)。
def _ea_floating_series_path():
    data_dir = os.getenv("EASYDEAL_DATA_DIR")
    if not data_dir:
        return None
    return os.path.join(data_dir, "ea_floating_series.json")

def _read_ea_floating_series():
    fp = _ea_floating_series_path()
    if not fp or not os.path.isfile(fp):
        return {"version": 1, "by_ea": {}}
    try:
        with open(fp, "r", encoding="utf-8") as f:
            j = json.load(f)
        if isinstance(j, dict) and isinstance(j.get("by_ea"), dict):
            return j
    except Exception:
        pass
    return {"version": 1, "by_ea": {}}

def _floating_drawdown_for_ea(ea_name, window="all"):
    """读本地 ea_floating_series.json 算指定 EA 在 window 内的浮亏时序回撤。

    window: "24h" / "7d" / "30d" / "all" (默认 all = 最近 ~90 天硬上限里全部数据)
    回:
      ea_name, points, current_floating, peak_floating, trough_floating, deepest_drawdown_usd,
      deepest_drawdown_at_ts(unix), window, samples(最近 8 个采样)
    """
    store = _read_ea_floating_series()
    by_ea = store.get("by_ea") or {}
    # 容错: 兼容带后缀 / 不带后缀的 ea_name
    stem = (ea_name or "").strip()
    for ext in (".mq5", ".ex5", ".mqh", ".set"):
        if stem.lower().endswith(ext):
            stem = stem[: -len(ext)]
            break
    entry = by_ea.get(stem) or by_ea.get(ea_name) or {}
    pts = entry.get("points") or []
    if not isinstance(pts, list) or not pts:
        return {"ok": True, "ea_name": ea_name, "points": 0,
                "note": "暂无 floating 序列数据 (Stage A 上线后才开始累计 / 该 EA 无持仓 → 不上报)"}
    # window 过滤
    import time as _t
    now = int(_t.time())
    win_sec = {"24h": 86400, "7d": 7*86400, "30d": 30*86400}.get(str(window or "all").lower(), None)
    if win_sec is not None:
        cutoff = now - win_sec
        filt = [p for p in pts if isinstance(p, dict) and (p.get("ts") or 0) >= cutoff]
    else:
        filt = [p for p in pts if isinstance(p, dict)]
    if not filt:
        return {"ok": True, "ea_name": ea_name, "points": 0, "window": window,
                "note": "窗口内无样本 (该 EA 在窗口里全程无持仓)"}
    vals = [(int(p.get("ts") or 0), float(p.get("fp") or 0), int(p.get("n") or 0)) for p in filt]
    vals.sort(key=lambda x: x[0])
    fps = [v[1] for v in vals]
    peak = fps[0]
    max_dd = 0.0
    trough = fps[0]
    deepest_ts = vals[0][0]
    for ts, fp, _n in vals:
        if fp > peak:
            peak = fp
        dd = peak - fp
        if dd > max_dd:
            max_dd = dd
            trough = fp
            deepest_ts = ts
    last = vals[-1]
    # 给 AI 看末 8 个样本 (留尾巴方便核验)
    tail = [{"ts": t, "fp": round(f, 2), "n": n} for t, f, n in vals[-8:]]
    return {
        "ok": True,
        "ea_name": ea_name,
        "account_login": entry.get("account_login"),
        "window": window or "all",
        "points": len(vals),
        "current_floating": round(last[1], 2),
        "current_positions": last[2],
        "peak_floating_in_window": round(max(fps), 2),
        "trough_floating_in_window": round(min(fps), 2),
        "deepest_drawdown_usd": round(max_dd, 2),
        "deepest_drawdown_at_ts": deepest_ts,
        "deepest_drawdown_at_iso": _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime(deepest_ts)),
        "samples_tail": tail,
    }


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Execute tool calls."""
    if name in {"run_backtest", "get_backtest_status", "list_backtests", "cancel_backtest", "panic_stop_all"}:
        return _offline_backtest_tool(name, arguments or {})

    # 0.3.52: 临时 spawn 的 python 子进程（callEasydealMcpOnce 从 main.js 拉起来
    # 调单一 tool 直接走 tools/call）不会先打 tools/list，所以 list_tools 里的
    # services_started lazy init 永远不触发 → strategy_instance 一直 None →
    # get_strategy() 抛 "交易上下文未初始化" → 客户端 UI 显示「返空响应」。
    # 用户「自动挂载一直失败」根因。
    #
    # 这里只 lazy-init 最小必需的 strategy_instance（=mt5.initialize() + 配置
    # 读取），不跑 start_all_services 里的 Flask / Monitor / scheduler 三个常驻
    # 线程 —— 那些是给 long-running 主 MCP 进程的，临时 spawn 跑会撞端口 8888
    # 跟主进程抢资源。
    global strategy_instance
    if strategy_instance is None:
        try:
            strategy_instance = TradingContext()
            logging.info(
                "[lazy-init] strategy_instance created via tools/call (running=%s)",
                strategy_instance.running)
        except Exception as _init_e:
            logging.exception(f"[lazy-init] TradingContext failed: {_init_e}")
    try:
        strategy = get_strategy()
        arguments = arguments or {}
        # easydeal-settings MCP 改了 settings.json 的话，这里 cheap stat 一下；
        # 检测到变更就重新绑 MT5 + 同步监控配置。一次工具调用一次 stat 不会
        # 卡顿，重活只在 mtime 变了时才跑。
        _maybe_reload_settings()

        if name == "get_monitor_logs":
            date_prefix = arguments.get("date") or _bj_date_str()
            log_type = str(arguments.get("type", "ALL")).upper()
            limit = int(arguments.get("limit", 100))

            keywords = None
            if log_type == "OPEN":
                keywords = ["[OPEN]"]
            elif log_type == "CLOSE":
                keywords = ["[CLOSE]"]
            elif log_type == "UPDATE":
                keywords = ["[UPDATE]"]
            elif log_type == "WARNING":
                keywords = ["WARNING"]
            elif log_type == "ERROR":
                keywords = ["ERROR"]

            # TimedRotatingFileHandler 把昨天及更早的内容轮转到
            # easydeal.log.<YYYY-MM-DD>，active 文件 easydeal.log 只含当天。
            today = _bj_date_str()
            target_file = log_file
            if date_prefix != today:
                rotated = f"{log_file}.{date_prefix}"
                if os.path.exists(rotated):
                    target_file = rotated

            lines = _read_recent_lines(
                target_file,
                limit=limit,
                date_prefix=date_prefix,
                keywords=keywords
            )
            result = {
                "date": date_prefix,
                "type": log_type,
                "source": os.path.basename(target_file),
                "count": len(lines),
                "lines": lines
            }
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "get_mt5_logs":
            date_str = arguments.get("date") or _bj_date_str()
            keyword = arguments.get("keyword")
            page = int(arguments.get("page", 1))
            page_size = int(arguments.get("page_size", 50))
            # 0.3.235: 多 MT5 — instance_id 指定时从对应 install_dir 推 data_dir
            instance_id = arguments.get("instance_id")
            data_path = _resolve_data_path_for_instance(instance_id)
            if not data_path:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "MT5 data path 不可用 — 实例 ID 不存在或 MT5 没在跑"}, ensure_ascii=False))]
            mt5_log_dir = os.path.join(data_path, "Logs")
            result = _read_mt5_log(mt5_log_dir, date_str, keyword=keyword, page_size=page_size, page=page)
            result["instance_id"] = instance_id or "default"
            result["data_path"] = data_path
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "get_ea_logs":
            date_str = arguments.get("date") or _bj_date_str()
            keyword = arguments.get("keyword")
            page = int(arguments.get("page", 1))
            page_size = int(arguments.get("page_size", 50))
            instance_id = arguments.get("instance_id")
            data_path = _resolve_data_path_for_instance(instance_id)
            if not data_path:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "MT5 data path 不可用 — 实例 ID 不存在或 MT5 没在跑"}, ensure_ascii=False))]
            ea_log_dir = os.path.join(data_path, "MQL5", "Logs")
            result = _read_mt5_log(ea_log_dir, date_str, keyword=keyword, page_size=page_size, page=page)
            result["instance_id"] = instance_id or "default"
            result["data_path"] = data_path
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "get_trading_status":
            # 0.3.235: 接 instance_id — 多 MT5 用户精确指定时切对应 SDK 上下文
            instance_id = arguments.get("instance_id")
            try:
                with _Mt5InstanceContext(instance_id):
                    status = strategy.get_status()
                    if isinstance(status, dict):
                        status["instance_id"] = instance_id or "default"
                        # 0.4.x: 补「今日已平仓成交」—— AI 回答「今天平了没 / 平了几笔 /
                        # 盈亏多少」时常只看当前持仓 (get_status) → 漏掉已平仓的, 误报「0 笔」。
                        # 这里直接查当日 MT5 成交历史的平仓腿 (entry=DEAL_ENTRY_OUT), 不管是
                        # 客户端 / 微信 / 定时任务 / EA 谁平的都能看到。失败不影响主输出。
                        try:
                            import datetime as _dt2
                            _t0 = _dt2.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
                            _deals = mt5.history_deals_get(_t0, _dt2.datetime.now()) or []
                            _closed = []
                            for _dl in _deals:
                                if getattr(_dl, "entry", None) == 1 and getattr(_dl, "type", 99) in (0, 1):
                                    _closed.append({
                                        "ticket": getattr(_dl, "position_id", None) or getattr(_dl, "ticket", None),
                                        "symbol": getattr(_dl, "symbol", ""),
                                        "volume": getattr(_dl, "volume", 0),
                                        "profit": round(float(getattr(_dl, "profit", 0)) + float(getattr(_dl, "swap", 0)) + float(getattr(_dl, "commission", 0)), 2),
                                        "magic": getattr(_dl, "magic", 0),
                                        "time": _ts_to_bj_str(getattr(_dl, "time", 0), "%H:%M:%S"),  # 真北京时间(走券商偏移)
                                    })
                            status["today_closed_deals"] = {
                                "count": len(_closed),
                                "total_pnl": round(sum(d["profit"] for d in _closed), 2),
                                "deals": _closed[-20:],
                                "note": "今日已平仓的成交 (含客户端/微信/定时任务/EA 任何来源)。回答「今天平了没/几笔/盈亏」看这里, 别只看当前持仓。",
                            }
                        except Exception as _e:
                            logging.debug(f"[get_trading_status] today_closed_deals failed: {_e}")
                        # 0.3.328: 列出其他可切的 MT5 实例 + 显式提示 AI 切实例方法.
                        # 解决「AI 抱怨 MCP 只能看默认实例切不到别的」误解 —
                        # 实际 instance_id 参数能切, 但 AI 不会主动用. 显式列出来 +
                        # 给 example 让 AI 看到就懂.
                        try:
                            _all_instances, _active_id = _read_mt5_instances_from_settings()
                            _others = []
                            for _inst in (_all_instances or []):
                                _id = _inst.get("id")
                                if _id and _id != instance_id and _id != _active_id:
                                    _others.append({
                                        "instance_id": _id,
                                        "name": _inst.get("name") or _id,
                                        "install_dir": _inst.get("installDir"),
                                    })
                            if _others or (_active_id and not instance_id):
                                status["available_instances"] = {
                                    "current_query": instance_id or f"default (active={_active_id})",
                                    "others": _others,
                                    "hint": (
                                        "要看其他 MT5 实例的盘面, 用 instance_id 参数再调一次本工具. "
                                        "例: get_trading_status(instance_id='<above id>'). "
                                        "或者用 list_all_mt5_status 一次拿全部聚合."
                                    ),
                                }
                        except Exception as _e:
                            logging.debug(f"[get_trading_status] list available_instances failed: {_e}")
                    return [TextContent(type="text", text=json.dumps(status, ensure_ascii=False, indent=2))]
            except (ValueError, RuntimeError) as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e), "instance_id": instance_id}, ensure_ascii=False))]

        if name == "list_all_mt5_status":
            # 0.3.235: 多 MT5 聚合视图 — 遍历 settings.mt5Instances, 对每个 instance
            # rebind SDK → account_info / positions / terminal_info → 收集. 完了 rebind
            # 回 active instance 防其它工具调用受影响. 该实例 MT5 没在跑就跳过 init 返
            # running=false (跟 _rebind_mt5 既有 _ezd_terminal_is_running 守护一致).
            result = _list_all_mt5_status_impl((arguments or {}).get("instance_ids"))
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "get_economic_calendar":
            return _get_economic_calendar_tool(arguments)

        if name == "get_market_info":
            # 0.3.235: instance_id 指定时切换 SDK
            instance_id = arguments.get("instance_id")
            try:
                with _Mt5InstanceContext(instance_id):
                    # 0.3.335: 优先用 mounted-state.json 拿当前 SDK 连的 install_dir
                    # 上挂的 EA 的 symbol (用户挂载时确定的). 比 strategy.symbol
                    # (active strategy 的) 准. fallback 是 fuzzy match.
                    effective_symbol = strategy.symbol
                    try:
                        _ti = mt5.terminal_info()
                        if _ti:
                            _install_dir = getattr(_ti, "path", None)
                            if _install_dir:
                                _mstate = _load_mounted_state(_install_dir)
                                if _mstate and _mstate.get("symbol"):
                                    effective_symbol = _mstate["symbol"]
                    except Exception:
                        pass
                    resolved_symbol = effective_symbol
                    symbol_info = mt5.symbol_info(effective_symbol)
                    if symbol_info is None:
                        try:
                            _picked, _ = _pick_chartable_symbol([effective_symbol])
                            if _picked:
                                resolved_symbol = _picked
                                symbol_info = mt5.symbol_info(resolved_symbol)
                        except Exception:
                            pass
                    if symbol_info is None:
                        return [TextContent(type="text", text=json.dumps({
                            "error": "market info unavailable",
                            "instance_id": instance_id or "default",
                            "symbol_tried": effective_symbol,
                            "hint": f"broker 上没找到 {effective_symbol} 也没找到 fuzzy match. 该 broker 可能不支持此品种."
                        }, ensure_ascii=False))]
                    market_info = {
                        "instance_id": instance_id or "default",
                        "symbol": resolved_symbol,
                        "effective_symbol": effective_symbol if effective_symbol != resolved_symbol else None,
                        "active_strategy_symbol": strategy.symbol if strategy.symbol != effective_symbol else None,
                        "bid": symbol_info.bid,
                        "ask": symbol_info.ask,
                        "spread": symbol_info.spread,
                        "time": _now_bj_str()
                    }
                    return [TextContent(type="text", text=json.dumps(market_info, ensure_ascii=False, indent=2))]
            except (ValueError, RuntimeError) as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e), "instance_id": instance_id}, ensure_ascii=False))]

        if name == "list_recent_news":
            # 0.3.14: 读 Electron 主进程 newsProvider 维护的本地缓存。
            # 缓存路径在 EASYDEAL_NEWS_BUFFER_FILE env（由 knowledge-base.js
            # 写到 .mcp.json 的 env 块里）。缓存内容是 jin10 解析后的 array。
            # 0.3.219: minutes_back > 60 自动扫 EASYDEAL_NEWS_DAILY_DIR 下的
            # YYYY-MM-DD.jsonl 跨日合并; 上限 30 天 (43200 分钟).
            buffer_path = os.getenv("EASYDEAL_NEWS_BUFFER_FILE")
            daily_dir = os.getenv("EASYDEAL_NEWS_DAILY_DIR")
            mins = int(arguments.get("minutes_back", 30) or 30)
            mins = max(1, min(mins, 43200))   # 30 天上限
            kw_raw = arguments.get("keyword_filter") or []
            kws = [str(k).strip() for k in kw_raw if str(k).strip()] if isinstance(kw_raw, list) else []
            important_only = bool(arguments.get("important_only"))
            max_items = int(arguments.get("max_items", 30) or 30)
            max_items = max(1, min(max_items, 500))   # 500 上限
            cutoff_ms = int(time.time() * 1000) - mins * 60_000

            def _matches(it, hay_kws):
                if not isinstance(it, dict): return False
                ts = it.get("ts")
                if isinstance(ts, (int, float)) and ts < cutoff_ms: return False
                if important_only and not it.get("important"): return False
                if hay_kws:
                    hay = (it.get("title") or "") + "\n" + (it.get("content") or "")
                    if not any(k in hay for k in hay_kws): return False
                return True

            def _shape(it):
                # 压缩字段: UI 用的 source_link / channel / type 这些 AI 不需要
                return {
                    "id": it.get("id"),
                    "time": it.get("time"),
                    "important": int(it.get("important") or 0),
                    "title": it.get("title") or "",
                    "content": it.get("content") or "",
                    "tags": it.get("tags") or [],
                    "remark": [
                        {"title": r.get("title"), "symbol": r.get("symbol")}
                        for r in (it.get("remark") or [])
                        if isinstance(r, dict)
                    ],
                }

            # 短窗 (<= 60min) 走 in-memory buffer (快路径)
            if mins <= 60:
                if not buffer_path or not os.path.isfile(buffer_path):
                    return [TextContent(type="text", text=json.dumps({
                        "ok": False,
                        "error": "金十快讯缓存还没就绪 — 客户端可能刚启动还没拉到第一批，"
                                 "或主进程的 news-provider 没起来。30 秒后再试。",
                        "buffer_path": buffer_path,
                    }, ensure_ascii=False))]
                try:
                    with open(buffer_path, "r", encoding="utf-8") as _f:
                        items = json.load(_f) or []
                except Exception as _e:
                    return [TextContent(type="text", text=json.dumps({
                        "ok": False, "error": f"读缓存失败：{_e}",
                        "buffer_path": buffer_path,
                    }, ensure_ascii=False))]
                if not isinstance(items, list): items = []
                out = []
                for it in items:
                    if not _matches(it, kws): continue
                    out.append(_shape(it))
                    if len(out) >= max_items: break
                return [TextContent(type="text", text=json.dumps({
                    "ok": True,
                    "source": "buffer",
                    "count": len(out),
                    "minutes_back": mins,
                    "keyword_filter": kws,
                    "important_only": important_only,
                    "items": out,
                }, ensure_ascii=False, indent=2))]

            # 长窗 (> 60min) 扫 daily files 跨日合并 + 去重
            if not daily_dir or not os.path.isdir(daily_dir):
                # 客户端版本太老没 daily archive — 回退到 buffer (会拿不全)
                if buffer_path and os.path.isfile(buffer_path):
                    try:
                        with open(buffer_path, "r", encoding="utf-8") as _f:
                            items = json.load(_f) or []
                    except Exception:
                        items = []
                    out = []
                    for it in items:
                        if not _matches(it, kws): continue
                        out.append(_shape(it))
                        if len(out) >= max_items: break
                    return [TextContent(type="text", text=json.dumps({
                        "ok": True,
                        "source": "buffer_only",
                        "note": "客户端版本没启用 daily archive, 仅能拿到内存 buffer 里的近期数据 (~200 条).",
                        "count": len(out),
                        "minutes_back": mins,
                        "keyword_filter": kws,
                        "important_only": important_only,
                        "items": out,
                    }, ensure_ascii=False, indent=2))]
                return [TextContent(type="text", text=json.dumps({
                    "ok": False,
                    "error": "daily archive 目录不存在 + 缓存文件也找不到. 客户端 news-provider 没起来.",
                    "daily_dir": daily_dir,
                }, ensure_ascii=False))]

            # 0.3.296: 移除冗余 `from datetime import datetime, timedelta` —
            # module 顶部 line 21 已 import. 这条内部 import 让 Python 把整个
            # call_tool 函数里的 `datetime` 视为 local variable → 任何在它之前
            # 用 datetime 的 handler 块 (get_profit_history line 5763 / 别的 N 处)
            # 都撞 UnboundLocalError "cannot access local variable 'datetime'
            # where it is not associated with a value". 用户 0.3.290 用 retry
            # + traceback_tail 暴露出这个 bug — 现在删了内部 import 让所有
            # handler 都用 module-level datetime.
            # 算 cutoff 覆盖的日期范围 (含 1 天余地防时区边界)
            cutoff_date = datetime.fromtimestamp((cutoff_ms / 1000) - 86400)
            today = datetime.now()
            dates_to_scan = []
            cursor = datetime(today.year, today.month, today.day)
            stop = datetime(cutoff_date.year, cutoff_date.month, cutoff_date.day)
            while cursor >= stop:
                dates_to_scan.append(cursor.strftime("%Y-%m-%d"))
                cursor -= timedelta(days=1)

            seen = set()
            all_items = []   # 倒序 (newest first)
            files_scanned = 0
            for d in dates_to_scan:
                if len(all_items) >= max_items: break
                fp = os.path.join(daily_dir, f"{d}.jsonl")
                if not os.path.isfile(fp): continue
                files_scanned += 1
                day_items = []
                try:
                    with open(fp, "r", encoding="utf-8") as _f:
                        for ln in _f:
                            ln = ln.strip()
                            if not ln: continue
                            try:
                                it = json.loads(ln)
                            except Exception:
                                continue
                            if not isinstance(it, dict): continue
                            iid = it.get("id")
                            if iid in seen: continue
                            seen.add(iid)
                            if not _matches(it, kws): continue
                            day_items.append(it)
                except Exception:
                    continue
                # 当日内倒序
                day_items.sort(key=lambda x: x.get("ts") or 0, reverse=True)
                for it in day_items:
                    all_items.append(_shape(it))
                    if len(all_items) >= max_items: break

            return [TextContent(type="text", text=json.dumps({
                "ok": True,
                "source": "daily_archive",
                "files_scanned": files_scanned,
                "count": len(all_items),
                "minutes_back": mins,
                "keyword_filter": kws,
                "important_only": important_only,
                "items": all_items,
            }, ensure_ascii=False, indent=2))]

        if name == "get_retail_sentiment":
            sym = str(arguments.get("symbol") or "").strip()
            if not sym:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "symbol 必填"}, ensure_ascii=False))]
            base = os.environ.get("EASYDEAL_API_BASE", "https://easydeal.fay-agent.com").rstrip("/")
            try:
                resp = requests.get(f"{base}/v1/sentiment", params={"match": sym}, timeout=10)
                d = resp.json()
            except Exception as e:
                return [TextContent(type="text", text=json.dumps(
                    {"error": f"查询散户情绪失败: {e}"}, ensure_ascii=False))]
            m = d.get("matched")
            if not m:
                return [TextContent(type="text", text=json.dumps(
                    {"ok": True, "symbol": sym, "matched": None,
                     "note": d.get("note") or "未找到该品种的散户情绪"}, ensure_ascii=False))]
            return [TextContent(type="text", text=json.dumps({
                "ok": True, "symbol": sym, "matched": m.get("name"),
                "long_pct": m.get("long"), "short_pct": m.get("short"),
                "long_lots": m.get("longLots"), "short_lots": m.get("shortLots"),
                "total_positions": m.get("total"),
                "avg_long_price": m.get("avgLong"), "avg_short_price": m.get("avgShort"),
                "updated_at": d.get("updated_at"),
                "hint": "long_pct/short_pct = 散户做多/做空人数占比%; 散户极度一边倒常作反向指标参考",
            }, ensure_ascii=False))]

        # 数据大屏 K 线(electron/mobile-relay.js 在序列号授权给大屏时调用, 见 board_kline.py)。
        # 内部上传用, 刻意不进 get_all_tools(): AI 看 K 线用 get_klines, 不需要这个。
        if name == "get_board_klines":
            result = _board_kline.collect(
                list(arguments.get("requests") or []),
                mt5=mt5,
                tf_consts=TIMEFRAME_MAP,
                instance=_Mt5InstanceContext,
                broker_offset=_BOARD_TICK_OFFSET,
                offset_hints=arguments.get("offsets") or {},
            )
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]

        if name == "get_klines":
            tf_map = {
                "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
                "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
                "D1": mt5.TIMEFRAME_D1, "W1": mt5.TIMEFRAME_W1, "MN1": mt5.TIMEFRAME_MN1,
            }
            tf_str = str(arguments.get("timeframe", "H1")).upper()
            if tf_str not in tf_map:
                return [TextContent(type="text", text=json.dumps(
                    {"error": f"unsupported timeframe: {tf_str}", "supported": list(tf_map.keys())},
                    ensure_ascii=False))]
            try:
                count = int(arguments.get("count", 2))
            except (TypeError, ValueError):
                count = 2
            count = max(1, min(count, 500))
            include_current = bool(arguments.get("include_current", False))
            start_pos = 0 if include_current else 1
            instance_id = arguments.get("instance_id")
            try:
                with _Mt5InstanceContext(instance_id):
                    # 0.3.335: 优先用 mounted-state.json 拿当前 SDK 连的 install_dir
                    # 上挂的 EA 的 symbol (跟 get_status / get_market_info 同款逻辑).
                    effective_symbol = strategy.symbol
                    try:
                        _ti = mt5.terminal_info()
                        if _ti:
                            _install_dir = getattr(_ti, "path", None)
                            if _install_dir:
                                _mstate = _load_mounted_state(_install_dir)
                                if _mstate and _mstate.get("symbol"):
                                    effective_symbol = _mstate["symbol"]
                    except Exception:
                        pass
                    # 0.3.330: fuzzy match fallback
                    resolved_symbol = effective_symbol
                    if mt5.symbol_info(effective_symbol) is None:
                        try:
                            _picked, _ = _pick_chartable_symbol([effective_symbol])
                            if _picked:
                                resolved_symbol = _picked
                        except Exception:
                            pass
                    rates = mt5.copy_rates_from_pos(resolved_symbol, tf_map[tf_str], start_pos, count)
                    if rates is None or len(rates) == 0:
                        return [TextContent(type="text", text=json.dumps(
                            {"error": "no kline data", "symbol_tried": resolved_symbol,
                             "effective_symbol": effective_symbol if effective_symbol != resolved_symbol else None,
                             "active_strategy_symbol": strategy.symbol if strategy.symbol != effective_symbol else None,
                             "timeframe": tf_str, "instance_id": instance_id or "default"},
                            ensure_ascii=False))]
                    # ⚠ MT5 epoch = 券商服务器时间. 探测偏移转真北京时间 (跟 market_data.time
                    # / as_of 同域, 可直接比较), 收盘判断用原始 server epoch (不依赖偏移).
                    _offset = _broker_offset_sec(resolved_symbol)
                    _stick = mt5.symbol_info_tick(resolved_symbol)
                    _server_now = int(_stick.time) if (_stick and getattr(_stick, "time", 0)) else None
                    _period_sec = {
                        "M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600,
                        "H4": 14400, "D1": 86400, "W1": 604800, "MN1": 2592000,
                    }.get(tf_str, 3600)
                    bars = []
                    for r in rates:
                        _ep = int(r["time"])
                        bars.append({
                            "time": _mt5_epoch_to_bj_str(_ep, _offset),   # 北京时间
                            "time_server": datetime.fromtimestamp(_ep, tz=pytz.utc).strftime("%Y-%m-%d %H:%M:%S"),  # 券商服务器墙上时间
                            "closed": (_server_now is not None and (_ep + _period_sec) <= _server_now),
                            "open": float(r["open"]),
                            "high": float(r["high"]),
                            "low": float(r["low"]),
                            "close": float(r["close"]),
                            "tick_volume": int(r["tick_volume"]),
                            "spread": int(r["spread"]),
                            "real_volume": int(r["real_volume"]),
                        })
                    result = {
                        "instance_id": instance_id or "default",
                        "symbol": resolved_symbol,
                        "effective_symbol": effective_symbol if effective_symbol != resolved_symbol else None,
                        "active_strategy_symbol": strategy.symbol if strategy.symbol != effective_symbol else None,
                        "timeframe": tf_str,
                        "count": len(bars),
                        "include_current": include_current,
                        "now_bj": _now_bj_str(),
                        "server_time": (datetime.fromtimestamp(_server_now, tz=pytz.utc).strftime("%Y-%m-%d %H:%M:%S") if _server_now is not None else None),
                        "broker_offset_hours": (round(_offset / 3600.0, 1) if _offset is not None else None),
                        "time_note": ("bars.time 为北京时间(可直接跟 now_bj 比), closed=该K线是否已收盘"
                                      if _offset is not None else
                                      "⚠券商时区未探测到(可能休市), time 暂按服务器墙上时间显示, 勿直接跟北京时间比"),
                        "bars": bars,
                    }
                    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
            except (ValueError, RuntimeError) as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e), "instance_id": instance_id}, ensure_ascii=False))]

        if name == "get_config":
            config = strategy.get_config_info()
            return ([], config)

        if name == "get_strategy_documentation":
            ok, doc = _get_or_generate_strategy_doc(strategy, arguments)
            return [TextContent(type="text", text=doc)]

        if name == "get_profit_history":
            start_time = arguments.get("start_time")
            end_time = arguments.get("end_time")
            if not start_time and not end_time:
                days = int(arguments.get("days", 30))
                end_dt = datetime.now()
                start_dt = end_dt - timedelta(days=days)
                start_time = start_dt.strftime("%Y-%m-%d %H:%M:%S")
                end_time = end_dt.strftime("%Y-%m-%d %H:%M:%S")
            # 0.3.97: 接 magic_filter — 调用方 (AI) 知道 EA magic 时可显式过滤，
            # 不传 / 空 list = 不按 magic 过滤（拿所有 EA 的 deal）
            # 0.3.119: 接 ea_name — 从 .easydeal-ea-monitor.json 取 per-EA cfg。
            #   优先级 magic_filter > ea_name > 全局 self.* 兜底
            magic_filter = arguments.get("magic_filter") or []
            ea_name = (arguments.get("ea_name") or "").strip() or None
            # 0.3.235: 多 MT5 — instance_id 指定时切换 SDK 拉对应 broker 的 deals
            instance_id = arguments.get("instance_id")
            # 0.3.290: catch 全部 Exception (之前只 catch ValueError/RuntimeError, 漏掉
            # TypeError / OSError / JSON serialization 等 → bubble 出去让 MCP stdio 挂掉,
            # AI 收到 transport error 概括成「Python 内部错误」). 同时返 traceback 让 AI
            # 能告诉用户具体哪行抛, 下次撞这个 bug 不用我们手动复现.
            try:
                with _Mt5InstanceContext(instance_id):
                    result = strategy.get_profit_history(
                        start_time=start_time, end_time=end_time,
                        magic_filter=magic_filter if isinstance(magic_filter, list) else [],
                        ea_name=ea_name,
                    )
                    if isinstance(result, dict):
                        result["instance_id"] = instance_id or "default"
                    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
            except Exception as e:
                import traceback as _tb
                tb_str = _tb.format_exc()
                logging.error(f"[get_profit_history] uncaught {type(e).__name__}: {e}\n{tb_str}")
                return [TextContent(type="text", text=json.dumps({
                    "error": f"{type(e).__name__}: {str(e)}",
                    "instance_id": instance_id,
                    "traceback_tail": tb_str.splitlines()[-6:] if tb_str else None,
                    "hint": "请把 traceback_tail 字段反馈给 EasyDeal 维护者 (0.3.290 加的诊断信息)",
                }, ensure_ascii=False))]

        # ---------- Strategy script improvement tools ----------

        if name == "get_orderguard_status":
            ok, ov = _orderguard_http_get("/overview-stats")
            if not ok:
                return [TextContent(type="text", text=json.dumps(
                    {"orderguard_available": False, "reason": ov,
                     "hint": "护航没启用/没启动 → 引导用户去「策略 → 🛡 护航」启用拦截或监控模式"},
                    ensure_ascii=False))]
            ok2, eas = _orderguard_http_get("/enabled-eas")
            _ov = ov.get("data", ov) if isinstance(ov, dict) else ov
            _eas = (eas.get("data", eas) if (ok2 and isinstance(eas, dict)) else None)
            return [TextContent(type="text", text=json.dumps(
                {"orderguard_available": True, "overview": _ov, "enabled_eas": _eas},
                ensure_ascii=False, indent=2))]

        if name == "get_orderguard_decisions":
            try:
                _lim = max(1, min(int(arguments.get("limit", 30)), 500))
            except (TypeError, ValueError):
                _lim = 30
            ok, resp = _orderguard_http_get("/decisions", {"limit": _lim, "ea": arguments.get("ea_name")})
            if not ok:
                return [TextContent(type="text", text=json.dumps(
                    {"orderguard_available": False, "reason": resp}, ensure_ascii=False))]
            _data = resp.get("data", resp) if isinstance(resp, dict) else resp
            return [TextContent(type="text", text=json.dumps(
                {"orderguard_available": True, "data": _data}, ensure_ascii=False, indent=2))]

        if name == "get_orderguard_stats":
            ok, resp = _orderguard_http_get("/stats")
            if not ok:
                return [TextContent(type="text", text=json.dumps(
                    {"orderguard_available": False, "reason": resp}, ensure_ascii=False))]
            _data = resp.get("data", resp) if isinstance(resp, dict) else resp
            return [TextContent(type="text", text=json.dumps(
                {"orderguard_available": True, "data": _data}, ensure_ascii=False, indent=2))]

        if name == "record_experience":
            _ea = arguments.get("ea_name") or arguments.get("ea") or _resolve_ea_filename()
            r = _append_experience(_ea, arguments.get("content", ""), arguments.get("category", ""))
            return [TextContent(type="text", text=json.dumps(r, ensure_ascii=False, indent=2))]

        if name == "read_experience":
            _ea = arguments.get("ea_name") or arguments.get("ea") or _resolve_ea_filename()
            r = _read_experience(_ea)
            return [TextContent(type="text", text=json.dumps(r, ensure_ascii=False, indent=2))]

        if name == "get_floating_drawdown":
            _ea = arguments.get("ea_name") or arguments.get("ea") or _resolve_ea_filename()
            _win = arguments.get("window") or "all"
            try:
                r = _floating_drawdown_for_ea(_ea, _win)
            except Exception as _e:
                r = {"ok": False, "error": str(_e)}
            return [TextContent(type="text", text=json.dumps(r, ensure_ascii=False, indent=2))]

        if name == "read_strategy_source":
            filepath = _get_strategy_file_path()
            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.readlines()
            start = max(1, int(arguments.get("start_line", 1)))
            end = int(arguments.get("end_line", len(lines)))
            end = min(end, len(lines))
            numbered = [f"{i}: {lines[i-1].rstrip()}" for i in range(start, end + 1)]
            result = {
                "file": filepath,
                "total_lines": len(lines),
                "range": f"{start}-{end}",
                "content": "\n".join(numbered)
            }
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "get_strategy_params":
            # 按调用方指定的 EA + 绑定实例读取(对齐 write_ea_parameters), 否则会读到
            # 默认/激活 EA + 默认实例的旧值, 表现为"改了参数保存后重开又还原"。
            _ea_arg = (arguments.get("ea_name") or "").strip() or None
            _inst_arg = arguments.get("instance_id")
            _dp = _resolve_data_path_for_instance(_inst_arg) if _inst_arg else None
            filepath = _get_strategy_file_path(_ea_arg, _dp)
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
            source_params = _parse_input_params(content)

            runtime_params = _load_params_from_runtime_json(_ea_arg, _dp) or {}
            config_params = _load_params_from_config_set(_ea_arg, _dp) or {}

            # 修「改参数保存后重开还原」: runtime.json 不再无条件优先于 config.set。
            # 按文件 mtime 决定 —— config.set 更新(用户刚保存, EA 还没把新值刷回 runtime.json,
            # 或这只 EA 根本不在 reload 后重写 runtime.json)→ 优先 config.set(用户保存值);
            # runtime.json 更新(EA 已应用并刷新)→ 优先 runtime.json(EA 真实运行值)。
            def _safe_mtime(_pp):
                try:
                    return os.path.getmtime(_pp) if (_pp and os.path.isfile(_pp)) else None
                except Exception:
                    return None
            _cfg_mtime = _safe_mtime(_get_config_set_path(_ea_arg, _dp))
            _rt_mtime = _safe_mtime(_get_runtime_json_path(_ea_arg, _dp))
            _prefer_config = (_cfg_mtime is not None and (_rt_mtime is None or _cfg_mtime >= _rt_mtime))

            merged = []
            for p in source_params:
                pname = p["name"]
                source_val = p["value"]
                runtime_val = runtime_params.get(pname)
                config_val = config_params.get(pname)

                if _prefer_config and config_val is not None:
                    effective = str(config_val)
                    source_tag = "config_set"
                elif runtime_val is not None:
                    effective = str(runtime_val)
                    source_tag = "runtime_json"
                elif config_val is not None:
                    effective = str(config_val)
                    source_tag = "config_set"
                else:
                    effective = source_val
                    source_tag = "source_default"

                merged.append({
                    "name": pname,
                    "type": p["type"],
                    "comment": p["comment"],
                    "effective_value": effective,
                    "effective_from": source_tag,
                    "source_default": source_val,
                    "runtime_value": str(runtime_val) if runtime_val is not None else None,
                    "config_set_value": str(config_val) if config_val is not None else None,
                })

            result = {
                "file": filepath,
                "param_count": len(merged),
                "runtime_source": "runtime_json" if runtime_params else None,
                "config_set_file": _get_config_set_path(_ea_arg, _dp),
                "config_set_overrides": len(config_params),
                "params": merged,
                "note": (
                    "effective_value 优先级按 mtime: config.set 与 runtime.json 谁的文件更新用谁的值 —— "
                    "刚保存(config.set 新)显示保存值; EA 应用并刷新 runtime.json 后(runtime 新)显示 EA 运行值; "
                    "都没有则 source_default。修了「改参数保存后重开还原」。"
                ),
            }
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "update_strategy_param":
            param_name = arguments["param_name"]
            new_value = str(arguments["new_value"])

            filepath = _get_strategy_file_path()
            with open(filepath, "r", encoding="utf-8") as f:
                source_params = _parse_input_params(f.read())
            by_name = {p["name"]: p for p in source_params}
            if param_name not in by_name:
                return [TextContent(type="text", text=json.dumps({
                    "error": f"Unknown param '{param_name}'",
                    "known_params": list(by_name.keys()),
                }, ensure_ascii=False))]

            try:
                normalized = _normalize_param_value(by_name[param_name]["type"], new_value)
            except ValueError as exc:
                return [TextContent(type="text", text=json.dumps({"error": str(exc)}, ensure_ascii=False))]

            cfg_path = _get_config_set_path()
            if not cfg_path:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "MT5 data_path unavailable — cannot locate MQL5/Files directory."},
                    ensure_ascii=False))]

            # Preserve existing entries and their order.
            entries: dict = {}
            order: list = []
            if os.path.isfile(cfg_path):
                try:
                    with open(cfg_path, "r", encoding="utf-8", errors="replace") as f:
                        for line in f:
                            s = line.strip()
                            if not s or s.startswith("#") or s.startswith(";") or "=" not in s:
                                continue
                            k, v = s.split("=", 1)
                            k = k.strip(); v = v.strip()
                            if not k or k == "ts":
                                continue
                            if k not in entries:
                                order.append(k)
                            entries[k] = v
                except Exception as exc:
                    logging.warning(f"config.set read failed before update ({cfg_path}): {exc}")

            old_value_in_config = entries.get(param_name)
            entries[param_name] = normalized
            if param_name not in order:
                order.append(param_name)

            ts_epoch = int(time.time())
            human_ts = datetime.fromtimestamp(ts_epoch).strftime("%Y-%m-%d %H:%M:%S")
            ea_base = os.path.splitext(_resolve_ea_filename())[0]
            out_lines = [
                f"# {ea_base} runtime overrides — written by easydeal_mcp at {human_ts}",
                "# EA OnTimer reloads this file when mtime advances (no recompile needed).",
                f"ts={ts_epoch}",
            ]
            for k in order:
                out_lines.append(f"{k}={entries[k]}")
            new_content = "\n".join(out_lines) + "\n"

            os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
            tmp_path = cfg_path + ".tmp"
            with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(new_content)
            os.replace(tmp_path, cfg_path)

            result = {
                "ok": True,
                "param": param_name,
                "type": by_name[param_name]["type"],
                "new_value": normalized,
                "old_value_in_config": old_value_in_config,
                "source_default": by_name[param_name]["value"],
                "config_file": cfg_path,
                "note": (
                    "已写入 config.set。EA 每 3 秒轮询该文件，检测到 mtime 变化即自动覆盖对应 runtime 变量并刷新 runtime.json；"
                    "不修改源码、无需重编译或重挂 EA。要回退为源码默认值：把该 param 改回 source_default 即可。"
                ),
            }
            logging.info(f"Runtime override written: {param_name} = {normalized} (prev={old_value_in_config})")
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "patch_strategy_code":
            search = arguments["search"]
            replace = arguments["replace"]
            confirm = bool(arguments.get("confirm", False))
            filepath = _get_strategy_file_path()

            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()

            count = content.count(search)
            if count == 0:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "Search string not found in strategy file", "search": search}, ensure_ascii=False))]

            if not confirm:
                # Preview mode: show context around matches
                previews = []
                start_idx = 0
                for i in range(count):
                    pos = content.find(search, start_idx)
                    ctx_start = max(0, content.rfind("\n", 0, max(0, pos - 80)) + 1)
                    ctx_end = min(len(content), content.find("\n", pos + len(search) + 80))
                    if ctx_end == -1:
                        ctx_end = len(content)
                    previews.append(content[ctx_start:ctx_end])
                    start_idx = pos + len(search)
                result = {"mode": "preview", "match_count": count, "previews": previews}
                return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

            # Execute replacement
            note = f"patch: {count} replacement(s), search='{search[:50]}'"
            backup_path = _backup_strategy(change_note=note)
            new_content = content.replace(search, replace)
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(new_content)

            result = {
                "mode": "applied",
                "match_count": count,
                "backup": os.path.basename(backup_path)
            }
            logging.info(f"Strategy code patched: {count} replacement(s)")
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "compile_strategy":
            # Optional ea_name: if supplied, find that specific .mq5 source
            # (workspace/strategies/<name>.mq5 → MQL5/Experts/<name>.mq5)
            # and copy it into MT5/Experts/ before compile, so the resulting
            # .ex5 is in the canonical location MT5 / our backtester expect.
            requested_ea = (arguments.get("ea_name") or "").strip()
            filepath = None
            workspace_dir = os.getenv("EASYDEAL_WORKSPACE_DIR")
            # SDK 没连上时 terminal_info() 为 None → 退回 EASYDEAL_MT5_DATA_DIR。
            # 否则命令里没有 /include, MetaEditor 落到 AppData 的 hash 数据目录
            # (便携 MT5 那份通常没 Include) → `error 106: Trade.mqh not found`,
            # 且 .ex5 编在 workspace 里不进 MT5/Experts。
            data_path_for_ea = _get_mt5_data_path() or _resolve_mt5_data_dir()
            if requested_ea:
                ea_basename = requested_ea
                if not ea_basename.lower().endswith(".mq5"):
                    ea_basename += ".mq5"
                # Look for the source .mq5
                src_candidates = []
                if workspace_dir:
                    src_candidates.append(os.path.join(workspace_dir, "strategies", ea_basename))
                if data_path_for_ea:
                    src_candidates.append(os.path.join(data_path_for_ea, "MQL5", "Experts", ea_basename))
                src_mq5 = next((p for p in src_candidates if os.path.isfile(p)), None)
                # 0.3.12 (simon case): flat 没找到 → 递归扫子目录。MT5
                # Navigator 支持把 EA 组织进子目录 (MQL5\Experts\MyDir\
                # <EA>.mq5)，用户手动这么放是合法操作。之前只看两条 flat
                # 路径 → 报 "未找到" → AI fallback 走 _get_strategy_file_path
                # → 找到子目录的 → 编译 in-place 到子目录 → EasyDeal
                # _verifyAgainstMt5 看不到 → 一直报错位。
                # 这里主动递归找：找到就在子目录就地编译，保留用户的目录
                # 组织（不强行搬到 flat）。
                if not src_mq5 and data_path_for_ea:
                    experts_root = os.path.join(data_path_for_ea, "MQL5", "Experts")
                    if os.path.isdir(experts_root):
                        target_lower = ea_basename.lower()
                        candidates = []
                        max_depth = 6
                        try:
                            base_depth = experts_root.rstrip(os.sep).count(os.sep)
                            for root, dirs, files in os.walk(experts_root):
                                cur_depth = root.rstrip(os.sep).count(os.sep) - base_depth
                                if cur_depth > max_depth:
                                    dirs[:] = []
                                    continue
                                for fn in files:
                                    if fn.lower() == target_lower:
                                        candidates.append(os.path.join(root, fn))
                        except Exception as _walk_e:
                            logging.warning(
                                "[compile_strategy] recursive scan failed: %s", _walk_e)
                        if candidates:
                            # Pick the newest (most recently edited) — tie-break
                            # by shortest path (favor flatter location).
                            candidates.sort(
                                key=lambda p: (-os.path.getmtime(p), len(p)))
                            src_mq5 = candidates[0]
                            logging.info(
                                "[compile_strategy] %s found via recursive scan at %s "
                                "(of %d candidates)", ea_basename, src_mq5, len(candidates))
                if not src_mq5:
                    return [TextContent(type="text", text=json.dumps(
                        {"error": f"未找到 {ea_basename}",
                         "looked_in": src_candidates,
                         "recursive_scan_root": (
                             os.path.join(data_path_for_ea, "MQL5", "Experts")
                             if data_path_for_ea else None
                         )}, ensure_ascii=False))]
                # Decide where to compile:
                #   - Source already under MT5/Experts (any depth) → compile in place.
                #     This preserves the user's subfolder organization (simon case).
                #   - Source only in workspace/strategies → copy to canonical FLAT
                #     location MT5/Experts/<EA>.mq5 then compile there.
                if data_path_for_ea:
                    experts_root = os.path.join(data_path_for_ea, "MQL5", "Experts")
                    is_under_experts = (
                        os.path.abspath(src_mq5).lower().startswith(
                            os.path.abspath(experts_root).lower() + os.sep)
                    )
                    if is_under_experts:
                        # Compile in place — don't disturb user's folder layout.
                        filepath = src_mq5
                    else:
                        # Workspace source → copy to flat canonical and compile there.
                        target_dir = experts_root
                        os.makedirs(target_dir, exist_ok=True)
                        target_mq5 = os.path.join(target_dir, ea_basename)
                        if os.path.abspath(src_mq5) != os.path.abspath(target_mq5):
                            import shutil as _sh
                            _sh.copy2(src_mq5, target_mq5)
                        filepath = target_mq5
                else:
                    filepath = src_mq5
            else:
                # Backward-compat: no name given → fall back to "the EA on chart"
                # discovery. Useful for users who only ever run one EA.
                filepath = _get_strategy_file_path()

            metaeditor = _get_metaeditor_path()

            if not metaeditor or not os.path.isfile(metaeditor):
                return [TextContent(type="text", text=json.dumps(
                    {"error": f"MetaEditor64 not found: '{metaeditor}'. "
                              "Ensure MT5 is initialized, or set METAEDITOR_PATH env var."},
                    ensure_ascii=False))]

            # 0.4.3: 每次编译前把 EasyDealAuth.mqh SDK 部署到 MT5/Include/
            # —— 卖家上架时 EA 里 #include <EasyDealAuth.mqh>，MetaEditor
            # 必须能在 Include 里找到才能编译过。幂等，sha 一样跳过。
            _auth_sdk_deploy = _ensure_easydeal_auth_mqh_deployed()
            if not _auth_sdk_deploy.get("ok"):
                logging.warning("[compile] EasyDealAuth.mqh 部署失败: %s",
                                _auth_sdk_deploy.get("reason"))

            # 0.3.133: 每次编译前把 OrderGuard.mqh + EasyDealCopyTrade.mqh 也部署
            # 到 live MT5 的 MQL5/Include/ —— EA 启用了拦截 / 跟单 hook 时 .mq5
            # 会 `#include <OrderGuard.mqh>` 或 `#include <EasyDealCopyTrade.mqh>`，
            # 必须能找到才编得过。覆盖 case：
            #   ① 老用户启用 OrderGuard 后 deployIntercept 已写一份（这里幂等覆盖）
            #   ② 用户从来没启用过但 .mq5 引用了（AI 帮加 / 抄别人代码）→ 这里救一下
            try:
                if data_path_for_ea:
                    _stage_easydeal_includes(data_path_for_ea)
            except Exception as _inc_e:
                logging.warning("[compile] OrderGuard.mqh/CopyTrade.mqh 部署失败: %s", _inc_e)

            # Pick a writable log location. Prefer MT5 data_path/MQL5/Logs
            # (MetaEditor writes its own logs there, so permission is guaranteed);
            # fall back to system temp.
            data_path = data_path_for_ea
            if data_path and os.path.isdir(os.path.join(data_path, "MQL5", "Logs")):
                log_dir = os.path.join(data_path, "MQL5", "Logs")
            else:
                import tempfile
                log_dir = tempfile.gettempdir()
            log_file_path = os.path.join(
                log_dir,
                f"{os.path.basename(filepath)}.mcp_compile_{int(time.time())}.log"
            )
            # Ensure no stale log from previous run
            if os.path.isfile(log_file_path):
                try:
                    os.remove(log_file_path)
                except OSError:
                    pass

            # Build the command line as a string so the flag syntax matches
            # MetaEditor's expectation: `/compile:"<path>"` with the QUOTES
            # around the path only, not around the whole flag.
            include_part = ""
            portable_part = ""
            if data_path:
                include_path = os.path.join(data_path, "MQL5")
                include_part = f' /include:"{include_path}"'
                # 便携 MT5 (data dir == 安装目录): 带 /portable, MetaEditor 自身的
                # 配置/日志也落安装目录, 不去 AppData 另起一份数据目录。
                _norm = lambda p: os.path.normcase(os.path.normpath(p))
                if _norm(data_path) == _norm(os.path.dirname(metaeditor)):
                    portable_part = " /portable"
            cmd_str = (
                f'"{metaeditor}"'
                f'{portable_part}'
                f' /compile:"{filepath}"'
                f'{include_part}'
                f' /log:"{log_file_path}"'
            )

            # Detect pre-existing MetaEditor instances using full tasklist path.
            preexisting_instances = -1
            tasklist_exe = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                         "System32", "tasklist.exe")
            tasklist_err = None
            if os.path.isfile(tasklist_exe):
                try:
                    tl = subprocess.run(
                        [tasklist_exe, "/FI", "IMAGENAME eq MetaEditor64.exe", "/NH"],
                        capture_output=True, text=True, timeout=5
                    )
                    preexisting_instances = sum(
                        1 for line in (tl.stdout or "").splitlines()
                        if "MetaEditor64.exe" in line
                    )
                except Exception as exc:
                    tasklist_err = str(exc)
            else:
                tasklist_err = f"tasklist.exe not found at {tasklist_exe}"

            # Capture .ex5 mtime before compile to detect whether MetaEditor actually rebuilt.
            ex5_path = os.path.splitext(filepath)[0] + ".ex5"
            ex5_mtime_before = os.path.getmtime(ex5_path) if os.path.isfile(ex5_path) else None

            # Hash-based skip: if .ex5 already exists AND was compiled from
            # this exact source content (sidecar `<ex5>.compiled_from` carries
            # the recorded src sha256), skip recompile entirely.
            #
            # WHY this matters — the MT5 client tracks 「运行时长」 from the
            # `loaded successfully` log timestamp, and flags 「需重新挂载」
            # whenever the deployed .ex5's mtime is newer than that. A
            # gratuitous recompile (same source content) touches mtime,
            # tripping that warning and effectively resetting the user's
            # perception of EA uptime even though the running binary didn't
            # change. Skipping unchanged sources keeps the running EA's
            # mount status clean.
            import hashlib as _hash
            try:
                with open(filepath, "rb") as _src_f:
                    _src_sha = _hash.sha256(_src_f.read()).hexdigest()
            except Exception:
                _src_sha = None

            _sidecar = ex5_path + ".compiled_from"
            if (_src_sha and os.path.isfile(ex5_path) and os.path.isfile(_sidecar)):
                try:
                    with open(_sidecar, "r", encoding="utf-8") as _sf:
                        _stored_sha = _sf.read().strip()
                except Exception:
                    _stored_sha = ""
                if _stored_sha == _src_sha:
                    return [TextContent(type="text", text=json.dumps({
                        "ok": True,
                        "skipped_recompile": True,
                        "reason": ("源码 sha256 未变 — 保持现有 .ex5 不动，避免触发"
                                   "客户端 mount 检测的『需重新挂载』警告。"),
                        "ex5_path": ex5_path,
                        "ex5_mtime": ex5_mtime_before,
                        "src_sha256": _src_sha,
                    }, ensure_ascii=False))]

            try:
                proc = subprocess.run(
                    cmd_str,
                    capture_output=True, text=True, timeout=120,
                    cwd=os.path.dirname(metaeditor),  # MetaEditor install dir, not EA's
                    shell=False
                )
            except subprocess.TimeoutExpired:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "Compilation timed out (120s)"}, ensure_ascii=False))]

            # Poll for up to 30s for async completion (in case another MetaEditor
            # instance handled it and writes log/ex5 after our subprocess exits).
            poll_deadline = time.time() + 30
            while time.time() < poll_deadline:
                if os.path.isfile(log_file_path):
                    break
                cur_mtime = os.path.getmtime(ex5_path) if os.path.isfile(ex5_path) else None
                if cur_mtime is not None and (ex5_mtime_before is None or cur_mtime > ex5_mtime_before):
                    break
                time.sleep(0.5)

            ex5_mtime_after = os.path.getmtime(ex5_path) if os.path.isfile(ex5_path) else None
            ex5_rebuilt = (
                ex5_mtime_after is not None
                and (ex5_mtime_before is None or ex5_mtime_after > ex5_mtime_before)
            )

            # Read compile log with BOM-based encoding detection
            compile_log = ""
            log_read_error = None
            if os.path.isfile(log_file_path):
                try:
                    with open(log_file_path, "rb") as f:
                        raw = f.read()
                    if raw.startswith(b"\xff\xfe"):
                        compile_log = raw[2:].decode("utf-16-le", errors="replace")
                    elif raw.startswith(b"\xfe\xff"):
                        compile_log = raw[2:].decode("utf-16-be", errors="replace")
                    elif raw.startswith(b"\xef\xbb\xbf"):
                        compile_log = raw[3:].decode("utf-8", errors="replace")
                    else:
                        # No BOM; MetaEditor typically writes UTF-16-LE. Try it first.
                        try:
                            compile_log = raw.decode("utf-16-le")
                        except UnicodeDecodeError:
                            compile_log = raw.decode("utf-8", errors="replace")
                finally:
                    try:
                        os.remove(log_file_path)
                    except OSError:
                        pass
            else:
                log_read_error = f"Log file not created at {log_file_path}"

            # Parse errors/warnings. MetaEditor lines look like:
            #   "file.mq5(123,45) : error 145: syntax error"
            # Summary line "Result: 0 error(s), 0 warning(s)" must NOT be treated as an error.
            error_re = re.compile(r':\s*error\s+\d+\s*:', re.IGNORECASE)
            warning_re = re.compile(r':\s*warning\s+\d+\s*:', re.IGNORECASE)
            errors = [l.strip() for l in compile_log.splitlines() if error_re.search(l)]
            warnings = [l.strip() for l in compile_log.splitlines() if warning_re.search(l)]

            # Extract summary "N error(s), M warning(s)" — authoritative if present.
            summary_re = re.compile(r'(\d+)\s*error\(s\)\s*,\s*(\d+)\s*warning\(s\)', re.IGNORECASE)
            summary_match = summary_re.search(compile_log)
            summary_err = summary_warn = None
            if summary_match:
                summary_err = int(summary_match.group(1))
                summary_warn = int(summary_match.group(2))

            # Success requires: log actually read AND 0 errors by both detailed and summary counts.
            log_empty = not compile_log.strip()
            if log_empty:
                success = False
                status = "log_empty_or_unreadable"
            elif summary_err is not None:
                success = summary_err == 0
                status = "summary_ok" if success else "summary_errors"
            else:
                success = len(errors) == 0
                status = "no_summary_fallback"

            # If log unreadable but .ex5 was rebuilt, we know compile worked.
            if log_empty and ex5_rebuilt:
                success = True
                status = "ex5_rebuilt_log_unreadable"

            # When compile actually produced a fresh .ex5, nudge the EA to reinit
            # so the new version takes effect without manual detach/reattach.
            reload_trigger = None
            workspace_ex5_synced = None
            if ex5_rebuilt:
                reload_trigger = _touch_reload_trigger()
                # Persist the source sha256 so a future identical compile can be
                # short-circuited (skip-recompile branch above). Best-effort.
                if _src_sha:
                    try:
                        with open(_sidecar, "w", encoding="utf-8") as _sf:
                            _sf.write(_src_sha)
                    except Exception:
                        pass
                # 0.3.10: 把新 .ex5 同步回 workspace/strategies/<EA>.ex5。
                # 之前编译只产物到 MT5/Experts，workspace 那份 .ex5 永远是
                # 编译前的旧版本 → 客户端 strategies-view 比 sha256 永远报
                # 「⚠ 不一致」，用户「点此修复 → AI 改源码编译 → 看 UI
                # 还是不一致 → 怀疑没修好」反复打转（用户 case）。
                # 同名 .mq5 已经从 workspace/strategies 自动同步过去（src_mq5
                # → target_mq5），出口同步 .ex5 反向，对称一致。
                if workspace_dir and requested_ea:
                    ws_ex5 = os.path.join(workspace_dir, "strategies",
                                          os.path.splitext(ea_basename)[0] + ".ex5")
                    if os.path.abspath(ws_ex5) != os.path.abspath(ex5_path):
                        try:
                            import shutil as _sh
                            os.makedirs(os.path.dirname(ws_ex5), exist_ok=True)
                            _sh.copy2(ex5_path, ws_ex5)
                            workspace_ex5_synced = ws_ex5
                        except Exception as _e:
                            workspace_ex5_synced = f"sync_failed: {_e}"

            result = {
                "success": success,
                "status": status,
                "return_code": proc.returncode,
                "ex5_rebuilt": ex5_rebuilt,
                "ex5_mtime_before": datetime.fromtimestamp(ex5_mtime_before).strftime("%Y-%m-%d %H:%M:%S") if ex5_mtime_before else None,
                "ex5_mtime_after": datetime.fromtimestamp(ex5_mtime_after).strftime("%Y-%m-%d %H:%M:%S") if ex5_mtime_after else None,
                "summary_errors": summary_err,
                "summary_warnings": summary_warn,
                "errors": errors,
                "warnings": warnings,
                "log_read_error": log_read_error,
                "log": compile_log[-3000:] if len(compile_log) > 3000 else compile_log,
                "command": cmd_str,
                "metaeditor_stdout": (proc.stdout or "")[:1000],
                "metaeditor_stderr": (proc.stderr or "")[:1000],
                "ea_source_exists": os.path.isfile(filepath),
                "ea_source_path": filepath,
                "log_dir_used": log_dir,
                "preexisting_metaeditor_instances": preexisting_instances,
                "tasklist_error": tasklist_err,
                "reload_trigger": reload_trigger,
                "workspace_ex5_synced": workspace_ex5_synced,
            }
            if not success:
                hints = []
                if preexisting_instances > 0:
                    hints.append(
                        f"检测到 {preexisting_instances} 个 MetaEditor64.exe 已在运行——这是最常见的静默失败原因。"
                        "MT5 的 MetaEditor 是单实例应用，新的 CLI 调用会通过 IPC 转发给已存在的实例然后立即退出返回 0，"
                        "真正的编译要么被老实例排队处理要么被忽略。请关闭所有 MetaEditor 窗口后重试。"
                    )
                if any(re.search(r'error\s+106\s*:', e, re.IGNORECASE) for e in errors):
                    hints.append(
                        f"error 106 是 #include 的文件找不到。本次编译用的 MT5 数据目录: {data_path or '未确定'}"
                        "（log 里 'including ...' 那行就是 MetaEditor 实际去找的路径）。"
                        "路径在 AppData\\MetaQuotes\\Terminal\\<hash> 下而该 MT5 是便携安装 → 数据目录选错了，"
                        "检查 EASYDEAL_MT5_DATA_DIR / MT5 是否已连接；路径对 → 去那个 MQL5\\Include 下补齐缺的 .mqh。"
                    )
                elif preexisting_instances == 0 and not ex5_rebuilt and not errors:
                    hints.append(
                        "MetaEditor 没有前置实例但 .ex5 未重编译——可能是源文件未被 EA 使用(未挂载)、"
                        "或 MetaEditor 对该目录无写权限(UAC 重定向到 VirtualStore)。"
                    )
                if log_empty:
                    hints.append(
                        "日志文件未生成，MetaEditor 可能在 /compile 参数解析阶段就失败了——"
                        "请手动跑一次: MetaEditor64.exe /compile:\"<path>\" /log:\"<writable_path>\" 观察行为。"
                    )
                result["hint"] = " ".join(hints) if hints else (
                    "MetaEditor 的 return_code 经常是 0 即使编译失败，判断要看 summary_errors 或 ex5_rebuilt。"
                )
            logging.info(f"Strategy compilation: status={status}, success={success}")
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        # 0.3.53: 参数设置工具
        if name == "list_ea_inputs":
            return _list_ea_inputs_tool(arguments)
        if name == "detect_ea_hot_reload_support":
            return _detect_ea_hot_reload_support_tool(arguments)
        if name == "write_ea_parameters":
            return _write_ea_parameters_tool(arguments)

        if name == "diagnose_params_sources":
            filepath = _get_strategy_file_path()
            source_params = []
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    source_params = _parse_input_params(f.read())
            except Exception as exc:
                logging.warning(f"diagnose_params_sources: read source failed: {exc}")

            ea_name = _resolve_ea_filename()
            runtime_info = _get_runtime_json_info(ea_name)
            config_info = _get_config_set_info(ea_name)
            chr_candidates = _scan_chart_profiles_for_ea(ea_name)
            chr_report = [
                {
                    "path": c["path"],
                    "mtime": datetime.fromtimestamp(c["mtime"]).strftime("%Y-%m-%d %H:%M:%S"),
                    "param_count": len(c["params"]),
                    "params": c["params"],
                }
                for c in chr_candidates
            ]

            picked_chr = chr_report[0] if chr_report else None
            effective_source = (
                "runtime_json" if runtime_info and runtime_info.get("exists")
                else ("config_set" if config_info and config_info.get("exists")
                else "source_defaults")
            )
            result = {
                "ea_name": ea_name,
                "ea_source_file": filepath,
                "effective_source": effective_source,
                "runtime_json": runtime_info,
                "config_set": config_info,
                "source_defaults": {p["name"]: p["value"] for p in source_params},
                "chart_profile_reference": {
                    "note": "MT5 图表快照，EA 挂载时才回写，可能过时。仅供诊断，不参与 effective_value 计算。",
                    "files_found": len(chr_report),
                    "picked": picked_chr["path"] if picked_chr else None,
                    "all": chr_report,
                },
                "note": (
                    "优先级: runtime_json (EA 每次 OnInit/OnTimer 热更后写入, 最真实) > config_set (MCP 写入的热更新覆盖) > source_defaults。"
                    "update_strategy_param 写 config_set；compile_strategy 成功会自动写 reload.trigger 触发 EA 重新 init。"
                    "chart_profile (.chr) 已从优先级链移除，仅作为参考。"
                ),
            }
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "get_strategy_backups":
            version_file = arguments.get("version_file")
            if not version_file:
                # Return backup list
                manifest = _load_backup_manifest()
                result = {
                    "backup_dir": _get_backup_dir(),
                    "count": len(manifest),
                    "versions": list(reversed(manifest))  # newest first
                }
                return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

            # Read specific backup file content
            backup_dir = _get_backup_dir()
            backup_path = os.path.join(backup_dir, os.path.basename(version_file))
            if not os.path.isfile(backup_path):
                return [TextContent(type="text", text=json.dumps(
                    {"error": f"Backup file not found: {version_file}"}, ensure_ascii=False))]

            with open(backup_path, "r", encoding="utf-8") as f:
                lines = f.readlines()

            start = max(1, int(arguments.get("start_line", 1)))
            end = min(int(arguments.get("end_line", 50)), len(lines))
            numbered = [f"{i}: {lines[i-1].rstrip()}" for i in range(start, end + 1)]

            # Find change note from manifest
            manifest = _load_backup_manifest()
            change_note = ""
            for entry in manifest:
                if entry.get("file") == os.path.basename(version_file):
                    change_note = entry.get("change_note", "")
                    break

            result = {
                "file": version_file,
                "change_note": change_note,
                "total_lines": len(lines),
                "range": f"{start}-{end}",
                "content": "\n".join(numbered)
            }
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]


        if name == "easydeal_debug_env":
            return _debug_env_tool()

        # ---- Chart windows: list / open / close ----
        if name == "list_trade_charts":
            return _list_trade_charts_tool(arguments)
        if name == "open_trade_charts":
            return _open_trade_charts_tool(arguments)
        if name == "close_trade_charts":
            return _close_trade_charts_tool(arguments)

        if name == "attach_eas_to_charts":
            return _attach_eas_to_charts_tool(arguments)

        # 0.3.272: Node launchMt5 restore 后调 — 算法交易开关 + EA 对话框 auto-confirm
        if name == "post_launch_arm_ea":
            return _post_launch_arm_ea_tool(arguments)

        # 0.3.x: 手机「暂停交易 / 恢复交易」— 确定性切 MT5 全局算法交易开关(挂载那套的逆/正过程)
        if name == "set_auto_trading":
            return _set_auto_trading_tool(arguments)

        # ---- Realtime per-EA stats (0.3.49+) ----
        if name == "get_ea_realtime_stats":
            # 0.3.235: 多 MT5 — instance_id 切到对应 SDK 上下文
            instance_id = arguments.get("instance_id")
            try:
                with _Mt5InstanceContext(instance_id):
                    return _get_ea_realtime_stats_tool(arguments)
            except (ValueError, RuntimeError) as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e), "instance_id": instance_id}, ensure_ascii=False))]

        # ---- Trading-write tools (gated) ----
        # 0.3.99: close/modify 跟 open 拆成两个独立 gate ——
        # EASYDEAL_TRADING_WRITE 只控 close + modify；
        # EASYDEAL_TRADING_WRITE_OPEN 单独控 open_position（凭空建仓的风险敞口完全不可控）。
        # 0.3.235: 多 MT5 — instance_id 切换 SDK 上下文;
        # close/modify 若没传 instance_id 但有 ticket, 自动按 ticket 反查所在 instance.
        if name in ("close_position", "modify_position"):
            if not _is_trading_write_enabled():
                return [TextContent(type="text", text=json.dumps({
                    "ok": False,          # 让中继 _doTool 据实回 failed(原来缺 ok 会被误判成功)
                    "error": "trading_write_disabled",
                    "message": (
                        "未开启「允许 AI 直接平仓 / 改单」。请在桌面 EasyDeal「设置 → 高级」开启此权限再重试。"
                    ),
                }, ensure_ascii=False))]
            instance_id = arguments.get("instance_id")
            ticket = arguments.get("ticket")
            # 1.4.10: 优先按 account_login 确定性路由(手机端多账户平/改单传了它) —— 比
            # _resolve_instance_for_ticket 逐个 rebind 探 ticket 可靠得多(后者任一实例
            # 检测不到在跑 / rebind 抖动就返 None → 回退默认实例 → 找不到单 → 平仓失效)。
            # login → instance 是 cached_account_login 直接比对, 少一轮全实例探测。
            if not instance_id and arguments.get("account_login"):
                try:
                    instance_id = _resolve_instance_for_login(arguments.get("account_login"))
                    if instance_id:
                        logging.info(f"[trading-write] account_login={arguments.get('account_login')} 反查到 instance={instance_id}")
                except Exception:
                    instance_id = None
            # 兜底: 还没定位到就按 ticket 逐个实例探测(AI 会话没传 account_login 时)。
            if not instance_id and ticket:
                instance_id = _resolve_instance_for_ticket(int(ticket))
                if instance_id:
                    logging.info(f"[trading-write] ticket={ticket} 自动反查到 instance={instance_id}")
            # 0.4.x 跨会话操作日志: 平/改单 append 到 <workspace>/.easydeal-activity.jsonl。
            # 客户端 chat / 微信 / 定时任务是三个独立 AI 会话, 互相看不到对方做了啥 ——
            # 这个共享日志让任一会话都能回答「最近平仓了吗」。CLAUDE.md 引导 AI 会话
            # 开始 / 被问到时先读它。写日志失败绝不影响交易本身 (try/except 吞掉)。
            def _log_act(_res):
                try:
                    _ws = os.getenv("EASYDEAL_WORKSPACE_DIR")
                    if not _ws:
                        return
                    import datetime as _dt
                    _txt = _res[0].text if _res else ""
                    _d = json.loads(_txt) if _txt else {}
                    _entry = {
                        "ts": _dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                        "source": os.getenv("EASYDEAL_SESSION_SOURCE", "ai"),
                        "action": name,
                        "args": {k: arguments.get(k) for k in ("ticket", "symbol", "volume", "sl", "tp", "all") if k in arguments},
                        "ok": (_d.get("error") is None),
                        "summary": str(_d.get("message") or _d.get("result") or _d.get("error") or "")[:200],
                        "instance_id": instance_id or "",
                    }
                    with open(os.path.join(_ws, ".easydeal-activity.jsonl"), "a", encoding="utf-8") as _f:
                        _f.write(json.dumps(_entry, ensure_ascii=False) + "\n")
                except Exception:
                    pass
            try:
                with _Mt5InstanceContext(instance_id):
                    if name == "close_position":
                        _res = _trading_close_position(strategy, arguments)
                        _log_act(_res)
                        return _res
                    if name == "modify_position":
                        _res = _trading_modify_position(strategy, arguments)
                        _log_act(_res)
                        return _res
            except (ValueError, RuntimeError) as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e), "instance_id": instance_id}, ensure_ascii=False))]
        if name == "open_position":
            if not _is_trading_write_open_enabled():
                return [TextContent(type="text", text=json.dumps({
                    "error": "trading_write_open_disabled",
                    "message": (
                        "用户没在客户端「设置 → 高级」里开启「允许 AI 直接开仓」（这跟平/改是两个独立开关）。"
                        "请先告知用户去开启此权限再重试 —— 开仓的风险敞口比平仓大得多，需要单独确认。"
                    ),
                }, ensure_ascii=False))]
            instance_id = arguments.get("instance_id")
            # 绑定多账户手机端开仓: 没传 instance_id 但带 account_login → 反查到该账户的实例, 路由过去开。
            if not instance_id and arguments.get("account_login"):
                try:
                    instance_id = _resolve_instance_for_login(arguments.get("account_login"))
                    if instance_id:
                        logging.info(f"[trading-open] account_login={arguments.get('account_login')} 反查到 instance={instance_id}")
                except Exception:
                    instance_id = None
            try:
                with _Mt5InstanceContext(instance_id):
                    return _trading_open_position(strategy, arguments)
            except (ValueError, RuntimeError) as e:
                return [TextContent(type="text", text=json.dumps({"error": str(e), "instance_id": instance_id}, ensure_ascii=False))]

        return [TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}, ensure_ascii=False))]

    except Exception as exc:
        # logging.exception 会自动捎带完整 traceback；之前用的 logging.error
        # 只 stringify exc，结果 logs/easydeal.log 里只见错误消息看不到哪行炸
        # —— 用户上传诊断 mcp_log.recent_errors 抠到错误也没法定位。
        logging.exception(f"Tool error {name}: {exc}")
        return [TextContent(type="text", text=json.dumps({"error": str(exc)}, ensure_ascii=False))]


# ============== MCP resources ==============

@server.list_resources()
async def list_resources() -> list[Resource]:
    """List available resources."""
    return [
        Resource(
            uri="trading://status",
            name="Trading Status",
            description="Current account, positions, and market snapshot.",
            mimeType="application/json"
        ),
        Resource(
            uri="trading://config",
            name="Monitor Config",
            description="Current monitor configuration and parameters.",
            mimeType="application/json"
        ),
        Resource(
            uri="trading://strategy-doc",
            name="Strategy Description",
            description="LLM-inferred strategy description from observations.",
            mimeType="text/markdown"
        )
    ]


@server.read_resource()
async def read_resource(uri: str) -> str:
    """Read resource content."""
    if uri == "trading://status":
        strategy = get_strategy()
        return json.dumps(strategy.get_status(), ensure_ascii=False, indent=2)
    if uri == "trading://config":
        strategy = get_strategy()
        return json.dumps(strategy.get_config_info(), ensure_ascii=False, indent=2)
    if uri == "trading://strategy-doc":
        strategy = get_strategy()
        ok, doc = _get_or_generate_strategy_doc(strategy)
        return doc
    return json.dumps({"error": f"Unknown resource: {uri}"}, ensure_ascii=False)


# ============== MCP prompts ==============

@server.list_prompts()
async def list_prompts() -> list[Prompt]:
    """List available prompts."""
    return [
        Prompt(
            name="analyze_trading_situation",
            description="Analyze current trading situation and suggest next steps.",
            arguments=[]
        ),
        Prompt(
            name="risk_assessment",
            description="Assess risk based on exposure and P/L.",
            arguments=[]
        )
    ]


@server.get_prompt()
async def get_prompt(name: str, arguments: dict[str, str] | None) -> GetPromptResult:
    """Get a prompt template."""
    strategy = get_strategy()
    status = strategy.get_status()
    config = strategy.get_config_info()

    summary = status.get("orders", {}).get("summary", {})
    total_profit = status.get("orders", {}).get("total_profit", 0)
    market = status.get("market_data", {})
    state = status.get("strategy_state", {})

    if name == "analyze_trading_situation":
        # Enrich with runtime params and recent EA logs
        param_diff = _get_param_diff()
        param_diff_text = ""
        if param_diff:
            param_diff_text = "\nParameter deviations (source vs runtime):\n" + json.dumps(param_diff, ensure_ascii=False, indent=2)

        ea_logs_text = ""
        data_path = _get_mt5_data_path()
        if data_path:
            ea_log_dir = os.path.join(data_path, "MQL5", "Logs")
            today = _bj_date_str()
            ea_result = _read_mt5_log(ea_log_dir, today, page_size=20, page=1)
            if "lines" in ea_result and ea_result["lines"]:
                ea_logs_text = "\nRecent EA logs:\n" + "\n".join(ea_result["lines"])

        text = f"""Analyze the current trading situation and provide suggestions.
Market: {market.get('symbol')} bid={market.get('bid')} ask={market.get('ask')}
Positions: total={summary.get('positions_total')} buy={summary.get('buy_count')} sell={summary.get('sell_count')} net_volume={summary.get('net_volume')}
P/L: {total_profit}
State: running={state.get('running')} open_position={state.get('is_open_position')}
Config: max_loss={config.get('parameters', {}).get('max_loss')} magic_numbers={config.get('parameters', {}).get('magic_numbers')}
Set parameters: {json.dumps(config.get('set_parameters', {}), ensure_ascii=False)}
{param_diff_text}
{ea_logs_text}
"""
        return GetPromptResult(
            description="Analyze current trading situation",
            messages=[PromptMessage(role="user", content=TextContent(type="text", text=text))]
        )

    if name == "risk_assessment":
        text = f"""Assess risk given the current exposure and P/L.
Balance={status.get('account', {}).get('balance')} Equity={status.get('account', {}).get('equity')} MarginLevel={status.get('account', {}).get('margin_level')}
TotalProfit={total_profit} MaxLoss={config.get('parameters', {}).get('max_loss')}
PositionsTotal={summary.get('positions_total')}
"""
        return GetPromptResult(
            description="Assess current risk",
            messages=[PromptMessage(role="user", content=TextContent(type="text", text=text))]
        )

    return GetPromptResult(
        description="Unknown prompt",
        messages=[PromptMessage(role="user", content=TextContent(type="text", text=f"Unknown prompt: {name}"))]
    )


# ============== Service startup ==============

def start_all_services():
    """Start MT5 monitor services."""
    global strategy_instance, monitor_instance

    logging.info("MCP connected; starting services...")

    strategy_instance = TradingContext()
    if not strategy_instance.running:
        logging.error("Trading context initialization failed")
        mt5.shutdown()
        return False

    logging.info("Trading context created")

    monitor_instance = TradingMonitor(strategy_instance)
    monitor_instance.add_callback(FileCallback())
    monitor_instance.add_callback(AgentCallback(
        url=os.getenv("FAY_NOTIFY_URL", "http://127.0.0.1:5000/transparent-pass"),
        api_key=os.getenv("FAY_API_KEY", "YOUR_API_KEY"),
        model=os.getenv("FAY_MODEL", "fay-streaming"),
        role=os.getenv("FAY_ROLE", "monitor"),
        cooldown=1800,
        user=os.getenv("FAY_NOTIFY_USER", "User")
    ))
    logging.info("Monitor created")

    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()
    logging.info("Flask API started (port 8888)")

    monitor_thread = threading.Thread(target=monitor_instance.run, daemon=True)
    monitor_thread.start()
    logging.info("Monitor thread started")
    logging.info("Strategy execution runs inside the EA; no strategy thread started.")

    persist_thread = threading.Thread(target=_strategy_consistency_review_loop, daemon=True)
    persist_thread.start()
    logging.info("Strategy consistency review scheduler started (00:15 daily, no auto doc update)")

    return True


services_started = False

@server.list_tools()
async def list_tools() -> list[Tool]:
    """List tools; start services on first call.

    0.3.236: EASYDEAL_PROBE_ONLY=1 时跳过 start_all_services — Skills tab 每 5s
    spawn ephemeral probe 调 list_tools, 如果触发 start_all_services → TradingContext
    → mt5.initialize() 不带 path → SDK 会自动 launch 默认 MT5. 用户撞到「关了
    MT5 后点 Skills 又被启起来 + 双进程」根因. probe 只想拿 tool schema, 不需要
    MT5 init.
    """
    global services_started
    probe_only = os.getenv("EASYDEAL_PROBE_ONLY") == "1"
    if not services_started and not probe_only:
        services_started = True
        if start_all_services():
            logging.info("Services started")
        else:
            logging.error("Service startup failed")
    elif probe_only:
        logging.info("[probe-only] 跳过 start_all_services — 只列 tool schema, 不 init MT5")
    tools = get_all_tools()
    if not _backtest_engine_available():
        tools = [t for t in tools if t.name not in _BACKTEST_ONLY_TOOLS]
    return tools


# Backtest tools need the wind-tunnel engine, which the community edition does
# not ship. panic_stop_all stays: it also clears the panic flag and scheduler.
_BACKTEST_ONLY_TOOLS = {"run_backtest", "get_backtest_status", "list_backtests", "cancel_backtest"}


def _backtest_engine_available() -> bool:
    try:
        import wind_backtests  # noqa: F401
        return True
    except ImportError:
        return False


def _stage_easydeal_includes(install_dir: str) -> dict:
    """Deploy bundled headers used by live EA compilation."""
    out = {"ok": True, "staged": [], "skipped": [], "errors": [], "target_dir": None}
    src_dir = os.getenv("EASYDEAL_MQL5_BUNDLED_DIR") or ""
    if not src_dir or not os.path.isdir(src_dir) or not install_dir:
        return out
    target_dir = os.path.join(install_dir, "MQL5", "Include")
    out["target_dir"] = target_dir
    try:
        os.makedirs(target_dir, exist_ok=True)
    except Exception as exc:
        out["ok"] = False
        out["errors"].append(f"mkdir {target_dir} failed: {exc}")
        logging.warning("[includes] mkdir failed: %s", exc)
        return out

    import shutil as _sh
    for fname in ("OrderGuard.mqh", "EasyDealCopyTrade.mqh"):
        src_path = os.path.join(src_dir, fname)
        if not os.path.isfile(src_path):
            out["skipped"].append(fname)        # bundled 里没有就别拷
            continue
        dst_path = os.path.join(target_dir, fname)
        try:
            # 同名优先 src 覆盖（确保版本一致，避免 live MT5 上有旧版残留）
            _sh.copy2(src_path, dst_path)
            out["staged"].append(fname)
        except Exception as exc:
            out["errors"].append(f"copy {fname}: {exc}")
            logging.warning("[includes] copy %s → %s failed: %s",
                            src_path, dst_path, exc)
    if out["staged"]:
        logging.info("[includes] staged %s to %s",
                     ", ".join(out["staged"]), target_dir)
    if out["errors"]:
        out["ok"] = False
    return out


def _resolve_mt5_install_dir() -> str | None:
    env = os.getenv("EASYDEAL_MT5_INSTALL_DIR")
    if env and os.path.isdir(env):
        return env
    try:
        info = mt5.terminal_info()
        if info and info.path and os.path.isdir(info.path):
            return info.path
    except Exception:
        pass
    return None


def _resolve_mt5_data_dir() -> str | None:
    env = os.getenv("EASYDEAL_MT5_DATA_DIR")
    if env and os.path.isdir(env):
        return env
    try:
        info = mt5.terminal_info()
        if info and info.data_path and os.path.isdir(info.data_path):
            return info.data_path
    except Exception:
        pass
    return None


def _ensure_easydeal_auth_mqh_deployed() -> dict:
    """把 python/EasyDealAuth.mqh 复制到 <MT5 data>/MQL5/Include/EasyDealAuth.mqh
    幂等 + sha 比较跳过重复。
    用途：编译任何带 `#include <EasyDealAuth.mqh>` 的 EA 时，MetaEditor 能解析。
    返回 {ok, dst, reason}。失败也不抛 — caller 视情况决定是否 fail。"""
    import hashlib, shutil as _sh
    data_dir = _resolve_mt5_data_dir()
    if not data_dir:
        return {"ok": False, "reason": "MT5 data dir 未确定"}
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "EasyDealAuth.mqh")
    if not os.path.isfile(src):
        return {"ok": False, "reason": f"SDK 源文件丢失: {src}"}
    include_dir = os.path.join(data_dir, "MQL5", "Include")
    os.makedirs(include_dir, exist_ok=True)
    dst = os.path.join(include_dir, "EasyDealAuth.mqh")
    try:
        if os.path.isfile(dst):
            def _sha(p):
                h = hashlib.sha256()
                with open(p, "rb") as f:
                    h.update(f.read())
                return h.hexdigest()
            if _sha(src) == _sha(dst):
                return {"ok": True, "dst": dst, "reason": "already-up-to-date"}
        _sh.copy2(src, dst)
        return {"ok": True, "dst": dst, "reason": "copied"}
    except Exception as e:
        return {"ok": False, "dst": dst, "reason": f"copy 失败: {e}"}


def _pick_chartable_symbol(prefer: list[str] | None = None) -> tuple[str | None, list[dict]]:
    """从给定列表（默认 settings.monitor.symbols + strategy.symbols 合并）
    里挑一个 broker 当前真有的 symbol。返回 (picked, candidates)；
    picked=None 表示一个都没匹配上。candidates 每条是 {symbol, exists, in_market_watch}。

    0.3.226: prefer 给了但 broker 上没 exact match → 自动**模糊匹配** broker 全
    symbol 列表里含 prefer stem 的 (如 'BTCUSD' → 'BTCUSDm' / 'BTCUSD.b' 等
    broker 加后缀的变体). 解决 Exness / ICMarkets / FXTM 等不同 broker symbol
    命名差异 — EA 配 'BTCUSD' 在所有这些 broker 都能 work, 不需为每个 broker
    单独配 monitor_config.symbols.
    """
    sources = []
    if prefer:
        sources = list(prefer)
    else:
        s = strategy_instance
        if s and s.symbols:
            sources.extend(s.symbols)
        if _settings_path and os.path.isfile(_settings_path):
            try:
                with open(_settings_path, "r", encoding="utf-8") as f:
                    sdata = json.load(f) or {}
                conf_syms = ((sdata.get("monitor") or {}).get("symbols")) or []
                for sym in conf_syms:
                    if isinstance(sym, str) and sym.strip() and sym not in sources:
                        sources.append(sym.strip())
            except Exception:
                pass
    candidates = []
    picked = None
    for sym in sources:
        info = None
        try:
            info = mt5.symbol_info(sym)
        except Exception:
            info = None
        in_mw = bool(info and getattr(info, "visible", False))
        exists = info is not None
        candidates.append({"symbol": sym, "exists": exists, "in_market_watch": in_mw})
        if exists and picked is None:
            picked = sym

    # 0.3.226: exact match 没命中 → 对每个 prefer stem 跑模糊匹配 (broker 全
    # symbol 列表里找含该 stem 的). 找到第一个 visible (在 Market Watch) 的优先,
    # 没 visible 就用第一个 exists 的.
    if picked is None and sources:
        try:
            all_syms = mt5.symbols_get() or []
            for stem in sources:
                if not stem: continue
                stem_upper = stem.upper()
                fuzzy_hits = []
                for si in all_syms:
                    name = getattr(si, "name", "") or ""
                    if not name: continue
                    if stem_upper in name.upper():
                        fuzzy_hits.append((name, bool(getattr(si, "visible", False))))
                if not fuzzy_hits: continue
                # 优先 visible (Market Watch) 的, 短名优先 (BTCUSDm 短过 BTCUSDm.pro)
                fuzzy_hits.sort(key=lambda x: (not x[1], len(x[0])))
                fuzzy_pick = fuzzy_hits[0][0]
                candidates.append({"symbol": fuzzy_pick, "exists": True,
                                    "in_market_watch": fuzzy_hits[0][1],
                                    "matched_via": f"fuzzy:{stem}"})
                picked = fuzzy_pick
                break
        except Exception:
            pass

    return picked, candidates


def _list_mt5_pids(install_dir: str | None = None) -> list[int]:
    """列出 terminal64.exe / terminal.exe 进程的 PID。
    0.3.84: 全部 PID + path 一次拉，Python 端做规范化 prefix 比较 —— 之前在 PowerShell
    里 StartsWith 时偶发为 0（已知作者 5/17 case：path 完全匹配 install_dir 仍被
    PowerShell 过滤掉）。Python 用 os.path.normcase + os.path.normpath，跨大小写 / 反斜杠 /
    多余空格的差异都能容忍。
    install_dir=None 时返回全部 PID（不过滤）。
    PowerShell 完全不可用时按 tasklist 兜底（只能拿 PID，拿不到 path）。"""
    import subprocess as _sp
    ps = (
        "$ErrorActionPreference='SilentlyContinue';"
        "Get-CimInstance Win32_Process -Filter "
        "\"Name='terminal64.exe' OR Name='terminal.exe'\" | "
        "Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
    )
    pid_paths: list[tuple[int, str | None]] = []
    try:
        out = _sp.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=6,
        )
        raw = (out.stdout or "").strip()
        if raw:
            data = json.loads(raw)
            if isinstance(data, dict):
                data = [data]
            for d in data:
                pid = int(d.get("ProcessId") or 0)
                if pid:
                    pid_paths.append((pid, d.get("ExecutablePath") or None))
    except Exception:
        pid_paths = []

    # install_dir 给定 → Python prefix 比较（normcase + normpath 处理大小写 / 路径分隔符）
    if install_dir:
        norm_target = os.path.normcase(os.path.normpath(install_dir.rstrip("\\/")))
        filtered: list[int] = []
        for pid, path in pid_paths:
            if not path:
                continue       # admin 进程读不到 path —— 跳过，broad 扫会触发兜底逻辑
            norm_path = os.path.normcase(os.path.normpath(path))
            if norm_path == norm_target or norm_path.startswith(norm_target + os.sep):
                filtered.append(pid)
        return filtered

    # 无 install_dir → 返回全部
    if pid_paths:
        return [pid for pid, _ in pid_paths]

    # PowerShell 拿不到 → tasklist 兜底
    pids: list[int] = []
    for exe in ("terminal64.exe", "terminal.exe"):
        try:
            out = _sp.run(
                ["tasklist", "/FI", f"IMAGENAME eq {exe}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=4,
            )
            for line in (out.stdout or "").splitlines():
                parts = [p.strip('"') for p in line.split('","')]
                if len(parts) >= 2 and parts[1].isdigit():
                    pids.append(int(parts[1]))
        except Exception:
            pass
    return pids


def _auto_confirm_ea_dialog(ea_name: str, timeout_sec: float = 10.0) -> dict:
    """0.3.269: 自动勾「允许算法交易」+ 按「确定」消掉 EA 加载对话框.

    MT5 第一次加载 EA 到图表时会弹个对话框 (title 形如 `SimpleBTC 2.00 (BTCUSDm,H1)`),
    内含「允许算法交易」checkbox + 确定/取消/重置按钮. 用户不勾的话 EA 加载了
    但不能交易. 自动勾 + 确定让用户不用手动操作.

    实现走 PowerShell + Win32:
      1. Poll 找窗口 title 以 ea_name 开头的对话框 (10s timeout)
      2. EnumChildWindows 找 className="Button" + text 含「允许」/「Enable」 → SendMessage BM_CLICK
      3. 找 className="Button" + text="确定"/"OK" → SendMessage BM_CLICK
      4. fallback: keybd_event SendInput (Tab Space Tab Enter)

    返回: {ok, status, via?, error?}
      status ∈ 'confirmed' / 'no_dialog' (没弹窗,可能 EA 已 trusted) /
              'no_checkbox' / 'click_failed' / 'timeout'
    """
    import subprocess as _sp
    import time as _time
    ps_script = r'''
$ErrorActionPreference = 'Continue'
$eaName = ''' + repr(ea_name) + r'''
$timeoutSec = ''' + str(int(timeout_sec)) + r'''

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumWindowsProc proc, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder buf, int max);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int idx);
  public const int GWL_STYLE = -16;
  public const long BS_CHECKBOX = 0x0002;
  public const long BS_AUTOCHECKBOX = 0x0003;
  public const long BS_3STATE = 0x0005;
  public const uint BM_CLICK = 0x00F5;
  public const uint BM_GETCHECK = 0x00F0;
  public const uint BM_SETCHECK = 0x00F1;
  public const uint WM_COMMAND = 0x0111;

  public static IntPtr FindDialog(string namePrefix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      string title = sb.ToString();
      // 0.3.272: 放宽 title 匹配. 之前要求 title.Contains("(") 假设 MT5 用
      // "SimpleBTC 2.00 (BTCUSDm,H1)" 格式, 但用户实测 0.3.272 截屏看到 EA
      // 属性对话框 title 是「SimpleBTC 2.00」无括号 → 漏匹配. 现改 prefix 匹配
      // + 长度 > prefix (避免匹配到只有 EA 名的别的小窗口).
      // 0.3.279: 加 Contains 兼容 — 用户实测 0.3.278 25s 仍 no_dialog, 怀疑
      // 标题不是严格 EA-name-prefix. 改成 title 含 ea_name 即可 (放宽不严).
      if (title.IndexOf(namePrefix, StringComparison.OrdinalIgnoreCase) >= 0 && title.Length > namePrefix.Length) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // 0.3.279: dump 所有可见 top-level 窗口 title 给上层诊断 — 用户报 no_dialog
  // 但截图 dialog 明明开着, 说明我 FindDialog 看不到它. dump 全部窗口能立刻
  // 看出 EnumWindows 视角到底有没有这个 dialog (有 → title 匹配逻辑错;
  // 没 → 进程隔离 / virtual desktop / 其它系统原因).
  public static List<string> ListAllVisibleWindows() {
    List<string> titles = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      string title = sb.ToString();
      if (title.Length > 0) titles.Add(title);
      return true;
    }, IntPtr.Zero);
    return titles;
  }

  public static List<IntPtr> FindButtonsInDialog(IntPtr dlg) {
    List<IntPtr> btns = new List<IntPtr>();
    EnumChildWindows(dlg, (h, l) => {
      StringBuilder cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      if (cls.ToString().Equals("Button", StringComparison.OrdinalIgnoreCase)) {
        btns.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return btns;
  }

  public static string BtnText(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }

  public static int BtnCheck(IntPtr h) {
    return (int)SendMessage(h, BM_GETCHECK, IntPtr.Zero, IntPtr.Zero);
  }

  public static void ClickBtn(IntPtr h) {
    SendMessage(h, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
  }

  // 0.3.273: BM_SETCHECK 直接强设状态 + 给 parent dialog 发 BN_CLICKED
  // notification (MT5 dialog 可能只在收到 WM_COMMAND(BN_CLICKED) 时才认 checkbox
  // 状态变化). BM_CLICK 偶发 silent — 用 SETCHECK+notify 兜底.
  public static void ForceCheckBtn(IntPtr h, IntPtr parent, int ctrlId) {
    SendMessage(h, BM_SETCHECK, (IntPtr)1, IntPtr.Zero);
    // notify parent dialog 这个 checkbox 被点了
    // BN_CLICKED = 0, wParam = MAKEWPARAM(ctrlId, BN_CLICKED), lParam = hwndCtl
    if (parent != IntPtr.Zero) {
      IntPtr wp = (IntPtr)((ctrlId & 0xFFFF) | (0 << 16));
      SendMessage(parent, WM_COMMAND, wp, h);
    }
  }

  // 0.3.273: 获取控件 ID (用于 WM_COMMAND notify)
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwndCtl);
  public static int CtrlId(IntPtr h) { return GetDlgCtrlID(h); }

  // 0.3.273: 判断 button 是不是 checkbox 类型
  public static bool IsCheckbox(IntPtr h) {
    long style = (long)GetWindowLong(h, GWL_STYLE) & 0x0F;
    return style == BS_CHECKBOX || style == BS_AUTOCHECKBOX || style == BS_3STATE;
  }
}
"@

# Poll 找对话框
$deadline = (Get-Date).AddSeconds($timeoutSec)
$dlg = [IntPtr]::Zero
$pollCount = 0
while ((Get-Date) -lt $deadline) {
  $dlg = [W]::FindDialog($eaName)
  if ($dlg -ne [IntPtr]::Zero) { break }
  $pollCount += 1
  Start-Sleep -Milliseconds 300
}
if ($dlg -eq [IntPtr]::Zero) {
  # 0.3.279: 没找到 dialog → dump 所有可见 top-level 窗口 title 帮诊断.
  # 用户实测 0.3.278 25s 仍 no_dialog 但截图 dialog 明明开着, dump 看到底
  # PS 视角能不能看见这个窗口.
  Write-Output ("poll_iterations:" + $pollCount)
  $allWins = [W]::ListAllVisibleWindows()
  Write-Output ("visible_window_count:" + $allWins.Count)
  foreach ($t in $allWins) {
    # 只 dump 跟 MT5 相关或可能是 EA dialog 的窗口, 不要 dump 整个桌面 50+ 个
    if ($t.Length -le 80 -and ($t -match 'MetaTrader|MT5|SimpleBTC|EA|Expert|专家|算法|允许' -or $t.IndexOf($eaName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
      Write-Output ("vis_win:" + $t)
    }
  }
  Write-Output "no_dialog"
  exit 0
}

# 0.3.273: log 找到的 dialog title 给上层诊断
$dlgTitle = New-Object System.Text.StringBuilder 256
[W]::GetWindowText($dlg, $dlgTitle, 256) | Out-Null
Write-Output ("dlg_title:" + $dlgTitle.ToString())

# 0.3.326: 跳过 tab 切换 — 实测 TCM_SETCURSEL + Ctrl+Shift+Tab keyboard 都被
# MT5 dialog UIPI 拒. 但 BM_SETCHECK 直接操作 hidden checkbox control 可以
# work (control 即使不在可见 tab 上, EnumChildWindows 也能找到, BM_SETCHECK
# 直接改它的 check state, MT5 dialog 不知道我们没切 tab).
# 用户在 dialog 上手动切「普通」tab 就能看到 checkbox 已经 ☑ 勾上, 直接点确定 commit.

# 枚举所有 Button 控件 + dump 所有按钮文本给上层诊断 (找错 button 时能立刻看出来)
$btns = [W]::FindButtonsInDialog($dlg)
if ($btns.Count -eq 0) { Write-Output "no_buttons"; exit 1 }

Write-Output ("btn_count:" + $btns.Count)
foreach ($b in $btns) {
  $t = [W]::BtnText($b)
  $isCb = [W]::IsCheckbox($b)
  $id = [W]::CtrlId($b)
  $chk = [W]::BtnCheck($b)
  Write-Output ("btn:id=" + $id + " cb=" + $isCb + " chk=" + $chk + " text=" + $t)
}

# 找「允许算法交易」/「Allow Algo Trading」/ 类似 checkbox
# 0.3.273: 优先选 IsCheckbox=true 的, 因为 OK / 取消 / 重置都是 button 不是 checkbox.
# 之前老代码靠 text 匹配选, 如果 text 包含「允许」的 OK 按钮 (不太可能但保险) 会撞.
$allowBtn = $null
$allowCtrlId = 0
$okBtn = $null
foreach ($b in $btns) {
  $t = [W]::BtnText($b)
  $isCb = [W]::IsCheckbox($b)
  # 0.3.323: 精确匹配「允许算法交易」/「允许实时自动交易」/「Allow Algo Trading」/
  # 「Allow live trading」. 撤回老正则 `text -match '允许'` 太宽 — 实测会撞
  # 「允许更改信号设置」(Allow modification of signal settings) 那个 checkbox,
  # 那个不是真正的 algo trading 开关. id 不固定 (10318 是 SimpleBTC,
  # 别的 EA 可能不同), 还是用 text 精确匹配靠谱.
  if ($allowBtn -eq $null -and $isCb -and (
        $t -match '允许算法交易' -or $t -match '允许实时自动交易' -or
        $t -match '(?i)allow\s+algo' -or $t -match '(?i)allow\s+live'
      )) {
    $allowBtn = $b
    $allowCtrlId = [W]::CtrlId($b)
    Write-Output ("matched_allow:id=" + $allowCtrlId + " text=" + $t)
  }
  # OK button: 「确定」/「OK」 — 不限 IsCheckbox (push button 也是 class "Button" 但不是 checkbox style)
  if ($okBtn -eq $null -and ($t -match '确定' -or $t -match '^(OK|Ok|确认)$')) {
    $okBtn = $b
    Write-Output ("matched_ok:text=" + $t)
  }
}

if ($allowBtn -eq $null) {
  Write-Output "no_allow_checkbox"
  exit 1
}

# 0.3.273: 三段勾选 — BM_SETCHECK + WM_COMMAND notify (有些 dialog 只认这个),
# 然后 BM_CLICK (有些 dialog 只认这个), 然后 keybd_event Space (UIPI fallback).
# 每步后回查 BM_GETCHECK, 一步成了就停.
$preCheck = [W]::BtnCheck($allowBtn)
Write-Output ("pre_check:" + $preCheck)

# 先把 dialog 提到前台 + 给 checkbox 设焦点 (后面 Space 键 fallback 用)
[W]::SetForegroundWindow($dlg) | Out-Null
Start-Sleep -Milliseconds 100

# 第 1 招: BM_SETCHECK + WM_COMMAND notify parent
[W]::ForceCheckBtn($allowBtn, $dlg, $allowCtrlId)
Start-Sleep -Milliseconds 150
$afterStep1 = [W]::BtnCheck($allowBtn)
Write-Output ("after_setcheck:" + $afterStep1)

if ($afterStep1 -eq 0) {
  # 第 2 招: BM_CLICK
  [W]::ClickBtn($allowBtn)
  Start-Sleep -Milliseconds 200
  $afterStep2 = [W]::BtnCheck($allowBtn)
  Write-Output ("after_click:" + $afterStep2)
}

if ([W]::BtnCheck($allowBtn) -eq 0) {
  # 第 3 招: 给 checkbox SetFocus + keybd_event Space
  [W]::SetFocus($allowBtn) | Out-Null
  Start-Sleep -Milliseconds 100
  Add-Type -TypeDefinition '
using System.Runtime.InteropServices;
public class K2 {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
  public const byte VK_SPACE = 0x20;
}'
  [K2]::keybd_event([K2]::VK_SPACE, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [K2]::keybd_event([K2]::VK_SPACE, 0, 2, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 200
  $afterStep3 = [W]::BtnCheck($allowBtn)
  Write-Output ("after_space:" + $afterStep3)
}

$finalCheck = [W]::BtnCheck($allowBtn)
Write-Output ("final_check:" + $finalCheck)

if ($finalCheck -eq 0) {
  Write-Output "checkbox_click_failed"
  exit 1
}

# 0.3.326: BM_SETCHECK 已经勾上 checkbox (即使 dialog active tab 是「输入」),
# 不再尝试点 OK (BM_CLICK 被 UIPI 拒, mouse_event 触发 MT5 关). dialog 留给用户:
# 用户切到「普通」tab → 看到 checkbox 已 ☑ → 点「确定」commit. dialog 保持
# 在 active tab「输入」也行 (用户可以直接点底部「确定」按钮 commit, 不必先切 tab).
Write-Output "confirmed:checkbox_set_user_clicks_ok"
'''
    logging.info(f"[ea_dialog] 开始 poll EA 对话框 (ea={ea_name}, timeout={timeout_sec}s)")
    try:
        # 0.3.323: 改用 tmp .ps1 + -File 替代 -EncodedCommand. 老 base64 EncodedCommand
        # 在 0.3.319 加了 3 个 Add-Type 类 (TabSwitch/KTab/MClick) 后超 Windows
        # 32k 命令行上限, PowerShell spawn fail with WinError 206. 改 file path
        # 命令行只有路径, script 内容在文件里, 无大小限制.
        import tempfile as _tempfile
        _tmp = _tempfile.NamedTemporaryFile(mode='w', suffix='.ps1', delete=False,
                                              encoding='utf-8-sig')
        _tmp.write(ps_script)
        _tmp.close()
        _ps1_path = _tmp.name
        try:
            proc = _sp.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-File", _ps1_path],
                capture_output=True, text=True, timeout=timeout_sec + 5,
                creationflags=getattr(_sp, "CREATE_NO_WINDOW", 0),
            )
        finally:
            try: os.unlink(_ps1_path)
            except Exception: pass
        out = (proc.stdout or "").strip()
        err_text = (proc.stderr or "").strip()[:300]
        # 0.3.273: 把 PS 全部 stdout (含 dlg_title / btn dump / 每步勾选回查)
        # 全 log 出来, 让用户报「checkbox 没勾上」时能完整回放
        full_out = out
        for _line in full_out.splitlines():
            logging.info(f"[ea_dialog] {_line}")
        last = (out.splitlines() or [""])[-1]
        if last.startswith("confirmed"):
            via = last.split(":", 1)[1] if ":" in last else "unknown"
            # 从 verbose output 拿最后一次 final_check 状态
            final_check = None
            for _line in full_out.splitlines():
                if _line.startswith("final_check:"):
                    try: final_check = int(_line.split(":", 1)[1])
                    except: pass
            return {"ok": True, "status": "confirmed", "via": via,
                    "final_check": final_check,
                    "raw_lines": full_out.splitlines()[-12:]}  # 留诊断 trail
        elif last == "no_dialog":
            # 没弹窗 — 可能 EA 已 trusted (不弹) 或 MT5 还没挂上 EA, 视为 OK
            return {"ok": True, "status": "no_dialog",
                    "hint": "未检测到 EA 加载对话框 (可能 EA 已被信任 / MT5 挂载延迟)"}
        else:
            return {"ok": False, "status": last or "unknown",
                    "ps_stderr": err_text,
                    "raw_lines": full_out.splitlines()[-12:]}
    except _sp.TimeoutExpired:
        logging.warning(f"[ea_dialog] PowerShell 超时 ({timeout_sec + 5}s)")
        return {"ok": False, "status": "timeout",
                "error": f"PowerShell 超时 ({timeout_sec + 5}s)"}
    except Exception as e:
        logging.warning(f"[ea_dialog] PowerShell 异常: {type(e).__name__}: {e}")
        return {"ok": False, "status": "exception",
                "error": f"{type(e).__name__}: {e}"}


def _set_algotrading(terminal_exe: str, install_dir: str, want_on: bool = True, use_rebind: bool = False) -> dict:
    """0.3.254 / 0.3.x: 确保 MT5 全局「算法交易」开关到达目标态 want_on. 查
    terminal_info().trade_allowed, 与目标不一致 → bring MT5 to front + 注入 Ctrl+E
    (该开关是切换键) + 回查验证. want_on=True 挂载时确保开; want_on=False 手机「暂停交易」确保关.

    注入用 PowerShell + Win32 keybd_event, 5 重 UIPI fallback 思路跟 Electron 的
    _bringWindowToFront 同款: SetForegroundWindow → ALT trick → MinimizeRestore →
    SwitchToThisWindow → WScript.Shell AppActivate. 哪条 OK 后立刻 keybd_event 模拟
    Ctrl+E 切「算法交易」全局开关 (MT5 工具栏那个红/绿按钮).

    0.3.271: 加 logging.info 让每步可见 (之前 0 日志, 用户报障无法回放),
    + 失败时再 retry 一次 (Win11 偶发首次 SetForegroundWindow 不生效).

    返回:
      {ok, status, via?, before_trade_allowed, after_trade_allowed?, error?, attempts?}
      status ∈ 'already_on' / 'switched_on' / 'switch_failed' / 'no_pid' / 'sdk_query_failed'
    """
    import subprocess as _sp
    import time as _time

    logging.info(f"[algotrading] 开始检查 trade_allowed (terminal={terminal_exe}, use_rebind={use_rebind})")

    # query 当前状态. use_rebind=True(多实例暂停): 用 _rebind_mt5(install_dir) 可靠切到
    # 该实例的 SDK 上下文(裸 _mt5_init(path) 在多实例下不一定听 path → 读错实例状态).
    # use_rebind=False(挂载主流程, 默认): 维持旧行为 _mt5_init(path)(会自动拉起 MT5)。
    def _query_trade_allowed():
        ok = _rebind_mt5(install_dir) if use_rebind else _mt5_init(path=terminal_exe)
        if ok:
            info = mt5.terminal_info()
            if info is not None and hasattr(info, "trade_allowed"):
                return bool(info.trade_allowed)
        return None

    before_trade_allowed = None
    try:
        before_trade_allowed = _query_trade_allowed()
    except Exception as e:
        logging.warning(f"[algotrading] SDK query 异常: {e}")
        return {"ok": False, "status": "sdk_query_failed", "error": str(e)}

    logging.info(f"[algotrading] before_trade_allowed={before_trade_allowed}")
    if before_trade_allowed is None:
        return {"ok": False, "status": "sdk_query_failed",
                "error": "terminal_info() 没返回 trade_allowed 字段"}
    if before_trade_allowed == want_on:
        logging.info(f"[algotrading] 已是目标态 want_on={want_on}, 跳过 Ctrl+E")
        return {"ok": True, "status": "already_on" if want_on else "already_off",
                "before_trade_allowed": before_trade_allowed}

    # 当前态 != 目标 → 找 MT5 PID 注入 Ctrl+E 切换
    pids = _list_mt5_pids(install_dir)
    if not pids:
        logging.warning(f"[algotrading] 没找到 MT5 PID @ {install_dir}")
        return {"ok": False, "status": "no_pid",
                "before_trade_allowed": before_trade_allowed,
                "error": f"{install_dir} 下没找到 terminal64.exe PID, 无法注入 Ctrl+E"}
    target_pid = pids[0]
    logging.info(f"[algotrading] 注入 Ctrl+E 到 pid={target_pid} (候选 pids={pids})")

    # PowerShell script: 5 重 UIPI fallback bring-to-front + keybd_event Ctrl+E
    # 跟 electron/main.js _bringWindowToFront 同款, 多一段 SendCtrlE
    ps_script = r'''
$ErrorActionPreference = 'Continue'
$pidT = ''' + str(int(target_pid)) + r'''

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool fUnknown);
  public const int SW_RESTORE = 9; public const int SW_MINIMIZE = 6;
  public const byte VK_MENU = 0x12; public const byte VK_CONTROL = 0x11; public const byte VK_E = 0x45;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static IntPtr FindMainByPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string BringToFront(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    uint targetPidDummy;
    uint targetTid = GetWindowThreadProcessId(hwnd, out targetPidDummy);
    uint myTid = GetCurrentThreadId();
    bool attached = false;
    if (targetTid != myTid) attached = AttachThreadInput(myTid, targetTid, true);
    bool fgOk = SetForegroundWindow(hwnd);
    if (attached) AttachThreadInput(myTid, targetTid, false);
    return fgOk ? "ok" : "fg_failed";
  }
  public static string AltTrick(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    return SetForegroundWindow(hwnd) ? "ok" : "alt_fail";
  }
  public static string MinRestore(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    ShowWindow(hwnd, SW_MINIMIZE);
    System.Threading.Thread.Sleep(80);
    ShowWindow(hwnd, SW_RESTORE);
    System.Threading.Thread.Sleep(80);
    return GetForegroundWindow() == hwnd ? "ok" : "minrestore_fail";
  }
  public static string SwitchTo(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    SwitchToThisWindow(hwnd, true);
    System.Threading.Thread.Sleep(80);
    return GetForegroundWindow() == hwnd ? "ok" : "switchto_fail";
  }
  // Ctrl+E 注入. 调用方保证 MT5 已经在前台.
  public static void SendCtrlE() {
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event(VK_E, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event(VK_E, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@

$via = $null
$t1 = [W]::BringToFront([uint32]$pidT); if ($t1 -eq "ok") { $via = "win32" }
if (-not $via) { $t2 = [W]::AltTrick([uint32]$pidT); if ($t2 -eq "ok") { $via = "alt_trick" } }
if (-not $via) { $t3 = [W]::MinRestore([uint32]$pidT); if ($t3 -eq "ok") { $via = "minrestore" } }
if (-not $via) { $t4 = [W]::SwitchTo([uint32]$pidT); if ($t4 -eq "ok") { $via = "switchto" } }
if (-not $via) {
  try {
    $wsh = New-Object -ComObject WScript.Shell
    if ($wsh.AppActivate([int]$pidT)) { $via = "wscript" }
  } catch {}
}
if (-not $via) { Write-Output "fail:no_front"; exit 1 }

# MT5 前台已经拿到, 等 200ms 让 OS 把焦点切实切过去, 再注入 Ctrl+E
Start-Sleep -Milliseconds 200
[W]::SendCtrlE()
Write-Output "ok:$via"
'''

    # 0.3.271: 最多试 2 次, 第一次失败 (5 重 fallback 全拒, 或注入了但 trade_allowed
    # 仍 false) → 等 1s 再试一次. Win11 偶发首次 SetForegroundWindow UIPI 拒,
    # 几秒后用户操作切走焦点 / OS 重置 input-focus 优先级后第二次能拿到.
    attempts = []
    via = None
    err_text = ""
    last_ps_out = ""
    for attempt_idx in range(2):
        if attempt_idx > 0:
            logging.info(f"[algotrading] 第 1 次失败, 等 1s 重试 (第 {attempt_idx+1} 次)")
            _time.sleep(1.0)
        try:
            encoded = base64.b64encode(ps_script.encode("utf-16le")).decode("ascii")
            proc = _sp.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-EncodedCommand", encoded],
                capture_output=True, text=True, timeout=10,
                creationflags=getattr(_sp, "CREATE_NO_WINDOW", 0),
            )
            out = (proc.stdout or "").strip()
            last_ps_out = out
            err_text = (proc.stderr or "").strip()[:400]
            last_line = (out.splitlines() or [""])[-1]
            logging.info(f"[algotrading] attempt#{attempt_idx+1} PS out: {last_line!r} (rc={proc.returncode})")
            if last_line.startswith("ok:"):
                via = last_line[3:]
                attempts.append({"idx": attempt_idx + 1, "via": via})
                break
            else:
                attempts.append({"idx": attempt_idx + 1, "result": last_line or "empty"})
        except _sp.TimeoutExpired:
            logging.warning(f"[algotrading] attempt#{attempt_idx+1} PowerShell timeout (10s)")
            attempts.append({"idx": attempt_idx + 1, "result": "timeout"})
            if attempt_idx == 1:
                return {"ok": False, "status": "switch_failed",
                        "before_trade_allowed": before_trade_allowed,
                        "error": "PowerShell Ctrl+E 注入超时 (10s, 两次)",
                        "attempts": attempts}
        except Exception as e:
            logging.warning(f"[algotrading] attempt#{attempt_idx+1} spawn err: {e}")
            attempts.append({"idx": attempt_idx + 1, "result": f"spawn_err: {e}"})
            if attempt_idx == 1:
                return {"ok": False, "status": "switch_failed",
                        "before_trade_allowed": before_trade_allowed,
                        "error": f"PowerShell spawn 失败: {e}",
                        "attempts": attempts}

    if via is None:
        logging.warning(f"[algotrading] 两次 5 重 UIPI fallback 全拒, ps_stderr={err_text[:200]}")
        return {"ok": False, "status": "switch_failed",
                "before_trade_allowed": before_trade_allowed,
                "error": "5 重 UIPI fallback 全拒 (两次重试均失败)",
                "ps_stderr": err_text,
                "attempts": attempts}

    # 等 800ms 让 MT5 处理 Ctrl+E + terminal.ini 状态翻转, 再回查
    _time.sleep(0.8)
    after_trade_allowed = None
    try:
        # 重新 query 拿新 terminal_info — MT5 内部 trade_allowed 已变, SDK cache 可能没刷
        if not use_rebind:
            mt5.shutdown()   # 非 rebind 路径: 强制 fresh init
        after_trade_allowed = _query_trade_allowed()
    except Exception as e:
        logging.warning(f"[algotrading] 回查 trade_allowed 异常: {e}")

    logging.info(f"[algotrading] via={via}, after_trade_allowed={after_trade_allowed}")

    # 注入了但没到目标态 → 再试一次 Ctrl+E (有时第一次 keystroke 时
    # MT5 焦点没完全切过来, 第二次能命中)
    if after_trade_allowed is not None and after_trade_allowed != want_on:
        logging.info(f"[algotrading] 注入后未到目标态(want_on={want_on}), 再来一次 Ctrl+E")
        _time.sleep(0.5)
        try:
            encoded = base64.b64encode(ps_script.encode("utf-16le")).decode("ascii")
            proc = _sp.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-EncodedCommand", encoded],
                capture_output=True, text=True, timeout=10,
                creationflags=getattr(_sp, "CREATE_NO_WINDOW", 0),
            )
            out = (proc.stdout or "").strip()
            last_line = (out.splitlines() or [""])[-1]
            logging.info(f"[algotrading] retry-after-false PS out: {last_line!r}")
            if last_line.startswith("ok:"):
                via = via + "+" + last_line[3:]
                attempts.append({"idx": "retry-after-false", "via": last_line[3:]})
                _time.sleep(0.8)
                try:
                    if not use_rebind:
                        mt5.shutdown()
                    after_trade_allowed = _query_trade_allowed()
                except Exception:
                    pass
                logging.info(f"[algotrading] after retry: after_trade_allowed={after_trade_allowed}")
        except Exception as e:
            logging.warning(f"[algotrading] retry-after-false err: {e}")

    ok = (after_trade_allowed == want_on)
    return {
        "ok": ok,
        "status": ("switched_on" if want_on else "switched_off") if ok else "switch_failed",
        "via": via,
        "before_trade_allowed": before_trade_allowed,
        "after_trade_allowed": after_trade_allowed,
        "attempts": attempts,
        **({"hint": "Ctrl+E 注入了但 MT5 仍报 trade_allowed=false. 可能撞「通过外部 Python API 禁用算法交易」选项 (5s 拉 account-info 自动反弹) — 请去 MT5 工具 → 选项 → EA 标签把那个选项取消勾选, 或手动点工具栏「▶ 算法交易」按钮."} if (not ok and want_on) else {}),
        **({"hint": "Ctrl+E 注入了但 MT5 仍报算法交易未关. EA 或「外部 Python API」选项可能又把它打开 — 请手动点 MT5 工具栏「算法交易」按钮确认关闭."} if (not ok and not want_on) else {}),
    }


def _ensure_algotrading_on(terminal_exe: str, install_dir: str) -> dict:
    """挂载/启动时确保全局算法交易**开启**(薄包装, 行为同旧版)。"""
    return _set_algotrading(terminal_exe, install_dir, want_on=True)


def _ensure_algotrading_off(terminal_exe: str, install_dir: str) -> dict:
    """手机「暂停交易」用: 确保全局算法交易**关闭**(挂载那套的逆过程)。"""
    return _set_algotrading(terminal_exe, install_dir, want_on=False)


def _set_auto_trading_tool(args: dict) -> list[TextContent]:
    """手机「暂停交易 / 恢复交易」: 确定性切 MT5 全局「算法交易」开关(Ctrl+E 注入 + 回查验证)。
    enabled=False(默认) = 暂停(关算法交易); enabled=True = 恢复(开)。
    instance_name(可选): 只切指定实例(按 settings 实例名匹配, 手机端「某策略旁的开关」用,
      只暂停/恢复该策略对应的那台 MT5); 不传 = 所有在跑实例(全局)。
    多实例下逐个 _rebind_mt5 切到该实例上下文再切+回查(裸 _mt5_init(path) 多实例会读错/
    切错实例), 完后 rebind 回 active。据实回报每实例结果。顶层 ok: 有在跑实例且全切成功 → True。"""
    want_on = bool(args.get("enabled", False))
    target_name = (args.get("instance_name") or "").strip()   # 定向: 只切这个实例

    def _json(obj):
        return [TextContent(type="text", text=json.dumps(obj, ensure_ascii=False))]

    def _terminal_exe(d):
        for cand in ("terminal64.exe", "terminal.exe"):
            p = os.path.join(d, cand)
            if os.path.isfile(p):
                return p
        return None

    instances, active_id = _read_mt5_instances_from_settings()
    active_install_dir = None
    for inst in (instances or []):     # 先定位 active(rebind 回去用), 不受定向过滤影响
        if inst.get("id") == active_id and (inst.get("installDir") or "").strip():
            active_install_dir = (inst.get("installDir") or "").strip()
    targets = []   # (name, install_dir, use_rebind)
    if instances:
        for inst in instances:
            nm = inst.get("name") or inst.get("id") or ""
            if target_name and nm != target_name:
                continue                # 定向: 跳过非目标实例
            d = (inst.get("installDir") or "").strip()
            if d:
                targets.append((nm or d, d, True))
    else:
        # 单 MT5(没配实例): 定向无意义, 直接默认目录
        d = _resolve_mt5_install_dir()
        if d:
            targets.append(("default", d, False))
    if not targets:
        return _json({"ok": False, "error": (f"找不到名为「{target_name}」的 MT5 实例" if target_name
                                              else "找不到任何 MT5 安装目录(未配置实例且默认目录解析失败)")})

    results = []
    running_ok = 0
    running_fail = 0
    try:
        for name, d, use_rebind in targets:
            # 只处理「在跑」的实例(没在跑 = 没在交易, 暂停语义下跳过, 也避免 rebind 自动拉起)
            try:
                running = _ezd_terminal_is_running(d)
            except Exception:
                running = True   # 检测失败按在跑处理, 交给内部 no_pid 兜底
            if not running:
                results.append({"name": name, "install_dir": d, "status": "not_running"})
                continue
            te = _terminal_exe(d)
            if not te:
                results.append({"name": name, "install_dir": d, "status": "no_terminal_exe"})
                continue
            try:
                # 多实例必须 use_rebind=True 才能把 SDK 上下文切到该实例读对状态/切对窗口
                r = _set_algotrading(te, d, want_on=want_on, use_rebind=use_rebind)
            except Exception as e:
                r = {"ok": False, "status": "exception", "error": f"{type(e).__name__}: {e}"}
            results.append({"name": name, "install_dir": d, **r})
            if r.get("status") in ("no_pid", "no_terminal_exe", "not_running"):
                continue        # 没在跑 → 不计入成败
            if r.get("ok"):
                running_ok += 1
            else:
                running_fail += 1
    finally:
        # rebind 回 active, 防其它工具 / 定时状态读错实例
        if active_install_dir:
            try:
                _rebind_mt5(active_install_dir)
            except Exception:
                pass

    action = "恢复自动交易" if want_on else "暂停自动交易"
    if running_ok + running_fail == 0:
        # 没有在跑的 MT5 → 暂停语义下等于本来就没在自动交易(据实告知, 不算失败)
        return _json({
            "ok": True, "status": "no_running_mt5",
            "message": "未发现正在运行的 MT5。" + ("自动交易本就处于停止状态。" if not want_on else "请先启动 MT5 再恢复。"),
            "results": results,
        })
    ok = running_fail == 0
    return _json({
        "ok": ok,
        "status": "all_done" if ok else "partial_failed",
        "message": f"{action}：{running_ok} 个实例成功" + (f"、{running_fail} 个失败" if running_fail else "") + "。",
        "results": results,
    })


def _press_f7_for_ea(install_dir: str) -> dict:
    """0.3.318: F7 hotkey 强制弹 EA 属性对话框. MT5 documented:
    chart active 时按 F7 = 当前 chart 上 EA 的属性框. 主动触发让
    _auto_confirm_ea_dialog 有 dialog 可点 (避开 MT5 5836 silent attach 不弹).

    流程: bring MT5 to front (5 重 UIPI fallback) → 等 200ms → SendInput F7.
    复用 _ensure_algotrading_on 同款 PowerShell 模板, 把 Ctrl+E 改 F7."""
    import subprocess as _sp
    import time as _time

    pids = _list_mt5_pids(install_dir)
    if not pids:
        return {"ok": False, "status": "no_pid", "error": f"{install_dir} 下没找到 terminal64.exe"}
    target_pid = pids[0]
    logging.info(f"[f7] 发 F7 到 pid={target_pid}")

    ps_script = r'''
$ErrorActionPreference = 'Continue'
$pidT = ''' + str(int(target_pid)) + r'''

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WF7 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool fUnknown);
  public const int SW_RESTORE = 9; public const int SW_MINIMIZE = 6;
  public const byte VK_MENU = 0x12; public const byte VK_F7 = 0x76;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static IntPtr FindMainByPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string BringToFront(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    uint targetPidDummy;
    uint targetTid = GetWindowThreadProcessId(hwnd, out targetPidDummy);
    uint myTid = GetCurrentThreadId();
    bool attached = false;
    if (targetTid != myTid) attached = AttachThreadInput(myTid, targetTid, true);
    bool fgOk = SetForegroundWindow(hwnd);
    if (attached) AttachThreadInput(myTid, targetTid, false);
    return fgOk ? "ok" : "fg_failed";
  }
  public static string MinRestore(uint pid) {
    IntPtr hwnd = FindMainByPid(pid);
    if (hwnd == IntPtr.Zero) return "no_window";
    ShowWindow(hwnd, SW_MINIMIZE);
    System.Threading.Thread.Sleep(80);
    ShowWindow(hwnd, SW_RESTORE);
    System.Threading.Thread.Sleep(80);
    return GetForegroundWindow() == hwnd ? "ok" : "minrestore_fail";
  }
  public static void SendF7() {
    keybd_event(VK_F7, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(VK_F7, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@

$via = $null
$t1 = [WF7]::BringToFront([uint32]$pidT); if ($t1 -eq "ok") { $via = "win32" }
if (-not $via) { $t2 = [WF7]::MinRestore([uint32]$pidT); if ($t2 -eq "ok") { $via = "minrestore" } }
if (-not $via) {
  try {
    $wsh = New-Object -ComObject WScript.Shell
    if ($wsh.AppActivate([int]$pidT)) { $via = "wscript" }
  } catch {}
}
if (-not $via) { Write-Output "fail:no_front"; exit 1 }

Start-Sleep -Milliseconds 300
[WF7]::SendF7()
Write-Output "ok:$via"
'''

    try:
        encoded = base64.b64encode(ps_script.encode("utf-16le")).decode("ascii")
        proc = _sp.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-EncodedCommand", encoded],
            capture_output=True, text=True, timeout=15,
        )
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        logging.info(f"[f7] PowerShell rc={proc.returncode} stdout={stdout!r} stderr={stderr[:200]!r}")
        if proc.returncode != 0 or not stdout.startswith("ok:"):
            return {"ok": False, "status": "send_failed",
                    "stdout": stdout, "stderr": stderr}
        via = stdout.split(":", 1)[1] if ":" in stdout else "unknown"
        return {"ok": True, "status": "sent", "via": via}
    except Exception as e:
        logging.warning(f"[f7] PowerShell exception: {e}")
        return {"ok": False, "status": "exception", "error": str(e)}


def _ensure_webrequest_whitelist(install_dir: str, urls=None) -> None:
    """1.2.39: 把 EasyDeal 服务端域名写进 MT5 的 WebRequest 白名单
    (config/common.ini 的 [Experts] WebRequest=1 + WebRequestUrl), 让 EA(如经济
    日历采集)能 WebRequest 直传。

    根因: EasyDeal 挂载靠 taskkill 杀 MT5, MT5 没机会保存用户在 GUI 手动加的白名单
    → 重挂后清空。写进文件就持久(杀进程丢不了)。幂等(已满足就不写) + 只动 [Experts]
    的这两个 key, 合并保留用户已有的其它 URL。"""
    if urls is None:
        urls = ["https://easydeal.fay-agent.com"]
    try:
        ini = os.path.join(install_dir, "config", "common.ini")
        if not os.path.isfile(ini) and os.path.isfile(os.path.join(install_dir, "Config", "common.ini")):
            ini = os.path.join(install_dir, "Config", "common.ini")
        try:
            with open(ini, "r", encoding="utf-16-le") as f:
                content = f.read()
            enc = "utf-16-le"
        except (FileNotFoundError, UnicodeError):
            try:
                with open(ini, "r", encoding="utf-8") as f:
                    content = f.read()
                enc = "utf-8"
            except FileNotFoundError:
                content = ""; enc = "utf-16-le"
        lines = content.splitlines() if content else []
        sec = "[Experts]"
        s0, s1 = -1, len(lines)
        for i, ln in enumerate(lines):
            if ln.strip().lstrip("﻿") == sec:
                s0 = i
                for j in range(i + 1, len(lines)):
                    t = lines[j].strip()
                    if t.startswith("[") and t.endswith("]"):
                        s1 = j; break
                break

        def _cur(key):
            rng = range(s0 + 1, s1) if s0 >= 0 else range(0)
            for k in rng:
                st = lines[k].strip()
                if "=" in st and st.split("=", 1)[0].strip() == key:
                    return st.split("=", 1)[1].strip()
            return ""

        # 已满足 → 幂等不写
        if s0 >= 0 and _cur("WebRequest") == "1" and all(u.split("//")[-1] in _cur("WebRequestUrl") for u in urls):
            return
        merged = [u.strip() for u in _cur("WebRequestUrl").replace(";", ",").split(",") if u.strip()]
        for u in urls:
            host = u.split("//")[-1]
            if not any(host in m for m in merged):
                merged.append(u)
        desired = {"WebRequest": "1", "WebRequestUrl": ",".join(dict.fromkeys(merged))}
        if s0 < 0:
            new_lines = lines + ([""] if lines and lines[-1] else []) + [sec] + [f"{k}={v}" for k, v in desired.items()] + [""]
        else:
            sl = lines[s0:s1]; seen = set()
            for i, ln in enumerate(sl):
                if i == 0:
                    continue
                st = ln.strip()
                if "=" in st:
                    key = st.split("=", 1)[0].strip()
                    if key in desired:
                        sl[i] = f"{key}={desired[key]}"; seen.add(key)
            for k, v in desired.items():
                if k not in seen:
                    sl.append(f"{k}={v}")
            new_lines = lines[:s0] + sl + lines[s1:]
        new_content = "\n".join(new_lines) + "\n"
        os.makedirs(os.path.dirname(ini), exist_ok=True)
        with open(ini, "w", encoding=enc) as f:
            f.write(new_content)
        logging.info(f"[webreq] WebRequest 白名单已写入 {ini} (urls={desired['WebRequestUrl']})")
    except Exception as e:
        logging.warning(f"[webreq] ensure whitelist failed: {e}")


# 0.3.271: mounted-state.json — 记录每个 MT5 instance 上次成功挂载的 EA 信息.
# 用户痛点: 关 MT5 后用 EasyDeal 重启 → EA / 图表消失 (因 startup.ini 是一次性
# 的, MT5 默认启动不读 ini). 持久化挂载状态后, Node 端 launchMt5 启动前查
# 这个文件, 如果该 instance 上次有 EA → 重写 startup.ini + /config: 启动 →
# 自动恢复 EA + 图表. 用户不用每次都从「自动挂载」按钮启动.
def _mounted_state_path() -> str | None:
    """返回 mounted-state.json 路径. EASYDEAL_DATA_DIR 缺失返 None (silent noop)."""
    data_dir = os.getenv("EASYDEAL_DATA_DIR")
    if not data_dir:
        return None
    return os.path.join(data_dir, "mounted-state.json")


def _norm_install_key(install_dir: str) -> str:
    """规范化 install_dir 作为 mounted-state.json 的 key.
    Windows 路径大小写不敏感 + 分隔符多样, 统一 lower + 替换 / → \\ + 去末尾 \\."""
    s = str(install_dir or "").replace("/", "\\").rstrip("\\")
    return s.lower()


def _save_mounted_state(install_dir: str, symbol: str, period: str,
                         ea_name: str, login: int | None = None,
                         server: str | None = None) -> None:
    """0.3.271: 写入该 install_dir 最后一次成功挂载的 EA 信息.
    Node 端 launchMt5 时读这个文件, 自动恢复 EA + 图表."""
    import datetime as _dt
    fp = _mounted_state_path()
    if not fp:
        logging.warning("[mounted-state] EASYDEAL_DATA_DIR 未设, 跳过持久化")
        return
    try:
        state = {}
        if os.path.exists(fp):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    state = json.load(f) or {}
            except (json.JSONDecodeError, OSError):
                state = {}
        key = _norm_install_key(install_dir)
        state[key] = {
            "install_dir": install_dir,
            "symbol":      symbol,
            "period":      period,
            "ea_name":     ea_name,
            "login":       login,
            "server":      server,
            "mounted_at":  _dt.datetime.now().isoformat(timespec="seconds"),
            # 0.4.25 req3: 显式标记「这条挂载是 EasyDeal 自动挂载的」. _save_mounted_state
            # 只在 auto-attach 流程被调, 所以恒为 'auto'. Node 端 launchMt5 restore 时
            # 只恢复 mount_mode=='auto' (或缺字段=老数据=auto) 的, 用户自己手挂的 EA
            # 不会进这个文件, 自然不会被强制恢复. 让「只恢复自动挂载」语义显式可查.
            "mount_mode":  "auto",
        }
        # atomic write — tmp + rename, 防 Electron 端 launchMt5 撞读到半写状态
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        tmp = fp + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(tmp, fp)
        logging.info(f"[mounted-state] saved: {key} → {ea_name} on {symbol}/{period}")
    except Exception as e:
        logging.warning(f"[mounted-state] save 失败: {e}")


def _chart_has_ea(install_dir: str, ea_name: str,
                  data_dir: str | None = None) -> bool:
    """Return whether the active MT5 profile already has this exact EA.

    Current MT5 builds use MQL5/Profiles/Charts/<ProfileLast> and .chr files
    are normally UTF-16.  Matching parsed <expert> names avoids substring
    false positives such as matching ``Foo`` against ``Foo_v2``.
    """
    if data_dir is None:
        data_dir = os.getenv("EASYDEAL_MT5_DATA_DIR", "") or _data_dir_for_install(install_dir)
    matches = _mt5_profile.find_ea_charts(install_dir, ea_name, data_dir)
    if matches:
        logging.info(f"[chr-detect] active profile contains EA {ea_name}: {matches[0]}")
    return bool(matches)


def _data_dir_for_install(install_dir: str) -> str | None:
    """按 install_dir 从 settings.mt5Instances 查该实例的 dataDir。
    ⚠ 非便携 MT5 的 profiles/图表(.chr)在 AppData 数据目录, **不在** install_dir —— 重挂去重
    只扫 install_dir 会扫空(斯宇实测: 重挂没替换掉旧图表)。查不到 / 便携(dataDir==installDir)返 None。"""
    try:
        norm = os.path.normcase(os.path.normpath(str(install_dir or "").rstrip("\\/")))
        instances, _ = _read_mt5_instances_from_settings()
        for inst in instances:
            idir = inst.get("installDir")
            if idir and os.path.normcase(os.path.normpath(str(idir).rstrip("\\/"))) == norm:
                dd = inst.get("dataDir")
                if dd and os.path.normcase(os.path.normpath(str(dd).rstrip("\\/"))) != norm:
                    return dd
        return None
    except Exception:
        return None


def _load_mounted_state(install_dir: str) -> dict | None:
    """0.3.304: 读该 install_dir 的挂载记录.
    返 dict {install_dir, symbol, period, ea_name, login, server, mounted_at} 或 None."""
    fp = _mounted_state_path()
    if not fp or not os.path.exists(fp):
        return None
    try:
        with open(fp, "r", encoding="utf-8") as f:
            state = json.load(f) or {}
        return state.get(_norm_install_key(install_dir))
    except Exception as e:
        logging.warning(f"[mounted-state] load 失败: {e}")
        return None


def _clear_mounted_state(install_dir: str) -> None:
    """0.3.271: 清掉该 install_dir 的挂载记录. 用户在 EasyDeal 卸载 EA / 切换
    binding / 删策略时调用, 防下次 launchMt5 自动恢复一个已删的 EA."""
    fp = _mounted_state_path()
    if not fp or not os.path.exists(fp):
        return
    try:
        with open(fp, "r", encoding="utf-8") as f:
            state = json.load(f) or {}
        key = _norm_install_key(install_dir)
        if key in state:
            del state[key]
            tmp = fp + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
            os.replace(tmp, fp)
            logging.info(f"[mounted-state] cleared: {key}")
    except Exception as e:
        logging.warning(f"[mounted-state] clear 失败: {e}")


# ===================== Tools: list / open / close chart windows =====================
#
# 图表窗口增删查。跟挂 EA 那套「kill + startup ini + 重启」完全独立, 全程不动 MT5
# 进程 —— 进程生命周期归 Electron 端 supervisor 管, 这里自己重启会被它判成未授权替换。
#   - MT5 在跑, 查 / 关: 直接跟窗口打交道 (mt5_windows)。关闭发的是标题栏 X 同款
#     系统命令, MT5 自己同步 profile, 不需要我们碰文件。
#   - MT5 在跑, 开: MT5 没有「运行中新开指定品种图表」的外部入口, 只能往 profile 目录
#     写 .chr。profile 正被加载时写进去的文件 MT5 不认, 所以先切到另一个 profile
#     (MT5 此刻把当前 profile 落盘并放手), 写完再切回来让它整个重新加载。
#   - MT5 没在跑: 三个工具都直接读写 profile 文件, 下次启动生效。

_CHART_LIMIT = 100          # MT5 最多同时开 100 个图表
_CHART_PUBLIC_KEYS = ("id", "symbol", "period", "ea_name")


def _chart_json(obj: dict) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(obj, ensure_ascii=False, indent=2))]


def _chart_public(chart: dict) -> dict:
    return {key: chart.get(key) for key in _CHART_PUBLIC_KEYS}


def _chart_wait(probe, timeout_sec: float, interval_sec: float = 0.3):
    """轮询 probe 直到返回真值或超时, 返回最后一次的结果。"""
    deadline = time.time() + timeout_sec
    while True:
        value = probe()
        if value or time.time() >= deadline:
            return value
        time.sleep(interval_sec)


def _chart_target(args: dict) -> dict:
    """解析图表工具作用的 MT5 实例: 目录 + 是否在跑 + 主窗口句柄。"""
    instance_id = str(args.get("instance_id") or "").strip()
    instances, _active_id = _read_mt5_instances_from_settings()
    if instance_id:
        inst = next((it for it in instances if it.get("id") == instance_id), None)
        if not inst or not inst.get("installDir"):
            raise ValueError(f"instance_id={instance_id} 不存在. 调 list_mt5_instances 看有效 ID.")
        install_dir = inst["installDir"]
        data_dir = inst.get("dataDir") or install_dir
    else:
        # Electron 端按 EA 绑定传 install_dir; 都没有就是默认实例。
        install_dir = str(args.get("install_dir") or "").strip() or _resolve_mt5_install_dir()
        if not install_dir:
            raise ValueError("MT5 安装目录未确定（没有配置默认实例）")
        wanted = _mt5_lifecycle.norm_path(install_dir)
        inst = next((it for it in instances
                     if _mt5_lifecycle.norm_path(it.get("installDir")) == wanted), None)
        data_dir = ((inst or {}).get("dataDir") or str(args.get("data_dir") or "").strip()
                    or _resolve_mt5_data_dir() or install_dir)

    pids = _mt5_lifecycle.exact_terminal_pids(install_dir)
    main = None
    if len(pids) > 1:
        raise RuntimeError(f"该实例有 {len(pids)} 个 MT5 进程在跑, 无法确定操作哪个窗口")
    if pids:
        main = _mt5_windows.main_window(pids[0])
        if not main:
            raise RuntimeError("MT5 进程在跑但主窗口还没出现（多半还在启动）, 稍后再试")
    elif _mt5_lifecycle.unreadable_terminal_pids():
        raise RuntimeError(
            "有 MT5 进程读不到路径（多半是以管理员权限启动的）, 无法判断目标实例是否在跑。"
            "请让 EasyDeal 和 MT5 用相同权限运行后再试")
    return {
        "instance_id": (inst or {}).get("id") or instance_id or None,
        "instance_name": (inst or {}).get("name"),
        "install_dir": install_dir,
        "data_dir": data_dir,
        "running": bool(pids),
        "main": main,
    }


def _chart_loaded_profile(target: dict) -> tuple[list[dict], dict | None]:
    """在跑的 MT5 此刻加载着哪个 profile。返回 (菜单里的全部 profile, 当前那个)。
    运行期间用户可能切过 profile, common.ini 的 ProfileLast 要到退出才更新, 所以问菜单。"""
    names = _mt5_profile.profile_names(target["install_dir"], target["data_dir"])
    menu = _mt5_windows.profile_menu(target["main"], names)
    return menu, next((item for item in menu if item["checked"]), None)


def _chart_profile_dir(target: dict):
    if target["running"]:
        _menu, loaded = _chart_loaded_profile(target)
        if loaded:
            return _mt5_profile.named_profile_dir(
                target["install_dir"], loaded["name"], target["data_dir"])
    return _mt5_profile.active_profile_dir(target["install_dir"], target["data_dir"])


def _chart_snapshot(target: dict) -> dict:
    """当前图表列表。在跑 = 实时窗口; 没在跑 = profile 文件 (下次启动会打开的)。

    ea_name 只有 profile 文件里有。实时窗口按 (品种, 周期) 对上落盘快照里挂了 EA 的
    图表就带上 —— 宁可多标, 因为它决定 close 时要不要保护这个窗口。"""
    profile_dir = _chart_profile_dir(target)
    saved = _mt5_profile.list_profile_charts(profile_dir) if profile_dir else []
    profile_name = profile_dir.name if profile_dir else None
    if not target["running"]:
        charts = [{"id": f"file:{chart['file']}", "symbol": chart["symbol"],
                   "period": chart["period"], "ea_name": chart["ea_name"],
                   "_file": chart["file"]} for chart in saved]
        return {"source": "profile", "profile": profile_name,
                "profile_dir": profile_dir, "charts": charts}

    # 窗口枚举顺序 = 文件顺序 (沙盒实测), 同 (品种, 周期) 的按先后一一配对。
    unpaired = list(saved)
    charts = []
    for window in _mt5_windows.chart_windows(target["main"]):
        symbol, period = _mt5_profile.parse_chart_title(window["title"]) or (window["title"], "")
        key = (symbol.casefold(), period)
        match = next((c for c in unpaired if (c["symbol"].casefold(), c["period"]) == key), None)
        if match:
            unpaired.remove(match)
        charts.append({"id": f"window:{window['handle']:#x}", "symbol": symbol, "period": period,
                       "ea_name": (match or {}).get("ea_name"),
                       "_handle": window["handle"], "_file": (match or {}).get("file")})
    return {"source": "live", "profile": profile_name,
            "profile_dir": profile_dir, "charts": charts}


def _chart_result_base(target: dict, snapshot: dict) -> dict:
    return {
        "instance_id": target["instance_id"],
        "instance_name": target["instance_name"],
        "running": target["running"],
        "source": snapshot["source"],
        "profile": snapshot["profile"],
    }


def _list_trade_charts_tool(args: dict) -> list[TextContent]:
    try:
        target = _chart_target(args or {})
        snapshot = _chart_snapshot(target)
    except (ValueError, RuntimeError, OSError) as e:
        return _chart_json({"ok": False, "error": str(e)})
    return _chart_json({
        "ok": True,
        **_chart_result_base(target, snapshot),
        "count": len(snapshot["charts"]),
        "charts": [_chart_public(chart) for chart in snapshot["charts"]],
        "note": ("MT5 在跑: 这是此刻实际打开的图表窗口" if target["running"]
                 else "MT5 没在跑: 这是 profile 里保存的图表, 下次启动该实例时会打开"),
    })


def _chart_open_specs(raw) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("charts 必填: 至少一项 {symbol, period}")
    specs = []
    for item in raw:
        if not isinstance(item, dict) or not str(item.get("symbol") or "").strip():
            raise ValueError(f"charts 每项都要有 symbol: {item!r}")
        period = _mt5_profile.normalize_period(item.get("period") or "H1")
        if not period:
            raise ValueError(f"不支持的周期 {item.get('period')!r}, 可选: {', '.join(_mt5_profile.PERIODS)}")
        specs.append({"symbol": str(item["symbol"]).strip(), "period": period})
    return specs


def _chart_resolve_symbols(target: dict, specs: list[dict]) -> list[str]:
    """把 spec 里的品种名换成券商上真实存在的 (XAUUSD → XAUUSDm), 返回找不到的品种。
    SDK 没连着目标实例时不校验, 原样放行 —— 图表工具不该因为 SDK 状态而不可用。"""
    try:
        with _Mt5InstanceContext(target["instance_id"]):
            info = mt5.terminal_info()
            if not info or (_mt5_lifecycle.norm_path(info.path)
                            != _mt5_lifecycle.norm_path(target["install_dir"])):
                return []
            missing = []
            for spec in specs:
                picked, _candidates = _pick_chartable_symbol([spec["symbol"]])
                if not picked:
                    missing.append(spec["symbol"])
                    continue
                spec["symbol"] = picked
                try:
                    mt5.symbol_select(picked, True)
                except Exception:
                    pass
            return missing
    except Exception as e:
        logging.warning(f"[charts] 品种校验跳过: {e}")
        return []


def _chart_pick_bridge(target: dict, menu: list[dict], loaded: dict) -> dict | None:
    """挑一个过渡 profile: 切过去的那一两秒它的图表会真的被加载, 所以必须不含 EA,
    图表越少越快。"""
    best = None
    for item in menu:
        if item["name"].casefold() == loaded["name"].casefold():
            continue
        profile_dir = _mt5_profile.named_profile_dir(
            target["install_dir"], item["name"], target["data_dir"])
        if not profile_dir:
            continue
        charts = _mt5_profile.list_profile_charts(profile_dir)
        if any(chart["ea_name"] for chart in charts):
            continue
        if best is None or len(charts) < best[0]:
            best = (len(charts), item)
    return best[1] if best else None


def _chart_switch_profile(target: dict, item: dict, timeout_sec: float) -> bool:
    """让 MT5 加载指定 profile 并等到它确实生效。"""
    def loaded_name():
        _menu, loaded = _chart_loaded_profile(target)
        return loaded["name"] if loaded else None

    _mt5_windows.select_profile(target["main"], item["command_id"])
    return bool(_chart_wait(lambda: loaded_name() == item["name"], timeout_sec))


def _open_charts_stopped(target: dict, specs: list[dict]) -> dict:
    profile_dir = _mt5_profile.active_profile_dir(target["install_dir"], target["data_dir"])
    if not profile_dir:
        # 从没启动过的实例还没有 profile 目录, MT5 首次启动默认加载 Default。
        mql5_dir = os.path.join(target["data_dir"], "MQL5")
        if not os.path.isdir(mql5_dir):
            return {"ok": False, "error": f"找不到 MT5 数据目录: {mql5_dir}"}
        profile_dir = os.path.join(mql5_dir, "Profiles", "Charts", "Default")
    existing = _mt5_profile.list_profile_charts(profile_dir)
    if len(existing) + len(specs) > _CHART_LIMIT:
        return {"ok": False, "error": f"MT5 最多同时开 {_CHART_LIMIT} 个图表, 现有 {len(existing)} 个"}
    added = _mt5_profile.add_charts(profile_dir, specs)
    snapshot = _chart_snapshot(target)
    return {
        "ok": True,
        "stage": "saved_to_profile",
        **_chart_result_base(target, snapshot),
        "opened": [{"symbol": chart["symbol"], "period": chart["period"]} for chart in added],
        "count": len(snapshot["charts"]),
        "charts": [_chart_public(chart) for chart in snapshot["charts"]],
        "note": "MT5 没在跑: 图表已写进 profile, 下次启动该实例时出现",
    }


def _chart_reload_preflight(target: dict) -> dict:
    """运行中的 MT5 能不能被要求重新加载图表配置。返回 {ok, loaded, loaded_dir, bridge}
    或 {ok: False, stage, error, hint}。"""
    hint = "在 EasyDeal「MT5 实例」里停止该实例后再调用本工具: 停止状态下直接写入, 下次启动时出现"
    if not _mt5_windows.is_enabled(target["main"]):
        return {"ok": False, "stage": "mt5_dialog_open",
                "error": "MT5 当前有弹窗没关（主窗口被锁住）, 先关掉弹窗再试"}
    menu, loaded = _chart_loaded_profile(target)
    loaded_dir = loaded and _mt5_profile.named_profile_dir(
        target["install_dir"], loaded["name"], target["data_dir"])
    if not loaded_dir:
        return {"ok": False, "stage": "profile_unknown",
                "error": "读不到 MT5 当前加载的图表配置(profile), 没法在运行中改图表", "hint": hint}
    bridge = _chart_pick_bridge(target, menu, loaded)
    if not bridge:
        return {"ok": False, "stage": "no_bridge_profile",
                "error": "该 MT5 没有第二个不含 EA 的图表配置(profile)可供过渡, 没法在运行中改图表",
                "hint": hint}
    return {"ok": True, "loaded": loaded, "loaded_dir": loaded_dir, "bridge": bridge}


def _chart_reload_impact(reason: str) -> dict:
    return {
        "impact": (f"MT5 在跑: {reason}需要让 MT5 重新加载一次图表配置（不重启进程, 约几秒）。"
                   "期间所有图表关闭再打开, 图表上的 EA 会重新初始化; broker 端持仓不受影响。"),
        "ai_next_action": ("还没有做任何改动。把上面的影响告诉用户, 用户同意后带 "
                           "confirm_reload=true 再调一次本工具。"),
    }


def _chart_reload_with(target: dict, pre: dict, mutate) -> dict:
    """切到过渡 profile → mutate(loaded_dir) 改文件 → 切回来让 MT5 整个重新加载。
    MT5 离开 profile 的瞬间就把它落盘 (沙盒实测 <0.1s), 所以 mutate 看到的是最新文件。
    返回 {ok, value} (mutate 的返回值) 或 {ok: False, stage, error, ai_next_action?}。"""
    loaded, loaded_dir, bridge = pre["loaded"], pre["loaded_dir"], pre["bridge"]
    logging.info(f"[charts] reload via profile '{bridge['name']}'")
    if not _chart_switch_profile(target, bridge, 15.0):
        return {"ok": False, "stage": "reload_failed",
                "error": "MT5 没有响应切换图表配置的命令, 图表没有任何改动"}
    value, mutate_error = None, None
    try:
        value = mutate(loaded_dir)
    except Exception as e:
        mutate_error = e
    # 不管写没写成都必须切回去 —— 原来的图表和 EA 此刻都没在加载。
    if not (_chart_switch_profile(target, loaded, 20.0)
            or _chart_switch_profile(target, loaded, 20.0)):
        return {
            "ok": False,
            "stage": "restore_failed",
            "error": (f"严重: MT5 停在图表配置「{bridge['name']}」, 没能切回「{loaded['name']}」, "
                      "原来的图表和 EA 现在都没有加载"),
            "ai_next_action": (f"立刻让用户在 MT5 菜单 文件 → 配置文件 里手动选回「{loaded['name']}」, "
                               "或在 EasyDeal「MT5 实例」里重启该实例。"),
        }
    if mutate_error:
        return {"ok": False, "stage": "write_failed",
                "error": f"写图表文件失败（已切回原图表配置）: {mutate_error}"}
    expected = len(_mt5_profile.list_profile_charts(loaded_dir))
    _chart_wait(lambda: len(_mt5_windows.chart_windows(target["main"])) >= expected, 30.0, 0.5)
    return {"ok": True, "value": value}


def _open_charts_running(target: dict, specs: list[dict], confirmed: bool) -> dict:
    pre = _chart_reload_preflight(target)
    if not pre["ok"]:
        return pre
    open_now = len(_mt5_windows.chart_windows(target["main"]))
    if open_now + len(specs) > _CHART_LIMIT:
        return {"ok": False, "error": f"MT5 最多同时开 {_CHART_LIMIT} 个图表, 现在已开 {open_now} 个"}
    missing = _chart_resolve_symbols(target, specs)
    if missing:
        return {"ok": False, "stage": "no_symbol_match",
                "error": f"当前券商上找不到这些品种: {', '.join(missing)}", "missing": missing}
    if not confirmed:
        ea_names = sorted({chart["ea_name"] for chart in
                           _mt5_profile.list_profile_charts(pre["loaded_dir"]) if chart["ea_name"]})
        return {"ok": False, "stage": "needs_user_confirm", "will_open": specs,
                "open_now": open_now, "ea_on_charts": ea_names, **_chart_reload_impact("追加图表")}

    done = _chart_reload_with(target, pre, lambda profile_dir: _mt5_profile.add_charts(profile_dir, specs))
    if not done["ok"]:
        return done
    added = done["value"]
    snapshot = _chart_snapshot(target)
    unseen = [(chart["symbol"].casefold(), chart["period"]) for chart in snapshot["charts"]]
    opened = []
    for chart in added:
        key = (chart["symbol"].casefold(), chart["period"])
        visible = key in unseen
        if visible:
            unseen.remove(key)
        opened.append({"symbol": chart["symbol"], "period": chart["period"], "visible": visible})
    ok = all(item["visible"] for item in opened)
    return {
        "ok": ok,
        "stage": "opened" if ok else "not_visible",
        **_chart_result_base(target, snapshot),
        "opened": opened,
        "count": len(snapshot["charts"]),
        "charts": [_chart_public(chart) for chart in snapshot["charts"]],
        **({} if ok else {"error": "图表文件已写入并重新加载, 但有图表窗口没出现（品种可能不可用）"}),
    }


def _open_trade_charts_tool(args: dict) -> list[TextContent]:
    args = args or {}
    try:
        specs = _chart_open_specs(args.get("charts"))
        target = _chart_target(args)
        if target["running"]:
            return _chart_json(_open_charts_running(
                target, specs, bool(args.get("confirm_reload"))))
        return _chart_json(_open_charts_stopped(target, specs))
    except (ValueError, RuntimeError, OSError) as e:
        return _chart_json({"ok": False, "error": str(e)})


def _chart_close_selectors(raw) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("charts 必填: 至少一项 {id} 或 {symbol, period}")
    selectors = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError(f"charts 每项都要是对象: {item!r}")
        chart_id = str(item.get("id") or "").strip()
        symbol = str(item.get("symbol") or "").strip()
        if not chart_id and not symbol:
            raise ValueError(f"charts 每项都要有 id 或 symbol: {item!r}")
        period = None
        if item.get("period"):
            period = _mt5_profile.normalize_period(item["period"])
            if not period:
                raise ValueError(f"不支持的周期 {item['period']!r}")
        selectors.append({"id": chart_id, "symbol": symbol, "period": period})
    return selectors


def _chart_selected(selector: dict, chart: dict) -> bool:
    if selector["id"]:
        return chart["id"].casefold() == selector["id"].casefold()
    return (chart["symbol"].casefold() == selector["symbol"].casefold()
            and selector["period"] in (None, chart["period"]))


def _close_trade_charts_tool(args: dict) -> list[TextContent]:
    args = args or {}
    try:
        selectors = _chart_close_selectors(args.get("charts"))
        target = _chart_target(args)
        snapshot = _chart_snapshot(target)
        picked, not_found = [], []
        for selector in selectors:
            hits = [chart for chart in snapshot["charts"] if _chart_selected(selector, chart)]
            if not hits:
                not_found.append({k: v for k, v in selector.items() if v})
            picked.extend(chart for chart in hits if chart not in picked)
        include_ea = bool(args.get("include_ea_charts"))
        skipped = [chart for chart in picked if chart["ea_name"] and not include_ea]
        closing = [chart for chart in picked if chart not in skipped]
        failed = []

        if closing and target["running"]:
            if not _mt5_windows.is_enabled(target["main"]):
                return _chart_json({"ok": False,
                                    "error": "MT5 当前有弹窗没关（主窗口被锁住）, 先关掉弹窗再试"})
            posted = []
            for chart in closing:
                try:
                    _mt5_windows.close_chart(chart["_handle"])
                    posted.append(chart)
                except OSError as e:
                    failed.append({**_chart_public(chart), "error": str(e)})

            def still_open():
                handles = {window["handle"] for window in _mt5_windows.chart_windows(target["main"])}
                return [chart for chart in posted if chart["_handle"] in handles]

            _chart_wait(lambda: not still_open(), 5.0, 0.2)
            failed.extend({**_chart_public(chart), "error": "窗口没有关闭"} for chart in still_open())
        elif closing:
            _mt5_profile.remove_charts(snapshot["profile_dir"],
                                       [chart["_file"] for chart in closing])

        failed_ids = {item["id"] for item in failed}
        closed = [chart for chart in closing if chart["id"] not in failed_ids]
        after = _chart_snapshot(target)
    except (ValueError, RuntimeError, OSError) as e:
        return _chart_json({"ok": False, "error": str(e)})

    result = {
        "ok": not (failed or not_found or skipped),
        **_chart_result_base(target, after),
        "closed": [_chart_public(chart) for chart in closed],
        "remaining": len(after["charts"]),
    }
    if skipped:
        result["skipped"] = [_chart_public(chart) for chart in skipped]
        result["skipped_reason"] = ("这些图表上挂着 EA, 关掉 EA 就停了, 所以没动。"
                                    "确认要关就带 include_ea_charts=true 再调一次")
    if not_found:
        result["not_found"] = not_found
    if failed:
        result["failed"] = failed
    return _chart_json(result)


def _symbol_currencies(symbol: str):
    """从交易品种解析相关货币码(用于经济日历按品种筛选)。
    XAUUSDm → {USD}(黄金以美元计价); EURUSD → {EUR, USD}; XAGUSD/Gold → +USD。"""
    s = str(symbol or "").upper()
    out = set()
    for c in _KNOWN_CCY:
        if c in s:
            out.add(c)
    if "XAU" in s or "XAG" in s or "GOLD" in s or "SILVER" in s:
        out.add("USD")
    return out


def _get_economic_calendar_tool(args: dict) -> list[TextContent]:
    """查经济日历(MT5 内 EasyDealCalendar EA 直传到 EasyDeal 服务端的)。
    按 currencies / symbol(自动解析货币) / importance / hours_ahead 筛选。
    1.5.x 历史模式: from_date/to_date/days_back/query 任一在场 → 走服务端
    /v1/calendar/history(去重历史归档表, 含窗口已滑走的过往数据)。"""
    import urllib.request
    import urllib.parse as _up
    base = (os.getenv("EASYDEAL_SERVER_BASE") or "https://easydeal.fay-agent.com").rstrip("/")

    # ---- 历史模式 ----
    if any(args.get(k) for k in ("from_date", "to_date", "days_back", "query")):
        qs = {}
        if args.get("from_date"):
            qs["from"] = str(args["from_date"]).strip()
        elif args.get("days_back"):
            import datetime as _dt
            try:
                d = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8))) - _dt.timedelta(days=int(args["days_back"]))
                qs["from"] = d.strftime("%Y-%m-%d")
            except Exception:
                pass
        if args.get("to_date"):
            qs["to"] = str(args["to_date"]).strip()
        if args.get("query"):
            qs["q"] = str(args["query"]).strip()
        ccy = set(str(c).upper() for c in (args.get("currencies") or []))
        if args.get("symbol"):
            ccy |= _symbol_currencies(args.get("symbol"))
        if ccy:
            qs["currencies"] = ",".join(sorted(ccy))
        if args.get("importance"):
            qs["importance"] = str(args["importance"]).lower()
        qs["limit"] = str(int(args.get("limit") or 200))
        try:
            raw = urllib.request.urlopen(
                base + "/v1/calendar/history?" + _up.urlencode(qs), timeout=15).read()
            data = json.loads(raw)
        except Exception as e:
            return [TextContent(type="text", text=json.dumps(
                {"ok": False, "error": f"拉取经济日历历史失败: {e}"}, ensure_ascii=False))]
        data["note"] = "历史归档模式; time 为北京时间。archive_oldest 之前的数据服务端没有。"
        return [TextContent(type="text", text=json.dumps(data, ensure_ascii=False))]

    # ---- 临近窗口模式(原行为不变) ----
    try:
        raw = urllib.request.urlopen(base + "/v1/calendar", timeout=15).read()
        data = json.loads(raw)
    except Exception as e:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": f"拉取经济日历失败: {e}"}, ensure_ascii=False))]
    events = data.get("events") or []
    ccy = set(str(c).upper() for c in (args.get("currencies") or []))
    if args.get("symbol"):
        ccy |= _symbol_currencies(args.get("symbol"))
    if ccy:
        events = [e for e in events if str(e.get("currency") or "").upper() in ccy]
    imp = str(args.get("importance") or "").lower()
    if imp:
        order = {"low": 1, "moderate": 2, "high": 3}
        thr = order.get(imp, 0)
        events = [e for e in events if order.get(str(e.get("importance") or "").lower(), 0) >= thr]
    ha = args.get("hours_ahead")
    if ha:
        try:
            import time as _t
            now = int(_t.time()); cutoff = now + int(ha) * 3600
            events = [e for e in events if isinstance(e.get("ts"), (int, float)) and (now - 86400) <= e["ts"] <= cutoff]
        except Exception:
            pass
    limit = int(args.get("limit") or 60)
    events = events[:limit]
    return [TextContent(type="text", text=json.dumps({
        "ok": True, "updated_at": data.get("updated_at"), "source": data.get("source"),
        "server": data.get("server"), "tz_offset_sec": data.get("tz_offset_sec"),
        "count": len(events), "events": events,
        "note": "time/ts 是数据源 broker 服务器时区; tz_offset_sec 是它相对 UTC 的偏移(秒)。",
    }, ensure_ascii=False))]


def _resolve_install_dir_for_ea(ea_name: str):
    """1.2.36: 按 EA 绑定的 mt5_instance_id 解析它该挂到哪个 MT5 实例。
    读 <settings_dir>/strategies.json 找 ea_name 对应、且绑了 mt5_instance_id 的
    record(setMt5InstanceForEa 会把同 ea_name 的所有 record 都写成同一个 id),
    再到 settings.json 的 mt5Instances 映射 installDir/dataDir。
    没绑 / 读失败 → 返 None,调用方退回默认实例(EASYDEAL_MT5_INSTALL_DIR),零回归。
    用途: AI 直接调 attach_eas_to_charts(不传 instance_id)时, 也能挂到策略选定的实例,
    不再一律落默认 active 实例(作者实测: 源码新策略首次经 AI 挂载 → 挂到默认 MT5)。"""
    if not _settings_path:
        return None
    stem = str(ea_name or "").replace("\\", "/").split("/")[-1]
    for sfx in (".mq5", ".ex5", ".mqh", ".set"):
        if stem.lower().endswith(sfx):
            stem = stem[:-len(sfx)]
            break
    if not stem:
        return None
    sdir = os.path.dirname(_settings_path)
    inst_id = None
    try:
        with open(os.path.join(sdir, "strategies.json"), "r", encoding="utf-8") as f:
            sj = json.load(f) or {}
        recs = sj.get("records") if isinstance(sj.get("records"), dict) else (sj if isinstance(sj, dict) else {})
        for r in (recs or {}).values():
            if not isinstance(r, dict):
                continue
            if (r.get("ea_name") or "") != stem:
                continue
            if r.get("mt5_instance_id"):
                inst_id = r.get("mt5_instance_id")
                break
    except Exception:
        return None
    if not inst_id:
        return None
    try:
        with open(_settings_path, "r", encoding="utf-8") as f:
            cfg = json.load(f) or {}
        for it in (cfg.get("mt5Instances") or []):
            if it.get("id") == inst_id:
                return {"install_dir": it.get("installDir"),
                        "data_dir": it.get("dataDir") or it.get("installDir")}
    except Exception:
        return None
    return None


# ===================== Tool: attach_eas_to_charts =====================
#
# 挂 EA = 往目标图表的 .chr 里写 <expert> 块 (name/path/expertmode=1/<inputs>)。沙盒实测:
# MT5 加载 profile 时按文件把 EA 挂上并应用 <inputs> (改过的值保留、缺的补默认、不认识的丢掉),
# 退出/切 profile 时原样保存。运行中走 _chart_reload_with 让 MT5 重新加载, 不杀进程。

_EXPERT_LOG_RE = re.compile(
    r"\bexpert\s+(?P<ea>.+?)\s+\((?P<symbol>[^,)]+),(?P<period>[^)]+)\)\s+"
    r"(?P<event>loaded successfully|加载成功|removed|已移除)"
    r"|initializing of (?P<ea2>.+?)\s+\((?P<symbol2>[^,)]+),(?P<period2>[^)]+)\)\s+(?P<fail>failed.*)",
    re.I)


def _chart_log_cursor(target: dict) -> tuple[str, int]:
    """MT5 终端日志 <data_dir>/logs/YYYYMMDD.log 的当前长度, 之后只看新追加的行。"""
    path = os.path.join(target["data_dir"], "logs", datetime.now().strftime("%Y%m%d") + ".log")
    try:
        return path, os.path.getsize(path)
    except OSError:
        return path, 0


def _chart_log_events(cursor: tuple[str, int]) -> list[dict]:
    path, offset = cursor
    try:
        with open(path, "rb") as f:
            f.seek(offset - offset % 2)
            text = f.read().decode("utf-16-le", "ignore")
    except OSError:
        return []
    events = []
    for line in text.splitlines():
        m = _EXPERT_LOG_RE.search(line)
        if not m:
            continue
        failed = bool(m.group("fail"))
        events.append({
            "ea": (m.group("ea2") if failed else m.group("ea")).strip(),
            "symbol": (m.group("symbol2") if failed else m.group("symbol")).strip(),
            "period": _mt5_profile.normalize_period(
                (m.group("period2") if failed else m.group("period")).strip()),
            "event": "failed" if failed else ("loaded" if m.group("event").lower()
                                             in ("loaded successfully", "加载成功") else "removed"),
            "line": line.strip(),
        })
    return events


def _attach_specs(raw) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("assignments 必填: 至少一项 {ea_name, chart_id | symbol}")
    specs = []
    for item in raw:
        if not isinstance(item, dict) or not str(item.get("ea_name") or "").strip():
            raise ValueError(f"assignments 每项都要有 ea_name: {item!r}")
        chart_id = str(item.get("chart_id") or "").strip()
        symbol = str(item.get("symbol") or "").strip()
        if not chart_id and not symbol:
            raise ValueError(f"assignments 每项要给 chart_id 或 symbol: {item!r}")
        period = _mt5_profile.normalize_period(item.get("period") or "H1")
        if not period:
            raise ValueError(f"不支持的周期 {item.get('period')!r}, 可选: {', '.join(_mt5_profile.PERIODS)}")
        inputs = item.get("inputs") or {}
        if not isinstance(inputs, dict):
            raise ValueError(f"inputs 要是对象 {{参数名: 值}}: {inputs!r}")
        specs.append({"ea_name": str(item["ea_name"]).strip().replace("/", "\\"),
                      "chart_id": chart_id, "symbol": symbol, "period": period,
                      "inputs": {str(k).strip(): v for k, v in inputs.items() if str(k).strip()},
                      "replace": bool(item.get("replace"))})
    return specs


def _attach_resolve_ea(target: dict, ea_name: str) -> dict:
    """找到 .ex5, 返回写进 .chr 的 name (裸名) + path (相对 MQL5)。"""
    experts = os.path.join(target["data_dir"], "MQL5", "Experts")
    stem = ea_name[:-4] if ea_name.lower().endswith(".ex5") else ea_name
    candidate = os.path.join(experts, stem + ".ex5")
    if not os.path.isfile(candidate):
        base = os.path.basename(stem).lower() + ".ex5"
        candidate = None
        for root, _dirs, files in os.walk(experts):
            hit = next((f for f in files if f.lower() == base), None)
            if hit:
                candidate = os.path.join(root, hit)
                break
    if not candidate:
        raise ValueError(f"{stem}.ex5 不在 {experts} 下 —— 先 compile_strategy 编译")
    rel = os.path.relpath(candidate, experts).replace("/", "\\")
    return {"name": os.path.splitext(os.path.basename(candidate))[0],
            "path": f"Experts\\{rel}", "ex5": candidate}


def _attach_source_inputs(target: dict, ea: dict) -> list[dict] | None:
    """EA 源码声明的 input 列表; 找不到源码返 None (买来的 .ex5 没源码很正常)。"""
    stem = ea["name"]
    candidates = []
    workspace = os.getenv("EASYDEAL_WORKSPACE_DIR")
    if workspace:
        candidates.append(os.path.join(workspace, "strategies", stem + ".mq5"))
    candidates.append(os.path.splitext(ea["ex5"])[0] + ".mq5")
    for path in candidates:
        if os.path.isfile(path):
            return _parse_ea_input_declarations(path)
    return None


def _attach_check_inputs(target: dict, ea: dict, inputs: dict) -> str | None:
    """有源码就校验参数名 (大小写敏感, MT5 按名匹配), 返回 warning 或 None。"""
    if not inputs:
        return None
    declared = _attach_source_inputs(target, ea)
    if declared is None:
        return f"{ea['name']} 没有源码, 参数名未校验; MT5 会忽略它不认识的参数"
    names = {d["name"] for d in declared}
    unknown = [k for k in inputs if k not in names]
    if unknown:
        raise ValueError(f"{ea['name']} 没有这些输入参数: {', '.join(unknown)}。"
                         f"可用: {', '.join(sorted(names))}")
    return None


def _attach_plan(target: dict, snapshot: dict, specs: list[dict]) -> list[dict]:
    """为每项选定目标图表。不做任何改动; 任何一项解析失败就整批不执行。"""
    charts = snapshot["charts"]
    taken = set()
    plan = []

    def ordinal(chart):
        same = [c for c in charts if (c["symbol"].casefold(), c["period"])
                == (chart["symbol"].casefold(), chart["period"])]
        return same.index(chart)

    for spec in specs:
        ea = _attach_resolve_ea(target, spec["ea_name"])
        warning = _attach_check_inputs(target, ea, spec["inputs"])
        item = {"spec": spec, "ea": ea, "warning": warning}
        if spec["chart_id"]:
            chart = next((c for c in charts if c["id"].casefold() == spec["chart_id"].casefold()), None)
            if not chart:
                raise ValueError(f"图表 {spec['chart_id']} 不存在, 用 list_trade_charts 看当前有哪些")
            if chart["id"] in taken:
                raise ValueError(f"图表 {spec['chart_id']} 在本次请求里被指定了两次")
            current = chart["ea_name"]
            if current and current.casefold() != ea["name"].casefold() and not spec["replace"]:
                raise ValueError(f"图表 {chart['id']} ({chart['symbol']},{chart['period']}) 已挂着 "
                                 f"{current}; 要替换成 {ea['name']} 请传 replace=true")
            action = "update" if current and current.casefold() == ea["name"].casefold() \
                else "replace" if current else "attach"
        else:
            missing = _chart_resolve_symbols(target, [spec])
            if missing:
                raise ValueError(f"当前券商上找不到品种 {missing[0]}")
            same = [c for c in charts if c["id"] not in taken
                    and (c["symbol"].casefold(), c["period"]) == (spec["symbol"].casefold(), spec["period"])]
            chart = (next((c for c in same if (c["ea_name"] or "").casefold() == ea["name"].casefold()), None)
                     or next((c for c in same if not c["ea_name"]), None))
            action = ("update" if chart and chart["ea_name"] else "attach" if chart else "create")
        if chart:
            taken.add(chart["id"])
            item.update(chart=chart, symbol=chart["symbol"], period=chart["period"],
                        ordinal=ordinal(chart))
        else:
            item.update(chart=None, symbol=spec["symbol"], period=spec["period"], ordinal=None)
        item["action"] = action
        plan.append(item)
    return plan


def _attach_apply(profile_dir, plan: list[dict]) -> None:
    """按 plan 改 profile 文件。目标按 (品种, 周期, 序号) 在最新文件里重新定位 ——
    运行中 MT5 刚把 profile 落盘, 文件名可能跟快照时不同。"""
    files = _mt5_profile.list_profile_charts(profile_dir)
    creates = []
    for item in plan:
        ea, spec = item["ea"], item["spec"]
        if item["chart"] is None:
            creates.append({"symbol": item["symbol"], "period": item["period"],
                            "expert": _mt5_profile.expert_block_text(ea["name"], ea["path"], spec["inputs"])})
            continue
        same = [c for c in files if (c["symbol"].casefold(), c["period"])
                == (item["symbol"].casefold(), item["period"])]
        if item["ordinal"] >= len(same):
            raise RuntimeError(f"图表 {item['symbol']},{item['period']} 在 profile 里找不到了")
        chart = same[item["ordinal"]]
        inputs = dict(spec["inputs"])
        if item["action"] == "update":
            inputs = {**chart["ea_inputs"], **inputs}
        item["applied_inputs"] = inputs
        _mt5_profile.write_chart_expert(
            chart["path"], _mt5_profile.expert_block_text(ea["name"], ea["path"], inputs))
    if creates:
        _mt5_profile.add_charts(profile_dir, creates)
    for item in plan:
        item.setdefault("applied_inputs", dict(item["spec"]["inputs"]))


def _attach_arm_algotrading(target: dict) -> dict | None:
    """挂完确保 MT5 工具栏「算法交易」全局开关是开的 (同 post_launch_arm_ea)。"""
    terminal_exe = next((os.path.join(target["install_dir"], c) for c in ("terminal64.exe", "terminal.exe")
                         if os.path.isfile(os.path.join(target["install_dir"], c))), None)
    if not terminal_exe:
        return None
    instances, active_id = _read_mt5_instances_from_settings()
    active_dir = next((it.get("installDir") for it in instances if it.get("id") == active_id), None)
    try:
        return _set_algotrading(terminal_exe, target["install_dir"], want_on=True, use_rebind=bool(instances))
    except Exception as e:
        return {"ok": False, "status": "exception", "error": f"{type(e).__name__}: {e}"}
    finally:
        if active_dir and _mt5_lifecycle.norm_path(active_dir) != _mt5_lifecycle.norm_path(target["install_dir"]):
            try:
                _rebind_mt5(active_dir)
            except Exception:
                pass


def _attach_results(target: dict, plan: list[dict], events: list[dict] | None) -> tuple[list[dict], dict]:
    """执行后对照最新快照 + 日志给每项结论。"""
    snapshot = _chart_snapshot(target)
    unseen = list(snapshot["charts"])
    results = []
    for item in plan:
        ea = item["ea"]
        key = (item["symbol"].casefold(), item["period"], ea["name"].casefold())
        chart = next((c for c in unseen if (c["symbol"].casefold(), c["period"],
                                             (c["ea_name"] or "").casefold()) == key), None)
        if chart:
            unseen.remove(chart)
        result = {"ea_name": ea["name"], "action": item["action"],
                  "chart": _chart_public(chart) if chart else {"symbol": item["symbol"], "period": item["period"]},
                  "inputs": item.get("applied_inputs", {}), "ok": chart is not None}
        if events is not None:
            mine = [e for e in events if e["ea"].casefold() == ea["name"].casefold()
                    and e["symbol"].casefold() == item["symbol"].casefold() and e["period"] == item["period"]]
            failed = next((e for e in reversed(mine) if e["event"] == "failed"), None)
            loaded = any(e["event"] == "loaded" for e in mine)
            result["loaded"] = False if failed else (True if loaded else None)
            if failed:
                result["ok"] = False
                result["error"] = f"EA 初始化失败: {failed['line']}"
            elif not loaded:
                result["log_note"] = "日志里没看到加载记录, 请看 MT5「EA 交易」日志确认"
        if not chart:
            result["error"] = result.get("error") or "重新加载后没在图表上看到这只 EA"
        if item["warning"]:
            result["warning"] = item["warning"]
        results.append(result)
    return results, snapshot


def _attach_finish(target: dict, plan: list[dict], events, stage: str, extra: dict) -> dict:
    results, snapshot = _attach_results(target, plan, events)
    for item, result in zip(plan, results):
        if result["ok"]:
            try:
                _save_mounted_state(target["install_dir"], item["symbol"], item["period"], item["ea"]["name"])
            except Exception as e:
                logging.warning(f"[attach] mounted-state 保存失败: {e}")
    return {
        "ok": all(r["ok"] for r in results),
        "stage": stage,
        **_chart_result_base(target, snapshot),
        "results": results,
        "count": len(snapshot["charts"]),
        "charts": [_chart_public(chart) for chart in snapshot["charts"]],
        **extra,
    }


def _attach_eas_to_charts_tool(args: dict) -> list[TextContent]:
    args = dict(args or {})
    try:
        specs = _attach_specs(args.get("assignments"))
        if not (args.get("instance_id") or args.get("install_dir")):
            # 1.2.36: 没指定实例时按 EA 绑定的实例走, 不一律落默认实例
            bound = {}
            for spec in specs:
                found = _resolve_install_dir_for_ea(spec["ea_name"])
                if found and found.get("install_dir"):
                    bound[_mt5_lifecycle.norm_path(found["install_dir"])] = found
            if len(bound) > 1:
                raise ValueError("这些 EA 绑定在不同的 MT5 实例上, 请传 instance_id 或分开调用")
            if bound:
                found = next(iter(bound.values()))
                args["install_dir"], args["data_dir"] = found["install_dir"], found.get("data_dir")
        target = _chart_target(args)
        snapshot = _chart_snapshot(target)
        if len(snapshot["charts"]) + len(specs) > _CHART_LIMIT:
            raise ValueError(f"MT5 最多同时开 {_CHART_LIMIT} 个图表")
        plan = _attach_plan(target, snapshot, specs)
        summary = [{"ea_name": p["ea"]["name"], "action": p["action"], "symbol": p["symbol"],
                    "period": p["period"], "inputs": p["spec"]["inputs"],
                    **({"chart_id": p["chart"]["id"]} if p["chart"] else {})} for p in plan]

        if not target["running"]:
            profile_dir = snapshot["profile_dir"] or os.path.join(
                target["data_dir"], "MQL5", "Profiles", "Charts", "Default")
            _attach_apply(profile_dir, plan)
            return _chart_json(_attach_finish(target, plan, None, "saved_to_profile", {
                "note": "MT5 没在跑: EA 已写进图表配置, 下次启动该实例时挂上"}))

        pre = _chart_reload_preflight(target)
        if not pre["ok"]:
            return _chart_json(pre)
        if not bool(args.get("confirm_reload")):
            return _chart_json({"ok": False, "stage": "needs_user_confirm", "will_attach": summary,
                                **_chart_reload_impact("挂 EA ")})
        cursor = _chart_log_cursor(target)
        done = _chart_reload_with(target, pre, lambda profile_dir: _attach_apply(profile_dir, plan))
        if not done["ok"]:
            return _chart_json(done)
        time.sleep(2.0)   # EA OnInit 落日志
        events = _chart_log_events(cursor)
        algotrading = _attach_arm_algotrading(target)
        return _chart_json(_attach_finish(target, plan, events, "attached",
                                          {"algotrading": algotrading} if algotrading else {}))
    except (ValueError, RuntimeError, OSError) as e:
        return _chart_json({"ok": False, "error": str(e)})


# ===================== Tool: post_launch_arm_ea (0.3.272) =====================

def _post_launch_arm_ea_tool(args: dict) -> list[TextContent]:
    """0.3.272: Node launchMt5 走 mounted-state restore 路径后调这个工具,
    把算法交易开关 + EA 对话框 auto-confirm 这两步补上.

    Node 端 launchMt5 spawn MT5 后就直接返了, 没机会跑 _ensure_algotrading_on +
    _auto_confirm_ea_dialog 这两步 → 用户实测「EA 挂上了但工具栏算法交易没开」.
    这个工具单独 expose 这两段, Node fire-and-forget 调用.

    args:
      install_dir (str): MT5 install dir
      ea_name     (str, optional): 用来 poll EA 对话框. 没传只跑算法交易那段.
      boot_wait_sec (float, default 3.0): 调用前等多少秒让 MT5 boot 稳定
    """
    install_dir = (args.get("install_dir") or "").strip()
    ea_name     = (args.get("ea_name") or "").strip() or None
    # 0.3.278: boot_wait 3.0 → 5.0. MT5 boot 完 EA load 才弹对话框, 加 2s 缓冲
    # 让对话框先弹再 poll. 也减少 poll 失败概率.
    boot_wait_sec = float(args.get("boot_wait_sec") or 5.0)

    if not install_dir:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "install_dir 必填"}, ensure_ascii=False))]
    if not os.path.isdir(install_dir):
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": f"install_dir 不存在: {install_dir}"}, ensure_ascii=False))]

    terminal_exe = None
    for _cand in ("terminal64.exe", "terminal.exe"):
        _p = os.path.join(install_dir, _cand)
        if os.path.isfile(_p):
            terminal_exe = _p
            break
    if not terminal_exe:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": f"terminal exe 不在 {install_dir}"}, ensure_ascii=False))]

    logging.info(f"[post_launch_arm_ea] 等 {boot_wait_sec}s 让 MT5 boot 稳定")
    time.sleep(boot_wait_sec)

    algotrading = None
    ea_dialog = None
    try:
        algotrading = _ensure_algotrading_on(terminal_exe, install_dir)
    except Exception as e:
        logging.warning(f"[post_launch_arm_ea] algotrading 异常: {e}")
        algotrading = {"ok": False, "status": "exception",
                        "error": f"{type(e).__name__}: {e}"}

    # 0.3.327: .chr detect 逻辑.
    # launchMt5 mounted-state restore 路径**特别重要** — 这是用户点「打开 MT5」
    # 按钮 / EasyDeal 重启时走的路径. 如果用户上次保存了 chart with EA, MT5
    # default profile 自动 restore EA + allow=true, 不需要我们 F7 + auto-confirm.
    ea_dialog = None
    if ea_name:
        if _chart_has_ea(install_dir, ea_name,
                         os.getenv("EASYDEAL_MT5_DATA_DIR", "") or None):
            logging.info(f"[post_launch] .chr 已含 EA {ea_name}, 跳过 F7 + auto-confirm")
            ea_dialog = {
                "ok": True, "status": "chr_already_has_ea",
                "hint": "MT5 default profile 已含此 EA, 自动 restore, 不需要操作"
            }
        else:
            try:
                time.sleep(0.5)
                f7_result = _press_f7_for_ea(install_dir)
                logging.info(f"[post_launch] F7 弹 dialog: {f7_result}")
                if f7_result.get("ok"):
                    ea_dialog = _auto_confirm_ea_dialog(ea_name, timeout_sec=25.0)
                    logging.info(f"[post_launch] _auto_confirm_ea_dialog: {ea_dialog}")
                else:
                    ea_dialog = {"ok": False, "status": "f7_send_failed", **f7_result}
            except Exception as e:
                ea_dialog = {"ok": False, "status": "exception",
                              "error": f"{type(e).__name__}: {e}"}

    return [TextContent(type="text", text=json.dumps({
        "ok": True,
        "stage": "post_launch_armed",
        "install_dir": install_dir,
        "ea_name": ea_name,
        **({"algotrading": algotrading} if algotrading else {}),
        **({"ea_dialog": ea_dialog} if ea_dialog else {}),
    }, ensure_ascii=False))]


# ===================== Tool: get_ea_realtime_stats =====================

def _get_ea_realtime_stats_tool(args: dict) -> list[TextContent]:
    """0.3.49: 实时算每只 EA 的成绩单。Node 侧 magic / symbols / load_at 解析
    完后塞进来；Python 只负责一次 history_deals_get + positions_get + 指标计算。
    把老的「每小时 ticker 写 records → UI 读 records」链路全替掉 —— 实时调一次
    拿到当前真值，不依赖 strategies.json 是否更新到位。
    """
    eas = args.get("eas") or []
    if not isinstance(eas, list) or not eas:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "eas 必填且非空"}, ensure_ascii=False))]
    try:
        lookback_days = max(1, min(365, int(args.get("lookback_days") or 30)))
    except Exception:
        lookback_days = 30

    # MT5 connect（复用同进程已经 initialize 的 mt5；其他工具调过就直接 reuse）
    # 0.3.206: 必须传 path — 不带 path 会让 SDK 随机抓 OS 默认那个 MT5,
    # 用户多 MT5 时会撞错 broker (用户: 选 XM 却读到 Exness 数据).
    try:
        if not mt5.terminal_info():
            _init_kwargs = {}
            _install_dir = os.getenv("EASYDEAL_MT5_INSTALL_DIR")
            if _install_dir:
                for _cand in ("terminal64.exe", "terminal.exe"):
                    _p = os.path.join(_install_dir, _cand)
                    if os.path.isfile(_p):
                        _init_kwargs["path"] = _p
                        break
            # 0.3.205: 防 SDK 自动 launch 用户主动关掉的 MT5
            if _install_dir and not _ezd_terminal_is_running(_install_dir):
                return [TextContent(type="text", text=json.dumps(
                    {"ok": False, "error": "MT5 未运行 — 请先到「MT5」tab 启动您选的 MT5 实例再试"},
                    ensure_ascii=False))]
            ok = _mt5_init(**_init_kwargs)
            if not ok:
                return [TextContent(type="text", text=json.dumps(
                    {"ok": False, "error": f"mt5.initialize 失败: {mt5.last_error()}"},
                    ensure_ascii=False))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": f"mt5 not available: {e}"}, ensure_ascii=False))]

    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    since = now - _dt.timedelta(days=lookback_days)
    deals_raw = mt5.history_deals_get(since, now) or []
    positions_raw = mt5.positions_get() or []
    info = mt5.account_info()
    balance = float(info.balance) if info else 0.0
    equity  = float(info.equity)  if info else 0.0
    today_start_sec = int(_dt.datetime(now.year, now.month, now.day,
                                       tzinfo=_dt.timezone.utc).timestamp())

    # 一次性 mt5 deal → dict（避开 namedtuple 重复 attr 解析）
    deals = []
    for d in deals_raw:
        deals.append({
            "ticket":     d.ticket,
            "magic":      int(d.magic or 0),
            "symbol":     d.symbol or "",
            "volume":     float(d.volume or 0),
            "profit":     float(d.profit or 0),
            "swap":       float(d.swap or 0),
            "commission": float(d.commission or 0),
            "time":       int(d.time or 0),
            "type":       int(d.type or 0),
            "entry":      int(d.entry or 0),   # 0=in, 1=out, 2=inout, 3=out_by
        })
    positions = []
    for p in positions_raw:
        positions.append({
            "ticket": p.ticket,
            "magic":  int(p.magic or 0),
            "symbol": p.symbol or "",
            "volume": float(p.volume or 0),
            "profit": float(p.profit or 0),
            "swap":   float(p.swap or 0),
        })

    fallback_start_sec = int(since.timestamp())

    out_items = []
    for spec in eas:
        if not isinstance(spec, dict):
            continue
        ea_name = (spec.get("ea_name") or "").strip()
        if not ea_name:
            continue
        magic = spec.get("magic")
        if magic is not None:
            try: magic = int(magic)
            except Exception: magic = None
        symbols = spec.get("symbols") or []
        syms_lc = set(str(s).lower() for s in symbols if s)
        load_at_sec = spec.get("load_at_sec")
        try: load_at_sec = int(load_at_sec) if load_at_sec else 0
        except Exception: load_at_sec = 0
        if not load_at_sec:
            load_at_sec = fallback_start_sec

        magic_resolved_by = "input" if magic is not None else None

        # Magic 缺失时：在 lookback 内、属于该 EA symbol 且 magic!=0 的 deals
        # 里挑频次最高的 magic 当兜底（跟 Node 侧 heuristic 同款，避免移植脱节）。
        if magic is None and syms_lc:
            counts = {}
            for d in deals:
                if d["magic"] == 0: continue
                if d["time"] < load_at_sec: continue
                if d["symbol"].lower() not in syms_lc: continue
                counts[d["magic"]] = counts.get(d["magic"], 0) + 1
            if counts:
                magic = max(counts, key=counts.get)
                magic_resolved_by = "heuristic"

        # 没拿到 magic → 用 symbol+time 兜底（仍然有 magic 字段，只是 0；客户端
        # 不该把这种 case 当「magic 不可用」屏蔽掉 — 至少 symbol 内的 magic=0
        # 手动单也能算进去）。但为了避免跨 EA 抢功劳，magic=0 的兜底只在
        # symbols 给定时启用。
        #
        # 0.3.57: 新加 `effective_since_sec` 过滤 —— 解决「4 天 EA 显 193 笔」反常。
        # 老历史：
        #   0.3.55 之前用 load_at_sec（最近挂载时间戳）filter → 升级 / 重挂 EA 后
        #     load_at 跳到「刚才」→ 之前所有交易被过滤掉 → trades=0 而 hours_run 还显
        #     累计天数。作者 5/15 实拍反馈后我在 0.3.56 把这个 filter 拿掉。
        #   0.3.56 改成完全不 filter → 当 EA cumulative 才 4 天但 30 天 lookback 里
        #     有同 magic 的旧版本 EA 留下的成交单时，4 天显 193 笔。又反常。
        # 0.3.57 的解：
        #   客户端用「last_loaded_at - cumulative_hours」估算「首次挂载点」（跨挂载累计
        #   保留），跟 30 天 lookback 取较新者作为 effective_since_sec 传进来。
        #   - 连续运行 EA：跟 load_at_sec 几乎相等，过滤准
        #   - 刚升级重挂的 EA：cumulative 保留 → 能回溯真实首挂时间
        #   - >30 天的老 EA：被 lookback floor cap 到 30 天，跟 hours_run 显示 cap 对齐
        # 兼容老 spec（没传 effective_since_sec）→ 走 0.3.56 的全开行为。
        effective_since_sec = spec.get("effective_since_sec")
        try: effective_since_sec = int(effective_since_sec) if effective_since_sec else 0
        except Exception: effective_since_sec = 0

        my_deals = []
        if magic is not None:
            for d in deals:
                if d["magic"] != magic: continue
                if effective_since_sec and d["time"] < effective_since_sec: continue
                my_deals.append(d)
        elif syms_lc:
            magic_resolved_by = "symbol_only"
            for d in deals:
                if d["symbol"].lower() not in syms_lc: continue
                if effective_since_sec and d["time"] < effective_since_sec: continue
                my_deals.append(d)

        my_deals.sort(key=lambda d: d["time"])

        trades = 0
        pnl = 0.0
        running_pnl = 0.0
        peak_pnl = 0.0
        max_dd_dollar = 0.0
        peak_pnl_at_max_dd = 0.0  # 0.3.341: snapshot peak 在 max_dd 发生瞬间, 当分母用
        today_trades = 0
        today_pnl = 0.0
        last_deal_at = None
        # 0.3.341 (方案 B): entry filter 对齐 server _compute_trades 的 entry in (1,2,3).
        # entry=1 OUT, entry=2 INOUT (reverse), entry=3 OUT_BY — 都算平仓 leg.
        # 之前只 entry==1, INOUT / OUT_BY 漏算 → 跟排行榜 trades 数对不上.
        for d in my_deals:
            realized = d["profit"] + d["swap"] + d["commission"]
            if d["entry"] in (1, 2, 3):    # closing leg (对齐 server)
                trades += 1
            pnl += realized
            running_pnl += realized
            if running_pnl > peak_pnl: peak_pnl = running_pnl
            dd = peak_pnl - running_pnl
            if dd > max_dd_dollar:
                max_dd_dollar = dd
                peak_pnl_at_max_dd = peak_pnl  # lock peak at this moment
            if d["time"] >= today_start_sec:
                if d["entry"] in (1, 2, 3):
                    today_trades += 1
                today_pnl += realized
            last_deal_at = d["time"]

        my_positions = []
        if magic is not None:
            for p in positions:
                if p["magic"] != magic: continue
                if syms_lc and p["symbol"].lower() not in syms_lc:
                    continue
                my_positions.append(p)
        elif syms_lc:
            for p in positions:
                if p["symbol"].lower() in syms_lc:
                    my_positions.append(p)
        open_count = len(my_positions)
        open_profit = sum(p["profit"] + p["swap"] for p in my_positions)

        # 0.3.341 (方案 B): 算法对齐 server metric.py:_compute_drawdown (0.5.57+).
        #
        # 1. pnl_pct 分母改用 bal_anchor_est = balance - pnl (反推 anchor 时刻 balance),
        #    跟 server 的 bal_anchor (anchor_ts 时刻或之前最近一条 balance row) 同语义.
        #    之前 client 用当前 balance 当分母 (line 10148 旧实现) 跟 server 飘.
        #    估算精度: 假设窗口内无非交易余额调整 (出入金 / charge); 一般 EA 短期 use case
        #    准确. 有出入金时差距出现但跟 server 同样按 deals 累加, 飘的方向一致.
        #
        # 2. max_dd_pct 分母改用「dd 发生瞬间」的 peak_balance snapshot, 不再被后续创新高
        #    稀释. 跟 server 0.5.57 fix 同款语义. 之前 client 用当前 balance 当分母会让
        #    回撤百分比每秒都飘 (balance 随 open position floating PnL 变).
        bal_anchor_est = balance - pnl  # 反推 anchor 时刻 balance
        peak_balance_at_max_dd = bal_anchor_est + peak_pnl_at_max_dd
        pnl_pct    = (pnl / bal_anchor_est) if bal_anchor_est > 0 else 0.0
        max_dd_pct = (max_dd_dollar / peak_balance_at_max_dd) if peak_balance_at_max_dd > 0 else 0.0

        out_items.append({
            "ea_name":            ea_name,
            "magic":              magic,
            "magic_resolved_by":  magic_resolved_by,    # input / heuristic / symbol_only / None
            "trades":             trades,
            "pnl":                round(pnl, 2),
            "pnl_pct":            round(pnl_pct, 6),
            "max_drawdown_dollar": round(max_dd_dollar, 2),
            "max_drawdown_pct":   round(max_dd_pct, 6),         # decimal fraction (0.297 = 29.7%)
            # 0.3.54: AI 友好版 — 直接百分比（29.7 表示 29.7%），不要 × 100。
            "max_drawdown_percent": round(max_dd_pct * 100, 2),
            "today_trades":       today_trades,
            "today_pnl":          round(today_pnl, 2),
            "open_positions":     open_count,
            "open_profit":        round(open_profit, 2),
            "last_deal_at":       last_deal_at,
            "load_at_sec":        load_at_sec,
            "effective_since_sec": effective_since_sec or None,    # 0.3.57: 让 UI / 诊断知道用的过滤起点
        })

    return [TextContent(type="text", text=json.dumps({
        "ok":            True,
        "ts":            int(now.timestamp()),
        "lookback_days": lookback_days,
        "account": {
            "balance":  balance,
            "equity":   equity,
            "currency": info.currency if info else None,
        } if info else None,
        "total_deals_in_lookback":     len(deals),
        "total_positions_open":        len(positions),
        "items":         out_items,
    }, ensure_ascii=False, indent=2))]


_PANIC_FLAG_DEFAULT_TTL_MS = 60 * 60 * 1000

def _panic_flag_path() -> str | None:
    workspace = os.getenv("EASYDEAL_WORKSPACE_DIR")
    if not workspace:
        return None
    return os.path.join(workspace, ".easy-deal", "panic.flag")

def _panic_flag_active() -> tuple[bool, dict]:
    p = _panic_flag_path()
    if not p or not os.path.isfile(p):
        return False, {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            j = json.load(f)
    except Exception:
        # 文件损坏 → 当过期处理 + 删掉
        try: os.unlink(p)
        except Exception: pass
        return False, {}
    ts = j.get("ts") or 0
    ttl = j.get("ttl_ms") or _PANIC_FLAG_DEFAULT_TTL_MS
    age = int(time.time() * 1000) - ts
    if age > ttl:
        try: os.unlink(p)
        except Exception: pass
        return False, {}
    return True, {
        "elapsed_ms": age,
        "remaining_ms": ttl - age,
        "reason": j.get("reason") or "panic_stop_all",
    }

def _panic_flag_set(reason: str = "panic_stop_all",
                    ttl_ms: int = _PANIC_FLAG_DEFAULT_TTL_MS) -> bool:
    p = _panic_flag_path()
    if not p:
        return False
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"ts": int(time.time() * 1000),
                       "ttl_ms": ttl_ms,
                       "reason": reason}, f)
        return True
    except Exception as exc:
        logging.warning("[panic] set flag failed: %s", exc)
        return False


def _panic_stop_all_tool(args: dict) -> list[TextContent]:
    reason = args.get("reason") or "user_requested"
    flag_ok = _panic_flag_set(reason=reason, ttl_ms=30_000)
    try:
        from wind_backtests import history, history_path
    except ImportError:
        # Community edition ships without the backtest engine: there are no
        # backtests to cancel, only the panic flag and scheduler cleanup.
        history = None
        history_path = None
    summary = {**(history("cancel-all") if history else {}), "crons_deleted": 0, "errors": []}


    # 2. 删 scheduler.db 里「回测进度」auto-poll cron, 不删用户主动建的 cron
    # 0.3.162: 跟 client 0.3.152 panic-stop-all 行为对齐 — 用户反馈「用户创建的定时任务
    # 不应该被 panic 删」(那是用户工作流: 每小时巡检 / 盯盘 / 自定义提醒).
    # scheduler-poll ticker 全停时, 用户 t_* 任务即使留着也不会被触发; 用户「解除全停」
    # 后自动恢复. auto-poll cron (跟 in-flight backtest 关联) 已经 cancel 不再需要.
    db_path = os.getenv("EASYDEAL_SCHEDULER_DB") or (str(history_path().with_name("scheduler.db")) if history_path else "")
    if db_path and os.path.isfile(db_path):
        try:
            import sqlite3 as _sql
            with _sql.connect(db_path, timeout=5) as conn:
                ids = [(tid,) for tid, name in conn.execute("SELECT id, name FROM tasks WHERE name LIKE '回测进度 %'")
                       if re.fullmatch(r"回测进度 .+ bt_[A-Za-z0-9]+", name)]
                conn.executemany("DELETE FROM tasks WHERE id = ?", ids)
                summary["crons_deleted"] = len(ids)
        except Exception as e:
            summary["errors"].append(f"scheduler.db: {e}")


    return [TextContent(type="text", text=json.dumps({
        "ok": True,
        "data": {
            **summary,
            "panic_flag_active_for_ms": 30 * 1000 if flag_ok else 0,
            "instruction": (
                "已停掉所有 running/queued 回测 + 它们的 auto-poll cron。"
                "用户主动建的 cron (巡检 / 盯盘 / 自定义提醒等) 保留不动 — scheduler 全停期间不触发, 解除后自动恢复。"
                "30 秒内 run_backtest 被拒 (防你立刻自己重启)。"
                "**你接下来不要再调任何工具**, 只把 summary 转告用户即可。"
                "用户明确说要重新跑再调 (30 秒后 flag 自然过期)。"
            ),
        },
    }, ensure_ascii=False))]


def _check_backtest_admission():
    active, info = _panic_flag_active()
    if active:
        raise ValueError(f"全停冷却中，还剩 {info['remaining_ms'] // 1000} 秒")


def _offline_backtest_tool(name, args):
    if name == "panic_stop_all":
        return _panic_stop_all_tool(args)
    try:
        from wind_backtests import history, submit
    except ImportError:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "社区版暂不提供回测（风洞引擎未随社区版发布）"}, ensure_ascii=False))]
    try:
        if name == "run_backtest":
            data = submit(args, check_admission=_check_backtest_admission)
        elif name == "list_backtests":
            data = history("list", args)
        else:
            action = "cancel" if name == "cancel_backtest" else "status"
            data = history(action, args["backtest_id"])
        result = {"ok": True, "data": data}
        if name == "run_backtest" and data["status"] in {"error", "config_error"}:
            result.update(ok=False, error=data["error"])
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]


# ============== Main ==============

async def run_mcp_server():
    """Run MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )


async def main():
    """Entry point."""
    logging.info("=" * 50)
    logging.info("EasyDeal MCP Server started")
    logging.info("Waiting for MCP connection...")
    logging.info("=" * 50)
    try:
        await run_mcp_server()
    except KeyboardInterrupt:
        logging.info("Interrupted; shutting down")
    finally:
        if strategy_instance:
            strategy_instance.running = False
        mt5.shutdown()
        logging.info("MCP Server stopped")


if __name__ == "__main__":
    asyncio.run(main())
