# OrderGuard — 订单护航系统设计 v2

## 一句话

在 EA 下单前 / 后，由规则引擎 + AI 判断是否放行，跟踪订单全生命周期，历史数据反哺决策。覆盖 **拦截模式**（EA 改源码主动调）+ **监控模式**（事后审计，零侵入），两种都支持。

## v2 关键变更（v1 → v2）

| | v1 | v2 |
|---|---|---|
| EA 接入 | 必须改源码 + 编译 | 拦截模式改源码 + **监控模式零侵入**（适用 .ex5-only） |
| AI 评估 | 同步 1-3s 阻塞下单 | **异步建议 + 缓存** — fast rules 立即放行，AI 后台跑，结果缓存命中率 90%+ |
| 回测兼容 | 没提 | EA 端本地 fast rules 副本，WebRequest 失败时本地复现 |
| 服务降级 | 「可配置」 | 默认 EA 本地静态 fast rules 兜底；AI 跳过 |
| UI 入口 | 无 | **「护航」专栏** + 我的策略每个 EA 加「🛡 护航」按钮 |
| 自动调整 | ±10% 自动 | 加硬上限 + 最小样本 + 回滚机制 |

---

## 总览架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EasyDeal Client                              │
│                                                                     │
│   ┌─ 我的策略 ─────────┐    ┌─ 护航专栏（新） ──────────────────┐     │
│   │ EA 行加「🛡 护航」 │    │ 在跑订单列表 + 展开 guard 状态     │     │
│   │ 按钮（监控/拦截）  │    │ + 整体战绩面板                     │     │
│   └────────┬───────────┘    └────────────┬───────────────────────┘     │
│            │                             │                          │
│   ┌────────▼─────────────────────────────▼─────────────────────┐    │
│   │  OrderGuard 引擎                                           │    │
│   │  ├── HTTP server (127.0.0.1:9527)                          │    │
│   │  │     用 mt5 SDK 的 `request_hook` / 我们的 mqh 接进来    │    │
│   │  ├── Fast Rules（确定性 <10ms）                            │    │
│   │  ├── AI Rules（异步 + 缓存，1-3s 但不阻塞 EA）             │    │
│   │  ├── Order Tracker（订单全生命周期记 SQLite）              │    │
│   │  └── Post-hoc Monitor（监控模式：监听 deal stream 事后审计）│    │
│   └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
        ↑                                       ↑
   ┌────┴─────┐                          ┌──────┴──────┐
   │ EA (MQL5)│ 拦截模式：WebRequest      │  MT5 SDK    │ 监控模式：
   │ 改源码   │ 调 :9527 同步阻塞 / 异步  │  Python     │ deal stream poll
   │ 加 mqh   │ guard.check_async()      │             │
   └──────────┘                          └─────────────┘
```

---

## 两种运行模式

### 监控模式（默认推荐 — 零侵入）

**适用**：所有 EA，包括 .ex5-only 买来的策略。

**工作方式**：
- EasyDeal 后台用 MT5 Python SDK 每秒 poll `positions_get()` + `history_deals_get()`，识别新开仓 / 新平仓事件
- 每条新 deal 进 OrderGuard 引擎做**事后**评估
- 如果该单**理应被拦截**但已经开了，发警告 + 可选触发对冲单 / 自动平仓（取决于配置）
- 全部 deals 进 Order Tracker 做生命周期跟踪

**优点**：
- 不需要改 EA 源码
- 立刻可用，没有延迟问题
- 适合 .ex5-only / 买来的策略

**缺点**：
- 「事后」≠「拦截」—— 高风险单已经下了才被察觉
- 对策略行为的影响只能通过「反向对冲 / 强平」实现，不如 pre-trade 拦截干净

### 拦截模式（高风险策略推荐）

**适用**：用户自己写 / 有源码的 EA。

**工作方式**：
- EA 在 OrderSend() 前 `#include <OrderGuard/OrderGuard.mqh>` 调 `OrderGuard_CheckAsync()`
- HTTP POST 到 localhost:9527
- **第一次同步阻塞 1-3s**（fast rules + AI），后续相同 (intent, context bucket) 命中**缓存 < 50ms**
- 返回 approved / blocked / adjusted_volume，EA 按结果决定

**优点**：
- 真正的 pre-trade 拦截
- AI 决策结果可调整 lot size，不是只能 0/1

**缺点**：
- 需要改 EA 源码 + 重编
- 第一次某 (intent, context) 组合命中时有 1-3s 延迟

### 用户怎么选？

「我的策略」每个 EA 行点「🛡 护航」按钮 → 弹对话框：

```
┌────────────────────────────────────────────────────┐
│  护航模式选择 — GMarket.mq5                        │
│                                                    │
│  ○ 监控模式（推荐）                                │
│    EA 不用改任何代码，立刻可用                     │
│    OrderGuard 监听 MT5 deals，事后审计 + 告警      │
│    [适用：买来的 .ex5 / 不想改源码 / 先观察]       │
│                                                    │
│  ○ 拦截模式（高风险策略推荐）                      │
│    AI 帮你改 EA 源码：插入 OrderGuard_Check()      │
│    + 配 fast rules + 重编一次 → 真 pre-trade 拦截 │
│    [适用：马丁 / 网格 / 重仓策略 / 有 .mq5 源码]   │
│                                                    │
│   ☐ 暂时只在 demo 账号上启用（推荐第一次）         │
│                                                    │
│   [取消]  [启用护航]                               │
└────────────────────────────────────────────────────┘
```

---

## 「护航」专栏 UI 设计

顶栏加一个 tab「🛡 护航」，跟「我的策略」「排行榜」并列。

### 整体布局

