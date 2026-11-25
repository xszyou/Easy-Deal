//+------------------------------------------------------------------+
//|                                                  OrderGuard.mqh  |
//|                                        EasyDeal — OrderGuard P1-A  |
//+------------------------------------------------------------------+
//
// EA 端订单护航库。开仓前调一次 OrderGuard_Check() 拿到放行/拦截/手数调整
// 决策，然后按结果决定是否 OrderSend。
//
// 用法（典型马丁 EA 的 OrderSend 改造）：
//
//   #include <OrderGuard.mqh>
//
//   OrderGuardResult guard = OrderGuard_Check(
//       "GMarket",                    // ea_name
//       "high",                       // risk_level
//       "martin_level_2",             // intent
//       _Symbol, ORDER_TYPE_SELL, 0.06
//   );
//
//   if(guard.status == OG_STATUS_BLOCKED) {
//       Print("[OrderGuard] 拦截: ", guard.reason);
//       return;
//   }
//   double actual_lots = guard.adjusted_volume > 0 ? guard.adjusted_volume : 0.06;
//   trade.Sell(actual_lots, _Symbol, 0, 0, 0, "martin");
//
// 设计细节：
//   - 同步阻塞 1 次 WebRequest 到本地 EasyDeal :PORT/check（HTTP timeout 默认 500ms）
//   - 拿不到 / 超时 → 自动 fallback 到本地 MQL5/Files/OrderGuard/<ea>.rules.json
//   - 回测环境（MQLInfoInteger(MQL5_TESTER) == 1）→ 跳过 HTTP 直接走本地 fast rules
//   - 端口从 MQL5/Files/OrderGuard/orderguard.port 读，没文件用默认 19527
//   - 0.3.67: 不需要鉴权 — 服务 bind 127.0.0.1，外部进程访问不到
//   - 消息面护航: OrderGuard_NewsGate() 开马丁前问一次 (默认关, 护航页手动开; 见文件末尾)
//
// 部署：EasyDeal 客户端「我的策略 → 🛡 护航 → 启用拦截模式」一键完成：
//   1. 把这个文件 copy 到 <MT5>/MQL5/Include/OrderGuard.mqh
//   2. 把 fast rules JSON 写到 <MT5>/MQL5/Files/OrderGuard/<ea>.rules.json
//   3. 把 token + port 文件写到 <MT5>/MQL5/Files/OrderGuard/
//   4. 提醒用户在 MT5 选项里把 http://127.0.0.1:PORT 加到 WebRequest 白名单
//+------------------------------------------------------------------+

#property strict

//+------------------------------------------------------------------+
//| Result codes                                                       |
//+------------------------------------------------------------------+
#define OG_STATUS_APPROVED       0    // 放行 — 按 adjusted_volume 下单（>0 时）
#define OG_STATUS_BLOCKED        1    // 拦截 — 不要下单
#define OG_STATUS_ADJUSTED       2    // 放行但调整了手数（看 adjusted_volume）
#define OG_STATUS_SERVICE_DOWN   3    // 服务挂了 — 看 local_decision 决定
#define OG_STATUS_DISABLED       4    // 该 EA 未启用护航 — 按 EA 原逻辑下单

// local_decision 取值（service down 时用）
#define OG_LOCAL_PASS            0
#define OG_LOCAL_BLOCK           1

#define OG_TIMEOUT_MS_DEFAULT    500  // HTTP 默认超时
#define OG_DEFAULT_PORT          19527

//+------------------------------------------------------------------+
//| Result struct                                                      |
//+------------------------------------------------------------------+
struct OrderGuardResult {
    int    status;             // OG_STATUS_*
    string reason;
    double adjusted_volume;    // > 0 时按这个手数下单，0 = 原手数 / blocked
    string decision_id;
    int    latency_ms;
    bool   ai_cached;
    int    local_decision;     // 仅 service_down 时填，OG_LOCAL_*
};

//+------------------------------------------------------------------+
//| Internal — port / token cache                                     |
//+------------------------------------------------------------------+
int     _og_cached_port  = 0;
string  _og_cached_token = "";
int     _og_cache_ts     = 0;
bool    _og_log_verbose  = false;     // 改 true 看详细日志

