"""
EasyDeal MCP Server - 交易监控MCP服务器（统一入口）
整合了监控服务、MCP协议接口及告警通知
"""

import asyncio
import json
import logging
import logging.handlers
import os
import re

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


def _ts_to_bj_str(ts, fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    """把 unix 时间戳（秒，int 或 float）格式化成北京时间字符串。
    None / 0 / 不可解析 → 空字符串。"""
    if ts is None:
        return ""
    try:
        if isinstance(ts, (int, float)):
            return datetime.fromtimestamp(int(ts), tz=BJ_TZ).strftime(fmt)
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
        self.magic_numbers = [999]
        self.magic_number = self.magic_numbers[0]
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
        if not mt5.initialize(**init_kwargs):
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
                    if not mt5.initialize(**init_kwargs):
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

        if errors:
            return False, "; ".join(errors)
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

    def is_tracked_position(self, pos) -> bool:
        if self.symbols and pos.symbol not in self.symbols:
            return False
        if self.magic_numbers:
            if pos.magic not in self.magic_numbers:
                return False
        comment = (pos.comment or "").lower()
        if self.comment_contains:
            if not any(token.lower() in comment for token in self.comment_contains):
                return False
        if self.comment_excludes:
            if any(token.lower() in comment for token in self.comment_excludes):
                return False
        return True

    def is_tracked_deal(self, deal) -> bool:
        if self.symbols and deal.symbol not in self.symbols:
            return False
        if self.magic_numbers:
            if deal.magic not in self.magic_numbers:
                return False
        comment = (deal.comment or "").lower()
        if self.comment_contains:
            if not any(token.lower() in comment for token in self.comment_contains):
                return False
        if self.comment_excludes:
            if any(token.lower() in comment for token in self.comment_excludes):
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
        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info is None:
            return {"error": "无法获取行情数据"}

        # 获取账户和终端信息
        account_info = mt5.account_info()
        terminal_info = mt5.terminal_info()
        
        positions = self.refresh_position_state()
        buy_orders = []
        sell_orders = []

        if positions:
            for pos in positions:
                order_info = {
                    "ticket": pos.ticket,
                    "volume": pos.volume,
                    "price_open": pos.price_open,
                    "price_current": pos.price_current,
                    "profit": pos.profit,
                    "comment": pos.comment,
                    "time": pos.time,
                    "sl": pos.sl,
                    "tp": pos.tp
                }
                if pos.type == mt5.ORDER_TYPE_BUY:
                    buy_orders.append(order_info)
                else:
                    sell_orders.append(order_info)

        buy_volume = sum(order["volume"] for order in buy_orders)
        sell_volume = sum(order["volume"] for order in sell_orders)
        total_profit = sum(pos.profit for pos in positions) if positions else 0

        status = {
            "account": {
                "balance": account_info.balance if account_info else 0,
                "equity": account_info.equity if account_info else 0,
                "margin_level": account_info.margin_level if account_info else 0,
                "currency": account_info.currency if account_info else "USD"
            },
            "terminal": {
                "connected": terminal_info.connected if terminal_info else False,
                # ping_last 来自 MT5 Python API，单位是微秒；统一转成毫秒以匹配 MT5 界面显示
                "ping": int(terminal_info.ping_last / 1000) if terminal_info else -1,
                "trade_allowed": terminal_info.trade_allowed if terminal_info else False
            },
            "market_data": {
                "symbol": self.symbol,
                "bid": symbol_info.bid,
                "ask": symbol_info.ask,
                "spread": symbol_info.spread,
                "time": _now_bj_str()
            },
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
                "total_profit": total_profit
            }
        }

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

    def get_profit_history(self, start_time=None, end_time=None):
        """获取指定时间段的收益历史"""
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

            deals = mt5.history_deals_get(start_dt, end_dt)

            if deals is None:
                error = mt5.last_error()
                return {"error": f"无法获取历史成交: {error}"}

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
            for deal in entries:
                t = deal.time
                if isinstance(t, int):
                    t = datetime.fromtimestamp(t)
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
    try:
        mt5.shutdown()
    except Exception:
        pass
    if not mt5.initialize(**init_kwargs):
        logging.error(f"[settings reload] mt5.initialize 失败 path={init_kwargs['path']} err={mt5.last_error()}")
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
            if not mt5.initialize(**init_kwargs):
                logging.error(f"[settings reload] retry init 失败：{mt5.last_error()}")
                return False
    logging.warning(
        f"[settings reload] 6 次重试后仍未绑到 {new_install_dir}（actual={actual}），"
        "保持 SDK 当前连接 —— 后续 symbol_info 失败时再让 Claude 引导处理"
    )
    return False


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