```
┌─────────────────────────────────────────────────────────────────────┐
│  🛡 护航                                                            │
│  实时拦截 + 事后审计你所有 EA 的订单，AI 协助风控                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ 整体战绩 ─────────────────────────────────────────────────┐    │
│  │  累计审批 1,247 单  │  拦截 86 单  │  调整手数 213 单       │    │
│  │  拦截单模拟回测：避免 -$2,840 亏损（不护航的话）            │    │
│  │  放行单实际成绩：$+1,520（胜率 58%）                       │    │
│  │  AI 判断准确度：83%（按事后 PnL 反向校验）                  │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─ 已护航的 EA ─────────────────────────────────────────────┐    │
│  │ GMarket    监控模式  审批 142  拦截 8   ✓启用              │    │
│  │ VP策略     拦截模式  审批 89   拦截 12  ✓启用              │    │
│  │ 屠龙战神   监控模式  审批 ---  ---     ⏸暂停              │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─ 在跑的订单 (3 单) ──────────────────────────────────────┐     │
│  │ ┌─ ▼ #12347 GMarket  Sell  0.04  XAUUSDm  4505.00 ──────┐│     │
│  │ │  开仓:  2026-05-16 10:30  浮盈: -$5.50                ││     │
│  │ │  ┌─ Guard 决策 ───────────────────────────────┐       ││     │
│  │ │  │ intent:    martin_level_2                  │       ││     │
│  │ │  │ risk:      high                            │       ││     │
│  │ │  │ fast rules: ✓ pass (ATR 0.8% 在阈值内)     │       ││     │
│  │ │  │ AI:        ✓ approved (confidence 0.72)    │       ││     │
│  │ │  │            "历史同类胜率 42%，放行但手数减半"│       ││     │
│  │ │  │ 原始 0.06 → 调整为 0.04                    │       ││     │
│  │ │  └────────────────────────────────────────────┘       ││     │
│  │ │  [改单] [手动平仓]                                     ││     │
│  │ └────────────────────────────────────────────────────────┘│     │
│  │ ┌─ ▶ #12345 GMarket  Buy   0.03  XAUUSDm  4520.00 ──────┐│     │
│  │ ┌─ ▶ #12346 GMarket  Sell  0.03  XAUUSDm  4510.00 ──────┐│     │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─ 最近 24h 决策日志 ─────────────────────────────────────────┐   │
│  │ 10:30 GMarket martin_2 → approved (减半至 0.04)             │   │
│  │ 09:15 VP策略 entry → blocked (CPI 数据 30 分钟内)            │   │
│  │ 08:48 GMarket martin_3 → blocked (马丁层数超 3 层)           │   │
│  │ ... [更多]                                                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 三个面板逻辑

1. **整体战绩**（顶部）— 沉淀的价值证明，给用户「这个功能值不值得开」直观答案
   - 拦截单模拟回测 = 假设这些单都下了会赚 / 亏多少（用 MT5 history 后续 N 分钟价格反推）
   - AI 准确度 = AI 说 approved 的单事后真正赚钱 + AI 说 blocked 的单事后真亏钱 / 总判断数
2. **已护航的 EA 列表** — 一行一个 EA，看到模式 + 单子数 + 当前启用状态
   - 暂停按钮：临时停了不删配置
   - 配置按钮：进 EA 的 fast rules 调阈值（高级用户）
3. **在跑的订单**（实时）— 当前所有未平仓位
   - 每行可展开，看 Guard 决策详情
   - 没护航的 EA 也显示（标「未护航」灰色），鼓励用户启用
   - 操作按钮：改单 / 手动平仓（直接调 MT5）
4. **决策日志**（事件流）— 最近 24h 所有 OrderGuard_Check 调用，方便审计

---

## 「我的策略」加「护航」按钮

EA 行 actions 区加「🛡 护航」/「✓ 已护航 (监控)」/「✓ 已护航 (拦截)」三态按钮。

```
GMarket.mq5  运行中  ... [说明] [统计] [回测] [⚙ 参数] [📎 指标] [📊 优化]
                         [🛡 护航]  [参与排行榜] [上架] [删除]
```

点击：
- **未护航** → 弹出模式选择对话框（监控 / 拦截，见上面）
- **已护航（监控）** → 弹详情：查看战绩 / 切换到拦截模式 / 暂停
- **已护航（拦截）** → 弹详情：查看战绩 / fast rules 配置 / 切回监控

启用流程（监控模式）：
1. 用户点「🛡 护航」选「监控模式」
2. EasyDeal 后台启动该 EA 的 deal stream 监听
3. AI 读 .mq5 源码（如有）自动识别策略类型 + 生成 fast rules
4. 用户确认 fast rules → 启用
5. 该 EA 出现在「护航」专栏

启用流程（拦截模式）：
1. 同上 1-4
2. AI 输出 OrderGuard_Check() 应该插入的位置 + 参数示例
3. 用户审 → 同意 → AI 直接改 .mq5 → 编译 → 部署
4. 用户去 MT5 给 EA 重新挂载（如需）
5. EA 启动后开始走 :9527 调用

---

## EA 改造的可逆性 / 语义保全（拦截模式必读）

**核心问题**：原 EA 内部状态机基于「OrderSend 必成功 + lots 等于代码值」的隐含假设。OrderGuard 改造后这两条都可能被打破，状态机断裂 → EA 行为漂移 → 回测和实盘对不上。

### 改造前必须做的 3 步静态分析

AI 读 `.mq5` 源码后，**不能直接插入 OrderGuard_Check** — 必须先扫一遍依赖：

#### Step A: 标出所有「假设 OrderSend 必成功」的代码点

```mql5
// 危险模式 1：调用方假设 OrderSend 必成功
trade.Sell(0.06, ...);                 // ← 改造点
g_martin_level++;                      // ← 这里隐含「上面一定下单成功了」
g_last_lots = 0.06;                    // ← 同上

