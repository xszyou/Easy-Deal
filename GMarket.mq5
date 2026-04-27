
#property copyright "Copyright 2026, by xszyou"
#property link      ""
#property version   "1.00"
#property strict
//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//|                                                      MyExpert.mq5|
//|                        Copyright 2024, MetaQuotes Software Corp. |
//|                                       http://www.metaquotes.net/ |
//+------------------------------------------------------------------+
#property strict

#include <Trade/Trade.mqh>


// 输入参数 (默认值；运行时可被 MQL5/Files/GMarket_config.set 覆盖)
input double InpFirstLots = 0.03;              // 起手大小
input double InpStep = 0.8;                    // 梯级（百分比）
input double InpMartinInterval = 1.2;          // 马丁最小矩离（百分比）
input double InpFilter = 0.1;                  // 虑波器（百分比）
input int    InpOrderTime = 0;                 // 开单间隔（秒）
input int    InpRetrySeconds = 1800;           // 重试间隔（秒）
input bool   InpIsPaused = false;              // 暂停策略执行
input bool   InpMartinEnabled = true;          // 马丁开关
input bool   InpIgnoreMagicNumber = true;      // 是否忽略魔术数（手操计入）
input double InpMaxLoss = 3000;                // 最大浮亏
input int    InpMaxMartinLevel = 3;            // 最大马丁层数
input double InpMaxAtrPct = 1.5;               // 允许马丁的最大ATR 百分比
input double InpMaxBollDeviation = 2.0;        // 允许马丁的最大布林带偏离
input double InpMartinBreakevenProfit = 0.0;   // 马丁零损保护缓冲金额，<=0 关闭
input bool   InpLogicalBreakeven = true;       // 逻辑零损保护（不修改订单）
input bool   InpBreakevenResetLadder = true;   // 零损时平掉爬梯方向base并重开
input bool   InpNewsFilterEnabled = true;      // 允许马丁的新闻过滤开关
input int    InpNewsBeforeMinutes = 60;        // 新闻前暂停分钟数
input int    InpNewsAfterMinutes = 60;         // 新闻后暂停分钟数
input bool   InpNewsHighImportance = true;     // 过滤高重要性新闻
input bool   InpNewsMediumImportance = false;  // 过滤中重要性新闻
input int    InpMagicNumber = 999;             // 魔术数

// ===== Runtime globals (writable; overridable by GMarket_config.set) =====
// Body code reads these; OnInit seeds them from Inp*; ReloadRuntimeConfig overrides from file.
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

// Config/trigger file state
datetime g_lastConfigApplied = 0;      // content timestamp from config.set (ts= line)
datetime g_lastReloadTrigger = 0;      // content timestamp from reload.trigger


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
const int AUTO_RELOAD_COOLDOWN = 2;
const int AUTO_RELOAD_MIN_INTERVAL = 2;
datetime nextRecoverAttemptTime = 0;
const int RECOVER_MIN_INTERVAL = 5;
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
   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   double price = (orderType == ORDER_TYPE_BUY) ? GetAsk() : GetBid();
   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = volume;
   request.type = orderType;
   request.price = price;
   request.deviation = slippagePoints;
   request.magic = MAGIC_NUMBER;
   request.comment = comment;
   request.type_filling = GetSymbolFillingMode();

   MarkTradeAction();
   ResetLastError();
   if (!OrderSend(request, result) || result.retcode != TRADE_RETCODE_DONE){
      string orderTypeName = orderType == ORDER_TYPE_BUY ? "BUY" : "SELL";
      PrintFormat("OrderSend failed: type=%s volume=%.2f price=%.5f filling=%d retcode=%d lastError=%d comment=%s",
                  orderTypeName, volume, price, (int)request.type_filling,
                  (int)result.retcode, GetLastError(), result.comment);
      return -1;
   }

   long positionTicket = GetPositionTicketFromDeal(result.deal);
   if (positionTicket <= 0 && result.order > 0){
      positionTicket = (long)result.order;
   }
   if (positionTicket <= 0){
      ENUM_POSITION_TYPE posType = orderType == ORDER_TYPE_BUY ? POSITION_TYPE_BUY : POSITION_TYPE_SELL;
      positionTicket = FindLatestPositionTicket(posType, volume, price);
   }
   return positionTicket;
}

