# GMarket 策略说明（只读）

> 基于 `GMarket.mq5` 的静态逻辑整理。该文档不参与自动更新，仅用于对照实际运行是否一致。

## 1. 核心思路（概要）
- **双向对冲起步**：首次同时开 BUY 与 SELL（同手数 firstLots）。
- **顺势“梯子”止盈**：当价格按设定步长 step% 向某方向运行时，关闭该方向上一笔并立刻同方向重开（滚动止盈）。
- **逆势马丁加仓**：当价格向相反方向回撤超过阈值（filter% 与 martinInterval%）时，在亏损侧增加马丁单，尝试回到盈亏平衡。
- **风险控制**：浮亏达到 maxLoss 时强制平仓并重置。

## 2. 交易流程（细节）
### 2.1 初始化
- 读入输入参数，设置 ATR(Bars=14, H1)、Bollinger(20,2.0) 指标句柄。
- `openTime = now + orderTime`，用于控制首次开仓时间。

### 2.2 起始开仓（对冲）
条件：`TimeCurrent() >= openTime` 且无持仓且非暂停。
- 同时开：
  - BUY `firstLots`（comment: “Buy first order”）
  - SELL `firstLots`（comment: “Sell first order”）
- 任一腿失败会回滚已开的腿，并延迟 `retrySeconds` 后重试。

### 2.3 梯子（顺势滚动）
当已经有持仓时，每个 Tick 检查：
- **向上梯子（Buy 方向）**：
  - 条件：`(Bid - lastBuyOpenPrice) / lastBuyOpenPrice >= step%`
  - 行为：平掉 lastBuy，再开新 BUY `firstLots`。
  - 若此前未设方向，则将 `followType = BUY`，并记录 `lastMartinOrderTick = lastSellOrderTick`。
- **向下梯子（Sell 方向）**：
  - 条件：`(lastSellOpenPrice - Ask) / lastSellOpenPrice >= step%`
  - 行为：平掉 lastSell，再开新 SELL `firstLots`。
  - 若此前未设方向，则将 `followType = SELL`，并记录 `lastMartinOrderTick = lastBuyOrderTick`。

### 2.4 马丁加仓（逆势）
仅在 `followType` 已确定时触发；且需要满足 `CheckMartinConditions()` 过滤（见第 4 节）。

- **当 followType = BUY（价格先上行）**：
  - 若价格回撤满足：
    - `(lastSellMartinOpenPrice - Ask) / lastSellMartinOpenPrice <= -martinInterval%` 且
    - `(Bid - lastBuyOpenPrice) / lastBuyOpenPrice <= -filter%`
  - 动作：
    1. 把当前 `lastSell` 记入马丁数组 `martinOrders`，`martinOrderCount++`
    2. 先开一笔 **Sell base**（`firstLots`）以维持对冲
    3. 再开一笔 **Sell martin**（手数按倍增规则），成功后 `seek++`

- **当 followType = SELL（价格先下行）**：
  - 若价格回撤满足：
    - `(Bid - lastBuyMartinOpenPrice) / lastBuyMartinOpenPrice <= -martinInterval%` 且
    - `(lastSellOpenPrice - Ask) / lastSellOpenPrice <= -filter%`
  - 动作对称：
    1. 记入 `lastBuy` 到马丁数组，`martinOrderCount++`
    2. 开 **Buy base**（`firstLots`）
    3. 开 **Buy martin**（手数倍增），成功后 `seek++`
  
注：若无上一张马丁单，则用当前同方向 base 单价格作为 `martinInterval` 的参考价。
注2：`seek` 表示**马丁层数（仅统计马丁单）**；`martinOrderCount` 表示 `martinOrders` 的条目数（包含同向 base + 马丁单）。

**倍增规则**：
- 若有前一笔马丁单：
  - `seek > 0` 时：`(lastLots + firstLots) * 2`
  - 否则：`lastLots * 2`
- 若无法取到上一手数：默认 `firstLots * 2`