// 危险模式 2：从 PositionsTotal() 反推状态
trade.Sell(0.06, ...);
if (PositionsTotal() != expected + 1) Alert("error");  // ← guard 拦了会误报

// 危险模式 3：下完立刻 OrderModify / 设 SL/TP
trade.Sell(0.06, ...);
trade.PositionModify(trade.ResultDeal(), sl, tp);      // ← block 的话 ResultDeal=0，调用空跑
```

AI 输出一份 **「危险依赖清单」** 给用户审：

```
GMarket.mq5 改造前 review：

  L142: trade.Sell(InpLots, ...) 后立刻
        L143: g_martin_level++ ← 依赖下单成功
        L144: g_last_open_price = Ask ← 同上
        L147: SendNotification("opened ", _Symbol)

  L201: trade.Buy(volume, ...) 后立刻
        L203: g_grid_step_count++

  ⚠ 共 2 处下单调用，4 处后继状态变更。改造时必须为每处补上
  「if (guard 被 block 或 lots 调整) 状态如何处理」逻辑。
```

#### Step B: 标出所有「依赖 lots 等于代码值」的代码点

```mql5
// 危险模式 1：马丁加倍依赖上一笔 lots
double next_lots = g_last_lots * 2.0;     // ← guard 调整 lots 后 g_last_lots 还是原值，下一笔失真

// 危险模式 2：合约价值计算依赖 lots
double risk = lots * contract_size * stop_pips * tick_value;   // ← lots 变了 risk 也变
```

如果 guard 的 adjusted_volume 跟 requested_volume 不等 — EA 应该用哪个？默认应该是 **adjusted_volume**（实际下的），并把这个值喂回 EA 的内部计数器。

#### Step C: 检测时序敏感策略

如果 EA 的下单逻辑里有：

- `OnTick()` 里直接判断 + 下单（每 tick 都可能下，秒级敏感）
- 信号源是 OnTimer 5s 内的（短周期）

→ 警告用户「该 EA 时序敏感，启用拦截模式可能有微秒级延迟影响」，建议先用监控模式跑 1 周看影响再决定。

### 改造模板：让 EA「知道」guard 的结果

不是简单插入 `if(!guard.approved) return;` — 那只阻止了下单，没修复后继状态。

改成 4 段式：

```mql5
// === 改造前 ===
trade.Sell(InpLots, _Symbol, 0, 0, 0, "martin");
g_martin_level++;
g_last_open_lots = InpLots;
g_last_open_price = SymbolInfoDouble(_Symbol, SYMBOL_BID);

// === 改造后（4 段）===

// 1. 预检
OrderGuardResult guard = OrderGuard_Check(
    "GMarket", "high", "martin_level_" + IntegerToString(g_martin_level + 1),
    _Symbol, ORDER_TYPE_SELL, InpLots, OG_TIMEOUT_MS_DEFAULT
);

// 2. 处理 block / service down
if (guard.status == OG_STATUS_BLOCKED) {
    Print("[OrderGuard] 拦截: ", guard.reason);
    OnOrderGuardBlocked("martin", InpLots);   // ← 用户填写：决定 EA 内部状态怎么 handle
    return;
}
if (guard.status == OG_STATUS_SERVICE_DOWN && guard.local_decision == OG_LOCAL_BLOCK) {
    Print("[OrderGuard] 本地 fast rules 拦截（服务挂了）: ", guard.reason);
    OnOrderGuardBlocked("martin", InpLots);
    return;
}

// 3. 用 adjusted_volume 替代原 InpLots
double actualLots = (guard.adjusted_volume > 0) ? guard.adjusted_volume : InpLots;
bool sent = trade.Sell(actualLots, _Symbol, 0, 0, 0, "martin");

// 4. 用 actualLots 而不是 InpLots 更新内部状态
if (sent) {
    g_martin_level++;
    g_last_open_lots = actualLots;            // ← 关键：用实际值，不是请求值
    g_last_open_price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
} else {
    Print("[OrderGuard] guard 放行但 OrderSend 失败: ", trade.ResultRetcodeDescription());
}
```

**`OnOrderGuardBlocked(intent, requestedLots)`** 是 AI 给 EA 作者起的 hook 函数，初始版本只 Print，但用户应该填写：

- 马丁策略：`g_martin_level` 不要 ++（保持，下次 tick 再尝试）
- 网格策略：`g_grid_step_count` 跳过该 step（避免无限重试）
- 趋势策略：把信号标记为 cooldown 10 分钟，避免疯狂重试

### 改造后必须做的 4 个安全网

#### 1. 原文件备份

改造后 `.mq5` 自动备份到 `workspace/strategies/.guard-backup/<EA>-<timestamp>.mq5.bak`。

UI 在「护航」专栏 EA 配置页加「↩ 回滚到原版」按钮，一键复原。

#### 2. 改造点 diff 给用户看

```diff
GMarket.mq5 改造预览：

@@ Line 142-145 (原下单点 1)
   trade.Sell(InpLots, _Symbol, 0, 0, 0, "martin");
