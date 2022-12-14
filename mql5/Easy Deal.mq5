//+------------------------------------------------------------------+
//|                                             TestBreakThrouth.mq5 |
//|                                            Copyright 2022,xszyou |
//|                                           https://www.yaheen.com |
//+------------------------------------------------------------------+
#include <Trade\Trade.mqh>
CTrade trade;

#property copyright "Copyright 2022,xszyou"
#property link      "https://www.yaheen.com"
#property version   "v1.01"

//---- 声明常量
#define OP_BUY 0           //买 
#define OP_SELL 1          //卖 
#define OP_BUYLIMIT 2      //BUY LIMIT 挂单类型 
#define OP_SELLLIMIT 3     //SELL LIMIT 挂单类型 
#define OP_BUYSTOP 4       //BUY STOP 挂单类型 
#define OP_SELLSTOP 5      //SELL STOP 挂单类型 
//---
#define MODE_OPEN 0
#define MODE_CLOSE 3
#define MODE_VOLUME 4 
#define MODE_REAL_VOLUME 5
#define MODE_TRADES 0
#define MODE_HISTORY 1
#define SELECT_BY_POS 0
#define SELECT_BY_TICKET 1
//---
#define DOUBLE_VALUE 0
#define FLOAT_VALUE 1
#define LONG_VALUE INT_VALUE
//---
#define CHART_BAR 0
#define CHART_CANDLE 1
//---
#define MODE_ASCEND 0
#define MODE_DESCEND 1
//---
#define MODE_LOW 1
#define MODE_HIGH 2
#define MODE_TIME 5
#define MODE_BID 9
#define MODE_ASK 10
#define MODE_POINT 11
#define MODE_DIGITS 12
#define MODE_SPREAD 13
#define MODE_STOPLEVEL 14
#define MODE_LOTSIZE 15
#define MODE_TICKVALUE 16
#define MODE_TICKSIZE 17
#define MODE_SWAPLONG 18
#define MODE_SWAPSHORT 19
#define MODE_STARTING 20
#define MODE_EXPIRATION 21
#define MODE_TRADEALLOWED 22
#define MODE_MINLOT 23
#define MODE_LOTSTEP 24
#define MODE_MAXLOT 25
#define MODE_SWAPTYPE 26
#define MODE_PROFITCALCMODE 27
#define MODE_MARGINCALCMODE 28
#define MODE_MARGININIT 29
#define MODE_MARGINMAINTENANCE 30
#define MODE_MARGINHEDGED 31
#define MODE_MARGINREQUIRED 32
#define MODE_FREEZELEVEL 33
//---
#define EMPTY -1
//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
input int set1 = 10000;//多少金额购买0.01手
input double set2 = 1.5;//开单区间（元）
input double set4 = 0.8;//到达赢利点区间（元）
input double set3 = 0.8;//追踪止赢金额(元)
int time = 30;//开单间隔
input int forceClosePrice = 2000;//浮亏多少强平
double Ask = 0;
double Bid = 0;
double topBorder = 0;//上边界
double bottomBorder = 0;//下边界
int orderCount = 0;//订单数量 
int lastOrderOperator = OP_BUY;//最后的订单操作
double followPrice = 0;
bool follow = false;
long nextOrderTime = 0;
int mulriple = 1;
int OnInit()
  {
//---
   printf("init");
   topBorder = 0;//上边界
   bottomBorder = 0;//下边界
   orderCount = 0;//订单数量 
   lastOrderOperator = OP_BUY;//最后的订单操作
   followPrice = 0;
   follow = false;
   nextOrderTime = TimeCurrent();
   
//---
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
//---
   
  }
//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+

