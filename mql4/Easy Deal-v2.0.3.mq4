//+------------------------------------------------------------------+
//|                                             TestBreakThrouth.mq5 |
//|                                            Copyright 2022,xszyou |
//|                                           https://www.yaheen.com |
//+------------------------------------------------------------------+


#property copyright "Copyright 2022,xszyou"
#property link      "https://www.yaheen.com"
#property version   "2022.11.08 v2.0.3"
#property strict

#property description " v2.0.3"
#property description "1、还原基本逻辑不循环不锁浮亏;"

#property description " v2.0.2"
#property description "1、修复达到条件不锁浮亏的bug;"

#property description " v2.0.1"
#property description "1、增大落差，降低区间增长幅度;"
#property description "2、到达浮亏或者指定单数开对冲单锁定浮亏;"
#property description "3、优化日志系统;"

#property description " v2.0.0"
#property description "1、改用3轮循环制，用盈利区间换风险;"
#property description "2、增加最大开单数参数，到达后不再开单"


//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
input string set_auto = "============【自动交易】============";//=========【自动交易】========
input int set0 = 555; //ea编号
input int set1 = 10000;//多少金额购买0.01手
input double set2 = 2.3;//开单区间（元）
input double set3 = 1.3;//追踪止赢金额(元)
input double set4 = 1.3;//到达赢利点区间（元）
input double set5 = 0.5; //回撤多少平仓
input int set6 = 6;//最大开单数
input bool set9 = false;//结束后不再开新单

