
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


// 输入参数
input double firstLots = 0.01; // 起手大小
input double step = 0.8; //梯级（百分比）
input double martinInterval = 1.2; //马丁最小矩离（百分比）
input double filter = 0.1; //虑波器（百分比）
input int orderTime = 0; //开单间隔（秒）
input int retrySeconds = 1800; //重试间隔（秒）
input bool InpIsPaused = false; // 暂停策略执行
input bool InpMartinEnabled = true; //马丁开关
input bool InpIgnoreMagicNumber = true; //是否忽略魔术数（手操计入）
input double maxLoss = 3000; //最大浮亏
input int maxMartinLevel = 3; //最大马丁层数
input double maxAtrPct = 1.5; //允许马丁的最大ATR 百分比
input double maxBollDeviation = 2.0; //允许马丁的最大布林带偏离
input bool InpNewsFilterEnabled = true; // 允许马丁的新闻过滤开关
input int InpNewsBeforeMinutes = 60; // 新闻前暂停分钟数
input int InpNewsAfterMinutes = 60; // 新闻后暂停分钟数
input bool InpNewsHighImportance = true; // 过滤高重要性新闻
input bool InpNewsMediumImportance = false; // 过滤中重要性新闻

input int MAGIC_NUMBER = 999; //魔术数

// Global control variables
bool isPaused;
bool martinEnabled;
bool ignoreMagicNumber;
bool newsFilterEnabled;


// UI Constants
#define UI_PREFIX "GM_UI_"
#define COLOR_BG clrBlack
#define COLOR_TEXT clrWhite
#define COLOR_BTN_ON clrGreen
#define COLOR_BTN_OFF clrRed

bool isOpenPosition = false;//是否已经新一轮开仓了
long lastBuyOrderTick = -1;//最后开的buy单
long lastSellOrderTick = -1;//最后开的sell单
long lastMartinOrderTick = -1;//最后开的马丁单
bool isFollow = false; //是否正在追踪开仓
int followType = -1;//梯级方向
datetime openTime = 0;
long martinOrders[20];//马丁单
int seek = 0;//马丁单的水位
bool running = true;
string martinPauseReason = "";

int atrHandle = INVALID_HANDLE;
int bandsHandle = INVALID_HANDLE;
int slippagePoints = 200;

double GetBid()
{
   return SymbolInfoDouble(_Symbol, SYMBOL_BID);
}

double GetAsk()
{
   return SymbolInfoDouble(_Symbol, SYMBOL_ASK);
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
   request.type_filling = ORDER_FILLING_IOC;

   if (!OrderSend(request, result) || result.retcode != TRADE_RETCODE_DONE){
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
   request.type_filling = ORDER_FILLING_IOC;

   if (!OrderSend(request, result) || result.retcode != TRADE_RETCODE_DONE){
      return false;
   }
   return true;
}


//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
    // Initialize globals from inputs
    isPaused = InpIsPaused;
    martinEnabled = InpMartinEnabled;
    ignoreMagicNumber = InpIgnoreMagicNumber;
    newsFilterEnabled = InpNewsFilterEnabled;

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
    // 清理代码
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

    // Hedge entry
    if(isFollow) {
        lastBuyOrderTick = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy first order");
        lastSellOrderTick = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell first order");
        if (lastBuyOrderTick < 0 || lastSellOrderTick < 0) {
            int err = GetLastError();
            if (lastBuyOrderTick > 0) {
               ClosePositionByTicket(lastBuyOrderTick);
            }
            if (lastSellOrderTick > 0) {
               ClosePositionByTicket(lastSellOrderTick);
            }
            isFollow = false;
           int retryDelay = retrySeconds > 0 ? retrySeconds : 1800;
           openTime = TimeCurrent() + retryDelay;
           printfPro("OrderSend failed with error #" + err + ", retry in " + retryDelay + "s");
           return;
       } else {
           printfPro("Hedge orders opened");
           isOpenPosition = true;
           isFollow = false;
           followType = -1;
       }
   }

   
  }


