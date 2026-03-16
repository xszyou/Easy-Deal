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
        self.symbols = ["XAUUSDm"]
        self.symbol = self.symbols[0]
        self.magic_numbers = [999]
        self.magic_number = self.magic_numbers[0]
        self.max_loss = 3000
        self.comment_contains = []
        self.comment_excludes = []
        self.set_path = os.getenv("EA_SET_PATH")
        if not self.set_path:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            self.set_path = os.path.abspath(os.path.join(base_dir, "..", "config.set"))
        self.set_parameters = {}
        set_ok, set_msg = self.load_set_file(self.set_path)
        if not set_ok:
            logging.warning(f"Set file load failed: {set_msg}")

        # 设置有效期（可选）
        self.expiry_date = None
        self.running = True

        # 运行状态
        self.is_open_position = False

        # Initialize MT5 connection
        if not mt5.initialize():
            logging.error("MT5初始化失败")
            print("MT5初始化失败")
            self.running = False
        else:
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
        """获取配置信息"""
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
            "set_path": self.set_path,
            "set_parameters": self.set_parameters,
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

    def load_set_file(self, path: str) -> tuple[bool, str]:
        if not path:
            self.set_parameters = {}
            return False, "set file path is empty"
        if not os.path.exists(path):
            self.set_parameters = {}
            return False, f"set file not found: {path}"
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except Exception as exc:
            self.set_parameters = {}
            return False, f"failed to read set file: {exc}"

        params = {}
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith(";") or stripped.startswith("#"):
                continue
            if "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key:
                continue
            if "||" in value:
                value = value.split("||", 1)[0].strip()
            params[key] = self._coerce_set_value(value)

        self.set_parameters = params
        self.set_path = path

        mapped = []
        if "MAGIC_NUMBER" in params:
            try:
                magic_value = int(params["MAGIC_NUMBER"])
                self.magic_numbers = [magic_value]
                self.magic_number = magic_value
                mapped.append("MAGIC_NUMBER")
            except (TypeError, ValueError):
                logging.warning("Invalid MAGIC_NUMBER in set file: %s", params["MAGIC_NUMBER"])

        message = f"loaded set file: {path}"
        if mapped:
            message = f"{message}; mapped: {', '.join(mapped)}"
        return True, message

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

        symbols_env = os.getenv("EA_SYMBOLS")
        if symbols_env is not None:
            profile["symbols"] = self._split_env_list(symbols_env)
        else:
            symbol_env = os.getenv("EA_SYMBOL")
            if symbol_env is not None:
                profile["symbol"] = symbol_env

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
                "ping": terminal_info.ping_last if terminal_info else -1,
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
            "data": data or {}
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
    """Agent 终端回调"""

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

    def __call__(self, event: dict):
        alert_key = f"{event['event_type']}:{event['level']}"
        now = time.time()
        if alert_key in self.last_alert_time:
            if now - self.last_alert_time[alert_key] < self.cooldown:
                return
        self.last_alert_time[alert_key] = now

        try:
            level_emoji = {"info": "ℹ️", "warning": "⚠️", "danger": "🚨", "critical": "🆘"}
            emoji = level_emoji.get(event["level"], "📢")

            prompt = f"""{emoji} 交易预警通知

类型: {event['event_type']}
级别: {event['level'].upper()}
时间: {event['timestamp']}
消息: {event['message']}
数据: {json.dumps(event.get('data', {}), ensure_ascii=False)}"""

            payload = {
                "user": self.user,
                "text": prompt,
            }

            response = requests.post(self.url, json=payload, timeout=10)

            if response.status_code != 200:
                monitor_logger.error(f"Agent回调失败，状态码：{response.status_code}")

        except Exception as e:
            monitor_logger.error(f"Agent回调执行失败: {e}")


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








def run_flask():
    """运行Flask服务器"""
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
        "你是交易策略分析师，请基于提供的信息推测EA的交易逻辑。",
        "注意：参数不等于规则；仅在有直接证据时引用。不要臆造指标或条件。",
        "请输出以下内容：",
        "1) 摘要",
        "2) 开仓/加仓/平仓假设",
        "3) 证据（引用日志/订单变化/参数）",
        "4) 未确定项或反例",
        "5) 下一步可能行为",
        "6) 需要补充的数据",
        "## 账户与持仓",
        json.dumps({
            "balance": account.get("balance"),
            "equity": account.get("equity"),
            "margin_level": account.get("margin_level"),
            "positions": summary
        }, ensure_ascii=False, indent=2),
        "## 监控配置",
        json.dumps(config, ensure_ascii=False, indent=2),
    ]

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
        prompt_sections.append("## 历史推测记录")
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

    return {
        "review_date": date_prefix,
        "window": {"start": start_time, "end": end_time},
        "base_doc_path": base_doc_path,
        "status": strategy.get_status(),
        "config": strategy.get_config_info(),
        "order_logs": order_logs,
        "log_lines": log_lines,
        "events": events,
        "chat_records": chat_records,
        "profit_history": profit_history,
    }


def _build_consistency_review_prompt(review_date: date, base_doc: str) -> str:
    review_day = review_date.strftime("%Y-%m-%d")
    prompt_sections = [
        "You are a trading-strategy auditor.",
        f"Review date: {review_day} (use only this day's observations).",
        "Task: judge whether the observed trading is consistent with the strategy description.",
        "Do not rewrite the strategy description and do not auto-update any documentation.",
        "Return strict JSON only (no extra text):",
        "{\"consistent\": true|false|null, \"summary\": \"\", \"mismatches\": [], \"evidence\": []}",
        "consistent=false means clear mismatch; true means broadly consistent; null means insufficient evidence or no trades.",
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

    context = {
        "status": strategy.get_status(),
        "config": strategy.get_config_info(),
        "order_logs": order_logs,
        "log_lines": log_lines,
        "events": events,
        "conversation": conversation,
        "chat_records": chat_records
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
    _ = strategy, arguments
    doc_path = _get_strategy_doc_path()
    doc = _read_strategy_doc(doc_path)
    if doc:
        return True, doc
    return False, f"strategy documentation not found at: {doc_path}"


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


# ============== MCP 工具定义 ==============

# ============== MCP tools ==============

# ============== MCP tools ==============

def get_all_tools() -> list[Tool]:
    """Return all available MCP tools."""
    return [
        Tool(
            name="get_trading_logs",
            description="Fetch trading logs for a date with an optional type filter.",
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
            name="get_trading_status",
            description="Get current account, positions, and market snapshot.",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_market_info",
            description="Get current market info for the configured symbol.",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_config",
            description="Get monitor configuration and loaded parameters.",
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
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Execute tool calls."""
    try:
        strategy = get_strategy()
        arguments = arguments or {}

        if name == "get_trading_logs":
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

            lines = _read_recent_lines(
                log_file,
                limit=limit,
                date_prefix=date_prefix,
                keywords=keywords
            )
            result = {"date": date_prefix, "type": log_type, "count": len(lines), "lines": lines}
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
        text = f"""Analyze the current trading situation and provide suggestions.
Market: {market.get('symbol')} bid={market.get('bid')} ask={market.get('ask')}
Positions: total={summary.get('positions_total')} buy={summary.get('buy_count')} sell={summary.get('sell_count')} net_volume={summary.get('net_volume')}
P/L: {total_profit}
State: running={state.get('running')} open_position={state.get('is_open_position')}
Config: max_loss={config.get('parameters', {}).get('max_loss')} magic_numbers={config.get('parameters', {}).get('magic_numbers')}
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
