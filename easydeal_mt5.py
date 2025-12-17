import MetaTrader5 as mt5
import time
from datetime import datetime
import pandas as pd
import pytz
from flask import Flask, jsonify, request, Response
import threading
import json
import os
import logging
import logging.handlers
from functools import wraps

# 配置日志
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

app = Flask(__name__)
strategy_instance = None  # 初始化全局变量

def log_request():
    """记录API请求的装饰器"""
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            # 记录请求信息
            api_logger.info(f"Request: {request.method} {request.url}")
            api_logger.info(f"Headers: {dict(request.headers)}")
            api_logger.info(f"Args: {dict(request.args)}")
            if request.is_json:
                api_logger.info(f"JSON Data: {request.get_json()}")
            
            # 执行原始函数
            response = f(*args, **kwargs)
            
            # 记录响应信息
            if isinstance(response, Response):
                api_logger.info(f"Response Status: {response.status_code}")
                api_logger.info(f"Response Headers: {dict(response.headers)}")
            elif isinstance(response, tuple):
                api_logger.info(f"Response Status: {response[1] if len(response) > 1 else 200}")
            
            return response
        return wrapped
    return decorator

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
                self.is_follow = False  # 重置状态，下次循环重新尝试
                time.sleep(1800)  # 等待1800秒(30分钟)后重试
                return
            else:
                logging.info(f"{self.get_market_info()} 双向开仓成功")
                self.last_buy_ticket = buy_order.order
                self.last_sell_ticket = sell_order.order
                self.is_open_position = True
                self.is_follow = False
                self.follow_type = None
                
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
            # 记录平仓前的状态
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
                # 记录平仓前的获利情况
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
                    # 记录平仓完成
                    logging.info(f"{self.get_market_info()} 向上爬梯平仓完成 - Buy#{buy_pos[0].ticket}")
                    
                    # 开新buy单
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
                # 记录平仓前的获利情况
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
                    # 记录平仓完成
                    logging.info(f"{self.get_market_info()} 向下爬梯平仓完成 - Sell#{sell_pos[0].ticket}")
                    
                    # 开新sell单
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
                    # 检查马丁条件
                    martin_allowed, pause_reason = self.check_martin_conditions()
                    if not martin_allowed:
                        self.martin_pause_reason = pause_reason
                        if self.seek == 0:  # 只在第一次记录日志，避免刷屏
                            logging.warning(f"{self.get_market_info()} 马丁暂停: {pause_reason}")
                        return
                    # 记录当前sell单为马丁单
                    self.martin_orders.append(self.last_sell_ticket)
                    self.seek += 1
                    
                    # 开新的基础sell单
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
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} sell 马丁开单失败#{new_sell.retcode}")
                        return
                        
                    # 检查是否达到最大马丁层数
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
                        # 获取当前sell马丁单的总浮亏
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
                    # 检查马丁条件
                    martin_allowed, pause_reason = self.check_martin_conditions()
                    if not martin_allowed:
                        self.martin_pause_reason = pause_reason
                        if self.seek == 0:  # 只在第一次记录日志，避免刷屏
                            logging.warning(f"{self.get_market_info()} 马丁暂停: {pause_reason}")
                        return
                    # 记录当前buy单为马丁单
                    self.martin_orders.append(self.last_buy_ticket)
                    self.seek += 1
                    
                    # 开新的基础buy单
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
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} buy 马丁开单失败#{new_buy.retcode}")
                        return
                        
                    # 检查是否达到最大马丁层数
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
                        # 获取当前buy马丁单的总浮亏
                        buy_positions = mt5.positions_get(symbol=self.symbol)
                        martin_total_profit = sum(pos.profit for pos in buy_positions if pos.type == mt5.ORDER_TYPE_BUY and pos.magic == self.magic_number and pos.ticket in self.martin_orders)
                        logging.info(f"{self.get_market_info()} Buy马丁单#{martin_order.order} 价格:{symbol_info.ask:.5f} 手数:{(buy_pos[0].volume + self.first_lots) * 2 if self.seek > 1 else buy_pos[0].volume * 2} 马丁总浮亏:{martin_total_profit:.2f}")
                    else:
                        self.running = False
                        logging.error(f"{self.get_market_info()} buy 马丁开单失败#{martin_order.retcode}")
                            
    def calc_total_martin_orders_profit(self):
        """计算所有马丁单的总利润"""
        total_profit = 0
        # 计算所有马丁单的利润
        for ticket in self.martin_orders:
            position = mt5.positions_get(ticket=ticket)
            if position:
                total_profit += position[0].profit
                
        # 加入与马丁单同时开的基础单的利润
        if self.follow_type == mt5.ORDER_TYPE_BUY:
            # 向上爬梯时，马丁单是sell单，基础单也是sell单
            base_position = mt5.positions_get(ticket=self.last_sell_ticket)
            if base_position:
                total_profit += base_position[0].profit
        elif self.follow_type == mt5.ORDER_TYPE_SELL:
            # 向下爬梯时，马丁单是buy单，基础单也是buy单
            base_position = mt5.positions_get(ticket=self.last_buy_ticket)
            if base_position:
                total_profit += base_position[0].profit
                
        return total_profit
        
    def close_martin_orders(self):
        """关闭所有马丁单"""
        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info is None:
            return
            
        # 平掉所有马丁单
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
                    
        # 平掉与马丁单同时开的基础单
        if self.follow_type == mt5.ORDER_TYPE_BUY:
            # 向上爬梯时，关闭对应的sell基础单
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
                    # 开新的sell基础单
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
            # 向下爬梯时，关闭对应的buy基础单
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
                    # 开新的buy基础单
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
                    
        # 清空马丁单列表和重置马丁计数器
        self.martin_orders = []
        self.seek = 0
        return True
        
    def update_ea_status(self):
        """更新EA状态，用于重载和恢复订单状态"""
        positions = mt5.positions_get(symbol=self.symbol)
        if positions is None:
            logging.error("无法获取持仓信息")
            return

        # 统计当前订单
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
            # 没有订单，重置状态
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
            # 基础双向订单
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
            # 有马丁订单的情况 - 支持偶数和奇数订单数
            self.is_follow = False
            self.running = True
            self.is_open_position = True

            # 按开仓时间排序
            buy_orders.sort(key=lambda x: x.time)
            sell_orders.sort(key=lambda x: x.time)

            # 根据订单数量差异判断方向
            if len(sell_orders) > len(buy_orders):
                # 做多方向 (sell单多，说明在加sell马丁)
                self.follow_type = mt5.ORDER_TYPE_BUY

                if len(buy_orders) >= 1:
                    self.last_buy_ticket = buy_orders[-1].ticket  # 最新的buy订单

                if len(sell_orders) >= 1:
                    self.last_sell_ticket = sell_orders[-1].ticket  # 最新的sell订单

                # 除了最新的sell基础单，其他都是马丁单
                if len(sell_orders) > 1:
                    self.martin_orders = [order.ticket for order in sell_orders[:-1]]
                    self.last_martin_ticket = self.martin_orders[-1] if self.martin_orders else None
                else:
                    self.martin_orders = []
                    self.last_martin_ticket = None

                self.seek = len(self.martin_orders)

                logging.info("\n做多方向状态:")
                if buy_orders:
                    logging.info(f"主Buy订单: #{self.last_buy_ticket} 仓位:{buy_orders[-1].volume:.2f} 利润:{buy_orders[-1].profit:.2f}")
                if sell_orders:
                    logging.info(f"基础Sell订单: #{self.last_sell_ticket} 仓位:{sell_orders[-1].volume:.2f} 利润:{sell_orders[-1].profit:.2f}")
                if self.martin_orders:
                    logging.info("\nSell马丁单:")
                    total_martin_profit = 0
                    for ticket in self.martin_orders:
                        order = next((o for o in sell_orders if o.ticket == ticket), None)
                        if order:
                            logging.info(f"  #{ticket} 仓位:{order.volume:.2f} 利润:{order.profit:.2f}")
                            total_martin_profit += order.profit
                    logging.info(f"马丁单总利润: {total_martin_profit:.2f}")

            elif len(buy_orders) > len(sell_orders):
                # 做空方向 (buy单多，说明在加buy马丁)
                self.follow_type = mt5.ORDER_TYPE_SELL

                if len(sell_orders) >= 1:
                    self.last_sell_ticket = sell_orders[-1].ticket  # 最新的sell订单

                if len(buy_orders) >= 1:
                    self.last_buy_ticket = buy_orders[-1].ticket  # 最新的buy订单

                # 除了最新的buy基础单，其他都是马丁单
                if len(buy_orders) > 1:
                    self.martin_orders = [order.ticket for order in buy_orders[:-1]]
                    self.last_martin_ticket = self.martin_orders[-1] if self.martin_orders else None
                else:
                    self.martin_orders = []
                    self.last_martin_ticket = None

                self.seek = len(self.martin_orders)

                logging.info("\n做空方向状态:")
                if sell_orders:
                    logging.info(f"主Sell订单: #{self.last_sell_ticket} 仓位:{sell_orders[-1].volume:.2f} 利润:{sell_orders[-1].profit:.2f}")
                if buy_orders:
                    logging.info(f"基础Buy订单: #{self.last_buy_ticket} 仓位:{buy_orders[-1].volume:.2f} 利润:{buy_orders[-1].profit:.2f}")
                if self.martin_orders:
                    logging.info("\nBuy马丁单:")
                    total_martin_profit = 0
                    for ticket in self.martin_orders:
                        order = next((o for o in buy_orders if o.ticket == ticket), None)
                        if order:
                            logging.info(f"  #{ticket} 仓位:{order.volume:.2f} 利润:{order.profit:.2f}")
                            total_martin_profit += order.profit
                    logging.info(f"马丁单总利润: {total_martin_profit:.2f}")

            else:
                # buy和sell数量相等但大于1，可能是特殊状态
                # 尝试根据手数判断方向
                self.last_buy_ticket = buy_orders[-1].ticket
                self.last_sell_ticket = sell_orders[-1].ticket

                buy_total_volume = sum(o.volume for o in buy_orders)
                sell_total_volume = sum(o.volume for o in sell_orders)

                if sell_total_volume > buy_total_volume:
                    # sell仓位大，做多方向
                    self.follow_type = mt5.ORDER_TYPE_BUY
                    self.martin_orders = [o.ticket for o in sell_orders[:-1]]
                elif buy_total_volume > sell_total_volume:
                    # buy仓位大，做空方向
                    self.follow_type = mt5.ORDER_TYPE_SELL
                    self.martin_orders = [o.ticket for o in buy_orders[:-1]]
                else:
                    # 仓位相等，无法确定方向，重置
                    self.follow_type = None
                    self.martin_orders = []

                self.seek = len(self.martin_orders)
                self.last_martin_ticket = self.martin_orders[-1] if self.martin_orders else None

                logging.info("\n等量订单状态（根据仓位判断）:")
                logging.info(f"Buy总仓位: {buy_total_volume:.2f}, Sell总仓位: {sell_total_volume:.2f}")
                logging.info(f"判断方向: {'Buy' if self.follow_type == mt5.ORDER_TYPE_BUY else 'Sell' if self.follow_type == mt5.ORDER_TYPE_SELL else '未确定'}")

            logging.info(f"\n当前seek值: {self.seek}")
            if self.follow_type:
                logging.info(f"交易方向: {'Buy' if self.follow_type == mt5.ORDER_TYPE_BUY else 'Sell'}")

        else:
            # 只有1个订单的异常状态
            self.running = False
            logging.error("\n订单状态异常（仅1个订单），请手动处理")
            logging.info("Buy订单:")
            for order in buy_orders:
                logging.info(f"  #{order.ticket} 仓位:{order.volume:.2f} 利润:{order.profit:.2f}")
            logging.info("Sell订单:")
            for order in sell_orders:
                logging.info(f"  #{order.ticket} 仓位:{order.volume:.2f} 利润:{order.profit:.2f}")

        logging.info(f"{'='*50}\n")
        
    def get_profit_history(self, start_time=None, end_time=None):
        """获取指定时间段的收益历史
        
        Args:
            start_time: 开始时间，格式："YYYY-MM-DD HH:MM:SS"，为None则不限制开始时间
            end_time: 结束时间，格式："YYYY-MM-DD HH:MM:SS"，为None则使用当前时间
        """
        try:
            # 转换时间字符串为datetime对象
            if start_time:
                start_dt = datetime.strptime(start_time, "%Y-%m-%d %H:%M:%S")
            else:
                start_dt = datetime(1970, 1, 1)
                
            if end_time:
                end_dt = datetime.strptime(end_time, "%Y-%m-%d %H:%M:%S")
            else:
                end_dt = datetime.now()
                
            # 确保时区正确
            timezone = pytz.timezone("Etc/UTC")
            start_dt = timezone.localize(start_dt)
            end_dt = timezone.localize(end_dt)
            
            # 获取历史成交
            deals = mt5.history_deals_get(
                start_dt,
                end_dt
            )
            
            if deals is None:
                error = mt5.last_error()
                return {"error": f"无法获取历史成交: {error}"}
            
            # 过滤出属于此策略的成交
            strategy_deals = [deal for deal in deals 
                            if deal.magic == self.magic_number and deal.symbol == self.symbol]
            
            # 计算统计数据
            total_profit = sum(deal.profit for deal in strategy_deals)
            total_volume = sum(deal.volume for deal in strategy_deals)
            deal_count = len(strategy_deals)
            
            profit_deals = [deal for deal in strategy_deals if deal.profit > 0]
            loss_deals = [deal for deal in strategy_deals if deal.profit < 0]
            
            profit_factor = abs(sum(deal.profit for deal in profit_deals)) / abs(sum(deal.profit for deal in loss_deals)) if loss_deals else float('inf')
            
            # 按小时统计收益
            hourly_profits = {}
            for deal in strategy_deals:
                deal_time = deal.time
                if isinstance(deal_time, int):
                    deal_time = datetime.fromtimestamp(deal_time)
                
                hour = deal_time.strftime("%Y-%m-%d %H:00:00")
                if hour not in hourly_profits:
                    hourly_profits[hour] = 0
                hourly_profits[hour] += deal.profit
                
            # 构建返回数据
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
        # 检查手动开关
        if not self.martin_enabled:
            return False, "马丁已被手动禁用"

        # 获取当前价格
        symbol_info = mt5.symbol_info(self.symbol)
        if symbol_info is None:
            return False, "无法获取行情"
        current_price = (symbol_info.bid + symbol_info.ask) / 2

        # 检查ATR波动率
        atr = self.calculate_atr()
        if atr:
            atr_pct = atr / current_price * 100
            if atr_pct > self.max_atr_pct:
                return False, f"ATR波动率过高({atr_pct:.2f}% > {self.max_atr_pct}%)"

        # 检查布林带偏离
        upper, middle, lower = self.calculate_bollinger()
        if middle and upper and lower:
            # 计算当前价格偏离中轨的标准差倍数
            std = (upper - middle) / 2.0  # 布林带用2倍标准差
            if std > 0:
                deviation = abs(current_price - middle) / std
                if deviation > self.max_boll_deviation:
                    direction = "上方" if current_price > middle else "下方"
                    return False, f"价格偏离布林带中轨过大({direction}{deviation:.2f}倍标准差)"

        return True, None

    def get_martin_status(self):
        """获取马丁状态信息"""
        allowed, reason = self.check_martin_conditions()

        # 获取技术指标
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
            
