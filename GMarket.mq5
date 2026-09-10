
#property copyright "Copyright 2026, xszyou - Open Source Standalone Edition"
#property link      "https://github.com/xszyou/Easy-Deal"
#property version   "1.082" // Open-source standalone edition; strategy version unchanged
// Source mirrors: https://gitee.com/xszyou/easy-deal and https://github.com/xszyou/Easy-Deal
#property strict
//+------------------------------------------------------------------+
//| 升级日志 (Changelog)                                             |
//|------------------------------------------------------------------|
//|------------------------------------------------------------------|
//| v1.082 2026-09-02  新增每周开盘延迟启动参数                        |
//|   [新增] InpWeekStartDelayHours：每周真实开盘后延迟 N 小时才允许   |
//|          开启新一轮；等待期间已有持仓仍正常管理、风控和退出。       |
//|------------------------------------------------------------------|
//| v1.081 2026-09-02  周盈/周亏改为按本 EA 的 symbol+magic 独立核算   |
//|   [修复] 同账户多 EA 不再共享 ACCOUNT_EQUITY 周基准，避免一组达标   |
//|          后触发所有 magic 同步清仓。口径=基准后已平盈亏+当前浮盈亏。|
//|------------------------------------------------------------------|
//| v1.08wl 2026-08-29  周末软着陆与重复补腿修复                       |
//|   [修复] 按 SymbolInfoSessionTrade 计算本周真实收盘，不再假设周五24点|
//|   [修复] 软着陆窗口内：纯底仓立即全平；有马丁只允许自然退出，退出后全平|
//|   [修复] 窗口内禁止首单、爬梯、补腿及新马丁                        |
//|   [修复] 跨周休市时保留待重置状态，开市后可靠建立新周 baseline      |
//|   [修复] WeekResetOnBoot=false 仍初始化 baseline，避免从0误判周盈利 |
//|   [修复] recovery 增加成交认领轮询与缺腿二次确认，防重复同向 base   |
//|   [安全] 默认按 magic 过滤；稳定态奇数持仓转安全停机，不再带病运行   |
//|------------------------------------------------------------------|
//| v1.07wl 2026-08-25  严格对齐 broker 开盘/休市切周 + B1 启动重置     |
//|   [新增] InpWeekResetOnBoot (bool, true): 启动/重启按"新周"重置   |
//|          baseline, 支持 EA 在周二/周三/休市期间挂上也能正确重置    |
//|   [新增] InpWeekResetGuardSecs (int, 300): 重置后 N 秒内不开新仓, |
//|          防挂上瞬间 spread/commission 偏差污染 delta 基准          |
//|   [改造] WeeklyGate() 改为"等 symbol 可交易再设 baseline"两步法:  |
//|          a) OnTick 触发时若 curWeekIdx==-1 (未 baseline) 且        |
//|             SymbolInfoInteger(_Symbol,SYMBOL_TRADE_MODE)!=DISABLED|
//|             → 重置; 否则保持 armed 状态跳过本 tick, 等开盘          |
//|          b) 跨过周末切 wk 也走同样"等可交易"逻辑, 防止周末末 tick   |
//|             触发误设 baseline (session 末 spread 拉宽)              |
//|   [改造] InSoftCloseWindow() 改用 SymbolInfoSession 取"今天"最后   |
//|          session 结束秒偏移, 与 broker 周五真实收盘对齐; 不再依赖   |
//|          day_of_week==5 + hour>=24-softCloseHours 这种日历启发   |
//|   [防御] OpenBlockedNow() 新增 weekResetGuardUntil 闸门 (B1 guard) |
//|          重置后 N 秒内不开 BUY/SELL, 让 baseline 落在"市场真态"上   |
//|------------------------------------------------------------------|
//| v1.06wl 2026-08-11  幽灵票守卫(实盘 MT5-2 卡死事故修复)           |
//|   [修复] closeMartinOrders 平 base 时若记账票已不在实仓(外部平仓/  |
//|          换挂接管遗留陈年票), 旧代码 return false → 马丁组永远走不 |
//|          完 → seek 卡死 + 每 tick 刷 "Close sell base failed      |
//|          #4753"(实测一天 13 万行)。改为跳过平仓直接重开。          |
//|   [修复] ShouldAutoReload 顶部加「陈年票号强制重载」: 任一记账票号 |
//|          已不在实仓则无视零损周期/交易冷却抑制直接重扫(那两道门会  |
//|          让失真状态永久卡死)。仅保留 MIN_INTERVAL 节流。          |
//|   [说明] 同源版本也存在该问题，换挂接管遗留仓时最易触发。         |
//|------------------------------------------------------------------|
//| v1.05wl 2026-08-08  GMarket_wl 四件套(风洞冠军配置回测验证版)     |
//|   默认参数 = A组 step0.7/interval1.0 + MaxLoss1000 + 布林门9999   |
//|   [新增] 周盈落袋: 权益较周初 >=InpWeekProfitLock 全平收工到下周  |
//|   [新增] 周末软着陆: 周五收盘前 InpSoftCloseHours 小时不开新马丁, |
//|          窗口内马丁组自然了结即全平收工; 无马丁则底仓自然过周末   |
//|   [新增] 马丁手数封顶 InpMartinLotCap (0.08): 每刀变浅            |
//|   [新增] 割肉冷却 InpCutCooldownHours (24h): 割后不开新局, 斩连环 |
//|   依据: 29真实tick周 22/29胜 +1074; 合成30周 24/30; MC100世界     |
//|         同种子69/100优于三件套, 中位收益-10.4%到+0.6%             |
//|------------------------------------------------------------------|
//| v1.04  2026-07-14                                                |
//|   [防御] MartinSpacingGuard 防贴脸护栏：两处马丁开仓在 Sleep(500) |
//|          后、发单前重读锚点(lastMartinOrderTick 开仓价)，seek>0   |
//|          且实际落地价距锚点 < martinInterval×0.5 → 回滚刚开的     |
//|          base、跳过本层、打 "MartinSpacingGuard" 日志并走既有     |
//|          backoff。正常路径永不触发；触发即说明存在"判定与落地     |
//|          之间锚点被改"的未知路径。                                |
//|   [说明] 复盘定性：此前监控报的"贴脸 0.00x%"系判据错误(量的是     |
//|          马丁与同秒配对新 base，设计上必然同价)。真实首层间距     |
//|          均 ≥1.2% 合法；残留问题=首层马丁进场距离无上界(2.4~3.4%  |
//|          危险区进场)，属进场帽/区间门范畴，待 G5b 回测拍板。      |
//| v1.03  2026-07-07                                                |
//|   [修复] CalcSeek() 清马丁后漏重置 lastMartinOrderTick：seek==0   |
//|          时旧代码把 lastMartinOrderTick 指向反向 base 而非 -1，   |
//|          导致下次新 base 开出时马丁仍以远价老锚点为参照，间距     |
//|          1.2% 条件瞬间满足 → 同秒开出新马丁与新 base，间距近乎    |
//|          零。现 seek==0 时统一置 lastMartinOrderTick = -1。       |
//| v1.02  2026-07-01                                                |
//|   [修复] 爬梯冻结：closeMartinOrders() 平完马丁未清「零损周期」   |
//|          标志，导致 breakevenCycleActive 卡在 true → ladderPaused |
//|          恒真 → 上下爬梯全部停摆(实测卡死 16h)。现在平马丁后清    |
//|          breakevenCycleActive/ResetDone/MartinTicket/BaseTicket。 |
//|   [修复] #4753 平仓死循环：closeMartinOrders 对已不存在的幽灵单   |
//|          反复平仓失败(err 4753)→死循环刷屏。现遇仓位不存在即当    |
//|          已平、移出跟踪、跳过，不再空转。                         |
//| v1.01  2026-06-30                                                |
//|   [修复] 马丁矩离锚点漂移：马丁触发距离原以会随爬梯/重载漂移的     |
//|          base 价为参照；单边行情下锚点漂到远价位老 base，使 1.2%  |
//|          条件近乎恒真 → 在错误价位连开马丁(~1点间距、手数翻倍     |
//|          失控 0.04→0.12→0.28→0.60)。现 seek>0 时改以「最后一张    |
//|          马丁单开仓价」为参照，恢复正常等距(≥1.2%)台阶。          |
//| v1.00  基线版本(双向对冲+爬梯追踪+马丁加仓)                       |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//|                                                     GMarket.mq5|
//|                     Open Source Standalone Edition, xszyou 2026 |
//|                         https://github.com/xszyou/Easy-Deal |
//+------------------------------------------------------------------+
#property strict

// 输入参数（由 MT5 参数面板设置，启动时映射到运行变量）
input double InpFirstLots = 0.02;              // 起手大小
input double InpStep = 0.7;                    // 梯级（百分比）[A组]
input double InpMartinInterval = 1.0;          // 马丁最小矩离（百分比）[A组]
input double InpFilter = 0.1;                  // 虑波器（百分比）
input int    InpOrderTime = 0;                 // 开单间隔（秒）
input int    InpRetrySeconds = 1800;           // 重试间隔（秒）
input bool   InpIsPaused = false;              // 暂停策略执行
input bool   InpMartinEnabled = true;          // 马丁开关
input bool   InpIgnoreMagicNumber = false;     // 是否忽略魔术数（默认仅管理本EA，开启会把同品种手操单计入）
input double InpMaxLoss = 1000;                // 最大浮亏
input int    InpMaxMartinLevel = 3;            // 最大马丁层数
input double InpMaxAtrPct = 1.5;               // 允许马丁的最大ATR 百分比
input double InpMaxBollDeviation = 9999.0;     // 允许马丁的最大布林带偏离(9999=复现实盘死门)
input double InpMartinBreakevenProfit = 30;    // 马丁零损保护缓冲金额，<=0 关闭
input double InpMartinExitProfit = 0;          // 马丁整平利润目标(0=原版回正即平; 100~200=验证甜点区; 300+已证有害)
input bool   InpLogicalBreakeven = true;       // 逻辑零损保护（不修改订单）
input bool   InpBreakevenResetLadder = true;   // 零损时平掉爬梯方向base并重开
input bool   InpNewsFilterEnabled = false;     // 允许马丁的新闻过滤开关(NFP过滤已证伪,默认关)
input int    InpNewsBeforeMinutes = 60;        // 新闻前暂停分钟数
input int    InpNewsAfterMinutes = 60;         // 新闻后暂停分钟数
input bool   InpNewsHighImportance = true;     // 过滤高重要性新闻
input bool   InpNewsMediumImportance = false;  // 过滤中重要性新闻
input int    InpMagicNumber = 999;             // 魔术数(=旧GMarket, 用于接手遗留仓)
// ===== 四件套周机制 (风洞 2026-08-08 定版) =====
input double InpWeekProfitLock   = 200.0;      // 周盈落袋: 权益较周初 >=X 全平收工 (0=关)
input double InpWeekLossHalt     = 0;          // 周亏熔断: 权益较周初 <=-X 全平收工 (0=关)
input int    InpSoftCloseHours   = 12;         // 周末软着陆窗口小时 (0=关)
input double InpMartinLotCap     = 0.08;       // 马丁单手数封顶 (0=关)
input double InpCutCooldownHours = 24;         // 割肉后冷却小时 (0=关)
input bool   InpWeekResetOnBoot      = true;   // 启动/重启按"新周"重置base (周二/周三挂上也能重置)
input int    InpWeekResetGuardSecs   = 300;    // 重置后多少秒内不开新仓 (防挂上瞬间spread污染baseline)
input double InpWeekStartDelayHours  = 0.0;    // 每周真实开盘后延迟开新一轮的小时数 (0=不延迟；已有仓继续管理)

// ===== Runtime globals (seeded from input parameters at startup) =====
// Strategy code reads these; OnInit seeds them from the matching Inp* values.
double firstLots;
double step;
double martinInterval;
double filter;
int    orderTime;
int    retrySeconds;
bool   isPaused;
bool   martinEnabled;
bool   ignoreMagicNumber;
double maxLoss;
double martinExitProfit;
int    maxMartinLevel;
double maxAtrPct;
double maxBollDeviation;
double martinBreakevenProfit;
bool   logicalBreakevenEnabled;
bool   breakevenResetLadderEnabled;
bool   newsFilterEnabled;
int    newsBeforeMinutes;
int    newsAfterMinutes;
bool   newsHighImportance;
bool   newsMediumImportance;
int    MAGIC_NUMBER;
double weekProfitLock;
double weekLossHalt;
int    softCloseHours;
double martinLotCap;
double cutCooldownHours;
bool   weekResetOnBoot;
int    weekResetGuardSecs;
double weekStartDelayHours;
// 周状态 (四件套)
double   weekStartEquity = 0;
long     curWeekIdx = -1;
bool     weekHalted = false;
bool     softMartinSeen = false;
datetime cutPauseUntil = 0;
// 启动重置 + guard (B1: EA 在休市/周中挂上时正确重置 baseline)
datetime weekResetAt     = 0;   // 最近一次重置 baseline 的 tick 时刻 (用于 guard 窗口)
datetime weekResetGuardUntil = 0; // 重置后 N 秒内不开新仓
bool     weekBaselineArmed = false; // 首次拿到 baseline 后置 true (避免重复重置)


// UI Constants
#define UI_PREFIX "GM_UI_"
#define COLOR_BG clrBlack
#define COLOR_TEXT clrWhite
#define COLOR_BTN_ON clrGreen
#define COLOR_BTN_OFF clrRed
#define MAX_TRACKED_ORDERS 100
#define MAX_BREAKEVEN_TARGETS MAX_TRACKED_ORDERS

