"""
EasyDeal 监控服务
定期检查策略状态，在触发条件时调用回调或发送通知
可配合 MCP Server 使用，为 Agent 提供事件驱动的触发点
"""

import time
import json
import logging
import requests
from datetime import datetime, timedelta
from typing import Callable, Optional
import MetaTrader5 as mt5

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class TradingMonitor:
    """交易监控器"""

    def __init__(self, strategy):
        self.strategy = strategy
        self.callbacks = []
        self.last_alert_time = {}
        self.alert_cooldown = 300  # 同类告警冷却时间（秒）

        # 告警阈值配置
        self.config = {
            # 风险告警
            "loss_warning_pct": 30,      # 浮亏达到最大浮亏的30%时警告
            "loss_danger_pct": 50,       # 浮亏达到50%时危险告警
            "loss_critical_pct": 70,     # 浮亏达到70%时紧急告警

            # 马丁层级告警
            "martin_warning_level": 2,   # 马丁2层时警告
            "martin_danger_level": 3,    # 马丁3层时危险
            "martin_critical_level": 4,  # 马丁4层时紧急

            # 马丁控制建议阈值
            "martin_disable_atr_pct": 1.2,      # ATR超过此值建议禁用马丁
            "martin_disable_boll_dev": 1.8,     # 布林带偏离超过此值建议禁用马丁

            # 技术指标告警
            "rsi_overbought": 70,        # RSI超买
            "rsi_oversold": 30,          # RSI超卖
            "volatility_high_pct": 1.5,  # ATR%高波动阈值

            # MACD告警
            "macd_cross_alert": True,              # 是否开启金叉死叉告警
            "macd_divergence_alert": True,         # 是否开启背离告警
            "macd_zero_cross_alert": True,         # 是否开启零轴穿越告警
            "macd_histogram_reversal_bars": 3,     # 柱状图连续反转N根告警

            # 检查间隔（秒）
            "risk_check_interval": 60,
            "market_check_interval": 300,
            "status_check_interval": 30,
            
            # 定时报告间隔
            "hourly_report_interval": 3600,
        }

        # 状态追踪
        self.last_status = None
        self.last_market_analysis = None
        self.last_macd_state = None  # 追踪MACD状态变化
        self.last_hourly_report_time = 0  # 上次小时报时间

    def add_callback(self, callback: Callable):
        """添加回调函数"""
        self.callbacks.append(callback)

    def notify(self, event_type: str, level: str, message: str, data: dict = None):
        """发送通知"""
        # 检查冷却
        alert_key = f"{event_type}:{level}"
        now = time.time()
        if alert_key in self.last_alert_time:
            if now - self.last_alert_time[alert_key] < self.alert_cooldown:
                return  # 在冷却期内，跳过

        self.last_alert_time[alert_key] = now

        event = {
            "timestamp": datetime.now().isoformat(),
            "event_type": event_type,
            "level": level,  # info, warning, danger, critical
            "message": message,
            "data": data or {}
        }

        logger.log(
            logging.CRITICAL if level == "critical" else
            logging.WARNING if level in ["warning", "danger"] else
            logging.INFO,
            f"[{level.upper()}] {event_type}: {message}"
        )

        # 调用所有回调
        for callback in self.callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"回调执行失败: {e}")

    def check_risk(self) -> dict:
        """检查风险状况"""
        status = self.strategy.get_status()
        config = self.strategy.get_config_info()

        total_profit = status["orders"]["total_profit"]
        max_loss = config["parameters"]["max_loss"]
        martin_level = self.strategy.seek
        max_martin = config["parameters"]["max_martin_level"]

        alerts = []

        # 检查浮亏
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

        # 检查马丁层级
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

    def check_market(self) -> dict:
        """检查市场状况"""
        symbol = self.strategy.symbol

        # 获取K线数据
        rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_H1, 0, 100)
        if rates is None or len(rates) == 0:
            return {"error": "无法获取行情数据"}

        closes = [float(r['close']) for r in rates]
        highs = [float(r['high']) for r in rates]
        lows = [float(r['low']) for r in rates]

        # 计算RSI
        rsi = self._calculate_rsi(closes, 14)
        current_rsi = rsi[-1] if rsi[-1] else 50

        # 计算ATR
        atr = self._calculate_atr(highs, lows, closes, 14)
        atr_pct = (atr[-1] / closes[-1] * 100) if atr[-1] else 0

        # 计算MACD
        macd_data = self._calculate_macd(closes)
        macd_line = macd_data["macd"]
        signal_line = macd_data["signal"]
        histogram = macd_data["histogram"]

        alerts = []

        # RSI告警
        if current_rsi >= self.config["rsi_overbought"]:
            self.notify("market_rsi", "warning",
                f"RSI={current_rsi:.1f} 进入超买区域",
                {"rsi": current_rsi})
            alerts.append("rsi_overbought")
        elif current_rsi <= self.config["rsi_oversold"]:
            self.notify("market_rsi", "warning",
                f"RSI={current_rsi:.1f} 进入超卖区域",
                {"rsi": current_rsi})
            alerts.append("rsi_oversold")

        # 波动率告警
        if atr_pct >= self.config["volatility_high_pct"]:
            self.notify("market_volatility", "warning",
                f"市场波动率较高 ATR={atr_pct:.2f}%",
                {"atr_pct": atr_pct})
            alerts.append("high_volatility")

        # 马丁控制建议 - 基于波动率
        if atr_pct >= self.config["martin_disable_atr_pct"]:
            martin_status = self.strategy.get_martin_status() if hasattr(self.strategy, 'get_martin_status') else None
            if martin_status and martin_status.get("martin_enabled", True):
                self.notify("martin_control", "warning",
                    f"建议禁用马丁: ATR波动率较高({atr_pct:.2f}%)，单边行情风险增加。可调用 disable_martin 工具暂停马丁加仓。",
                    {"atr_pct": atr_pct, "threshold": self.config["martin_disable_atr_pct"], "action": "disable_martin"})
                alerts.append("martin_disable_suggested")

        # 马丁控制建议 - 基于布林带偏离
        boll_deviation = self._check_bollinger_deviation(closes, highs, lows)
        if boll_deviation and boll_deviation >= self.config["martin_disable_boll_dev"]:
            martin_status = self.strategy.get_martin_status() if hasattr(self.strategy, 'get_martin_status') else None
            if martin_status and martin_status.get("martin_enabled", True):
                self.notify("martin_control", "warning",
                    f"建议禁用马丁: 价格偏离布林带中轨过大({boll_deviation:.2f}倍标准差)，趋势行情中马丁风险增加。可调用 disable_martin 工具暂停马丁加仓。",
                    {"boll_deviation": boll_deviation, "threshold": self.config["martin_disable_boll_dev"], "action": "disable_martin"})
                alerts.append("martin_disable_suggested")

        # MACD告警
        macd_alerts = self._check_macd_alerts(macd_line, signal_line, histogram, closes, highs, lows)
        alerts.extend(macd_alerts)

        return {
            "rsi": current_rsi,
            "atr_pct": atr_pct,
            "price": closes[-1],
            "macd": macd_line[-1] if macd_line[-1] else 0,
            "macd_signal": signal_line[-1] if signal_line[-1] else 0,
            "macd_histogram": histogram[-1] if histogram[-1] else 0,
            "alerts": alerts
        }

    def check_status(self) -> dict:
        """检查策略状态"""
        status = self.strategy.get_status()

        alerts = []

        # 检查策略是否停止
        if not status["strategy_state"]["running"]:
            self.notify("status", "critical",
                "策略已停止运行！",
                {"running": False})
            alerts.append("strategy_stopped")

        # 检查是否暂停
        if status["strategy_state"]["paused"]:
            self.notify("status", "info",
                "策略当前处于暂停状态",
                {"paused": True})
            alerts.append("strategy_paused")

        # 检查持仓变化
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

    def send_hourly_report(self):
        """发送每小时巡逻报告"""
        try:
            status = self.strategy.get_status()
            symbol = self.strategy.symbol
            
            # 获取市场数据
            rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_H1, 0, 100)
            if rates is None or len(rates) == 0:
                logger.error("无法获取K线数据用于小时报")
                return

            closes = [float(r['close']) for r in rates]
            highs = [float(r['high']) for r in rates]
            lows = [float(r['low']) for r in rates]
            current_price = closes[-1]

            # 计算指标
            boll_deviation = self._check_bollinger_deviation(closes, highs, lows) or 0
            macd_data = self._calculate_macd(closes)
            macd_val = macd_data["macd"][-1] if macd_data["macd"] else 0
            
            # 策略状态
            total_profit = status["orders"]["total_profit"]
            martin_status = self.strategy.get_martin_status() if hasattr(self.strategy, 'get_martin_status') else {}
            martin_enabled = martin_status.get("martin_enabled", False)
            seek = status["strategy_state"]["seek"]
            
            # 构建消息
            message = (
                f"🛡️ 定时巡逻报告\n"
                f"当前价格: {current_price:.5f}\n"
                f"总浮动盈亏: {total_profit:.2f}\n"
                f"马丁层级: {seek}\n"
                f"马丁状态: {'✅开启' if martin_enabled else '⛔关闭'}\n"
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
            logger.error(f"发���小时报失败: {e}")

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

        for i in range(period, len(gains)):
            avg_gain = (avg_gain * (period-1) + gains[i]) / period
            avg_loss = (avg_loss * (period-1) + losses[i]) / period

            if avg_loss == 0:
                rsi.append(100)
            else:
                rsi.append(100 - (100 / (1 + avg_gain/avg_loss)))

        if avg_loss == 0:
            rsi.append(100)
        else:
            rsi.append(100 - (100 / (1 + avg_gain/avg_loss)))

        return rsi

    def _calculate_atr(self, highs, lows, closes, period=14):
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
            atr.append((atr[-1] * (period-1) + tr[i]) / period)

        return atr

    def _check_bollinger_deviation(self, closes, highs, lows, period=20, std_dev=2.0):
        """检查当前价格偏离布林带中轨的标准差倍数"""
        if len(closes) < period:
            return None

        recent_closes = closes[-period:]
        middle = sum(recent_closes) / period
        variance = sum((x - middle) ** 2 for x in recent_closes) / period
        std = variance ** 0.5

        if std == 0:
            return 0

        current_price = closes[-1]
        deviation = abs(current_price - middle) / std
        return deviation

    def _calculate_ema(self, data: list, period: int) -> list:
        """计算EMA"""
        ema = []
        multiplier = 2 / (period + 1)
        for i in range(len(data)):
            if i == 0:
                ema.append(data[0])
            else:
                ema.append((data[i] - ema[-1]) * multiplier + ema[-1])
        return ema

    def _calculate_macd(self, closes: list, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
        """计算MACD指标"""
        ema_fast = self._calculate_ema(closes, fast)
        ema_slow = self._calculate_ema(closes, slow)

        macd_line = [f - s for f, s in zip(ema_fast, ema_slow)]

        # 计算信号线
        signal_line = self._calculate_ema(macd_line, signal)

        # 计算柱状图
        histogram = [m - s for m, s in zip(macd_line, signal_line)]

        return {
            "macd": macd_line,
            "signal": signal_line,
            "histogram": histogram
        }

    def _check_macd_alerts(self, macd_line: list, signal_line: list, histogram: list,
                           closes: list, highs: list, lows: list) -> list:
        """检查MACD相关告警"""
        alerts = []

        if len(macd_line) < 3 or len(signal_line) < 3:
            return alerts

        current_macd = macd_line[-1]
        prev_macd = macd_line[-2]
        current_signal = signal_line[-1]
        prev_signal = signal_line[-2]
        current_hist = histogram[-1]
        prev_hist = histogram[-2]

        # 1. 金叉死叉告警
        if self.config["macd_cross_alert"]:
            # 金叉: MACD从下向上穿越信号线
            if prev_macd <= prev_signal and current_macd > current_signal:
                level = "warning"
                # 零轴上方金叉更强
                if current_macd > 0:
                    level = "info"
                    message = f"MACD金叉（零轴上方）- 强烈看涨信号"
                else:
                    message = f"MACD金叉（零轴下方）- 看涨信号"

                self.notify("macd_cross", level, message, {
                    "type": "golden_cross",
                    "macd": round(current_macd, 5),
                    "signal": round(current_signal, 5),
                    "above_zero": current_macd > 0
                })
                alerts.append("macd_golden_cross")

            # 死叉: MACD从上向下穿越信号线
            elif prev_macd >= prev_signal and current_macd < current_signal:
                level = "warning"
                # 零轴下方死叉更危险
                if current_macd < 0:
                    level = "danger"
                    message = f"MACD死叉（零轴下方）- 强烈看跌信号"
                else:
                    message = f"MACD死叉（零轴上方）- 看跌信号"

                self.notify("macd_cross", level, message, {
                    "type": "death_cross",
                    "macd": round(current_macd, 5),
                    "signal": round(current_signal, 5),
                    "below_zero": current_macd < 0
                })
                alerts.append("macd_death_cross")

        # 2. 零轴穿越告警
        if self.config["macd_zero_cross_alert"]:
            # 上穿零轴
            if prev_macd <= 0 and current_macd > 0:
                self.notify("macd_zero", "info",
                    f"MACD上穿零轴 - 趋势转多",
                    {"macd": round(current_macd, 5), "direction": "up"})
                alerts.append("macd_zero_cross_up")

            # 下穿零轴
            elif prev_macd >= 0 and current_macd < 0:
                self.notify("macd_zero", "warning",
                    f"MACD下穿零轴 - 趋势转空",
                    {"macd": round(current_macd, 5), "direction": "down"})
                alerts.append("macd_zero_cross_down")

        # 3. 柱状图反转告警
        if self.config["macd_histogram_reversal_bars"] > 0:
            reversal_bars = self.config["macd_histogram_reversal_bars"]

            # 检查柱状图是否连续N根同向变化后反转
            if len(histogram) >= reversal_bars + 1:
                recent_hist = histogram[-(reversal_bars + 1):]

                # 检查之前N根是否同向递增/递减
                prev_increasing = all(recent_hist[i] < recent_hist[i+1] for i in range(reversal_bars - 1))
                prev_decreasing = all(recent_hist[i] > recent_hist[i+1] for i in range(reversal_bars - 1))

                # 最后一根反转
                if prev_increasing and recent_hist[-1] < recent_hist[-2]:
                    self.notify("macd_histogram", "warning",
                        f"MACD柱状图由增转减 - 上涨动能减弱",
                        {"histogram": round(current_hist, 5), "reversal": "bearish"})
                    alerts.append("macd_histogram_bearish_reversal")

                elif prev_decreasing and recent_hist[-1] > recent_hist[-2]:
                    self.notify("macd_histogram", "info",
                        f"MACD柱状图由减转增 - 下跌动能减弱",
                        {"histogram": round(current_hist, 5), "reversal": "bullish"})
                    alerts.append("macd_histogram_bullish_reversal")

        # 4. 背离告警
        if self.config["macd_divergence_alert"]:
            divergence = self._check_macd_divergence(macd_line, closes, highs, lows)
            if divergence:
                alerts.append(divergence["type"])

        # 更新MACD状态
        self.last_macd_state = {
            "macd": current_macd,
            "signal": current_signal,
            "histogram": current_hist,
            "cross_state": "above" if current_macd > current_signal else "below"
        }

        return alerts

    def _check_macd_divergence(self, macd_line: list, closes: list, highs: list, lows: list) -> Optional[dict]:
        """检查MACD背离"""
        lookback = 20  # 回溯周期

        if len(macd_line) < lookback or len(closes) < lookback:
            return None

        recent_macd = macd_line[-lookback:]
        recent_closes = closes[-lookback:]
        recent_highs = highs[-lookback:]
        recent_lows = lows[-lookback:]

        # 找价格高点和低点
        price_high_idx = recent_highs.index(max(recent_highs))
        price_low_idx = recent_lows.index(min(recent_lows))

        # 顶背离: 价格创新高，但MACD没有创新高
        if price_high_idx > lookback // 2:  # 高点在后半段
            first_half_macd_max = max(recent_macd[:lookback//2])
            second_half_macd_max = max(recent_macd[lookback//2:])
            first_half_price_max = max(recent_highs[:lookback//2])
            second_half_price_max = max(recent_highs[lookback//2:])

            if second_half_price_max > first_half_price_max and second_half_macd_max < first_half_macd_max:
                self.notify("macd_divergence", "danger",
                    f"MACD顶背离 - 价格新高但MACD未能跟随，可能见顶",
                    {"type": "bearish_divergence", "price_high": second_half_price_max})
                return {"type": "macd_bearish_divergence"}

        # 底背离: 价格创新低，但MACD没有创新低
        if price_low_idx > lookback // 2:  # 低点在后半段
            first_half_macd_min = min(recent_macd[:lookback//2])
            second_half_macd_min = min(recent_macd[lookback//2:])
            first_half_price_min = min(recent_lows[:lookback//2])
            second_half_price_min = min(recent_lows[lookback//2:])

            if second_half_price_min < first_half_price_min and second_half_macd_min > first_half_macd_min:
                self.notify("macd_divergence", "info",
                    f"MACD底背离 - 价格新低但MACD未能跟随，可能见底",
                    {"type": "bullish_divergence", "price_low": second_half_price_min})
                return {"type": "macd_bullish_divergence"}

        return None

    def run(self):
        """启动监控循环"""
        logger.info("监控服务启动")

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

                # 市场检查（最不频繁）
                if now - last_market_check >= self.config["market_check_interval"]:
                    self.check_market()
                    last_market_check = now

                # 小时巡逻报告
                if now - self.last_hourly_report_time >= self.config["hourly_report_interval"]:
                    # 首次运行不立即发送，或者可以根据需求调整。这里假设首次运行也发送一次作为确认
                    if self.last_hourly_report_time == 0:
                        self.last_hourly_report_time = now # 避免启动立即发，等一个周期。如果想立即发，可以把这行去掉或者逻辑调整
                    else:
                        self.send_hourly_report()
                        self.last_hourly_report_time = now

            except Exception as e:
                logger.error(f"监控检查失败: {e}")

            time.sleep(10)  # 主循环间隔


class WebhookCallback:
    """Webhook 回调"""

    def __init__(self, url: str, headers: dict = None):
        self.url = url
        self.headers = headers or {"Content-Type": "application/json"}

    def __call__(self, event: dict):
        try:
            response = requests.post(
                self.url,
                json=event,
                headers=self.headers,
                timeout=10
            )
            if response.status_code != 200:
                logger.warning(f"Webhook 响应异常: {response.status_code}")
        except Exception as e:
            logger.error(f"Webhook 调用失败: {e}")


class FileCallback:
    """文件记录回调"""

    def __init__(self, filepath: str = "logs/monitor_events.jsonl"):
        self.filepath = filepath

    def __call__(self, event: dict):
        with open(self.filepath, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")


class AgentCallback:
    """Agent 终端回调 - 将预警发送到Agent处理"""

    def __init__(self, url: str = "http://127.0.0.1:5000/v1/chat/completions",
                 api_key: str = "YOUR_API_KEY",
                 model: str = "fay-streming",
                 role: str = "安监",
                 cooldown: int = 1800):  # 同类预警冷却时间（秒），默认30分钟
        self.url = url
        self.api_key = api_key
        self.model = model
        self.role = role
        self.cooldown = cooldown
        self.last_alert_time = {}  # 记录每种预警的最后发送时间

    def __call__(self, event: dict):
        # 检查冷却期，避免重复发送相同预警
        alert_key = f"{event['event_type']}:{event['level']}"
        now = time.time()
        if alert_key in self.last_alert_time:
            if now - self.last_alert_time[alert_key] < self.cooldown:
                logger.debug(f"Agent回调跳过（冷却中）: {alert_key}")
                return
        self.last_alert_time[alert_key] = now

        # 发送预警到Agent终端
        try:
            # 构建提示词
            level_emoji = {
                "info": "ℹ️",
                "warning": "⚠️",
                "danger": "🚨",
                "critical": "🆘"
            }
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
                'messages': [
                    {'role': self.role, 'content': prompt}
                ],
                'stream': True
            }

            response = requests.post(
                self.url,
                headers=headers,
                data=json.dumps(data),
                stream=True,
                timeout=30
            )

            if response.status_code != 200:
                logger.error(f"Agent回调失败，状态码：{response.status_code}")
                return

            # 处理流式响应
            full_response = ""
            for line in response.iter_lines(decode_unicode=True):
                if line:
                    if line.strip() == 'data: [DONE]':
                        break
                    if line.startswith('data:'):
                        line = line[5:].strip()
                        try:
                            data = json.loads(line)
                            choices = data.get('choices')
                            if choices:
                                delta = choices[0].get('delta', {})
                                content = delta.get('content', '')
                                full_response += content
                        except json.JSONDecodeError:
                            pass

            if full_response:
                logger.info(f"Agent响应: {full_response[:200]}...")

        except Exception as e:
            logger.error(f"Agent回调执行失败: {e}")


# ============== 使用示例 ==============

if __name__ == "__main__":
    from easydeal_mt5 import EasyDealStrategy

    # 初始化MT5
    if not mt5.initialize():
        print("MT5初始化失败")
        exit(1)

    # 创建策略实例
    strategy = EasyDealStrategy()

    # 创建监控器
    monitor = TradingMonitor(strategy)

    # 添加回调
    monitor.add_callback(FileCallback())  # 记录到文件
    # monitor.add_callback(WebhookCallback("https://your-webhook-url.com/events"))  # 发送到webhook

    # 添加Agent回调 - 发送预警到Agent终端处理
    monitor.add_callback(AgentCallback(
        url="http://127.0.0.1:5000/v1/chat/completions",
        api_key="YOUR_API_KEY",
        model="fay-streming",
        role="安监",
        cooldown=1800  # 同类预警30分钟内不重复发送
    ))

    # 自定义回调示例：打印到控制台
    def console_callback(event):
        level = event["level"]
        if level in ["danger", "critical"]:
            print(f"\n{'='*50}")
            print(f"⚠️  {event['event_type']}: {event['message']}")
            print(f"{'='*50}\n")

    monitor.add_callback(console_callback)

    # 启动监控
    try:
        monitor.run()
    except KeyboardInterrupt:
        print("\n监控服务已停止")
    finally:
        mt5.shutdown()