int ma = 0;
int time = 30;//开单间隔
input int forceClosePrice = 100000;//浮亏多少强平
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

   printfPro("init");
   ma = set0;
   printfPro("orders:");
   for(int i=0;i<OrdersTotal();i++)
     {
      if(OrderSelect(i, SELECT_BY_POS) && OrderMagicNumber() == ma)
        {
         OrderPrint();
        }
     }
   printfPro("OrdersTotal:" + calcEaOrder("all", ma) + ",profit:" + calcTotalProfit(0, "all", ma));
   
   printfPro("ma:" + ma);
   topBorder = 0;//上边界
   bottomBorder = 0;//下边界
   orderCount = 0;//订单数量 
   lastOrderOperator = OP_BUY;//最后的订单操作
   followPrice = 0;
   follow = false;
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

      
   //浮亏过高强平
   if(calcTotalProfit(0, "all", ma) < (0 - forceClosePrice))
     {
      closeAll();
      printfPro("浮亏强平");
     }
   
   //更新追踪
   if(orderCount != calcEaOrder("all", ma))
     {
      orderCount = calcEaOrder("all", ma);
      if(orderCount > 0 && EDOrderSelect(orderCount - 1, ma))
        {
         topBorder = OrderOpenPrice();//上边界
         bottomBorder = OrderOpenPrice();//下边界
         lastOrderOperator = OrderType();//最后的订单操作
        }else
           {
              topBorder = 0;//上边界
              bottomBorder = 0;//下边界
           }
      
      followPrice = 0;
      follow = false;
      printfPro("重新开始追踪");
     }
     
     mulriple = AccountBalance() / set1 < 1 ? 1 : AccountBalance() / set1;
   
   if(topBorder == 0)
     {
      topBorder = Ask;
     }
   if(bottomBorder == 0)
     {
      bottomBorder = Bid;
     }
     
   //开首单，隔开时间，防止几个窗口的ea同时开首单
   if(orderCount == 0)
     {
      if(Ask > topBorder + 0.3 && !set9 && (OrdersTotal() == 0 || (OrderSelect(OrdersTotal() - 1, SELECT_BY_POS) && TimeCurrent() > OrderOpenTime() + 60)))
        {
         if(buy(0.01 * mulriple, OrdersTotal() + ":" + ma + "" + (orderCount + 1), Ask, ma))
           {
            orderCount ++;
            topBorder = Ask;
            lastOrderOperator = OP_BUY;
            printfPro("开仓buy：" + 0.01 * mulriple);
            nextOrderTime = (long)TimeCurrent() + time;
           }
        }
      if(Bid < bottomBorder - 0.3 && !set9 && (OrdersTotal() == 0 || (OrderSelect(OrdersTotal() - 1, SELECT_BY_POS) && TimeCurrent() > OrderOpenTime() + 60)))
        {
         if(sell(0.01 * mulriple, OrdersTotal() + ":" + ma + "" + (orderCount + 1), Bid, ma))
           {
            orderCount ++;
            bottomBorder = Bid;
            lastOrderOperator = OP_SELL;
            printfPro("开仓sell：" + 0.01 * mulriple);
            nextOrderTime = (long)TimeCurrent() + time;
           }
        }
     }
     
   //加仓或移动止盈
   if(lastOrderOperator == OP_BUY && orderCount > 0)
     {
       if(Bid < topBorder - set2)
         {
          if(orderCount < set6 )
            {
             //反向加仓
             double p = MarketInfo(Symbol(), MODE_TICKVALUE) * (set4 / Point);//1手到达计算盈利追踪线盈利多少
             double profix = calcTotalProfit((0 - set4 - (Ask - Bid))/Point, "all", ma);//计算到达盈利追踪线浮亏多少
             double lots = NormalizeDouble((MathAbs(profix) + set3 * mulriple) / p, 2);
             printfPro("准备加仓sell:" + lots);
             if(sell(lots, OrdersTotal() + ":" + ma + "" +  (orderCount + 1), Bid, ma))
               {
                printfPro("成功加仓sell:" + lots);
                bottomBorder = Bid;
                orderCount ++;
                lastOrderOperator = OP_SELL;
                nextOrderTime = (long)TimeCurrent() + time;
               
               }
            }
          
         }
         
      
       //移动止盈
       if(follow == false && calcTotalProfit(0, "all", ma) >= set3  * mulriple)
         {
          follow = true;
          followPrice = calcTotalProfit(0, "all", ma);
          printfPro("追踪平仓:" + followPrice);
         }
       if(follow == true)
         {
          followPrice = followPrice < calcTotalProfit(0, "all", ma) ? calcTotalProfit(0, "all", ma) : followPrice;
         }
       if(follow == true && followPrice - calcTotalProfit(0, "all", ma) >= set5  * mulriple)
         {
           double temp = calcTotalProfit(0, "all", ma);
           if(closeAll())
             {
              printfPro("盈利平仓:" + temp);
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
           if(orderCount < set6)
             {
              //反向加仓
                double p = MarketInfo(Symbol(), MODE_TICKVALUE) * (set4 / Point);//1手到达计算盈利追踪线盈利多少
                double profix = calcTotalProfit((0 + set4 + (Ask - Bid))/Point, "all", ma);//计算到达盈利追踪线浮亏多少
                double lots = NormalizeDouble((MathAbs(profix) + set3 * mulriple) / p, 2);
                printfPro("准备加仓buy:" + lots);
                if(buy(lots, OrdersTotal() + ":" + ma + "" +  (orderCount + 1), Ask, ma))
                  {
                   printfPro("成功加仓buy:" + lots);
                   topBorder = Ask;
                   orderCount ++;
                   lastOrderOperator = OP_BUY;
                   nextOrderTime = (long)TimeCurrent() + time;
                  }
             }
              
          
         }
         
       
       //移动止盈
       if(follow == false && calcTotalProfit(0, "all", ma) >= set3 * mulriple)
         {
          follow = true;
          followPrice = calcTotalProfit(0, "all", ma);
          printfPro("追踪平仓:" + followPrice);
         }
       if(follow == true)
         {
          followPrice = followPrice < calcTotalProfit(0, "all", ma) ? calcTotalProfit(0, "all", ma) : followPrice;
         }
       if(follow == true && followPrice - calcTotalProfit(0, "all", ma) >= set5 * mulriple)
         {
           double temp = calcTotalProfit(0, "all", ma);
           if(closeAll())
             {
              printfPro("盈利平仓:" + temp);
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
bool buy(double lots, string comment, double price, int magic)
{
   return OrderSend(Symbol(),OP_BUY,lots,MarketInfo(Symbol(),MODE_ASK),0,0,0,"(" + magic + ")" + comment,magic,0,clrRed);
}

//买入空单
bool sell(double lots, string comment, double price, int magic)
{
   return OrderSend(Symbol(),OP_SELL,lots,MarketInfo(Symbol(),MODE_BID),0,0,0,"(" + magic + ")" + comment,magic,0,clrRed);
}

//计算EA总盈亏
double calcTotalProfit(double point, string type, int ma )
{
   double b_profit = 0;
   double s_profit = 0;
   for (int i= OrdersTotal() - 1; i >= 0; i--) 
   {
         if(OrderSelect(i,SELECT_BY_POS,MODE_TRADES)==true)
             {
                  
                  if( ma != 0 && OrderMagicNumber()==ma && OrderSymbol()==Symbol() )
                     {
                             
                          if(OrderType()==OP_BUY)
                             {
                               b_profit+=OrderProfit()+(MarketInfo(Symbol(), MODE_TICKVALUE)*point*OrderLots())+OrderCommission()+OrderSwap(); //多盈亏                           
                             }     

                          if(OrderType()==OP_SELL)
                             {
                               s_profit+=OrderProfit()-(MarketInfo(Symbol(), MODE_TICKVALUE)*point*OrderLots())+OrderCommission()+OrderSwap(); //空盈亏                                                                        
                             }       
                                                                    
                      } 
               }
     }
     if(type == "sell")
       {
        return s_profit;
       }
     if(type == "buy")
       {
        return b_profit;
       }
     //printfPro("浮盈：" + (b_profit + s_profit));
     return b_profit + s_profit; 
}



bool closeAll()
  {
   
   Close_All_Order_DeadLine(Symbol(),"EA","BS",ma);
   return true;
  }
//+------------------------------------------------------------------+

//计算EA的订单数量
int calcEaOrder(string op, int ma)
{
   int total = 0;
   for (int i= OrdersTotal() - 1; i >= 0; i--) 
   {
         if(OrderSelect(i,SELECT_BY_POS,MODE_TRADES)==true)
             {
                  if( OrderMagicNumber() == ma && OrderSymbol() == Symbol() )
                     {
                        
                        if(op == "all")
                          {
                           total ++;   
                          }
                         if(op == "buy" && OrderType()==OP_BUY)
                           {
                            total ++;   
                           }
                          if(op == "sell" && OrderType()==OP_SELL)
                            {
                             total ++;   
                            } 
                         
                             
                                                                    
                      } 
               }
     }
     return total;
}



 //========所有单===================================================从神经刀偷过来
void Close_All_Order_DeadLine (string symbol,string CountType,string Order_Type,int MaMa)
{
          for(int i=OrdersTotal()-1;i>=0;i--)
            {
               if(OrderSelect(i,SELECT_BY_POS,MODE_TRADES)==true)
                 {
                       if(symbol=="ALL" )//统计仓库所有货币 && 所有开单时间不能大于截止时间
                         {
                               if(CountType=="ALL")//EA及手工单  (不再筛选了 直接统计)
                                   {
                                           Close_Order(Order_Type); 
                                   }
                                   
                               if(CountType=="EA")//EA单
                                   {
                                       if( OrderMagicNumber()==MaMa )    
                                          {
                                           Close_Order(Order_Type);                          
                                          }                             
                                   }
                                   
                               if(CountType=="HAND")//手工单
                                   {
                                       if( OrderMagicNumber()==0 )    
                                          {
                                           Close_Order(Order_Type);                          
                                          }                             
                                   }  
                                   
                               if(CountType=="EA_HAND")//手工单
                                   {
                                       if( OrderMagicNumber()==0 || OrderMagicNumber()==MaMa )    
                                          {
                                           Close_Order(Order_Type);                          
                                          }                             
                                   }                                          
                         }
         //==================================================================================                
                       if(symbol!="ALL" && symbol==OrderSymbol() )//只统计指定货币 && 所有开单时间不能大于截止时间
                         {
                         
                               if(CountType=="ALL")//EA及手工单  (不再筛选了 直接统计)
                                   {
                                           Close_Order(Order_Type); 
                                   }
                                   
                               if(CountType=="EA")//EA单
                                   {
                                       
                                       if( OrderMagicNumber()==MaMa )    
                                          {
                                           Close_Order(Order_Type);                         
                                          }                             
                                   }
                                   
                               if(CountType=="HAND")//手工单
                                   {
                                       if( OrderMagicNumber()==0 )    
                                          {
                                           Close_Order(Order_Type);    
                                          }                       
                                   }   
                                   
                               if(CountType=="EA_HAND")//手工单
                                   {
                                       if( OrderMagicNumber()==0 || OrderMagicNumber()==MaMa )    
                                          {
                                           Close_Order(Order_Type);                         
                                          }                             
                                   }                                           
                          
                         }  
         //==================================================================================            
                 }
            }//for end
}//void End

void Close_Order(string type)
{
   if(type=="LS_ALL")//删除挂单
     {   
         if(OrderType()>=2)
           {
             OrderDelete(OrderTicket());
           }             
     }  
     
   if(type=="B")
     {
         if(OrderType()==OP_BUY )                             
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300,clrYellow);
           }     
     }
     
   if(type=="S")
     {
         if(OrderType()==OP_SELL)
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300,clrYellow);
           }     
     } 
     
   if(type=="B_ALL")
     {
         if(OrderType()==OP_BUY )                             
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300);
           }   
         if(OrderType()==OP_BUYSTOP || OrderType()==OP_BUYLIMIT )
           {
             OrderDelete(OrderTicket());
           }               
     }
     
   if(type=="S_ALL")
     {
         if(OrderType()==OP_SELL)
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300);
           }   
         if(OrderType()==OP_SELLSTOP || OrderType()==OP_SELLLIMIT )
           {
             OrderDelete(OrderTicket());
           }               
     } 
          
   if(type=="BS")
     {
         if(OrderType()==OP_BUY )                             
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300,clrYellow);
           }  
           
         if(OrderType()==OP_SELL)
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300,clrYellow);
           }                           
     }
       
   if(type=="ALL")
     {
         if(OrderType()==OP_BUY )                             
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300);
           }  
           
         if(OrderType()==OP_SELL)
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300);
           }    
           
         if(OrderType()>1)
           {
             OrderDelete(OrderTicket());
           }                          
     }