bool isOpenPosition = false;//是否已经新一轮开仓了
long lastBuyOrderTick = -1;//最后开的buy单
long lastSellOrderTick = -1;//最后开的sell单
long lastMartinOrderTick = -1;//最后开的马丁单
long lastMartinBaseTicket = -1;//马丁触发时同向新开的base单（不含首单）
bool isFollow = false; //是否正在追踪开仓
int followType = -1;//梯级方向
datetime openTime = 0;
long martinOrders[MAX_TRACKED_ORDERS];//马丁单
long breakevenTickets[MAX_BREAKEVEN_TARGETS];
double breakevenPrices[MAX_BREAKEVEN_TARGETS];
int breakevenCount = 0;
bool breakevenCycleActive = false;
bool breakevenResetDone = false;
long breakevenCycleMartinTicket = -1;
long breakevenCycleBaseTicket = -1;
int seek = 0;//马丁层数
int martinOrderCount = 0;//马丁订单数量（martinOrders 数组长度）
bool running = true;
string martinPauseReason = "";
datetime lastTradeActionTime = 0;
datetime lastAutoReloadTime = 0;
const int AUTO_RELOAD_COOLDOWN = 5;     // 2→5: 拉长 AutoReload 抑制窗口，覆盖 EA 自身 ladder/martin 多步操作(平仓重试 + 开base→Sleep500→开martin)的过渡期，避免重读把 followType/seek 冲掉，造成"爬梯/开马丁了却显示无方向(followType=-1)"的假象
const int AUTO_RELOAD_MIN_INTERVAL = 2;
long lastCloseAttemptTicket = -1;       // 平仓去重：上次尝试平仓的 ticket
datetime lastCloseAttemptTime = 0;      // 及其时间
const int CLOSE_DEDUP_WINDOW = 2;       // 同一 ticket 在该秒数内不重复发平仓请求，避免上一次平仓还在途时再发触发 #10039「Order to close already exists」
datetime nextRecoverAttemptTime = 0;
datetime missingBuyConfirmedAt = 0;
datetime missingSellConfirmedAt = 0;
const int RECOVER_MIN_INTERVAL = 5;
const int RECOVER_CONFIRM_SECONDS = 5;
const int POSITION_CLAIM_RETRIES = 10;
const int POSITION_CLAIM_SLEEP_MS = 200;
datetime nextLadderResetAttemptTime = 0;
const int LADDER_RESET_MIN_INTERVAL = 5;
bool breakevenReloadBlock = false;
long lastBreakevenTicket = -1;

// Martin 失败退避（2026-04-27 加入，防 04-24 22:14 那种秒级重试风暴）
datetime lastSellMartinFailTime = 0;
int sellMartinFailCount = 0;
datetime lastBuyMartinFailTime = 0;
int buyMartinFailCount = 0;
datetime lastSellMartinBackoffLogTime = 0;
datetime lastBuyMartinBackoffLogTime = 0;

int atrHandle = INVALID_HANDLE;
int bandsHandle = INVALID_HANDLE;
int slippagePoints = 200;

string GetMarginModeName(long marginMode)
{
   if (marginMode == ACCOUNT_MARGIN_MODE_RETAIL_NETTING){
      return "RETAIL_NETTING";
   }
   if (marginMode == ACCOUNT_MARGIN_MODE_EXCHANGE){
      return "EXCHANGE";
   }
   if (marginMode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING){
      return "RETAIL_HEDGING";
   }
   return "UNKNOWN";
}

ENUM_ORDER_TYPE_FILLING GetSymbolFillingMode()
{
   long fillingMode = 0;
   if (!SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE, fillingMode)){
      return ORDER_FILLING_IOC;
   }

   long executionMode = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_EXEMODE);
   if ((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC){
      return ORDER_FILLING_IOC;
   }
   if ((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK){
      return ORDER_FILLING_FOK;
   }

   if (executionMode != SYMBOL_TRADE_EXECUTION_MARKET){
      return ORDER_FILLING_RETURN;
   }
   return ORDER_FILLING_IOC;
}

double GetBid()
{
   return SymbolInfoDouble(_Symbol, SYMBOL_BID);
}

double GetAsk()
{
   return SymbolInfoDouble(_Symbol, SYMBOL_ASK);
}

void MarkTradeAction()
{
   lastTradeActionTime = TimeCurrent();
}

double GetAtrValue()
{
   if (atrHandle == INVALID_HANDLE){
      return 0;
   }
   double atrBuffer[];
   ArraySetAsSeries(atrBuffer, true);
   if (CopyBuffer(atrHandle, 0, 0, 1, atrBuffer) <= 0){
      return 0;
   }
   return atrBuffer[0];
}

bool GetBollingerBands(double &upper, double &middle)
{
   if (bandsHandle == INVALID_HANDLE){
      return false;
   }
   double upperBuf[];
   double middleBuf[];
   ArraySetAsSeries(upperBuf, true);
   ArraySetAsSeries(middleBuf, true);
   if (CopyBuffer(bandsHandle, 0, 0, 1, upperBuf) <= 0){
      return false;
   }
   if (CopyBuffer(bandsHandle, 1, 0, 1, middleBuf) <= 0){
      return false;
   }
   upper = upperBuf[0];
   middle = middleBuf[0];
   return true;
}

long FindLatestPositionTicket(ENUM_POSITION_TYPE type, double volume, double price)
{
   long latestTicket = -1;
   datetime latestTime = 0;
   double volumeStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double priceTolerance = SymbolInfoDouble(_Symbol, SYMBOL_POINT) * 10;

   for (int i = PositionsTotal() - 1; i >= 0; i--){
      long ticket = -1;
      if (!SelectPositionByIndex(i, ticket)){
         continue;
      }
      if (!IsTrackedPosition()){
         continue;
      }
      if ((int)PositionGetInteger(POSITION_TYPE) != type){
         continue;
      }
      double posVolume = PositionGetDouble(POSITION_VOLUME);
      if (MathAbs(posVolume - volume) > volumeStep){
         continue;
      }
      if (price > 0){
         double posPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         if (MathAbs(posPrice - price) > priceTolerance){
            continue;
         }
      }
      datetime posTime = (datetime)PositionGetInteger(POSITION_TIME);
      if (posTime >= latestTime){
         latestTime = posTime;
         latestTicket = ticket;
      }
   }
   return latestTicket;
}

long FindRecentPositionTicket(ENUM_POSITION_TYPE type, double volume,
                              datetime earliestTime, double price)
{
   long latestTicket = -1;
   datetime latestTime = 0;
   double volumeStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double priceTolerance = SymbolInfoDouble(_Symbol, SYMBOL_POINT) * 50;

   for (int i = PositionsTotal() - 1; i >= 0; i--){
      long ticket = -1;
      if (!SelectPositionByIndex(i, ticket) || !IsTrackedPosition()) continue;
      if ((int)PositionGetInteger(POSITION_TYPE) != type) continue;
      if (MathAbs(PositionGetDouble(POSITION_VOLUME) - volume) > volumeStep) continue;

      datetime posTime = (datetime)PositionGetInteger(POSITION_TIME);
      if (posTime < earliestTime) continue;
      if (price > 0 && MathAbs(PositionGetDouble(POSITION_PRICE_OPEN) - price) > priceTolerance) continue;
      if (posTime >= latestTime){
         latestTime = posTime;
         latestTicket = ticket;
      }
   }
   return latestTicket;
}

bool SelectPositionByTicket(long ticket)
{
   if (ticket <= 0){
      return false;
   }
   return PositionSelectByTicket((ulong)ticket);
}

bool SelectPositionByIndex(int index, long &ticket)
{
   ulong posTicket = PositionGetTicket(index);
   if (posTicket == 0){
      return false;
   }
   ticket = (long)posTicket;
   return PositionSelectByTicket(posTicket);
}

bool IsTrackedPosition()
{
   if (PositionGetString(POSITION_SYMBOL) != _Symbol){
      return false;
   }
   if (!ignoreMagicNumber && (int)PositionGetInteger(POSITION_MAGIC) != MAGIC_NUMBER){
      return false;
   }
   return true;
}

void PrintPositionInfo()
{
   long ticket = (long)PositionGetInteger(POSITION_TICKET);
   string symbol = PositionGetString(POSITION_SYMBOL);
   int type = (int)PositionGetInteger(POSITION_TYPE);
   double volume = PositionGetDouble(POSITION_VOLUME);
   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   double profit = PositionGetDouble(POSITION_PROFIT);
   string typeName = type == POSITION_TYPE_BUY ? "BUY" : "SELL";
   PrintFormat("Position #%I64d %s %s volume=%.2f price=%.5f profit=%.2f",
               ticket, symbol, typeName, volume, openPrice, profit);
}

long GetPositionTicketFromDeal(ulong dealTicket)
{
   if (dealTicket == 0){
      return -1;
   }
   datetime now = TimeCurrent();
   if (!HistorySelect(now - 60, now + 60)){
      return -1;
   }
   if (!HistoryDealSelect(dealTicket)){
      return -1;
   }
   long positionId = (long)HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
   return positionId > 0 ? positionId : -1;
}

// Martin 失败退避：返回还需等待秒数；0=允许重试。
// 退避梯度：1 次失败 -> 5s，2 次 -> 30s，3 次及以上 -> 120s。
// 距上次失败超过 300s 视为冷却完成，重新允许并由上层负责清零。
int MartinBackoffRemaining(datetime lastFail, int failCount)
{
   if (lastFail == 0) return 0;
   datetime now = TimeCurrent();
   int elapsed = (int)(now - lastFail);
   if (elapsed >= 300) return 0;
   int wait = 5;
   if (failCount >= 2) wait = 30;
   if (failCount >= 3) wait = 120;
   return elapsed >= wait ? 0 : (wait - elapsed);
}

long SendMarketOrder(ENUM_ORDER_TYPE orderType, double volume, string comment)
{
   double orderVolume = volume;

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   double price = (orderType == ORDER_TYPE_BUY) ? GetAsk() : GetBid();
   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = orderVolume;
   request.type = orderType;
   request.price = price;
   request.deviation = slippagePoints;
   request.magic = MAGIC_NUMBER;
   request.comment = comment;
   request.type_filling = GetSymbolFillingMode();

   datetime sentAt = TimeCurrent();
   MarkTradeAction();
   ResetLastError();
   // DONE_PARTIAL(部分成交)也算成功: 仓位已真实存在, 按失败返 -1 会触发 recovery 重复开腿
   if (!OrderSend(request, result) ||
       (result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_DONE_PARTIAL)){
      string orderTypeName = orderType == ORDER_TYPE_BUY ? "BUY" : "SELL";
      PrintFormat("OrderSend failed: type=%s volume=%.2f price=%.5f filling=%d retcode=%d lastError=%d comment=%s",
                  orderTypeName, orderVolume, price, (int)request.type_filling,
                  (int)result.retcode, GetLastError(), result.comment);
      return -1;
   }


   long hintedTicket = GetPositionTicketFromDeal(result.deal);
   if (hintedTicket <= 0 && result.order > 0){
      hintedTicket = (long)result.order;
   }

   ENUM_POSITION_TYPE posType = orderType == ORDER_TYPE_BUY ? POSITION_TYPE_BUY : POSITION_TYPE_SELL;
   // 慢 broker 可能先返回 DONE、稍后才把 position 注册进终端。最多等约 2 秒，
   // 且只认领本次发单时刻之后出现的仓位，不能误拿同方向旧 base。
   for (int attempt = 0; attempt < POSITION_CLAIM_RETRIES; attempt++){
      if (hintedTicket > 0 && SelectPositionByTicket(hintedTicket)){
         return hintedTicket;
      }
      long claimed = FindRecentPositionTicket(posType, orderVolume, sentAt - 1,
                                              attempt < 3 ? price : 0);
      if (claimed > 0) return claimed;
      Sleep(POSITION_CLAIM_SLEEP_MS);
   }

   // result.order 可能只是订单票而非持仓票；未确认仓位存在时必须返回 -1，
   // 交给带二次确认的 recovery 重扫，避免保存幽灵票号。
   return -1;
}

bool ClosePositionByTicket(long ticket)
{
   if (!SelectPositionByTicket(ticket)){
      return false;
   }

   // 平仓竞态守卫：同一 ticket 上一次平仓请求可能仍在途（持仓还在 = 还没成交），
   // 窗口内不重复发，避免 #10039「Order to close already exists」/ #10036 风暴。
   datetime nowClose = TimeCurrent();
   if (ticket == lastCloseAttemptTicket && (nowClose - lastCloseAttemptTime) < CLOSE_DEDUP_WINDOW){
      return false;
   }
   lastCloseAttemptTicket = ticket;
   lastCloseAttemptTime = nowClose;

   int type = (int)PositionGetInteger(POSITION_TYPE);
   double volume = PositionGetDouble(POSITION_VOLUME);
   string symbol = PositionGetString(POSITION_SYMBOL);
   long magic = (long)PositionGetInteger(POSITION_MAGIC);

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_DEAL;
   request.symbol = symbol;
   request.position = (ulong)ticket;
   request.volume = volume;
   request.type = (type == POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   request.price = (type == POSITION_TYPE_BUY) ? GetBid() : GetAsk();
   request.deviation = slippagePoints;
   request.magic = (int)magic;
   request.comment = "Close position";
   request.type_filling = GetSymbolFillingMode();

   MarkTradeAction();
   ResetLastError();
   if (!OrderSend(request, result) || result.retcode != TRADE_RETCODE_DONE){
      PrintFormat("Close position failed: ticket=%I64d filling=%d retcode=%d lastError=%d comment=%s",
                  ticket, (int)request.type_filling, (int)result.retcode,
                  GetLastError(), result.comment);
      return false;
   }
   return true;
}

double GetPositionNetProfit()
{
   return PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
}

void ClearBreakevenTargets()
{
   breakevenCount = 0;
   for (int i = 0; i < ArraySize(breakevenTickets); i++){
      breakevenTickets[i] = -1;
      breakevenPrices[i] = 0.0;
   }
}

bool CalculateBreakevenTargetPrice(long ticket, double &target)
{
   if (!SelectPositionByTicket(ticket)){
      return false;
   }
   if (PositionGetString(POSITION_SYMBOL) != _Symbol){
      return false;
   }

   int type = (int)PositionGetInteger(POSITION_TYPE);
   double volume = PositionGetDouble(POSITION_VOLUME);
   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);

   double spread = GetAsk() - GetBid();
   if (spread <= 0){
      spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) * _Point;
   }
   double commissionCost = -PositionGetDouble(POSITION_COMMISSION);
   if (commissionCost < 0){
      commissionCost = 0;
   }
   double commissionPriceDelta = 0.0;
   if (commissionCost > 0 && volume > 0){
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      if (tickValue <= 0){
         tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_PROFIT);
      }
      double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if (tickValue > 0 && tickSize > 0){
         commissionPriceDelta = commissionCost / (tickValue * volume) * tickSize;
      }
   }
   double newSL = (type == POSITION_TYPE_BUY)
      ? (openPrice + spread + commissionPriceDelta)
      : (openPrice - spread - commissionPriceDelta);
   newSL = NormalizeDouble(newSL, _Digits);

   int stopsLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   int freezeLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   double minDistance = MathMax(stopsLevel, freezeLevel) * _Point;
   double bid = GetBid();
   double ask = GetAsk();
   if (type == POSITION_TYPE_BUY){
      double maxSL = bid - minDistance;
      if (newSL > maxSL){
         return false;
      }
   }else{
      double minSL = ask + minDistance;
      if (newSL < minSL){
         return false;
      }
   }

   target = newSL;
   return true;
}

