"""
EasyDeal MCP Server - 交易策略MCP服务器
允许AI Agent通过MCP协议与交易策略进行交互
"""

import asyncio
import json
import logging
import os
import threading
import time
import requests
import functools
from datetime import datetime, timedelta
from typing import Any

import MetaTrader5 as mt5
import pytz
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool,
    TextContent,
    Resource,
    ResourceTemplate,
    Prompt,
    PromptMessage,
    PromptArgument,
    GetPromptResult,
)

# 配置日志
log_directory = "logs"
if not os.path.exists(log_directory):
    os.makedirs(log_directory)

logging.basicConfig(
    filename=os.path.join(log_directory, "mcp_server.log"),
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# 创建MCP服务器
server = Server("easydeal-trading")

# 全局策略实例引用
strategy_instance = None
strategy_thread = None

# 策略文件路径
STRATEGY_FILE_PATH = os.path.join(os.path.dirname(__file__), "easydeal_mt5.py")
SERVER_FILE_PATH = __file__
MONITOR_FILE_PATH = os.path.join(os.path.dirname(__file__), "easydeal_monitor.py")


def get_file_content(file_path: str) -> str:
    """读取文件内容"""
    try:
        if not os.path.exists(file_path):
             return f"# 文件不存在: {file_path}"
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"# 无法读取文件: {str(e)}"


def start_strategy_thread():
    """启动策略运行线程"""
    global strategy_instance, strategy_thread
    
    if strategy_instance and strategy_instance.running:
        # 如果线程已存在且正在运行，则无需重启
        if strategy_thread and strategy_thread.is_alive():
            return

        logging.info("正在启动策略后台线程...")
        strategy_thread = threading.Thread(target=strategy_instance.run, daemon=True)
        strategy_thread.start()


def get_strategy():
    """获取或创建策��实例"""
    global strategy_instance
    if strategy_instance is None:
        from easydeal_mt5 import EasyDealStrategy
        strategy_instance = EasyDealStrategy()
        start_strategy_thread()
    return strategy_instance


def get_strategy_source_code() -> str:
    """获取策略源代码"""
    return get_file_content(STRATEGY_FILE_PATH)


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

**示例**：
- BUY单盈利达到0.1%，平仓后重新开BUY单
- 此时 `follow_type = BUY`，表示做多方向

### 3. 马丁格尔加仓机制

当跟踪方向确定后，如果逆势方向出现较大亏损，触发马丁加仓：

**触发条件**（以做多为例）：
- 顺势单(BUY)亏损 <= -`filter`%
- 逆势单(SELL)亏损 <= -`martin_interval`%

**执行动作**：
1. 将当前逆势基础单标记为马丁单
2. 开新的逆势基础单（`first_lots`手数）
3. 开马丁加仓单（手数 = 上次马丁单 × 2）
4. `seek` 计数器 +1

### 4. 马丁单平仓逻辑

当所有马丁单 + 对应方向基础单的总利润 >= 0 时：
1. 平掉所有马丁单
2. 平掉同向基础单
3. 开新的基础单，开始新一轮循环
4. 重置 `seek = 0`

### 5. 方向重置

当 `seek = 0` 且逆势基础单利润 >= 0 时：
- 重置 `follow_type = None`
- 策略回到初始双向状态

## 关键参数说明

| 参数 | 说明 | 作用 |
|------|------|------|
| `first_lots` | 基础单手数 | 每次开仓的最小单位 |
| `step` | 爬梯步长(%) | 盈利多少百分比触发爬梯 |
| `martin_interval` | 马丁间隔(%) | 逆势单亏损多少触发马丁 |
| `filter` | 过滤百分比(%) | 顺势单必须先亏损到此值才允许开马丁 |
| `max_martin_level` | 最大马丁层数 | 防止无限加仓 |
| `max_loss` | 最大浮亏 | 触发后强制平仓所有订单 |
| `magic_number` | 魔术数字 | 订单标识，区分其他EA的订单 |

## 状态变量说明

| 变量 | 类型 | 说明 |
|------|------|------|
| `is_open_position` | bool | 是否已开仓 |
| `follow_type` | ORDER_TYPE | 跟踪方向 (BUY/SELL/None) |
| `seek` | int | 当前马丁层级 |
| `martin_orders` | list | 马丁单ticket列表 |
| `last_buy_ticket` | int | 最新BUY基础单ticket |
| `last_sell_ticket` | int | 最新SELL基础单ticket |
| `paused` | bool | 策略是否暂停 |
| `running` | bool | 策略是否运行 |

## 风险控制

### 最大浮亏保护
当所有持仓总浮亏达到 `-max_loss` 时：
1. 立即平掉所有订单
2. 停止策略运行（`running = False`）

### 马丁层数限制
当马丁单数量达到 `max_martin_level` 时：
- 不再开新的马丁单
- 等待价格回归或触发最大浮亏保护

## 交易流程图

```
开始
  │
  ├─ 双向开仓 (BUY + SELL)
  │
  └─ 主循环
      │
      ├─ 检查最大浮亏 → 触发则全平
      │
      ├─ 马丁单总利润 >= 0 → 平仓马丁单
      │
      ├─ BUY盈利 >= step% → 爬梯向上
      │
      ├─ SELL盈利 >= step% → 爬梯向下
      │
      └─ 满足马丁条件 → 开马丁单
```

## 资金效率

- 浮亏转换效率: 93%+
- 风险集中在马丁层级过深的情况
- 建议根据资金量合理设置 `max_loss` 和 `max_martin_level`
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

    # 计算信号线
    valid_macd = [m for m in macd_line if m is not None]
    if len(valid_macd) >= signal:
        signal_line = [None] * (len(macd_line) - len(valid_macd))
        signal_ema = calculate_ema(valid_macd, signal)
        signal_line.extend(signal_ema)
    else:
        signal_line = [None] * len(macd_line)

    # 计算柱状图
    histogram = [m - s if m and s else None for m, s in zip(macd_line, signal_line)]

    return {
        "macd": macd_line,
        "signal": signal_line,
        "histogram": histogram
    }


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

    return {
        "middle": ma,
        "upper": upper,
        "lower": lower
    }


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


def calculate_stochastic(highs: list, lows: list, closes: list, k_period: int = 14, d_period: int = 3) -> dict:
    """计算随机指标"""
    k_values = []

    for i in range(len(closes)):
        if i < k_period - 1:
            k_values.append(None)
        else:
            highest = max(highs[i - k_period + 1:i + 1])
            lowest = min(lows[i - k_period + 1:i + 1])
            if highest == lowest:
                k_values.append(50)
            else:
                k_values.append(100 * (closes[i] - lowest) / (highest - lowest))

    # 计算D线 (K的移动平均)
    d_values = []
    for i in range(len(k_values)):
        if k_values[i] is None or i < k_period - 1 + d_period - 1:
            d_values.append(None)
        else:
            valid_k = [k for k in k_values[i - d_period + 1:i + 1] if k is not None]
            if len(valid_k) == d_period:
                d_values.append(sum(valid_k) / d_period)
            else:
                d_values.append(None)

    return {
        "k": k_values,
        "d": d_values
    }


# ============== 工具定义 ==============

@server.list_tools()
async def list_tools() -> list[Tool]:
    """列出所有可用的交易工具"""
    return [
        Tool(
            name="get_trading_status",
            description="获取当前交易策略的完整状态，包括市场数据、策略状态、马丁状态、持仓订单和总利润",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="get_market_info",
            description="获取当前交易品种的实时行情信息（买价、卖价、点差）",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="get_config",
            description="获取策略的配置参数，包括交易品种、手数、步长、马丁间隔等",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="get_strategy_documentation",
            description="获取策略逻辑文档，包含爬梯/马丁规则说明",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="pause_strategy",
            description="暂停交易策略，策略将停止开新仓位但保留现有持仓",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="resume_strategy",
            description="恢复已暂停的交易策略",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="close_all_positions",
            description="平掉所有当前持仓订单（危险操作，需谨慎使用）",
            inputSchema={
                "type": "object",
                "properties": {
                    "confirm": {
                        "type": "boolean",
                        "description": "确认执行平仓操作，必须设为true才会执行"
                    }
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
                    "days": {
                        "type": "integer",
                        "description": "查询的天数，默认30天",
                        "default": 30
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="read_server_code",
            description="读取MCP服务器脚本 (easydeal_mcp_server.py) 的完整源代码",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="read_strategy_code",
            description="读取MT5交易策略脚本 (easydeal_mt5.py) 的完整源代码",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="read_monitor_code",
            description="读取监控脚本 (easydeal_monitor.py) 的完整源代码",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="get_logs",
            description="获取策略运行日志，用于诊断和监控",
            inputSchema={
                "type": "object",
                "properties": {
                    "lines": {
                        "type": "integer",
                        "description": "返回的日志行数，默认100",
                        "default": 100
                    },
                    "level": {
                        "type": "string",
                        "description": "日志级别过滤: ALL, INFO, WARNING, ERROR",
                        "enum": ["ALL", "INFO", "WARNING", "ERROR"],
                        "default": "ALL"
                    },
                    "log_type": {
                        "type": "string",
                        "description": "日志类型: all, main, api",
                        "enum": ["all", "main", "api"],
                        "default": "main"
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="reload_strategy",
            description="重新加载策略，用于恢复订单状态或重新初始化",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="analyze_risk",
            description="分析当前持仓的风险状况，包括浮亏、马丁层级、距离止损的距离",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="get_position_details",
            description="获取所有持仓订单的详细信息",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="update_config",
            description="更新策略配置参数（运行时生效，不持久化）",
            inputSchema={
                "type": "object",
                "properties": {
                    "max_loss": {
                        "type": "number",
                        "description": "最大浮亏限制"
                    },
                    "max_martin_level": {
                        "type": "integer",
                        "description": "最大马丁层数"
                    },
                    "step": {
                        "type": "number",
                        "description": "爬梯步长百分比"
                    },
                    "martin_interval": {
                        "type": "number",
                        "description": "马丁加仓间隔"
                    },
                    "filter": {
                        "type": "number",
                        "description": "过滤百分比"
                    }
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
                        "description": "K线周期: M1(1分钟), M5(5分钟), M15(15分钟), M30(30分钟), H1(1小时), H4(4小时), D1(日线), W1(周线), MN1(月线)",
                        "enum": ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"],
                        "default": "H1"
                    },
                    "count": {
                        "type": "integer",
                        "description": "获取的K线数量，默认100，最大1000",
                        "default": 100
                    }
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
                        "description": "K线周期",
                        "enum": ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"],
                        "default": "H1"
                    },
                    "indicators": {
                        "type": "array",
                        "description": "需要计算的指标列表: MA, EMA, RSI, MACD, BOLL, ATR, STOCH",
                        "items": {
                            "type": "string",
                            "enum": ["MA", "EMA", "RSI", "MACD", "BOLL", "ATR", "STOCH"]
                        },
                        "default": ["MA", "RSI", "MACD"]
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_market_analysis",
            description="获取综合市场分析，包括趋势判断、支撑阻力位、波动率等",
            inputSchema={
                "type": "object",
                "properties": {
                    "timeframe": {
                        "type": "string",
                        "description": "分析的时间周期",
                        "enum": ["M15", "H1", "H4", "D1"],
                        "default": "H1"
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_tick_data",
            description="获取最近的Tick逐笔数据",
            inputSchema={
                "type": "object",
                "properties": {
                    "count": {
                        "type": "integer",
                        "description": "获取的Tick数量，默认100，最大1000",
                        "default": 100
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="get_martin_status",
            description="获取马丁策略状态，包括是否启用、当前层级、波动率指标等",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="enable_martin",
            description="启用马丁加仓功能",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="disable_martin",
            description="禁用马丁加仓功能（策略将继续运行但不会开新的马丁单）",
            inputSchema={
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "禁用原因（可选）",
                        "default": "手动禁用"
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="update_martin_config",
            description="更新马丁控制参数（波动率阈值、布林带偏离阈值等）",
            inputSchema={
                "type": "object",
                "properties": {
                    "max_atr_pct": {
                        "type": "number",
                        "description": "最大ATR百分比，超过此值暂停马丁（默认1.5）"
                    },
                    "max_boll_deviation": {
                        "type": "number",
                        "description": "最大布林带偏离倍数，价格偏离中轨超过此值暂停马丁（默认2.0）"
                    }
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
                    "message": {
                        "type": "string",
                        "description": "要发送的消息内容"
                    }
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
            # 获取并合并马丁状态
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
                "spread_float": round((symbol_info.ask - symbol_info.bid) / symbol_info.point, 1),
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "volume_min": symbol_info.volume_min,
                "volume_max": symbol_info.volume_max,
                "volume_step": symbol_info.volume_step,
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
                "success": True,
                "message": "策略已暂停",
                "paused": True
            }, ensure_ascii=False))]

        elif name == "resume_strategy":
            strategy.paused = False
            logging.info("策略已恢复 (via MCP)")
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": "策略已恢复运行",
                "paused": False
            }, ensure_ascii=False))]

        elif name == "close_all_positions":
            confirm = arguments.get("confirm", False)
            if not confirm:
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "message": "操作未确认，请设置 confirm=true 来执行平仓"
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

        elif name == "get_history_orders":
            start_date_str = arguments.get("start_date")
            end_date_str = arguments.get("end_date")
            count = arguments.get("count")
            group = arguments.get("group")
            
            # Default to strategy symbol if not provided
            if not group:
                group = strategy.symbol
            
            # Determine time range
            if end_date_str:
                end_dt = datetime.strptime(end_date_str, "%Y-%m-%d %H:%M:%S")
            else:
                end_dt = datetime.now()
                
            if start_date_str:
                start_dt = datetime.strptime(start_date_str, "%Y-%m-%d %H:%M:%S")
            else:
                # If count is provided, look back enough time (e.g., 1 year) to likely find them, 
                # then slice. If no count, default to 30 days.
                if count:
                     start_dt = end_dt - timedelta(days=365)
                else:
                     start_dt = end_dt - timedelta(days=30)

            # Ensure timezone (mt5 usually expects UTC or local depending on setup, but datetime objects work)
            try:
                timezone = pytz.timezone("Etc/UTC")
                if start_dt.tzinfo is None:
                    start_dt = timezone.localize(start_dt)
                if end_dt.tzinfo is None:
                    end_dt = timezone.localize(end_dt)
            except Exception:
                pass 

            deals = mt5.history_deals_get(start_dt, end_dt, group=group)
            
            if deals is None:
                 return [TextContent(type="text", text=json.dumps({"error": "无法获取历史订单", "mt5_error": mt5.last_error()}, ensure_ascii=False))]
                 
            deal_list = []
            for deal in deals:
                # If looking for strategy orders (default), filter by magic number if it matches strategy symbol
                # Typically strategy users want to see THEIR orders.
                # But if group is specified explicitly by user (e.g. "EURUSD"), they might want all.
                # Here we assume if group was auto-set to strategy.symbol, we might want to filter?
                # But users might want to see manual trades too.
                # I will include magic number and let user decide, or filter?
                # I will NOT filter by magic number to give full history for the symbol, 
                # unless I want to be strict. `get_profit_history` DOES filter.
                # Given "history transaction orders" usually implies "what did THIS bot do?" or "what happened on this account?"
                # I'll stick to returning all deals for the group/symbol, but I'll add a flag `is_strategy_deal`.
                
                is_strategy_deal = (deal.magic == strategy.magic_number)
                
                deal_list.append({
                    "ticket": deal.ticket,
                    "order": deal.order,
                    "time": datetime.fromtimestamp(deal.time).strftime("%Y-%m-%d %H:%M:%S"),
                    "type": "BUY" if deal.type == mt5.DEAL_TYPE_BUY else "SELL",
                    "entry": "IN" if deal.entry == mt5.DEAL_ENTRY_IN else "OUT" if deal.entry == mt5.DEAL_ENTRY_OUT else "IN/OUT",
                    "volume": deal.volume,
                    "price": deal.price,
                    "commission": deal.commission,
                    "swap": deal.swap,
                    "profit": deal.profit,
                    "magic": deal.magic,
                    "comment": deal.comment,
                    "is_strategy_deal": is_strategy_deal
                })
            
            # Sort by time descending (newest first)
            deal_list.sort(key=lambda x: x["time"], reverse=True)
            
            # Apply count limit
            if count:
                deal_list = deal_list[:count]
                
            return [TextContent(type="text", text=json.dumps({
                "total_retrieved": len(deals),
                "count": len(deal_list),
                "start_date": start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                "end_date": end_dt.strftime("%Y-%m-%d %H:%M:%S"),
                "orders": deal_list
            }, ensure_ascii=False, indent=2))]

        elif name == "read_server_code":
            content = get_file_content(SERVER_FILE_PATH)
            return [TextContent(type="text", text=content)]

        elif name == "read_strategy_code":
            content = get_file_content(STRATEGY_FILE_PATH)
            return [TextContent(type="text", text=content)]

        elif name == "read_monitor_code":
            content = get_file_content(MONITOR_FILE_PATH)
            return [TextContent(type="text", text=content)]

        elif name == "get_logs":
            lines = arguments.get("lines", 100)
            level = arguments.get("level", "ALL").upper()
            log_type = arguments.get("log_type", "main").lower()

            # 读取日志文件
            if log_type == "api":
                log_file = os.path.join(log_directory, "api_requests.log")
            elif log_type == "main":
                log_file = os.path.join(log_directory, "easydeal.log")
            else:
                log_file = os.path.join(log_directory, "easydeal.log")

            if not os.path.exists(log_file):
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "message": "日志文件不存在"
                }, ensure_ascii=False))]

            with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
                all_lines = f.readlines()

            # 过滤日志级别
            if level != "ALL":
                all_lines = [line for line in all_lines if level in line]

            # 返回最后N行
            logs = all_lines[-lines:] if lines > 0 else all_lines

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "total": len(all_lines),
                "returned": len(logs),
                "logs": [line.strip() for line in logs]
            }, ensure_ascii=False, indent=2))]

        elif name == "reload_strategy":
            global strategy_instance
            
            # 停止旧策略
            if strategy_instance:
                strategy_instance.running = False
                # 等待一小段时间确保旧线程有机会退出
                time.sleep(0.1)
            
            from easydeal_mt5 import EasyDealStrategy
            strategy_instance = EasyDealStrategy()

            if not strategy_instance.running:
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "message": "策略重新加载失败"
                }, ensure_ascii=False))]

            # 启动新策略线程
            start_strategy_thread()

            logging.info("策略已重新加载 (via MCP)")
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": "策略已重新加载并启动运行",
                "status": strategy_instance.get_status()
            }, ensure_ascii=False, indent=2))]

        elif name == "analyze_risk":
            status = strategy.get_status()
            config = strategy.get_config_info()

            total_profit = status["orders"]["total_profit"]
            max_loss = config["parameters"]["max_loss"]
            martin_level = strategy.seek
            max_martin_level = config["parameters"]["max_martin_level"]

            # 计算风险指标
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
                "distance_to_stop": max_loss - abs(total_profit) if total_profit < 0 else max_loss,
                "martin_level": martin_level,
                "max_martin_level": max_martin_level,
                "martin_percentage": round(martin_ratio, 2),
                "follow_direction": status["strategy_state"]["follow_type"],
                "is_paused": status["strategy_state"]["paused"],
                "recommendations": []
            }

            # 生成建议
            if loss_ratio > 70:
                risk_analysis["recommendations"].append("浮亏接近止损线，建议考虑手动干预")
            if martin_ratio > 80:
                risk_analysis["recommendations"].append("马丁层级接近上限，建议密切关注")
            if strategy.paused:
                risk_analysis["recommendations"].append("策略当前已暂停")
            if not risk_analysis["recommendations"]:
                risk_analysis["recommendations"].append("当前风险可控，策略运行正常")

            return [TextContent(type="text", text=json.dumps(risk_analysis, ensure_ascii=False, indent=2))]

        elif name == "get_position_details":
            positions = mt5.positions_get(symbol=strategy.symbol)
            if positions is None:
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "message": "无法获取持仓信息"
                }, ensure_ascii=False))]

            position_list = []
            for pos in positions:
                if pos.magic == strategy.magic_number:
                    pos_type = "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL"
                    is_martin = pos.ticket in strategy.martin_orders
                    is_base = pos.ticket == strategy.last_buy_ticket or pos.ticket == strategy.last_sell_ticket

                    position_list.append({
                        "ticket": pos.ticket,
                        "type": pos_type,
                        "volume": pos.volume,
                        "open_price": pos.price_open,
                        "current_price": pos.price_current,
                        "profit": pos.profit,
                        "comment": pos.comment,
                        "open_time": datetime.fromtimestamp(pos.time).strftime("%Y-%m-%d %H:%M:%S"),
                        "is_martin_order": is_martin,
                        "is_base_order": is_base
                    })

            # 按类型分组统计
            buy_positions = [p for p in position_list if p["type"] == "BUY"]
            sell_positions = [p for p in position_list if p["type"] == "SELL"]

            result = {
                "total_positions": len(position_list),
                "buy_count": len(buy_positions),
                "sell_count": len(sell_positions),
                "buy_profit": sum(p["profit"] for p in buy_positions),
                "sell_profit": sum(p["profit"] for p in sell_positions),
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
                    "success": True,
                    "message": "配置已更新",
                    "updated": updated,
                    "current_config": strategy.get_config_info()
                }, ensure_ascii=False, indent=2))]
            else:
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "message": "没有提供需要更新的参数"
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
                return [TextContent(type="text", text=json.dumps({
                    "error": "无法获取K线数据"
                }, ensure_ascii=False))]

            klines = []
            for rate in rates:
                klines.append({
                    "time": datetime.fromtimestamp(rate['time']).strftime("%Y-%m-%d %H:%M:%S"),
                    "open": float(rate['open']),
                    "high": float(rate['high']),
                    "low": float(rate['low']),
                    "close": float(rate['close']),
                    "volume": int(rate['tick_volume']),
                    "spread": int(rate['spread'])
                })

            # 计算一些基本统计
            closes = [k["close"] for k in klines]
            highs = [k["high"] for k in klines]
            lows = [k["low"] for k in klines]

            result = {
                "symbol": strategy.symbol,
                "timeframe": timeframe_str,
                "count": len(klines),
                "period": {
                    "start": klines[0]["time"] if klines else None,
                    "end": klines[-1]["time"] if klines else None
                },
                "summary": {
                    "highest": max(highs) if highs else None,
                    "lowest": min(lows) if lows else None,
                    "latest_close": closes[-1] if closes else None,
                    "price_change": closes[-1] - closes[0] if len(closes) > 1 else 0,
                    "price_change_pct": round((closes[-1] - closes[0]) / closes[0] * 100, 4) if len(closes) > 1 else 0
                },
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

            # 获取足够的K线数据用于计算指标
            rates = mt5.copy_rates_from_pos(strategy.symbol, timeframe, 0, 200)
            if rates is None or len(rates) == 0:
                return [TextContent(type="text", text=json.dumps({
                    "error": "无法获取K线数据"
                }, ensure_ascii=False))]

            closes = [float(r['close']) for r in rates]
            highs = [float(r['high']) for r in rates]
            lows = [float(r['low']) for r in rates]
            times = [datetime.fromtimestamp(r['time']).strftime("%Y-%m-%d %H:%M:%S") for r in rates]

            result = {
                "symbol": strategy.symbol,
                "timeframe": timeframe_str,
                "latest_time": times[-1],
                "latest_price": closes[-1],
                "indicators": {}
            }

            # 只返回最近20个数据点的指标值
            slice_count = 20

            if "MA" in indicators:
                ma5 = calculate_ma(closes, 5)
                ma10 = calculate_ma(closes, 10)
                ma20 = calculate_ma(closes, 20)
                ma60 = calculate_ma(closes, 60)

                result["indicators"]["MA"] = {
                    "MA5": round(ma5[-1], 5) if ma5[-1] else None,
                    "MA10": round(ma10[-1], 5) if ma10[-1] else None,
                    "MA20": round(ma20[-1], 5) if ma20[-1] else None,
                    "MA60": round(ma60[-1], 5) if ma60[-1] else None,
                    "trend": "上涨" if closes[-1] > ma20[-1] else "下跌" if ma20[-1] else "未知",
                    "recent_values": {
                        "MA5": [round(v, 5) if v else None for v in ma5[-slice_count:]],
                        "MA20": [round(v, 5) if v else None for v in ma20[-slice_count:]]
                    }
                }

            if "EMA" in indicators:
                ema12 = calculate_ema(closes, 12)
                ema26 = calculate_ema(closes, 26)

                result["indicators"]["EMA"] = {
                    "EMA12": round(ema12[-1], 5),
                    "EMA26": round(ema26[-1], 5),
                    "recent_values": {
                        "EMA12": [round(v, 5) for v in ema12[-slice_count:]],
                        "EMA26": [round(v, 5) for v in ema26[-slice_count:]]
                    }
                }

            if "RSI" in indicators:
                rsi = calculate_rsi(closes, 14)

                rsi_value = rsi[-1]
                if rsi_value:
                    if rsi_value > 70:
                        rsi_signal = "超买"
                    elif rsi_value < 30:
                        rsi_signal = "超卖"
                    else:
                        rsi_signal = "中性"
                else:
                    rsi_signal = "未知"

                result["indicators"]["RSI"] = {
                    "RSI14": round(rsi_value, 2) if rsi_value else None,
                    "signal": rsi_signal,
                    "recent_values": [round(v, 2) if v else None for v in rsi[-slice_count:]]
                }

            if "MACD" in indicators:
                macd_data = calculate_macd(closes)

                macd_value = macd_data["macd"][-1]
                signal_value = macd_data["signal"][-1]
                hist_value = macd_data["histogram"][-1]

                if macd_value and signal_value:
                    if macd_value > signal_value:
                        macd_signal = "金叉/看涨"
                    else:
                        macd_signal = "死叉/看跌"
                else:
                    macd_signal = "未知"

                result["indicators"]["MACD"] = {
                    "MACD": round(macd_value, 5) if macd_value else None,
                    "Signal": round(signal_value, 5) if signal_value else None,
                    "Histogram": round(hist_value, 5) if hist_value else None,
                    "signal": macd_signal,
                    "recent_histogram": [round(v, 5) if v else None for v in macd_data["histogram"][-slice_count:]]
                }

            if "BOLL" in indicators:
                boll = calculate_bollinger(closes, 20, 2.0)

                current_price = closes[-1]
                upper = boll["upper"][-1]
                middle = boll["middle"][-1]
                lower = boll["lower"][-1]

                if upper and lower and middle:
                    bandwidth = (upper - lower) / middle * 100
                    if current_price > upper:
                        boll_position = "突破上轨"
                    elif current_price < lower:
                        boll_position = "突破下轨"
                    elif current_price > middle:
                        boll_position = "上半区"
                    else:
                        boll_position = "下半区"
                else:
                    bandwidth = None
                    boll_position = "未知"

                result["indicators"]["BOLL"] = {
                    "upper": round(upper, 5) if upper else None,
                    "middle": round(middle, 5) if middle else None,
                    "lower": round(lower, 5) if lower else None,
                    "bandwidth_pct": round(bandwidth, 2) if bandwidth else None,
                    "position": boll_position
                }

            if "ATR" in indicators:
                atr = calculate_atr(highs, lows, closes, 14)

                atr_value = atr[-1]
                atr_pct = (atr_value / closes[-1] * 100) if atr_value else None

                result["indicators"]["ATR"] = {
                    "ATR14": round(atr_value, 5) if atr_value else None,
                    "ATR_pct": round(atr_pct, 4) if atr_pct else None,
                    "volatility": "高" if atr_pct and atr_pct > 1 else "中" if atr_pct and atr_pct > 0.5 else "低",
                    "recent_values": [round(v, 5) if v else None for v in atr[-slice_count:]]
                }

            if "STOCH" in indicators:
                stoch = calculate_stochastic(highs, lows, closes)

                k_value = stoch["k"][-1]
                d_value = stoch["d"][-1]

                if k_value and d_value:
                    if k_value > 80 and d_value > 80:
                        stoch_signal = "超买"
                    elif k_value < 20 and d_value < 20:
                        stoch_signal = "超卖"
                    elif k_value > d_value:
                        stoch_signal = "看涨"
                    else:
                        stoch_signal = "看跌"
                else:
                    stoch_signal = "未知"

                result["indicators"]["STOCH"] = {
                    "K": round(k_value, 2) if k_value else None,
                    "D": round(d_value, 2) if d_value else None,
                    "signal": stoch_signal
                }

            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        elif name == "get_market_analysis":
            timeframe_str = arguments.get("timeframe", "H1")

            timeframe = TIMEFRAME_MAP.get(timeframe_str)
            if timeframe is None:
                return [TextContent(type="text", text=json.dumps({
                    "error": f"不支持的时间周期: {timeframe_str}"
                }, ensure_ascii=False))]

            # 获取K线数据
            rates = mt5.copy_rates_from_pos(strategy.symbol, timeframe, 0, 200)
            if rates is None or len(rates) == 0:
                return [TextContent(type="text", text=json.dumps({
                    "error": "无法获取K线数据"
                }, ensure_ascii=False))]

            closes = [float(r['close']) for r in rates]
            highs = [float(r['high']) for r in rates]
            lows = [float(r['low']) for r in rates]

            current_price = closes[-1]

            # 计算各种指标
            ma20 = calculate_ma(closes, 20)
            ma60 = calculate_ma(closes, 60)
            rsi = calculate_rsi(closes, 14)
            macd_data = calculate_macd(closes)
            atr = calculate_atr(highs, lows, closes, 14)
            boll = calculate_bollinger(closes, 20, 2.0)

            # 趋势判断
            trend_signals = []
            if ma20[-1] and ma60[-1]:
                if ma20[-1] > ma60[-1]:
                    trend_signals.append("MA金叉")
                else:
                    trend_signals.append("MA死叉")

                if current_price > ma20[-1]:
                    trend_signals.append("价格在MA20上方")
                else:
                    trend_signals.append("价格在MA20下方")

            if macd_data["macd"][-1] and macd_data["signal"][-1]:
                if macd_data["macd"][-1] > macd_data["signal"][-1]:
                    trend_signals.append("MACD金叉")
                else:
                    trend_signals.append("MACD死叉")

            # 综合趋势
            bullish_count = sum(1 for s in trend_signals if "金叉" in s or "上方" in s)
            bearish_count = sum(1 for s in trend_signals if "死叉" in s or "下方" in s)

            if bullish_count > bearish_count:
                overall_trend = "看涨"
            elif bearish_count > bullish_count:
                overall_trend = "看跌"
            else:
                overall_trend = "震荡"

            # 计算支撑阻力位
            recent_highs = highs[-50:]
            recent_lows = lows[-50:]
            resistance1 = max(recent_highs)
            support1 = min(recent_lows)

            # 使用布林带作为动态支撑阻力
            dynamic_resistance = boll["upper"][-1] if boll["upper"][-1] else resistance1
            dynamic_support = boll["lower"][-1] if boll["lower"][-1] else support1

            # 波动率分析
            atr_value = atr[-1] if atr[-1] else 0
            atr_pct = (atr_value / current_price * 100) if atr_value else 0

            # RSI信号
            rsi_value = rsi[-1]
            if rsi_value:
                if rsi_value > 70:
                    rsi_signal = "超买，可能回调"
                elif rsi_value < 30:
                    rsi_signal = "超卖，可能反弹"
                elif rsi_value > 50:
                    rsi_signal = "偏强"
                else:
                    rsi_signal = "偏弱"
            else:
                rsi_signal = "未知"

            analysis = {
                "symbol": strategy.symbol,
                "timeframe": timeframe_str,
                "current_price": current_price,
                "analysis_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),

                "trend": {
                    "overall": overall_trend,
                    "signals": trend_signals,
                    "ma20": round(ma20[-1], 5) if ma20[-1] else None,
                    "ma60": round(ma60[-1], 5) if ma60[-1] else None
                },

                "momentum": {
                    "rsi": round(rsi_value, 2) if rsi_value else None,
                    "rsi_signal": rsi_signal,
                    "macd": round(macd_data["macd"][-1], 5) if macd_data["macd"][-1] else None,
                    "macd_histogram": round(macd_data["histogram"][-1], 5) if macd_data["histogram"][-1] else None
                },

                "support_resistance": {
                    "resistance1": round(resistance1, 5),
                    "support1": round(support1, 5),
                    "dynamic_resistance": round(dynamic_resistance, 5),
                    "dynamic_support": round(dynamic_support, 5),
                    "distance_to_resistance_pct": round((resistance1 - current_price) / current_price * 100, 2),
                    "distance_to_support_pct": round((current_price - support1) / current_price * 100, 2)
                },

                "volatility": {
                    "atr": round(atr_value, 5),
                    "atr_pct": round(atr_pct, 4),
                    "level": "高" if atr_pct > 1 else "中" if atr_pct > 0.5 else "低",
                    "bollinger_bandwidth_pct": round((boll["upper"][-1] - boll["lower"][-1]) / boll["middle"][-1] * 100, 2) if boll["middle"][-1] else None
                },

                "recommendation": {
                    "bias": overall_trend,
                    "confidence": "高" if abs(bullish_count - bearish_count) >= 2 else "中" if abs(bullish_count - bearish_count) == 1 else "低",
                    "notes": []
                }
            }

            # 添加建议注释
            if rsi_value and rsi_value > 70:
                analysis["recommendation"]["notes"].append("RSI超买，短期可能回调")
            elif rsi_value and rsi_value < 30:
                analysis["recommendation"]["notes"].append("RSI超卖，短期可能反弹")

            if atr_pct > 1:
                analysis["recommendation"]["notes"].append("波动率较高，注意风险控制")

            if not analysis["recommendation"]["notes"]:
                analysis["recommendation"]["notes"].append("无特殊信号")

            return [TextContent(type="text", text=json.dumps(analysis, ensure_ascii=False, indent=2))]

        elif name == "get_tick_data":
            count = min(arguments.get("count", 100), 1000)

            ticks = mt5.copy_ticks_from_pos(strategy.symbol, 0, count, mt5.COPY_TICKS_ALL)
            if ticks is None or len(ticks) == 0:
                return [TextContent(type="text", text=json.dumps({
                    "error": "无法获取Tick数据"
                }, ensure_ascii=False))]

            tick_list = []
            for tick in ticks:
                tick_list.append({
                    "time": datetime.fromtimestamp(tick['time']).strftime("%Y-%m-%d %H:%M:%S"),
                    "time_msc": int(tick['time_msc']),
                    "bid": float(tick['bid']),
                    "ask": float(tick['ask']),
                    "volume": int(tick['volume']) if 'volume' in tick.dtype.names else 0,
                    "flags": int(tick['flags'])
                })

            # 计算统计
            bids = [t["bid"] for t in tick_list]
            asks = [t["ask"] for t in tick_list]
            spreads = [t["ask"] - t["bid"] for t in tick_list]

            result = {
                "symbol": strategy.symbol,
                "count": len(tick_list),
                "period": {
                    "start": tick_list[0]["time"] if tick_list else None,
                    "end": tick_list[-1]["time"] if tick_list else None
                },
                "summary": {
                    "bid_high": max(bids) if bids else None,
                    "bid_low": min(bids) if bids else None,
                    "ask_high": max(asks) if asks else None,
                    "ask_low": min(asks) if asks else None,
                    "avg_spread": round(sum(spreads) / len(spreads), 6) if spreads else None,
                    "max_spread": max(spreads) if spreads else None,
                    "latest_bid": bids[-1] if bids else None,
                    "latest_ask": asks[-1] if asks else None
                },
                "ticks": tick_list[-50:]  # 只返回最近50条以减少数据量
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
                "success": True,
                "message": "马丁加仓功能已启用",
                "martin_enabled": True,
                "status": strategy.get_martin_status()
            }, ensure_ascii=False, indent=2))]

        elif name == "disable_martin":
            reason = arguments.get("reason", "手动禁用")
            strategy.martin_enabled = False
            strategy.martin_pause_reason = reason
            logging.warning(f"马丁已禁用 (via MCP): {reason}")
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"马丁加仓功能已禁用: {reason}",
                "martin_enabled": False,
                "reason": reason,
                "status": strategy.get_martin_status()
            }, ensure_ascii=False, indent=2))]

        elif name == "update_martin_config":
            updated = []

            if "max_atr_pct" in arguments:
                strategy.max_atr_pct = arguments["max_atr_pct"]
                updated.append(f"max_atr_pct = {arguments['max_atr_pct']}")

            if "max_boll_deviation" in arguments:
                strategy.max_boll_deviation = arguments["max_boll_deviation"]
                updated.append(f"max_boll_deviation = {arguments['max_boll_deviation']}")

            if updated:
                logging.info(f"马丁配置已更新 (via MCP): {', '.join(updated)}")
                return [TextContent(type="text", text=json.dumps({
                    "success": True,
                    "message": "马丁配置已更新",
                    "updated": updated,
                    "status": strategy.get_martin_status()
                }, ensure_ascii=False, indent=2))]
            else:
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "message": "没有提供需要更新的参数"
                }, ensure_ascii=False))]

        elif name == "notify_owner":
            message = arguments.get("message")
            if not message:
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "message": "消息内容不能为空"
                }, ensure_ascii=False))]
            
            try:
                # 调用Fay透传接口
                url = "http://127.0.0.1:5000/transparent-pass"
                payload = {
                    "user": "User",  # 默认用户
                    "text": message,
                    "audio": None
                }
                headers = {'Content-Type': 'application/json'}
                
                # 使用 run_in_executor 避免阻塞事件循环
                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(
                    None, 
                    functools.partial(requests.post, url, json=payload, headers=headers, timeout=5)
                )
                
                if response.status_code == 200:
                    return [TextContent(type="text", text=json.dumps({
                        "success": True,
                        "message": f"已通知主人: {message}"
                    }, ensure_ascii=False))]
                else:
                    return [TextContent(type="text", text=json.dumps({
                        "success": False,
                        "message": f"通知失败，Fay服务器返回状态码: {response.status_code}"
                    }, ensure_ascii=False))]
            except Exception as e:
                logging.error(f"通知主人失败: {str(e)}")
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "message": f"通知发送失败: {str(e)}"
                }, ensure_ascii=False))]

        else:
            return [TextContent(type="text", text=json.dumps({
                "error": f"未知工具: {name}"
            }, ensure_ascii=False))]

    except Exception as e:
        logging.error(f"工具调用错误 {name}: {str(e)}")
        return [TextContent(type="text", text=json.dumps({
            "error": str(e)
        }, ensure_ascii=False))]


