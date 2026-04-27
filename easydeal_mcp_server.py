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
        # so that mt5.terminal_info() and mt5.symbol_info() are available
        if not mt5.initialize():
            logging.error("MT5初始化失败")
            print("MT5初始化失败")
            self.running = False
            return

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
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
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
                deal_time = deal.time
                if isinstance(deal_time, int):
                    deal_time = datetime.fromtimestamp(deal_time)
                hour = deal_time.strftime("%Y-%m-%d %H:00:00")
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
                    "time": datetime.fromtimestamp(deal.time).strftime("%Y-%m-%d %H:%M:%S") if isinstance(deal.time, int) else deal.time.strftime("%Y-%m-%d %H:%M:%S"),
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
            "timestamp": datetime.now().isoformat(),
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
    date_prefix = datetime.now().strftime("%Y-%m-%d")

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
    Returns the .mq5 source filename (e.g. 'GMarket.mq5') or None.
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


def _get_strategy_file_path() -> str:
    """Return the absolute path to the EA .mq5 strategy file.

    Resolution order:
    1. EA_FILE_PATH env var (full path to .mq5 file)
    2. Auto-detect from MT5 chart profile (.chr) to find which EA is loaded,
       then locate its .mq5 source in MQL5/Experts/
    3. EA_FILENAME env var (default GMarket.mq5) in MQL5/Experts/
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
    ea_filename = _cached_ea_filename or os.getenv("EA_FILENAME", "GMarket.mq5")

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
        ea_name = _cached_ea_filename or os.getenv("EA_FILENAME", "GMarket.mq5")
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
        ea_name = _cached_ea_filename or os.getenv("EA_FILENAME", "GMarket.mq5")
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
        ea_name = _cached_ea_filename or os.getenv("EA_FILENAME", "GMarket.mq5")
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
        ea_name = _cached_ea_filename or os.getenv("EA_FILENAME", "GMarket.mq5")
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
        ea_name = _cached_ea_filename or os.getenv("EA_FILENAME", "GMarket.mq5")
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
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = _get_backup_dir()
    ea_basename = os.path.basename(src)
    dst = os.path.join(backup_dir, f"{ea_basename}.{ts}.bak")
    shutil.copy2(src, dst)

    # Update manifest
    manifest = _load_backup_manifest()
    manifest.append({
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "file": os.path.basename(dst),
        "source": ea_basename,
        "change_note": change_note or "",
    })
    _save_backup_manifest(manifest)
    return dst


def _get_metaeditor_path() -> str:
    """Get MetaEditor64.exe path from MT5 itself.

    Resolution order:
    1. METAEDITOR_PATH env var (manual override)
    2. mt5.terminal_info().path (MT5 installation directory, reported by MT5)
    """
    env_path = os.getenv("METAEDITOR_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path

    info = mt5.terminal_info()
    if info and info.path:
        return os.path.join(info.path, "MetaEditor64.exe")

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
            description="读取 GMarket.mq5 策略源码（带行号）。可指定行范围以减少输出量。",
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
                "热更新 EA 运行时参数：向 MQL5/Files/GMarket_config.set 写入 k=v 覆盖项。"
                "EA 每 3 秒轮询该文件，检测到 mtime 变化自动加载新值并刷新 runtime.json，"
                "无需重编译、无需重挂图表。param_name 必须是 GMarket.mq5 中 input 声明的变量名（如 InpFirstLots, InpIsPaused, InpMagicNumber）。"
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
            description="在 GMarket.mq5 中搜索替换代码。confirm=false 仅预览匹配，confirm=true 执行替换（自动备份）。",
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
                "【开发期编译工具 · 非查询工具】调用 MetaEditor64 对 GMarket.mq5 源代码做语法编译，"
                "返回编译器 stderr/stdout。仅在『修改策略代码后需要重新编译』这一场景下使用。"
                "禁止用于：查看行情/价格/点差/K线 → 请改用 get_market_info；"
                "查看账户/持仓/订单/盘面状态 → 请改用 get_trading_status；"
                "查看策略运行/信号 → 请改用 get_strategy_status。"
                "此工具无任何查询能力，调用它不会得到市场数据。"
            ),
            inputSchema={"type": "object", "properties": {}, "required": []}
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
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Execute tool calls."""
    try:
        strategy = get_strategy()
        arguments = arguments or {}

        if name == "get_monitor_logs":
            date_prefix = arguments.get("date") or datetime.now().strftime("%Y-%m-%d")
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
            today = datetime.now().strftime("%Y-%m-%d")
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
            date_str = arguments.get("date") or datetime.now().strftime("%Y-%m-%d")
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
            date_str = arguments.get("date") or datetime.now().strftime("%Y-%m-%d")
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
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
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
            out_lines = [
                f"# GMarket runtime overrides — written by easydeal_mcp at {human_ts}",
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

            ea_name = _cached_ea_filename or os.getenv("EA_FILENAME", "GMarket.mq5")
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

        return [TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}, ensure_ascii=False))]

    except Exception as exc:
        logging.error(f"Tool error {name}: {exc}")
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
            today = datetime.now().strftime("%Y-%m-%d")
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