-  g_martin_level++;
-  g_last_open_lots = InpLots;
+  OrderGuardResult guard = OrderGuard_Check(...);
+  if (guard.status == OG_STATUS_BLOCKED) { OnOrderGuardBlocked(...); return; }
+  double actualLots = (guard.adjusted_volume > 0) ? guard.adjusted_volume : InpLots;
+  bool sent = trade.Sell(actualLots, ...);
+  if (sent) {
+      g_martin_level++;
+      g_last_open_lots = actualLots;  // ← 用 actualLots
+      ...
+  }
```

用户审完 → 同意 → AI 写文件 → 编译 → 部署。**默认不同意** — 用户必须 explicit confirm。

#### 3. 改造后自动跑一次回测 + 对比原 EA

回测**禁用 OrderGuard**（mqh 检测到 tester 环境直接走本地 fast rules / 全放行）：

| 指标 | 原 EA 回测 | 改造后 EA 回测（不启用护航）| 差异 |
|---|---|---|---|
| 总净利 | $5,200 | $5,195 | -0.1% ✓ |
| 总笔数 | 312 | 312 | 0 ✓ |
| 最大回撤 | -8.5% | -8.5% | 0 ✓ |

差异 < 1% 且方向一致 → **改造没破坏原策略行为**，可启用。
差异 > 1% → 提示用户「改造可能影响策略行为，请人工 review」 + 默认不启用护航，让用户自己决定。

这是「不可逆破坏」最关键的兜底 — 用回测数据证明改造没造成行为漂移。

#### 4. 灰度启用 — 默认只在 demo 账号生效

模式选择对话框那个「☐ 暂时只在 demo 账号上启用（推荐第一次）」复选框默认勾上。

OrderGuard.mqh 启动时读 `mt5.account_info().trade_mode`：
- `ACCOUNT_TRADE_MODE_DEMO` → 正常 check
- `ACCOUNT_TRADE_MODE_REAL` + 用户没显式取消「demo only」 → 旁路（return approved），仅记录到 monitor 模式

用户用 demo 跑 1 周觉得稳定 → UI 关掉「demo only」开关 → 实盘生效。

### 自动改造的局限 + 用户兜底

AI 改造能 cover **90% 的常见 EA 模式**。遇到这些情况 AI 应该**拒绝自动改**，让用户手动：

- EA 用了多 OrderSend 调用（不同 condition 下下单），变量交叉依赖严重
- EA 用 EventChartCustom / inter-EA 通信触发下单（异步链路）
- EA 用回调 / pending order 链（下了 stop-limit pending，触发后才下市价）
- 源码里有用户自己写的 try/retry 逻辑（容易跟 guard fallback 撞）

AI 检出这些模式 → 跳过自动改造 → 输出「OrderGuard.mqh 接入指南」给用户手动改。

---

## EA 侧 OrderGuard.mqh（拦截模式）

```mql5
#include <OrderGuard/OrderGuard.mqh>

// === 异步预热（开仓决策前几秒就调，可选）===
// 让 AI 后台开始思考，到真要下单时缓存里就有了
OrderGuard_PrecheckAsync(
    "GMarket", "high", "martin_level_2",
    _Symbol, ORDER_TYPE_SELL, 0.06
);

// ... EA 自己的信号判断 ...

// === 下单前最终决策 ===
OrderGuardResult guard = OrderGuard_Check(
    "GMarket",              // EA 名
    "high",                 // risk_level: low / medium / high / critical
    "martin_level_2",       // intent: EA 自由填写
    _Symbol,                // 品种
    ORDER_TYPE_SELL,        // 方向
    0.06,                   // 手数
    OG_TIMEOUT_MS_DEFAULT   // 超时 ms（默认 500 — 超过 fallback 走本地 fast rules）
);

if(guard.status == OG_STATUS_BLOCKED) {
    Print("OrderGuard 拦截: ", guard.reason);
    return;
}
if(guard.status == OG_STATUS_SERVICE_DOWN) {
    Print("OrderGuard 服务不可达，按本地 fast rules: ", guard.local_decision);
    if(guard.local_decision == OG_LOCAL_BLOCK) return;
}

double finalLots = guard.adjusted_volume > 0 ? guard.adjusted_volume : 0.06;
trade.Sell(finalLots, ...);
```

### OrderGuard.mqh 行为细节

- **缓存优先**：本地有当前 (intent, context bucket) 的最近 AI 决策（≤5 分钟内），直接返回，<50ms
- **缓存 miss + AI 已经被预热**：等 AI 回（≤200ms 命中 server-side cache）
- **缓存 miss + AI 没预热**：fast rules 立刻返回，AI 后台跑，结果存下次用
- **HTTP 超时（默认 500ms）**：本地静态 fast rules（启动时从 server pull 一次缓存到 `MQL5/Files/OrderGuard/<ea>.rules.json`）决定
- **服务挂了（连接失败）**：同上 fallback 到本地静态规则
- **没装 OrderGuard 或服务不在**：调用直接返回 `OG_STATUS_DISABLED`，EA 按原逻辑走

### EA 改造工作量

| 改造项 | 工作量 |
|---|---|
| #include OrderGuard.mqh | 1 行 |
| 主下单函数前插入 Check() | 3-5 行 |
| risk_level / intent 字符串决策 | EA 作者写，每只 EA 5-10 行逻辑 |
| MT5 选项加 WebRequest 白名单 `http://127.0.0.1:9527` | 用户手动一次，10 秒 |

总计：每只 EA 接入约 **15 分钟**（AI 协助下生成代码后用户审 + 编译）。

---

## 双层规则引擎

### Fast Rules（确定性 <10ms）

JSON 配置，每只 EA 一份：

```json
{
  "ea_name": "GMarket",
  "version": 3,
  "updated_at": "2026-05-16T10:00:00Z",
  "rules": {
    "max_volume":               0.1,
    "max_positions":            10,
    "max_drawdown_pct":         30,
    "blocked_hours":            [0, 1, 2, 3],
    "risk_level_policy": {
      "low":      { "action": "pass",  "ai_check": false },
      "medium":   { "action": "pass",  "ai_check": "async" },
      "high":     { "action": "check", "ai_check": true   },
      "critical": { "action": "block", "ai_check": false  }
    },
    "intent_specific": {
      "martin": { "max_level": 3, "ladder_atr_min": 0.5 },
      "scalp":  { "max_spread_points": 30 }
    },
    "min_atr_pct":              0.3,
    "max_atr_pct":              1.5,
    "max_boll_deviation":       2.0,
    "news_block_minutes_before": 60,
    "news_block_minutes_after":  60
  }
}
```

### AI Rules（异步 + 缓存）