bool RegisterBreakevenTarget(long ticket)
{
   double target = 0.0;
   if (!CalculateBreakevenTargetPrice(ticket, target)){
      return false;
   }
   for (int i = 0; i < breakevenCount; i++){
      if (breakevenTickets[i] == ticket){
         breakevenPrices[i] = target;
         return true;
      }
   }
   if (breakevenCount >= ArraySize(breakevenTickets)){
      printfPro("Breakeven target buffer full");
      return false;
   }
   breakevenTickets[breakevenCount] = ticket;
   breakevenPrices[breakevenCount] = target;
   breakevenCount++;
   PrintFormat("Logical breakeven armed: ticket=%I64d target=%.5f",
               ticket, target);
   return true;
}

void RemoveBreakevenTarget(int index)
{
   for (int i = index; i < breakevenCount - 1; i++){
      breakevenTickets[i] = breakevenTickets[i + 1];
      breakevenPrices[i] = breakevenPrices[i + 1];
   }
   if (breakevenCount > 0){
      breakevenCount--;
      breakevenTickets[breakevenCount] = -1;
      breakevenPrices[breakevenCount] = 0.0;
   }
}

bool RemoveMartinOrderByTicket(long ticket)
{
   for (int i = 0; i < martinOrderCount; i++){
      if (martinOrders[i] == ticket){
         for (int j = i; j < martinOrderCount - 1; j++){
            martinOrders[j] = martinOrders[j + 1];
         }
         martinOrders[martinOrderCount - 1] = -1;
         martinOrderCount--;
         return true;
      }
   }
   return false;
}

void RefreshMartinBaseTicket()
{
   if (followType == POSITION_TYPE_BUY){
      lastMartinBaseTicket = lastSellOrderTick;
   }else if (followType == POSITION_TYPE_SELL){
      lastMartinBaseTicket = lastBuyOrderTick;
   }else{
      lastMartinBaseTicket = -1;
   }
}

void RecalculateMartinState()
{
   int newSeek = 0;
   long bestTicket = -1;
   double bestLots = 0.0;
   double volumeStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   for (int i = 0; i < martinOrderCount; i++){
      long ticket = martinOrders[i];
      if (ticket <= 0){
         continue;
      }
      if (!SelectPositionByTicket(ticket)){
         continue;
      }
      double lots = PositionGetDouble(POSITION_VOLUME);
      if (lots > firstLots + volumeStep * 0.5){
         newSeek++;
         if (lots > bestLots || (lots == bestLots && ticket > bestTicket)){
            bestLots = lots;
            bestTicket = ticket;
         }
      }
   }

   seek = newSeek;
   if (seek > 0){
      lastMartinOrderTick = bestTicket;
   }else{
      lastMartinOrderTick = -1;   // 马丁已全平，清掉残留锚点，防止下次新base开出时误用远价老马丁票触发同价马丁(2026-07-07)
   }
}

long FindLatestBaseTicketByType(ENUM_POSITION_TYPE type)
{
   return FindLatestPositionTicket(type, firstLots, 0);
}

bool ResetLadderBase()
{
   // 软着陆窗口禁止任何平后重开；现有马丁组只允许自然退出。
   if (InSoftCloseWindow()) return false;
   if (!breakevenResetLadderEnabled){
      return false;
   }
   datetime now = TimeCurrent();
   if (now < nextLadderResetAttemptTime){
      return false;
   }
   bool success = false;
   if (followType == POSITION_TYPE_BUY){
      long ladderTicket = lastBuyOrderTick;
      if (ladderTicket > 0){
         if (!ClosePositionByTicket(ladderTicket)){
            // 缺脚根因修复：持仓若已不存在(被零损/手动平掉, err 4753)，当作已平、跳过平仓直接重开，避免反复失败死循环
            if (SelectPositionByTicket(ladderTicket)){
               printfPro("Reset ladder buy base failed #" + GetLastError());
               nextLadderResetAttemptTime = now + LADDER_RESET_MIN_INTERVAL;
               return false;
            }
            printfPro("Reset ladder buy base: 持仓已不存在，跳过平仓直接重开");
         }
      }
      long newTicket = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy base reset");
      if (newTicket > 0){
         lastBuyOrderTick = newTicket;
         success = true;
      }else{
         printfPro("Reopen ladder buy base failed #" + GetLastError());
         lastBuyOrderTick = FindLatestBaseTicketByType(POSITION_TYPE_BUY);
      }
   }else if (followType == POSITION_TYPE_SELL){
      long ladderTicket = lastSellOrderTick;
      if (ladderTicket > 0){
         if (!ClosePositionByTicket(ladderTicket)){
            // 缺脚根因修复：持仓若已不存在(被零损/手动平掉, err 4753)，当作已平、跳过平仓直接重开，避免反复失败死循环
            if (SelectPositionByTicket(ladderTicket)){
               printfPro("Reset ladder sell base failed #" + GetLastError());
               nextLadderResetAttemptTime = now + LADDER_RESET_MIN_INTERVAL;
               return false;
            }
            printfPro("Reset ladder sell base: 持仓已不存在，跳过平仓直接重开");
         }
      }
      long newTicket = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell base reset");
      if (newTicket > 0){
         lastSellOrderTick = newTicket;
         success = true;
      }else{
         printfPro("Reopen ladder sell base failed #" + GetLastError());
         lastSellOrderTick = FindLatestBaseTicketByType(POSITION_TYPE_SELL);
      }
   }
   nextLadderResetAttemptTime = now + LADDER_RESET_MIN_INTERVAL;
   return success;
}

void UpdateBreakevenCycleStatus()
{
   if (!breakevenCycleActive){
      return;
   }
   bool martinAlive = (breakevenCycleMartinTicket > 0 &&
                       SelectPositionByTicket(breakevenCycleMartinTicket));
   bool baseAlive = (breakevenCycleBaseTicket > 0 &&
                     SelectPositionByTicket(breakevenCycleBaseTicket));
   if (!breakevenResetLadderEnabled || breakevenResetDone){
      if (!martinAlive && !baseAlive){
         breakevenCycleActive = false;
         breakevenResetDone = false;
         breakevenCycleMartinTicket = -1;
         breakevenCycleBaseTicket = -1;
      }
   }
}

void HandleBreakevenClosure(long ticket)
{
   if (RemoveMartinOrderByTicket(ticket)){
      RecalculateMartinState();
   }

   if (ticket == lastBuyOrderTick){
      lastBuyOrderTick = FindLatestBaseTicketByType(POSITION_TYPE_BUY);
   }else if (ticket == lastSellOrderTick){
      lastSellOrderTick = FindLatestBaseTicketByType(POSITION_TYPE_SELL);
   }

   RefreshMartinBaseTicket();

   if (breakevenCycleActive && !breakevenResetDone &&
       (ticket == breakevenCycleMartinTicket || ticket == breakevenCycleBaseTicket)){
      if (ResetLadderBase()){
         breakevenResetDone = true;
      }
   }

   UpdateBreakevenCycleStatus();
}

void TryResetLadderBaseIfNeeded()
{
   if (!breakevenCycleActive || breakevenResetDone || !breakevenResetLadderEnabled){
      return;
   }
   if (ResetLadderBase()){
      breakevenResetDone = true;
      UpdateBreakevenCycleStatus();
   }
}

void CheckLogicalBreakeven()
{
   if (!logicalBreakevenEnabled || breakevenCount <= 0){
      return;
   }

   double bid = GetBid();
   double ask = GetAsk();

   for (int i = 0; i < breakevenCount; i++){
      long ticket = breakevenTickets[i];
      double target = breakevenPrices[i];
      if (ticket <= 0){
         RemoveBreakevenTarget(i--);
         continue;
      }
      if (!SelectPositionByTicket(ticket)){
         RemoveBreakevenTarget(i--);
         continue;
      }
      int type = (int)PositionGetInteger(POSITION_TYPE);
      bool hit = false;
      if (type == POSITION_TYPE_BUY){
         if (bid <= target){
            hit = true;
         }
      }else{
         if (ask >= target){
            hit = true;
         }
      }
      if (!hit){
         continue;
      }
      if (ClosePositionByTicket(ticket)){
         RemoveBreakevenTarget(i--);
         HandleBreakevenClosure(ticket);
      }else{
         printfPro("Logical breakeven close failed #" + GetLastError());
      }
   }

   UpdateBreakevenCycleStatus();
}

bool SetPositionBreakevenSL(long ticket)
{
   if (logicalBreakevenEnabled){
      breakevenReloadBlock = false;
      lastBreakevenTicket = -1;
      return RegisterBreakevenTarget(ticket);
   }

   if (!SelectPositionByTicket(ticket)){
      return false;
   }
   if (PositionGetString(POSITION_SYMBOL) != _Symbol){
      return false;
   }

   int type = (int)PositionGetInteger(POSITION_TYPE);
   double volume = PositionGetDouble(POSITION_VOLUME);
   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   double currentSL = PositionGetDouble(POSITION_SL);

   double spread = GetAsk() - GetBid();
   if (spread <= 0){
      spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) * _Point;
   }
   double commissionCost = -PositionGetDouble(POSITION_COMMISSION);
   if (commissionCost < 0){
      commissionCost = 0;
   }
   double commissionPriceDelta = 0;
   if (commissionCost > 0 && volume > 0){
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      if (tickValue <= 0){
         tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_PROFIT);
      }
      double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if (tickValue > 0 && tickSize > 0){
         commissionPriceDelta = commissionCost / (tickValue * volume) * tickSize;
      }
   }
   double newSL = (type == POSITION_TYPE_BUY)
      ? (openPrice + spread + commissionPriceDelta)
      : (openPrice - spread - commissionPriceDelta);
   newSL = NormalizeDouble(newSL, _Digits);

   double eps = _Point * 0.5;
   if (currentSL > 0){
      if (type == POSITION_TYPE_BUY && currentSL >= newSL - eps){
         PrintFormat("Breakeven SL unchanged (BUY): ticket=%I64d currentSL=%.5f targetSL=%.5f",
                     ticket, currentSL, newSL);
         return true;
      }
      if (type == POSITION_TYPE_SELL && currentSL <= newSL + eps){
         PrintFormat("Breakeven SL unchanged (SELL): ticket=%I64d currentSL=%.5f targetSL=%.5f",
                     ticket, currentSL, newSL);
         return true;
      }
   }

   int stopsLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   int freezeLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   double minDistance = MathMax(stopsLevel, freezeLevel) * _Point;
   double bid = GetBid();
   double ask = GetAsk();
   if (type == POSITION_TYPE_BUY){
      double maxSL = bid - minDistance;
      if (newSL > maxSL){
         PrintFormat("Breakeven SL rejected (BUY): ticket=%I64d targetSL=%.5f maxSL=%.5f minDistance=%.5f",
                     ticket, newSL, maxSL, minDistance);
         return false;
      }
   }else{
      double minSL = ask + minDistance;
      if (newSL < minSL){
         PrintFormat("Breakeven SL rejected (SELL): ticket=%I64d targetSL=%.5f minSL=%.5f minDistance=%.5f",
                     ticket, newSL, minSL, minDistance);
         return false;
      }
   }

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_SLTP;
   request.symbol = _Symbol;
   request.position = (ulong)ticket;
   request.sl = newSL;
   request.tp = PositionGetDouble(POSITION_TP);
   request.magic = (int)PositionGetInteger(POSITION_MAGIC);

   MarkTradeAction();
   if (!OrderSend(request, result) || result.retcode != TRADE_RETCODE_DONE){
      PrintFormat("Set breakeven SL failed: retcode=%d lastError=%d comment=%s",
                  (int)result.retcode, GetLastError(), result.comment);
      return false;
   }
   breakevenReloadBlock = true;
   lastBreakevenTicket = ticket;
   PrintFormat("Breakeven SL set: ticket=%I64d newSL=%.5f",
               ticket, newSL);
   return true;
}

void ApplyMartinBreakevenStops()
{
   if (martinBreakevenProfit <= 0 || seek <= 0 || martinOrderCount <= 0){
      return;
   }

   int martinSide = -1;
   if (followType == POSITION_TYPE_BUY){
      martinSide = POSITION_TYPE_SELL;
   }else if (followType == POSITION_TYPE_SELL){
      martinSide = POSITION_TYPE_BUY;
   }
   if (martinSide == -1){
      return;
   }

   long baseTicket = lastMartinBaseTicket;
   long ladderTicket = (martinSide == POSITION_TYPE_SELL) ? lastBuyOrderTick : lastSellOrderTick;

   long martinTicket = -1;
   if (lastMartinOrderTick > 0 && SelectPositionByTicket(lastMartinOrderTick) &&
       (int)PositionGetInteger(POSITION_TYPE) == martinSide){
      martinTicket = lastMartinOrderTick;
   }else{
      long maxTicket = -1;
      for (int i = 0; i < martinOrderCount; i++){
         long ticket = martinOrders[i];
         if (ticket <= 0){
            continue;
         }
         if (!SelectPositionByTicket(ticket)){
            continue;
         }
         if ((int)PositionGetInteger(POSITION_TYPE) != martinSide){
            continue;
         }
         if (ticket > maxTicket){
            maxTicket = ticket;
         }
      }
      martinTicket = maxTicket;
   }

   if (martinTicket <= 0 || ladderTicket <= 0){
      return;
   }

   if (!SelectPositionByTicket(martinTicket) ||
       (int)PositionGetInteger(POSITION_TYPE) != martinSide){
      return;
   }
   double martinProfit = GetPositionNetProfit();

   double baseProfit = 0.0;
   bool hasBase = false;
   if (baseTicket > 0 && SelectPositionByTicket(baseTicket) &&
       (int)PositionGetInteger(POSITION_TYPE) == martinSide){
      baseProfit = GetPositionNetProfit();
      hasBase = true;
   }

   if (!SelectPositionByTicket(ladderTicket) ||
       (int)PositionGetInteger(POSITION_TYPE) == martinSide){
      return;
   }
   double ladderProfit = GetPositionNetProfit();
   if (ladderProfit >= 0){
      return;
   }

   if (martinProfit + baseProfit >= (-ladderProfit + martinBreakevenProfit)){
      bool armed = false;
      if (SetPositionBreakevenSL(martinTicket)){
         armed = true;
      }
      if (hasBase && SetPositionBreakevenSL(baseTicket)){
         armed = true;
      }
      if (breakevenResetLadderEnabled && armed){
         long cycleBase = hasBase ? baseTicket : -1;
         if (!breakevenCycleActive ||
             breakevenCycleMartinTicket != martinTicket ||
             breakevenCycleBaseTicket != cycleBase){
            breakevenCycleActive = true;
            breakevenResetDone = false;
            breakevenCycleMartinTicket = martinTicket;
            breakevenCycleBaseTicket = cycleBase;
            nextLadderResetAttemptTime = 0;
         }
      }
   }
}