void OnTick()
  {
//---
   MqlTick last_tick;
   SymbolInfoTick(_Symbol,last_tick);
   Ask=last_tick.ask;
   Bid=last_tick.bid;
   
   //浮亏过高强平
   if(calcTotalProfit() < (0 - forceClosePrice))
     {
      closeAll();
      printf("浮亏强平");
     }
   
   //更新追踪
   if(orderCount != PositionsTotal())
     {
      orderCount = PositionsTotal();
      if(orderCount > 0)
        {
         PositionGetTicket(PositionsTotal() - 1);
         topBorder = PositionGetDouble(POSITION_PRICE_OPEN);//上边界
         bottomBorder = PositionGetDouble(POSITION_PRICE_OPEN);//下边界
         lastOrderOperator = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? OP_BUY : OP_SELL;//最后的订单操作
        }else
           {
              topBorder = 0;//上边界
              bottomBorder = 0;//下边界
           }
      
      followPrice = 0;
      follow = false;
      printf("重新开始追踪");
     }
     
     mulriple = AccountInfoDouble(ACCOUNT_BALANCE) / set1 < 1 ? 1 : AccountInfoDouble(ACCOUNT_BALANCE) / set1;
   
   if(topBorder == 0)
     {
      topBorder = Ask;
     }
   if(bottomBorder == 0)
     {
      bottomBorder = Bid;
     }
     
   //开首单
   if(orderCount == 0)
     {
      if(Ask > topBorder + 0.3)
        {
         if(buy(0.01 * mulriple, "开仓buy：" + (orderCount + 1), Ask))
           {
            orderCount ++;
            topBorder = Ask;
            lastOrderOperator = OP_BUY;
            printf("开仓buy：" + 0.01 * mulriple);
            nextOrderTime = (long)TimeCurrent() + time;
           }
        }
      if(Bid < bottomBorder - 0.3)
        {
         if(sell(0.01 * mulriple, "开仓sell：" + (orderCount + 1), Bid))
           {
            orderCount ++;
            bottomBorder = Bid;
            lastOrderOperator = OP_SELL;
            printf("开仓sell：" + 0.01 * mulriple);
            nextOrderTime = (long)TimeCurrent() + time;
           }
        }
     }
     
   //加仓或移动止盈
   if(lastOrderOperator == OP_BUY && orderCount > 0)
     {
       if(Bid < topBorder - set2)
         {
          //反向加仓
          double p = 0;
          OrderCalcProfit(ORDER_TYPE_SELL, Symbol(), 1, Bid, Bid - set4, p);//TODO 计算1手到达盈利线盈利有多少
          double profix = calcTotalProfit(0 - set4);//计算到达盈利线的浮亏
          double lots = NormalizeDouble(MathAbs((profix + set3 * mulriple)/ p)  , 2);
          printf("准备加仓sell:" + lots);
          if(sell(lots, "加仓sell:" + (orderCount + 1), Bid))
            {
             printf("成功加仓sell:" + lots);
             bottomBorder = Bid;
             orderCount ++;
             lastOrderOperator = OP_SELL;
             nextOrderTime = (long)TimeCurrent() + time;
            
            }
         }
         
      
       //移动止盈
       if(follow == false && calcTotalProfit() > set3  * mulriple)
         {
          follow = true;
          followPrice = calcTotalProfit();
          printf("追踪平仓:" + followPrice);
         }
       if(follow == true)
         {
          followPrice = followPrice < calcTotalProfit() ? calcTotalProfit() : followPrice;
         }
       if(follow == true && followPrice - calcTotalProfit() > 0.5  * mulriple)
         {
           double temp = calcTotalProfit();
           if(closeAll())
             {
              printf("盈利平仓:" + temp);
              follow = false;
              followPrice = 0;
              topBorder = 0;
              bottomBorder = 0;
              orderCount = 0; 
              nextOrderTime = (long)TimeCurrent() + time;
             }
          
         }
       
         
       
     }
     
     if(lastOrderOperator == OP_SELL && orderCount > 0)
     {
       if(Ask > bottomBorder + set2)
         {
          //反向加仓
          double p = 0;
          OrderCalcProfit(ORDER_TYPE_BUY, Symbol(), 1, Ask, Ask + set4, p);//TODO 计算1手se2美元盈利多少
          double profix = calcTotalProfit(set4);//TODO 原是set2
          double lots = NormalizeDouble(MathAbs((profix + set3 * mulriple) / p), 2);
          printf("准备加仓buy:" + lots);
          if(buy(lots, "加仓buy:" + (orderCount + 1), Ask))
            {
             printf("成功加仓buy:" + lots);
             topBorder = Ask;
             orderCount ++;
             lastOrderOperator = OP_BUY;
             nextOrderTime = (long)TimeCurrent() + time;
            }
         }
         
       
       //移动止盈
       if(follow == false && calcTotalProfit() > set3 * mulriple)
         {
          follow = true;
          followPrice = calcTotalProfit();
          printf("追踪平仓:" + followPrice);
         }
       if(follow == true)
         {
          followPrice = followPrice < calcTotalProfit() ? calcTotalProfit() : followPrice;
         }
       if(follow == true && followPrice - calcTotalProfit() > 0.5 * mulriple)
         {
           double temp = calcTotalProfit();
           if(closeAll())
             {
              printf("盈利平仓:" + temp);
              follow = false;
              followPrice = 0;
              topBorder = 0;
              bottomBorder = 0;
              orderCount = 0; 
              nextOrderTime = (long)TimeCurrent() + time;
             }
          
         }
       
         
       
     }
   

      
   
  }