**关键设计：AI 永远不阻塞 EA 主线程**。

工作流：

```
EA 调 /orderguard/check ──► fast rules 通过 ──► 查 AI cache（key = intent + context_bucket）
                                                  │
                                  ┌───命中────────┘
                                  │
                                  ▼
                          立即返回 (< 50ms)
                          状态：approved/blocked/adjusted
                          + ai_cached: true
                          + cache_age_sec: 120
                          + decision_id

                                  ┌───未命中──────────┐
                                  │                   │
                                  ▼                   ▼
                          立即返回 fast rules    后台 spawn AI job
                          决策（pass + 备注      （3s 内完成）
                          "AI 评估中"）           │
                                                 ▼
                                        结果存 cache，5 分钟 TTL
                                        + 投到 SSE / WebSocket
                                        通知客户端 UI
                                        如果 AI 说"应拦截"但
                                        EA 已下单 → 推警告 +
                                        可选自动反向对冲
```

**context_bucket**：把 atr / drawdown / spread 等连续值离散化（如 atr<0.3, 0.3-0.6, 0.6-1.0, 1.0-1.5, >1.5），同 bucket 的不同时间点视为同 case，缓存命中率高。

**缓存命中估算**：一个稳定运行的 EA，常见 context 不超过 100 种组合，运行 1 周后命中率 > 95%。

### AI 提交给 LLM 的 prompt

让 AI 拿到：
- 订单请求（ea / intent / risk / symbol / side / volume）
- 账号实时（balance / equity / drawdown）
- 当前持仓清单
- 市场指标（atr / boll / spread / 趋势）
- 新闻日历（最近 + 即将的高影响事件）
- **历史决策成绩**：这个 intent + 这个 bucket 历史 N 次的胜率 / 平均盈亏

AI 输出：

```json
{
  "approved":         false,
  "reason":           "马丁同类意图历史胜率仅 35%，当前 ATR 0.8% 处于中高位，且 60 分钟内有 US CPI",
  "adjusted_volume":  0,
  "confidence":       0.82,
  "context_bucket":   "atr_0.6-1.0:bullish:cpi_60m",
  "next_review_at":   "2026-05-16T11:30:00Z"
}
```

`next_review_at` 让缓存定期失效，避免脏数据。

---

## 监控模式（事后审计）

**核心**：不靠 EA 改造，靠 EasyDeal 主动 poll MT5 拿成交数据。

```python
# 伪代码：每 2 秒跑一次
while True:
    cur_positions = mt5.positions_get()
    new_positions = diff_against(cur_positions, last_positions)

    for pos in new_positions:  # 刚开的仓
        deal = mt5.history_deals_get(ticket=pos.ticket)[0]
        intent, risk_level = infer_intent_from_deal(deal, ea_config)
        decision = run_orderguard_rules(deal, intent, risk_level)
        record_decision(decision, post_hoc=True)

        if decision.status == "would_block":
            notify_user(
                f"⚠ EA {deal.ea_name} 刚开了一笔本应被拦截的单 #{pos.ticket}",
                actions=[("立即反向对冲", hedge), ("强平", close)],
            )
            if ea_config.auto_hedge_on_violation:
                open_hedge_position(pos)

    last_positions = cur_positions
    sleep(2)
```

**intent 推断**（监控模式没有 EA 主动声明）：

| 启发式 | 推断 intent |
|---|---|
| 跟现有 positions 同方向 + 加仓 | `add_position` / `martin` |
| 跟现有 positions 反方向 + 平 | `recovery` / `hedge_close` |
| 首笔，无任何 positions | `initial` |
| 多笔同时开 + 不同 type | `grid` |
| 持仓 < 5 分钟内开 + 强卖反向 | `scalp` |

不完美但能 cover 80% 场景。剩 20% 默认 `unknown`，AI 评估时上下文里就标"intent 未知，按 risk_level=medium 处理"。

---

## 订单生命周期跟踪（不变）

`OrderRecord` 结构同 v1。增加字段：

- `mode`: `intercept` / `monitor`
- `local_fallback`: bool — 服务不可达时本地兜底
- `ai_cached`: bool — AI 决策是否从缓存命中
- `cache_age_sec`: 缓存年龄
- `post_hoc`: bool — 监控模式的事后记录

---

## 回测兼容（v1 没覆盖的）

**问题**：MT5 Strategy Tester 跑 EA 时 WebRequest 默认被禁，调 `OrderGuard_Check()` 失败。如果 EA 兜底 `approved=true`，回测和实盘行为不一致，回测的盈亏数据失真。

**解法**：
1. EasyDeal 启用护航时，**把 fast rules 的 JSON 副本写到 `MT5/MQL5/Files/OrderGuard/<EA>.rules.json`**
2. OrderGuard.mqh 检测到 WebRequest 失败时，**自动 fallback 读本地 JSON**，按 fast rules 本地复现一遍判断
3. AI 部分回测时跳过（无法在 tester 里跑 1-3s AI 调用），按 fast rules 决策即可
4. EA 端代码：

```mql5
OrderGuardResult guard = OrderGuard_Check(...);
if(guard.status == OG_STATUS_SERVICE_DOWN) {
    // 本地 fast rules 复现 — 回测 / 服务挂时走这条
    guard = OrderGuard_LocalFastCheck(...);
}
```

5. 回测报告里多一栏「Guard 拦截单数」，给用户直观看到护航对回测结果的影响

---

## 服务降级 / 失败处理