//===========================================================[WIN]============     
   if(type=="B_B_Stop")
     {
         if(OrderType()==OP_BUY )                             
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300);
           }     
         if(OrderType()==OP_BUYSTOP)
           {
             OrderDelete(OrderTicket());
           }             
     }    
     
   if(type=="B_Stop")
     {   
         if(OrderType()==OP_BUYSTOP)
           {
             OrderDelete(OrderTicket());
           }             
     }      
     
   if(type=="S_S_Stop")
     {
         if(OrderType()==OP_SELL)
           {
             OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300);
           }     
         if(OrderType()==OP_SELLSTOP)
           {
             OrderDelete(OrderTicket());
           }             
     }    
     
   if(type=="S_Stop")
     {  
         if(OrderType()==OP_SELLSTOP)
           {
             OrderDelete(OrderTicket());
           }             
     }  
     
   if(type=="B_Limit")
     {  
         if(OrderType()==OP_BUYLIMIT)
           {
             OrderDelete(OrderTicket());
           }             
     }    
     
   if(type=="S_Limit")
     {  
         if(OrderType()==OP_SELLLIMIT)
           {
             OrderDelete(OrderTicket());
           }             
     }                 
//===========================================================[WIN]============
     if(type=="BS_WIN")//统计Sell and SellStop 
        {
           if(OrderType()==OP_SELL || OrderType()==OP_BUY)
              {
                  if( OrderProfit()+OrderCommission()+OrderSwap()>0 )
                    {
                        if(OrderType()==OP_BUY )                             
                          {
                            OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300);
                          }  
                          
                        if(OrderType()==OP_SELL)
                          {
                            OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300);
                          }                        
                    }
              }                             
        } 
         
     if(type=="B_WIN")//统计Sell and SellStop 
        {
           if(OrderType()==OP_BUY )
              {
                  if( OrderProfit()+OrderCommission()+OrderSwap()>0 )
                    {
                        if(OrderType()==OP_BUY )                             
                          {
                            OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300);
                          }  
                    }
              }                             
        }   
        
     if(type=="S_WIN")//统计Sell and SellStop 
        {
           if(OrderType()==OP_SELL )
              {
                  if( OrderProfit()+OrderCommission()+OrderSwap()>0 )
                    {
                        if(OrderType()==OP_SELL)
                          {
                            OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300);
                          } 
                    }
              }                             
        }       