bool ClosePositionByTicket(long ticket)
{
   if (!SelectPositionByTicket(ticket)){
      return false;
   }

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
      if (followType == POSITION_TYPE_BUY){
         lastMartinOrderTick = lastSellOrderTick;
      }else if (followType == POSITION_TYPE_SELL){
         lastMartinOrderTick = lastBuyOrderTick;
      }else{
         lastMartinOrderTick = -1;
      }
   }
}

long FindLatestBaseTicketByType(ENUM_POSITION_TYPE type)
{
   return FindLatestPositionTicket(type, firstLots, 0);
}

bool ResetLadderBase()
{
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
            printfPro("Reset ladder buy base failed #" + GetLastError());
            nextLadderResetAttemptTime = now + LADDER_RESET_MIN_INTERVAL;
            return false;
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
            printfPro("Reset ladder sell base failed #" + GetLastError());
            nextLadderResetAttemptTime = now + LADDER_RESET_MIN_INTERVAL;
            return false;
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
// ---- runtime config / reload helpers ---------------------------------------

// Copy Inp* input defaults into runtime globals. Called at OnInit (before config override).
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
    logicalBreakevenEnabled     = InpLogicalBreakeven;
    breakevenResetLadderEnabled = InpBreakevenResetLadder;
    newsFilterEnabled           = InpNewsFilterEnabled;
    newsBeforeMinutes           = InpNewsBeforeMinutes;
    newsAfterMinutes            = InpNewsAfterMinutes;
    newsHighImportance          = InpNewsHighImportance;
    newsMediumImportance        = InpNewsMediumImportance;
    MAGIC_NUMBER                = InpMagicNumber;
  }

bool ParseBoolValue(string v)
  {
    StringToLower(v);
    return (v == "true" || v == "1" || v == "yes" || v == "on");
  }

// Apply one key=value override. Returns true if key is recognized.
bool ApplyRuntimeOverride(string key, string val)
  {
    if (key == "InpFirstLots")             { firstLots = StringToDouble(val); return true; }
    if (key == "InpStep")                  { step = StringToDouble(val); return true; }
    if (key == "InpMartinInterval")        { martinInterval = StringToDouble(val); return true; }
    if (key == "InpFilter")                { filter = StringToDouble(val); return true; }
    if (key == "InpOrderTime")             { orderTime = (int)StringToInteger(val); return true; }
    if (key == "InpRetrySeconds")          { retrySeconds = (int)StringToInteger(val); return true; }
    if (key == "InpIsPaused")              { isPaused = ParseBoolValue(val); return true; }
    if (key == "InpMartinEnabled")         { martinEnabled = ParseBoolValue(val); return true; }
    if (key == "InpIgnoreMagicNumber")     { ignoreMagicNumber = ParseBoolValue(val); return true; }
    if (key == "InpMaxLoss")               { maxLoss = StringToDouble(val); return true; }
    if (key == "InpMaxMartinLevel")        { maxMartinLevel = (int)StringToInteger(val); return true; }
    if (key == "InpMaxAtrPct")             { maxAtrPct = StringToDouble(val); return true; }
    if (key == "InpMaxBollDeviation")      { maxBollDeviation = StringToDouble(val); return true; }
    if (key == "InpMartinBreakevenProfit") { martinBreakevenProfit = StringToDouble(val); return true; }
    if (key == "InpLogicalBreakeven")      { logicalBreakevenEnabled = ParseBoolValue(val); return true; }
    if (key == "InpBreakevenResetLadder")  { breakevenResetLadderEnabled = ParseBoolValue(val); return true; }
    if (key == "InpNewsFilterEnabled")     { newsFilterEnabled = ParseBoolValue(val); return true; }
    if (key == "InpNewsBeforeMinutes")     { newsBeforeMinutes = (int)StringToInteger(val); return true; }
    if (key == "InpNewsAfterMinutes")      { newsAfterMinutes = (int)StringToInteger(val); return true; }
    if (key == "InpNewsHighImportance")    { newsHighImportance = ParseBoolValue(val); return true; }
    if (key == "InpNewsMediumImportance")  { newsMediumImportance = ParseBoolValue(val); return true; }
    if (key == "InpMagicNumber")           { MAGIC_NUMBER = (int)StringToInteger(val); return true; }
    return false;
  }