| 场景 | 默认行为 | 可配置 |
|---|---|---|
| EasyDeal 服务挂了（HTTP 5xx）| EA 本地 fast rules 兜底 → 走 risk_level_policy.fallback_action（默认 pass） | 改成 block |
| EasyDeal 没启动（连接拒绝）| 同上 | 同上 |
| HTTP 超时（500ms）| 同上 | 超时 ms 可调 100-5000 |
| AI 报错 | fast rules 决策直接生效，AI 标记 unavailable | — |
| Fast rules 本身报错 | EA 按原逻辑下单 + 高优先级 Alert 到 EasyDeal UI | — |
| MT5 WebRequest 被禁（回测 / 用户没加白名单）| 本地 JSON fast rules 兜底 | — |

**铁律**：默认永远倾向「放行 + 告警」而不是「拦截 + 沉默」。OrderGuard 哪天挂了用户的 EA 全不动 = 大灾难。

---

## 自动规则生成（refined）

跟 v1 流程一样，但加 **EA 类型识别准确度回访**：

- AI 第一次读 EA 源码生成的 ea_type / order_intents，记在 `rules.json` 里
- 1 周后或 100 单后，**反查实际数据**：
  - 用户标 `intent=martin` 的实际单子，胜率 / 持仓时长 / 平均亏损 跟 AI 预测的「马丁特征」匹配吗？
  - 不匹配 → 提示用户「这只 EA 的 martin 单实际表现不像马丁，要重新分类吗？」+ AI 给新建议

---

## 反馈自学习（加保险）

v1 的「±10% 自动调整」补充：

1. **最小样本**：≥ 30 单的统计才考虑调整
2. **冷却期**：每次自动调整后 1 周内不再自动调整同一个阈值
3. **硬上限**：单次调整 ≤ ±10%，**全期累计偏离初始值 ≤ ±50%** — 防止漂移失控
4. **快照 + 回滚**：每次自动调整存 `rules_history` 表，UI 可一键回滚到任意历史快照
5. **A/B 验证**：高风险调整（如 max_martin_level 从 3 → 4）走灰度 — 比如 50% 概率新规则、50% 旧规则，对比一周再决定

---

## HTTP 接口（refined）

### POST /orderguard/check  — 同步决策（拦截模式 EA 调）

请求：

```json
{
  "ea_name":    "GMarket",
  "risk_level": "high",
  "intent":     "martin_level_2",
  "symbol":     "XAUUSDm",
  "side":       "sell",
  "volume":     0.06,
  "timeout_ms": 500
}
```

响应：

```json
{
  "status":          "approved",          // approved / blocked / adjusted
  "reason":          "ATR 0.8% 适中，AI 缓存命中（120s 内），放行手数减半",
  "adjusted_volume": 0.03,
  "decision_id":     "dg_20260516_001",
  "latency_ms":      18,
  "ai_cached":       true,
  "cache_age_sec":   120,
  "next_review_at":  "2026-05-16T11:30:00Z"
}
```

### POST /orderguard/precheck-async  — 预热（拦截模式 EA 可选调）

让 AI 后台开始评估，不等结果。EA 真要下单时再 POST /check 大概率命中缓存。

### GET /orderguard/local-rules?ea=<name>  — 拉本地兜底规则

EA 启动时拉一次缓存到 `MT5/Files/OrderGuard/<ea>.rules.json`，HTTP 不通时用。

### GET /orderguard/status

```json
{
  "enabled":        true,
  "ea_profiles":    {"GMarket": "intercept", "VP策略": "monitor"},
  "total_decisions": 1247,
  "blocked":         86,
  "adjusted":        213,
  "ai_accuracy":     0.83,
  "block_savings_usd": 2840.50
}
```

### GET /orderguard/positions  — 在跑的订单 + 各自的 guard 决策

护航专栏「在跑的订单」用。

### GET /orderguard/stats?ea=<name>&intent=<intent>

特定 EA + intent 的成绩单。

---

## 数据存储

SQLite 路径：`<EasyDeal data>/orderguard.db`

```sql
-- 审批决策表
CREATE TABLE decisions (
  decision_id      TEXT PRIMARY KEY,
  ea_name          TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  mode             TEXT,                  -- intercept / monitor
  risk_level       TEXT,
  intent           TEXT,
  symbol           TEXT,
  side             TEXT,
  requested_volume REAL,
  approved_volume  REAL,
  approved         INTEGER,
  reason           TEXT,
  ai_cached        INTEGER,
  ai_confidence    REAL,
  context_json     TEXT,                  -- 决策时的 context 快照
  post_hoc         INTEGER,
  local_fallback   INTEGER
);

CREATE INDEX idx_decisions_ea_intent ON decisions(ea_name, intent, ts DESC);

-- 订单生命周期表
CREATE TABLE orders (
  ticket           INTEGER PRIMARY KEY,
  decision_id      TEXT REFERENCES decisions(decision_id),
  ea_name          TEXT,
  open_price       REAL,
  open_time        INTEGER,
  close_price      REAL,
  close_time       INTEGER,
  volume           REAL,
  pnl              REAL,
  holding_sec      INTEGER,
  close_reason     TEXT
);

-- EA 规则配置表（含历史快照）
CREATE TABLE ea_rules (
  ea_name          TEXT NOT NULL,
  version          INTEGER NOT NULL,
  rules_json       TEXT,
  created_at       INTEGER,
  created_by       TEXT,                  -- 'ai' / 'user' / 'auto_adjust'
  reason           TEXT,                  -- 为何这次改动
  PRIMARY KEY (ea_name, version)
);

-- AI 决策缓存
CREATE TABLE ai_cache (
  cache_key        TEXT PRIMARY KEY,      -- ea_name + intent + context_bucket
  decision_json    TEXT,
  ts               INTEGER,
  expires_at       INTEGER
);

CREATE INDEX idx_ai_cache_expires ON ai_cache(expires_at);
```

**保留策略**：
- decisions / orders 保留 90 天明细，更早聚合到 monthly_stats
- ai_cache 自动 TTL 5 分钟
- ea_rules 永久保留（小数据量）

---

## 安全 / 认证（v1 没覆盖）