//+------------------------------------------------------------------+
//| 更新Ea状态                                               |
//+------------------------------------------------------------------+
void UpdateEAStatus(){

    // 1. 收集所有相关订单
    long buyTickets[20];      // BUY 订单票号
    double buyPrices[20];    // BUY 订单价格
    double buyLots[20];      // BUY 订单手数
    int buyCount = 0;

    long sellTickets[20];     // SELL 订单票号
    double sellPrices[20];   // SELL 订单价格
    double sellLots[20];     // SELL 订单手数
    int sellCount = 0;

    // 遍历所有订单，分类收集
    for (int i = PositionsTotal() - 1; i >= 0; i--){
        long ticket = -1;
        if (SelectPositionByIndex(i, ticket) &&
            IsTrackedPosition()){

            int posType = (int)PositionGetInteger(POSITION_TYPE);
            if (posType == POSITION_TYPE_BUY && buyCount < 20){
                buyTickets[buyCount] = ticket;
                buyPrices[buyCount] = PositionGetDouble(POSITION_PRICE_OPEN);
                buyLots[buyCount] = PositionGetDouble(POSITION_VOLUME);
                buyCount++;
            }
            else if (posType == POSITION_TYPE_SELL && sellCount < 20){
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

    //--- 情况2：订单数量异常（奇数或不符合预期）
    if (totalCount % 2 != 0 || buyCount == 0 || sellCount == 0){
        isOpenPosition = true;
        running = false;
        printfPro("重载异常：订单数量不符合预期，buyCount=" + buyCount + ", sellCount=" + sellCount);
        return;
    }

    //--- 情况3：只有基础对冲单 (1买1卖)
    if (buyCount == 1 && sellCount == 1){
        isOpenPosition = true;
        isFollow = false;
        followType = -1;
        seek = 0;
        lastBuyOrderTick = buyTickets[0];
        lastSellOrderTick = sellTickets[0];
        lastMartinOrderTick = -1;
        running = true;
        printfPro("重载：基础对冲单已恢复");
        return;
    }

    //--- 情况4：有马丁加仓单
    isOpenPosition = true;
    isFollow = false;
    running = true;

    // 判断马丁方向：哪边订单多，哪边就是马丁方向的反向
    // 例如：BUY单多，说明价格下跌，在做多马丁，followType = POSITION_TYPE_BUY
    if (buyCount > sellCount){
        followType = POSITION_TYPE_BUY;
        RestoreMartinStatus_Buy(buyTickets, buyPrices, buyLots, buyCount,
                                sellTickets, sellPrices, sellLots, sellCount);
    }
    else if (sellCount > buyCount){
        followType = POSITION_TYPE_SELL;
        RestoreMartinStatus_Sell(buyTickets, buyPrices, buyLots, buyCount,
                                 sellTickets, sellPrices, sellLots, sellCount);
    }
    else {
        // buyCount == sellCount 但都大于1，异常情况
        running = false;
        printfPro("重载异常：买卖单数量相等但大于1");
    }

    // 绘制成本线
    if (seek > 0){
        ObjectDelete(0, "MartinLine");
        ObjectCreate(0, "MartinLine", OBJ_HLINE, 0, 0, CalculateMartinOrdersTotalCost());
    }
}
void ResetAllStatus(){
    isOpenPosition = false;
    lastBuyOrderTick = -1;
    lastSellOrderTick = -1;
    lastMartinOrderTick = -1;
    isFollow = false;
    followType = -1;
    openTime = TimeCurrent() + orderTime;
    seek = 0;
    running = true;

    // 清空马丁订单数组
    for (int i = 0; i < 20; i++){
        martinOrders[i] = -1;
    }
}
void RestoreMartinStatus_Buy(long &buyTickets[], double &buyPrices[], double &buyLots[], int buyCount,
                              long &sellTickets[], double &sellPrices[], double &sellLots[], int sellCount){

    // 1. 识别 SELL 端的 base order（应该只有1个）
    lastSellOrderTick = sellTickets[0];

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

    for (int i = 0; i < buyCount; i++){
        if (buyLots[i] == firstLots){
            // firstLots 单：找价格最高的作为 base buy
            if (buyPrices[i] > baseBuyPrice){
                // 如果之前有 base，把它加入马丁数组
                if (baseBuyTicket != -1){
                    martinOrders[seek] = baseBuyTicket;
                    seek++;
                }
                baseBuyPrice = buyPrices[i];
                baseBuyTicket = buyTickets[i];
            }
            else {
                // 不是最高价的 firstLots 单，加入马丁数组
                martinOrders[seek] = buyTickets[i];
                seek++;
            }
        }
        else {
            // 非 firstLots 单是马丁单
            martinOrders[seek] = buyTickets[i];
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

    lastBuyOrderTick = baseBuyTicket;
    lastMartinOrderTick = lastMartinTicket;

    printfPro("重载BUY马丁：seek=" + seek +
              ", baseBuy=" + baseBuyTicket +
              ", baseSell=" + lastSellOrderTick +
              ", lastMartin=" + lastMartinTicket);

    // 打印马丁订单详情
    for (int i = 0; i < seek; i++){
        if (SelectPositionByTicket(martinOrders[i])){
            PrintPositionInfo();
        }
    }
}
void RestoreMartinStatus_Sell(long &buyTickets[], double &buyPrices[], double &buyLots[], int buyCount,
                               long &sellTickets[], double &sellPrices[], double &sellLots[], int sellCount){

    // 1. 识别 BUY 端的 base order（应该只有1个）
    lastBuyOrderTick = buyTickets[0];

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

    for (int i = 0; i < sellCount; i++){
        if (sellLots[i] == firstLots){
            // firstLots 单：找价格最低的作为 base sell
            if (sellPrices[i] < baseSellPrice){
                // 如果之前有 base，把它加入马丁数组
                if (baseSellTicket != -1){
                    martinOrders[seek] = baseSellTicket;
                    seek++;
                }
                baseSellPrice = sellPrices[i];
                baseSellTicket = sellTickets[i];
            }
            else {
                // 不是最低价的 firstLots 单，加入马丁数组
                martinOrders[seek] = sellTickets[i];
                seek++;
            }
        }
        else {
            // 非 firstLots 单是马丁单
            martinOrders[seek] = sellTickets[i];
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

    lastSellOrderTick = baseSellTicket;
    lastMartinOrderTick = lastMartinTicket;

    printfPro("重载SELL马丁：seek=" + seek +
              ", baseBuy=" + lastBuyOrderTick +
              ", baseSell=" + baseSellTicket +
              ", lastMartin=" + lastMartinTicket);

    // 打印马丁订单详情
    for (int i = 0; i < seek; i++){
        if (SelectPositionByTicket(martinOrders[i])){
            PrintPositionInfo();
        }
    }
}


//+------------------------------------------------------------------+
//| 检查加仓和止盈条件                                               |
//+------------------------------------------------------------------+
void CheckAddAndTakeProfitConditions() {

   // close martin
   if (followType != -1 && seek > 0 && calcTotalMartinOrdersProfit() >= 0 && closeMartinOrders()){
      followType = -1;
      seek = 0;
      printfPro("close martin");
      // clear martin line
      ObjectDelete(0, "MartinLine");
      return;
   }
 
   if (seek == 0 && followType == POSITION_TYPE_BUY && SelectPositionByTicket(lastSellOrderTick) && PositionGetDouble(POSITION_PROFIT) >= 0){
      followType = -1;
      printfPro("Lower boundary crossed, reset ladder direction");
   }
    
   if (seek == 0 && followType == POSITION_TYPE_SELL && SelectPositionByTicket(lastBuyOrderTick) && PositionGetDouble(POSITION_PROFIT) >= 0){
      followType = -1;
      printfPro("Upper boundary crossed, reset ladder direction");
   }
   
   // ladder up
   if(followType != POSITION_TYPE_SELL && SelectPositionByTicket(lastBuyOrderTick) && (GetBid() - PositionGetDouble(POSITION_PRICE_OPEN)) / PositionGetDouble(POSITION_PRICE_OPEN) * 100 >= step){
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
   else if(followType != POSITION_TYPE_BUY && SelectPositionByTicket(lastSellOrderTick) && (PositionGetDouble(POSITION_PRICE_OPEN) - GetAsk()) / PositionGetDouble(POSITION_PRICE_OPEN) * 100 >= step){
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
   
   // sell martin
   else if (followType == POSITION_TYPE_BUY){
      double buyOpenPrice = 0;
      double sellOpenPrice = 0;
      if (SelectPositionByTicket(lastBuyOrderTick)){
         buyOpenPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      }
      if (SelectPositionByTicket(lastSellOrderTick)){
         sellOpenPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      }
      if (buyOpenPrice > 0 && sellOpenPrice > 0 &&
          (GetBid() - buyOpenPrice) / buyOpenPrice * 100 <= 0 - filter &&
          (sellOpenPrice - GetAsk()) / sellOpenPrice * 100 <= 0 - martinInterval){
               
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

         if (seek >= ArraySize(martinOrders)){
            running = false;
            printfPro("Martin order buffer full");
            return;
         }
         martinOrders[seek] = lastSellOrderTick;
         seek ++;
         // add tracking order
         lastSellOrderTick = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell base");
         if (lastSellOrderTick == -1){
            printfPro("Sell martin base failed #" + GetLastError());
            return;
         }

         if (maxMartinLevel > 0 && seek >= maxMartinLevel){
            printfPro("Reached max martin level: " + maxMartinLevel);
            return;
         }

         // add martin order
         double martinLots = 0;
         if (SelectPositionByTicket(lastMartinOrderTick)){
            double lastLots = PositionGetDouble(POSITION_VOLUME);
            if (seek > 1){
               martinLots = (lastLots + firstLots) * 2;
            }else {
               martinLots = lastLots * 2;
            }
         }
         if (martinLots <= 0){
            martinLots = firstLots * 2;
         }
         lastMartinOrderTick = SendMarketOrder(ORDER_TYPE_SELL, martinLots, "Sell martin");
         if (lastMartinOrderTick != -1){
            if (seek >= ArraySize(martinOrders)){
               running = false;
               printfPro("Martin order buffer full");
               return;
            }
            martinOrders[seek] = lastMartinOrderTick;
            seek ++;
            printfPro("Sell martin");
            
            // draw line
            ObjectDelete(0, "MartinLine");
            ObjectCreate(0, "MartinLine", OBJ_HLINE, 0, 0, CalculateMartinOrdersTotalCost());
         }else {
            printfPro("Sell martin order failed #" + GetLastError());
         }
      }
   }
   
   // buy martin
   else if (followType == POSITION_TYPE_SELL){
      double buyOpenPrice2 = 0;
      double sellOpenPrice2 = 0;
      if (SelectPositionByTicket(lastSellOrderTick)){
         sellOpenPrice2 = PositionGetDouble(POSITION_PRICE_OPEN);
      }
      if (SelectPositionByTicket(lastBuyOrderTick)){
         buyOpenPrice2 = PositionGetDouble(POSITION_PRICE_OPEN);
      }
      if (sellOpenPrice2 > 0 && buyOpenPrice2 > 0 &&
          (sellOpenPrice2 - GetAsk()) / sellOpenPrice2 * 100 <= 0 - filter &&
          (GetBid() - buyOpenPrice2) / buyOpenPrice2 * 100 <= 0 - martinInterval){

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

         if (seek >= ArraySize(martinOrders)){
            running = false;
            printfPro("Martin order buffer full");
            return;
         }
         martinOrders[seek] = lastBuyOrderTick;
         seek ++;
               
         // add tracking order
         lastBuyOrderTick = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy base");
         if (lastBuyOrderTick == -1){
            printfPro("Buy martin base failed #" + GetLastError());
            return;
         }

         if (maxMartinLevel > 0 && seek >= maxMartinLevel){
            printfPro("Reached max martin level: " + maxMartinLevel);
            return;
         }

         // add martin order
         double martinLots2 = 0;
         if (SelectPositionByTicket(lastMartinOrderTick)){
            double lastLots2 = PositionGetDouble(POSITION_VOLUME);
            if (seek > 1){
               martinLots2 = (lastLots2 + firstLots) * 2;
            }else {
               martinLots2 = lastLots2 * 2;
            }
         }
         if (martinLots2 <= 0){
            martinLots2 = firstLots * 2;
         }
         lastMartinOrderTick = SendMarketOrder(ORDER_TYPE_BUY, martinLots2, "Buy martin");
         if (lastMartinOrderTick != -1){
            if (seek >= ArraySize(martinOrders)){
               running = false;
               printfPro("Martin order buffer full");
               return;
            }
            martinOrders[seek] = lastMartinOrderTick;
            seek ++;
            printfPro("Buy martin");
            
            // draw line
            ObjectDelete(0, "MartinLine");
            ObjectCreate(0, "MartinLine", OBJ_HLINE, 0, 0, CalculateMartinOrdersTotalCost());
   
         }else {
            printfPro("Buy martin order failed #" + GetLastError());
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
   for (int i= 0; i < seek; i ++) 
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
   for (int j = 0; j < 20; j++){
      martinOrders[j] = -1;
   }
   return success;
}


//计算马丁的综合成本                                           
double CalculateMartinOrdersTotalCost() {
    double totalCost = 0.0;
    double totalLots = 0.0;

    // 遍历所有订单
    for(int i = 0; i < seek; i++) {
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
   for (int i= 0; i < seek; i ++) 
   {
         if (martinOrders[i] != -1 && SelectPositionByTicket(martinOrders[i])){
            profit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
         }
   }

   if (followType == POSITION_TYPE_BUY && SelectPositionByTicket(lastSellOrderTick)){
      profit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
   }else if (followType == POSITION_TYPE_SELL && SelectPositionByTicket(lastBuyOrderTick)){
      profit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
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
   datetime start = now - InpNewsAfterMinutes * 60;
   datetime end = now + InpNewsBeforeMinutes * 60;
   
   MqlCalendarValue values[];
   
   if(CalendarValueHistory(values, start, end, NULL, NULL)) {
      for(int i=0; i<ArraySize(values); i++) {
         MqlCalendarEvent event;
         if(CalendarEventById(values[i].event_id, event)) {
             
             bool importanceMatch = false;
             if(InpNewsHighImportance && event.importance == CALENDAR_IMPORTANCE_HIGH) importanceMatch = true;
             if(InpNewsMediumImportance && event.importance == CALENDAR_IMPORTANCE_MODERATE) importanceMatch = true;
             
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
    
    // Recovery for Failed Open (Ticket is -1)
    if (lastBuyOrderTick == -1) {
        // Only recover if market is likely open (simple check? or just try)
        // We just try. If it fails again, it logs error and retry next tick.
        printfPro("Missing Buy Leg (Ticket -1). Attempting recovery...");
        lastBuyOrderTick = SendMarketOrder(ORDER_TYPE_BUY, firstLots, "Buy base recovery");
        if(lastBuyOrderTick > 0) printfPro("Buy Leg Recovered: #" + IntegerToString(lastBuyOrderTick));
    }
    
    if (lastSellOrderTick == -1) {
        printfPro("Missing Sell Leg (Ticket -1). Attempting recovery...");
        lastSellOrderTick = SendMarketOrder(ORDER_TYPE_SELL, firstLots, "Sell base recovery");
        if(lastSellOrderTick > 0) printfPro("Sell Leg Recovered: #" + IntegerToString(lastSellOrderTick));
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
         UpdateEAStatus();
         ObjectSetInteger(0, sparam, OBJPROP_STATE, false); // Reset button state to unpressed
         ChartRedraw();
      }
   }
}

void CreateGUI()
{
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
   SetButtonState("BtnReload", "Reload EA State", clrGray); // Stateless button
   SetButtonState("BtnPause", isPaused ? "Resume Strategy" : "Pause Strategy", isPaused ? COLOR_BTN_OFF : COLOR_BTN_ON);
   SetButtonState("BtnMartin", martinEnabled ? "Martin ON" : "Martin OFF", martinEnabled ? COLOR_BTN_ON : COLOR_BTN_OFF);
   SetButtonState("BtnMagic", ignoreMagicNumber ? "Ignore Magic: ON" : "Ignore Magic: OFF", ignoreMagicNumber ? COLOR_BTN_ON : clrGray);
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