//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
// ---- runtime input initialization ------------------------------------------

// Copy Inp* values into runtime globals at initialization.
void SeedRuntimeFromInputs()
  {
    firstLots                   = InpFirstLots;
    step                        = InpStep;
    martinInterval              = InpMartinInterval;
    filter                      = InpFilter;
    orderTime                   = InpOrderTime;
    retrySeconds                = InpRetrySeconds;
    isPaused                    = InpIsPaused;
    martinEnabled               = InpMartinEnabled;
    ignoreMagicNumber           = InpIgnoreMagicNumber;
    maxLoss                     = InpMaxLoss;
    maxMartinLevel              = InpMaxMartinLevel;
    maxAtrPct                   = InpMaxAtrPct;
    maxBollDeviation            = InpMaxBollDeviation;
    martinBreakevenProfit       = InpMartinBreakevenProfit;
    martinExitProfit            = InpMartinExitProfit;
    logicalBreakevenEnabled     = InpLogicalBreakeven;
    breakevenResetLadderEnabled = InpBreakevenResetLadder;
    newsFilterEnabled           = InpNewsFilterEnabled;
    newsBeforeMinutes           = InpNewsBeforeMinutes;
    newsAfterMinutes            = InpNewsAfterMinutes;
    newsHighImportance          = InpNewsHighImportance;
    newsMediumImportance        = InpNewsMediumImportance;
    MAGIC_NUMBER                = InpMagicNumber;
    weekProfitLock              = InpWeekProfitLock;
    weekLossHalt                = InpWeekLossHalt;
    softCloseHours              = InpSoftCloseHours;
    martinLotCap                = InpMartinLotCap;
    cutCooldownHours            = InpCutCooldownHours;
    weekResetOnBoot             = InpWeekResetOnBoot;
    weekResetGuardSecs          = InpWeekResetGuardSecs;
    weekStartDelayHours         = MathMax(0.0, InpWeekStartDelayHours);
  }

int OnInit()
  {
    SeedRuntimeFromInputs();

    ClearBreakevenTargets();
    breakevenCycleActive = false;
    breakevenResetDone = false;
    breakevenCycleMartinTicket = -1;
    breakevenCycleBaseTicket = -1;
    nextLadderResetAttemptTime = 0;
    nextRecoverAttemptTime = 0;
    missingBuyConfirmedAt = 0;
    missingSellConfirmedAt = 0;

    long marginMode = AccountInfoInteger(ACCOUNT_MARGIN_MODE);
    if (marginMode != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING){
       PrintFormat("[GMarket] 非对冲账户(回测放行不退出), margin mode=%s",
                   GetMarginModeName(marginMode));
       // 保持 v1.082 原策略行为：不因账户模式检测退出。
    }

    // 初始化代码
    atrHandle = iATR(_Symbol, PERIOD_H1, 14);
    bandsHandle = iBands(_Symbol, PERIOD_H1, 20, 0, 2.0, PRICE_CLOSE);
    openTime = TimeCurrent() + orderTime;
    UpdateEAStatus();

    // Setup UI
    CreateGUI();
    UpdateGUI();

    printfPro("重新载入");
    return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
    if (atrHandle != INVALID_HANDLE){
       IndicatorRelease(atrHandle);
       atrHandle = INVALID_HANDLE;
    }
    if (bandsHandle != INVALID_HANDLE){
       IndicatorRelease(bandsHandle);
       bandsHandle = INVALID_HANDLE;
    }

    ObjectsDeleteAll(0, UI_PREFIX);
  }

//+------------------------------------------------------------------+
//| 四件套周机制: 周基准/落袋/熔断/软着陆/冷却 (风洞 2026-08-08 定版)|
//| v1.08wl 2026-08-29  使用 SymbolInfoSessionTrade 对齐真实交易时段   |
//|   - "周"按 broker server time 切分，休市跨周时延迟到开市建 baseline|
//|   - 软着陆窗口按本周最后交易 session 的结束时间倒推                |
//|   - 窗口内纯底仓立即全平；马丁组自然退出后全平，不再开新仓          |
//|   - 启动和跨周重置后由 guard 暂停开仓，避免 spread 污染 baseline    |
//+------------------------------------------------------------------+

// --- helpers ----------------------------------------------------------

int SessionSeconds(datetime value)
{
   MqlDateTime dt;
   TimeToStruct(value, dt);
   return dt.hour * 3600 + dt.min * 60 + dt.sec;
}

bool IsTradeSessionOpenNow(datetime now)
{
   MqlDateTime dt;
   TimeToStruct(now, dt);
   int nowSeconds = dt.hour * 3600 + dt.min * 60 + dt.sec;

   for (uint session = 0; session < 16; session++){
      datetime fromTime = 0;
      datetime toTime = 0;
      if (!SymbolInfoSessionTrade(_Symbol, (ENUM_DAY_OF_WEEK)dt.day_of_week,
                                  session, fromTime, toTime)){
         break;
      }
      int fromSeconds = SessionSeconds(fromTime);
      int toSeconds = SessionSeconds(toTime);
      if (toSeconds == 0) toSeconds = 86400;

      if (fromSeconds <= toSeconds){
         if (nowSeconds >= fromSeconds && nowSeconds < toSeconds) return true;
      }else{
         // 极少数 broker 的交易时段会跨越午夜。
         if (nowSeconds >= fromSeconds || nowSeconds < toSeconds) return true;
      }
   }
   return false;
}

bool SymbolTradeAllowed()
{
   long mode = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_MODE);
   bool permission = (mode == SYMBOL_TRADE_MODE_FULL ||
                      mode == SYMBOL_TRADE_MODE_LONGONLY ||
                      mode == SYMBOL_TRADE_MODE_SHORTONLY);
   return permission && IsTradeSessionOpenNow(TimeCurrent());
}

bool GetCurrentWeekClose(datetime now, datetime &closeTime)
{
   MqlDateTime dt;
   TimeToStruct(now, dt);
   datetime todayStart = now - dt.hour * 3600 - dt.min * 60 - dt.sec;
   int daysSinceMonday = (dt.day_of_week + 6) % 7;
   datetime mondayStart = todayStart - daysSinceMonday * 86400;

   bool found = false;
   datetime latestClose = 0;
   // 搜索周一到周六，排除属于下个交易周的周日晚间开盘。
   for (int dayOffset = 0; dayOffset <= 5; dayOffset++){
      ENUM_DAY_OF_WEEK day = (ENUM_DAY_OF_WEEK)(dayOffset + 1);
      for (uint session = 0; session < 16; session++){
         datetime fromTime = 0;
         datetime toTime = 0;
         if (!SymbolInfoSessionTrade(_Symbol, day, session, fromTime, toTime)){
            break;
         }
         int fromSeconds = SessionSeconds(fromTime);
         int toSeconds = SessionSeconds(toTime);
         datetime candidate = mondayStart + dayOffset * 86400 + toSeconds;
         if (toSeconds <= fromSeconds) candidate += 86400;
         if (!found || candidate > latestClose){
            latestClose = candidate;
            found = true;
         }
      }
   }

   if (!found){
      // broker 未提供 session 元数据时保守回落到周六 00:00（server time）。
      latestClose = mondayStart + 5 * 86400;
   }
   closeTime = latestClose;
   return found;
}

// --- gates ------------------------------------------------------------

// 周盈/周亏只核算当前图表品种 + 当前 magic，避免同账户多 EA 相互触发落袋。
double GetTrackedOpenPnl()
{
   double total = 0.0;
   for (int i = PositionsTotal() - 1; i >= 0; i--){
      long ticket = -1;
      if (!SelectPositionByIndex(i, ticket)) continue;
      if (PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if ((int)PositionGetInteger(POSITION_MAGIC) != MAGIC_NUMBER) continue;
      total += PositionGetDouble(POSITION_PROFIT)
               + PositionGetDouble(POSITION_SWAP)
               + PositionGetDouble(POSITION_COMMISSION);
   }
   return total;
}

double GetTrackedClosedPnlSince(datetime fromTime, datetime toTime)
{
   if (fromTime <= 0 || toTime < fromTime || !HistorySelect(fromTime, toTime)) return 0.0;

   double total = 0.0;
   int deals = HistoryDealsTotal();
   for (int i = 0; i < deals; i++){
      ulong dealTicket = HistoryDealGetTicket(i);
      if (dealTicket == 0) continue;
      if (HistoryDealGetString(dealTicket, DEAL_SYMBOL) != _Symbol) continue;
      if ((int)HistoryDealGetInteger(dealTicket, DEAL_MAGIC) != MAGIC_NUMBER) continue;
      total += HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
               + HistoryDealGetDouble(dealTicket, DEAL_SWAP)
               + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION)
               + HistoryDealGetDouble(dealTicket, DEAL_FEE);
   }
   return total;
}

double GetTrackedWeekDelta(datetime now)
{
   return GetTrackedClosedPnlSince(weekResetAt, now)
          + GetTrackedOpenPnl()
          - weekStartEquity;
}

bool GetCurrentWeekOpen(datetime now, datetime &openTime)
{
   long weekIdx = (long)((now - 345600) / 604800);
   datetime mondayStart = (datetime)(weekIdx * 604800 + 345600);
   bool found = false;
   datetime earliestOpen = 0;

   for (int dayOffset = 0; dayOffset <= 5; dayOffset++){
      ENUM_DAY_OF_WEEK day = (ENUM_DAY_OF_WEEK)(dayOffset + 1);
      for (uint session = 0; session < 16; session++){
         datetime fromTime = 0;
         datetime toTime = 0;
         if (!SymbolInfoSessionTrade(_Symbol, day, session, fromTime, toTime)) break;
         datetime candidate = mondayStart + dayOffset * 86400 + SessionSeconds(fromTime);
         if (!found || candidate < earliestOpen){
            earliestOpen = candidate;
            found = true;
         }
      }
   }

   openTime = found ? earliestOpen : mondayStart;
   return found;
}

bool InWeekStartDelayWindow()
{
   if (weekStartDelayHours <= 0) return false;
   datetime weekOpen = 0;
   GetCurrentWeekOpen(TimeCurrent(), weekOpen);
   datetime allowNewCycleAt = weekOpen + (int)MathRound(weekStartDelayHours * 3600.0);
   return TimeCurrent() < allowNewCycleAt;
}

bool InSoftCloseWindow()
{
   if (softCloseHours <= 0) return false;
   datetime now = TimeCurrent();
   datetime weekClose = 0;
   GetCurrentWeekClose(now, weekClose);
   datetime windowStart = weekClose - softCloseHours * 3600;
   return (now >= windowStart && now < weekClose && SymbolTradeAllowed());
}

bool OpenBlockedNow()
{
   if (weekHalted) return true;
   if (InWeekStartDelayWindow()) return true;
   if (InSoftCloseWindow()) return true;
   if (cutPauseUntil > 0 && TimeCurrent() < cutPauseUntil) return true;
   // 重置 guard 窗口内不开新仓 (B1)
   if (weekResetGuardUntil > 0 && TimeCurrent() < weekResetGuardUntil) return true;
   return false;
}