HTTP server 绑 `127.0.0.1:9527`，**不绑 0.0.0.0**，外网碰不到。

但同机器其他进程可以伪造请求 — 个人电脑这无所谓，**VPS / 共享机器**就是问题。

**解决**：启用时生成一次 token，写到 `MT5/MQL5/Files/OrderGuard/auth.token`（MT5 EA 能读这文件夹）。OrderGuard.mqh 启动时读 token，每次 HTTP 请求带 `X-OG-Token: <token>` header。

server 端校验，错的拒绝。

token 重置：用户在「护航」专栏点「重置 token」，文件被重写 → EA 重启后用新 token。

---

## 端口冲突

EasyDeal 现有 Python 服务跑在 8888（Flask）。9527 没冲突。但若用户运行其他软件占用 9527 — 启动时换端口：

```python
for port in [9527, 9528, 9529, 9530, 9999]:
    if try_bind(port): break
```

绑成功的端口写到 `<EasyDeal data>/orderguard.port` 给 OrderGuard.mqh 读。

---

## 多账号 / 多 EA 并发

HTTP server 用 `aiohttp` 异步，并发 100+ 请求无压力。

但 AI 评估 1-3s，并发跑 10 个就消耗 10 个 token 池 spot。**限流**：
- 每 EA 最多 1 个 AI job in-flight（同一 EA 的请求排队）
- 全局并发 AI ≤ 5（防止 token 池打爆）
- 排队超 10s 直接 fallback 到 fast rules

---

## 跟商城 / 排行榜联动（未来扩展）

护航产生的 **fast rules + intent classification** 可以共享：

- 卖家上架 EA 时**附带 OrderGuard 规则文件**
- 买家装 EA 后，护航自动启用，规则按卖家配置生效
- 排行榜可以加「带护航开关的成绩」维度 — 用户能比较「同 EA 带护航 vs 不带的胜率」

这条放 P4 看。

---

## 实现架构（**不是 thread-per-order**）

常见误解：「每个 EA 一个线程跟踪订单」/ 「每个订单一个 thread 监控」 — 高频策略一天几百单 × N 只 EA = 几千线程 = 客户端进程爆炸。

实际架构：**单进程 asyncio event loop + 后台 task + 共享 worker pool**。一个 thread 调度所有事，I/O 时 yield 等。

```
EasyDeal 主进程 (Electron renderer 或 main)
└─ Python OrderGuard 子进程 (一个进程，asyncio 事件循环)
    │
    ├── 【HTTP server】 aiohttp on 127.0.0.1:9527
    │   单 worker，async handler 处理所有 EA 请求
    │   ─ N 个 EA 同时 POST /check 也只是 N 个并发 coroutine，无 thread cost
    │
    ├── 【Order Tracker task】 1 个常驻 asyncio task
    │   每 2 秒 poll MT5 (mt5.positions_get + history_deals_get)
    │   diff 跟上次比较，识别新开 / 平 / 改 → 写 SQLite
    │   ─ 处理所有 EA 的所有订单（不是 per-EA / per-order）
    │
    ├── 【AI Worker Pool】 5 个 coroutine（asyncio.Queue）
    │   POST /check 命中需要 AI 时 → 投到 queue
    │   coroutine 取出 → 调 LLM → 回填 cache → 通知 client
    │   ─ 全局并发上限 5（防止 token 池打爆 + LLM 服务并发限制）
    │
    ├── 【AI Cache】 in-memory dict + asyncio.Lock
    │   key = (ea_name, intent, context_bucket)
    │   value = 决策结果 + expires_at
    │   ─ check 时先看 cache，命中 < 50ms 返回，无 lock 冲突
    │
    └── 【SQLite write task】 1 个常驻 task
        消费 write queue（decisions / orders 落盘）
        ─ 单 writer 避免 SQLite write lock 撞车
```

### 关键时序

```
EA "下单前 check" 请求路径：

1. EA OrderSend 前调 WebRequest POST /check        [EA 主线程 同步阻塞 1 次]
        │ HTTP
        ▼
2. aiohttp handler 接到请求                          [server 1 个 coroutine]
        │
        ▼
3. Fast rules 跑（纯 Python 比较）                   [< 5ms]
        │
        ▼
4. 查 AI cache                                       [< 1ms dict lookup]
        │
   ┌────┴─────┬──────────────────┐
   │ 命中     │ 未命中             │
   ▼          ▼                   │
5a. 返回缓存  5b. 投 AI queue +    │
    决策      立即返回 fast rules │
   <50ms      决策 + "ai_evaluating"│
              flag                 │
                                   │
                                  ▼
                        6. AI worker coroutine 后台:
                           - 拉账户 / 持仓 / 市场上下文
                           - 调 Claude / OpenAI LLM (1-3s)
                           - 回填 cache + 推 SSE 通知客户端
                           - 如果 AI 说"应该拦截"但 EA 已下单 →
                             告警 + 可选自动反向对冲
```

### 数据流（监控模式）

```
1. Order Tracker task wakes up (每 2s)
2. cur_positions = mt5.positions_get()
3. cur_deals = mt5.history_deals_get(last_check_time, now)
4. 跟上次的 set 比较，diff：
   - new_positions: 刚开的 (ticket 没见过)
   - closed_positions: 没了的 (ticket 上次有这次没)
   - modified_positions: SL/TP 改了的 (price 字段变了)
5. 对每个 new_position：
   a. 推断 intent (基于持仓 context heuristic)
   b. 跑 fast rules + 投 AI queue
   c. 写 decisions 表 (post_hoc=true)
   d. 如果 decision = "would_block" → 推告警
6. 对每个 closed_position：
   a. 找它对应的 decision_id
   b. 更新 orders 表 close_price / close_time / pnl
   c. 触发 self-learning 统计累积
```

### 性能预估

实测预算（基于现有 EasyDeal 子进程量级估计）：