# ============== 资源定义 ==============

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
            uri="trading://positions",
            name="持仓信息",
            description="获取当前所有持仓订单的详细信息",
            mimeType="application/json"
        ),
        Resource(
            uri="trading://strategy-doc",
            name="策略逻辑文档",
            description="获取EasyDeal交易策略的完整逻辑说明，包括爬梯机制、马丁格尔规则、风控逻辑等",
            mimeType="text/markdown"
        ),
        Resource(
            uri="trading://strategy-code",
            name="策略源代码",
            description="获取EasyDeal策略的完整Python源代码（敏感资源，仅在需要深入分析时使用）",
            mimeType="text/x-python"
        ),
    ]


@server.read_resource()
async def read_resource(uri: str) -> str:
    """读取资源"""
    strategy = get_strategy()

    if uri == "trading://status":
        return json.dumps(strategy.get_status(), ensure_ascii=False, indent=2)

    elif uri == "trading://config":
        return json.dumps(strategy.get_config_info(), ensure_ascii=False, indent=2)

    elif uri == "trading://positions":
        positions = mt5.positions_get(symbol=strategy.symbol)
        if positions is None:
            return json.dumps({"error": "无法获取持仓信息"}, ensure_ascii=False)

        position_list = []
        for pos in positions:
            if pos.magic == strategy.magic_number:
                position_list.append({
                    "ticket": pos.ticket,
                    "type": "BUY" if pos.type == mt5.ORDER_TYPE_BUY else "SELL",
                    "volume": pos.volume,
                    "open_price": pos.price_open,
                    "profit": pos.profit,
                    "comment": pos.comment
                })

        return json.dumps({"positions": position_list}, ensure_ascii=False, indent=2)

    elif uri == "trading://strategy-doc":
        return get_strategy_documentation()

    elif uri == "trading://strategy-code":
        return get_strategy_source_code()

    else:
        return json.dumps({"error": f"未知资源: {uri}"}, ensure_ascii=False)