// Read GMarket_config.set (written by MCP) and apply overrides.
// If forceApply=false, skip when file mtime hasn't advanced since last apply.
// Returns true if any overrides were applied.
bool ReloadRuntimeConfig(bool forceApply)
  {
    string filename = "GMarket_config.set";
    if (!FileIsExist(filename)) return false;

    int fh = FileOpen(filename, FILE_READ | FILE_TXT | FILE_ANSI);
    if (fh == INVALID_HANDLE) return false;

    datetime mtime = (datetime)FileGetInteger(fh, FILE_MODIFY_DATE);
    if (!forceApply && mtime > 0 && mtime <= g_lastConfigApplied){
       FileClose(fh);
       return false;
    }

    int applied = 0;
    int unknown = 0;
    while (!FileIsEnding(fh)){
       string line = FileReadString(fh);
       StringTrimLeft(line); StringTrimRight(line);
       if (StringLen(line) == 0) continue;
       if (StringGetCharacter(line, 0) == '#') continue;
       int eq = StringFind(line, "=");
       if (eq <= 0) continue;
       string key = StringSubstr(line, 0, eq);
       string val = StringSubstr(line, eq + 1);
       StringTrimLeft(key); StringTrimRight(key);
       StringTrimLeft(val); StringTrimRight(val);
       if (key == "ts") continue;
       if (ApplyRuntimeOverride(key, val)) applied++;
       else unknown++;
    }
    FileClose(fh);

    if (mtime > 0) g_lastConfigApplied = mtime;
    if (applied > 0 || unknown > 0){
       PrintFormat("ReloadRuntimeConfig: %d applied, %d unknown (mtime=%s)",
                   applied, unknown, TimeToString(mtime, TIME_DATE | TIME_SECONDS));
    }
    if (applied > 0) UpdateButtonState();
    return applied > 0;
  }

// Watch GMarket_reload.trigger (contains a timestamp). When it advances, force
// a chart reinit so OnInit fires and picks up a freshly compiled .ex5.
bool CheckReloadTrigger()
  {
    string filename = "GMarket_reload.trigger";
    if (!FileIsExist(filename)) return false;
    int fh = FileOpen(filename, FILE_READ | FILE_TXT | FILE_ANSI);
    if (fh == INVALID_HANDLE) return false;
    string content = "";
    if (!FileIsEnding(fh)) content = FileReadString(fh);
    FileClose(fh);
    StringTrimLeft(content); StringTrimRight(content);
    if (StringLen(content) == 0) return false;
    datetime ts = (datetime)StringToInteger(content);
    if (ts <= 0) return false;
    if (g_lastReloadTrigger == 0){
       g_lastReloadTrigger = ts;  // prime on first observation, don't fire
       return false;
    }
    if (ts > g_lastReloadTrigger){
       g_lastReloadTrigger = ts;
       return true;
    }
    return false;
  }