//===========================================================[LOSS]============
     if(type=="BS_LOSS")//统计Sell and SellStop 
        {
           if(OrderType()==OP_SELL || OrderType()==OP_BUY)
              {
                  if( OrderProfit()+OrderCommission()+OrderSwap()<0 )
                    {
                        if(OrderType()==OP_BUY )                             
                          {
                            OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300);
                          }  
                          
                        if(OrderType()==OP_SELL)
                          {
                            OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300);
                          }                        
                    }
              }                             
        } 
         
     if(type=="B_LOSS")//统计Sell and SellStop 
        {
           if(OrderType()==OP_BUY )
              {
                  if( OrderProfit()+OrderCommission()+OrderSwap()<0 )
                    {
                        if(OrderType()==OP_BUY )                             
                          {
                            OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_BID),300);
                          }  
                    }
              }                             
        }   
        
     if(type=="S_LOSS")//统计Sell and SellStop 
        {
           if(OrderType()==OP_SELL )
              {
                  if( OrderProfit()+OrderCommission()+OrderSwap()<0 )
                    {
                        if(OrderType()==OP_SELL)
                          {
                            OrderClose(OrderTicket(),OrderLots(),MarketInfo(OrderSymbol(),MODE_ASK),300);
                          } 
                    }
              }                             
        }             
}