# ============== 提示模板定义 ==============

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
        Prompt(
            name="daily_report",
            description="生成每日交易报告",
            arguments=[
                PromptArgument(
                    name="days",
                    description="报告天数",
                    required=False
                )
            ]
        ),
        Prompt(
            name="emergency_response",
            description="紧急情况响应指南",
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
- 点差: {status['market_data']['spread']}

## 策略状态
- 运行状态: {'运行中' if status['strategy_state']['running'] else '已停止'}
- 暂停状态: {'已暂停' if status['strategy_state']['paused'] else '未暂停'}
- 跟踪方向: {status['strategy_state']['follow_type'] or '无'}
- 马丁层级: {status['strategy_state']['seek']}

## 持仓情况
- 买单数量: {len(status['orders']['buy_orders'])}
- 卖单数量: {len(status['orders']['sell_orders'])}
- 马丁单: {status['orders']['martin_orders']}
- 总浮动盈亏: {status['orders']['total_profit']}

## 配置参数
- 首单手数: {config['parameters']['first_lots']}
- 爬梯步长: {config['parameters']['step']}%
- 马丁间隔: {config['parameters']['martin_interval']}
- 最大浮亏: {config['parameters']['max_loss']}
- 最大马丁层: {config['parameters']['max_martin_level']}

请分析：
1. 当前市场走势对策略的影响
2. 持仓风险评估
3. 是否需要调整策略参数
4. 下一步操作建议"""
                    )
                )
            ]
        )

    elif name == "risk_assessment":
        status = strategy.get_status()
        config = strategy.get_config_info()

        total_profit = status["orders"]["total_profit"]
        max_loss = config["parameters"]["max_loss"]

        return GetPromptResult(
            description="风险评估",
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(
                        type="text",
                        text=f"""请对当前交易进行风险评估：

## 风险指标
- 当前浮动盈亏: {total_profit}
- 最大浮亏限制: {max_loss}
- 浮亏占比: {abs(total_profit) / max_loss * 100:.1f}% (如果亏损)
- 马丁层级: {strategy.seek} / {config['parameters']['max_martin_level']}

## 持仓详情
买单:
{json.dumps(status['orders']['buy_orders'], ensure_ascii=False, indent=2)}

卖单:
{json.dumps(status['orders']['sell_orders'], ensure_ascii=False, indent=2)}

请评估：
1. 当前风险等级（低/中/高/极高）
2. 主要风险点
3. 风控建议
4. 是否需要立即采取行动"""
                    )
                )
            ]
        )

    elif name == "daily_report":
        days = int(arguments.get("days", "1")) if arguments else 1
        start_time = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
        end_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        profit_history = strategy.get_profit_history(start_time=start_time, end_time=end_time)

        return GetPromptResult(
            description="每日交易报告",
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(
                        type="text",
                        text=f"""请根据以下数据生成交易报告：

## 统计周期
{start_time} 至 {end_time}

## 交易统计
{json.dumps(profit_history.get('summary', {}), ensure_ascii=False, indent=2)}

## 小时收益分布
{json.dumps(profit_history.get('hourly_profits', []), ensure_ascii=False, indent=2)}

## 成交明细
{json.dumps(profit_history.get('deals', [])[:20], ensure_ascii=False, indent=2)}
{'...(更多交易记录已省略)' if len(profit_history.get('deals', [])) > 20 else ''}

请生成包含以下内容的报告：
1. 收益概览
2. 交易分析
3. 策略表现评估
4. 改进建议"""
                    )
                )
            ]
        )

    elif name == "emergency_response":
        status = strategy.get_status()

        return GetPromptResult(
            description="紧急情况响应",
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(
                        type="text",
                        text=f"""紧急情况响应指南

## 当前状态快照
- 总浮动盈亏: {status['orders']['total_profit']}
- 运行状态: {'运行中' if status['strategy_state']['running'] else '已停止'}
- 马丁层级: {status['strategy_state']['seek']}

## 可用的紧急操作
1. **暂停策略**: 使用 pause_strategy 工具停止开新仓
2. **全部平仓**: 使用 close_all_positions 工具 (需 confirm=true)
3. **调整参数**: 使用 update_config 工具调整风控参数

## 应急检查清单
- [ ] 确认当前市场状况
- [ ] 评估浮亏是否在可接受范围
- [ ] 检查马丁层级是否过高
- [ ] 决定是否需要人工干预

请根据当前状况，建议最合适的应急响应措施。"""
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


# ============== 主函数 ==============

async def main():
    """运行MCP服务器"""
    logging.info("启动 EasyDeal MCP Server")

    # 初始化MT5连接
    if not mt5.initialize():
        logging.error("MT5初始化失败")
        print("错误: MT5初始化失败，请确保MetaTrader 5已运行")
        return

    logging.info("MT5连接成功")

    try:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options()
            )
    finally:
        mt5.shutdown()
        logging.info("MCP Server已关闭")


if __name__ == "__main__":
    asyncio.run(main())