// Dump current runtime parameter values to MQL5/Files/GMarket_runtime.json
// so MCP can read the true runtime values (post-override).
void DumpInputsRuntime()
  {
    string filename = "GMarket_runtime.json";
    int fh = FileOpen(filename, FILE_WRITE | FILE_TXT | FILE_ANSI);
    if (fh == INVALID_HANDLE){
       PrintFormat("DumpInputsRuntime: FileOpen failed, err=%d", GetLastError());
       return;
    }
    string ts = TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS);
    string cfgTs = (g_lastConfigApplied > 0
                    ? TimeToString(g_lastConfigApplied, TIME_DATE | TIME_SECONDS)
                    : "");
    string json = "{\n";
    json += "  \"ea_name\": \"GMarket.mq5\",\n";
    json += "  \"symbol\": \"" + _Symbol + "\",\n";
    json += "  \"updated_at\": \"" + ts + "\",\n";
    json += "  \"config_applied_at\": \"" + cfgTs + "\",\n";
    json += "  \"magic_number\": " + IntegerToString(MAGIC_NUMBER) + ",\n";
    json += "  \"params\": {\n";
    json += "    \"InpFirstLots\": "             + DoubleToString(firstLots, 4) + ",\n";
    json += "    \"InpStep\": "                  + DoubleToString(step, 4) + ",\n";
    json += "    \"InpMartinInterval\": "        + DoubleToString(martinInterval, 4) + ",\n";
    json += "    \"InpFilter\": "                + DoubleToString(filter, 4) + ",\n";
    json += "    \"InpOrderTime\": "             + IntegerToString(orderTime) + ",\n";
    json += "    \"InpRetrySeconds\": "          + IntegerToString(retrySeconds) + ",\n";
    json += "    \"InpIsPaused\": "              + (isPaused ? "true" : "false") + ",\n";
    json += "    \"InpMartinEnabled\": "         + (martinEnabled ? "true" : "false") + ",\n";
    json += "    \"InpIgnoreMagicNumber\": "     + (ignoreMagicNumber ? "true" : "false") + ",\n";
    json += "    \"InpMaxLoss\": "               + DoubleToString(maxLoss, 2) + ",\n";
    json += "    \"InpMaxMartinLevel\": "        + IntegerToString(maxMartinLevel) + ",\n";
    json += "    \"InpMaxAtrPct\": "             + DoubleToString(maxAtrPct, 4) + ",\n";
    json += "    \"InpMaxBollDeviation\": "      + DoubleToString(maxBollDeviation, 4) + ",\n";
    json += "    \"InpMartinBreakevenProfit\": " + DoubleToString(martinBreakevenProfit, 2) + ",\n";
    json += "    \"InpLogicalBreakeven\": "      + (logicalBreakevenEnabled ? "true" : "false") + ",\n";
    json += "    \"InpBreakevenResetLadder\": "  + (breakevenResetLadderEnabled ? "true" : "false") + ",\n";
    json += "    \"InpNewsFilterEnabled\": "     + (newsFilterEnabled ? "true" : "false") + ",\n";
    json += "    \"InpNewsBeforeMinutes\": "     + IntegerToString(newsBeforeMinutes) + ",\n";
    json += "    \"InpNewsAfterMinutes\": "      + IntegerToString(newsAfterMinutes) + ",\n";
    json += "    \"InpNewsHighImportance\": "    + (newsHighImportance ? "true" : "false") + ",\n";
    json += "    \"InpNewsMediumImportance\": "  + (newsMediumImportance ? "true" : "false") + ",\n";
    json += "    \"InpMagicNumber\": "           + IntegerToString(MAGIC_NUMBER) + "\n";
    json += "  }\n";
    json += "}\n";
    FileWriteString(fh, json);
    FileClose(fh);
  }

