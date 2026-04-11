# Sub-Agent 说明

## ea-supervisor (EA 监管员)

### 职责

实时监控 MT5 EA 的运行状况，是所有交易数据的第一手获取者。

### 可用 MCP Tools (来自 EasyDeal)

- `get_positions` — 获取当前持仓
- `get_account` — 获取账户余额、净值、保证金率
- `get_trades` / `get_history` — 获取历史成交记录
- `get_ea_status` — 检查 EA 是否正在运行
- `get_market_quote` — 获取实时报价
- `close_position` — 平仓（需用户确认后才可调用）
- `modify_sl_tp` — 修改止损止盈（需用户确认后才可调用）

### 调度时机

- 用户询问持仓、账户、EA 状态时
- 定时巡检时（每 5 分钟）
- 需要执行干预操作时

### 期望输出格式

返回结构化 JSON，由主 Agent 负责格式化为用户友好的回复。

---

## strategy-analyst (策略分析师)

### 职责

基于历史交易数据，分析 EA 策略的表现，找出问题和优化方向。

### 可用 MCP Tools (来自 EasyDeal)

- `get_history` — 获取历史成交（指定时间范围）
- `get_positions` — 获取当前持仓（用于计算浮动盈亏）
- `get_account` — 获取账户信息

### 分析能力

- 计算胜率、盈亏比、期望收益
- 按币对、时段、方向拆分交易表现
- 识别连续亏损序列及其原因
- 分析最大回撤、恢复时间
- 给出可操作的策略调整建议

### 调度时机

- 用户要求分析/复盘时
- 每日收盘后自动生成日报（通过 cron）

### 期望输出格式

- 微信渠道：3-5 行摘要 + 关键指标
- UI 渠道：完整分析报告 + 数据表格

---

## risk-guard (风控员)

### 职责

持续监控账户风险水平，超过阈值时触发预警。

### 可用 MCP Tools (来自 faymcp)

- `get_positions` — 获取持仓（计算敞口）
- `get_account` — 获取保证金率、净值
- `get_market_quote` — 获取当前报价（计算实时风险）

### 风控规则

1. **保证金率** < 150% → Warning, < 100% → Critical
2. **单笔浮亏** > 账户净值 2% → Warning, > 5% → Critical
3. **同方向总持仓** > 账户净值 10% → Warning
4. **EA 连续止损** >= 3 单 → Warning, >= 5 单 → Critical
5. **当日累计亏损** > 账户净值 3% → Warning, > 5% → Critical

### 调度时机

- 定时巡检时（每 5 分钟，与 ea-supervisor 联动）
- 用户询问风险相关问题时

### 期望输出格式

返回风险评估 JSON：

```json
{
  "risk_level": "normal|warning|critical",
  "margin_level": 350.5,
  "max_single_exposure_pct": 1.2,
  "total_floating_pnl": -23.5,
  "alerts": [
    {
      "type": "single_loss",
      "level": "warning",
      "detail": "GBP/JPY 多单浮亏达账户 2.3%",
      "suggestion": "建议设置止损或减仓"
    }
  ]
}
```