def read_file_with_fallback_encoding(file_path):
    """使用不同编码尝试读取文件"""
    encodings = ['utf-8', 'gbk', 'gb2312', 'iso-8859-1']
    for encoding in encodings:
        try:
            with open(file_path, 'r', encoding=encoding) as f:
                return f.readlines()
        except UnicodeDecodeError:
            continue
    # 如果所有编码都失败，使用二进制模式读取并用errors='replace'处理
    with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
        return f.readlines()

def run_flask():
    """运行Flask服务器"""
    app.run(host='0.0.0.0', port=8888, debug=False)

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
    
@app.route('/reload', methods=['POST'])
@log_request()
def reload_strategy():
    global strategy_instance
    strategy_instance = EasyDealStrategy()
    if not strategy_instance.running:
        return jsonify({"error": "策略初始化失败"})
    return jsonify({"message": "策略已重新加载"})
    
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
        
    # 获取 days 参数
    days = request.args.get('days', type=int, default=30)
    
    # 计算开始时间
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

@app.route('/logs')
@log_request()
def get_logs():
    try:
        # 获取查询参数
        lines = request.args.get('lines', default=100, type=int)
        level = request.args.get('level', default='ALL').upper()
        log_type = request.args.get('type', default='all').lower()
        
        # 根据类型选择日志文件
        if log_type == 'api':
            target_log = os.path.join(log_directory, "api_requests.log")
        elif log_type == 'main':
            target_log = os.path.join(log_directory, "easydeal.log")
        else:
            # 返回所有日志
            main_logs = []
            api_logs = []
            
            main_log_path = os.path.join(log_directory, "easydeal.log")
            api_log_path = os.path.join(log_directory, "api_requests.log")
            
            if os.path.exists(main_log_path):
                main_logs = read_file_with_fallback_encoding(main_log_path)
            
            if os.path.exists(api_log_path):
                api_logs = read_file_with_fallback_encoding(api_log_path)
            
            # 合并并按时间排序
            all_logs = main_logs + api_logs
            all_logs.sort()
            
            # 根据日志级别过滤
            if level != 'ALL':
                all_logs = [log for log in all_logs if level in log]
            
            # 只返回最后N行
            logs_to_return = all_logs[-lines:] if lines > 0 else all_logs
            
            return jsonify({
                'status': 'success',
                'logs': logs_to_return,
                'total': len(all_logs)
            })
        
        # 读取指定的日志文件
        if os.path.exists(target_log):
            logs = read_file_with_fallback_encoding(target_log)
                
            # 根据日志级别过滤
            if level != 'ALL':
                logs = [log for log in logs if level in log]
                
            # 只返回最后N行
            logs_to_return = logs[-lines:] if lines > 0 else logs
            
            return jsonify({
                'status': 'success',
                'logs': logs_to_return,
                'total': len(logs)
            })
        else:
            return jsonify({
                'status': 'error',
                'message': '日志文件不存在'
            })
            
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        })

if __name__ == "__main__":
    # 创建策略实例
    strategy_instance = EasyDealStrategy()
    
    if not strategy_instance.running:
        logging.error("策略初始化失败，请检查错误信息")
        exit(1)
        
    # 启动Flask服务器
    flask_thread = threading.Thread(target=run_flask)
    flask_thread.daemon = True
    flask_thread.start()
    
    logging.info("服务器已启动，监听端口: 8888")
    print("服务器已启动，监听端口: 8888")
    
    # 运行策略
    while strategy_instance.running:
        if not strategy_instance.paused:
            strategy_instance.run()
            
        time.sleep(1)