### 2.5 马丁平衡与退出
- 当 `martinBreakevenProfit > 0`：
  - 优先检查**当前马丁单 + 同向 base 单**的合计浮盈；
  - 若其合计浮盈 >= **爬梯方向 base 单当前亏损** + `martinBreakevenProfit`（缓冲金额），
    则将可识别订单的止损设置到开仓价并计入点差与手续费（零损保护）。
  - 同向 base 单指**马丁触发时新开的 base**（不含首单）；若无法识别，则仅对当前马丁单触发零损保护。
- 当 `seek > 0` 且 `calcTotalMartinOrdersProfit() >= 0`：
  - 关闭所有马丁单，并重置 `seek = 0`，`followType = -1`。
  - 若为 BUY 方向，重新开一笔 Sell base；若为 SELL 方向，重新开一笔 Buy base。
  - 该函数统计 `profit + swap + commission`（含手续费）。

### 2.6 方向重置
- 当 `seek == 0` 且反向 base 单盈利 >= 0，会把 `followType` 重置为 `-1`，等待下一次梯子确定方向。

### 2.7 最大亏损强平
- 若所有持仓浮动盈亏之和 `<= -maxLoss`：
  - 立即平掉所有跟踪单，`ResetAllStatus()`。

## 3. 订单识别与跟踪
- 仅跟踪当前品种（`_Symbol`）。
- 若 `InpIgnoreMagicNumber = false`，则必须匹配 `MAGIC_NUMBER`。
- 对应状态支持自动重载（`AutoReloadIfNeeded` / `UpdateEAStatus`）。

## 4. 马丁过滤条件（CheckMartinConditions）
马丁加仓需要同时满足：
1. `InpMartinEnabled = true`
2. **新闻过滤**（若启用）：
   - 时间窗口：`now - InpNewsAfterMinutes` 至 `now + InpNewsBeforeMinutes`
   - 重要性：High / Medium（由参数控制）
   - 事件货币与品种基准/报价货币匹配
3. **ATR 波动限制**：`ATR% <= maxAtrPct`
4. **布林偏离限制**：`|price - middle| / std <= maxBollDeviation`

若不满足，马丁暂停并记录原因。

## 5. 重要输入参数（摘录）
- `firstLots`：起始手数
- `step`：梯子触发百分比
- `martinInterval`：马丁触发距离（%）
- `filter`：回撤过滤阈值（%）
- `orderTime`：首次开仓延迟（秒）
- `retrySeconds`：失败重试间隔（秒）
- `maxLoss`：最大浮亏强平
- `maxMartinLevel`：最大马丁层级
- `martinBreakevenProfit`：马丁零损保护缓冲金额（<=0 关闭）
- `maxAtrPct` / `maxBollDeviation`：马丁波动过滤
- `InpNews*`：新闻过滤配置
- `MAGIC_NUMBER` / `InpIgnoreMagicNumber`

## 6. 异常恢复与自检
- **缺腿恢复**：若发现 Buy 或 Sell 票号为 -1，会尝试重开。
- **自动重载**：若实际持仓数与预期不一致，会 `UpdateEAStatus()` 重建内部状态。
- **单边持仓**：会进入恢复模式并继续运行，不强制停机。

## 7. 手动控制与 UI
- 按钮：Pause / Martin Switch / Ignore Magic / Reload EA State
- 按钮功能说明：
  - **Pause Strategy**：暂停/恢复策略主循环（仅停止策略逻辑，不自动平仓）。
  - **Martin Switch**：开启/关闭马丁加仓逻辑（关闭后马丁不再触发）。
  - **Ignore Magic**：是否忽略魔术号过滤（开启后手动单也会被视为策略单）。
  - **Reload EA State**：手动重建内部状态与持仓跟踪（用于修复缺腿/手动干预后的状态不一致）。

---
> 复盘校对建议：
> - 是否“先对冲后梯子”，并在回撤时触发马丁；
> - 马丁是否因新闻/ATR/Boll 被暂停；
> - maxLoss 是否触发全平；
> - 是否存在“单边缺腿恢复”行为。
