# 定时巡检任务

# 路径: ~/.openclaw/workspaces/forex-commander/cron/patrol.md

# 

# OpenClaw cron 任务定义

# 用法: openclaw cron add --file patrol.md

## 任务: 交易巡检 (每 5 分钟)

schedule: "*/5 * * * *"
agent: forex-commander
session: "cron:patrol"

### 指令

请执行例行巡检：

1. 调度 ea-supervisor 执行巡检：
   
   - 检查 EA 运行状态
   - 获取当前持仓
   - 获取账户状态

2. 调度 risk-guard 执行风险评估：
   
   - 基于持仓和账户数据评估风险等级

3. 汇总结果：
   
   - 如果 risk_level 为 "critical"：立即通过所有渠道推送预警
   - 如果 risk_level 为 "warning"：通过微信推送
   - 如果 risk_level 为 "normal" 或 "caution"：记录到日志，不推送

4. 如果 EA 停止运行（get_ea_status 返回非活跃状态）：
   
   - 无论其他指标如何，立即发送 Critical 预警

请精简输出，巡检正常时只输出一行摘要。

---

## 任务: 每日收盘报告 (每天 UTC 22:00)

schedule: "0 22 * * 1-5"
agent: forex-commander
session: "cron:daily-report"

### 指令

请生成今日交易日报：

1. 调度 ea-supervisor 获取今日完整交易历史
2. 调度 strategy-analyst 分析今日交易表现
3. 调度 risk-guard 给出当前风险评估

将三份报告合并为一份简报，通过微信推送给用户。格式：

📊 每日交易简报 [日期]

- 今日交易：X 笔 | 胜率 XX%
- 净盈亏：+/-$XX
- 当前持仓：X 笔 | 浮动盈亏 +/-$XX
- 风险等级：正常/注意/警告
- [如有] 分析师建议：...