//计算开单量
double calcTotalLots(string op, int ma)
{
   double lots = 0.00;
   for (int i= OrdersTotal() - 1; i >= 0; i--) 
   {
         if(OrderSelect(i,SELECT_BY_POS,MODE_TRADES)==true)
             {
                  if( OrderMagicNumber() == ma && OrderSymbol()==Symbol() )
                     {
                          
                             
                          if(op == "all")
                            {
                             lots += OrderLots();
                            }
                          if(op == "buy" && OrderType()==OP_BUY)
                             {
                               lots += OrderLots();                           
                             }     

                          if(op == "sell" && OrderType()==OP_SELL)
                             {
                               lots += OrderLots();                                                                        
                             }       
                                                                    
                      } 
               }
     }
     
     return lots;
}

//替换orderselect
bool EDOrderSelect(int index, int ma)
{
   int count = -1;
   for(int i=0;i<OrdersTotal();i++)
     {
      if(OrderSelect(i, SELECT_BY_POS) && OrderMagicNumber() == ma)
        {
         count ++;
        }
      if(count == index)
        {
         return true;
        }
     }
   return false;
}

//日志输出
string afterPrint = "";
void printfPro(string text, bool once = false)
{
   if(!once || text != afterPrint)
     {
      printf("(" + ma + ")" + text);
      afterPrint=text;
     }
}