| 场景 | 资源占用 |
|---|---|
| 空载（无 EA 在跑）| 进程 30 MB，CPU 0.1% |
| 1 个 EA 监控模式，5 单/小时 | 进程 50 MB，CPU < 1% |
| 5 个 EA 拦截模式，全部高频，1000 check/天 | 进程 80 MB，CPU 1-3% 平均，AI peak 时短期 10% |
| 极端：10 个 EA 全马丁，5000 check/天 + 全 cache miss | 进程 120 MB，CPU 5%（被 AI worker pool 5 并发限制） |

对比 thread-per-order：1000 单同时跟 = 1000 线程 = 几百 MB stack 占用 + 调度开销，3-5x 内存，CPU 翻倍。

### 为什么不用多线程

- **Python GIL** 让多线程 CPU bound 没用
- I/O bound 场景 asyncio 远超线程（无 context switch 开销）
- mt5 SDK 本身**不是线程安全** — 必须串行调用。多线程反而需要加锁，等于退化成串行
- 容易调试 — 所有状态在 1 个 event loop 里，没竞态

### 跟 EasyDeal 主进程的关系

OrderGuard 作为**独立 Python 子进程**跑（跟 wechat_mcp / scheduler_mcp 同级），由 Electron main 进程 spawn + supervise：

- 启动：EasyDeal 启动时 spawn OrderGuard.py
- 健康检查：每 30s GET /orderguard/status，没响应重启子进程
- 退出：EasyDeal 退出时 SIGTERM 子进程

跟 MT5 通过本地 HTTP 127.0.0.1:9527 通信。跟 EasyDeal 主进程通过 stdio MCP 协议（暴露 OrderGuard 内部工具给 AI 用，比如 `get_order_decisions(ea, since)` 让 Claude 在 AI 对话里查阅）。

---

## 落地节奏（refined）

| 阶段 | 内容 | 工期 |
|---|---|---|
| **P0a — 监控模式骨架** | EasyDeal 加 deal stream poll + decisions/orders 表 + 简单 fast rules + UI「护航」专栏（只看，不能配） | 2-3 天 |
| **P0b — 我的策略加按钮** | EA 行「🛡 护航」按钮 + 监控模式启用流程（不需改 EA） | 1 天 |
| **P1a — 拦截模式 MQH** | OrderGuard.mqh 单文件库 + GMarket 接入示范 + fast rules JSON | 2-3 天 |
| **P1b — AI 异步缓存** | AI 走异步 + cache，确保 EA 不阻塞 | 2-3 天 |
| **P1c — 回测兼容** | 本地 fast rules JSON fallback | 1 天 |
| **P2 — 通用规则生成** | AI 读任意 EA 源码 → 自动生成 fast rules + intent 分类 + 修改 EA 代码 | 3-5 天 |
| **P2.5 — 服务降级 + 安全** | token 认证、端口选择、超时 fallback 完整覆盖 | 1-2 天 |
| **P3 — 反馈自学习** | 历史数据 → 阈值自动微调 + 快照回滚 | 2-3 天 |
| **P4 — 商城 / 排行榜联动** | 上架带护航规则、排行榜带护航维度 | 1 周（视优先级）|

**最小可发布版本 = P0a + P0b** — 用户能看到「我所有 EA 的订单」+ 「拦截了多少单」 — 价值立刻可感知。

---

## 风险与注意事项（refined）

1. **延迟影响** — AI 走异步缓存后基本消除，但**第一次某 context bucket 命中**会卡 EA 1-3s。建议用户为高频 EA 在 EA 启动后用 `OrderGuard_Precheck` 预热常见 context
2. **WebRequest 白名单** — MT5 选项 → EA → 允许 WebRequest URL：`http://127.0.0.1:9527`。用户不加，OrderGuard.mqh 走本地 JSON fallback
3. **服务可用性** — EasyDeal 必须运行才有 AI；不在时 EA 用本地 fast rules，但失去 AI 智能判断
4. **数据安全** — 所有订单数据本地 SQLite，不上传云端
5. **AI 幻觉风险** — 决策返回 confidence，<0.6 默认放行（宁漏不误）。confidence 历史校验做反馈
6. **用户心理** — OrderGuard 是「少下单」，用户买 EA 是「多赚钱」，本能排斥。靠**整体战绩面板**（拦截单模拟回测的盈亏对比）说服用户长期开启
7. **回测断层** — 没启用 WebRequest 时本地 JSON fallback，确保回测和实盘行为一致
8. **EA 源码改造侵入** — 仅拦截模式需要，监控模式零侵入。先推监控、用户认可后再升级到拦截
9. **多账号冲突** — 同机多 MT5 实例时，OrderGuard 监听哪一个？设计：每个 EA 启用时记 MT5 install_dir，监控只 poll 那只
10. **TOKEN 池消耗** — AI 走 Claude / GPT 等 LLM，每次决策 ~500-2000 token。重度策略每天 50 单 × 500 token = 25k token/天。pro tier 用户 OK，free tier 需限流

---

## 总结

OrderGuard v2 的核心赌局：

1. **监控模式作为入口**让所有用户（含 .ex5-only）零侵入接入 — 大大扩展受众
2. **AI 异步 + 缓存**把 v1 的延迟问题压到不可见 — 让拦截模式真正可用
3. **「护航」专栏 UI** 把 OrderGuard 价值可视化（拦截了多少 / 避免了多少亏损） — 让用户主动想开启而不是被动加上
4. **回测 + 降级 + 安全 + 端口冲突**这些边角都在落地节奏里有明确安排

如果 P0a + P0b 一周内能上 — 用户看到自己每只 EA 的全订单 + 实时浮亏 + AI 后台已经在评估这些单 — **「这是我装 EasyDeal 的理由」**这种 emotional value 立刻成立。