//+------------------------------------------------------------------+
//| 读 MQL5/Files/OrderGuard/orderguard.port 拿实际端口                |
//+------------------------------------------------------------------+
int OrderGuard_GetPort()
{
    // 每 60s 刷新一次（防止 EasyDeal 重启换端口）
    if(_og_cached_port > 0 && TimeLocal() - _og_cache_ts < 60)
        return _og_cached_port;

    int handle = FileOpen("OrderGuard\\orderguard.port", FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
    if(handle == INVALID_HANDLE) {
        // 试 EA-local Files
        handle = FileOpen("OrderGuard\\orderguard.port", FILE_READ|FILE_TXT|FILE_ANSI);
    }
    if(handle == INVALID_HANDLE) {
        if(_og_log_verbose) Print("[OrderGuard] port file 找不到，用默认 ", OG_DEFAULT_PORT);
        _og_cached_port = OG_DEFAULT_PORT;
        _og_cache_ts = (int)TimeLocal();
        return _og_cached_port;
    }
    string line = FileReadString(handle);
    FileClose(handle);
    int port = (int)StringToInteger(line);
    if(port <= 0 || port > 65535) port = OG_DEFAULT_PORT;
    _og_cached_port = port;
    _og_cache_ts = (int)TimeLocal();
    return port;
}

//+------------------------------------------------------------------+
//| 0.3.67: token 鉴权已废 — 服务 bind 127.0.0.1 外部本就访问不到。   |
//| 函数保留以兼容老 EA，永远返回空字符串。                              |
//+------------------------------------------------------------------+
string OrderGuard_GetToken()
{
    return "";
}

//+------------------------------------------------------------------+
//| 读 <ea>.rules.json 做本地 fast rules 兜底（回测 + 服务不可达时用）  |
//+------------------------------------------------------------------+
struct OG_LocalRules {
    bool   loaded;
    double max_volume;
    int    max_positions;
    int    martin_max_level;
    string blocked_intents;     // 逗号分隔 — 这些 intent 一律拦
};

OG_LocalRules OrderGuard_LoadLocalRules(string ea_name)
{
    OG_LocalRules r;
    r.loaded = false;
    r.max_volume = 999;
    r.max_positions = 999;
    r.martin_max_level = 99;
    r.blocked_intents = "";

    string fname = "OrderGuard\\" + ea_name + ".rules.json";
    int handle = FileOpen(fname, FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
    if(handle == INVALID_HANDLE) handle = FileOpen(fname, FILE_READ|FILE_TXT|FILE_ANSI);
    if(handle == INVALID_HANDLE) return r;

    string body = "";
    while(!FileIsEnding(handle)) body += FileReadString(handle) + "\n";
    FileClose(handle);

    // 极简 JSON 解析 — 只提取我们关心的 4 个键值（不引入 JSON 库）
    r.loaded = true;
    r.max_volume       = _og_extract_number(body, "max_volume", 999);
    r.max_positions    = (int)_og_extract_number(body, "max_positions", 999);
    r.martin_max_level = (int)_og_extract_number(body, "martin_max_level", 99);
    r.blocked_intents  = _og_extract_string(body, "blocked_intents");
    return r;
}

//+------------------------------------------------------------------+
//| 极简 JSON 解析助手 — 找 "key": <数字>                              |
//+------------------------------------------------------------------+
double _og_extract_number(string body, string key, double def_val)
{
    string needle = "\"" + key + "\"";
    int pos = StringFind(body, needle);
    if(pos < 0) return def_val;
    int colon = StringFind(body, ":", pos);
    if(colon < 0) return def_val;
    // 跳空白
    int p = colon + 1;
    while(p < StringLen(body) && (StringGetCharacter(body, p) == ' ' || StringGetCharacter(body, p) == '\t'))
        p++;
    // 读数字
    string num = "";
    while(p < StringLen(body)) {
        ushort ch = StringGetCharacter(body, p);
        if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-') num += ShortToString(ch);
        else break;
        p++;
    }
    if(StringLen(num) == 0) return def_val;
    return StringToDouble(num);
}

string _og_extract_string(string body, string key)
{
    string needle = "\"" + key + "\"";
    int pos = StringFind(body, needle);
    if(pos < 0) return "";
    int q1 = StringFind(body, "\"", pos + StringLen(needle) + 1);
    if(q1 < 0) return "";
    int q2 = StringFind(body, "\"", q1 + 1);
    if(q2 < 0) return "";
    return StringSubstr(body, q1 + 1, q2 - q1 - 1);
}

//+------------------------------------------------------------------+
//| 本地 fast rules 决策（HTTP 不可达 / 回测时）                       |
//+------------------------------------------------------------------+
OrderGuardResult OrderGuard_LocalFastCheck(
    string ea_name, string risk_level, string intent,
    string symbol, int side, double volume)
{
    OrderGuardResult r;
    r.status = OG_STATUS_APPROVED;
    r.reason = "";
    r.adjusted_volume = 0;
    r.decision_id = "local_" + (string)TimeLocal();
    r.latency_ms = 0;
    r.ai_cached = false;
    r.local_decision = OG_LOCAL_PASS;

    OG_LocalRules rules = OrderGuard_LoadLocalRules(ea_name);
    if(!rules.loaded) {
        // 没本地规则文件 → 默认放行（"宁漏不误"原则）
        r.reason = "no local rules — default pass";
        return r;
    }

    // 1. max_volume
    if(volume > rules.max_volume) {
        r.status = OG_STATUS_ADJUSTED;
        r.adjusted_volume = rules.max_volume;
        r.reason = "local: volume " + DoubleToString(volume, 2) +
                   " > max " + DoubleToString(rules.max_volume, 2) +
                   " — 手数调整到上限";
        return r;
    }

    // 2. 风险级别 = critical 一律拦
    if(StringCompare(risk_level, "critical", false) == 0) {
        r.status = OG_STATUS_BLOCKED;
        r.local_decision = OG_LOCAL_BLOCK;
        r.reason = "local: risk_level=critical — 拦截";
        return r;
    }

    // 3. martin 层数
    if(StringFind(intent, "martin") >= 0 || StringFind(intent, "Martin") >= 0) {
        int level = _og_parse_level(intent);
        if(level > rules.martin_max_level) {
            r.status = OG_STATUS_BLOCKED;
            r.local_decision = OG_LOCAL_BLOCK;
            r.reason = "local: martin level " + (string)level + " > max " +
                       (string)rules.martin_max_level;
            return r;
        }
    }

    // 4. blocked_intents 黑名单
    if(StringLen(rules.blocked_intents) > 0 &&
       StringFind(rules.blocked_intents, intent) >= 0) {
        r.status = OG_STATUS_BLOCKED;
        r.local_decision = OG_LOCAL_BLOCK;
        r.reason = "local: intent '" + intent + "' in blocked_intents list";
        return r;
    }

    r.reason = "local fast rules: passed";
    return r;
}

int _og_parse_level(string intent)
{
    // 找 intent 里第一个数字串当 level（"martin_level_3" → 3, "martin3" → 3）
    string num = "";
    for(int i = 0; i < StringLen(intent); i++) {
        ushort ch = StringGetCharacter(intent, i);
        if(ch >= '0' && ch <= '9') num += ShortToString(ch);
    }
    if(StringLen(num) == 0) return 1;
    return (int)StringToInteger(num);
}

//+------------------------------------------------------------------+
//| HTTP POST 到 EasyDeal /check                                       |
//+------------------------------------------------------------------+
bool _og_http_post(int port, string token, string body, int timeout_ms,
                   string &response_out)
{
    string url = "http://127.0.0.1:" + (string)port + "/check";
    string headers = "Content-Type: application/json\r\n";
    if(StringLen(token) > 0) headers += "X-OG-Token: " + token + "\r\n";

    char data[];
    StringToCharArray(body, data, 0, StringLen(body));
    // 去末尾的 \0
    if(ArraySize(data) > 0 && data[ArraySize(data)-1] == 0)
        ArrayResize(data, ArraySize(data) - 1);

    char result[];
    string result_headers;
    ResetLastError();
    int code = WebRequest("POST", url, headers, timeout_ms, data, result, result_headers);
    if(code == -1) {
        int err = GetLastError();
        if(_og_log_verbose)
            Print("[OrderGuard] WebRequest 失败 err=", err, " — 请在 MT5 选项→EA 把 ",
                  "http://127.0.0.1:", port, " 加到允许 WebRequest 列表");
        return false;
    }
    if(code != 200) {
        if(_og_log_verbose) Print("[OrderGuard] HTTP ", code, " ", url);
        return false;
    }
    response_out = CharArrayToString(result);
    return true;
}

//+------------------------------------------------------------------+
//| 主 API: OrderGuard_Check — 同步阻塞，最多 timeout_ms                |
//+------------------------------------------------------------------+
OrderGuardResult OrderGuard_Check(
    string ea_name,
    string risk_level,
    string intent,
    string symbol,
    int    side,             // ORDER_TYPE_BUY / ORDER_TYPE_SELL
    double volume,
    int    timeout_ms = OG_TIMEOUT_MS_DEFAULT)
{
    OrderGuardResult r;
    r.status = OG_STATUS_APPROVED;
    r.reason = "";
    r.adjusted_volume = 0;
    r.decision_id = "";
    r.latency_ms = 0;
    r.ai_cached = false;
    r.local_decision = OG_LOCAL_PASS;

    int t0 = (int)GetTickCount();

    // 回测环境 — 跳过 HTTP，直接本地 fast rules
    if(MQLInfoInteger(MQL_TESTER) == 1 || MQLInfoInteger(MQL_OPTIMIZATION) == 1) {
        OrderGuardResult lr = OrderGuard_LocalFastCheck(ea_name, risk_level, intent,
                                                        symbol, side, volume);
        lr.reason = "[tester] " + lr.reason;
        lr.latency_ms = (int)GetTickCount() - t0;
        return lr;
    }

    int port = OrderGuard_GetPort();
    string token = OrderGuard_GetToken();

    // 构 JSON body — 不用 JSON 库，手拼
    string side_str = (side == ORDER_TYPE_BUY) ? "buy" : "sell";
    string body = "{";
    body += "\"ea_name\":\""    + ea_name + "\",";
    body += "\"risk_level\":\"" + risk_level + "\",";
    body += "\"intent\":\""     + intent + "\",";
    body += "\"symbol\":\""     + symbol + "\",";
    body += "\"side\":\""       + side_str + "\",";
    body += "\"volume\":"       + DoubleToString(volume, 2);
    body += "}";

    string resp = "";
    bool ok = _og_http_post(port, token, body, timeout_ms, resp);
    if(!ok) {
        // 服务不可达 → 本地兜底
        OrderGuardResult lr = OrderGuard_LocalFastCheck(ea_name, risk_level, intent,
                                                        symbol, side, volume);
        lr.status = OG_STATUS_SERVICE_DOWN;
        lr.reason = "[service down] " + lr.reason;
        // 把 local_decision 翻译给上层
        if(lr.adjusted_volume > 0)   lr.local_decision = OG_LOCAL_PASS;
        else if(StringFind(lr.reason, "拦截") >= 0) lr.local_decision = OG_LOCAL_BLOCK;
        else                          lr.local_decision = OG_LOCAL_PASS;
        lr.latency_ms = (int)GetTickCount() - t0;
        return lr;
    }

    // 解析响应
    // 服务端返回: {"ok":true,"data":{"approved":true,"reason":"...","adjusted_volume":null,"decision_id":"dg_xxx","latency_ms":12}}
    bool approved = _og_extract_bool(resp, "approved");
    double adj    = _og_extract_number(resp, "adjusted_volume", -1);
    string reason = _og_extract_string(resp, "reason");
    string did    = _og_extract_string(resp, "decision_id");
    bool cached   = _og_extract_bool(resp, "ai_cached");

    r.reason = reason;
    r.decision_id = did;
    r.ai_cached = cached;
    r.adjusted_volume = (adj > 0 ? adj : 0);

    if(!approved) {
        r.status = OG_STATUS_BLOCKED;
    } else if(adj > 0 && MathAbs(adj - volume) > 0.001) {
        r.status = OG_STATUS_ADJUSTED;
    } else {
        r.status = OG_STATUS_APPROVED;
    }

    r.latency_ms = (int)GetTickCount() - t0;
    return r;
}

//+------------------------------------------------------------------+
//| 1.0.7: 改单前调 — 拦「SL 往亏损方向外扩」(收紧 SL / 改 TP 一律放行)。|
//| 服务端按 ref_price + cur_sl/new_sl 判外扩; 回测 / 服务挂 → 一律放行  |
//| (宁漏不误; 真正拦截只在服务端在线时发生, 离线不本地误判 trailing)。   |
//|   用法: 改 SL/TP 前调一次, BLOCKED 就别改 ——                        |
//|     OrderGuardResult g = OrderGuard_CheckModify("GMarket", pos_ticket,|
//|         _Symbol, ORDER_TYPE_BUY, cur_sl, cur_tp, new_sl, new_tp, bid);|
//|     if(g.status==OG_STATUS_BLOCKED){ Print(g.reason); return; }      |
//+------------------------------------------------------------------+
OrderGuardResult OrderGuard_CheckModify(
    string ea_name, long ticket, string symbol, int side,
    double cur_sl, double cur_tp, double new_sl, double new_tp,
    double ref_price, int timeout_ms = OG_TIMEOUT_MS_DEFAULT)
{
    OrderGuardResult r;
    r.status = OG_STATUS_APPROVED; r.reason = ""; r.adjusted_volume = 0;
    r.decision_id = ""; r.latency_ms = 0; r.ai_cached = false; r.local_decision = OG_LOCAL_PASS;
    int t0 = (int)GetTickCount();
    if(MQLInfoInteger(MQL_TESTER) == 1 || MQLInfoInteger(MQL_OPTIMIZATION) == 1)
        return r;                       // 回测不拦
    int dg = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
    if(dg <= 0 || dg > 8) dg = 5;
    string side_str = (side == ORDER_TYPE_BUY) ? "buy" : "sell";
    string body = "{";
    body += "\"op\":\"modify\",";
    body += "\"ea_name\":\"" + ea_name + "\",";
    body += "\"ticket\":"    + (string)ticket + ",";
    body += "\"symbol\":\""  + symbol + "\",";
    body += "\"side\":\""    + side_str + "\",";
    body += "\"cur_sl\":"    + DoubleToString(cur_sl, dg) + ",";
    body += "\"cur_tp\":"    + DoubleToString(cur_tp, dg) + ",";
    body += "\"new_sl\":"    + DoubleToString(new_sl, dg) + ",";
    body += "\"new_tp\":"    + DoubleToString(new_tp, dg) + ",";
    body += "\"ref_price\":" + DoubleToString(ref_price, dg);
    body += "}";
    string resp = "";
    if(!_og_http_post(OrderGuard_GetPort(), "", body, timeout_ms, resp)) {
        r.status = OG_STATUS_SERVICE_DOWN; r.reason = "[service down] approve";
        r.latency_ms = (int)GetTickCount() - t0; return r;
    }
    if(!_og_extract_bool(resp, "approved")) r.status = OG_STATUS_BLOCKED;
    r.reason      = _og_extract_string(resp, "reason");
    r.decision_id = _og_extract_string(resp, "decision_id");
    r.latency_ms  = (int)GetTickCount() - t0;
    return r;
}

//+------------------------------------------------------------------+
//| 1.0.7: 平仓前调 — 默认放行 (服务端默认关平仓拦截; 且永不拦止损)。    |
//| floating_pnl 传给服务端: 浮亏<=0 一律放行 (止损绝不拦)。回测/服务挂  |
//| → 放行。只有用户显式开「平仓拦截」+ 在线 + 盈利单偏早 才可能 BLOCKED。|
//+------------------------------------------------------------------+
OrderGuardResult OrderGuard_CheckClose(
    string ea_name, long ticket, string symbol, int side, double volume,
    double open_price, double cur_price, double cur_sl, double cur_tp,
    double floating_pnl, string intent, int timeout_ms = OG_TIMEOUT_MS_DEFAULT)
{
    OrderGuardResult r;
    r.status = OG_STATUS_APPROVED; r.reason = ""; r.adjusted_volume = 0;
    r.decision_id = ""; r.latency_ms = 0; r.ai_cached = false; r.local_decision = OG_LOCAL_PASS;
    int t0 = (int)GetTickCount();
    if(MQLInfoInteger(MQL_TESTER) == 1 || MQLInfoInteger(MQL_OPTIMIZATION) == 1)
        return r;
    int dg = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
    if(dg <= 0 || dg > 8) dg = 5;
    string side_str = (side == ORDER_TYPE_BUY) ? "buy" : "sell";
    string body = "{";
    body += "\"op\":\"close\",";
    body += "\"ea_name\":\""    + ea_name + "\",";
    body += "\"ticket\":"       + (string)ticket + ",";
    body += "\"symbol\":\""     + symbol + "\",";
    body += "\"side\":\""       + side_str + "\",";
    body += "\"volume\":"       + DoubleToString(volume, 2) + ",";
    body += "\"open_price\":"   + DoubleToString(open_price, dg) + ",";
    body += "\"cur_price\":"    + DoubleToString(cur_price, dg) + ",";
    body += "\"cur_sl\":"       + DoubleToString(cur_sl, dg) + ",";
    body += "\"cur_tp\":"       + DoubleToString(cur_tp, dg) + ",";
    body += "\"floating_pnl\":" + DoubleToString(floating_pnl, 2) + ",";
    body += "\"intent\":\""     + intent + "\"";
    body += "}";
    string resp = "";
    if(!_og_http_post(OrderGuard_GetPort(), "", body, timeout_ms, resp)) {
        r.status = OG_STATUS_SERVICE_DOWN; r.reason = "[service down] approve";
        r.latency_ms = (int)GetTickCount() - t0; return r;
    }
    if(!_og_extract_bool(resp, "approved")) r.status = OG_STATUS_BLOCKED;
    r.reason      = _og_extract_string(resp, "reason");
    r.decision_id = _og_extract_string(resp, "decision_id");
    r.latency_ms  = (int)GetTickCount() - t0;
    return r;
}

//+------------------------------------------------------------------+
//| Async precheck — 让 AI 后台开始评估，下次 Check 时大概率命中 cache |
//+------------------------------------------------------------------+
void OrderGuard_PrecheckAsync(
    string ea_name, string risk_level, string intent,
    string symbol, int side, double volume)
{
    int port = OrderGuard_GetPort();
    string token = OrderGuard_GetToken();
    string side_str = (side == ORDER_TYPE_BUY) ? "buy" : "sell";
    string body = "{";
    body += "\"ea_name\":\""    + ea_name + "\",";
    body += "\"risk_level\":\"" + risk_level + "\",";
    body += "\"intent\":\""     + intent + "\",";
    body += "\"symbol\":\""     + symbol + "\",";
    body += "\"side\":\""       + side_str + "\",";
    body += "\"volume\":"       + DoubleToString(volume, 2);
    body += "}";
    // 1ms timeout fire-and-forget — 我们不要结果，只要把它先丢到服务端缓存预热
    string ignored = "";
    _og_http_post_async(port, token, body, ignored);
}

void _og_http_post_async(int port, string token, string body, string &ignored)
{
    string url = "http://127.0.0.1:" + (string)port + "/precheck-async";
    string headers = "Content-Type: application/json\r\n";
    if(StringLen(token) > 0) headers += "X-OG-Token: " + token + "\r\n";
    char data[];
    StringToCharArray(body, data, 0, StringLen(body));
    if(ArraySize(data) > 0 && data[ArraySize(data)-1] == 0)
        ArrayResize(data, ArraySize(data) - 1);
    char result[];
    string result_headers;
    // 50ms timeout — 不等结果
    WebRequest("POST", url, headers, 50, data, result, result_headers);
}

//+------------------------------------------------------------------+
//| 极简 JSON bool 解析                                                |
//+------------------------------------------------------------------+
bool _og_extract_bool(string body, string key)
{
    string needle = "\"" + key + "\"";
    int pos = StringFind(body, needle);
    if(pos < 0) return false;
    int colon = StringFind(body, ":", pos);
    if(colon < 0) return false;
    string after = StringSubstr(body, colon + 1, 8);
    StringTrimLeft(after);
    return (StringFind(after, "true") == 0);
}

//+------------------------------------------------------------------+
//| Notify — EA 成交 / 平仓后回传给服务端补全 orders 表生命周期        |
//| 用户可选调用，监控模式也能自动收 deal 事件不强制                   |
//+------------------------------------------------------------------+
void OrderGuard_Notify(string decision_id, ulong ticket, double open_price,
                       double close_price = 0, double pnl = 0,
                       string close_reason = "")
{
    int port = OrderGuard_GetPort();
    string token = OrderGuard_GetToken();
    string body = "{";
    body += "\"decision_id\":\"" + decision_id + "\",";
    body += "\"ticket\":"        + (string)ticket + ",";
    body += "\"open_price\":"    + DoubleToString(open_price, _Digits);
    if(close_price > 0) {
        body += ",\"close_price\":" + DoubleToString(close_price, _Digits);
        body += ",\"pnl\":"          + DoubleToString(pnl, 2);
        body += ",\"close_reason\":\"" + close_reason + "\"";
    }
    body += "}";
    string url = "http://127.0.0.1:" + (string)port + "/notify";
    string headers = "Content-Type: application/json\r\n";
    if(StringLen(token) > 0) headers += "X-OG-Token: " + token + "\r\n";
    char data[];
    StringToCharArray(body, data, 0, StringLen(body));
    if(ArraySize(data) > 0 && data[ArraySize(data)-1] == 0)
        ArrayResize(data, ArraySize(data) - 1);
    char result[];
    string result_headers;
    WebRequest("POST", url, headers, 300, data, result, result_headers);
}

//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| 消息面护航 (news gate)                                             |
//|                                                                  |
//| EA 开马丁单 (或其他逆势加仓) 前调 OrderGuard_NewsGate(): EasyDeal 用 |
//| 一次 LLM 调用结合「资讯」快讯 + 经济日历判断是否放行。               |
//|   - 默认关闭: 用户在 EasyDeal「护航」页为该 EA 手动开启才生效;      |
//|     关闭时服务端立刻回 DISABLED, 不调 AI。                          |
//|   - 非阻塞: 首次通常回 PENDING —— 本 tick 别开, 隔 retry_after_sec |
//|     再问; EA 自己设最长等待, 超时放行。                             |
//|   - 回测 / 服务不可达 / WebRequest 未加白名单 / HTTP 失败 → ALLOW。 |
//|   - 经济日历由本函数在 EA 本地读 MT5 日历一并上报, 服务端只做补充。 |
//|                                                                  |
//|   OrderGuardNewsResult n = OrderGuard_NewsGate(                    |
//|       MQLInfoString(MQL_PROGRAM_NAME), magic, _Symbol,             |
//|       ORDER_TYPE_SELL, martin_level, lots);                        |
//|   if(n.verdict == OG_NEWS_DENY || n.verdict == OG_NEWS_PENDING)    |
//|       return;   // 本次不开, retry_after_sec 后再问                |
//|                                                                  |
//| 另外建议 OnTimer 里每 1~2 分钟调一次 OrderGuard_NewsGateHello(),   |
//| 让「护航」页知道这只 EA 支持消息面护航、且连得上护航服务。          |
//+------------------------------------------------------------------+
#define OG_NEWS_ALLOW      0    // 放行
#define OG_NEWS_DENY       1    // 拦截 —— retry_after_sec 后再问
#define OG_NEWS_PENDING    2    // AI 评估中 —— 本次不开, retry_after_sec 后再问
#define OG_NEWS_DISABLED   3    // 该 EA 没开消息面护航 (或回测) —— 按原逻辑走

#define OG_NEWS_CAL_BACK_MIN   120   // 上报日历: 往前 2 小时 (已公布)
#define OG_NEWS_CAL_AHEAD_MIN  360   // 上报日历: 往后 6 小时 (待公布)
#define OG_NEWS_CAL_MAX        40

struct OrderGuardNewsResult {
    int    verdict;          // OG_NEWS_*
    string reason;
    int    retry_after_sec;
    string mode;             // off / shadow / enforce; "" = 没拿到服务端响应
    string decision_id;
    bool   fail_open;        // true = 因 AI / 服务不可用等原因默认放行
};

string _og_json_esc(string s)
{
    StringReplace(s, "\\", "\\\\");
    StringReplace(s, "\"", "\\\"");
    StringReplace(s, "\r", " ");
    StringReplace(s, "\n", " ");
    StringReplace(s, "\t", " ");
    return s;
}

// UTF-8 收发 (日历事件名 / 服务端理由含中文)。返回 HTTP 状态码, -1 = WebRequest 失败。
int _og_http_post_utf8(string path, string body, int timeout_ms, string &response_out)
{
    string url = "http://127.0.0.1:" + (string)OrderGuard_GetPort() + path;
    string headers = "Content-Type: application/json; charset=utf-8\r\n";
    char data[];
    int n = StringToCharArray(body, data, 0, -1, CP_UTF8);
    if(n > 0 && data[n - 1] == 0) ArrayResize(data, n - 1);
    char result[];
    string result_headers;
    ResetLastError();
    int code = WebRequest("POST", url, headers, timeout_ms, data, result, result_headers);
    if(code == -1) {
        if(_og_log_verbose)
            Print("[OrderGuard] news-gate WebRequest 失败 err=", GetLastError(), " — 请在 MT5 选项→EA 把 ",
                  "http://127.0.0.1:", OrderGuard_GetPort(), " 加到允许 WebRequest 列表");
        return -1;
    }
    response_out = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
    return code;
}

// 收集品种相关货币的中/高重要性日历事件, 时间换算成 UTC 秒。返回 JSON 数组;
// ok=false = 本地日历不可用 (部分 broker 关闭了日历), 服务端会改用 /v1/calendar。
string OrderGuard_CollectCalendarJson(string symbol, bool &ok)
{
    ok = false;
    string c1 = SymbolInfoString(symbol, SYMBOL_CURRENCY_BASE);
    string c2 = SymbolInfoString(symbol, SYMBOL_CURRENCY_PROFIT);
    string c3 = SymbolInfoString(symbol, SYMBOL_CURRENCY_MARGIN);
    datetime srv = TimeTradeServer();
    // 服务器时区偏移按 15 分钟取整 (两个时钟读数有秒级误差)
    long offset = (long)MathRound((double)(srv - TimeGMT()) / 900.0) * 900;

    MqlCalendarValue values[];
    ResetLastError();
    CalendarValueHistory(values, srv - OG_NEWS_CAL_BACK_MIN * 60, srv + OG_NEWS_CAL_AHEAD_MIN * 60, NULL, NULL);
    int err = GetLastError();
    int n = ArraySize(values);
    if(err != 0 && n == 0) return "[]";
    ok = true;

    string out = "";
    int count = 0;
    for(int i = 0; i < n && count < OG_NEWS_CAL_MAX; i++) {
        MqlCalendarEvent ev;
        if(!CalendarEventById(values[i].event_id, ev)) continue;
        if(ev.importance != CALENDAR_IMPORTANCE_HIGH && ev.importance != CALENDAR_IMPORTANCE_MODERATE) continue;
        MqlCalendarCountry ct;
        if(!CalendarCountryById(ev.country_id, ct)) continue;
        string cur = ct.currency;
        if(StringLen(cur) == 0 || (cur != c1 && cur != c2 && cur != c3)) continue;
        string item = "{\"ts_utc\":" + IntegerToString((long)values[i].time - offset);
        item += ",\"currency\":\"" + _og_json_esc(cur) + "\"";
        item += ",\"title\":\"" + _og_json_esc(ev.name) + "\"";
        item += ",\"importance\":\"" + (ev.importance == CALENDAR_IMPORTANCE_HIGH ? "high" : "moderate") + "\"";
        item += ",\"actual\":"   + (values[i].HasActualValue()   ? DoubleToString(values[i].GetActualValue(), 4)   : "null");
        item += ",\"forecast\":" + (values[i].HasForecastValue() ? DoubleToString(values[i].GetForecastValue(), 4) : "null");
        item += ",\"previous\":" + (values[i].HasPreviousValue() ? DoubleToString(values[i].GetPreviousValue(), 4) : "null");
        item += "}";
        if(count > 0) out += ",";
        out += item;
        count++;
    }
    return "[" + out + "]";
}

OrderGuardNewsResult OrderGuard_NewsGate(
    string ea_name, long magic, string symbol, int side,   // side: ORDER_TYPE_BUY / ORDER_TYPE_SELL
    int level, double volume, int timeout_ms = 1000)
{
    OrderGuardNewsResult r;
    r.verdict = OG_NEWS_ALLOW; r.reason = ""; r.retry_after_sec = 0;
    r.mode = ""; r.decision_id = ""; r.fail_open = false;

    if(MQLInfoInteger(MQL_TESTER) == 1 || MQLInfoInteger(MQL_OPTIMIZATION) == 1) {
        r.verdict = OG_NEWS_DISABLED;           // 回测里没有 AI / 实时资讯, 不参与
        r.reason = "tester";
        return r;
    }

    bool cal_ok = false;
    string cal = OrderGuard_CollectCalendarJson(symbol, cal_ok);
    string body = "{\"op\":\"check\"";
    body += ",\"ea_name\":\"" + _og_json_esc(ea_name) + "\"";
    body += ",\"magic\":"     + IntegerToString(magic);
    body += ",\"symbol\":\""  + _og_json_esc(symbol) + "\"";
    body += ",\"side\":\""    + (side == ORDER_TYPE_BUY ? "buy" : "sell") + "\"";
    body += ",\"level\":"     + IntegerToString(level);
    body += ",\"volume\":"    + DoubleToString(volume, 2);
    body += ",\"calendar_ok\":" + (cal_ok ? "true" : "false");
    body += ",\"calendar\":"  + cal;
    body += "}";

    string resp = "";
    int code = _og_http_post_utf8("/news-gate", body, timeout_ms, resp);
    if(code != 200) {
        r.fail_open = true;
        r.reason = (code == -1)
            ? "护航服务不可达 (未运行或未加 WebRequest 白名单), 放行"
            : "护航服务 HTTP " + IntegerToString(code) + ", 放行";
        return r;
    }

    string v = _og_extract_string(resp, "verdict");
    r.mode            = _og_extract_string(resp, "mode");
    r.reason          = _og_extract_string(resp, "reason");
    r.decision_id     = _og_extract_string(resp, "decision_id");
    r.retry_after_sec = (int)_og_extract_number(resp, "retry_after_sec", 0);
    r.fail_open       = _og_extract_bool(resp, "fail_open");
    if(v == "deny")          r.verdict = OG_NEWS_DENY;
    else if(v == "pending")  r.verdict = OG_NEWS_PENDING;
    else if(v == "disabled") r.verdict = OG_NEWS_DISABLED;
    else                     r.verdict = OG_NEWS_ALLOW;   // allow / 未知值 → 放行
    return r;
}

// 心跳: 让「护航」页知道该 EA 支持消息面护航 + 连得上服务。返回服务端的 mode, "" = 没连上。
string OrderGuard_NewsGateHello(string ea_name, long magic, string symbol, string ea_version)
{
    if(MQLInfoInteger(MQL_TESTER) == 1 || MQLInfoInteger(MQL_OPTIMIZATION) == 1) return "";
    string body = "{\"op\":\"hello\"";
    body += ",\"ea_name\":\""    + _og_json_esc(ea_name) + "\"";
    body += ",\"magic\":"        + IntegerToString(magic);
    body += ",\"symbol\":\""     + _og_json_esc(symbol) + "\"";
    body += ",\"ea_version\":\"" + _og_json_esc(ea_version) + "\"";
    body += "}";
    string resp = "";
    if(_og_http_post_utf8("/news-gate", body, 500, resp) != 200) return "";
    return _og_extract_string(resp, "mode");
}

//+------------------------------------------------------------------+