// 返回 true = 周机制拦截 (已落袋/熔断/软着陆收工); false = 允许正常交易
bool WeeklyGate()
{
   datetime now = TimeCurrent();
   long wkNow = (long)((now - 345600) / 604800);

   // 首次挂载或跨周休市后，必须等真实交易时段开启才建立 baseline。
   if (!weekBaselineArmed){
      curWeekIdx = wkNow;
      if (!SymbolTradeAllowed()) return true;

      weekStartEquity = GetTrackedOpenPnl();
      weekBaselineArmed = true;
      weekResetAt = now;
      weekResetGuardUntil = (weekResetOnBoot && weekResetGuardSecs > 0)
                            ? now + weekResetGuardSecs : 0;
      weekHalted = false;
      softMartinSeen = false;
      printfPro("Boot baseline equity " + DoubleToString(weekStartEquity, 2) +
                ", guard until " + TimeToString(weekResetGuardUntil));
   }

   // 跨周时先解除 armed；若仍休市则持续拦截，开市后的首个 tick 再建新基准。
   if (wkNow != curWeekIdx){
      curWeekIdx = wkNow;
      weekBaselineArmed = false;
      if (!SymbolTradeAllowed()) return true;

      weekStartEquity = GetTrackedOpenPnl();
      weekBaselineArmed = true;
      weekResetAt = now;
      weekResetGuardUntil = weekResetGuardSecs > 0 ? now + weekResetGuardSecs : 0;
      weekHalted = false;
      softMartinSeen = false;
      printfPro("New week: baseline equity " + DoubleToString(weekStartEquity, 2) +
                ", guard until " + TimeToString(weekResetGuardUntil));
   }

   if (weekHalted) return true;

   double delta = GetTrackedWeekDelta(now);
   if (weekProfitLock > 0 && delta >= weekProfitLock){
      printfPro("Week profit locked: +" + DoubleToString(delta, 2));
      if (CloseAllOrders()){ ResetAllStatus(); weekHalted = true; }
      return true;
   }
   if (weekLossHalt > 0 && delta <= -weekLossHalt){
      printfPro("Week loss halt: " + DoubleToString(delta, 2));
      if (CloseAllOrders()){ ResetAllStatus(); weekHalted = true; }
      return true;
   }

   if (InSoftCloseWindow()){
      if (seek > 0){
         softMartinSeen = true;
         return false; // 保留现有马丁组，只允许其自然退出。
      }

      // 没有马丁时（包括纯两张底仓、或马丁刚自然结束）立即清仓并停到下周。
      printfPro(softMartinSeen
                ? "Weekend soft close: martin cycle resolved"
                : "Weekend soft close: close base hedge");
      if (CloseAllOrders()){
         ResetAllStatus();
         weekHalted = true;
      }
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
  {
   UpdateGUI(); // Update UI on every tick

   // 风控与周末门必须先于所有会平仓/重开仓的状态逻辑。
   if (CheckMaxLoss()) return;
   if (WeeklyGate()) return;

   CheckLogicalBreakeven();
   TryResetLadderBaseIfNeeded();
   AutoReloadIfNeeded();

   if (isPaused){
    printfPro("Strategy paused", true);
    return;
   }
   if (!running){
    printfPro("Error: handle orders manually and restart", true);
    return;
   }

   RecoverMissingOrders();

    // Open positions
    if (!isOpenPosition)
    {
       CheckEntryConditions();
    }
    // Add and take profit
    if (isOpenPosition)
    {
       CheckAddAndTakeProfitConditions();
   }
  }

//+------------------------------------------------------------------+
//| 检查买卖条件                                                     |
//+------------------------------------------------------------------+
void CheckEntryConditions()
  {
   if (OpenBlockedNow())
   {
      return;
   }
   if (TimeCurrent() < openTime)
   {
      return;
   }

   isFollow = true;

    // Hedge entry: open BUY first; only open SELL after BUY confirms.
    // If BUY fails -> nothing to clean up, back off via retrySeconds.
    // If SELL fails -> keep BUY leg, mark isOpenPosition=true; RecoverMissingOrders fills SELL on its cadence.
    // No local cleanup / no immediate retry, to avoid spread-bleed when broker repeatedly rejects one side.
    if(isFollow) {
        lastBuyOrderTick = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy first order");
        if (lastBuyOrderTick < 0) {
            int err = GetLastError();
            isFollow = false;
            int retryDelay = retrySeconds > 0 ? retrySeconds : 1800;
            openTime = TimeCurrent() + retryDelay;
            printfPro("Buy first order failed #" + err + ", retry in " + retryDelay + "s");
            return;
        }
        Sleep(500); // broker anti-scalping: delay before opposite leg
        lastSellOrderTick = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell first order");
        if (lastSellOrderTick < 0) {
            int err = GetLastError();
            printfPro("Sell first order failed #" + err + "; keeping Buy leg, deferring to RecoverMissingOrders");
        }
        isOpenPosition = true;
        isFollow = false;
        followType = -1;
        lastMartinBaseTicket = -1;
    }


  }


//+------------------------------------------------------------------+
//| 更新Ea状态                                               |
//+------------------------------------------------------------------+
void UpdateEAStatus(){

    // 1. 收集所有相关订单
    long buyTickets[MAX_TRACKED_ORDERS];      // BUY 订单票号
    double buyPrices[MAX_TRACKED_ORDERS];    // BUY 订单价格
    double buyLots[MAX_TRACKED_ORDERS];      // BUY 订单手数
    int buyCount = 0;

    long sellTickets[MAX_TRACKED_ORDERS];     // SELL 订单票号
    double sellPrices[MAX_TRACKED_ORDERS];   // SELL 订单价格
    double sellLots[MAX_TRACKED_ORDERS];     // SELL 订单手数
    int sellCount = 0;

    // 遍历所有订单，分类收集
    for (int i = PositionsTotal() - 1; i >= 0; i--){
        long ticket = -1;
        if (SelectPositionByIndex(i, ticket) &&
            IsTrackedPosition()){

            int posType = (int)PositionGetInteger(POSITION_TYPE);
            if (posType == POSITION_TYPE_BUY && buyCount < MAX_TRACKED_ORDERS){
                buyTickets[buyCount] = ticket;
                buyPrices[buyCount] = PositionGetDouble(POSITION_PRICE_OPEN);
                buyLots[buyCount] = PositionGetDouble(POSITION_VOLUME);
                buyCount++;
            }
            else if (posType == POSITION_TYPE_SELL && sellCount < MAX_TRACKED_ORDERS){
                sellTickets[sellCount] = ticket;
                sellPrices[sellCount] = PositionGetDouble(POSITION_PRICE_OPEN);
                sellLots[sellCount] = PositionGetDouble(POSITION_VOLUME);
                sellCount++;
            }
        }
    }

    int totalCount = buyCount + sellCount;

    // 2. 根据订单数量处理不同情况

   //--- 情况1：无持仓，重置所有状态
   if (totalCount == 0){
       ResetAllStatus();
       printfPro("重载：无持仓，状态已重置");
       return;
   }

    //--- 情况2：单边持仓，进入缺腿恢复模式（不中断运行）
    if (buyCount == 0 && sellCount > 0){
        isOpenPosition = true;
        isFollow = false;
        followType = -1;
        seek = 0;
        martinOrderCount = 0;
        lastBuyOrderTick = -1;
        lastSellOrderTick = sellTickets[0];
        lastMartinOrderTick = lastSellOrderTick;
        lastMartinBaseTicket = -1;
        running = true;
        for (int i = 0; i < ArraySize(martinOrders); i++){
            martinOrders[i] = -1;
        }
        printfPro("单边持仓：缺少BUY腿，进入恢复模式");
        return;
    }
    if (sellCount == 0 && buyCount > 0){
        isOpenPosition = true;
        isFollow = false;
        followType = -1;
        seek = 0;
        martinOrderCount = 0;
        lastSellOrderTick = -1;
        lastBuyOrderTick = buyTickets[0];
        lastMartinOrderTick = lastBuyOrderTick;
        lastMartinBaseTicket = -1;
        running = true;
        for (int i = 0; i < ArraySize(martinOrders); i++){
            martinOrders[i] = -1;
        }
        printfPro("单边持仓：缺少SELL腿，进入恢复模式");
        return;
    }

    //--- 情况3：稳定态奇数订单不符合本策略结构，安全停机，禁止继续补单/加仓。
    // 自身多步交易的短暂奇数态已由 AUTO_RELOAD_COOLDOWN 屏蔽。
    if (totalCount % 2 != 0){
        running = false;
        printfPro("重载异常：检测到稳定态奇数订单，策略已安全停机，buyCount=" +
                  buyCount + ", sellCount=" + sellCount);
        return;
    }

    //--- 情况4：只有基础对冲单 (1买1卖)
    if (buyCount == 1 && sellCount == 1){
        isOpenPosition = true;
        isFollow = false;
        followType = -1;
        seek = 0;
        martinOrderCount = 0;
        lastBuyOrderTick = buyTickets[0];
        lastSellOrderTick = sellTickets[0];
        lastMartinOrderTick = -1;
        lastMartinBaseTicket = -1;
        running = true;
        printfPro("重载：基础对冲单已恢复");
        return;
    }

    //--- 情况5：有马丁加仓单
    isOpenPosition = true;
    isFollow = false;
    running = true;

    // 判断马丁方向：哪边订单多，哪边就是马丁方向
    // followType 表示爬梯方向，应为马丁方向的反向
    if (buyCount > sellCount){
        followType = POSITION_TYPE_SELL;
        RestoreMartinStatus_Buy(buyTickets, buyPrices, buyLots, buyCount,
                                sellTickets, sellPrices, sellLots, sellCount);
    }
    else if (sellCount > buyCount){
        followType = POSITION_TYPE_BUY;
        RestoreMartinStatus_Sell(buyTickets, buyPrices, buyLots, buyCount,
                                 sellTickets, sellPrices, sellLots, sellCount);
    }
    else {
        // buyCount == sellCount 但都大于1，异常情况
        running = false;
        printfPro("重载异常：买卖单数量相等但大于1");
    }

    // 绘制成本线
    if (martinOrderCount > 0){
        ObjectDelete(0, "MartinLine");
        ObjectCreate(0, "MartinLine", OBJ_HLINE, 0, 0, CalculateMartinOrdersTotalCost());
    }
}
bool ShouldAutoReload()
{
   datetime now = TimeCurrent();
   // 2026-08-11 陈年票号强制重载: 任一记账票号已不在实仓 = 状态失真, 必须重扫。
   // 不受「零损周期/交易动作冷却」抑制 —— 实测那两道门会让 lastSell/lastMartin 指向幽灵票的
   // 状态永久卡死(seek 停在 1, 每 tick 刷平仓失败)。仅保留 MIN_INTERVAL 节流防每 tick 重扫。
   if (isOpenPosition && now - lastAutoReloadTime > AUTO_RELOAD_MIN_INTERVAL){
      if ((lastBuyOrderTick > 0 && !SelectPositionByTicket(lastBuyOrderTick)) ||
          (lastSellOrderTick > 0 && !SelectPositionByTicket(lastSellOrderTick)) ||
          (lastMartinOrderTick > 0 && !SelectPositionByTicket(lastMartinOrderTick))){
         printfPro("AutoReload: 检测到陈年票号(记账票已不在实仓), 强制重扫");
         return true;
      }
   }
   if (logicalBreakevenEnabled && (breakevenCycleActive || breakevenCount > 0)){
      return false;
   }
   if (now - lastTradeActionTime <= AUTO_RELOAD_COOLDOWN){
      return false;
   }
   if (now - lastAutoReloadTime <= AUTO_RELOAD_MIN_INTERVAL){
      return false;
   }
   if (breakevenReloadBlock){
      int trackedCount = calcTotalOrders();
      int expectedCount = GetExpectedTrackedCount();
      if (trackedCount != expectedCount &&
          MathAbs(trackedCount - expectedCount) == 1 &&
          lastBreakevenTicket > 0 &&
          !SelectPositionByTicket(lastBreakevenTicket)){
         return false;
      }
   }

   int trackedCount = calcTotalOrders();
   int expectedCount = GetExpectedTrackedCount();
   if (trackedCount != expectedCount){
      return true;
   }

   if (isOpenPosition){
      if (lastBuyOrderTick > 0 && !SelectPositionByTicket(lastBuyOrderTick)){
         return true;
      }
      if (lastSellOrderTick > 0 && !SelectPositionByTicket(lastSellOrderTick)){
         return true;
      }
      for (int i = 0; i < martinOrderCount; i++){
         if (martinOrders[i] > 0 && !SelectPositionByTicket(martinOrders[i])){
            return true;
         }
      }
   }

   return false;
}
void AutoReloadIfNeeded()
{
   if (!ShouldAutoReload()){
      return;
   }
   lastAutoReloadTime = TimeCurrent();
   printfPro("自动重载：检测到手动订单变更", true);
   UpdateEAStatus();
}
void ResetAllStatus(){
    isOpenPosition = false;
    lastBuyOrderTick = -1;
    lastSellOrderTick = -1;
    lastMartinOrderTick = -1;
    lastMartinBaseTicket = -1;
    isFollow = false;
    followType = -1;
    openTime = TimeCurrent() + orderTime;
    seek = 0;
    martinOrderCount = 0;
    running = true;
    breakevenReloadBlock = false;
    lastBreakevenTicket = -1;
    ClearBreakevenTargets();
    breakevenCycleActive = false;
    breakevenResetDone = false;
    breakevenCycleMartinTicket = -1;
    breakevenCycleBaseTicket = -1;
    nextRecoverAttemptTime = 0;
    missingBuyConfirmedAt = 0;
    missingSellConfirmedAt = 0;

    // 清空马丁订单数组
    for (int i = 0; i < ArraySize(martinOrders); i++){
        martinOrders[i] = -1;
    }
}

int GetExpectedTrackedCount()
{
   if (!isOpenPosition){
      return 0;
   }
   int expected = 0;
   if (lastBuyOrderTick > 0){
      expected++;
   }
   if (lastSellOrderTick > 0){
      expected++;
   }
   if (martinOrderCount > 0){
      expected += martinOrderCount;
   }
   return expected;
}
void RestoreMartinStatus_Buy(long &buyTickets[], double &buyPrices[], double &buyLots[], int buyCount,
                              long &sellTickets[], double &sellPrices[], double &sellLots[], int sellCount){

    // 1. 识别 SELL 端的 base order（应该只有1个）
    lastSellOrderTick = sellTickets[0];
    long martinBaseTicket = -1;
    int martinBaseCount = 0;
    for (int i = 0; i < sellCount; i++){
        if (sellLots[i] == firstLots){
            martinBaseCount++;
            if (sellTickets[i] > martinBaseTicket){
                martinBaseTicket = sellTickets[i];
            }
        }
    }
    lastMartinBaseTicket = (martinBaseCount >= 2) ? martinBaseTicket : -1;

    // 2. 识别 BUY 端订单
    // - 价格最高的 firstLots 单是 base buy
    // - 其他 firstLots 单是追踪单
    // - 非 firstLots 单是马丁单
    // - 手数最大（或价格最低）的非 firstLots 单是最后马丁单

    long baseBuyTicket = -1;
    double baseBuyPrice = 0;
    long lastMartinTicket = -1;
    double lastMartinLots = 0;
    double lastMartinPrice = 999999;

    seek = 0;
    martinOrderCount = 0;
    for (int i = 0; i < ArraySize(martinOrders); i++){
        martinOrders[i] = -1;
    }

    for (int i = 0; i < buyCount; i++){
        if (buyLots[i] == firstLots){
            // firstLots 单：找价格最高的作为 base buy
            if (buyPrices[i] > baseBuyPrice){
                // 如果之前有 base，把它加入马丁数组
                if (baseBuyTicket != -1){
                    if (martinOrderCount >= ArraySize(martinOrders)){
                        printfPro("Martin order buffer full");
                        break;
                    }
                    martinOrders[martinOrderCount] = baseBuyTicket;
                    martinOrderCount++;
                }
                baseBuyPrice = buyPrices[i];
                baseBuyTicket = buyTickets[i];
            }
            else {
                // 不是最高价的 firstLots 单，加入马丁数组
                if (martinOrderCount >= ArraySize(martinOrders)){
                    printfPro("Martin order buffer full");
                    break;
                }
                martinOrders[martinOrderCount] = buyTickets[i];
                martinOrderCount++;
            }
        }
        else {
            // 非 firstLots 单是马丁单
            if (martinOrderCount >= ArraySize(martinOrders)){
                printfPro("Martin order buffer full");
                break;
            }
            martinOrders[martinOrderCount] = buyTickets[i];
            martinOrderCount++;
            seek++;

            // 找手数最大的（或价格最低的）作为最后马丁单
            if (buyLots[i] > lastMartinLots ||
                (buyLots[i] == lastMartinLots && buyPrices[i] < lastMartinPrice)){
                lastMartinLots = buyLots[i];
                lastMartinPrice = buyPrices[i];
                lastMartinTicket = buyTickets[i];
            }
        }
    }
    if (!running){
        return;
    }

    lastBuyOrderTick = baseBuyTicket;
    lastMartinOrderTick = lastMartinTicket;

    printfPro("重载BUY马丁：seek=" + seek +
              ", baseBuy=" + baseBuyTicket +
              ", baseSell=" + lastSellOrderTick +
              ", lastMartin=" + lastMartinTicket);

    // 打印马丁订单详情
    for (int i = 0; i < martinOrderCount; i++){
        if (SelectPositionByTicket(martinOrders[i])){
            PrintPositionInfo();
        }
    }
}
void RestoreMartinStatus_Sell(long &buyTickets[], double &buyPrices[], double &buyLots[], int buyCount,
                               long &sellTickets[], double &sellPrices[], double &sellLots[], int sellCount){

    // 1. 识别 BUY 端的 base order（应该只有1个）
    lastBuyOrderTick = buyTickets[0];
    long martinBaseTicket = -1;
    int martinBaseCount = 0;
    for (int i = 0; i < buyCount; i++){
        if (buyLots[i] == firstLots){
            martinBaseCount++;
            if (buyTickets[i] > martinBaseTicket){
                martinBaseTicket = buyTickets[i];
            }
        }
    }
    lastMartinBaseTicket = (martinBaseCount >= 2) ? martinBaseTicket : -1;

    // 2. 识别 SELL 端订单
    // - 价格最低的 firstLots 单是 base sell
    // - 其他 firstLots 单是追踪单
    // - 非 firstLots 单是马丁单
    // - 手数最大（或价格最高）的非 firstLots 单是最后马丁单

    long baseSellTicket = -1;
    double baseSellPrice = 999999;
    long lastMartinTicket = -1;
    double lastMartinLots = 0;
    double lastMartinPrice = 0;

    seek = 0;
    martinOrderCount = 0;
    for (int i = 0; i < ArraySize(martinOrders); i++){
        martinOrders[i] = -1;
    }

    for (int i = 0; i < sellCount; i++){
        if (sellLots[i] == firstLots){
            // firstLots 单：找价格最低的作为 base sell
            if (sellPrices[i] < baseSellPrice){
                // 如果之前有 base，把它加入马丁数组
                if (baseSellTicket != -1){
                    if (martinOrderCount >= ArraySize(martinOrders)){
                        printfPro("Martin order buffer full");
                        break;
                    }
                    martinOrders[martinOrderCount] = baseSellTicket;
                    martinOrderCount++;
                }
                baseSellPrice = sellPrices[i];
                baseSellTicket = sellTickets[i];
            }
            else {
                // 不是最低价的 firstLots 单，加入马丁数组
                if (martinOrderCount >= ArraySize(martinOrders)){
                    printfPro("Martin order buffer full");
                    break;
                }
                martinOrders[martinOrderCount] = sellTickets[i];
                martinOrderCount++;
            }
        }
        else {
            // 非 firstLots 单是马丁单
            if (martinOrderCount >= ArraySize(martinOrders)){
                printfPro("Martin order buffer full");
                break;
            }
            martinOrders[martinOrderCount] = sellTickets[i];
            martinOrderCount++;
            seek++;

            // 找手数最大的（或价格最高的）作为最后马丁单
            if (sellLots[i] > lastMartinLots ||
                (sellLots[i] == lastMartinLots && sellPrices[i] > lastMartinPrice)){
                lastMartinLots = sellLots[i];
                lastMartinPrice = sellPrices[i];
                lastMartinTicket = sellTickets[i];
            }
        }
    }
    if (!running){
        return;
    }

    lastSellOrderTick = baseSellTicket;
    lastMartinOrderTick = lastMartinTicket;

    printfPro("重载SELL马丁：seek=" + seek +
              ", baseBuy=" + lastBuyOrderTick +
              ", baseSell=" + baseSellTicket +
              ", lastMartin=" + lastMartinTicket);

    // 打印马丁订单详情
    for (int i = 0; i < martinOrderCount; i++){
        if (SelectPositionByTicket(martinOrders[i])){
            PrintPositionInfo();
        }
    }
}


//+------------------------------------------------------------------+
//| 检查加仓和止盈条件                                               |
//+------------------------------------------------------------------+
void CheckAddAndTakeProfitConditions() {

   // close martin / breakeven protection
   if (followType != -1 && seek > 0){
      if (martinBreakevenProfit > 0){
         ApplyMartinBreakevenStops();
      }
      if (calcTotalMartinOrdersProfit() >= martinExitProfit && closeMartinOrders()){
         followType = -1;
         seek = 0;
         martinOrderCount = 0;
         lastMartinBaseTicket = -1;
         printfPro("close martin");
         // clear martin line
         ObjectDelete(0, "MartinLine");
         return;
      }
   }

   // 软着陆窗口内禁止爬梯换仓和新马丁；上面的自然退出检查仍保留。
   if (InSoftCloseWindow()) return;

   if (seek == 0 && followType == POSITION_TYPE_BUY && SelectPositionByTicket(lastSellOrderTick) && PositionGetDouble(POSITION_PROFIT) >= 0){
      followType = -1;
      printfPro("Lower boundary crossed, reset ladder direction");
   }

   if (seek == 0 && followType == POSITION_TYPE_SELL && SelectPositionByTicket(lastBuyOrderTick) && PositionGetDouble(POSITION_PROFIT) >= 0){
      followType = -1;
      printfPro("Upper boundary crossed, reset ladder direction");
   }

   bool ladderPaused = breakevenCycleActive;

   // ladder up
   if(!ladderPaused && followType != POSITION_TYPE_SELL && SelectPositionByTicket(lastBuyOrderTick) && (GetBid() - PositionGetDouble(POSITION_PRICE_OPEN)) / PositionGetDouble(POSITION_PRICE_OPEN) * 100 >= step){
      PrintPositionInfo();
      if (ClosePositionByTicket(lastBuyOrderTick)){
         lastBuyOrderTick = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy base");
         if (lastBuyOrderTick != -1){
            if (followType == -1){// first ladder step sets direction
               followType = POSITION_TYPE_BUY;
               lastMartinOrderTick = lastSellOrderTick;
            }
            printfPro("Ladder up");
         }else {
            printfPro("Ladder up buy failed #" + GetLastError());
         }
      }else {
         printfPro("Ladder up close failed #" + GetLastError());
      }
   }

   // ladder down followType == -1 || followType == POSITION_TYPE_SELL
   else if(!ladderPaused && followType != POSITION_TYPE_BUY && SelectPositionByTicket(lastSellOrderTick) && (PositionGetDouble(POSITION_PRICE_OPEN) - GetAsk()) / PositionGetDouble(POSITION_PRICE_OPEN) * 100 >= step){
      PrintPositionInfo();
      if (ClosePositionByTicket(lastSellOrderTick)){
         lastSellOrderTick = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell base");
         if (lastSellOrderTick != -1){
            if (followType == -1){// first ladder step sets direction
               followType = POSITION_TYPE_SELL;
               lastMartinOrderTick = lastBuyOrderTick;
            }
            printfPro("Ladder down");
         }else {
            printfPro("Ladder down sell failed #" + GetLastError());
         }
      }else {
         printfPro("Ladder down close failed #" + GetLastError());
      }
   }

   // sell martin - 向下爬梯时开SELL马丁单
   else if (followType == POSITION_TYPE_BUY){
      long ladderTicket = lastBuyOrderTick;
      long martinBaseTicket = lastMartinBaseTicket > 0 ? lastMartinBaseTicket : lastSellOrderTick;
      double ladderPrice = 0.0;
      double martinBasePrice = 0.0;
      double ladderProfit = 0.0;
      double martinBaseProfit = 0.0;
      if (SelectPositionByTicket(ladderTicket) &&
          (int)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY){
         ladderPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         ladderProfit = PositionGetDouble(POSITION_PROFIT)
                        + PositionGetDouble(POSITION_SWAP)
                        + PositionGetDouble(POSITION_COMMISSION);
      }
      if (SelectPositionByTicket(martinBaseTicket) &&
          (int)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL){
         martinBasePrice = PositionGetDouble(POSITION_PRICE_OPEN);
         martinBaseProfit = PositionGetDouble(POSITION_PROFIT)
                            + PositionGetDouble(POSITION_SWAP)
                            + PositionGetDouble(POSITION_COMMISSION);
      }
      // 马丁矩离参照：seek>0 时以"最后一张马丁单"的开仓价为准(不再用会随爬梯/重载漂移的 base 价)，
      // 杜绝锚点漂到远价位老 base 导致在错误价位连开马丁(2026-06-30 修)
      double martinRefPrice = martinBasePrice;
      if (seek > 0 && lastMartinOrderTick > 0 && SelectPositionByTicket(lastMartinOrderTick)){
         martinRefPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      }
      // 向下爬梯：SELL 端亏损达到马丁距离(以最后马丁为参照) && BUY base亏损超过滤波器距离（两张base均浮亏）
      if (ladderPrice > 0 && martinBasePrice > 0 && martinRefPrice > 0 &&
          (martinRefPrice - GetAsk()) / martinRefPrice * 100 <= 0 - martinInterval &&
          (GetBid() - ladderPrice) / ladderPrice * 100 <= 0 - filter &&
          ladderProfit < 0 && martinBaseProfit < 0){

         int sellWait = MartinBackoffRemaining(lastSellMartinFailTime, sellMartinFailCount);
         if (sellWait > 0){
            datetime nowTs = TimeCurrent();
            if (nowTs - lastSellMartinBackoffLogTime >= 30){
               printfPro("Sell martin backoff: " + sellWait + "s left (failCount=" + sellMartinFailCount + ")");
               lastSellMartinBackoffLogTime = nowTs;
            }
            return;
         }

         if (maxMartinLevel > 0 && seek >= maxMartinLevel){
             printfPro("Max Martin Level Reached (L" + seek + ")");
             return;
         }

         string reason = "";
         if (!CheckMartinConditions(reason)){
            martinPauseReason = reason;
            if (seek == 0){
               printfPro("Martin paused: " + reason, true);
            }
            return;
         }
         martinPauseReason = "";

         if (martinOrderCount + 2 > ArraySize(martinOrders)){
            printfPro("Martin order buffer full");
            return;
         }
         long prevSellBase = lastSellOrderTick;
         long prevMartinTick = lastMartinOrderTick;
         long prevMartinBase = lastMartinBaseTicket;
         if (prevSellBase <= 0){
            printfPro("Sell martin skipped: missing sell base");
            return;
         }
         martinOrders[martinOrderCount] = prevSellBase;
         martinOrderCount ++;
         // add tracking order
         long newSellBase = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell base");
         if (newSellBase == -1){
            printfPro("Sell martin base failed #" + GetLastError());
            martinOrderCount--;
            martinOrders[martinOrderCount] = -1;
            lastSellOrderTick = prevSellBase;
            lastMartinBaseTicket = prevMartinBase;
            lastMartinOrderTick = prevMartinTick;
            return;
         }
         lastSellOrderTick = newSellBase;
         lastMartinBaseTicket = newSellBase;

         if (maxMartinLevel > 0 && seek >= maxMartinLevel){
            printfPro("Reached max martin level: " + maxMartinLevel);
            return;
         }

         // add martin order
         double martinLots = 0;
         if (SelectPositionByTicket(lastMartinOrderTick)){
            double lastLots = PositionGetDouble(POSITION_VOLUME);
            if (seek > 0){
               martinLots = (lastLots + firstLots) * 2;
            }else {
               martinLots = lastLots * 2;
            }
         }
         if (martinLots <= 0){
            martinLots = firstLots * 2;
         }
         if (martinLotCap > 0 && martinLots > martinLotCap){
            printfPro("MartinLotCap: " + DoubleToString(martinLots,2) + " -> " + DoubleToString(martinLotCap,2));
            martinLots = martinLotCap;
         }
         Sleep(500); // broker anti-scalping: delay between sell base and sell martin (fixes 5/7 22x reject loop)
         // 2026-07-14 v1.04 防贴脸护栏：马丁落地前按「实际将成交价 vs 锚点」复核层间距。
         // 入口判定已保证 ≥martinInterval，此处不一致 = 锚点在判定与落地之间被改（未知路径漂移），
         // 宁可回滚刚开的 base 跳过本层，也不在贴脸位置堆双倍手数。触发即打 MartinSpacingGuard 日志。
         if (seek > 0){
            double guardRef = martinRefPrice;
            if (lastMartinOrderTick > 0 && SelectPositionByTicket(lastMartinOrderTick)){
               guardRef = PositionGetDouble(POSITION_PRICE_OPEN); // 重读，防 Sleep 期间状态被改
            }
            double guardGap = (guardRef > 0) ? MathAbs(GetBid() - guardRef) / guardRef * 100.0 : -1;
            if (guardGap >= 0 && guardGap < martinInterval * 0.5){
               printfPro("MartinSpacingGuard: 拦截贴脸Sell martin gap=" + DoubleToString(guardGap, 4) +
                         "% < " + DoubleToString(martinInterval * 0.5, 2) + "%, 回滚base跳过本层");
               lastSellMartinFailTime = TimeCurrent();
               sellMartinFailCount++;
               if (ClosePositionByTicket(newSellBase)){
                  lastSellOrderTick = prevSellBase;
                  lastMartinBaseTicket = prevMartinBase;
                  martinOrderCount--;
                  martinOrders[martinOrderCount] = -1;
               }else{
                  printfPro("Rollback sell base failed #" + GetLastError());
               }
               lastMartinOrderTick = prevMartinTick;
               return;
            }
         }
         long newMartinTicket = SendMarketOrder(ORDER_TYPE_SELL, martinLots, "Sell martin");
         if (newMartinTicket != -1){
            if (martinOrderCount >= ArraySize(martinOrders)){
               printfPro("Martin order buffer full");
               return;
            }
            martinOrders[martinOrderCount] = newMartinTicket;
            martinOrderCount ++;
            seek ++;
            lastMartinOrderTick = newMartinTicket;
            sellMartinFailCount = 0;
            lastSellMartinFailTime = 0;
            printfPro("Sell martin");

            // draw line
            ObjectDelete(0, "MartinLine");
            ObjectCreate(0, "MartinLine", OBJ_HLINE, 0, 0, CalculateMartinOrdersTotalCost());
         }else {
            lastSellMartinFailTime = TimeCurrent();
            sellMartinFailCount ++;
            printfPro("Sell martin order failed #" + GetLastError() + " (failCount=" + sellMartinFailCount + ", will backoff)");
            bool rollbackOk = ClosePositionByTicket(newSellBase);
            if (rollbackOk){
               lastSellOrderTick = prevSellBase;
               lastMartinBaseTicket = prevMartinBase;
               martinOrderCount--;
               martinOrders[martinOrderCount] = -1;
            }else{
               printfPro("Rollback sell base failed #" + GetLastError());
            }
            lastMartinOrderTick = prevMartinTick;
         }
      }
   }

   // buy martin - 向上爬梯时开BUY马丁单
   else if (followType == POSITION_TYPE_SELL){
      long ladderTicket = lastSellOrderTick;
      long martinBaseTicket = lastMartinBaseTicket > 0 ? lastMartinBaseTicket : lastBuyOrderTick;
      double ladderPrice = 0.0;
      double martinBasePrice = 0.0;
      double ladderProfit = 0.0;
      double martinBaseProfit = 0.0;
      if (SelectPositionByTicket(ladderTicket) &&
          (int)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL){
         ladderPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         ladderProfit = PositionGetDouble(POSITION_PROFIT)
                        + PositionGetDouble(POSITION_SWAP)
                        + PositionGetDouble(POSITION_COMMISSION);
      }
      if (SelectPositionByTicket(martinBaseTicket) &&
          (int)PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY){
         martinBasePrice = PositionGetDouble(POSITION_PRICE_OPEN);
         martinBaseProfit = PositionGetDouble(POSITION_PROFIT)
                            + PositionGetDouble(POSITION_SWAP)
                            + PositionGetDouble(POSITION_COMMISSION);
      }
      // 马丁矩离参照：seek>0 时以"最后一张马丁单"的开仓价为准(不再用会随爬梯/重载漂移的 base 价)，
      // 杜绝锚点漂到远价位老 base 导致在错误价位连开马丁(2026-06-30 修)
      double martinRefPrice = martinBasePrice;
      if (seek > 0 && lastMartinOrderTick > 0 && SelectPositionByTicket(lastMartinOrderTick)){
         martinRefPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      }
      // 向上爬梯：BUY 端亏损达到马丁距离(以最后马丁为参照) && SELL base亏损超过滤波器距离（两张base均浮亏）
      if (ladderPrice > 0 && martinBasePrice > 0 && martinRefPrice > 0 &&
          (GetBid() - martinRefPrice) / martinRefPrice * 100 <= 0 - martinInterval &&
          (ladderPrice - GetAsk()) / ladderPrice * 100 <= 0 - filter &&
          ladderProfit < 0 && martinBaseProfit < 0){

         int buyWait = MartinBackoffRemaining(lastBuyMartinFailTime, buyMartinFailCount);
         if (buyWait > 0){
            datetime nowTs2 = TimeCurrent();
            if (nowTs2 - lastBuyMartinBackoffLogTime >= 30){
               printfPro("Buy martin backoff: " + buyWait + "s left (failCount=" + buyMartinFailCount + ")");
               lastBuyMartinBackoffLogTime = nowTs2;
            }
            return;
         }

         if (maxMartinLevel > 0 && seek >= maxMartinLevel){
             printfPro("Max Martin Level Reached (L" + seek + ")");
             return;
         }

         string reason2 = "";
         if (!CheckMartinConditions(reason2)){
            martinPauseReason = reason2;
            if (seek == 0){
               printfPro("Martin paused: " + reason2, true);
            }
            return;
         }
         martinPauseReason = "";

         if (martinOrderCount + 2 > ArraySize(martinOrders)){
            printfPro("Martin order buffer full");
            return;
         }
         long prevBuyBase = lastBuyOrderTick;
         long prevMartinTick2 = lastMartinOrderTick;
         long prevMartinBase2 = lastMartinBaseTicket;
         if (prevBuyBase <= 0){
            printfPro("Buy martin skipped: missing buy base");
            return;
         }
         martinOrders[martinOrderCount] = prevBuyBase;
         martinOrderCount ++;

         // add tracking order
         long newBuyBase = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy base");
         if (newBuyBase == -1){
            printfPro("Buy martin base failed #" + GetLastError());
            martinOrderCount--;
            martinOrders[martinOrderCount] = -1;
            lastBuyOrderTick = prevBuyBase;
            lastMartinBaseTicket = prevMartinBase2;
            lastMartinOrderTick = prevMartinTick2;
            return;
         }
         lastBuyOrderTick = newBuyBase;
         lastMartinBaseTicket = newBuyBase;

         if (maxMartinLevel > 0 && seek >= maxMartinLevel){
            printfPro("Reached max martin level: " + maxMartinLevel);
            return;
         }

         // add martin order
         double martinLots2 = 0;
         if (SelectPositionByTicket(lastMartinOrderTick)){
            double lastLots2 = PositionGetDouble(POSITION_VOLUME);
            if (seek > 0){
               martinLots2 = (lastLots2 + firstLots) * 2;
            }else {
               martinLots2 = lastLots2 * 2;
            }
         }
         if (martinLots2 <= 0){
            martinLots2 = firstLots * 2;
         }
         if (martinLotCap > 0 && martinLots2 > martinLotCap){
            printfPro("MartinLotCap: " + DoubleToString(martinLots2,2) + " -> " + DoubleToString(martinLotCap,2));
            martinLots2 = martinLotCap;
         }
         Sleep(500); // broker anti-scalping: delay between buy base and buy martin (fixes 5/7 22x reject loop)
         // 2026-07-14 v1.04 防贴脸护栏（同 Sell 侧，buy 按 Ask 落地价复核）
         if (seek > 0){
            double guardRef2 = martinRefPrice;
            if (lastMartinOrderTick > 0 && SelectPositionByTicket(lastMartinOrderTick)){
               guardRef2 = PositionGetDouble(POSITION_PRICE_OPEN); // 重读，防 Sleep 期间状态被改
            }
            double guardGap2 = (guardRef2 > 0) ? MathAbs(GetAsk() - guardRef2) / guardRef2 * 100.0 : -1;
            if (guardGap2 >= 0 && guardGap2 < martinInterval * 0.5){
               printfPro("MartinSpacingGuard: 拦截贴脸Buy martin gap=" + DoubleToString(guardGap2, 4) +
                         "% < " + DoubleToString(martinInterval * 0.5, 2) + "%, 回滚base跳过本层");
               lastBuyMartinFailTime = TimeCurrent();
               buyMartinFailCount++;
               if (ClosePositionByTicket(newBuyBase)){
                  lastBuyOrderTick = prevBuyBase;
                  lastMartinBaseTicket = prevMartinBase2;
                  martinOrderCount--;
                  martinOrders[martinOrderCount] = -1;
               }else{
                  printfPro("Rollback buy base failed #" + GetLastError());
               }
               lastMartinOrderTick = prevMartinTick2;
               return;
            }
         }
         long newMartinTicket2 = SendMarketOrder(ORDER_TYPE_BUY, martinLots2, "Buy martin");
         if (newMartinTicket2 != -1){
            if (martinOrderCount >= ArraySize(martinOrders)){
               printfPro("Martin order buffer full");
               return;
            }
            martinOrders[martinOrderCount] = newMartinTicket2;
            martinOrderCount ++;
            seek ++;
            lastMartinOrderTick = newMartinTicket2;
            buyMartinFailCount = 0;
            lastBuyMartinFailTime = 0;
            printfPro("Buy martin");

            // draw line
            ObjectDelete(0, "MartinLine");
            ObjectCreate(0, "MartinLine", OBJ_HLINE, 0, 0, CalculateMartinOrdersTotalCost());

         }else {
            lastBuyMartinFailTime = TimeCurrent();
            buyMartinFailCount ++;
            printfPro("Buy martin order failed #" + GetLastError() + " (failCount=" + buyMartinFailCount + ", will backoff)");
            bool rollbackOk2 = ClosePositionByTicket(newBuyBase);
            if (rollbackOk2){
               lastBuyOrderTick = prevBuyBase;
               lastMartinBaseTicket = prevMartinBase2;
               martinOrderCount--;
               martinOrders[martinOrderCount] = -1;
            }else{
               printfPro("Rollback buy base failed #" + GetLastError());
            }
            lastMartinOrderTick = prevMartinTick2;
         }
      }
   }

}


// 计算买入手数，为可用保证金的1%
double CalculateBuyVolume() {

    return firstLots;
}

// 关闭所有马丁单的函数
bool closeMartinOrders() {
   bool success = true;
   for (int i= 0; i < martinOrderCount; i ++)
   {
      if (martinOrders[i] != -1){
         if (!ClosePositionByTicket(martinOrders[i])){
            // 缺脚根因修复：仓位若已不存在(被零损/手动/broker平掉, err 4753)，当作已平、跳过，
            // 避免 closeMartinOrders 反复对幽灵单平仓失败→#4753 死循环(2026-07-01 修)
            if (!SelectPositionByTicket(martinOrders[i])){
               martinOrders[i] = -1;
            } else {
               success = false;
            }
         }
      }
   }

   if (!success){
      printfPro("OrderClose failed with error #" + GetLastError());
      return false;
   }

   // 周末软着陆中马丁组回正后直接清掉所有剩余仓位，不再重开一张 base。
   if (InSoftCloseWindow()){
      if (!CloseAllOrders()){
         printfPro("Weekend soft close: remaining positions close failed #" + GetLastError());
         return false;
      }
      seek = 0;
      martinOrderCount = 0;
      lastMartinBaseTicket = -1;
      for (int k = 0; k < ArraySize(martinOrders); k++) martinOrders[k] = -1;
      breakevenCycleActive = false;
      breakevenResetDone = false;
      breakevenCycleMartinTicket = -1;
      breakevenCycleBaseTicket = -1;
      return true;
   }

   if (followType == POSITION_TYPE_BUY){
      // 2026-08-11 幽灵票守卫: 记账的 sell base 已不在实仓(外部平仓/换挂接管遗留的陈年票)时,
      // 旧代码 return false → closeMartinOrders 永远走不完 → seek 卡死 + 每 tick 刷
      // "Close sell base failed #4753"(MT5-2 实测一天 13 万行)。与「Reset ladder buy base:
      // 持仓已不存在」同款处理: 跳过平仓直接重开。
      if (!SelectPositionByTicket(lastSellOrderTick)){
         printfPro("Close martin: sell base 持仓已不存在，跳过平仓直接重开");
      }
      else if (!ClosePositionByTicket(lastSellOrderTick)){
         printfPro("Close sell base failed #" + GetLastError());
         return false;
      }
      lastSellOrderTick = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell base");
      if (lastSellOrderTick < 0){
         running = false;
         printfPro("Open new sell base failed #" + GetLastError());
         return false;
      }
   }else if (followType == POSITION_TYPE_SELL){
      // 幽灵票守卫(同上, buy 侧)
      if (!SelectPositionByTicket(lastBuyOrderTick)){
         printfPro("Close martin: buy base 持仓已不存在，跳过平仓直接重开");
      }
      else if (!ClosePositionByTicket(lastBuyOrderTick)){
         printfPro("Close buy base failed #" + GetLastError());
         return false;
      }
      lastBuyOrderTick = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy base");
      if (lastBuyOrderTick < 0){
         running = false;
         printfPro("Open new buy base failed #" + GetLastError());
         return false;
      }
   }

   seek = 0;
   martinOrderCount = 0;
   lastMartinBaseTicket = -1;
   for (int j = 0; j < ArraySize(martinOrders); j++){
      martinOrders[j] = -1;
   }
   // 爬梯冻结根因修复：平完马丁必须清「零损周期」标志，否则 breakevenCycleActive 卡 true →
   // ladderPaused 永久为真 → 上下爬梯全冻(2026-07-01 修)
   breakevenCycleActive = false;
   breakevenResetDone = false;
   breakevenCycleMartinTicket = -1;
   breakevenCycleBaseTicket = -1;
   return success;
}


//计算马丁的综合成本
double CalculateMartinOrdersTotalCost() {
    double totalCost = 0.0;
    double totalLots = 0.0;

    // 遍历所有订单
    for(int i = 0; i < martinOrderCount; i++) {
        if(martinOrders[i] != -1 && SelectPositionByTicket(martinOrders[i])) {  // 选择每一个订单
            double orderVolume = PositionGetDouble(POSITION_VOLUME);  // 获取订单的手数
            double orderOpenPrice = PositionGetDouble(POSITION_PRICE_OPEN);  // 获取订单的开仓价格

            // 计算成本并累加到总成本
            totalCost += orderVolume * orderOpenPrice;
            totalLots += orderVolume;

        }
    }
    /**
    if (Symbol() == "GBPAUDm"){
               printf("totalCost:" + totalCost);
               printf("totalLots:" + totalLots);
            }
    **/
    return totalLots > 0 ? totalCost / totalLots : 0;
}

//日志输出
string afterPrint = "";
void printfPro(string text, bool once = false)
{
   if(!once || text != afterPrint)
     {
      double ask = GetAsk();
      double bid = GetBid();
      Print(text + "（Ask:" + DoubleToString(ask, _Digits) +
            ",Bid:" + DoubleToString(bid, _Digits) +
            ",seek:" + seek +
            ",lastbuy:" + lastBuyOrderTick +
            ", lastsell:" + lastSellOrderTick +
            ",lastmartin:" + lastMartinOrderTick +
            ",followType:" + followType +
            "martinprofix:" + DoubleToString(calcTotalMartinOrdersProfit(), 2) + "）" );
      afterPrint=text;
     }
}

//计算马丁总浮亏
double calcTotalMartinOrdersProfit()
{
   double profit = 0;
   for (int i= 0; i < martinOrderCount; i ++)
   {
         if (martinOrders[i] != -1 && SelectPositionByTicket(martinOrders[i])){
            profit += PositionGetDouble(POSITION_PROFIT)
                      + PositionGetDouble(POSITION_SWAP)
                      + PositionGetDouble(POSITION_COMMISSION);
         }
   }

   if (followType == POSITION_TYPE_BUY && SelectPositionByTicket(lastSellOrderTick)){
      profit += PositionGetDouble(POSITION_PROFIT)
                + PositionGetDouble(POSITION_SWAP)
                + PositionGetDouble(POSITION_COMMISSION);
   }else if (followType == POSITION_TYPE_SELL && SelectPositionByTicket(lastBuyOrderTick)){
      profit += PositionGetDouble(POSITION_PROFIT)
                + PositionGetDouble(POSITION_SWAP)
                + PositionGetDouble(POSITION_COMMISSION);
   }

   return profit;
}

//计算订单总数
int calcTotalOrders(int openType = -1){
   int count = 0;
   for (int i= PositionsTotal() - 1; i >= 0; i--)
   {
      long ticket = -1;
      if (SelectPositionByIndex(i, ticket))
      {
         if (IsTrackedPosition())
         {
            int posType = (int)PositionGetInteger(POSITION_TYPE);
            if (openType == -1 || posType == openType){
               count ++;
            }
         }
      }
    }
    return count;
}


bool IsTrackedOrder()
{
   return IsTrackedPosition();
}

bool CloseOrderByTicket(long ticket)
{
   return ClosePositionByTicket(ticket);
}

bool CloseAllOrders()
{
   bool success = true;
   for (int i = PositionsTotal() - 1; i >= 0; i--){
      long ticket = -1;
      if (SelectPositionByIndex(i, ticket) && IsTrackedPosition()){
         if (!ClosePositionByTicket(ticket)){
            success = false;
         }
      }
   }
   return success;
}

bool CheckMaxLoss()
{
   if (maxLoss <= 0){
      return false;
   }
   double totalProfit = 0;
   for (int i = PositionsTotal() - 1; i >= 0; i--){
      long ticket = -1;
      if (SelectPositionByIndex(i, ticket) && IsTrackedPosition()){
         totalProfit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      }
   }
   if (totalProfit <= 0 - maxLoss){
      // 闭市(10018)等平仓失败场景的重试节流: 避免每 tick 重复触发刷日志
      static datetime nextMaxLossRetry = 0;
      if (TimeCurrent() < nextMaxLossRetry){
         return false;
      }
      printfPro("Max loss triggered, total floating P/L: " + DoubleToString(totalProfit, 2));
      if (CloseAllOrders()){
         ResetAllStatus();
         if (cutCooldownHours > 0){
            cutPauseUntil = TimeCurrent() + (int)(cutCooldownHours * 3600.0);
            printfPro("Cut cooldown until " + TimeToString(cutPauseUntil));
         }
         return true;
      }
      // 平仓未全部成功(典型: 闭市 retcode 10018) → 状态不能重置!
      // 否则持仓成孤儿(爬梯/马丁/重载都不认) + 浮亏仍超限每tick重复触发死循环
      // (2026.06.05 一年回测实证: 割肉撞上闭市, 状态被重置, 满仓拖过周末 −1008→−1108)。
      // 保留全部 ticket 跟踪, 30 秒后重试, 开市第一时间平掉。
      printfPro("Max loss: 部分平仓失败(可能闭市), 状态保留待重试, 30s 后再试");
      nextMaxLossRetry = TimeCurrent() + 30;
      return false;
   }
   return false;
}

bool IsNewsTime(string &newsTitle) {
   if(!newsFilterEnabled) return false;

   datetime now = TimeCurrent();
   datetime start = now - newsAfterMinutes * 60;
   datetime end = now + newsBeforeMinutes * 60;

   MqlCalendarValue values[];

   if(CalendarValueHistory(values, start, end, NULL, NULL)) {
      for(int i=0; i<ArraySize(values); i++) {
         MqlCalendarEvent event;
         if(CalendarEventById(values[i].event_id, event)) {

             bool importanceMatch = false;
             if(newsHighImportance && event.importance == CALENDAR_IMPORTANCE_HIGH) importanceMatch = true;
             if(newsMediumImportance && event.importance == CALENDAR_IMPORTANCE_MODERATE) importanceMatch = true;

             if(!importanceMatch) continue;

             // Get currency from country
             MqlCalendarCountry country;
             string eventCurrency = "";
             if(CalendarCountryById(event.country_id, country)){
                 eventCurrency = country.currency;
             }

             string base = SymbolInfoString(_Symbol, SYMBOL_CURRENCY_BASE);
             string profit = SymbolInfoString(_Symbol, SYMBOL_CURRENCY_PROFIT);

             if(StringFind(eventCurrency, base) < 0 && StringFind(eventCurrency, profit) < 0) {
                 continue;
             }

             // Get event name
             newsTitle = event.name;
             return true;
         }
      }
   }
   return false;
}

bool CheckMartinConditions(string &reason)
{
   if (InSoftCloseWindow()){
      reason = "Weekend soft-landing window";
      return false;
   }
   if (cutPauseUntil > 0 && TimeCurrent() < cutPauseUntil){
      reason = "Cut cooldown";
      return false;
   }
   if (!martinEnabled){
      reason = "Martin disabled";
      return false;
   }

   string newsTitle = "";
   if (IsNewsTime(newsTitle)){
      reason = "News Event: " + newsTitle;
      return false;
   }

   double price = (GetBid() + GetAsk()) / 2.0;
   double atr = GetAtrValue();
   if (atr > 0){
      double atrPct = atr / price * 100;
      if (atrPct > maxAtrPct){
         reason = "ATR too high (" + DoubleToString(atrPct, 2) + "% > " + DoubleToString(maxAtrPct, 2) + "%)";
         return false;
      }
   }

   double upper = 0;
   double middle = 0;
   if (GetBollingerBands(upper, middle) && upper > 0 && middle > 0){
      double std = (upper - middle) / 2.0;
      if (std > 0){
         double deviation = MathAbs(price - middle) / std;
         if (deviation > maxBollDeviation){
            string direction = price > middle ? "above" : "below";
            reason = "Price deviation too large (" + direction + " " + DoubleToString(deviation, 2) + "x)";
            return false;
         }
      }
   }

   reason = "";
   return true;
}

void RecoverMissingOrders() {
    if (!isOpenPosition || InSoftCloseWindow() || weekHalted) return;

    datetime now = TimeCurrent();
    if (now < nextRecoverAttemptTime) return;
    bool attempted = false;

    if (lastBuyOrderTick == -1) {
        long existingBuy = FindLatestBaseTicketByType(POSITION_TYPE_BUY);
        if (existingBuy > 0) {
            lastBuyOrderTick = existingBuy;
            missingBuyConfirmedAt = 0;
            printfPro("Buy Leg 实仓已存在, 认领 #" + IntegerToString(existingBuy) + ", 取消 recovery 补开");
        } else if (missingBuyConfirmedAt == 0) {
            missingBuyConfirmedAt = now;
            nextRecoverAttemptTime = now + RECOVER_CONFIRM_SECONDS;
            printfPro("Missing Buy Leg: 等待二次确认");
        } else if (now - missingBuyConfirmedAt >= RECOVER_CONFIRM_SECONDS) {
            existingBuy = FindLatestBaseTicketByType(POSITION_TYPE_BUY);
            if (existingBuy > 0) {
                lastBuyOrderTick = existingBuy;
            } else {
                lastBuyOrderTick = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy base recovery");
                attempted = true;
                if (lastBuyOrderTick > 0) printfPro("Buy Leg Recovered: #" + IntegerToString(lastBuyOrderTick));
            }
            missingBuyConfirmedAt = 0;
        }
    } else {
        missingBuyConfirmedAt = 0;
    }

    if (lastSellOrderTick == -1) {
        long existingSell = FindLatestBaseTicketByType(POSITION_TYPE_SELL);
        if (existingSell > 0) {
            lastSellOrderTick = existingSell;
            missingSellConfirmedAt = 0;
            printfPro("Sell Leg 实仓已存在, 认领 #" + IntegerToString(existingSell) + ", 取消 recovery 补开");
        } else if (missingSellConfirmedAt == 0) {
            missingSellConfirmedAt = now;
            nextRecoverAttemptTime = now + RECOVER_CONFIRM_SECONDS;
            printfPro("Missing Sell Leg: 等待二次确认");
        } else if (now - missingSellConfirmedAt >= RECOVER_CONFIRM_SECONDS) {
            existingSell = FindLatestBaseTicketByType(POSITION_TYPE_SELL);
            if (existingSell > 0) {
                lastSellOrderTick = existingSell;
            } else {
                lastSellOrderTick = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell base recovery");
                attempted = true;
                if (lastSellOrderTick > 0) printfPro("Sell Leg Recovered: #" + IntegerToString(lastSellOrderTick));
            }
            missingSellConfirmedAt = 0;
        }
    } else {
        missingSellConfirmedAt = 0;
    }

    if (attempted) nextRecoverAttemptTime = now + RECOVER_MIN_INTERVAL;
}

//+------------------------------------------------------------------+
//| UI Functions                                                     |
//+------------------------------------------------------------------+

void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
{
   if(id == CHARTEVENT_OBJECT_CLICK) {
      if(sparam == UI_PREFIX + "BtnPause") {
         isPaused = !isPaused;
         UpdateButtonState();
         ChartRedraw();
      }
      else if(sparam == UI_PREFIX + "BtnMartin") {
         martinEnabled = !martinEnabled;
         UpdateButtonState();
         ChartRedraw();
      }
      else if(sparam == UI_PREFIX + "BtnMagic") {
         ignoreMagicNumber = !ignoreMagicNumber;
         UpdateButtonState();
         ChartRedraw();
         UpdateEAStatus(); // Refresh status as tracking might change
      }
      else if(sparam == UI_PREFIX + "BtnReload") {
         printfPro("Manual Reload Triggered", true);
         breakevenReloadBlock = false;
         lastBreakevenTicket = -1;
         ClearBreakevenTargets();
         breakevenCycleActive = false;
         breakevenResetDone = false;
         breakevenCycleMartinTicket = -1;
         breakevenCycleBaseTicket = -1;
         nextLadderResetAttemptTime = 0;
         UpdateEAStatus();
         ObjectSetInteger(0, sparam, OBJPROP_STATE, false); // Reset button state to unpressed
         ChartRedraw();
      }
   }
}

void CreateGUI()
{
   ObjectsDeleteAll(0, UI_PREFIX); // self-heal: force clean slate so reinit races can't leave stale objects

   // Bottom-Left Info Labels
   CreateLabel("LblInfo1", 20, 120, "Martin Level: --");
   CreateLabel("LblInfo2", 20, 100, "Direction: --");
   CreateLabel("LblInfo3", 20, 80, "ATR: --");
   CreateLabel("LblInfo4", 20, 60, "Bollinger: --");
   CreateLabel("LblInfo5", 20, 40, "Profit: --");

   // Bottom-Right Control Buttons
   int btnWidth = 120;
   int btnHeight = 30;
   int xBase = 140;
   int yBase = 40;

   CreateButton("BtnReload", "Reload EA State", CORNER_RIGHT_LOWER, xBase, yBase + (btnHeight + 5) * 3, btnWidth, btnHeight);
   CreateButton("BtnPause", "Pause Strategy", CORNER_RIGHT_LOWER, xBase, yBase + (btnHeight + 5) * 2, btnWidth, btnHeight);
   CreateButton("BtnMartin", "Martin Switch", CORNER_RIGHT_LOWER, xBase, yBase + (btnHeight + 5) * 1, btnWidth, btnHeight);
   CreateButton("BtnMagic", "Ignore Magic", CORNER_RIGHT_LOWER, xBase, yBase, btnWidth, btnHeight);

   UpdateButtonState();
}

void CreateLabel(string name, int x, int y, string text)
{
   string objName = UI_PREFIX + name;
   if(ObjectFind(0, objName) < 0) {
      ObjectCreate(0, objName, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, objName, OBJPROP_XDISTANCE, x);
      ObjectSetInteger(0, objName, OBJPROP_YDISTANCE, y);
      ObjectSetInteger(0, objName, OBJPROP_CORNER, CORNER_LEFT_LOWER);
      ObjectSetString(0, objName, OBJPROP_TEXT, text);
      ObjectSetInteger(0, objName, OBJPROP_COLOR, COLOR_TEXT);
      ObjectSetInteger(0, objName, OBJPROP_FONTSIZE, 10);
   }
}

void CreateButton(string name, string text, ENUM_BASE_CORNER corner, int x, int y, int width, int height)
{
   string objName = UI_PREFIX + name;
   if(ObjectFind(0, objName) < 0) {
      ObjectCreate(0, objName, OBJ_BUTTON, 0, 0, 0);
      ObjectSetInteger(0, objName, OBJPROP_XDISTANCE, x);
      ObjectSetInteger(0, objName, OBJPROP_YDISTANCE, y);
      ObjectSetInteger(0, objName, OBJPROP_CORNER, corner);
      ObjectSetInteger(0, objName, OBJPROP_XSIZE, width);
      ObjectSetInteger(0, objName, OBJPROP_YSIZE, height);
      ObjectSetString(0, objName, OBJPROP_TEXT, text);
      ObjectSetInteger(0, objName, OBJPROP_FONTSIZE, 9);
      ObjectSetInteger(0, objName, OBJPROP_COLOR, clrBlack);
      ObjectSetInteger(0, objName, OBJPROP_BGCOLOR, clrGray);
   }
}

void UpdateButtonState()
{
   static bool rebuilding = false;
   if (!rebuilding && ObjectFind(0, UI_PREFIX + "BtnPause") < 0) {
      rebuilding = true;
      CreateGUI();
      rebuilding = false;
      return;
   }
   SetButtonState("BtnReload", "Reload EA State", clrGray); // Stateless button
   SetButtonState("BtnPause", isPaused ? "Resume Strategy" : "Pause Strategy", isPaused ? COLOR_BTN_OFF : COLOR_BTN_ON);
   SetButtonState("BtnMartin", martinEnabled ? "Martin ON" : "Martin OFF", martinEnabled ? COLOR_BTN_ON : COLOR_BTN_OFF);
   SetButtonState("BtnMagic", ignoreMagicNumber ? "Ignore Magic: ON" : "Ignore Magic: OFF", ignoreMagicNumber ? COLOR_BTN_ON : clrGray);
   ChartRedraw(); // force immediate repaint after local panel state changes
}

void SetButtonState(string name, string text, color bgColor)
{
   string objName = UI_PREFIX + name;
   ObjectSetString(0, objName, OBJPROP_TEXT, text);
   ObjectSetInteger(0, objName, OBJPROP_BGCOLOR, bgColor);
}

void UpdateGUI()
{
   // Prepare Data
   string direction = "None";
   if(followType == POSITION_TYPE_BUY) direction = "BUY";
   else if(followType == POSITION_TYPE_SELL) direction = "SELL";

   double atr = GetAtrValue();
   double price = (GetBid() + GetAsk()) / 2.0;
   double atrPct = (price > 0) ? (atr / price * 100) : 0;

   double bollUpper = 0, bollMiddle = 0;
   double bollDev = 0;
   if (GetBollingerBands(bollUpper, bollMiddle) && bollMiddle > 0) {
      double std = (bollUpper - bollMiddle) / 2.0;
      if (std > 0) bollDev = MathAbs(price - bollMiddle) / std;
   }

   double totalProfit = calcTotalMartinOrdersProfit();

   // Update Labels
   ObjectSetString(0, UI_PREFIX + "LblInfo1", OBJPROP_TEXT, "Martin Level: " + IntegerToString(seek) + " / " + IntegerToString(maxMartinLevel));
   ObjectSetString(0, UI_PREFIX + "LblInfo2", OBJPROP_TEXT, "Direction: " + direction);
   ObjectSetString(0, UI_PREFIX + "LblInfo3", OBJPROP_TEXT, "ATR: " + DoubleToString(atrPct, 3) + "% (Max " + DoubleToString(maxAtrPct, 2) + "%)");
   ObjectSetString(0, UI_PREFIX + "LblInfo4", OBJPROP_TEXT, "Boll Dev: " + DoubleToString(bollDev, 2) + " (Max " + DoubleToString(maxBollDeviation, 2) + ")");
   ObjectSetString(0, UI_PREFIX + "LblInfo5", OBJPROP_TEXT, "Martin Profit: " + DoubleToString(totalProfit, 2));
}
