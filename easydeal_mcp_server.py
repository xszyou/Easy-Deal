"""
EasyDeal MCP Server - 交易策略MCP服务器（统一入口）
整合了交易策略、监控服务和MCP协议接口
"""

import asyncio
import json
import logging
import logging.handlers
import os
import time
import threading
import requests
import functools
from datetime import datetime, timedelta
from typing import Any, Callable, Optional
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
    PromptArgument,
    GetPromptResult,
)

# ============== 日志配置 ==============

log_directory = "logs"
if not os.path.exists(log_directory):
    os.makedirs(log_directory)

# 主日志文件配置
log_file = os.path.join(log_directory, "easydeal.log")
logging.basicConfig(
    filename=log_file,
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

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

# 源代码文件路径
SOURCE_FILE_PATH = __file__


# ============== 交易策略类 ==============

class EasyDealStrategy:
    def __init__(self):
        logging.info("初始化策略实例")

        # 直接设置交易参数
        self.symbol = "XAUUSDm"  # 交易币对
        self.first_lots = 0.01  # 首单手数
        self.step = 0.1  # 步长
        self.martin_interval = 1.6  # 马丁间隔
        self.filter = 0.1  # 过滤百分比
        self.order_time = 0  # 下单时间
        self.magic_number = 999  # 魔术数字
        self.max_loss = 3000  # 最大亏损
        self.max_martin_level = 5  # 最大马丁层数

        # 马丁控制参数
        self.martin_enabled = True  # 马丁开关（可由MCP控制）
        self.max_atr_pct = 1.5  # ATR%超过此值暂停马丁
        self.max_boll_deviation = 2.0  # 价格偏离布林带中轨超过N倍标准差时暂停马丁
        self.martin_pause_reason = None  # 马丁暂停原因

        # 设置有效期（可选）
        self.expiry_date = None
        self.running = True

        # Strategy state variables
        self.is_open_position = False
        self.last_buy_ticket = None
        self.last_sell_ticket = None
        self.last_martin_ticket = None
        self.is_follow = False
        self.follow_type = None
        self.open_time = 0
        self.martin_orders = []
        self.seek = 0
        self.paused = False

        # Initialize MT5 connection
        if not mt5.initialize():
            logging.error("MT5初始化失败")
            print("MT5初始化失败")
            self.running = False
        else:
            # 验证币对是否存在
            symbol_info = mt5.symbol_info(self.symbol)
            if symbol_info is None:
                logging.error(f"错误: MT5中不存在币对 {self.symbol}")
                print(f"错误: MT5中不存在币对 {self.symbol}")
                self.running = False
                return

            self.update_ea_status()
            logging.info(f"载入策略，交易币对: {self.symbol}")

    def get_config_info(self):
        """获取配置信息"""
        return {
            "parameters": {
                "symbol": self.symbol,
                "first_lots": self.first_lots,
                "step": self.step,
                "martin_interval": self.martin_interval,
                "filter": self.filter,
                "order_time": self.order_time,
                "magic_number": self.magic_number,
                "max_loss": self.max_loss,
                "max_martin_level": self.max_martin_level
            },
            "expiry_date": self.expiry_date.strftime("%Y-%m-%d %H:%M:%S") if self.expiry_date else None,
            "days_remaining": (self.expiry_date - datetime.now()).days if self.expiry_date else None,
            "is_expired": datetime.now() > self.expiry_date if self.expiry_date else False
        }

    def get_status(self):
        """获取策略状态数据"""
        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info is None:
            return {"error": "无法获取行情数据"}

        positions = mt5.positions_get(symbol=self.symbol)
        buy_orders = []
        sell_orders = []

        if positions:
            for pos in positions:
                if pos.magic == self.magic_number:
                    order_info = {
                        "ticket": pos.ticket,
                        "volume": pos.volume,
                        "price_open": pos.price_open,
                        "profit": pos.profit,
                        "comment": pos.comment
                    }
                    if pos.type == mt5.ORDER_TYPE_BUY:
                        buy_orders.append(order_info)
                    else:
                        sell_orders.append(order_info)

        status = {
            "market_data": {
                "symbol": self.symbol,
                "bid": symbol_info.bid,
                "ask": symbol_info.ask,
                "spread": symbol_info.spread,
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            },
            "strategy_state": {
                "running": self.running,
                "paused": self.paused,
                "follow_type": "BUY" if self.follow_type == mt5.ORDER_TYPE_BUY else "SELL" if self.follow_type == mt5.ORDER_TYPE_SELL else None,
                "seek": self.seek,
                "is_open_position": self.is_open_position
            },
            "orders": {
                "buy_orders": buy_orders,
                "sell_orders": sell_orders,
                "martin_orders": [int(ticket) for ticket in self.martin_orders],
                "total_profit": sum(pos.profit for pos in positions if pos.magic == self.magic_number) if positions else 0
            }
        }

        return status

    def close_all_orders(self):
        """平掉所有订单"""
        positions = mt5.positions_get(symbol=self.symbol)
        if positions is None:
            return {"error": "无法获取持仓信息"}

        success = True
        error_messages = []

        for pos in positions:
            if pos.magic == self.magic_number:
                order_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
                price = mt5.symbol_info(self.symbol).bid if order_type == mt5.ORDER_TYPE_SELL else mt5.symbol_info(self.symbol).ask

                result = mt5.order_send({
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": self.symbol,
                    "volume": pos.volume,
                    "type": order_type,
                    "position": pos.ticket,
                    "price": price,
                    "magic": self.magic_number,
                    "comment": "Close all",
                    "type_filling": mt5.ORDER_FILLING_IOC
                })

                if result.retcode != mt5.TRADE_RETCODE_DONE:
                    success = False
                    error_messages.append(f"订单 #{pos.ticket} 平仓失败: {result.retcode}")

        if success:
            self.is_open_position = False
            self.last_buy_ticket = None
            self.last_sell_ticket = None
            self.last_martin_ticket = None
            self.is_follow = False
            self.follow_type = None
            self.open_time = 0
            self.martin_orders = []
            self.seek = 0
            return {"message": "所有订单已平仓"}
        else:
            return {"error": "部分订单平仓失败", "details": error_messages}

    def check_entry_conditions(self):
        """检查开仓条件"""
        if time.time() >= self.open_time:
            self.is_follow = True

        if self.is_follow:
            symbol_info = mt5.symbol_info(self.symbol)
            if symbol_info is None:
                return

            # 开buy单
            buy_order = mt5.order_send({
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": self.symbol,
                "volume": self.first_lots,
                "type": mt5.ORDER_TYPE_BUY,
                "price": symbol_info.ask,
                "magic": self.magic_number,
                "comment": "Buy base",
                "type_filling": mt5.ORDER_FILLING_IOC
            })

            # 开sell单
            sell_order = mt5.order_send({
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": self.symbol,
                "volume": self.first_lots,
                "type": mt5.ORDER_TYPE_SELL,
                "price": symbol_info.bid,
                "magic": self.magic_number,
                "comment": "Sell base",
                "type_filling": mt5.ORDER_FILLING_IOC
            })

            if buy_order.retcode != mt5.TRADE_RETCODE_DONE or sell_order.retcode != mt5.TRADE_RETCODE_DONE:
                logging.error(f"{self.get_market_info()} 下单失败，错误代码: {buy_order.retcode}, {sell_order.retcode}，1800秒后重试")
                self.is_follow = False
                time.sleep(1800)
                return
            else:
                self.last_buy_ticket = buy_order.order
                self.last_sell_ticket = sell_order.order
                self.is_open_position = True
                self.is_follow = False
                self.follow_type = None
                logging.info(f"{self.get_market_info()} 双向开仓成功 Buy#{self.last_buy_ticket} 价格:{symbol_info.ask:.5f} 手数:{self.first_lots} | Sell#{self.last_sell_ticket} 价格:{symbol_info.bid:.5f} 手数:{self.first_lots}")

    def check_add_and_take_profit(self):
        """检查加仓和止盈条件"""
        if not self.running:
            return

        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info is None:
            return

        # 检查最大浮亏限制
        if self.check_max_loss():
            return

        # 平掉盈利的马丁单
        if self.follow_type is not None and self.seek > 0 and self.calc_total_martin_orders_profit() >= 0:
            positions = mt5.positions_get(symbol=self.symbol)
            if positions:
                martin_profit = sum(pos.profit for pos in positions if pos.ticket in self.martin_orders)
                base_profit = sum(pos.profit for pos in positions if pos.ticket not in self.martin_orders)
                logging.info(f"{self.get_market_info()} 准备平仓 - 马丁总盈亏:{martin_profit:.2f} 基础单盈亏:{base_profit:.2f}")

            if self.close_martin_orders():
                self.follow_type = None
                self.seek = 0
                logging.info(f"{self.get_market_info()} 平仓完成")
                logging.info(f"{self.get_market_info()} =========== 新周期开始 ===========")
                return

        # 重置方向
        if self.seek == 0:
            if self.follow_type == mt5.ORDER_TYPE_BUY:
                sell_pos = mt5.positions_get(ticket=self.last_sell_ticket)
                if sell_pos and sell_pos[0].profit >= 0:
                    self.follow_type = None
                    logging.info(f"{self.get_market_info()} 越过下边界，重置楼梯方向")

            elif self.follow_type == mt5.ORDER_TYPE_SELL:
                buy_pos = mt5.positions_get(ticket=self.last_buy_ticket)
                if buy_pos and buy_pos[0].profit >= 0:
                    self.follow_type = None
                    logging.info(f"{self.get_market_info()} 越过上边界，重置楼梯方向")

        # 往上爬梯
        buy_pos = mt5.positions_get(ticket=self.last_buy_ticket)
        if buy_pos and self.follow_type != mt5.ORDER_TYPE_SELL:
            buy_profit_percent = (symbol_info.bid - buy_pos[0].price_open) / buy_pos[0].price_open * 100
            if buy_profit_percent >= self.step:
                logging.info(f"{self.get_market_info()} 准备向上爬梯平仓 - Buy#{buy_pos[0].ticket} 获利:{buy_pos[0].profit:.2f}")

                close_order = mt5.order_send({
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": self.symbol,
                    "volume": buy_pos[0].volume,
                    "type": mt5.ORDER_TYPE_SELL,
                    "position": self.last_buy_ticket,
                    "price": symbol_info.bid,
                    "magic": self.magic_number,
                    "comment": "Close buy for ladder up",
                    "type_filling": mt5.ORDER_FILLING_IOC
                })

                if close_order.retcode == mt5.TRADE_RETCODE_DONE:
                    logging.info(f"{self.get_market_info()} 向上爬梯平仓完成 - Buy#{buy_pos[0].ticket}")

                    lots = buy_pos[0].volume
                    new_buy = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": self.symbol,
                        "volume": self.first_lots,
                        "type": mt5.ORDER_TYPE_BUY,
                        "price": symbol_info.ask,
                        "magic": self.magic_number,
                        "comment": "Buy base",
                        "type_filling": mt5.ORDER_FILLING_IOC
                    })

                    if new_buy.retcode == mt5.TRADE_RETCODE_DONE:
                        self.last_buy_ticket = new_buy.order
                        logging.info(f"{self.get_market_info()} 往上爬梯 - Buy#{new_buy.order} 价格:{symbol_info.ask:.5f} 手数:{lots}")
                        if self.follow_type is None:
                            self.follow_type = mt5.ORDER_TYPE_BUY
                            self.last_martin_ticket = self.last_sell_ticket
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} 往上爬梯buy失败：#{new_buy.retcode}")
                else:
                    self.running = False
                    logging.error(f"{self.get_market_info()} 往上爬梯close失败：#{close_order.retcode}")

        # 往下爬梯
        sell_pos = mt5.positions_get(ticket=self.last_sell_ticket)
        if sell_pos and self.follow_type != mt5.ORDER_TYPE_BUY:
            sell_profit_percent = (sell_pos[0].price_open - symbol_info.ask) / sell_pos[0].price_open * 100
            if sell_profit_percent >= self.step:
                logging.info(f"{self.get_market_info()} 准备向下爬梯平仓 - Sell#{sell_pos[0].ticket} 获利:{sell_pos[0].profit:.2f}")

                close_order = mt5.order_send({
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": self.symbol,
                    "volume": sell_pos[0].volume,
                    "type": mt5.ORDER_TYPE_BUY,
                    "position": self.last_sell_ticket,
                    "price": symbol_info.ask,
                    "magic": self.magic_number,
                    "comment": "Close sell for ladder down",
                    "type_filling": mt5.ORDER_FILLING_IOC
                })

                if close_order.retcode == mt5.TRADE_RETCODE_DONE:
                    logging.info(f"{self.get_market_info()} 向下爬梯平仓完成 - Sell#{sell_pos[0].ticket}")

                    lots = sell_pos[0].volume
                    new_sell = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": self.symbol,
                        "volume": self.first_lots,
                        "type": mt5.ORDER_TYPE_SELL,
                        "price": symbol_info.bid,
                        "magic": self.magic_number,
                        "comment": "Sell base",
                        "type_filling": mt5.ORDER_FILLING_IOC
                    })

                    if new_sell.retcode == mt5.TRADE_RETCODE_DONE:
                        self.last_sell_ticket = new_sell.order
                        logging.info(f"{self.get_market_info()} 往下爬梯 - Sell#{new_sell.order} 价格:{symbol_info.bid:.5f} 手数:{lots}")
                        if self.follow_type is None:
                            self.follow_type = mt5.ORDER_TYPE_SELL
                            self.last_martin_ticket = self.last_buy_ticket
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} 往下爬梯sell失败：#{new_sell.retcode}")
                else:
                    self.running = False
                    logging.error(f"{self.get_market_info()} 往下爬梯close失败：#{close_order.retcode}")

        # 添加马丁单 - Buy方向
        if self.follow_type == mt5.ORDER_TYPE_BUY:
            buy_pos = mt5.positions_get(ticket=self.last_buy_ticket)
            sell_pos = mt5.positions_get(ticket=self.last_sell_ticket)
            if buy_pos and sell_pos:
                buy_profit_percent = (symbol_info.bid - buy_pos[0].price_open) / buy_pos[0].price_open * 100
                sell_profit_percent = (sell_pos[0].price_open - symbol_info.ask) / sell_pos[0].price_open * 100

                if buy_profit_percent <= -self.filter and sell_profit_percent <= -self.martin_interval:
                    martin_allowed, pause_reason = self.check_martin_conditions()
                    if not martin_allowed:
                        self.martin_pause_reason = pause_reason
                        if self.seek == 0:
                            logging.warning(f"{self.get_market_info()} 马丁暂停: {pause_reason}")
                        return

                    self.martin_orders.append(self.last_sell_ticket)
                    self.seek += 1

                    lots = sell_pos[0].volume
                    new_sell = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": self.symbol,
                        "volume": self.first_lots,
                        "type": mt5.ORDER_TYPE_SELL,
                        "price": symbol_info.bid,
                        "magic": self.magic_number,
                        "comment": "Sell base",
                        "type_filling": mt5.ORDER_FILLING_IOC
                    })

                    if new_sell.retcode == mt5.TRADE_RETCODE_DONE:
                        self.last_sell_ticket = new_sell.order
                        logging.info(f"{self.get_market_info()} 新Sell基础单#{self.last_sell_ticket} 价格:{symbol_info.bid:.5f} 手数:{self.first_lots} seek:{self.seek}")
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} sell 马丁开单失败#{new_sell.retcode}")
                        return

                    if len(self.martin_orders) >= self.max_martin_level:
                        logging.warning(f"{self.get_market_info()} 达到最大马丁层数限制:{self.max_martin_level}")
                        return

                    martin_order = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": self.symbol,
                        "volume": (sell_pos[0].volume + self.first_lots) * 2 if self.seek > 1 else sell_pos[0].volume * 2,
                        "type": mt5.ORDER_TYPE_SELL,
                        "price": symbol_info.bid,
                        "magic": self.magic_number,
                        "comment": "Sell martin",
                        "type_filling": mt5.ORDER_FILLING_IOC
                    })

                    if martin_order.retcode == mt5.TRADE_RETCODE_DONE:
                        self.last_martin_ticket = martin_order.order
                        self.martin_orders.append(self.last_martin_ticket)
                        self.seek += 1
                        sell_positions = mt5.positions_get(symbol=self.symbol)
                        martin_total_profit = sum(pos.profit for pos in sell_positions if pos.type == mt5.ORDER_TYPE_SELL and pos.magic == self.magic_number and pos.ticket in self.martin_orders)
                        logging.info(f"{self.get_market_info()} Sell马丁单#{martin_order.order} 价格:{symbol_info.bid:.5f} 手数:{(sell_pos[0].volume + self.first_lots) * 2 if self.seek > 1 else sell_pos[0].volume * 2} 马丁总浮亏:{martin_total_profit:.2f}")
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} sell 马丁开单失败#{martin_order.retcode}")

        # 添加马丁单 - Sell方向
        elif self.follow_type == mt5.ORDER_TYPE_SELL:
            buy_pos = mt5.positions_get(ticket=self.last_buy_ticket)
            sell_pos = mt5.positions_get(ticket=self.last_sell_ticket)
            if buy_pos and sell_pos:
                buy_profit_percent = (symbol_info.bid - buy_pos[0].price_open) / buy_pos[0].price_open * 100
                sell_profit_percent = (sell_pos[0].price_open - symbol_info.ask) / sell_pos[0].price_open * 100

                if sell_profit_percent <= -self.filter and buy_profit_percent <= -self.martin_interval:
                    martin_allowed, pause_reason = self.check_martin_conditions()
                    if not martin_allowed:
                        self.martin_pause_reason = pause_reason
                        if self.seek == 0:
                            logging.warning(f"{self.get_market_info()} 马丁暂停: {pause_reason}")
                        return

                    self.martin_orders.append(self.last_buy_ticket)
                    self.seek += 1

                    lots = buy_pos[0].volume
                    new_buy = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": self.symbol,
                        "volume": self.first_lots,
                        "type": mt5.ORDER_TYPE_BUY,
                        "price": symbol_info.ask,
                        "magic": self.magic_number,
                        "comment": "Buy base",
                        "type_filling": mt5.ORDER_FILLING_IOC
                    })

                    if new_buy.retcode == mt5.TRADE_RETCODE_DONE:
                        self.last_buy_ticket = new_buy.order
                        logging.info(f"{self.get_market_info()} 新Buy基础单#{self.last_buy_ticket} 价格:{symbol_info.ask:.5f} 手数:{self.first_lots} seek:{self.seek}")
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} buy 马丁开单失败#{new_buy.retcode}")
                        return

                    if len(self.martin_orders) >= self.max_martin_level:
                        logging.warning(f"{self.get_market_info()} 达到最大马丁层数限制:{self.max_martin_level}")
                        return

                    martin_order = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": self.symbol,
                        "volume": (buy_pos[0].volume + self.first_lots) * 2 if self.seek > 1 else buy_pos[0].volume * 2,
                        "type": mt5.ORDER_TYPE_BUY,
                        "price": symbol_info.ask,
                        "magic": self.magic_number,
                        "comment": "Buy martin",
                        "type_filling": mt5.ORDER_FILLING_IOC
                    })

                    if martin_order.retcode == mt5.TRADE_RETCODE_DONE:
                        self.last_martin_ticket = martin_order.order
                        self.martin_orders.append(self.last_martin_ticket)
                        self.seek += 1
                        buy_positions = mt5.positions_get(symbol=self.symbol)
                        martin_total_profit = sum(pos.profit for pos in buy_positions if pos.type == mt5.ORDER_TYPE_BUY and pos.magic == self.magic_number and pos.ticket in self.martin_orders)
                        logging.info(f"{self.get_market_info()} Buy马丁单#{martin_order.order} 价格:{symbol_info.ask:.5f} 手数:{(buy_pos[0].volume + self.first_lots) * 2 if self.seek > 1 else buy_pos[0].volume * 2} 马丁总浮亏:{martin_total_profit:.2f}")
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} buy 马丁开单失败#{martin_order.retcode}")

    def calc_total_martin_orders_profit(self):
        """计算所有马丁单的总利润"""
        total_profit = 0
        for ticket in self.martin_orders:
            position = mt5.positions_get(ticket=ticket)
            if position:
                total_profit += position[0].profit

        if self.follow_type == mt5.ORDER_TYPE_BUY:
            base_position = mt5.positions_get(ticket=self.last_sell_ticket)
            if base_position:
                total_profit += base_position[0].profit
        elif self.follow_type == mt5.ORDER_TYPE_SELL:
            base_position = mt5.positions_get(ticket=self.last_buy_ticket)
            if base_position:
                total_profit += base_position[0].profit

        return total_profit

    def close_martin_orders(self):
        """关闭所有马丁单"""
        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info is None:
            return

        for ticket in self.martin_orders:
            position = mt5.positions_get(ticket=ticket)
            if position:
                order_type = mt5.ORDER_TYPE_BUY if position[0].type == mt5.ORDER_TYPE_SELL else mt5.ORDER_TYPE_SELL
                price = symbol_info.ask if order_type == mt5.ORDER_TYPE_BUY else symbol_info.bid

                close_order = mt5.order_send({
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": self.symbol,
                    "volume": position[0].volume,
                    "type": order_type,
                    "position": position[0].ticket,
                    "price": price,
                    "magic": self.magic_number,
                    "comment": "Close martin",
                    "type_filling": mt5.ORDER_FILLING_IOC
                })

                if close_order.retcode != mt5.TRADE_RETCODE_DONE:
                    logging.error(f"{self.get_market_info()} 关闭马丁单失败：#{close_order.retcode}")
                    return False

        if self.follow_type == mt5.ORDER_TYPE_BUY:
            base_position = mt5.positions_get(ticket=self.last_sell_ticket)
            if base_position:
                close_order = mt5.order_send({
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": self.symbol,
                    "volume": base_position[0].volume,
                    "type": mt5.ORDER_TYPE_BUY,
                    "position": self.last_sell_ticket,
                    "price": symbol_info.ask,
                    "magic": self.magic_number,
                    "comment": "Close base with martin",
                    "type_filling": mt5.ORDER_FILLING_IOC
                })

                if close_order.retcode == mt5.TRADE_RETCODE_DONE:
                    new_sell = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": self.symbol,
                        "volume": self.first_lots,
                        "type": mt5.ORDER_TYPE_SELL,
                        "price": symbol_info.bid,
                        "magic": self.magic_number,
                        "comment": "Sell base",
                        "type_filling": mt5.ORDER_FILLING_IOC
                    })

                    if new_sell.retcode == mt5.TRADE_RETCODE_DONE:
                        self.last_sell_ticket = new_sell.order
                    else:
                        logging.error(f"{self.get_market_info()} 开新sell基础单失败：#{new_sell.retcode}")
                        return False
                else:
                    logging.error(f"{self.get_market_info()} 关闭sell基础单失败：#{close_order.retcode}")
                    return False

        elif self.follow_type == mt5.ORDER_TYPE_SELL:
            base_position = mt5.positions_get(ticket=self.last_buy_ticket)
            if base_position:
                close_order = mt5.order_send({
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": self.symbol,
                    "volume": base_position[0].volume,
                    "type": mt5.ORDER_TYPE_SELL,
                    "position": self.last_buy_ticket,
                    "price": symbol_info.bid,
                    "magic": self.magic_number,
                    "comment": "Close base with martin",
                    "type_filling": mt5.ORDER_FILLING_IOC
                })

                if close_order.retcode == mt5.TRADE_RETCODE_DONE:
                    new_buy = mt5.order_send({
                        "action": mt5.TRADE_ACTION_DEAL,
                        "symbol": self.symbol,
                        "volume": self.first_lots,
                        "type": mt5.ORDER_TYPE_BUY,
                        "price": symbol_info.ask,
                        "magic": self.magic_number,
                        "comment": "Buy base",
                        "type_filling": mt5.ORDER_FILLING_IOC
                    })

                    if new_buy.retcode == mt5.TRADE_RETCODE_DONE:
                        self.last_buy_ticket = new_buy.order
                    else:
                        logging.error(f"{self.get_market_info()} 开新buy基础单失败：#{new_buy.retcode}")
                        return False
                else:
                    logging.error(f"{self.get_market_info()} 关闭buy基础单失败：#{close_order.retcode}")
                    return False

        self.martin_orders = []
        self.seek = 0
        return True

    def update_ea_status(self):
        """更新EA状态，用于重载和恢复订单状态"""
        positions = mt5.positions_get(symbol=self.symbol)
        if positions is None:
            logging.error("无法获取持仓信息")
            return

        buy_orders = []
        sell_orders = []
        for pos in positions:
            if pos.magic == self.magic_number:
                if pos.type == mt5.ORDER_TYPE_BUY:
                    buy_orders.append(pos)
                else:
                    sell_orders.append(pos)

        order_count = len(buy_orders) + len(sell_orders)
        logging.info(f"\n{'='*50}")
        logging.info("重新载入策略 - 状态数据:")
        logging.info(f"总订单数: {order_count}")
        logging.info(f"Buy订单数: {len(buy_orders)}")
        logging.info(f"Sell订单数: {len(sell_orders)}")

        if order_count == 0:
            self.is_open_position = False
            self.last_buy_ticket = None
            self.last_sell_ticket = None
            self.last_martin_ticket = None
            self.is_follow = False
            self.follow_type = None
            self.open_time = 0
            self.martin_orders = []
            self.seek = 0
            self.running = True
            logging.info("\n状态已重置为初始状态")

        elif order_count == 2 and len(buy_orders) == 1 and len(sell_orders) == 1:
            self.last_buy_ticket = buy_orders[0].ticket
            self.last_sell_ticket = sell_orders[0].ticket
            self.is_open_position = True
            self.last_martin_ticket = None
            self.is_follow = False
            self.follow_type = None
            self.open_time = 0
            self.martin_orders = []
            self.seek = 0
            self.running = True
            logging.info("\n基础双向订单状态:")
            logging.info(f"Buy订单: #{self.last_buy_ticket} 仓位:{buy_orders[0].volume:.2f} 利润:{buy_orders[0].profit:.2f}")
            logging.info(f"Sell订单: #{self.last_sell_ticket} 仓位:{sell_orders[0].volume:.2f} 利润:{sell_orders[0].profit:.2f}")

        elif order_count >= 2:
            self.is_follow = False
            self.running = True
            self.is_open_position = True

            buy_orders.sort(key=lambda x: x.time)
            sell_orders.sort(key=lambda x: x.time)

            if len(sell_orders) > len(buy_orders):
                self.follow_type = mt5.ORDER_TYPE_BUY
                if len(buy_orders) >= 1:
                    self.last_buy_ticket = buy_orders[-1].ticket
                if len(sell_orders) >= 1:
                    # 第一个sell（按时间排序）是基础单，后面的都是马丁单
                    self.last_sell_ticket = sell_orders[0].ticket
                if len(sell_orders) > 1:
                    # 马丁单是除了第一个基础单之外的所有sell单
                    self.martin_orders = [order.ticket for order in sell_orders[1:]]
                    self.last_martin_ticket = self.martin_orders[-1] if self.martin_orders else None
                else:
                    self.martin_orders = []
                    self.last_martin_ticket = None
                self.seek = len(self.martin_orders)
                logging.info("\n做多方向状态:")

            elif len(buy_orders) > len(sell_orders):
                self.follow_type = mt5.ORDER_TYPE_SELL
                if len(sell_orders) >= 1:
                    self.last_sell_ticket = sell_orders[-1].ticket
                if len(buy_orders) >= 1:
                    # 第一个buy（按时间排序）是基础单，后面的都是马丁单
                    self.last_buy_ticket = buy_orders[0].ticket
                if len(buy_orders) > 1:
                    # 马丁单是除了第一个基础单之外的所有buy单
                    self.martin_orders = [order.ticket for order in buy_orders[1:]]
                    self.last_martin_ticket = self.martin_orders[-1] if self.martin_orders else None
                else:
                    self.martin_orders = []
                    self.last_martin_ticket = None
                self.seek = len(self.martin_orders)
                logging.info("\n做空方向状态:")

            else:
                # 数量相等时，第一个（按时间排序）是基础单
                self.last_buy_ticket = buy_orders[0].ticket
                self.last_sell_ticket = sell_orders[0].ticket
                buy_total_volume = sum(o.volume for o in buy_orders)
                sell_total_volume = sum(o.volume for o in sell_orders)

                if sell_total_volume > buy_total_volume:
                    self.follow_type = mt5.ORDER_TYPE_BUY
                    # 马丁单是除了第一个基础单之外的所有sell单
                    self.martin_orders = [o.ticket for o in sell_orders[1:]]
                elif buy_total_volume > sell_total_volume:
                    self.follow_type = mt5.ORDER_TYPE_SELL
                    # 马丁单是除了第一个基础单之外的所有buy单
                    self.martin_orders = [o.ticket for o in buy_orders[1:]]
                else:
                    self.follow_type = None
                    self.martin_orders = []

                self.seek = len(self.martin_orders)
                self.last_martin_ticket = self.martin_orders[-1] if self.martin_orders else None

            logging.info(f"\n当前seek值: {self.seek}")

        else:
            self.running = False
            logging.error("\n订单状态异常（仅1个订单），请手动处理")

        logging.info(f"{'='*50}\n")

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

            strategy_deals = [deal for deal in deals
                            if deal.magic == self.magic_number and deal.symbol == self.symbol]

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

    def get_market_info(self):
        """获取当前行情信息字符串"""
        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info:
            return f"[{self.symbol} Bid:{symbol_info.bid:.5f} Ask:{symbol_info.ask:.5f}]"
        return ""

    def calculate_atr(self, period=14):
        """计算ATR指标"""
        rates = mt5.copy_rates_from_pos(self.symbol, mt5.TIMEFRAME_H1, 0, period + 1)
        if rates is None or len(rates) < period + 1:
            return None

        tr_list = []
        for i in range(1, len(rates)):
            high = float(rates[i]['high'])
            low = float(rates[i]['low'])
            prev_close = float(rates[i-1]['close'])
            tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
            tr_list.append(tr)

        atr = sum(tr_list) / len(tr_list)
        return atr

    def calculate_bollinger(self, period=20, std_dev=2.0):
        """计算布林带"""
        rates = mt5.copy_rates_from_pos(self.symbol, mt5.TIMEFRAME_H1, 0, period)
        if rates is None or len(rates) < period:
            return None, None, None

        closes = [float(r['close']) for r in rates]
        middle = sum(closes) / period
        variance = sum((x - middle) ** 2 for x in closes) / period
        std = variance ** 0.5
        upper = middle + std_dev * std
        lower = middle - std_dev * std

        return upper, middle, lower

    def check_martin_conditions(self):
        """检查是否允许开马丁单，返回 (allowed, reason)"""
        if not self.martin_enabled:
            return False, "马丁已被手动禁用"

        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info is None:
            return False, "无法获取行情"
        current_price = (symbol_info.bid + symbol_info.ask) / 2

        atr = self.calculate_atr()
        if atr:
            atr_pct = atr / current_price * 100
            if atr_pct > self.max_atr_pct:
                return False, f"ATR波动率过高({atr_pct:.2f}% > {self.max_atr_pct}%)"

        upper, middle, lower = self.calculate_bollinger()
        if middle and upper and lower:
            std = (upper - middle) / 2.0
            if std > 0:
                deviation = abs(current_price - middle) / std
                if deviation > self.max_boll_deviation:
                    direction = "上方" if current_price > middle else "下方"
                    return False, f"价格偏离布林带中轨过大({direction}{deviation:.2f}倍标准差)"

        return True, None

    def get_martin_status(self):
        """获取马丁状态信息"""
        allowed, reason = self.check_martin_conditions()

        atr = self.calculate_atr()
        symbol_info = mt5.symbol_info(self.symbol)
        current_price = (symbol_info.bid + symbol_info.ask) / 2 if symbol_info else 0
        atr_pct = (atr / current_price * 100) if atr and current_price else 0

        upper, middle, lower = self.calculate_bollinger()
        boll_deviation = 0
        if middle and upper:
            std = (upper - middle) / 2.0
            if std > 0:
                boll_deviation = abs(current_price - middle) / std

        return {
            "martin_enabled": self.martin_enabled,
            "martin_allowed": allowed,
            "pause_reason": reason,
            "current_seek": self.seek,
            "max_martin_level": self.max_martin_level,
            "indicators": {
                "atr_pct": round(atr_pct, 4),
                "max_atr_pct": self.max_atr_pct,
                "boll_deviation": round(boll_deviation, 2),
                "max_boll_deviation": self.max_boll_deviation,
                "boll_upper": round(upper, 5) if upper else None,
                "boll_middle": round(middle, 5) if middle else None,
                "boll_lower": round(lower, 5) if lower else None,
                "current_price": round(current_price, 5)
            }
        }

    def check_max_loss(self):
        """检查是否达到最大浮亏限制"""
        positions = mt5.positions_get(symbol=self.symbol)
        if positions:
            total_profit = sum(pos.profit for pos in positions if pos.magic == self.magic_number)
            if total_profit <= -self.max_loss:
                logging.warning(f"{self.get_market_info()} 触发最大浮亏保护 总浮亏:{total_profit:.2f}")
                self.close_all_orders()
                self.running = False
                return True
        return False

    def run(self):
        """主运行循环"""
        while self.running:
            if self.paused:
                time.sleep(1)
                continue

            if not self.is_open_position:
                self.check_entry_conditions()
            else:
                self.check_add_and_take_profit()

            time.sleep(0.01)


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
            "martin_warning_level": 2,
            "martin_danger_level": 3,
            "martin_critical_level": 4,
            "martin_disable_atr_pct": 1.2,
            "martin_disable_boll_dev": 1.8,
            "rsi_overbought": 70,
            "rsi_oversold": 30,
            "volatility_high_pct": 1.5,
            "macd_cross_alert": True,
            "macd_divergence_alert": True,
            "macd_zero_cross_alert": True,
            "macd_histogram_reversal_bars": 3,
            "risk_check_interval": 60,
            "market_check_interval": 300,
            "status_check_interval": 30,
            "hourly_report_interval": 3600,
        }

        self.last_status = None
        self.last_market_analysis = None
        self.last_macd_state = None
        self.last_hourly_report_time = 0

    def add_callback(self, callback: Callable):
        """添加回调函数"""
        self.callbacks.append(callback)

    def notify(self, event_type: str, level: str, message: str, data: dict = None):
        """发送通知"""
        alert_key = f"{event_type}:{level}"
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
        martin_level = self.strategy.seek
        max_martin = config["parameters"]["max_martin_level"]

        alerts = []

        if total_profit < 0:
            loss_pct = abs(total_profit) / max_loss * 100

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

        if martin_level >= self.config["martin_critical_level"]:
            self.notify("risk_martin", "critical",
                f"马丁层级达到 {martin_level}/{max_martin}，风险极高！",
                {"level": martin_level, "max": max_martin})
            alerts.append("martin_critical")
        elif martin_level >= self.config["martin_danger_level"]:
            self.notify("risk_martin", "danger",
                f"马丁层级达到 {martin_level}/{max_martin}",
                {"level": martin_level, "max": max_martin})
            alerts.append("martin_danger")
        elif martin_level >= self.config["martin_warning_level"]:
            self.notify("risk_martin", "warning",
                f"马丁层级达到 {martin_level}",
                {"level": martin_level, "max": max_martin})
            alerts.append("martin_warning")

        return {
            "total_profit": total_profit,
            "loss_pct": abs(total_profit) / max_loss * 100 if total_profit < 0 else 0,
            "martin_level": martin_level,
            "alerts": alerts
        }

    def check_status(self) -> dict:
        """检查策略状态"""
        status = self.strategy.get_status()
        alerts = []

        if not status["strategy_state"]["running"]:
            self.notify("status", "critical", "策略已停止运行！", {"running": False})
            alerts.append("strategy_stopped")

        if status["strategy_state"]["paused"]:
            self.notify("status", "info", "策略当前处于暂停状态", {"paused": True})
            alerts.append("strategy_paused")

        if self.last_status:
            last_tickets = set()
            for order in self.last_status["orders"]["buy_orders"] + self.last_status["orders"]["sell_orders"]:
                last_tickets.add(order["ticket"])

            current_tickets = set()
            for order in status["orders"]["buy_orders"] + status["orders"]["sell_orders"]:
                current_tickets.add(order["ticket"])

            if last_tickets != current_tickets:
                new_orders = current_tickets - last_tickets
                closed_orders = last_tickets - current_tickets

                msg_parts = []
                if new_orders:
                    msg_parts.append(f"新开仓:{len(new_orders)}笔")
                if closed_orders:
                    msg_parts.append(f"平仓:{len(closed_orders)}笔")

                message = f"持仓变动 - {', '.join(msg_parts)}"
                self.notify("status", "info", message, {
                    "new_tickets": list(new_orders),
                    "closed_tickets": list(closed_orders),
                    "total_positions": len(current_tickets)
                })

        self.last_status = status

        return {
            "running": status["strategy_state"]["running"],
            "paused": status["strategy_state"]["paused"],
            "positions": len(status["orders"]["buy_orders"]) + len(status["orders"]["sell_orders"]),
            "profit": status["orders"]["total_profit"],
            "alerts": alerts
        }

    def check_market(self) -> dict:
        """检查市场状况（技术指标）"""
        symbol = self.strategy.symbol
        alerts = []

        try:
            rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_H1, 0, 100)
            if rates is None or len(rates) == 0:
                return {"error": "无法获取K线数据"}

            closes = [float(r['close']) for r in rates]
            highs = [float(r['high']) for r in rates]
            lows = [float(r['low']) for r in rates]
            current_price = closes[-1]

            # RSI检查
            rsi = self._calculate_rsi(closes, 14)
            rsi_value = rsi[-1] if rsi and rsi[-1] else None
            if rsi_value:
                if rsi_value > self.config["rsi_overbought"]:
                    self.notify("market_rsi", "warning",
                        f"RSI超买警告: {rsi_value:.1f} > {self.config['rsi_overbought']}",
                        {"rsi": rsi_value, "signal": "overbought"})
                    alerts.append("rsi_overbought")
                elif rsi_value < self.config["rsi_oversold"]:
                    self.notify("market_rsi", "warning",
                        f"RSI超卖警告: {rsi_value:.1f} < {self.config['rsi_oversold']}",
                        {"rsi": rsi_value, "signal": "oversold"})
                    alerts.append("rsi_oversold")

            # ATR波动率检查
            atr = self._calculate_atr(highs, lows, closes, 14)
            atr_value = atr[-1] if atr and atr[-1] else None
            if atr_value:
                atr_pct = atr_value / current_price * 100
                if atr_pct > self.config["volatility_high_pct"]:
                    self.notify("market_volatility", "warning",
                        f"波动率过高: ATR {atr_pct:.2f}% > {self.config['volatility_high_pct']}%",
                        {"atr": atr_value, "atr_pct": atr_pct})
                    alerts.append("high_volatility")

            # MACD检查
            macd_data = self._calculate_macd(closes)
            if macd_data and self.config["macd_cross_alert"]:
                macd_line = macd_data["macd"]
                signal_line = macd_data["signal"]
                histogram = macd_data["histogram"]

                if len(macd_line) >= 2 and macd_line[-1] and macd_line[-2] and signal_line[-1] and signal_line[-2]:
                    # 金叉检测
                    if macd_line[-2] < signal_line[-2] and macd_line[-1] > signal_line[-1]:
                        self.notify("market_macd", "info",
                            "MACD金叉信号",
                            {"macd": macd_line[-1], "signal": signal_line[-1], "cross": "golden"})
                        alerts.append("macd_golden_cross")
                    # 死叉检测
                    elif macd_line[-2] > signal_line[-2] and macd_line[-1] < signal_line[-1]:
                        self.notify("market_macd", "info",
                            "MACD死叉信号",
                            {"macd": macd_line[-1], "signal": signal_line[-1], "cross": "death"})
                        alerts.append("macd_death_cross")

            # 布林带偏离检查
            boll_deviation = self._check_bollinger_deviation(closes, highs, lows)
            if boll_deviation and abs(boll_deviation) > self.config["martin_disable_boll_dev"]:
                direction = "上轨" if boll_deviation > 0 else "下轨"
                self.notify("market_bollinger", "warning",
                    f"价格接近布林带{direction}，偏离 {abs(boll_deviation):.2f} 倍标准差",
                    {"deviation": boll_deviation})
                alerts.append("bollinger_extreme")

            self.last_market_analysis = {
                "rsi": rsi_value,
                "atr_pct": atr_pct if atr_value else None,
                "macd": macd_data["macd"][-1] if macd_data and macd_data["macd"][-1] else None,
                "boll_deviation": boll_deviation
            }

            return {"alerts": alerts, "analysis": self.last_market_analysis}

        except Exception as e:
            monitor_logger.error(f"市场检查失败: {e}")
            return {"error": str(e)}

    def send_hourly_report(self):
        """发送每小时巡检报告"""
        try:
            status = self.strategy.get_status()
            symbol = self.strategy.symbol

            # 获取市场数据
            rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_H1, 0, 100)
            if rates is None or len(rates) == 0:
                monitor_logger.error("无法获取K线数据用于小时报")
                return

            closes = [float(r['close']) for r in rates]
            highs = [float(r['high']) for r in rates]
            lows = [float(r['low']) for r in rates]
            current_price = closes[-1]

            # 计算指标
            boll_deviation = self._check_bollinger_deviation(closes, highs, lows) or 0
            macd_data = self._calculate_macd(closes)
            macd_val = macd_data["macd"][-1] if macd_data and macd_data["macd"][-1] else 0

            # 策略状态
            total_profit = status["orders"]["total_profit"]
            martin_status = self.strategy.get_martin_status()
            martin_enabled = martin_status.get("martin_enabled", False)
            seek = status["strategy_state"]["seek"]

            # 构建消息
            message = (
                f"定时巡检报告\n"
                f"当前价格: {current_price:.5f}\n"
                f"总浮动盈亏: {total_profit:.2f}\n"
                f"马丁层级: {seek}\n"
                f"马丁状态: {'开启' if martin_enabled else '关闭'}\n"
                f"布林带偏离: {boll_deviation:.2f}倍SD\n"
                f"MACD值: {macd_val:.5f}"
            )

            data = {
                "price": current_price,
                "profit": total_profit,
                "boll_dev": boll_deviation,
                "macd": macd_val,
                "martin_enabled": martin_enabled,
                "seek": seek
            }

            self.notify("hourly_report", "info", message, data)

        except Exception as e:
            monitor_logger.error(f"发送小时报失败: {e}")

    def _calculate_rsi(self, closes: list, period: int = 14) -> list:
        """计算RSI"""
        rsi = [None] * period
        gains, losses = [], []

        for i in range(1, len(closes)):
            change = closes[i] - closes[i-1]
            gains.append(max(0, change))
            losses.append(max(0, -change))

        if len(gains) < period:
            return [None] * len(closes)

        avg_gain = sum(gains[:period]) / period
        avg_loss = sum(losses[:period]) / period

        if avg_loss == 0:
            rsi.append(100)
        else:
            rs = avg_gain / avg_loss
            rsi.append(100 - (100 / (1 + rs)))

        for i in range(period, len(gains)):
            avg_gain = (avg_gain * (period-1) + gains[i]) / period
            avg_loss = (avg_loss * (period-1) + losses[i]) / period

            if avg_loss == 0:
                rsi.append(100)
            else:
                rs = avg_gain / avg_loss
                rsi.append(100 - (100 / (1 + rs)))

        return rsi

    def _calculate_atr(self, highs: list, lows: list, closes: list, period: int = 14) -> list:
        """计算ATR"""
        tr = []
        for i in range(len(closes)):
            if i == 0:
                tr.append(highs[i] - lows[i])
            else:
                tr.append(max(
                    highs[i] - lows[i],
                    abs(highs[i] - closes[i-1]),
                    abs(lows[i] - closes[i-1])
                ))

        atr = [None] * (period - 1)
        atr.append(sum(tr[:period]) / period)

        for i in range(period, len(tr)):
            atr.append((atr[-1] * (period - 1) + tr[i]) / period)

        return atr

    def _calculate_macd(self, closes: list, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
        """计算MACD"""
        def ema(data, period):
            result = []
            multiplier = 2 / (period + 1)
            for i in range(len(data)):
                if i == 0:
                    result.append(data[0])
                else:
                    result.append((data[i] - result[-1]) * multiplier + result[-1])
            return result

        ema_fast = ema(closes, fast)
        ema_slow = ema(closes, slow)

        macd_line = [f - s for f, s in zip(ema_fast, ema_slow)]

        signal_line = ema(macd_line, signal)
        histogram = [m - s for m, s in zip(macd_line, signal_line)]

        return {"macd": macd_line, "signal": signal_line, "histogram": histogram}

    def _check_bollinger_deviation(self, closes: list, highs: list, lows: list, period: int = 20, std_dev: float = 2.0):
        """检查布林带偏离程度"""
        if len(closes) < period:
            return None

        window = closes[-period:]
        middle = sum(window) / period
        variance = sum((x - middle) ** 2 for x in window) / period
        std = variance ** 0.5

        if std == 0:
            return None

        current_price = closes[-1]
        deviation = (current_price - middle) / std

        return deviation

    def run(self):
        """启动监控循环"""
        monitor_logger.info("监控服务启动")

        last_risk_check = 0
        last_market_check = 0
        last_status_check = 0

        while True:
            now = time.time()

            try:
                # 状态检查（最频繁）
                if now - last_status_check >= self.config["status_check_interval"]:
                    self.check_status()
                    last_status_check = now

                # 风险检查
                if now - last_risk_check >= self.config["risk_check_interval"]:
                    self.check_risk()
                    last_risk_check = now

                # 市场检查
                if now - last_market_check >= self.config["market_check_interval"]:
                    self.check_market()
                    last_market_check = now

                # 小时巡检报告
                if now - self.last_hourly_report_time >= self.config["hourly_report_interval"]:
                    if self.last_hourly_report_time == 0:
                        # 首次运行等一个周期再发送
                        self.last_hourly_report_time = now
                    else:
                        self.send_hourly_report()
                        self.last_hourly_report_time = now

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

    def __init__(self, url: str = "http://127.0.0.1:5000/v1/chat/completions",
                 api_key: str = "YOUR_API_KEY",
                 model: str = "fay-streming",
                 role: str = "安监",
                 cooldown: int = 1800):
        self.url = url
        self.api_key = api_key
        self.model = model
        self.role = role
        self.cooldown = cooldown
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
数据: {json.dumps(event.get('data', {}), ensure_ascii=False)}

请分析此预警并给出建议。"""

            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {self.api_key}',
            }

            data = {
                'model': self.model,
                'messages': [{'role': self.role, 'content': prompt}],
                'stream': True
            }

            response = requests.post(self.url, headers=headers, data=json.dumps(data), stream=True, timeout=30)

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


@app.route('/status')
@log_request()
def get_status():
    if strategy_instance is None:
        return jsonify({"error": "策略未初始化"})
    return jsonify(strategy_instance.get_status())


@app.route('/pause', methods=['POST'])
@log_request()
def pause_strategy():
    if strategy_instance is None:
        return jsonify({"error": "策略未初始化"})
    strategy_instance.paused = True
    return jsonify({"message": "策略已暂停"})


@app.route('/resume', methods=['POST'])
@log_request()
def resume_strategy():
    if strategy_instance is None:
        return jsonify({"error": "策略未初始化"})
    strategy_instance.paused = False
    return jsonify({"message": "策略已继续"})


@app.route('/close_all', methods=['POST'])
@log_request()
def close_all_orders():
    if strategy_instance is None:
        return jsonify({"error": "策略未初始化"})
    strategy_instance.close_all_orders()
    return jsonify({"message": "所有订单已平仓"})


@app.route('/profit')
@log_request()
def get_profit():
    if strategy_instance is None:
        return jsonify({"error": "策略未初始化"})
    days = request.args.get('days', type=int, default=30)
    start_time = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    end_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    result = strategy_instance.get_profit_history(start_time=start_time, end_time=end_time)
    return jsonify(result)


@app.route('/config')
@log_request()
def get_config():
    if strategy_instance is None:
        return jsonify({"error": "策略未初始化"})
    return jsonify(strategy_instance.get_config_info())


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
    """获取策略实例"""
    global strategy_instance
    if strategy_instance is None:
        raise RuntimeError("策略实例未初始化")
    return strategy_instance


def get_strategy_documentation() -> str:
    """获取策略逻辑文档"""
    return '''# EasyDeal 交易策略逻辑文档

## 策略概述

EasyDeal 是一个基于 MetaTrader 5 的双向爬梯+马丁格尔自动交易策略。

## 核心机制

### 1. 双向开仓入场
策略启动后同时开立 BUY 和 SELL 两个基础单（手数为 `first_lots`），形成对冲结构。

### 2. 爬梯止盈机制
当某个方向的基础单盈利达到 `step`% 时：
1. 平掉该盈利单
2. 在当前价位重新开立同方向基础单
3. 锁定该方向为跟踪方向（`follow_type`）

### 3. 马丁格尔加仓机制
当跟踪方向确定后，如果逆势方向出现较大亏损，触发马丁加仓。

### 4. 马丁单平仓逻辑
当所有马丁单 + 对应方向基础单的总利润 >= 0 时：
1. 平掉所有马丁单
2. 平掉同向基础单
3. 开新的基础单，开始新一轮循环

## 关键参数说明

| 参数 | 说明 |
|------|------|
| `first_lots` | 基础单手数 |
| `step` | 爬梯步长(%) |
| `martin_interval` | 马丁间隔(%) |
| `filter` | 过滤百分比(%) |
| `max_martin_level` | 最大马丁层数 |
| `max_loss` | 最大浮亏 |
'''


# ============== 时间周期映射 ==============

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


# ============== 技术指标计算函数 ==============

def calculate_ma(closes: list, period: int) -> list:
    """计算简单移动平均线"""
    ma = []
    for i in range(len(closes)):
        if i < period - 1:
            ma.append(None)
        else:
            ma.append(sum(closes[i - period + 1:i + 1]) / period)
    return ma


def calculate_ema(closes: list, period: int) -> list:
    """计算指数移动平均线"""
    ema = []
    multiplier = 2 / (period + 1)
    for i in range(len(closes)):
        if i == 0:
            ema.append(closes[0])
        else:
            ema.append((closes[i] - ema[-1]) * multiplier + ema[-1])
    return ema


def calculate_rsi(closes: list, period: int = 14) -> list:
    """计算相对强弱指标"""
    rsi = [None] * period
    gains = []
    losses = []

    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gains.append(max(0, change))
        losses.append(max(0, -change))

    if len(gains) < period:
        return [None] * len(closes)

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    if avg_loss == 0:
        rsi.append(100)
    else:
        rs = avg_gain / avg_loss
        rsi.append(100 - (100 / (1 + rs)))

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        if avg_loss == 0:
            rsi.append(100)
        else:
            rs = avg_gain / avg_loss
            rsi.append(100 - (100 / (1 + rs)))

    return rsi


def calculate_macd(closes: list, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    """计算MACD指标"""
    ema_fast = calculate_ema(closes, fast)
    ema_slow = calculate_ema(closes, slow)

    macd_line = [f - s if f and s else None for f, s in zip(ema_fast, ema_slow)]

    valid_macd = [m for m in macd_line if m is not None]
    if len(valid_macd) >= signal:
        signal_line = [None] * (len(macd_line) - len(valid_macd))
        signal_ema = calculate_ema(valid_macd, signal)
        signal_line.extend(signal_ema)
    else:
        signal_line = [None] * len(macd_line)

    histogram = [m - s if m and s else None for m, s in zip(macd_line, signal_line)]

    return {"macd": macd_line, "signal": signal_line, "histogram": histogram}


def calculate_bollinger(closes: list, period: int = 20, std_dev: float = 2.0) -> dict:
    """计算布林带"""
    ma = calculate_ma(closes, period)
    upper = []
    lower = []

    for i in range(len(closes)):
        if i < period - 1:
            upper.append(None)
            lower.append(None)
        else:
            window = closes[i - period + 1:i + 1]
            mean = ma[i]
            variance = sum((x - mean) ** 2 for x in window) / period
            std = variance ** 0.5
            upper.append(mean + std_dev * std)
            lower.append(mean - std_dev * std)

    return {"middle": ma, "upper": upper, "lower": lower}


def calculate_atr(highs: list, lows: list, closes: list, period: int = 14) -> list:
    """计算真实波幅均值"""
    tr = []
    for i in range(len(closes)):
        if i == 0:
            tr.append(highs[i] - lows[i])
        else:
            tr.append(max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1])
            ))

    atr = [None] * (period - 1)
    atr.append(sum(tr[:period]) / period)

    for i in range(period, len(tr)):
        atr.append((atr[-1] * (period - 1) + tr[i]) / period)

    return atr


# ============== MCP 工具定义 ==============

def get_all_tools() -> list[Tool]:
    """获取所有可用的交易工具列表"""
    return [
        Tool(
            name="get_trading_status",
            description="获取当前交易策略的完整状态，包括市场数据、策略状态、马丁状态、持仓订单和总利润",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_market_info",
            description="获取当前交易品种的实时行情信息（买价、卖价、点差）",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_config",
            description="获取策略的配置参数，包括交易品种、手数、步长、马丁间隔等",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_strategy_documentation",
            description="获取策略逻辑文档，包含爬梯/马丁规则说明",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="pause_strategy",
            description="暂停交易策略，策略将停止开新仓位但保留现有持仓",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="resume_strategy",
            description="恢复已暂停的交易策略",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="close_all_positions",
            description="平掉所有当前持仓订单（危险操作，需谨慎使用）",
            inputSchema={
                "type": "object",
                "properties": {
                    "confirm": {"type": "boolean", "description": "确认执行平仓操作，必须设为true才会执行"}
                },
                "required": ["confirm"]
            }
        ),
        Tool(
            name="get_profit_history",
            description="获取指定天数内的交易收益历史和统计数据",
            inputSchema={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "查询的天数，默认30天", "default": 30}
                },
                "required": []
            }
        ),
        Tool(
            name="analyze_risk",
            description="分析当前持仓的风险状况，包括浮亏、马丁层级、距离止损的距离",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="get_position_details",
            description="获取所有持仓订单的详细信息",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="update_config",
            description="更新策略配置参数（运行时生效，不持久化）",
            inputSchema={
                "type": "object",
                "properties": {
                    "max_loss": {"type": "number", "description": "最大浮亏限制"},
                    "max_martin_level": {"type": "integer", "description": "最大马丁层数"},
                    "step": {"type": "number", "description": "爬梯步长百分比"},
                    "martin_interval": {"type": "number", "description": "马丁加仓间隔"},
                    "filter": {"type": "number", "description": "过滤百分比"}
                },
                "required": []
            }
        ),
        Tool(
            name="get_klines",
            description="获取K线/蜡烛图数据，支持多种时间周期",
            inputSchema={
                "type": "object",
                "properties": {
                    "timeframe": {
                        "type": "string",
                        "description": "K线周期",
                        "enum": ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"],
                        "default": "H1"
                    },
                    "count": {"type": "integer", "description": "获取的K线数量", "default": 100}
                },
                "required": []
            }
        ),
        Tool(
            name="get_technical_indicators",
            description="获取常用技术指标数据，包括MA、RSI、MACD、布林带等",
            inputSchema={
                "type": "object",
                "properties": {
                    "timeframe": {
                        "type": "string",
                        "enum": ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"],
                        "default": "H1"
                    },
                    "indicators": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["MA", "EMA", "RSI", "MACD", "BOLL", "ATR"]},
                        "default": ["MA", "RSI", "MACD"]
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_martin_status",
            description="获取马丁策略状态，包括是否启用、当前层级、波动率指标等",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="enable_martin",
            description="启用马丁加仓功能",
            inputSchema={"type": "object", "properties": {}, "required": []}
        ),
        Tool(
            name="disable_martin",
            description="禁用马丁加仓功能",
            inputSchema={
                "type": "object",
                "properties": {
                    "reason": {"type": "string", "description": "禁用原因", "default": "手动禁用"}
                },
                "required": []
            }
        ),
        Tool(
            name="notify_owner",
            description="通知主人（发送消息给Fay数字人进行播报）",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "要发送的消息内容"}
                },
                "required": ["message"]
            }
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """执行工具调用"""
    try:
        strategy = get_strategy()

        if name == "get_trading_status":
            status = strategy.get_status()
            martin_status = strategy.get_martin_status()
            status["martin_status"] = martin_status
            return [TextContent(type="text", text=json.dumps(status, ensure_ascii=False, indent=2))]

        elif name == "get_market_info":
            symbol_info = mt5.symbol_info(strategy.symbol)
            if symbol_info is None:
                return [TextContent(type="text", text=json.dumps({"error": "无法获取行情数据"}, ensure_ascii=False))]

            market_info = {
                "symbol": strategy.symbol,
                "bid": symbol_info.bid,
                "ask": symbol_info.ask,
                "spread": symbol_info.spread,
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
            return [TextContent(type="text", text=json.dumps(market_info, ensure_ascii=False, indent=2))]

        elif name == "get_config":
            config = strategy.get_config_info()
            return [TextContent(type="text", text=json.dumps(config, ensure_ascii=False, indent=2))]

        elif name == "get_strategy_documentation":
            doc = get_strategy_documentation()
            return [TextContent(type="text", text=doc)]

        elif name == "pause_strategy":
            strategy.paused = True
            logging.info("策略已暂停 (via MCP)")
            return [TextContent(type="text", text=json.dumps({
                "success": True, "message": "策略已暂停", "paused": True
            }, ensure_ascii=False))]

        elif name == "resume_strategy":
            strategy.paused = False
            logging.info("策略已恢复 (via MCP)")
            return [TextContent(type="text", text=json.dumps({
                "success": True, "message": "策略已恢复运行", "paused": False
            }, ensure_ascii=False))]

        elif name == "close_all_positions":
            confirm = arguments.get("confirm", False)
            if not confirm:
                return [TextContent(type="text", text=json.dumps({
                    "success": False, "message": "操作未确认，请设置 confirm=true 来执行平仓"
                }, ensure_ascii=False))]

            result = strategy.close_all_orders()
            logging.warning("执行全部平仓 (via MCP)")
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        elif name == "get_profit_history":
            days = arguments.get("days", 30)
            start_time = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
            end_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            result = strategy.get_profit_history(start_time=start_time, end_time=end_time)
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        elif name == "analyze_risk":
            status = strategy.get_status()
            config = strategy.get_config_info()

            total_profit = status["orders"]["total_profit"]
            max_loss = config["parameters"]["max_loss"]
            martin_level = strategy.seek
            max_martin_level = config["parameters"]["max_martin_level"]

            loss_ratio = abs(total_profit) / max_loss * 100 if total_profit < 0 else 0
            martin_ratio = martin_level / max_martin_level * 100

            risk_level = "低"
            if loss_ratio > 50 or martin_ratio > 60:
                risk_level = "高"
            elif loss_ratio > 30 or martin_ratio > 40:
                risk_level = "中"

            risk_analysis = {
                "risk_level": risk_level,
                "floating_profit": total_profit,
                "max_loss_limit": max_loss,
                "loss_percentage": round(loss_ratio, 2),
                "martin_level": martin_level,
                "max_martin_level": max_martin_level,
                "martin_percentage": round(martin_ratio, 2),
                "recommendations": []
            }

            if loss_ratio > 70:
                risk_analysis["recommendations"].append("浮亏接近止损线，建议考虑手动干预")
            if martin_ratio > 80:
                risk_analysis["recommendations"].append("马丁层级接近上限，建议密切关注")
            if not risk_analysis["recommendations"]:
                risk_analysis["recommendations"].append("当前风险可控，策略运行正常")

            return [TextContent(type="text", text=json.dumps(risk_analysis, ensure_ascii=False, indent=2))]

        elif name == "get_position_details":
            positions = mt5.positions_get(symbol=strategy.symbol)
            if positions is None:
                return [TextContent(type="text", text=json.dumps({
                    "success": False, "message": "无法获取持仓信息"
                }, ensure_ascii=False))]

            position_list = []
            for pos in positions:
                if pos.magic == strategy.magic_number:
                    pos_type = "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL"
                    is_martin = pos.ticket in strategy.martin_orders

                    position_list.append({
                        "ticket": pos.ticket,
                        "type": pos_type,
                        "volume": pos.volume,
                        "open_price": pos.price_open,
                        "current_price": pos.price_current,
                        "profit": pos.profit,
                        "is_martin_order": is_martin
                    })

            result = {
                "total_positions": len(position_list),
                "total_profit": sum(p["profit"] for p in position_list),
                "positions": position_list
            }

            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        elif name == "update_config":
            updated = []

            if "max_loss" in arguments:
                strategy.max_loss = arguments["max_loss"]
                updated.append(f"max_loss = {arguments['max_loss']}")

            if "max_martin_level" in arguments:
                strategy.max_martin_level = arguments["max_martin_level"]
                updated.append(f"max_martin_level = {arguments['max_martin_level']}")

            if "step" in arguments:
                strategy.step = arguments["step"]
                updated.append(f"step = {arguments['step']}")

            if "martin_interval" in arguments:
                strategy.martin_interval = arguments["martin_interval"]
                updated.append(f"martin_interval = {arguments['martin_interval']}")

            if "filter" in arguments:
                strategy.filter = arguments["filter"]
                updated.append(f"filter = {arguments['filter']}")

            if updated:
                logging.info(f"配置已更新 (via MCP): {', '.join(updated)}")
                return [TextContent(type="text", text=json.dumps({
                    "success": True, "message": "配置已更新", "updated": updated
                }, ensure_ascii=False, indent=2))]
            else:
                return [TextContent(type="text", text=json.dumps({
                    "success": False, "message": "没有提供需要更新的参数"
                }, ensure_ascii=False))]

        elif name == "get_klines":
            timeframe_str = arguments.get("timeframe", "H1")
            count = min(arguments.get("count", 100), 1000)

            timeframe = TIMEFRAME_MAP.get(timeframe_str)
            if timeframe is None:
                return [TextContent(type="text", text=json.dumps({
                    "error": f"不支持的时间周期: {timeframe_str}"
                }, ensure_ascii=False))]

            rates = mt5.copy_rates_from_pos(strategy.symbol, timeframe, 0, count)
            if rates is None or len(rates) == 0:
                return [TextContent(type="text", text=json.dumps({"error": "无法获取K线数据"}, ensure_ascii=False))]

            klines = []
            for rate in rates:
                klines.append({
                    "time": datetime.fromtimestamp(rate['time']).strftime("%Y-%m-%d %H:%M:%S"),
                    "open": float(rate['open']),
                    "high": float(rate['high']),
                    "low": float(rate['low']),
                    "close": float(rate['close']),
                    "volume": int(rate['tick_volume'])
                })

            result = {
                "symbol": strategy.symbol,
                "timeframe": timeframe_str,
                "count": len(klines),
                "klines": klines
            }

            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        elif name == "get_technical_indicators":
            timeframe_str = arguments.get("timeframe", "H1")
            indicators = arguments.get("indicators", ["MA", "RSI", "MACD"])

            timeframe = TIMEFRAME_MAP.get(timeframe_str)
            if timeframe is None:
                return [TextContent(type="text", text=json.dumps({
                    "error": f"不支持的时间周期: {timeframe_str}"
                }, ensure_ascii=False))]

            rates = mt5.copy_rates_from_pos(strategy.symbol, timeframe, 0, 200)
            if rates is None or len(rates) == 0:
                return [TextContent(type="text", text=json.dumps({"error": "无法获取K线数据"}, ensure_ascii=False))]

            closes = [float(r['close']) for r in rates]
            highs = [float(r['high']) for r in rates]
            lows = [float(r['low']) for r in rates]

            result = {
                "symbol": strategy.symbol,
                "timeframe": timeframe_str,
                "latest_price": closes[-1],
                "indicators": {}
            }

            if "MA" in indicators:
                ma20 = calculate_ma(closes, 20)
                result["indicators"]["MA"] = {
                    "MA20": round(ma20[-1], 5) if ma20[-1] else None,
                    "trend": "上涨" if closes[-1] > ma20[-1] else "下跌" if ma20[-1] else "未知"
                }

            if "RSI" in indicators:
                rsi = calculate_rsi(closes, 14)
                rsi_value = rsi[-1]
                result["indicators"]["RSI"] = {
                    "RSI14": round(rsi_value, 2) if rsi_value else None,
                    "signal": "超买" if rsi_value and rsi_value > 70 else "超卖" if rsi_value and rsi_value < 30 else "中性"
                }

            if "MACD" in indicators:
                macd_data = calculate_macd(closes)
                result["indicators"]["MACD"] = {
                    "MACD": round(macd_data["macd"][-1], 5) if macd_data["macd"][-1] else None,
                    "Signal": round(macd_data["signal"][-1], 5) if macd_data["signal"][-1] else None,
                    "Histogram": round(macd_data["histogram"][-1], 5) if macd_data["histogram"][-1] else None
                }

            if "BOLL" in indicators:
                boll = calculate_bollinger(closes, 20, 2.0)
                result["indicators"]["BOLL"] = {
                    "upper": round(boll["upper"][-1], 5) if boll["upper"][-1] else None,
                    "middle": round(boll["middle"][-1], 5) if boll["middle"][-1] else None,
                    "lower": round(boll["lower"][-1], 5) if boll["lower"][-1] else None
                }

            if "ATR" in indicators:
                atr = calculate_atr(highs, lows, closes, 14)
                atr_value = atr[-1]
                atr_pct = (atr_value / closes[-1] * 100) if atr_value else None
                result["indicators"]["ATR"] = {
                    "ATR14": round(atr_value, 5) if atr_value else None,
                    "ATR_pct": round(atr_pct, 4) if atr_pct else None
                }

            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        elif name == "get_martin_status":
            martin_status = strategy.get_martin_status()
            return [TextContent(type="text", text=json.dumps(martin_status, ensure_ascii=False, indent=2))]

        elif name == "enable_martin":
            strategy.martin_enabled = True
            strategy.martin_pause_reason = None
            logging.info("马丁已启用 (via MCP)")
            return [TextContent(type="text", text=json.dumps({
                "success": True, "message": "马丁加仓功能已启用", "martin_enabled": True
            }, ensure_ascii=False, indent=2))]

        elif name == "disable_martin":
            reason = arguments.get("reason", "手动禁用")
            strategy.martin_enabled = False
            strategy.martin_pause_reason = reason
            logging.warning(f"马丁已禁用 (via MCP): {reason}")
            return [TextContent(type="text", text=json.dumps({
                "success": True, "message": f"马丁加仓功能已禁用: {reason}", "martin_enabled": False
            }, ensure_ascii=False, indent=2))]

        elif name == "notify_owner":
            message = arguments.get("message")
            if not message:
                return [TextContent(type="text", text=json.dumps({
                    "success": False, "message": "消息内容不能为空"
                }, ensure_ascii=False))]

            try:
                url = "http://127.0.0.1:5000/transparent-pass"
                payload = {"user": "User", "text": message, "audio": None}
                headers = {'Content-Type': 'application/json'}

                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(
                    None,
                    functools.partial(requests.post, url, json=payload, headers=headers, timeout=5)
                )

                if response.status_code == 200:
                    return [TextContent(type="text", text=json.dumps({
                        "success": True, "message": f"已通知主人: {message}"
                    }, ensure_ascii=False))]
                else:
                    return [TextContent(type="text", text=json.dumps({
                        "success": False, "message": f"通知失败，状态码: {response.status_code}"
                    }, ensure_ascii=False))]
            except Exception as e:
                return [TextContent(type="text", text=json.dumps({
                    "success": False, "message": f"通知发送失败: {str(e)}"
                }, ensure_ascii=False))]

        else:
            return [TextContent(type="text", text=json.dumps({"error": f"未知工具: {name}"}, ensure_ascii=False))]

    except Exception as e:
        logging.error(f"工具调用错误 {name}: {str(e)}")
        return [TextContent(type="text", text=json.dumps({"error": str(e)}, ensure_ascii=False))]


# ============== MCP 资源定义 ==============

@server.list_resources()
async def list_resources() -> list[Resource]:
    """列出可用的资源"""
    return [
        Resource(
            uri="trading://status",
            name="实时交易状态",
            description="获取当前交易策略的实时状态信息",
            mimeType="application/json"
        ),
        Resource(
            uri="trading://config",
            name="策略配置",
            description="获取当前策略的配置参数",
            mimeType="application/json"
        ),
        Resource(
            uri="trading://strategy-doc",
            name="策略逻辑文档",
            description="获取EasyDeal交易策略的完整逻辑说明",
            mimeType="text/markdown"
        ),
        Resource(
            uri="trading://source-code",
            name="完整源代码",
            description="获取EasyDeal MCP Server的完整源代码（包含策略、监控、API）",
            mimeType="text/x-python"
        ),
    ]


@server.read_resource()
async def read_resource(uri: str) -> str:
    """读取资源"""
    if uri == "trading://status":
        strategy = get_strategy()
        return json.dumps(strategy.get_status(), ensure_ascii=False, indent=2)

    elif uri == "trading://config":
        strategy = get_strategy()
        return json.dumps(strategy.get_config_info(), ensure_ascii=False, indent=2)

    elif uri == "trading://strategy-doc":
        return get_strategy_documentation()

    elif uri == "trading://source-code":
        return get_file_content(SOURCE_FILE_PATH)

    else:
        return json.dumps({"error": f"未知资源: {uri}"}, ensure_ascii=False)


# ============== MCP 提示模板定义 ==============

@server.list_prompts()
async def list_prompts() -> list[Prompt]:
    """列出可用的提示模板"""
    return [
        Prompt(
            name="analyze_trading_situation",
            description="分析当前交易状况并给出建议",
            arguments=[]
        ),
        Prompt(
            name="risk_assessment",
            description="进行风险评估并提供风控建议",
            arguments=[]
        ),
    ]


@server.get_prompt()
async def get_prompt(name: str, arguments: dict[str, str] | None) -> GetPromptResult:
    """获取提示模板"""
    strategy = get_strategy()

    if name == "analyze_trading_situation":
        status = strategy.get_status()
        config = strategy.get_config_info()

        return GetPromptResult(
            description="分析当前交易状况",
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(
                        type="text",
                        text=f"""请分析以下交易状况并给出建议：

## 当前市场数据
- 交易品种: {status['market_data']['symbol']}
- 买价: {status['market_data']['bid']}
- 卖价: {status['market_data']['ask']}

## 策略状态
- 运行状态: {'运行中' if status['strategy_state']['running'] else '已停止'}
- 暂停状态: {'已暂停' if status['strategy_state']['paused'] else '未暂停'}
- 马丁层级: {status['strategy_state']['seek']}

## 持仓情况
- 总浮动盈亏: {status['orders']['total_profit']}

请分析：
1. 当前市场走势对策略的影响
2. 持仓风险评估
3. 下一步操作建议"""
                    )
                )
            ]
        )

    else:
        return GetPromptResult(
            description="未知提示",
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(type="text", text=f"未找到提示模板: {name}")
                )
            ]
        )


# ============== 启动服务函数 ==============

def start_all_services():
    """启动所有服务（策略、监控、Flask）"""
    global strategy_instance, monitor_instance

    logging.info("MCP连接已建立，开始启动所有服务...")

    # 初始化MT5连接
    if not mt5.initialize():
        logging.error("MT5初始化失败")
        return False

    logging.info("MT5连接成功")

    # 创建策略实例
    strategy_instance = EasyDealStrategy()
    if not strategy_instance.running:
        logging.error("策略初始化失败")
        mt5.shutdown()
        return False

    logging.info("策略实例创建成功")

    # 创建监控器
    monitor_instance = TradingMonitor(strategy_instance)
    monitor_instance.add_callback(FileCallback())
    monitor_instance.add_callback(AgentCallback(
        url="http://127.0.0.1:5000/v1/chat/completions",
        api_key="YOUR_API_KEY",
        model="fay-streming",
        role="安监",
        cooldown=1800
    ))
    logging.info("监控器创建成功")

    # 启动Flask服务器线程
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()
    logging.info("Flask API服务器已启动 (端口: 8888)")

    # 启动策略运行线程
    strategy_thread = threading.Thread(target=strategy_instance.run, daemon=True)
    strategy_thread.start()
    logging.info("策略运行线程已启动")

    # 启动监控线程
    monitor_thread = threading.Thread(target=monitor_instance.run, daemon=True)
    monitor_thread.start()
    logging.info("监控服务线程已启动")

    logging.info("所有服务已启动完成")
    return True


# 标记服务是否已启动
services_started = False


@server.list_tools()
async def list_tools() -> list[Tool]:
    """列出所有可用的交易工具（首次调用时启动服务）"""
    global services_started

    # MCP连接后首次调用工具列表时启动服务
    if not services_started:
        services_started = True
        logging.info("检测到MCP连接，正在启动服务...")
        if start_all_services():
            logging.info("服务启动成功")
        else:
            logging.error("服务启动失败")

    return get_all_tools()


# ============== 主函数 ==============

async def run_mcp_server():
    """运行MCP服务器"""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )


async def main():
    """主入口函数"""
    logging.info("=" * 50)
    logging.info("EasyDeal MCP Server 已启动")
    logging.info("等待MCP连接后自动启动交易服务...")
    logging.info("=" * 50)

    try:
        # 运行MCP服务器（阻塞等待连接）
        await run_mcp_server()
    except KeyboardInterrupt:
        logging.info("收到中断信号，正在关闭...")
    finally:
        if strategy_instance:
            strategy_instance.running = False
        mt5.shutdown()
        logging.info("MCP Server已关闭")


if __name__ == "__main__":
    asyncio.run(main())