def _get_strategy_file_path() -> str:
    """Return the absolute path to the EA .mq5 strategy file.

    Resolution order:
    1. EA_FILE_PATH env var (full path to .mq5 file)
    2. Auto-detect from MT5 chart profile (.chr) to find which EA is loaded,
       then locate its .mq5 source in MQL5/Experts/
    3. EA_FILENAME env var (legacy default _DEFAULT_EA_FILENAME) in MQL5/Experts/
    4. Fallback to project directory
    """
    global _cached_ea_filename

    # 1. Explicit env override
    env_path = os.getenv("EA_FILE_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path

    try:
        info = mt5.terminal_info()
        data_path = info.data_path if info else None
    except Exception:
        data_path = None

    # 2. Auto-detect EA name from chart profiles (cached)
    if _cached_ea_filename is None:
        detected = _detect_ea_from_charts()
        if detected:
            _cached_ea_filename = detected

    # Determine filename to search for
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


def _load_params_from_runtime_json(ea_name: str = None) -> dict | None:
    """Read EA-dumped runtime parameters from MQL5/Files/<EA>_runtime.json.

    The EA's OnInit writes this file, so it always reflects the true current
    input values (unlike .chr which MT5 only flushes on save/close).
    Returns {param_name: value_as_string} or None if file missing/invalid.
    """
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


def _get_config_set_path(ea_name: str = None) -> str | None:
    """Return path to MQL5/Files/<EA>_config.set (MCP-written runtime overrides)."""
    if ea_name is None:
        ea_name = _resolve_ea_filename()
    ea_base = os.path.splitext(ea_name)[0]
    data_path = _get_mt5_data_path()
    if not data_path:
        return None
    return os.path.join(data_path, "MQL5", "Files", f"{ea_base}_config.set")


def _load_params_from_config_set(ea_name: str = None) -> dict | None:
    """Parse <EA>_config.set. Returns {param_name: value_str} or None."""
    path = _get_config_set_path(ea_name)
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
            description="获取 MCP 监控服务自身的日志（含持仓变动、告警、风控事件等）。从 logs/easydeal.log 读取。",
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
            description="获取 MT5 终端日志（连接状态、订单执行回报等）。从 MT5 数据目录 Logs/ 读取，倒序分页（page=1 最新）。",
            inputSchema={
                "type": "object",
                "properties": {
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
            description="获取 EA 策略的 Print() 输出日志（交易决策、开平仓、马丁触发等）。从 MT5 数据目录 MQL5/Logs/ 读取，倒序分页（page=1 最新）。",
            inputSchema={
                "type": "object",
                "properties": {
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
            description="查看当前盘面情况：账户余额/净值、持仓订单明细、市场行情快照（价格/点差）、策略状态。用于回答『盘面怎么样』『持仓情况』『账户状态』等问题。",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_market_info",
            description="获取当前交易品种的实时行情数据：买卖价、点差、涨跌幅、波动率等。用于回答『行情如何』『价格多少』『市场波动』等问题。",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_klines",
            description=(
                "获取 K 线 OHLC 数据。支持多种时图（M1/M5/M15/M30/H1/H4/D1/W1/MN1）和任意条数。"
                "默认从最近已收盘那根向前取。用于波动率分析、回放行情、判断趋势强弱等。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
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
            description="Get profit history and summary for a time window.",
            inputSchema={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "Lookback days", "default": 30},
                    "start_time": {"type": "string", "description": "YYYY-MM-DD HH:MM:SS"},
                    "end_time": {"type": "string", "description": "YYYY-MM-DD HH:MM:SS"}
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
            description="获取 EA 所有 input 参数的完整视图：同时返回 runtime_json (EA OnInit/OnTimer 写入, 最准)、config_set (MCP 热更新覆盖) 与源码默认值，并标注当前生效值(effective_value)。参数读不准时首选此工具。",
            inputSchema={"type": "object", "properties": {}, "required": []}
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
            name="run_backtest",
            description=(
                "在 MT5 Strategy Tester 里跑一个 EA 的回测。非阻塞：立即返回 backtest_id，"
                "实际回测可能耗时 1-30 分钟（取决于品种、周期、日期范围、历史数据是否本地）。"
                "调用后用 get_backtest_status 轮询进度，结束时拿到指标。"
                "前置条件：EA 必须已经编译（.ex5 在 MQL5/Experts/）；MT5 终端可以正在运行（会单独 spawn 一个测试实例）。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ea_name":   {"type": "string", "description": "EA 名（不带 .ex5），需在 MQL5/Experts/ 已编译"},
                    "symbol":    {"type": "string", "description": "品种，如 XAUUSD / EURUSD"},
                    "period":    {"type": "string", "enum": ["M1","M5","M15","M30","H1","H4","D1","W1"], "description": "周期"},
                    "from_date": {"type": "string", "description": "起始日期 YYYY-MM-DD"},
                    "to_date":   {"type": "string", "description": "结束日期 YYYY-MM-DD"},
                    "deposit":   {"type": "number", "default": 10000, "description": "初始资金（默认 10000）"},
                    "leverage":  {"type": "integer", "default": 100, "description": "杠杆（默认 100）"},
                    "currency":  {"type": "string", "default": "USD", "description": "账户货币"},
                    "input_overrides": {
                        "type": "object",
                        "description": "覆盖 EA 的 input 参数（可选）。键为 input 名，值为字符串/数字/bool。",
                    },
                },
                "required": ["ea_name", "symbol", "period", "from_date", "to_date"],
            },
        ),
        Tool(
            name="get_backtest_status",
            description=(
                "查询 run_backtest 启动的回测进度。"
                "running 时返回 elapsed_seconds；ok 时返回 metrics（净利、夏普、最大回撤、交易数等）；"
                "error / finished_no_report 时返回错误说明。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "backtest_id": {"type": "string", "description": "run_backtest 返回的 id"},
                },
                "required": ["backtest_id"],
            },
        ),
        Tool(
            name="list_backtests",
            description=(
                "列出回测记录（最近优先），含状态、EA 名、品种、净利润 / 夏普 / 交易数 / 最大回撤。"
                "默认返回最近 20 条；可传 limit (1-100) 控制数量；传 ea 过滤指定 EA。"
                "记录从 backtests.json 持久化文件加载，跨 MCP 进程重启可见。"
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
    ] + _trading_write_tools() + [   # 内部按 _is_trading_write_enabled / _is_trading_write_open_enabled 各自决定
        # 始终可见的诊断工具 — 用户在 chat 里说「调用 easydeal_debug_env」
        # 就能看到当前 MCP 进程里 EASYDEAL_TRADING_WRITE / EASYDEAL_TRADING_WRITE_OPEN
        # 等关键 env，用来定位「我开了开关但 Claude 还说没工具」之类的问题。
        Tool(
            name="easydeal_debug_env",
            description=(
                "诊断工具：返回当前 easydeal MCP 进程看到的关键环境变量 + 是否暴露 平仓/改单/开仓 工具。"
                "用户反馈「开了平仓/开仓权限但 Claude 看不到工具」时调用此工具，"
                "如果返回 trading_write_enabled / trading_write_open_enabled =false 说明 .mcp.json 没正确注入 env，"
                "= true 但工具仍不可见说明问题在 Claude / MCP 端。"
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
    ]


def _is_trading_write_enabled() -> bool:
    """读环境变量决定是否暴露「平仓 / 改单」类工具（不含开仓）。
    客户端「设置 → 高级 → 允许 AI 直接平仓 / 改单」勾上时会注入
    EASYDEAL_TRADING_WRITE=1。默认关闭以防 LLM 在用户没明确授权时动实盘。
    跟 _is_trading_write_open_enabled 拆开 —— 开仓权限独立 toggle。"""
    return os.getenv("EASYDEAL_TRADING_WRITE", "").strip() in ("1", "true", "yes", "on")


def _is_trading_write_open_enabled() -> bool:
    """单独控 open_position 工具的暴露。开仓比平/改激进得多
    （凭空建仓的风险敞口完全不可控），用户经常想给 AI 平改权限但不给开仓权限。
    EASYDEAL_TRADING_WRITE_OPEN=1 才暴露 open_position。"""
    return os.getenv("EASYDEAL_TRADING_WRITE_OPEN", "").strip() in ("1", "true", "yes", "on")


def _debug_env_tool() -> list[TextContent]:
    """easydeal_debug_env 实现 — 把当前进程的几个 EASYDEAL_* env 摊开给 Claude。"""
    keys = [
        "EASYDEAL_TRADING_WRITE", "EASYDEAL_TRADING_WRITE_OPEN",
        "EASYDEAL_WORKSPACE_DIR",
        "EASYDEAL_MT5_INSTALL_DIR", "EASYDEAL_MT5_DATA_DIR",
        "EASYDEAL_BACKTESTS_FILE", "EASYDEAL_SCHEDULER_DB",
        "EASYDEAL_BACKTEST_LOGIN", "EASYDEAL_BACKTEST_SERVER",
        "EASYDEAL_BACKTEST_INSTALL_DIR", "EASYDEAL_BACKTEST_PORTABLE",
    ]
    env_view = {k: os.getenv(k, "") for k in keys}
    # 把 LOGIN 这种敏感字段做个 mask
    if env_view.get("EASYDEAL_BACKTEST_LOGIN"):
        v = env_view["EASYDEAL_BACKTEST_LOGIN"]
        env_view["EASYDEAL_BACKTEST_LOGIN"] = f"{v[:3]}***{v[-2:]}" if len(v) > 5 else "***"
    return [TextContent(type="text", text=json.dumps({
        "trading_write_enabled":      _is_trading_write_enabled(),
        "trading_write_open_enabled": _is_trading_write_open_enabled(),
        "env":                        env_view,
        "tools_visible_count":        len([1 for _ in _trading_write_tools()]) + 1,  # +1 = self
        "hint": (
            "如果 trading_write_enabled / trading_write_open_enabled = false 但客户端开关已开 — "
            "1) 检查 .mcp.json 里 mcpServers.easydeal.env 是否有 "
            "    EASYDEAL_TRADING_WRITE=\"1\" / EASYDEAL_TRADING_WRITE_OPEN=\"1\" "
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


# MT5 retcode 常见值 → 中文友好提示。用户实测反馈：「连续调用 modify_position
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

    # 每次入口先 ping SDK 连接，挂了立刻 re-init 一次
    try:
        ti = mt5.terminal_info()
        if not (ti and getattr(ti, "connected", False)):
            mt5.initialize()
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

    # stops_level 距离 + 价方向 预检验。AI 算出来的 SL/TP 经常离当前价太近，
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

    # 失败时给 AI 明确诊断，AI 下次重试就能调整参数
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
    用户必须在「设置 → 高级」显式开启「允许 AI 直接开仓」(EASYDEAL_TRADING_WRITE_OPEN=1)
    才会暴露该工具 —— 跟平/改是两个独立开关。"""
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
    try:
        volume = float(raw_vol)
    except (TypeError, ValueError):
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"invalid volume: {raw_vol!r}",
        }, ensure_ascii=False))]
    if volume <= 0:
        return [TextContent(type="text", text=json.dumps({
            "ok": False, "error": f"volume 必须 > 0，收到 {volume}",
        }, ensure_ascii=False))]

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
    # AI 没传 magic 时自动生成一个稳定 magic，让后续 deal 能归属回来。
    # 用 time.time()*1000 取 31bit 范围内（MT5 magic 是 ulong 但 signed 32bit 安全）。
    if magic == 0:
        magic = int(time.time() * 1000) & 0x7FFFFFFF

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
    retcode = getattr(result, "retcode", None)
    explained = _retcode_explain(retcode) if not ok else None

    return [TextContent(type="text", text=json.dumps({
        "ok":              ok,
        "symbol":          symbol,
        "side":            side,
        "volume":          volume,
        "price":           price,
        "sl":              sl,
        "tp":              tp,
        "magic":           magic,
        "ticket":          getattr(result, "order", None) if ok else None,
        "deal":            getattr(result, "deal", None),
        "retcode":         retcode,
        "retcode_explain": explained,
        "comment":         getattr(result, "comment", None),
        "message":         None if ok else f"order_send 失败 — {explained}",
    }, ensure_ascii=False, indent=2))]


def _trading_write_tools() -> list[Tool]:
    """拆成两个独立权限 ——
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
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ticket": {
                        "type": "integer",
                        "description": "要平的具体单号（来自 get_trading_status 的 orders）；不传 = 平掉该 EA 的全部持仓",
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
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ticket": {"type": "integer", "description": "持仓单号"},
                    "sl": {"type": "number", "description": "新止损价；0 = 清除止损"},
                    "tp": {"type": "number", "description": "新止盈价；0 = 清除止盈"},
                },
                "required": ["ticket"],
            },
        ))
    if _is_trading_write_open_enabled():
        tools.append(Tool(
            name="open_position",
            description=(
                "⚠⚠ 实盘动作：市价开仓（凭空建仓，最高风险）。**独立**的授权开关 ——"
                "用户必须在「设置 → 高级」里勾上「允许 AI 直接开仓」（跟平/改是两个开关）才会暴露。"
                "返回新单 ticket + 实际成交价；失败时 error 字段说明原因（symbol 不可用 / "
                "volume 越界 / 行情未开 / broker 拒单等）。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "symbol":    {"type": "string",  "description": "品种代码，跟当前 broker 一致（XAUUSD / XAUUSDm / ...）"},
                    "side":      {"type": "string",  "enum": ["buy", "sell"], "description": "方向"},
                    "volume":    {"type": "number",  "description": "手数；会自动 round 到 broker 允许的 volume_step 倍数"},
                    "sl":        {"type": "number",  "description": "止损价（绝对价位）；不传 / 传 0 = 不设止损"},
                    "tp":        {"type": "number",  "description": "止盈价（绝对价位）；不传 / 传 0 = 不设止盈"},
                    "magic":     {"type": "integer", "description": "magic number；不传 = 0（AI 自动生成稳定 magic）"},
                    "comment":   {"type": "string",  "description": "订单备注（MT5 限制 31 字符）；不传 = 'Open (AI)'"},
                    "deviation": {"type": "integer", "description": "允许滑点（点）；不传 = 20"},
                },
                "required": ["symbol", "side", "volume"],
            },
        ))
    return tools


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Execute tool calls."""
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
            data_path = _get_mt5_data_path()
            if not data_path:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "MT5 terminal not connected, cannot locate log directory"}, ensure_ascii=False))]
            mt5_log_dir = os.path.join(data_path, "Logs")
            result = _read_mt5_log(mt5_log_dir, date_str, keyword=keyword, page_size=page_size, page=page)
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "get_ea_logs":
            date_str = arguments.get("date") or _bj_date_str()
            keyword = arguments.get("keyword")
            page = int(arguments.get("page", 1))
            page_size = int(arguments.get("page_size", 50))
            data_path = _get_mt5_data_path()
            if not data_path:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "MT5 terminal not connected, cannot locate log directory"}, ensure_ascii=False))]
            ea_log_dir = os.path.join(data_path, "MQL5", "Logs")
            result = _read_mt5_log(ea_log_dir, date_str, keyword=keyword, page_size=page_size, page=page)
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        if name == "get_trading_status":
            status = strategy.get_status()
            return [TextContent(type="text", text=json.dumps(status, ensure_ascii=False, indent=2))]

        if name == "get_market_info":
            symbol_info = mt5.symbol_info(strategy.symbol)
            if symbol_info is None:
                return [TextContent(type="text", text=json.dumps({"error": "market info unavailable"}, ensure_ascii=False))]
            market_info = {
                "symbol": strategy.symbol,
                "bid": symbol_info.bid,
                "ask": symbol_info.ask,
                "spread": symbol_info.spread,
                "time": _now_bj_str()
            }
            return [TextContent(type="text", text=json.dumps(market_info, ensure_ascii=False, indent=2))]

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
            rates = mt5.copy_rates_from_pos(strategy.symbol, tf_map[tf_str], start_pos, count)
            if rates is None or len(rates) == 0:
                return [TextContent(type="text", text=json.dumps(
                    {"error": "no kline data", "symbol": strategy.symbol, "timeframe": tf_str},
                    ensure_ascii=False))]
            bars = []
            for r in rates:
                bars.append({
                    "time": datetime.fromtimestamp(int(r["time"])).strftime("%Y-%m-%d %H:%M:%S"),
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "tick_volume": int(r["tick_volume"]),
                    "spread": int(r["spread"]),
                    "real_volume": int(r["real_volume"]),
                })
            result = {
                "symbol": strategy.symbol,
                "timeframe": tf_str,
                "count": len(bars),
                "include_current": include_current,
                "bars": bars,
            }
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

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
            result = strategy.get_profit_history(start_time=start_time, end_time=end_time)
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        # ---------- Strategy script improvement tools ----------

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
            filepath = _get_strategy_file_path()
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
            source_params = _parse_input_params(content)

            runtime_params = _load_params_from_runtime_json() or {}
            config_params = _load_params_from_config_set() or {}

            merged = []
            for p in source_params:
                pname = p["name"]
                source_val = p["value"]
                runtime_val = runtime_params.get(pname)
                config_val = config_params.get(pname)

                if runtime_val is not None:
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
                "config_set_file": _get_config_set_path(),
                "config_set_overrides": len(config_params),
                "params": merged,
                "note": (
                    "effective_value 优先级: runtime_json (EA 实际运行值, 最准) > config_set (MCP 写入的热更新覆盖) > source_default。"
                    "用 update_strategy_param 写入 config_set 即可热更新，EA 3 秒内会自动应用。"
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
            data_path_for_ea = _get_mt5_data_path()
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
                if not src_mq5:
                    return [TextContent(type="text", text=json.dumps(
                        {"error": f"未找到 {ea_basename}",
                         "looked_in": src_candidates}, ensure_ascii=False))]
                # Ensure the file is at the canonical MT5/Experts location
                if data_path_for_ea:
                    target_dir = os.path.join(data_path_for_ea, "MQL5", "Experts")
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

            # Pick a writable log location. Prefer MT5 data_path/MQL5/Logs
            # (MetaEditor writes its own logs there, so permission is guaranteed);
            # fall back to system temp.
            data_path = _get_mt5_data_path()
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
            if data_path:
                include_path = os.path.join(data_path, "MQL5")
                include_part = f' /include:"{include_path}"'
            cmd_str = (
                f'"{metaeditor}"'
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
            }
            if not success:
                hints = []
                if preexisting_instances > 0:
                    hints.append(
                        f"检测到 {preexisting_instances} 个 MetaEditor64.exe 已在运行——这是最常见的静默失败原因。"
                        "MT5 的 MetaEditor 是单实例应用，新的 CLI 调用会通过 IPC 转发给已存在的实例然后立即退出返回 0，"
                        "真正的编译要么被老实例排队处理要么被忽略。请关闭所有 MetaEditor 窗口后重试。"
                    )
                if preexisting_instances == 0 and not ex5_rebuilt:
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

        if name == "run_backtest":
            return _run_backtest_tool(arguments)

        if name == "get_backtest_status":
            return _get_backtest_status_tool(arguments)

        if name == "list_backtests":
            return _list_backtests_tool(arguments)

        if name == "easydeal_debug_env":
            return _debug_env_tool()

        # ---- Trading-write tools (gated) ----
        # close/modify 跟 open 拆成两个独立 gate ——
        # EASYDEAL_TRADING_WRITE 只控 close + modify；
        # EASYDEAL_TRADING_WRITE_OPEN 单独控 open_position（凭空建仓的风险敞口完全不可控）。
        if name in ("close_position", "modify_position"):
            if not _is_trading_write_enabled():
                return [TextContent(type="text", text=json.dumps({
                    "error": "trading_write_disabled",
                    "message": (
                        "用户没在客户端「设置 → 高级」里开启「允许 AI 直接平仓 / 改单」。"
                        "请先告知用户去开启此权限再重试。"
                    ),
                }, ensure_ascii=False))]
            if name == "close_position":
                return _trading_close_position(strategy, arguments)
            if name == "modify_position":
                return _trading_modify_position(strategy, arguments)
        if name == "open_position":
            if not _is_trading_write_open_enabled():
                return [TextContent(type="text", text=json.dumps({
                    "error": "trading_write_open_disabled",
                    "message": (
                        "用户没在客户端「设置 → 高级」里开启「允许 AI 直接开仓」（这跟平/改是两个独立开关）。"
                        "请先告知用户去开启此权限再重试 —— 开仓的风险敞口比平仓大得多，需要单独确认。"
                    ),
                }, ensure_ascii=False))]
            return _trading_open_position(strategy, arguments)

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
    """List tools; start services on first call."""
    global services_started
    if not services_started:
        services_started = True
        if start_all_services():
            logging.info("Services started")
        else:
            logging.error("Service startup failed")
    return get_all_tools()


# ============== Backtest ==============
#
# Drives the MT5 Strategy Tester from the command line. Non-blocking by
# design — `run_backtest` returns immediately with a backtest_id, and the
# caller polls `get_backtest_status` to wait for results.
#
# We spawn a fresh `terminal64.exe /config:<ini>` instance per test. The
# config INI has a `[Tester]` section that drives the test, plus optional
# `[TesterInputs]` to override input parameters. When `ShutdownTerminal=1`
# the test instance exits on its own once the run finishes.
#
# Reports come out at <data_path>/Reports/<name>.htm (UTF-16 LE). We parse
# the standard MetaQuotes report HTML to extract the headline metrics.
#
# Concurrency caveat: running a test instance while the user has MT5 open
# elsewhere usually works (MT5 allows multiple instances), but for clean
# isolation users may want to close their live terminal first.

import subprocess

_backtests: dict[str, dict] = {}  # bt_id -> state dict (in-memory; includes live proc handle)
_BT_KEEP = 30  # cap memory: keep last N records
_backtests_loaded_from_disk = False  # one-shot init guard

# Concurrent-spawn cap. MT5 instances on the same data dir contend for the
# data-dir lock; running 2+ in parallel often produces "finished_no_report"
# for one of them. Serialise via an internal queue.
_MAX_CONCURRENT_BACKTESTS = 1


def _running_backtests_count() -> int:
    return sum(1 for bt in _backtests.values() if bt.get("status") == "running")


def _spawn_backtest_now(bt_id: str, bt: dict) -> bool:
    """Actually start the terminal64 subprocess for a backtest record. The
    record must already have spawn_cmd / spawn_cwd / spawn_creationflags
    populated. Returns True on success, False on failure (and writes
    error fields onto the record)."""
    try:
        kwargs = {"cwd": bt.get("spawn_cwd")}
        flags = bt.get("spawn_creationflags") or 0
        if flags:
            kwargs["creationflags"] = flags
        # spawn_cmd is now a pre-quoted string (so /config:"path with space"
        # is honored by MT5). Old records may still have it as a list — handle
        # both for back-compat with persisted state.
        spawn_cmd = bt["spawn_cmd"]
        if isinstance(spawn_cmd, list):
            proc = subprocess.Popen(spawn_cmd, **kwargs)
        else:
            proc = subprocess.Popen(spawn_cmd, shell=False, **kwargs)
        bt["proc"] = proc
        bt["pid"] = proc.pid           # 持久化到 backtests.json — 客户端「取消」按钮能直接 kill
        bt["status"] = "running"
        bt["started_at"] = time.time()  # reset elapsed timer when actually starting
        bt.pop("queued_at", None)
        return True
    except Exception as exc:
        bt["status"] = "error"
        bt["error"] = f"spawn failed: {exc}"
        bt["finished_at"] = time.time()
        return False


def _scheduler_db_path() -> str | None:
    """Locate scheduler.db. Prefer EASYDEAL_SCHEDULER_DB env (set by the
    easydeal-client when wiring up .mcp.json); else derive as a sibling of
    backtests.json (both live in <userData>/data/)."""
    p = os.getenv("EASYDEAL_SCHEDULER_DB")
    if p and os.path.isfile(p):
        return p
    bt = _backtests_file()
    if bt:
        guess = os.path.join(os.path.dirname(bt), "scheduler.db")
        if os.path.isfile(guess):
            return guess
    return None


def _auto_schedule_backtest_poll(bt_id: str, ea: str, symbol: str) -> tuple[bool, str | None]:
    """Insert a polling task DIRECTLY into scheduler.db so the easydeal-client
    sidecar will fire it every minute and call get_backtest_status until the
    backtest finishes.

    Why direct DB insert (vs Claude calling mcp__easydeal-scheduler__schedule_task):
    LLMs are notorious for *claiming* "I scheduled it" without actually calling
    the tool — observed in practice with 3 backtest runs in this session, all
    chat replies said "已设置自动检查任务" but scheduler.db had 0 entries.
    Removing Claude from the loop makes the auto-poll behaviour reliable.

    Returns (ok, task_id_or_error).
    """
    db_path = _scheduler_db_path()
    if not db_path:
        return False, "scheduler.db not found"
    try:
        import sqlite3 as _sql
        import secrets as _sec
        task_id = "t_" + _sec.token_hex(6)
        now_ms = int(time.time() * 1000)
        # Fire at the next minute boundary so it polls within ~60s.
        next_fire = ((now_ms // 60_000) + 1) * 60_000
        prompt = (
            f"自动触发：查询回测 {bt_id} 进度。\n"
            f"调 mcp__easydeal__get_backtest_status({{\"backtest_id\":\"{bt_id}\"}})。\n"
            f"\n"
            f"⚠ 铁律：**绝对不要主动调 mcp__easydeal__run_backtest 重试这只回测**。\n"
            f"任何状态（包括 config_error / error / finished_no_report / 0 笔成交）都只汇报给用户 + cancel_task 自己 → 由用户决定要不要重跑。原因：\n"
            f"  - 失败常因配置（accounts.dat 缺失 / 副本 MT5 数据没下载 / 起止日期超出 broker 数据范围 / .ex5 跟 .mq5 版本不一致）\n"
            f"  - 不修配置直接重试 = 必然再失败，每次都烧 token + 弹通知\n"
            f"  - 用户看到失败原因，10 秒内自己判断要不要修 + 重发 比让 LLM 瞎试 10 次靠谱\n"
            f"\n"
            f"分支处理：\n"
            f"- status=queued/running → 简短日志，不要发到用户对话；不要再排新任务。\n"
            f"- status=ok（回测托管模式 — 给用户综合分析，不是只甩数字）：\n"
            f"  1. Read strategies/{ea}.md（如果文件存在）— 拿到策略意图、风险阈值、参数预期。没文件就跳过这步。\n"
            f"  2. 把 metrics 跟 .md 描述的合理表现对照，判断 verdict：\n"
            f"     - 净利 / 夏普 是否达策略 doc 描述的合理预期\n"
            f"     - 最大回撤 是否超出 .md 里写的风控阈值\n"
            f"     - 交易频率 / 胜率 / 盈亏比 是否符合策略性质（高频抓小利 vs 低频大趋势 vs 网格 vs 马丁）\n"
            f"  3. 给一段话评估，最后一句明确给 verdict 之一：\n"
            f"     - ✅ 通过 — 表现达预期，可以推下一步（实盘 demo / 实盘小仓试跑）\n"
            f"     - ⚠ 调参 — 哪个 input 怎么调（具体数值范围，不要泛泛「调整参数」）\n"
            f"     - ❌ 否决 — 这套思路可能不适合这个品种/周期/时段，建议换个方向\n"
            f"  4. 用这个格式发到 chat + wechat：\n"
            f"     ```\n"
            f"     ✅ 回测完成 {ea} @ {symbol}\n"
            f"     净利 +XXX (XX%)  夏普 X.XX  最大回撤 -X.X%\n"
            f"     交易 XX 笔  胜率 XX%  盈亏比 X.X\n"
            f"     \n"
            f"     【评估】<两三句话，结合 .md 意图分析为什么这个数字 OK / 不 OK>\n"
            f"     【下一步】<{{✅ 通过 / ⚠ 调参 / ❌ 否决}}>: <具体建议>\n"
            f"     ```\n"
            f"  5. **必须**调 mcp__easydeal-scheduler__cancel_task({{\"task_id\":\"<触发上下文 Task id>\"}}) 把自己关掉。\n"
            f"- status=error/finished_no_report/config_error → **不要泛泛说「失败了」**。返回里有 `data.message`（已含具体 hint）+ `data.diagnostic.log_lines`（MT5 日志原文）+ `data.next_steps`（用户该怎么做）—— 直接把这三块结构化转告用户，格式：\n"
            f"     ```\n"
            f"     ⚠ 回测失败 {ea} @ {symbol}\n"
            f"     原因：<data.message 这句话>\n"
            f"     \n"
            f"     MT5 日志关键行：\n"
            f"     - <log_lines[0]>\n"
            f"     - <log_lines[1]>\n"
            f"     ...（最多 4 行；没 log_lines 就省略这块）\n"
            f"     \n"
            f"     建议：\n"
            f"     1. <next_steps[0]>\n"
            f"     2. <next_steps[1]>\n"
            f"     ...\n"
            f"     ```\n"
            f"     讲完**必须**调 cancel_task 关掉自己。**不要重试** —— 上面铁律已说明。\n"
            f"- 返回里有 user_action_hint → 转告用户。\n"
        )
        # Declare delivery channels via the new `notify` column. Value is
        # JSON-encoded list — see scheduler_mcp.py _normalize_notify().
        # We push to chat AND wechat (the recipient-window guards on the
        # Electron side handle "is wechat actually wanted right now").
        notify_json = '["chat","wechat"]'
        with _sql.connect(db_path) as conn:
            # Add the column on the fly if it doesn't exist (covers DBs
            # created before the schema change).
            cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
            if "notify" not in cols:
                conn.execute("ALTER TABLE tasks ADD COLUMN notify TEXT")
            conn.execute(
                """INSERT INTO tasks
                   (id, name, schedule, kind, prompt, mode, enabled, created_at,
                    next_fire_at, last_fire_at, last_status, notify)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)""",
                (task_id, f"回测进度 {ea} {bt_id}", "* * * * *", "cron",
                 prompt, "llm_headless", 1, now_ms, next_fire, notify_json),
            )
        return True, task_id
    except Exception as exc:
        logging.exception("[backtest] auto-schedule poll failed")
        return False, str(exc)


def _schedule_pending_backtests():
    """Promote oldest queued backtests to running while we have capacity."""
    while _running_backtests_count() < _MAX_CONCURRENT_BACKTESTS:
        queue = sorted(
            [(bt_id, bt) for bt_id, bt in _backtests.items() if bt.get("status") == "queued"],
            key=lambda kv: kv[1].get("queued_at") or 0,
        )
        if not queue:
            return
        bt_id, bt = queue[0]
        if _spawn_backtest_now(bt_id, bt):
            logging.info("[backtest] dequeued %s → running", bt_id)
        _save_persisted_backtests()


def _queue_position(bt_id: str) -> int:
    """1-based position among queued tasks; 0 means not queued."""
    queue = sorted(
        [(b_id, bt) for b_id, bt in _backtests.items() if bt.get("status") == "queued"],
        key=lambda kv: kv[1].get("queued_at") or 0,
    )
    for i, (b_id, _) in enumerate(queue, start=1):
        if b_id == bt_id:
            return i
    return 0


# ---- Persistent backtests file ----
# When EASYDEAL_BACKTESTS_FILE is set (the easydeal-client passes it),
# every state change is mirrored to that JSON. The Electron UI reads the
# file to render per-EA history and unread badges.

def _backtests_file() -> str | None:
    p = os.getenv("EASYDEAL_BACKTESTS_FILE")
    if p:
        return p
    workspace = os.getenv("EASYDEAL_WORKSPACE_DIR")
    if workspace:
        return os.path.join(workspace, ".easydeal", "backtests.json")
    return None


def _serialize_bt(bt_id: str, bt: dict) -> dict:
    """Strip non-serializable fields (Popen handle) and flatten into a
    JSON-safe record. We DO persist `report_candidates` and `spawn_cwd`
    because get_backtest_status needs them to finalise records loaded
    from disk after the spawning MCP child process has died.

    时间戳字段统一用 `... or 0`（None → 0）—— 0.1.69 之前 _record_preflight_failure
    / _spawn_backtest_now 在异常路径下偶尔留 started_at=None 进盘，下次 load 后
    任意一处 sort/comparison 直接 TypeError「'<' not supported between instances
    of 'NoneType' and 'float'」，且 traceback 被吃掉只剩单行 ERROR 没法定位。
    根治：写盘 + 内存层面都不再允许 None 时间戳，下游任何比较都能安全跑。"""
    return {
        "id":               bt_id,
        "ea":               bt.get("ea"),
        "symbol":           bt.get("symbol"),
        "period":           bt.get("period"),
        "from_date":        bt.get("from_date"),
        "to_date":          bt.get("to_date"),
        "deposit":          bt.get("deposit"),
        "leverage":         bt.get("leverage"),
        "currency":         bt.get("currency"),
        "started_at":       bt.get("started_at") or 0,
        "queued_at":        bt.get("queued_at") or 0,
        "finished_at":      bt.get("finished_at") or 0,
        "status":           bt.get("status"),
        "exit_code":        bt.get("exit_code"),
        "metrics":          bt.get("metrics"),
        "report_path":      bt.get("report_path"),
        "error":            bt.get("error"),
        "viewed":           bt.get("viewed", False),
        # Inputs the user / Claude provided to this run — useful for
        # reviewing "what did this backtest actually test?"
        "input_overrides":  bt.get("input_overrides") or {},
        "account":          bt.get("account") or None,
        # Cross-process resume fields — let get_backtest_status finalise a
        # disk-loaded record without the original Popen handle.
        "report_candidates": bt.get("report_candidates"),
        "spawn_cwd":         bt.get("spawn_cwd"),
        # spawn 进程 PID — 客户端「取消」按钮用这个直接 taskkill，
        # 不用绕到 MCP 工具调用。Popen 句柄持久不了（进程退出后失效），
        # 但 PID 跨重启仍然可以查存活 + kill。
        "pid":               bt.get("pid"),
    }


def _load_persisted_backtests() -> dict:
    p = _backtests_file()
    if not p or not os.path.isfile(p):
        return {"by_ea": {}}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"by_ea": {}}


def _ensure_backtests_loaded():
    """Lazy first-use load of the persistent backtests.json into the in-memory
    `_backtests` dict. Without this, every fresh MCP child process spawned by
    Claude Code starts with an empty dict and `list_backtests` reports zero
    history — even though backtests.json on disk has dozens of records.

    We do it lazily (on first list/get/run call) because the stdio MCP server
    starts before module-level init makes sense, and MetaTrader5 / mt5 module
    interactions during import are messy. Idempotent — guarded by a flag."""
    global _backtests_loaded_from_disk
    if _backtests_loaded_from_disk:
        return
    _backtests_loaded_from_disk = True
    persisted = _load_persisted_backtests()
    by_ea = (persisted or {}).get("by_ea") or {}
    for ea, lst in by_ea.items():
        for r in lst:
            bt_id = r.get("id")
            if not bt_id or bt_id in _backtests:
                continue
            # Disk record is a flat snapshot — copy fields into in-memory
            # shape. proc handle stays absent (this is past-state, not live).
            rec = dict(r)
            # 兜底：早期版本写过 None 进盘（preflight failure 路径 + spawn 失败
            # 路径）。任何后续 sort 或 (time.time() - x) 都会 None vs float 炸。
            # 加载时一次性 normalize 掉，让所有下游都能安全走 or 0 / 算术。
            for ts_field in ("started_at", "queued_at", "finished_at"):
                if rec.get(ts_field) is None:
                    rec[ts_field] = 0
            _backtests[bt_id] = rec
            # Old records used spawn_cmd as a list — keep as-is, _spawn checks.
    # If we accidentally over-loaded beyond our cap, trim newest-N.
    if len(_backtests) > _BT_KEEP * 4:
        _trim_backtests()


def _save_persisted_backtests():
    """Snapshot the merged in-memory + on-disk state. Records on disk that
    aren't currently in _backtests are kept (history); records in memory
    overwrite their disk counterparts (latest state)."""
    p = _backtests_file()
    if not p:
        return
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        existing = _load_persisted_backtests()
        by_ea: dict[str, list[dict]] = existing.get("by_ea", {}) or {}
        # Index existing entries by id for fast update
        index: dict[str, tuple[str, int]] = {}  # id -> (ea, index_in_list)
        for ea, lst in by_ea.items():
            for i, e in enumerate(lst):
                if e.get("id"):
                    index[e["id"]] = (ea, i)

        for bt_id, bt in _backtests.items():
            rec = _serialize_bt(bt_id, bt)
            ea = rec.get("ea") or "_unknown"
            if bt_id in index:
                old_ea, idx = index[bt_id]
                if old_ea == ea:
                    by_ea[old_ea][idx] = rec
                else:
                    # Strategy renamed? Move it
                    del by_ea[old_ea][idx]
                    by_ea.setdefault(ea, []).insert(0, rec)
            else:
                by_ea.setdefault(ea, []).insert(0, rec)
                index[bt_id] = (ea, 0)

        # Sort each EA's list by started_at desc, cap at 30
        for ea in by_ea:
            by_ea[ea].sort(key=lambda x: x.get("started_at") or 0, reverse=True)
            by_ea[ea] = by_ea[ea][:_BT_KEEP]

        out = {"by_ea": by_ea, "saved_at": int(time.time())}
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
    except Exception as exc:
        logging.warning("[backtests] save failed: %s", exc)


def _mt5_login_dialog_visible() -> bool:
    """Best-effort detection: any visible top-level window whose title looks
    like the MT5 login confirm dialog. Used to surface a 'go click login'
    hint while a backtest is stuck waiting on it. Windows-only."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
        u32 = ctypes.windll.user32
        EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        found = []

        def cb(hwnd, _lparam):
            try:
                if not u32.IsWindowVisible(hwnd):
                    return True
                length = u32.GetWindowTextLengthW(hwnd)
                if length == 0:
                    return True
                buf = ctypes.create_unicode_buffer(length + 1)
                u32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value or ""
                # Match the MT5 login window. The title varies by language —
                # e.g. "登录交易账户", "Authorization", "Account login".
                low = title.lower()
                if (
                    "登录" in title or "登入" in title or
                    "authorization" in low or "account login" in low or
                    "trading account" in low and "login" in low
                ):
                    # Restrict to MT5-owned windows by class name to avoid
                    # false positives (Windows logon, browser tabs, etc.)
                    cls = ctypes.create_unicode_buffer(64)
                    u32.GetClassNameW(hwnd, cls, 64)
                    if cls.value and ("MQ4" in cls.value or "Login" in cls.value or "Dialog" in cls.value):
                        found.append(title)
            except Exception:
                pass
            return True

        u32.EnumWindows(EnumWindowsProc(cb), 0)
        return bool(found)
    except Exception:
        return False


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


def _build_tester_ini(*, ea, symbol, period, from_date, to_date,
                      deposit, leverage, currency, overrides, report_name,
                      login=None, server=None):
    """Compose an MT5 tester INI. MT5 expects YYYY.MM.DD dates.

    `login` + `server` MUST be supplied — MT5's tester refuses to start
    without an account ("tester not started because the account is not
    specified"). When the spawned terminal instance has saved credentials
    for that login (origin.dat), no password prompt is needed.
    """
    from_d = str(from_date).replace("-", ".")
    to_d = str(to_date).replace("-", ".")
    leverage_str = f"1:{int(leverage)}"

    # MT5 build 5xxx 实测：Login / Server **必须放在 [Tester] 段** —— 只放
    # [Common] 时 tester 启动会立刻报「tester not started because the
    # account is not specified」并退出。[Common] 段的 Login/Server 是给
    # 终端主连接用的，跟 tester 是独立通道。诊断用户 EZDL-KSBF-7BHR 的
    # tester_log_tails 直接抓到这条错误日志才定位的。
    # 双段都写：[Common] 让 MT5 终端先登录，[Tester] 给 tester 显式账号。
    # Password 不写 —— accounts.dat（portable bootstrap 时已写盘）会按
    # Login 号查到 hashed password。
    lines = ["[Common]"]
    if login:
        lines.append(f"Login={login}")
    else:
        lines.append("Login=")
    if server:
        lines.append(f"Server={server}")
    lines += [
        "ProxyEnable=0",
        "",
        "[Tester]",
        f"Expert={ea}",
        f"Symbol={symbol}",
        f"Period={period}",
    ]
    if login:
        lines.append(f"Login={login}")
    if server:
        lines.append(f"Server={server}")
    lines += [
        "Optimization=0",
        # Model 2 = OHLC on M1 (a good speed/accuracy trade-off; "every tick"
        # is more accurate but much slower).
        "Model=2",
        f"FromDate={from_d}",
        f"ToDate={to_d}",
        "ForwardMode=0",
        f"Deposit={int(deposit)}",
        f"Currency={currency}",
        f"Leverage={leverage_str}",
        "ExecutionMode=0",
        "ShutdownTerminal=1",
        "Replace=1",
        "Visual=0",
        f"Report={report_name}",
        "",
    ]
    if overrides:
        lines.append("[TesterInputs]")
        for k, v in overrides.items():
            if v is True:
                lines.append(f"{k}=true")
            elif v is False:
                lines.append(f"{k}=false")
            else:
                lines.append(f"{k}={v}")
    return "\n".join(lines)


def _write_ini(path: str, content: str):
    # MT5 reads INIs as UTF-16 LE with BOM.
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\xff\xfe")  # UTF-16 LE BOM
        f.write(content.encode("utf-16-le"))


def _read_log_utf16_or_utf8(path: str) -> str | None:
    """Read MT5 log file. Newer MT5 builds write UTF-16 LE w/ BOM;
    very old or agent logs sometimes UTF-8. Best effort, returns None on
    miss. Logs can be large — caller should pass back only what's needed."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except (FileNotFoundError, PermissionError):
        return None
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        for enc in ("utf-16", "utf-16-le"):
            try:
                return data.decode(enc, errors="ignore")
            except Exception:
                continue
    try:
        return data.decode("utf-8", errors="ignore")
    except Exception:
        return None


def _backtest_next_steps_from_hint(hint: str | None) -> list[str]:
    """Map a postmortem hint to specific next steps. Generic fallback when
    hint is None/unknown."""
    if not hint:
        return [
            "MT5 → 视图 → 工具箱 → 日志 看具体报错（也可看上面 log_lines）",
            "确认 EA 已经编译（检查 MT5/Experts/<EA>.ex5 是否存在 + 文件不是 0 字节）",
            "确认品种 / 周期 / 日期范围 MT5 真有历史数据（工具箱 → 历史中心）",
            "如果还无法定位，把 log_files_checked 路径里的最近一个文件发给 AI 让它读完整内容",
        ]
    if "账号" in hint:
        return [
            "客户端窗口 → 设置 tab → 回测环境 卡片",
            "确认步骤 2「副本目录已登录 demo 账号」标记是绿色的",
            "如果不是绿色 → 点「保存并启动登录（/portable）」→ 在弹出的 MT5 里手动登一次 demo 号 → **必须勾「保存账户信息」** → 关掉",
            "回客户端，新开一条对话再发回测请求（已开的对话拿的是旧 env，不会热加载）",
        ]
    if "历史数据" in hint:
        return [
            "打开你回测用的那个副本 MT5（不是主 MT5）",
            "工具栏 → 工具箱 → 历史中心（或按 F2）",
            "找到回测要用的品种 → 双击 → 「下载」按钮拉完整历史",
            "下完关掉副本 MT5，回客户端再发回测",
        ]
    if "品种名错" in hint:
        return [
            "**注意**：mcp__easydeal__get_market_info 查的是【主 MT5】（用户日常交易那个）的品种 —— 如果回测 MT5 接的是不同 broker（例如主 = Exness 加 m 后缀，回测 = MetaQuotes-Demo 不加后缀），这两个的品种名表是不一样的。",
            "如果上面 hint 提示了「跨 broker」 → 让用户手动打开**回测 MT5**（不是主 MT5）→ 视图 → 市场观察（Ctrl+M）→ 右键空白 → 显示全部 → 把黄金那条的全名发给你（Exness/Tickmill/IC Markets 各家叫法都不同）",
            "或者直接换几个常见名试一遍 retry：XAUUSD、GOLD、XAU/USD、XAUUSD.x、XAUUSD.r —— 第一个能跑通的就是对的",
            "把 symbol 参数换成正确的全名后重新发起 run_backtest",
        ]
    if "EA" in hint and "编译" in hint:
        return [
            "调 mcp__easydeal__compile_strategy(name='<EA>') 重新编译",
            "看返回的 stderr / stdout 里的 error 行 — 修源码后再回测",
        ]
    if "锁" in hint:
        return [
            "看任务管理器里有几个 terminal64.exe 在跑",
            "如果回测副本目录的 MT5 是 zombie，手动关掉",
            "如果是主 MT5 占着 → 配「回测环境」卡片建独立副本（步骤 1）",
        ]
    return [
        "按上面 hint 给的方向定位",
        "把 log_lines 里的具体报错发给 AI 帮你诊断",
    ]


def _collect_backtest_postmortem(install_dir: str, started_at: float, *,
                                  max_lines: int = 8,
                                  max_chars_per_line: int = 240) -> dict:
    """Look at MT5 logs from the failed backtest's install dir, return the
    likely root cause as a structured dict so the run_backtest /
    get_backtest_status response carries actionable detail instead of just
    "spawn 死了，没生成报告".

    Why this exists: when a backtest spawn dies without producing a report,
    we historically returned a generic message. Users (and Claude
    paraphrasing the tool response) then say "失败了，可能凭据 / 历史数据
    / 参数错误" — useless. MT5 actually writes the precise reason to its
    logs (account not found, symbol missing, EA not found, history file
    corrupted, etc.). This walks the right log paths post-spawn-time and
    extracts the relevant lines.

    Log locations checked, in order of usefulness:
      1. <install>/Tester/logs/<YYYYMMDD>.log  — tester's own log (best)
      2. <install>/Tester/Logs/<YYYYMMDD>.log  — older MT5 capitalisation
      3. <install>/Tester/Agent-127.0.0.1-3000/logs/<YYYYMMDD>.log
      4. <install>/Logs/<YYYYMMDD>.log  — terminal log (lock / login errors)
      5. <install>/MQL5/Logs/<YYYYMMDD>.log  — EA-side log (compile errors)

    Returns: {"hint": "<short human reason>", "log_lines": [...],
              "log_files_checked": [...]}.
    """
    if not install_dir or not os.path.isdir(install_dir):
        return {"hint": None, "log_lines": [], "log_files_checked": []}
    # We only care about lines written AFTER the spawn began.
    # Subtract 5s for clock drift safety.
    cutoff = max(0, (started_at or 0) - 5)
    today = time.strftime("%Y%m%d", time.localtime())
    yesterday = time.strftime("%Y%m%d", time.localtime(time.time() - 86400))
    candidates = []
    for sub in (
        ["Tester", "logs"], ["Tester", "Logs"],
        ["Tester", "Agent-127.0.0.1-3000", "logs"],
        ["Tester", "Agent-127.0.0.1-3000", "Logs"],
        ["Logs"],
        ["MQL5", "Logs"],
    ):
        for d in (today, yesterday):
            candidates.append(os.path.join(install_dir, *sub, f"{d}.log"))

    # Keywords that strongly indicate the actual failure cause. Order =
    # priority (first matched line wins). 0.2.8: 把"用户能修"的具体错（品种 /
    # 账号 / 历史数据 / 编译）放最前面 —— 之前 disconnected / connection
    # 排在前面，每次 tester 退出都会顺带写一条 "Core 01 disconnected"，
    # postmortem 命中那条就报「网络问题」，盖过了真正的「symbol does not
    # exist」根因。重排后即使日志里同时有断连和品种错，hint 优先选品种错。
    error_patterns = [
        # === 最高优先：品种 / EA / 数据这类用户立刻能定位的 ===
        ("symbol does not exist",         "品种名错 — broker 全列表里没这个品种"),
        ("symbol not exist",              "品种名错 — broker 全列表里没这个品种"),
        ("symbol unknown",                "品种名错 — broker 全列表里没这个品种"),
        ("expert was not loaded",         "EA 没装上 — .ex5 文件可能丢了 / 损坏；重新编译试试"),
        ("compilation error",             "EA 编译失败 — 源码语法有问题，重新编译试试"),
        ("no history",                    "历史数据缺失 — 这个品种 / 周期在指定日期范围内没数据，去 MT5 工具箱『历史中心』下载"),
        ("data not synchronized",         "历史数据没同步 — MT5 工具箱『历史中心』下载完整历史再试"),
        ("missing data",                  "历史数据缺失 — 同上，去『历史中心』下载"),
        ("file not found",                "文件缺失 — 可能 .ex5 没编译成功；先跑 compile_strategy 再回测"),
        # === 次高：账号 / 凭据 / 锁 ===
        ("account is not specified",      "回测账号没指定 — 可能 accounts.dat 没生成或 LOGIN/SERVER env 没传到 tester"),
        ("not specified",                 "回测账号没指定 — 可能 accounts.dat 没生成或 LOGIN/SERVER env 没传到 tester"),
        ("invalid account",               "回测账号无效 / 已禁用 — 检查账号有没有过期，或换一个 demo 号"),
        ("incorrect password",            "密码错 — accounts.dat 缓存过期，重新「保存并启动登录」一次"),
        ("authorization failed",          "登录服务器失败 — 网络问题 / 账号密码错 / 服务器名错"),
        ("login failed",                  "登录失败 — 看下面具体行"),
        ("locked",                        "数据目录被锁 — 另一个 MT5 实例在用同一个目录，关掉再试"),
        ("access denied",                 "权限拒绝 — 安装目录可能在 Program Files 下需要管理员；移到普通目录或用 portable"),
        # === 最低：网络断连 / 一般"not found" ===
        # 这些放最后，因为 tester 退出时几乎必报 disconnected，但那不是根因。
        ("disconnected",                  "MT5 跟服务器断了连接 — 网络问题 / 服务器故障"),
        # 下面的 None hint 只用来高亮上下文行，不作为最终 hint
        ("expert ",                       None),
        ("not found",                     None),
        ("connection",                    None),
    ]

    # 0.2.8: 按行的时间戳过滤"早于 spawn"的内容。MT5 日志是 daily 文件
    # （20260510.log），同一文件可能既有今天 09:00 旧 tester 跑过的 trace，
    # 又有 15:05 新 spawn 的 trace。光按 file mtime 过滤不够 —— 文件 mtime
    # 是 15:06（新写过），但前 200 行 tail 里仍夹着 09:xx 的 disconnected
    # 旧记录，会误命中。每行都拿前缀的 HH:MM:SS.mmm 跟 spawn time 比，比
    # spawn 早的整行跳过。
    log_date = today  # 用今天的日期 + 行内 HH:MM:SS 拼出绝对时间
    spawn_lt = time.localtime(cutoff) if cutoff else None

    def _line_after_spawn(line: str) -> bool:
        """MT5 line 形如 `RL\t0\t15:00:39.609\t...` —— 第 3 个 tab 字段是
        HH:MM:SS.mmm 钟点。如果文件名是今天，把这个钟点拼成今天的时间戳，
        跟 spawn cutoff 比；早于 spawn 的 → False（跳过）。日期跨天的 corner
        case 简化处理：tail 倒数 200 行里基本不会跨天，直接用今天日期。
        无法解析时间的行（不是标准 MT5 trace 格式）→ 返回 True 保留。"""
        if not spawn_lt:
            return True
        try:
            parts = line.split("\t", 3)
            if len(parts) < 3:
                return True
            t_field = parts[2]   # HH:MM:SS.mmm
            hh = int(t_field[0:2]); mm = int(t_field[3:5]); ss = int(t_field[6:8])
            # 拼今天的时间戳
            line_t = time.mktime((
                spawn_lt.tm_year, spawn_lt.tm_mon, spawn_lt.tm_mday,
                hh, mm, ss, 0, 0, -1
            ))
            return line_t >= cutoff
        except Exception:
            return True

    captured_lines: list[str] = []
    files_checked: list[str] = []
    best_hint: str | None = None
    seen = set()
    for fp in candidates:
        if fp in seen:
            continue
        seen.add(fp)
        if not os.path.isfile(fp):
            continue
        files_checked.append(fp)
        try:
            mtime = os.path.getmtime(fp)
            if mtime < cutoff:
                continue
        except Exception:
            continue
        text = _read_log_utf16_or_utf8(fp) or ""
        if not text:
            continue
        # 取尾部 600 行 + 行级时间过滤（之前 200 行 + 无时间过滤会让旧
        # session 的 disconnected 行盖掉新 session 的真错因）。
        tail_lines = text.splitlines()[-600:]
        for line in tail_lines:
            ln = (line or "").strip()
            if not ln:
                continue
            if not _line_after_spawn(ln):
                continue
            # Lower-cost match
            ln_lower = ln.lower()
            for kw, hint in error_patterns:
                if kw.lower() in ln_lower:
                    if hint and best_hint is None:
                        best_hint = hint
                    if len(captured_lines) < max_lines:
                        captured_lines.append(ln[:max_chars_per_line])
                    break
    return {
        "hint": best_hint,
        "log_lines": captured_lines,
        "log_files_checked": files_checked[:8],
    }


def _read_report(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        return None
    # MT5 reports are usually UTF-16 LE
    for enc in ("utf-16", "utf-16-le", "utf-8"):
        try:
            return data.decode(enc, errors="ignore")
        except Exception:
            continue
    return None


def _parse_html_report(html: str) -> dict:
    """Best-effort extraction of headline metrics from a MT5 tester HTML
    report. Layout/locale varies by MT5 build:

      - English locale (older docs, generic build):
            <td>Total Net Profit:</td><td>1234</td>
      - Chinese locale (Exness MT5 5xxx, what the user actually sees):
            <td>总净盈利:</td><td><b>4 649.67</b></td>
        Note the <b>...</b> wrapper around the value cell, AND space as
        thousands separator ("4 649.67" not "4,649.67").

    We accept both label languages AND both value-cell layouts, return
    whichever sticks."""

    def find(label_variants):
        for label in label_variants:
            # Two patterns for the value cell — bare or wrapped in <b>:
            #   <td>label:</td><td>VALUE</td>
            #   <td>label:</td><td><b>VALUE</b></td>
            for value_inner in (r"\s*<b[^>]*>\s*([^<]+?)\s*</b>\s*",
                                r"\s*([^<]+?)\s*"):
                m = re.search(
                    rf"<td[^>]*>\s*{re.escape(label)}\s*:?\s*</td>\s*<td[^>]*>{value_inner}</td>",
                    html, re.IGNORECASE)
                if m:
                    return m.group(1).strip()
        return None

    def num(s):
        if s is None:
            return None
        # MT5 thousands-separator: space ("4 649.67"). Also strip commas & nbsp.
        s = s.strip().replace(",", "").replace("\xa0", "").replace(" ", "")
        s = s.replace("&nbsp;", "")
        # parenthesized = negative
        if s.startswith("(") and s.endswith(")"):
            s = "-" + s[1:-1]
        try:
            return float(s)
        except Exception:
            return None

    def pct_inside(s):
        if s is None:
            return None
        # "735.18 (4.94%)" or "(4.94%)"
        m = re.search(r"\(\s*([\d.]+)\s*%\s*\)", s)
        if m:
            return float(m.group(1)) / 100.0
        # "4.94% (735.18)" or "4.94%"
        m2 = re.match(r"\s*([\d.]+)\s*%", s)
        if m2:
            return float(m2.group(1)) / 100.0
        return None

    def num_before_paren(s):
        """Extract leading number from values like '735.18 (4.94%)' →
        735.18. Falls back to plain num() for values without parens."""
        if s is None:
            return None
        # Strip parenthesised tail, then num()
        head = re.split(r"\s*\(", s, maxsplit=1)[0]
        return num(head)

    def int_count(s):
        if s is None:
            return None
        # "44" or "23 (61.90%)" — take the leading integer
        m = re.match(r"\s*(\d+)\s*", s)
        if m:
            return int(m.group(1))
        return None

    metrics = {
        "net_profit":       num(find(["Total Net Profit", "总净盈利"])),
        "gross_profit":     num(find(["Gross Profit", "毛利", "总盈利"])),
        "gross_loss":       num(find(["Gross Loss", "毛损", "总亏损"])),
        "profit_factor":    num(find(["Profit Factor", "盈利因子"])),
        "expected_payoff":  num(find(["Expected Payoff", "预期收益"])),
        "sharpe":           num(find(["Sharpe Ratio", "夏普比率"])),
        "recovery_factor":  num(find(["Recovery Factor", "采收率", "恢复因子"])),
        # Drawdown values look like "735.18 (4.94%)" — strip $ vs %
        "max_drawdown_abs": num_before_paren(
            find(["Balance Drawdown Maximal", "Maximal Drawdown",
                  "最大结余亏损", "最大净值亏损", "平衡资金回撤最大值"])
        ),
        "max_drawdown_pct": pct_inside(
            find(["Balance Drawdown Relative", "相对结余亏损", "相对净值亏损",
                  "Balance Drawdown Maximal", "最大结余亏损", "最大净值亏损"])
        ),
        "trades":           int_count(find(["Total Trades", "交易总计", "总交易"])),
        "wins":             int_count(find(["Profit Trades (% of total)", "Profit Trades",
                                            "盈利交易 (% 全部)", "盈利交易"])),
        "losses":           int_count(find(["Loss Trades (% of total)", "Loss Trades",
                                            "亏损交易 (% 全部)", "亏损交易"])),
        "win_rate":         pct_inside(find(["Profit Trades (% of total)",
                                             "盈利交易 (% 全部)"])),
    }
    return {k: v for k, v in metrics.items() if v is not None}


def _trim_backtests():
    if len(_backtests) <= _BT_KEEP:
        return
    # 用 `.get(...) or 0` 而不是 `.get(..., 0)` —— 后者 default 只在 key 缺失
    # 时生效；record 里 started_at 显式 None 时仍是 None，sort 比较 None vs
    # float 直接 TypeError「'<' not supported between instances of 'NoneType'
    # and 'float'」。其他几处 sort（_save_persisted_backtests / _queue_position
    # / _schedule_pending_backtests）都用 or 0 防御过了，这里漏了。
    by_started = sorted(_backtests.items(), key=lambda kv: (kv[1].get("started_at") or 0), reverse=True)
    keep_ids = {bt_id for bt_id, _ in by_started[:_BT_KEEP]}
    for bt_id in list(_backtests):
        if bt_id not in keep_ids:
            _backtests.pop(bt_id, None)


def _record_preflight_failure(ea: str, symbol: str, period: str,
                              from_date: str, to_date: str,
                              deposit, leverage, currency: str,
                              error_code: str, error_msg: str) -> None:
    """Persist a backtest 'config_error' record so the UI's 回测历史 panel
    shows what happened. Without this, the user clicks 回测, MCP aborts
    via a preflight, and the 回测历史 panel shows nothing new — making
    them think their click did nothing."""
    try:
        bt_id = f"bt_{int(time.time() * 1000):x}"
        now = time.time()
        _backtests[bt_id] = {
            "id": bt_id, "ea": ea, "symbol": symbol, "period": period,
            "from_date": from_date, "to_date": to_date,
            "deposit": deposit, "leverage": leverage, "currency": currency,
            # 时间戳一律用 float（0 表示 N/A）—— 不留 None，避免 sort 时
            # None vs float TypeError。
            "started_at": now, "queued_at": 0, "finished_at": now,
            "status": "config_error",
            "exit_code": None, "metrics": None, "report_path": None,
            "error_code": error_code,
            "error": error_msg,
            "viewed": False,
        }
        _trim_backtests()
        _save_persisted_backtests()
    except Exception:
        pass   # best-effort — don't let a record-keeping bug mask the real error


def _run_backtest_tool(args: dict) -> list[TextContent]:
    _ensure_backtests_loaded()
    ea = (args.get("ea_name") or "").strip()
    symbol = (args.get("symbol") or "").strip()
    period = (args.get("period") or "").strip().upper()
    from_date = (args.get("from_date") or "").strip()
    to_date = (args.get("to_date") or "").strip()
    deposit = args.get("deposit", 10000) or 10000
    leverage = args.get("leverage", 100) or 100
    currency = (args.get("currency") or "USD").strip()
    overrides = args.get("input_overrides") or {}

    if not ea or not symbol or not period or not from_date or not to_date:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "ea_name / symbol / period / from_date / to_date 必填"},
            ensure_ascii=False))]

    install_dir = _resolve_mt5_install_dir()
    data_dir = _resolve_mt5_data_dir()

    # When a SEPARATE backtest MT5 install is configured (recommended —
    # full isolation from live), redirect the spawn to that one. This is
    # set by the easydeal-client UI under 设置 → 回测环境. The live
    # install remains untouched so user's running EAs aren't disturbed.
    backtest_override = os.getenv("EASYDEAL_BACKTEST_INSTALL_DIR")
    if backtest_override and os.path.isdir(backtest_override):
        install_dir = backtest_override
        # In /portable mode the tester treats install_dir as data_dir.
        data_dir = backtest_override

    if not install_dir:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "未找到 MT5 安装目录。请在客户端「设置」→「回测环境」配置回测专用 MT5 路径，或在「实盘登录」启动主 MT5。"},
            ensure_ascii=False))]

    # 用 terminal64.exe 普通名启动。MT5 自检不允许改名启动（之前曾把副本
    # 改成 terminal64_backtest.exe 的方案被 ExitCode 10001 否了），这里就只认
    # 原名 / 32 位老版 terminal.exe 兜底。
    terminal_exe = None
    for candidate in ("terminal64.exe", "terminal.exe"):
        p = os.path.join(install_dir, candidate)
        if os.path.isfile(p):
            terminal_exe = p
            break
    if not terminal_exe:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": f"terminal64.exe 不在 {install_dir} — 先在客户端做步骤 1：复制主 MT5 → 副本"},
            ensure_ascii=False))]

    # Decide portable vs attached mode early so the rest of the function
    # can branch on it. (NOTE: this used to be defined further down, which
    # caused a NameError when `primary_experts_dir` referenced it. Moved up.)
    #
    #   PORTABLE mode (preferred): dedicated demo account, auto-login from
    #     <install>/origin.dat. Triggered by EASYDEAL_BACKTEST_PORTABLE=1 +
    #     LOGIN/SERVER env vars + origin.dat present in the spawn install dir.
    #   ATTACHED mode (fallback): use the currently-running MT5's account.
    # Decide whether we have a viable backtest configuration BEFORE spawning.
    # Three states:
    #   1. portable_intended + origin.dat present → use_portable=True, all set
    #   2. portable_intended + origin.dat MISSING → return setup error (need bootstrap)
    #   3. no portable env at all → fall through to attached mode (will fail
    #      against a running live MT5 due to data-dir lock — also surface this)
    portable_intended = (
        os.getenv("EASYDEAL_BACKTEST_PORTABLE") == "1"
        and os.getenv("EASYDEAL_BACKTEST_LOGIN")
        and os.getenv("EASYDEAL_BACKTEST_SERVER")
    )
    # Newer MT5 builds save login state at Config/accounts.dat instead of
    # the legacy origin.dat — check either one.
    origin_dat   = os.path.join(install_dir, "origin.dat")
    accounts_dat = os.path.join(install_dir, "Config", "accounts.dat")
    has_credentials = os.path.isfile(origin_dat) or os.path.isfile(accounts_dat)
    use_portable = portable_intended and has_credentials

    # Preflight error: portable was intended but credentials weren't bootstrapped.
    # This is THE specific configuration error users hit most often. Tell them
    # exactly which UI button to click — no generic "check this and that".
    if portable_intended and not has_credentials:
        _record_preflight_failure(ea, symbol, period, from_date, to_date,
                                   deposit, leverage, currency,
                                   "backtest_credentials_missing",
                                   "缺 Config/accounts.dat — 还没 bootstrap 回测账号登录")
        return [TextContent(type="text", text=json.dumps({
            "ok": False,
            "error_code": "backtest_credentials_missing",
            "error": ("回测账号还没在 portable 模式下登录过 — 安装目录里"
                      "没有缓存的登录凭据 (Config/accounts.dat)。"),
            "diagnostic": {
                "install_dir":           install_dir,
                "expected_accounts_dat": accounts_dat,
                "backtest_login":        os.getenv("EASYDEAL_BACKTEST_LOGIN"),
                "backtest_server":       os.getenv("EASYDEAL_BACKTEST_SERVER"),
            },
            "next_steps": [
                "客户端窗口 → 设置 tab → 回测环境 卡片",
                "确认账号 / 服务器已经填好（建议 Exness 模拟账号）",
                "点「保存并启动登录（/portable）」按钮",
                "弹出来的 MT5 里：文件 → 登录到交易账户 → 输账号密码 →",
                "  勾「保存账户信息」→ 登录 → **完全退出 MT5**（右上角 X 关掉）",
                f"完成后凭据会出现在 {accounts_dat}",
                "回客户端再点一次「检测就绪」确认绿色 ✓",
                "之后所有回测自动用这套配置，不用再手动登录",
            ],
        }, ensure_ascii=False))]

    # In portable mode the tester reads/writes inside install_dir; otherwise
    # it uses the standard data_dir under %APPDATA%. Pick the right Experts/
    # location accordingly so deploy + compile lands where the tester reads.
    primary_experts_dir = (
        os.path.join(install_dir, "MQL5", "Experts") if use_portable
        else (os.path.join(data_dir, "MQL5", "Experts") if data_dir
              else os.path.join(install_dir, "MQL5", "Experts"))
    )

    # Verify EA is compiled. Check primary first, then alternates.
    ex5_candidates = [os.path.join(primary_experts_dir, f"{ea}.ex5")]
    if data_dir and primary_experts_dir != os.path.join(data_dir, "MQL5", "Experts"):
        ex5_candidates.append(os.path.join(data_dir, "MQL5", "Experts", f"{ea}.ex5"))
    if primary_experts_dir != os.path.join(install_dir, "MQL5", "Experts"):
        ex5_candidates.append(os.path.join(install_dir, "MQL5", "Experts", f"{ea}.ex5"))
    ex5_path = next((p for p in ex5_candidates if os.path.isfile(p)), None)

    # Auto-deploy: if no .ex5 exists yet, look for the .mq5 source in the
    # workspace's strategies/ dir (or already in MT5 Experts), copy it into
    # MT5 Experts, and compile via MetaEditor. This makes the chat-driven
    # "create EA → backtest" flow seamless: the user shouldn't have to
    # manually copy files between dirs.
    if not ex5_path:
        deploy_log: list[str] = []
        deploy_target_dir = primary_experts_dir
        os.makedirs(deploy_target_dir, exist_ok=True)
        target_mq5 = os.path.join(deploy_target_dir, f"{ea}.mq5")

        # Source candidate paths
        workspace_dir = os.getenv("EASYDEAL_WORKSPACE_DIR")
        mq5_candidates = []
        if workspace_dir:
            mq5_candidates.append(os.path.join(workspace_dir, "strategies", f"{ea}.mq5"))
        mq5_candidates.append(os.path.join(deploy_target_dir, f"{ea}.mq5"))

        src_mq5 = next((p for p in mq5_candidates if os.path.isfile(p)), None)
        if not src_mq5:
            return [TextContent(type="text", text=json.dumps(
                {"ok": False,
                 "error": f"未找到 {ea}.ex5 或 .mq5 源码。",
                 "looked_for_ex5": ex5_candidates,
                 "looked_for_mq5": mq5_candidates,
                 "hint": "请先在对话里让 Claude 用 Write 工具把 EA 源码写到 strategies/<EA>.mq5"},
                ensure_ascii=False))]

        # Copy .mq5 into Experts/ if it isn't already there.
        if os.path.abspath(src_mq5) != os.path.abspath(target_mq5):
            import shutil
            shutil.copy2(src_mq5, target_mq5)
            deploy_log.append(f"copied {os.path.basename(src_mq5)} → {target_mq5}")
        else:
            deploy_log.append(f"using existing {target_mq5}")

        # Compile with MetaEditor
        metaeditor = _get_metaeditor_path()
        if not metaeditor or not os.path.isfile(metaeditor):
            return [TextContent(type="text", text=json.dumps(
                {"ok": False,
                 "error": "找不到 MetaEditor64.exe。请在客户端「设置」里设置 MT5 安装目录，或设置 METAEDITOR_PATH 环境变量。",
                 "deploy_log": deploy_log},
                ensure_ascii=False))]

        try:
            import subprocess as _sp
            compile_cmd = [metaeditor, "/portable", f"/compile:{target_mq5}", f"/log:{target_mq5}.compile.log"]
            cres = _sp.run(compile_cmd, capture_output=True, timeout=120)
            deploy_log.append(f"compile rc={cres.returncode}")
        except _sp.TimeoutExpired:
            return [TextContent(type="text", text=json.dumps(
                {"ok": False, "error": "编译超时（>120s）", "deploy_log": deploy_log},
                ensure_ascii=False))]
        except Exception as exc:
            return [TextContent(type="text", text=json.dumps(
                {"ok": False, "error": f"编译失败：{exc}", "deploy_log": deploy_log},
                ensure_ascii=False))]

        # Re-check for .ex5
        target_ex5 = os.path.join(deploy_target_dir, f"{ea}.ex5")
        if not os.path.isfile(target_ex5):
            # Read compile log if present
            compile_log_text = ""
            log_path = f"{target_mq5}.compile.log"
            if os.path.isfile(log_path):
                try:
                    with open(log_path, "rb") as f:
                        raw = f.read()
                    for enc in ("utf-16", "utf-8"):
                        try:
                            compile_log_text = raw.decode(enc, errors="ignore")
                            break
                        except Exception:
                            continue
                except Exception:
                    pass
            return [TextContent(type="text", text=json.dumps(
                {"ok": False,
                 "error": "MetaEditor 编译没有产出 .ex5（语法错？）",
                 "deploy_log": deploy_log,
                 "compile_log": compile_log_text[-2000:] if compile_log_text else "(no log)",
                 "target_ex5": target_ex5},
                ensure_ascii=False))]
        ex5_path = target_ex5
        deploy_log.append(f"compiled → {target_ex5}")

    # Resolve which account the tester logs into. `use_portable` already
    # determined upstream → derive credentials accordingly.
    if use_portable:
        acct_login = int(os.getenv("EASYDEAL_BACKTEST_LOGIN"))
        acct_server = os.getenv("EASYDEAL_BACKTEST_SERVER")
    else:
        acct_login = None
        acct_server = None
        try:
            acct = mt5.account_info()
            if acct:
                acct_login = acct.login
                acct_server = acct.server
        except Exception:
            pass

        if not acct_login or not acct_server:
            _record_preflight_failure(ea, symbol, period, from_date, to_date,
                                       deposit, leverage, currency,
                                       "backtest_no_account",
                                       "回测无可用账号")
            return [TextContent(type="text", text=json.dumps({
                "ok": False,
                "error_code": "backtest_no_account",
                "error": ("回测无可用账号 —— 既没配回测专用账号（推荐），"
                          "你日常那个 MT5 也没在线 / Python 没法 attach。"),
                "diagnostic": {
                    "portable_env_set":  bool(os.getenv("EASYDEAL_BACKTEST_PORTABLE")),
                    "origin_dat_exists": os.path.isfile(os.path.join(install_dir, "origin.dat")),
                    "install_dir":       install_dir,
                },
                "next_steps": [
                    "客户端窗口 → 设置 tab → 回测环境 卡片",
                    "「回测 MT5 安装目录」留空（用主 MT5 那份即可，不论你日常用的是实盘还是模拟）",
                    "填回测账号 / 服务器（**用 demo 模拟账号**，回测就别动实盘资金了）",
                    "点「保存并启动登录（/portable）」按钮",
                    "弹出的 MT5 里登录回测账号、勾「保存账户信息」、关掉",
                    "回客户端，下次回测自动用 portable 模式跟主 MT5 并行，不冲突（主 MT5 是实盘还是模拟都不会被影响）",
                ],
            }, ensure_ascii=False))]

    # Even with valid account info, attached-mode (no /portable) can fail
    # silently when live MT5 is running because the spawn fights for the
    # data-dir lock. Surface this BEFORE we spawn so the user gets useful
    # guidance instead of an opaque exit_code.
    if not use_portable and data_dir:
        # Heuristic: live MT5 has data_dir; if we'd spawn into the same data_dir
        # without /portable, MT5 will exit immediately with the lock error.
        try:
            ti = mt5.terminal_info()
            live_data_path = ti.data_path if ti else None
        except Exception:
            live_data_path = None
        if live_data_path and os.path.normcase(os.path.abspath(live_data_path)) == \
                              os.path.normcase(os.path.abspath(data_dir)):
            _record_preflight_failure(ea, symbol, period, from_date, to_date,
                                       deposit, leverage, currency,
                                       "backtest_data_dir_conflict",
                                       f"你日常那个 MT5 占着相同的数据目录 {data_dir}")
            # 细化 next_steps —— 命中这个错误意味着 portable_intended=False，
            # 三种成因（按客户端用户做到哪一步分）：
            #   A. 完全没配回测环境 (没 EASYDEAL_BACKTEST_INSTALL_DIR + 没 LOGIN/SERVER)
            #   B. 副本目录建了但还没在副本里登录 demo (INSTALL_DIR 在，accounts.dat 不在)
            #   C. 副本登录了但「高级」面板账号字段没填 (creds 在，LOGIN/SERVER env 缺)
            bt_install = os.getenv("EASYDEAL_BACKTEST_INSTALL_DIR")
            has_creds = False
            if bt_install:
                has_creds = (os.path.isfile(os.path.join(bt_install, "Config", "accounts.dat"))
                          or os.path.isfile(os.path.join(bt_install, "origin.dat")))
            has_login_env = bool(os.getenv("EASYDEAL_BACKTEST_LOGIN") and os.getenv("EASYDEAL_BACKTEST_SERVER"))

            if not bt_install:
                case_label = "回测环境完全没配"
                next_steps = [
                    "客户端「设置」→ 回测环境 卡片",
                    "步骤 1「选个目录存副本」→ 留空让客户端自动选 → 点「复制主 MT5 → 副本」",
                    "步骤 2 启动副本 → **用 demo 模拟号登录**（回测就别拿实盘账号去跑了）→ 必须勾「保存账户信息」→ 关掉",
                    "步骤 2 「高级」展开 → 填 demo 账号 + 服务器 → 保存",
                    "步骤 3 检测就绪",
                    "新开一条对话再发回测请求即可（已开的对话拿的是旧 env，不会热加载）",
                ]
            elif not has_creds:
                case_label = "副本目录建了但还没在副本里登录 demo"
                next_steps = [
                    f"副本目录已建：{bt_install}",
                    "客户端「设置」→ 回测环境 → 步骤 2「启动副本 MT5」",
                    "弹出的副本 MT5 里：文件 → 登录到交易账户 → **用 demo 模拟号登录**（回测专用，别用实盘号 —— 别拿真钱去跑）",
                    "⚠ 必须勾「保存账户信息」 → 关掉副本窗口",
                    "步骤 2「高级」展开 → 填刚才用的 demo 账号 + 服务器 → 保存",
                    "新开一条对话再发回测请求",
                ]
            elif not has_login_env:
                case_label = "差「高级面板」里账号 / 服务器字段"
                next_steps = [
                    f"副本目录 + demo 凭据都已就绪：{bt_install}",
                    "只差「设置」→ 回测环境 → 步骤 2「高级：手动指定账号 / 服务器」展开里的两个字段",
                    "账号填步骤 2 你登录副本时用的 demo 账号号（数字）",
                    "服务器填那个 demo 的服务器名（如 Exness-MT5Trial14）",
                    "点「保存修改」",
                    "**新开一条 AI 对话**再发回测请求（关键 — 已开的对话里 MCP 子进程拿的是旧 env，不会热加载）",
                ]
            else:
                # 兜底：env 都齐但还是 use_portable=False，多半 has_credentials 检测出问题
                case_label = "环境 env 齐全但 use_portable 还是 False（罕见）"
                next_steps = [
                    "客户端「设置」→ 回测环境 → 步骤 3 点「检测就绪」看返回，"
                    "确认 portable_ready=true",
                    "若不就绪 → 按返回的具体提示修",
                    "或：临时关掉主 MT5 跑完回测再启动（不推荐 — 主 MT5 上挂的 EA 会中断）",
                ]

            return [TextContent(type="text", text=json.dumps({
                "ok": False,
                "error_code": "backtest_data_dir_conflict",
                "error": (f"回测会跟正在运行的主 MT5 抢同一个数据目录锁，"
                          f"spawn 会立即退出 (exit_code 3294954943)。具体卡在：{case_label}。"),
                "diagnostic": {
                    "live_data_dir":           live_data_path,
                    "spawn_data_dir":          data_dir,
                    "case":                    case_label,
                    "backtest_install_dir":    bt_install,
                    "has_credentials":         has_creds,
                    "has_login_server_env":    has_login_env,
                },
                "next_steps": next_steps,
            }, ensure_ascii=False))]

    # ---- Symbol preflight (CONDITIONAL — 0.2.8 重写) ----
    # MT5 Python SDK 是单实例 IPC，只能查它当前 attach 的那个 MT5（= 主 MT5
    # / live MT5）。当回测 broker 跟主 MT5 broker 不同（典型：主 = Exness 用
    # XAUUSDm，回测 = MetaQuotes-Demo 用 XAUUSD），用主 MT5 SDK 查回测要用的
    # 品种，会得到错误结论 —— 这就是 EZDL-... 用户反复踩的坑：
    #   - 用 XAUUSD 跑 → preflight（查 Exness）说"不存在"，建议改 XAUUSDm
    #   - 用 XAUUSDm 跑 → preflight（查 Exness）说"存在"，spawn 后回测
    #     MT5（MetaQuotes-Demo）实际报"symbol XAUUSDm not exist"
    #
    # 三档逻辑：
    #   (a) 没活的 MT5 → 跳 preflight，让 tester 自己说存不存在（postmortem
    #       拿 hint）
    #   (b) 有活的 MT5 + 回测 broker 跟它**同一个 broker** → 用 SDK 严格校验
    #       （之前的 candidates fuzzy 匹配那套）
    #   (c) 有活的 MT5 + 回测 broker **不同**（用 EASYDEAL_BACKTEST_LOGIN 是
    #       不是 != live login 来判断）→ 跳 preflight + 在 logging 里留警告。
    #       这种情况 SDK 查到的品种列表对回测来说不算数，强行校验只会误导。
    try:
        _live_terminal = mt5.terminal_info()
    except Exception:
        _live_terminal = None
    try:
        _live_account = mt5.account_info() if _live_terminal is not None else None
    except Exception:
        _live_account = None

    _bt_login_env = os.getenv("EASYDEAL_BACKTEST_LOGIN")
    _live_login = getattr(_live_account, "login", None) if _live_account else None
    _cross_broker = bool(
        use_portable
        and _bt_login_env
        and _live_login
        and str(_live_login) != str(_bt_login_env)
    )

    if _live_terminal is not None and not _cross_broker:
        try:
            sym_info = mt5.symbol_info(symbol)
        except Exception:
            sym_info = None
        if not sym_info:
            import re as _re
            base = _re.sub(r"[._\-mz0-9]+$", "", symbol).strip() or symbol
            try:
                all_syms = mt5.symbols_get(f"*{base}*") or []
                candidates = sorted(set(s.name for s in all_syms))[:20]
            except Exception:
                candidates = []
            _record_preflight_failure(ea, symbol, period, from_date, to_date,
                                       deposit, leverage, currency,
                                       "backtest_symbol_not_found",
                                       f"品种 {symbol} 不存在 (候选: {', '.join(candidates[:5])})")
            return [TextContent(type="text", text=json.dumps({
                "ok": False,
                "error_code": "backtest_symbol_not_found",
                "error": f"品种 {symbol} 在当前账户（{acct_server}）的市场观察 / 商品列表里不存在。",
                "diagnostic": {
                    "requested_symbol":   symbol,
                    "broker_server":      acct_server,
                    "fuzzy_match_count":  len(candidates),
                    "candidates":         candidates,
                    "tip": ("很多券商对主流品种加后缀，比如 Exness 用 XAUUSDm / EURUSDm，"
                            "IC Markets 用 EURUSD.m / GBPUSD.m。直接看 candidates "
                            "列表，挑最贴近你要测的那一个重新发起 run_backtest。"),
                },
                "next_steps": [
                    f"用 get_market_info / 列表里的 candidates 重新选一个真实存在的品种",
                    "重新调 run_backtest，把 symbol 参数改成正确的全名",
                    "（不需要用户去 MT5 里手动加品种，直接换名即可）",
                ],
            }, ensure_ascii=False))]
    elif _cross_broker:
        # 跨 broker，跳过严格校验。给 Python logger 留一行 + 在工具响应里
        # 也声明，让 Claude 别误以为我们已经"确认"了品种 —— spawn 后真的
        # 不存在，就让 postmortem 给确切原因。
        logging.warning(
            "[backtest] cross-broker preflight skipped: live login=%s broker=%s != bt login=%s broker=%s; "
            "symbol %s will be validated by tester at spawn",
            _live_login, getattr(_live_account, "server", "?"),
            _bt_login_env, acct_server, symbol,
        )
    # else: no live MT5 → symbol check skipped; we trust the user-supplied
    # symbol. Replica MT5 will validate it on its own when starting tester.

    # ---- Lock-conflict preflight + auto-cleanup ----
    # In portable mode, the data dir IS the install dir. If a terminal64.exe
    # is already running with our backtest install_dir as its exe dir, the
    # new spawn would fight for the same data-dir lock and silently exit.
    #
    # Auto-cleanup heuristic:
    #   - install_dir IS our backtest replica (because we're in /portable
    #     mode and use_portable=True implies an explicit override or the
    #     replica was bootstrapped) → the only thing that runs from the
    #     replica is OUR previous backtest spawns. They sometimes don't
    #     honour ShutdownTerminal=1 (visual mode, race condition, etc.) →
    #     leftover process. **Auto-kill is safe** because:
    #       1. The replica is dedicated to backtesting (separate dir from
    #          the live install — we refuse to copy onto the live dir)
    #       2. The user's actual live trading runs from the LIVE install
    #          (different exe path, different dir)
    #       3. The killed process is by definition done with its job
    #          (a still-running tester would either be at "running" status
    #          in our records, or it's a zombie that's not making progress)
    #   - If we somehow hit a process whose exe is in the LIVE install
    #     (shouldn't happen in portable mode because install_dir = replica
    #     path here, but defensively check) → never kill, abort with the
    #     classic preflight error so the user manages it.
    if use_portable:
        try:
            import psutil as _psu  # type: ignore
            inst_norm = os.path.normcase(os.path.abspath(install_dir))
            killed_pids = []
            blocking_live_pid = None
            for p in _psu.process_iter(["name", "exe"]):
                try:
                    n = (p.info.get("name") or "").lower()
                    if n not in ("terminal64.exe", "terminal.exe"):
                        continue
                    exe_path = p.info.get("exe") or ""
                    exe_dir = os.path.dirname(exe_path)
                    if os.path.normcase(os.path.abspath(exe_dir)) != inst_norm:
                        continue
                    # Match — this process is locking our backtest dir.
                    # Sanity: it MUST be in the replica, NOT the live install.
                    # (We're in portable mode + install_dir is the spawn target,
                    # so any match here is by definition a replica process.)
                    pid = p.pid
                    try:
                        p.kill()
                        killed_pids.append(pid)
                    except (_psu.NoSuchProcess, _psu.AccessDenied) as exc:
                        # Couldn't kill (perm denied, race, etc.) — fall back
                        # to the user-managed abort path.
                        blocking_live_pid = pid
                except (_psu.NoSuchProcess, _psu.AccessDenied):
                    continue
            # If we killed any leftovers, give the OS a moment to release
            # file handles (esp. the lock file in <install>/terminal.cnf).
            if killed_pids:
                logging.info("[backtest] auto-killed leftover replica MT5 pid(s) %s; "
                             "proceeding with new spawn", killed_pids)
                time.sleep(1.5)
            # Couldn't auto-clean — abort with the existing user-guided path.
            if blocking_live_pid is not None:
                _record_preflight_failure(ea, symbol, period, from_date, to_date,
                                           deposit, leverage, currency,
                                           "backtest_install_dir_locked",
                                           f"安装目录已被 pid {blocking_live_pid} 的 MT5 占用（无法自动清理）")
                return [TextContent(type="text", text=json.dumps({
                    "ok": False,
                    "error_code": "backtest_install_dir_locked",
                    "error": (f"安装目录 {install_dir} 已经有一个 MT5 实例在跑"
                              f" (pid {blocking_live_pid})，但权限不足无法自动清理。"),
                    "diagnostic": {
                        "running_pid": blocking_live_pid,
                        "install_dir": install_dir,
                    },
                    "next_steps": [
                        f"在任务管理器手动结束 pid {blocking_live_pid} 那个 MT5 进程",
                        "然后重新发起回测请求",
                        "如果反复出现，把 EasyDeal 以管理员身份运行可避免",
                    ],
                }, ensure_ascii=False))]
        except ImportError:
            pass  # psutil missing — skip the check, fall through to spawn

    # Generate ID, INI, paths
    bt_id = f"bt_{int(time.time() * 1000):x}"
    report_name = f"easydeal-test-{bt_id}"
    ini_path = os.path.join(install_dir, "Config", f"easydeal-test-{bt_id}.ini")

    ini_content = _build_tester_ini(
        ea=ea, symbol=symbol, period=period,
        from_date=from_date, to_date=to_date,
        deposit=deposit, leverage=leverage, currency=currency,
        overrides=overrides, report_name=report_name,
        login=acct_login, server=acct_server,
    )
    try:
        _write_ini(ini_path, ini_content)
    except Exception as exc:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": f"写入 INI 失败：{exc}"}, ensure_ascii=False))]

    # Report location — MT5 build 5xxx behaviour (empirically observed):
    # when the INI's `Report=name` field has NO directory component, MT5
    # writes the .htm directly into the *data dir root*, NOT into a
    # `Reports/` subdir. Older builds / docs reference `Reports/` so we
    # still check there as a fallback.
    #
    # In /portable mode, data_dir = install_dir (because of /portable),
    # so reports land in <install_dir>/<name>.htm.
    # In attached mode, they land in <data_dir>/<name>.htm.
    report_candidates = []
    # Roots that could hold the report file. Order = check first wins.
    report_roots = []
    if use_portable:
        report_roots = [install_dir]
    else:
        if data_dir: report_roots.append(data_dir)
        report_roots.append(install_dir)
    # Side-companion: the .htm comes with -hst.png / -mfemae.png / -holding.png
    # / .png siblings written to the same dir, so this dir is the truth.
    for root in report_roots:
        report_candidates.append(os.path.join(root, f"{report_name}.htm"))
        report_candidates.append(os.path.join(root, f"{report_name}.html"))
        # Legacy <root>/Reports/ subdir fallback (older builds, docs)
        report_candidates.append(os.path.join(root, "Reports", f"{report_name}.htm"))
        report_candidates.append(os.path.join(root, "Reports", f"{report_name}.html"))

    # In portable mode add the /portable flag so the spawned tester uses
    # install_dir as its data dir (with our pre-saved origin.dat for auto-login).
    #
    # IMPORTANT — manual quoting: when ini_path contains spaces (e.g.
    # "D:\Projects\easy_deal_agent\MetaTrader 5 EXNESS_backtest\Config\..."),
    # subprocess.list2cmdline wraps the whole "/config:path with space" arg
    # in double-quotes:    "/config:D:\...\file.ini"
    # but MT5 expects:     /config:"D:\...\file.ini"
    # When MT5 sees the former, it treats the quoted string AS the path
    # (including the leading "/config:") and silently fails:
    #     `cannot load config "...\file.ini""`
    # We bypass list2cmdline by building the command line ourselves and
    # passing it as a string. Popen on Windows then hands it directly to
    # CreateProcess unmodified.
    def _winq(s):
        return '"' + str(s).replace('"', '\\"') + '"' if (' ' in str(s) or '\t' in str(s)) else str(s)
    cmd_parts = [_winq(terminal_exe)]
    if use_portable:
        cmd_parts.append("/portable")
    # /profile: forces MT5 to load a SPECIFIC profile by name — if the named
    # profile doesn't exist, MT5 creates an empty one. We use a dedicated
    # name so the tester always boots into a CLEAN, EA-free workspace,
    # regardless of what chart-attached EAs happen to live in the replica's
    # Profiles/ dir. Without this, copies / restored backups / users who
    # point backtest_install_dir at an existing populated MT5 would see
    # their live chart layout (including attached EAs) auto-load alongside
    # the strategy tester. This is belt-and-suspenders on top of the copy
    # exclusion — the copy step already skips Profiles/, but this protects
    # against bypasses (manual config, restored backups, etc.).
    cmd_parts.append("/profile:easydeal-tester")
    cmd_parts.append("/config:" + _winq(ini_path))
    cmd = " ".join(cmd_parts)
    spawn_flags = (
        (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
        if os.name == "nt" else 0
    )

    bt_record = {
        "ea": ea, "symbol": symbol, "period": period,
        "from_date": from_date, "to_date": to_date,
        "deposit": deposit, "leverage": leverage, "currency": currency,
        # input_overrides — the EA parameters Claude / user passed to override
        # the source defaults. Persisted so the user can see "this run used
        # InpFirstLots=0.05 InpStep=1.2" etc. when reviewing history later.
        # Empty {} = used source defaults.
        "input_overrides": dict(overrides) if overrides else {},
        # Report account (so history shows which broker/account the run
        # actually went against — useful when user has multiple).
        "account": {"login": acct_login, "server": acct_server},
        "ini_path": ini_path,
        "report_name": report_name,
        "report_candidates": report_candidates,
        "spawn_cmd": cmd,
        "spawn_cwd": install_dir,
        "spawn_creationflags": spawn_flags,
        "viewed": False,
    }

    # If the spawn budget is full, queue this run instead of starting it.
    # get_backtest_status will dequeue automatically as running tasks finish.
    if _running_backtests_count() >= _MAX_CONCURRENT_BACKTESTS:
        bt_record["status"] = "queued"
        bt_record["queued_at"] = time.time()
        _backtests[bt_id] = bt_record
        _trim_backtests()
        _save_persisted_backtests()
        position = _queue_position(bt_id)
        return [TextContent(type="text", text=json.dumps({
            "ok": True,
            "data": {
                "backtest_id": bt_id,
                "status": "queued",
                "queue_position": position,
                "ea": ea, "symbol": symbol, "period": period,
                "from_date": from_date, "to_date": to_date,
                "message": (
                    f"已有 {_running_backtests_count()} 个回测在跑，本次排在第 {position} 位等待。"
                    "前面的跑完会自动接力，无需手工操作。继续轮询 get_backtest_status 即可。"
                ),
            },
        }, ensure_ascii=False))]

    # Otherwise spawn immediately
    bt_record["queued_at"] = time.time()
    _backtests[bt_id] = bt_record
    if not _spawn_backtest_now(bt_id, bt_record):
        _save_persisted_backtests()
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": f"启动 MT5 测试进程失败：{bt_record.get('error')}"},
            ensure_ascii=False))]
    _trim_backtests()
    _save_persisted_backtests()

    # Auto-register the polling task in scheduler.db. Removes the LLM from
    # the loop — Claude was claiming "已设置自动检查任务" without actually
    # calling schedule_task. Now the scheduler sidecar fires every minute,
    # spawns a headless claude turn that calls get_backtest_status, and
    # cancels itself on terminal status.
    poll_ok, poll_info = _auto_schedule_backtest_poll(bt_id, ea, symbol)
    if poll_ok:
        logging.info("[backtest] %s: auto-scheduled poll task %s", bt_id, poll_info)
    else:
        logging.warning("[backtest] %s: auto-schedule failed: %s — Claude must "
                        "manually call get_backtest_status", bt_id, poll_info)

    mode_msg = (
        f"使用 portable 模式（专用账号 {acct_login}@{acct_server}），跟主 MT5 互不干扰。"
        if use_portable
        else "使用主 MT5 账号 attached 模式。如主 MT5 同时在跑，新实例可能弹登录框需要手动点击。"
    )
    return [TextContent(type="text", text=json.dumps({
        "ok": True,
        "data": {
            "backtest_id": bt_id,
            "status": "running",
            "mode": "portable" if use_portable else "attached",
            "ea": ea, "symbol": symbol, "period": period,
            "from_date": from_date, "to_date": to_date,
            "ini_path": ini_path,
            "expected_report": report_candidates[0],
            "account": {"login": acct_login, "server": acct_server},
            "auto_poll_task_id": poll_info if poll_ok else None,
            "auto_poll_status": "scheduled" if poll_ok else f"failed: {poll_info}",
            "message": (
                "回测已启动。" + mode_msg + "\n"
                "1 年 H1 数据通常 1-3 分钟，M5 数据可能 5-10 分钟。\n"
                "请用 get_backtest_status 轮询，参数：{\"backtest_id\": \"" + bt_id + "\"}"
            ),
        },
    }, ensure_ascii=False))]


def _get_backtest_status_tool(args: dict) -> list[TextContent]:
    _ensure_backtests_loaded()
    bt_id = (args.get("backtest_id") or "").strip()
    if not bt_id:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": "backtest_id 必填"}, ensure_ascii=False))]
    bt = _backtests.get(bt_id)
    if not bt:
        return [TextContent(type="text", text=json.dumps(
            {"ok": False, "error": f"未找到回测 {bt_id}（可能已被回收）"},
            ensure_ascii=False))]

    # Status: queued — still waiting for a spawn slot. Try to promote
    # something first in case capacity opened up since last call.
    _schedule_pending_backtests()
    if bt.get("status") == "queued":
        position = _queue_position(bt_id)
        wait_seconds = int(time.time() - (bt.get("queued_at") or time.time()))
        return [TextContent(type="text", text=json.dumps({
            "ok": True,
            "data": {
                "backtest_id": bt_id,
                "status": "queued",
                "queue_position": position,
                "wait_seconds": wait_seconds,
                "ea": bt["ea"], "symbol": bt["symbol"], "period": bt["period"],
                "message": f"排队中（前面还有 {position - 1} 个）— 前一个跑完会自动接力。",
            },
        }, ensure_ascii=False))]

    proc = bt.get("proc")
    elapsed = int(time.time() - bt.get("started_at", time.time()))

    # Records loaded from backtests.json (across MCP-process restarts) have
    # status="running" but no live `proc` handle — the spawn happened in a
    # previous MCP child that's now dead. We can't poll() it, but we CAN
    # finalise from disk evidence:
    #   - Report .htm exists in candidates → tester finished cleanly,
    #     just nobody updated the record. Parse + mark "ok".
    #   - No report AND no terminal64.exe alive in install_dir → spawn
    #     died without producing report. Mark "finished_no_report".
    #   - No report BUT a terminal64.exe is alive in install_dir → still
    #     genuinely running (in another process); just report "running".
    if proc is None:
        # Build candidate list — prefer persisted report_candidates, fall
        # back to derivation from id + install dir for old records that
        # were persisted before we started saving the candidates field.
        candidates = list(bt.get("report_candidates") or [])
        if not candidates:
            report_name = f"easydeal-test-{bt_id}"
            spawn_cwd = bt.get("spawn_cwd") or ""
            override = os.getenv("EASYDEAL_BACKTEST_INSTALL_DIR") or ""
            install_guesses = [d for d in (spawn_cwd, override) if d]
            for root in install_guesses:
                for ext in ("htm", "html"):
                    candidates.append(os.path.join(root, f"{report_name}.{ext}"))
                    candidates.append(os.path.join(root, "Reports", f"{report_name}.{ext}"))
        report_path_disk = None
        for cand in candidates:
            try:
                if os.path.isfile(cand):
                    report_path_disk = cand
                    break
            except Exception:
                continue
        if report_path_disk:
            html = _read_report(report_path_disk)
            metrics = _parse_html_report(html) if html else {}
            bt["status"] = "ok"
            bt["finished_at"] = bt.get("finished_at") or os.path.getmtime(report_path_disk)
            bt["exit_code"] = bt.get("exit_code") or 0
            bt["metrics"] = metrics
            bt["report_path"] = report_path_disk
            bt["error"] = None
            _save_persisted_backtests()
            _schedule_pending_backtests()
            return [TextContent(type="text", text=json.dumps({
                "ok": True,
                "data": {
                    "backtest_id": bt_id,
                    "status": "ok",
                    "elapsed_seconds": elapsed,
                    "ea": bt.get("ea"), "symbol": bt.get("symbol"), "period": bt.get("period"),
                    "from_date": bt.get("from_date"), "to_date": bt.get("to_date"),
                    "report_path": report_path_disk,
                    "metrics": metrics,
                    "note": "记录从持久化文件恢复，没有活的 proc 句柄，但报告文件已存在 — 自动 finalise。",
                },
            }, ensure_ascii=False))]
        # No report — check if any MT5 is still running in the install dir
        # (= the spawn from prior MCP process is still alive somewhere)
        install_dir = bt.get("spawn_cwd") or ""
        external_alive = False
        try:
            import psutil as _psu  # type: ignore
            if install_dir:
                inst_norm = os.path.normcase(os.path.abspath(install_dir))
                for p in _psu.process_iter(["name", "exe"]):
                    try:
                        n = (p.info.get("name") or "").lower()
                        if n not in ("terminal64.exe", "terminal.exe"):
                            continue
                        ed = os.path.dirname(p.info.get("exe") or "")
                        if os.path.normcase(os.path.abspath(ed)) == inst_norm:
                            external_alive = True
                            break
                    except (_psu.NoSuchProcess, _psu.AccessDenied):
                        continue
        except ImportError:
            pass
        if external_alive:
            return [TextContent(type="text", text=json.dumps({
                "ok": True,
                "data": {
                    "backtest_id": bt_id,
                    "status": "running",
                    "elapsed_seconds": elapsed,
                    "ea": bt.get("ea"), "symbol": bt.get("symbol"), "period": bt.get("period"),
                    "note": "上次 spawn 还在跑（不在本 MCP 进程里），稍后再轮询。",
                },
            }, ensure_ascii=False))]
        # 0.3.0: Path A 的 race 兜底 —— 即使没 live proc 也没 external 进程，
        # 也要看看是不是 MT5 退出后刚好在 flush .htm 的窗口里。检查
        # install_dir 下任何 tester / terminal log 的最新 mtime，如果最近
        # 60s 内还在写 → 给 grace。
        try:
            recent_log_activity = False
            for sub in (["Tester", "logs"], ["Tester", "Logs"], ["Logs"]):
                d = os.path.join(install_dir, *sub)
                if not os.path.isdir(d):
                    continue
                for fn in os.listdir(d):
                    if not fn.endswith(".log"):
                        continue
                    fp = os.path.join(d, fn)
                    try:
                        if (time.time() - os.path.getmtime(fp)) < 60:
                            recent_log_activity = True
                            break
                    except Exception:
                        continue
                if recent_log_activity:
                    break
            if recent_log_activity:
                return [TextContent(type="text", text=json.dumps({
                    "ok": True,
                    "data": {
                        "backtest_id": bt_id,
                        "status": "running",
                        "elapsed_seconds": elapsed,
                        "ea": bt.get("ea"), "symbol": bt.get("symbol"), "period": bt.get("period"),
                        "note": (
                            "原 MCP 子进程已死，但 install_dir 下 MT5 日志最近 60s 内还在写"
                            " —— tester 退出但 .htm 还在 flush，先返 running 等下次 cron。"
                        ),
                    },
                }, ensure_ascii=False))]
        except Exception:
            pass
        # No proc, no report, no external MT5 alive → it's dead and lost.
        # 试着从 install_dir 下的 tester / terminal log 里挖出真原因，比
        # "spawn 死了" 这种泛泛说更有用。
        postmortem = _collect_backtest_postmortem(install_dir, bt.get("started_at") or 0)
        bt["status"] = "finished_no_report"
        bt["finished_at"] = bt.get("finished_at") or time.time()
        bt_error_msg = postmortem.get("hint") or "spawn 已退出但没生成报告（也没在 MT5 日志里抓到具体错因）"
        bt["error"] = bt.get("error") or bt_error_msg
        _save_persisted_backtests()
        return [TextContent(type="text", text=json.dumps({
            "ok": True,
            "data": {
                "backtest_id": bt_id,
                "status": "finished_no_report",
                "elapsed_seconds": elapsed,
                "ea": bt.get("ea"), "symbol": bt.get("symbol"), "period": bt.get("period"),
                "error_code": "backtest_no_report",
                "message": (
                    f"回测失败：{bt_error_msg}。详见 log_lines / next_steps。"
                ),
                "diagnostic": {
                    "install_dir": install_dir,
                    "log_files_checked": postmortem.get("log_files_checked") or [],
                    "log_lines":         postmortem.get("log_lines") or [],
                    "note": "从持久化文件恢复，原 MCP 子进程已死；以上 log_lines 是从 install_dir 下的 MT5 日志里抓的、spawn 启动后写的相关行。",
                },
                "next_steps": _backtest_next_steps_from_hint(postmortem.get("hint")),
            },
        }, ensure_ascii=False))]

    rc = proc.poll()

    if rc is None:
        # WATCHDOG — tester finished but MT5 didn't auto-shutdown.
        #
        # ShutdownTerminal=1 in the INI tells MT5 to quit after the tester
        # completes; works most of the time but can be skipped (visual mode,
        # race condition during cleanup, account auth dialog popping up
        # AFTER tester finished, etc.). Symptoms: report .htm exists but
        # process is still alive, holding the data-dir lock and blocking
        # the next backtest.
        #
        # Detection: if any of the report_candidates file already exists
        # AND it's not a stale leftover from a PREVIOUS backtest with the
        # same id (which can't happen — id is uniquely time-based per run).
        # If found → kill the process, treat it as if rc=0 (clean exit).
        report_path_early = None
        for cand in bt["report_candidates"]:
            if os.path.isfile(cand):
                report_path_early = cand
                break
        if report_path_early:
            try:
                proc.kill()
                proc.wait(timeout=3)
            except Exception:
                pass  # already dying or perm error; we'll fall through
            rc = proc.poll() if proc.poll() is not None else 0
            logging.info("[backtest] %s: tester report found but MT5 still alive — "
                         "force-killed and finalised (likely ShutdownTerminal=1 "
                         "skipped)", bt_id)
            # Fall through to the "rc is set" branch below which finalises
            # the record from the report.
        else:
            # Genuinely still running — soft-detect stuck states.
            hint = None
            if elapsed >= 30:
                hint = (
                    f"已经 {elapsed}s 了还没动静。如果你的主 MT5 在跑，"
                    "新 spawn 的 tester 实例很可能弹了登录确认框等你点击——"
                    "切到任务栏看看 MT5 是不是有未处理的对话框。点了登录之后 tester 会继续。"
                )
            elif elapsed >= 10 and _mt5_login_dialog_visible():
                hint = "检测到 MT5 登录对话框可见，请去点击登录按钮（账号已预填）。"
            return [TextContent(type="text", text=json.dumps({
                "ok": True,
                "data": {
                    "backtest_id": bt_id,
                    "status": "running",
                    "elapsed_seconds": elapsed,
                    "ea": bt["ea"], "symbol": bt["symbol"], "period": bt["period"],
                    **({"user_action_hint": hint} if hint else {}),
                },
            }, ensure_ascii=False))]

    # Process exited — find the report
    report_path = None
    for cand in bt["report_candidates"]:
        if os.path.isfile(cand):
            report_path = cand
            break

    if not report_path:
        # 0.3.0: 防 race condition —— MT5 tester 进程退出后还要 ~5-30s 才把
        # .htm 报告完全 flush 写盘。如果 cron 第一次 poll 正好抓在 process
        # exited 但 file 还没 flush 的窗口里，会误报 finished_no_report，把
        # 后面 cron 全 cancel，导致用户必须手动重问。
        # 解决：第一次看到 proc 退出 + 没报告 → 标记 exit_observed_at，
        # 返回 status="running_finalizing" 让 cron 再 poll 几次；超过 60s
        # 还没 .htm 才真判失败。
        now_ts = time.time()
        first_observed = bt.get("exit_observed_at")
        if not first_observed:
            bt["exit_observed_at"] = now_ts
            bt["exit_code_observed"] = rc
            _save_persisted_backtests()
            return [TextContent(type="text", text=json.dumps({
                "ok": True,
                "data": {
                    "backtest_id": bt_id,
                    "status": "running",
                    "elapsed_seconds": elapsed,
                    "ea": bt["ea"], "symbol": bt["symbol"], "period": bt["period"],
                    "note": (
                        f"MT5 进程刚退出（exit_code={rc}），但 .htm 报告还没 flush。"
                        "MT5 tester 退出后通常 5-30s 才落盘，先等下次 cron 再 check。"
                    ),
                },
            }, ensure_ascii=False))]
        # 已经观察到 exit 不止一次了，给个总宽限期 60s
        flush_grace_sec = 60
        wait_secs = int(now_ts - first_observed)
        if wait_secs < flush_grace_sec:
            return [TextContent(type="text", text=json.dumps({
                "ok": True,
                "data": {
                    "backtest_id": bt_id,
                    "status": "running",
                    "elapsed_seconds": elapsed,
                    "ea": bt["ea"], "symbol": bt["symbol"], "period": bt["period"],
                    "note": (
                        f"MT5 进程已退出 {wait_secs}s（grace={flush_grace_sec}s），"
                        ".htm 仍在 flush，再等下次 cron。"
                    ),
                },
            }, ensure_ascii=False))]
        # 超过 grace 还是没报告 → 真失败
        # 抓 MT5 日志找具体错因 —— 比单纯 exit_code 信息量大得多
        spawn_install = bt.get("spawn_cwd") or os.getenv("EASYDEAL_BACKTEST_INSTALL_DIR") or ""
        postmortem = _collect_backtest_postmortem(spawn_install, bt.get("started_at") or 0)
        bt["status"] = "finished_no_report"
        bt["finished_at"] = time.time()
        bt["exit_code"] = rc
        bt["error"] = postmortem.get("hint") or "no report file produced"
        _save_persisted_backtests()
        _schedule_pending_backtests()

        # Pattern-match the exit code to surface a precise next_steps list.
        # The unsigned ↔ signed conversion: rc & 0xFFFFFFFF then check.
        rc_signed = rc - (1 << 32) if rc >= (1 << 31) else rc
        # 优先用从日志里挖到的 hint，没 hint 才走 exit_code 模式匹配，再没匹配就泛泛 fallback
        if postmortem.get("hint"):
            next_steps = _backtest_next_steps_from_hint(postmortem["hint"])
        elif rc_signed == -1000012353:
            # MT5's "tester not started because the account is not specified".
            # Almost always means the spawn couldn't attach to a logged-in
            # session — i.e., backtest portable bootstrap was never done.
            next_steps = [
                "客户端窗口 → 设置 tab → 回测环境 卡片",
                "「回测 MT5 安装目录」留空（用主 MT5 那份即可，不论你日常用的是实盘还是模拟）",
                "填回测账号 / 服务器（**用 demo 模拟账号**，回测就别动实盘资金了）",
                "点「保存并启动登录（/portable）」按钮",
                "弹出来的 MT5 里：文件 → 登录到交易账户 → 输账号密码 →",
                "  勾「保存账户信息」→ 登录 → 关掉这个 MT5",
                "下次回测自动用这套配置，不用再手动登录",
            ]
        else:
            next_steps = _backtest_next_steps_from_hint(None)

        return [TextContent(type="text", text=json.dumps({
            "ok": True,
            "data": {
                "backtest_id": bt_id,
                "status": "finished_no_report",
                "exit_code": rc,
                "exit_code_signed": rc_signed,
                "elapsed_seconds": elapsed,
                "looked_in": bt["report_candidates"],
                "error_code": "backtest_no_report",
                "message": (
                    f"MT5 测试进程已退出 (exit_code={rc}) 但未生成报告。"
                    + (f"日志显示：{postmortem['hint']}" if postmortem.get("hint")
                       else "MT5 日志里也没抓到明确错因，按 next_steps 排查。")
                ),
                "diagnostic": {
                    "log_files_checked": postmortem.get("log_files_checked") or [],
                    "log_lines":         postmortem.get("log_lines") or [],
                },
                "next_steps": next_steps,
            },
        }, ensure_ascii=False))]

    html = _read_report(report_path)
    if not html:
        return [TextContent(type="text", text=json.dumps({
            "ok": True,
            "data": {
                "backtest_id": bt_id,
                "status": "report_unreadable",
                "exit_code": rc,
                "report_path": report_path,
                "message": "找到报告文件但读不出来（编码问题），请手动打开 .htm",
            },
        }, ensure_ascii=False))]

    metrics = _parse_html_report(html)
    bt["status"] = "ok"
    bt["finished_at"] = time.time()
    bt["exit_code"] = rc
    bt["metrics"] = metrics
    bt["report_path"] = report_path
    _save_persisted_backtests()
    _schedule_pending_backtests()  # capacity freed — promote next queued

    return [TextContent(type="text", text=json.dumps({
        "ok": True,
        "data": {
            "backtest_id": bt_id,
            "status": "ok",
            "exit_code": rc,
            "elapsed_seconds": elapsed,
            "ea": bt["ea"], "symbol": bt["symbol"], "period": bt["period"],
            "from_date": bt["from_date"], "to_date": bt["to_date"],
            "report_path": report_path,
            "metrics": metrics,
        },
    }, ensure_ascii=False))]


def _list_backtests_tool(args: dict | None = None) -> list[TextContent]:
    _ensure_backtests_loaded()
    args = args or {}
    limit = max(1, min(int(args.get("limit", 20)), 100))
    ea_filter = (args.get("ea") or "").strip().lower()

    items = []
    for bt_id, bt in _backtests.items():
        if ea_filter and (bt.get("ea") or "").lower() != ea_filter:
            continue
        proc = bt.get("proc")
        rc = proc.poll() if proc else None
        # If we have a live proc, that wins. Otherwise honour the persisted status.
        live_status = bt.get("status") if (rc is not None or proc is None) else "running"
        items.append({
            "backtest_id": bt_id,
            "ea": bt.get("ea"), "symbol": bt.get("symbol"), "period": bt.get("period"),
            "from_date": bt.get("from_date"), "to_date": bt.get("to_date"),
            "started_at": int(bt.get("started_at", 0)),
            "finished_at": int(bt.get("finished_at") or 0) or None,
            "elapsed_seconds": int(
                (bt.get("finished_at") or time.time()) - bt.get("started_at", time.time())
            ),
            "exit_code": bt.get("exit_code") if rc is None else rc,
            "status": live_status,
            # Headline metrics so Claude doesn't need a follow-up call per id
            "net_profit": (bt.get("metrics") or {}).get("net_profit"),
            "sharpe":     (bt.get("metrics") or {}).get("sharpe"),
            "trades":     (bt.get("metrics") or {}).get("trades"),
            "max_drawdown_pct": (bt.get("metrics") or {}).get("max_drawdown_pct"),
            "report_path": bt.get("report_path"),
            "error":       bt.get("error"),
        })
    items.sort(key=lambda x: x["started_at"], reverse=True)
    total = len(items)
    items = items[:limit]
    return [TextContent(type="text", text=json.dumps(
        {"ok": True, "data": {
            "backtests": items, "count": len(items), "total_in_history": total,
            "note": (f"返回最近 {len(items)} 条；总共有 {total} 条历史记录。"
                     "传 limit / ea 参数过滤。") if total > len(items) else None,
        }},
        ensure_ascii=False))]


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