//+------------------------------------------------------------------+

//买入多单
bool buy(double lots, string comment, double price, int magic = 555)
{
   MqlTradeRequest request = {};
   MqlTradeResult result = {0};
   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.type = ORDER_TYPE_BUY;
   request.volume = lots;
   request.deviation = 30;//滑点数
   request.price = price;
   //request.sl = 0;
   //request.tp = 0;
   request.comment = comment;
   request.magic = magic;
   return OrderSend(request, result);
}

//买入空单
bool sell(double lots, string comment, double price, int magic = 555)
{
   MqlTradeRequest request = {};
   MqlTradeResult result = {0};
   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.type = ORDER_TYPE_SELL;
   request.volume = lots;
   request.deviation = 30;//滑点数
   request.price = price;
   //request.sl = 0;
   //request.tp = 0;
   request.comment = comment;
   request.magic = magic;
   return OrderSend(request, result);
}

//计算EA总盈亏
double calcTotalProfit(double offsetClosePrice = 0)
{
   double profit = 0;
   for (int i= PositionsTotal() - 1; i >= 0; i--) 
   {
         if(PositionGetTicket(i) != 0 && PositionGetInteger(POSITION_MAGIC) == 555)
             {
                    double p = 0;
                    if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
                      {
                       OrderCalcProfit(ORDER_TYPE_BUY, Symbol(), PositionGetDouble(POSITION_VOLUME), PositionGetDouble(POSITION_PRICE_OPEN), Bid + offsetClosePrice, p);
                      }
                    if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL)
                      {
                       OrderCalcProfit(ORDER_TYPE_SELL, Symbol(), PositionGetDouble(POSITION_VOLUME), PositionGetDouble(POSITION_PRICE_OPEN), Ask + offsetClosePrice, p);
                      }
                    profit += p;    
                                                                        
               }
     }
    
     return profit; 
}



bool closeAll()
  {
   trade.PositionClose(Symbol());
//--- 声明并初始化交易请求和交易请求结果
   MqlTradeRequest request;
   MqlTradeResult  result;
   int total=PositionsTotal(); // 持仓数   
//--- 重做所有持仓


   for(int i=total-1; i>=0; i--)
     {
      ulong  position_ticket=PositionGetTicket(i);                                                           // 持仓价格
      if(!trade.PositionClose(position_ticket))
      {
         
         return false;
      }
        
     }
     return true;
  }
//+------------------------------------------------------------------+

//计算lots
double calcTotalLots(int type)
{

   double sellLots = 0;
   double buyLots = 0;
   for(int i=PositionsTotal() - 1;i>=0;i--)
     {
      ulong  position_ticket=PositionGetTicket(i);
      if(POSITION_TYPE_BUY == PositionGetInteger(POSITION_TYPE))
        {
         buyLots += PositionGetDouble(POSITION_VOLUME);
        }
      if(POSITION_TYPE_SELL == PositionGetInteger(POSITION_TYPE))
        {
         sellLots += PositionGetDouble(POSITION_VOLUME);
        }
       
     }
   if(type == OP_BUY)
     {
      return buyLots;
     }
     
   if(type == OP_SELL)
     {
      return sellLots;
     }
     
   return 0;
   
}