int OnInit()
  {
    SeedRuntimeFromInputs();
    ReloadRuntimeConfig(true);           // always apply overrides on init
    // Prime reload trigger so we don't fire on a stale file immediately after attach.
    CheckReloadTrigger();

    ClearBreakevenTargets();
    breakevenCycleActive = false;
    breakevenResetDone = false;
    breakevenCycleMartinTicket = -1;
    breakevenCycleBaseTicket = -1;
    nextLadderResetAttemptTime = 0;

    DumpInputsRuntime();

    long marginMode = AccountInfoInteger(ACCOUNT_MARGIN_MODE);
    if (marginMode != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING){
       PrintFormat("Init failed: this EA requires a hedging account, current margin mode=%s",
                   GetMarginModeName(marginMode));
       return(INIT_FAILED);
    }

    // 初始化代码
    atrHandle = iATR(_Symbol, PERIOD_H1, 14);
    bandsHandle = iBands(_Symbol, PERIOD_H1, 20, 0, 2.0, PRICE_CLOSE);
    openTime = TimeCurrent() + orderTime;
    UpdateEAStatus();

    // Setup UI
    CreateGUI();
    UpdateGUI();

    EventSetTimer(3);  // poll config + reload trigger every 3s

    printfPro("重新载入");
    return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Timer: poll config.set and reload.trigger                        |
//+------------------------------------------------------------------+
void OnTimer()
  {
    if (ReloadRuntimeConfig(false)){
       DumpInputsRuntime();
       UpdateEAStatus();
       UpdateGUI();
       printfPro("参数已热更新");
    }
    if (CheckReloadTrigger()){
       printfPro("Reload trigger detected: forcing chart reinit");
       ChartSetSymbolPeriod(0, _Symbol, _Period);
    }
  }

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
    EventKillTimer();
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
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
  {
   CheckLogicalBreakeven();
   TryResetLadderBaseIfNeeded();
   AutoReloadIfNeeded();
   UpdateGUI(); // Update UI on every tick

   // Safety Check: Always check max loss first
   if (CheckMaxLoss()) return;

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

    //--- 情况3：订单数量异常（奇数且不是单边缺腿）
    if (totalCount % 2 != 0){
        // 零损/止损导致的临时奇数单：不重置任何状态，等待下一次自然恢复
        printfPro("重载警告：订单数量奇数，跳过重载，buyCount=" + buyCount + ", sellCount=" + sellCount);
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
      if (calcTotalMartinOrdersProfit() >= 0 && closeMartinOrders()){
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
      // 向下爬梯：SELL base亏损达到马丁距离 && BUY base亏损超过滤波器距离（两张base均浮亏）
      if (ladderPrice > 0 && martinBasePrice > 0 &&
          (martinBasePrice - GetAsk()) / martinBasePrice * 100 <= 0 - martinInterval &&
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
      // 向上爬梯：BUY base亏损达到马丁距离 && SELL base亏损超过滤波器距离（两张base均浮亏）
      if (ladderPrice > 0 && martinBasePrice > 0 &&
          (GetBid() - martinBasePrice) / martinBasePrice * 100 <= 0 - martinInterval &&
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
            success = false;
         }
      }
   }
    
   if (!success){
      printfPro("OrderClose failed with error #" + GetLastError());
      return false;
   }

   if (followType == POSITION_TYPE_BUY){
      if (!ClosePositionByTicket(lastSellOrderTick)){
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
      if (!ClosePositionByTicket(lastBuyOrderTick)){
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
      printfPro("Max loss triggered, total floating P/L: " + DoubleToString(totalProfit, 2));
      CloseAllOrders();
      ResetAllStatus();
      return true;
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
    if (!isOpenPosition) return;

    datetime now = TimeCurrent();
    if (now < nextRecoverAttemptTime){
        return;
    }
    bool attempted = false;
    
    // Recovery for Failed Open (Ticket is -1)
    if (lastBuyOrderTick == -1) {
        // Only recover if market is likely open (simple check? or just try)
        // We just try. If it fails again, it logs error and retry next tick.
        printfPro("Missing Buy Leg (Ticket -1). Attempting recovery...");
        lastBuyOrderTick = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy base recovery");
        if(lastBuyOrderTick > 0) printfPro("Buy Leg Recovered: #" + IntegerToString(lastBuyOrderTick));
        attempted = true;
    }

    if (attempted) Sleep(500); // broker anti-scalping: delay before opposite leg
    if (lastSellOrderTick == -1) {
        printfPro("Missing Sell Leg (Ticket -1). Attempting recovery...");
        lastSellOrderTick = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell base recovery");
        if(lastSellOrderTick > 0) printfPro("Sell Leg Recovered: #" + IntegerToString(lastSellOrderTick));
        attempted = true;
    }

    if (attempted){
        nextRecoverAttemptTime = now + RECOVER_MIN_INTERVAL;
    }
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
   ChartRedraw(); // force immediate repaint so MCP-driven color changes show without needing a tick
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
