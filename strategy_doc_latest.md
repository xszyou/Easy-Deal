# GMarket v1.082 策略说明

> 基于开源 `GMarket.mq5` v1.082 的静态逻辑整理。EA 为 standalone 单文件：在 MT5 的输入参数窗口配置和编译运行，不依赖 EasyDeal 文件桥、外部 include 或第三方包。

## 核心逻辑

- **双向对冲起步**：在 `InpOrderTime` 延迟后，同时开同手数 BUY / SELL；任一腿失败会回滚，并按 `InpRetrySeconds` 延后重试。
- **顺势梯子**：价格按 `step` 达到方向阈值时，平该方向上一张 base 后以 `firstLots` 重开，滚动实现顺势止盈。
- **逆势马丁**：已确定梯子方向后，满足 `martinInterval`、`filter` 和过滤条件时，在亏损侧补 base 与马丁单；`seek` 只计马丁层数。
- **退出**：马丁组净收益（含利润、隔夜利息和手续费）达到 `InpMartinExitProfit` 时退出；`0` 表示回正即退出。`InpMartinBreakevenProfit` 可启用零损保护缓冲。

## 风险与周机制

- **最大亏损与冷却**：跟踪仓位浮亏达到 `InpMaxLoss` 时全平并重置；若设置 `InpCutCooldownHours`，冷却期内不启动新一轮交易。
- **独立周统计**：按券商真实交易周建立本 EA、当前品种和魔术号的周基准，独立计算周内已平与在仓盈亏。达到 `InpWeekProfitLock`（周盈落袋）或 `InpWeekLossHalt`（周亏熔断）即全平，并停至下个交易周。
- **周末软着陆**：以品种实际周收盘会话计算 `InpSoftCloseHours` 窗口；窗口内不新开首单、梯子、补腿或马丁。已有马丁组可自然退出，退出后全平收工；无马丁组则平对冲底仓。
- **手数封顶**：`InpMartinLotCap` 限制每张马丁单的最大手数（`0` 关闭），不改变起始手数。
- **新周保护**：周基准只在品种可交易后建立；`InpWeekResetGuardSecs` 在重置后暂禁新仓，`InpWeekStartDelayHours` 可从真实周开盘起再延迟启动新一轮。等待期仍管理既有持仓、风控和退出。

## 马丁过滤与订单范围

马丁需同时通过开关、ATR、布林偏离和可选的 MT5 原生经济日历过滤。新闻窗口由 `InpNewsBeforeMinutes` / `InpNewsAfterMinutes` 和重要性参数控制，并按品种货币匹配。EA 默认按当前品种和 `InpMagicNumber` 跟踪；只有显式开启忽略魔术号时才会纳入同品种其他订单。

## 关键参数

- `InpFirstLots`、`InpStep`、`InpMartinInterval`、`InpFilter`：起始手数、梯子和马丁触发条件。
- `InpMaxLoss`、`InpMaxMartinLevel`、`InpMartinLotCap`、`InpCutCooldownHours`：亏损、层数、手数和割肉冷却限制。
- `InpMartinExitProfit`、`InpMartinBreakevenProfit`：马丁组退出目标与零损保护缓冲。
- `InpWeekProfitLock`、`InpWeekLossHalt`、`InpSoftCloseHours`：周盈/周亏和周末软着陆。
- `InpWeekResetOnBoot`、`InpWeekResetGuardSecs`、`InpWeekStartDelayHours`：周基准、重置保护和周开盘延迟。

## 稳定性与操作

EA 对部分成交进行认领轮询，处理缺腿和已消失的历史 ticket，避免重复补单或无效平仓循环；稳定态出现奇数持仓时会安全停机，等待人工检查，而非继续带病加仓。图表按钮可暂停策略、开关马丁、切换魔术号过滤和手动重建持仓状态。

> **风险提示：** 对冲和马丁并不消除风险。请先在策略测试器和模拟账户验证，按账户规模设置手数、最大亏损和周限制；本说明不构成投资建议，也不保证收益。
