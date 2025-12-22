# EasyDeal MT5 交易策略

## 策略概述

EasyDeal MT5是一个基于MetaTrader 5平台的自动化交易策略，支持 AI Agent 通过 MCP 协议接入进行智能交易管理。

策略会双向开仓入场，在顺势方向执行爬梯止盈并开新单，在逆势方向会不断开马丁单，直至逆势方向的订单不亏损完结。在第一次爬梯后会锁定方向。开马丁时会同时开一张同向基础单，马丁单的大小为上一次马丁单和基础单加起来的两倍。马丁单受控于两个参数，马丁最小矩离和滤波矩离，上一张逆向单必须达到马丁矩离并回撤达到滤波矩离才会增开马丁单。马丁单结束时会补开一张基础单，形成新一轮双单起步，如此不断循环。在执行的图形变化上会出现，双单锁定的区间由小变大，再突然变窄。在资金方面，在绝对安全的情况下先把浮亏转换成盈利，再通过马丁单去结束浮亏，浮亏转换效率93%以上，风险位在于马丁。很多人对马丁有意见，但其实跑赢概率还是得马丁，只是如果以马丁来做营收，冲着马丁去落单，总会遇到极端情况。这个策略就是反过来的，常态化用浮亏换收益，摘机再用马丁去收浮亏。

## 作者故事

17年上半年我带队做了一个币交易所，往后是钱包、o2c、合约等配套工具。20年后业余时间帮多个资管公司编写外汇交易ea，主业是ai开发，至今一直在打造数字人开源项目 https://github.com/xszyou/fay 。最近老想把数字人（更多是指agent），与ea相结合，故挑选了一套简洁的策略作为demo，给大家开源出来。

## 主要特点

- **双向开仓**：同时开立买单和卖单，捕捉市场双向机会
- **马丁格尔策略**：合适的时机使用马丁来收窄锁定区间，降低浮亏
- **风险控制**：设置最大亏损限制和最大马丁层数，防止过度亏损，agent会视风险情况自动关闭马丁功能
- **Web API接口**：提供完整的REST API，可远程监控和控制策略
- **MCP Server**：支持 AI Agent 接入，实现智能化交易管理
- **监控告警**：内置监控服务，支持 MACD/RSI/ATR/布林带 等技术指标告警
- **定时巡检**：每小时自动发送巡检报告，包含价格、盈亏、马丁状态等
- **日志记录**：详细记录交易和API请求，便于回测和分析
- **复盘回测**：联系客服获取ea程序使用MT自带复盘功能进行回测

## 项目文件

```
easy-deal/
├── easydeal_mcp_server.py   # 统一入口（策略 + 监控 + API + MCP Server）
├── mcp_config.json          # MCP 客户端配置示例
├── requirements.txt         # Python 依赖
├── README.md                # 项目文档
└── logs/                    # 日志目录
    ├── easydeal.log         # 策略运行日志
    ├── api_requests.log     # API请求日志
    └── monitor_events.jsonl # 监控事件日志
```

## 安装要求

- Python 3.12
- MetaTrader 5平台及其Python API
- Windows 操作系统（MT5 限制）

### 安装依赖

```bash
pip install -r requirements.txt
```

或手动安装：

```bash
pip install MetaTrader5 pandas flask pytz mcp requests
```

## 使用流程

### 1. 准备工作

- 开户及下载MT5（本文以exness为例）

  - 访问exness官网（可能需要vpn，vpn不能使用美国、伊朗、朝鲜、欧盟、英国）：https://one.exnessonelink.com/a/r6fx3vgje1

  - 点击右上角登录-->开立账户-->注册-->个人专区

    - ![image-20251201164439332](image-20251201164439332.png)

  - 我的账户-->模拟-->交易-->Meta Trader 5（此处保存好交易账号信息及服务器信息）-->下载安装MT5平台-->运行exness5setup.exe-->等待安装完成

    - ![image-20251201164751516](image-20251201164751516.png)
    - ![image-20251201165907714](image-20251201165907714.png)

  - 运行MT5终端-->关闭开设账户弹窗-->导航栏-->exness-->账户--右健-->登录到交易账户（注意，此处填写的登录名为上文选择mt5交易时记录的那串数字账号，服务器也需注意选择正确）

    - ![image-20251201171300979](image-20251201171300979.png)
    - 主窗口交闭除XAUUSDm,H1 外的其他窗口，并全屏。（若关多了，可以在左则交易品种右键重新打开交易窗口）
      - ![image-20251201171802594](image-20251201171802594.png)

  - 选择XAUUSDm窗口

### 2. 配置参数

在`easydeal_mcp_server.py`文件中，通过修改`EasyDealStrategy`类的`__init__`方法来配置交易参数：（也可以让agent去更改）

```python
def __init__(self):
    # 直接设置交易参数
    self.symbol = "XAUUSDm"  # 交易币对
    self.first_lots = 0.01  # 首单手数
    self.step = 0.1  # 步长
    self.martin_interval = 1.6  # 马丁间隔
    self.filter = 0.1  # 过滤百分比
    self.order_time = 0  # 下单时间
    self.magic_number = 999  # 魔术数字
    self.max_loss = 3000  # 最大亏损
    self.max_martin_level = 5  # 最大马丁层数
```

| 参数名              | 说明            | 默认值    | 建议范围       |
| ---------------- | ------------- | ------ | ---------- |
| symbol           | 交易币对          | XAUUSDm | 任何MT5支持的币对 |
| first_lots       | 首单手数          | 0.01   | 0.01-1.0   |
| step             | 马丁加仓步长        | 0.1    | 0.1-0.5    |
| martin_interval  | 马丁间隔（点数）      | 1.6    | 1.0-5.0    |
| filter           | 过滤百分比         | 0.1    | 0.05-0.2   |
| order_time       | 下单时间（0表示立即下单） | 0      | 0或Unix时间戳  |
| magic_number     | 魔术数字（订单标识）    | 999    | 任意整数       |
| max_loss         | 最大亏损限制（美元）    | 3000   | 根据资金量设置    |
| max_martin_level | 最大马丁层数        | 5      | 3-10       |

### 3. 启动 Agent

1、依照 https://github.com/xszyou/fay 安装并运行fay(记得star哦)

![image-20251201173550931](image-20251201173550931.png)

2、在fay界面配置上easy deal及window capture（为ea状态截图留底）mcp服务器

![image-20251201172558108](image-20251201172558108.png)

```json
[
    {
        "id": 1,
        "name": "easy deal",
        "ip": "",
        "connection_time": "2025-12-11 11:03:47",
        "key": "",
        "transport": "stdio",
        "command": "python",
        "args": [
            "easydeal_mcp_server.py"
        ],
        "cwd": "mcp_servers/easy-deal",
        "env": {}
    }
]
```

注：cwd请替换为easydeal_mcp_server.py所在目录。

3、配置工具预启动

easy deal ：get_strategy_documentation (不保存预启动工具执行结果到记忆)、get_trading_status(保存预启动工具执行结果到记忆)

**重要说明**：当 Agent 连接 MCP Server 时，会自动启动以下服务：
- 交易策略（自动恢复已有订单状态）
- 监控服务（风险检查、市场分析、每小时巡检）
- Flask API 服务（端口 8888）

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户/AI Agent                            │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │  easydeal_mcp_server  │
                    │     (统一入口)         │
                    ├───────────────────────┤
                    │  ┌─────────────────┐  │
                    │  │   MCP Server    │  │ ← Agent 连接后自动启动
                    │  │    (stdio)      │  │   所有服务
                    │  └────────┬────────┘  │
                    │           │           │
                    │  ┌────────┼────────┐  │
                    │  │        │        │  │
                    │  ▼        ▼        ▼  │
                    │ Flask   策略    监控   │
                    │ :8888   线程    线程   │
                    │  └────────┼────────┘  │
                    │           │           │
                    │           ▼           │
                    │  ┌─────────────────┐  │
                    │  │EasyDealStrategy │  │
                    │  │  (核心交易逻辑)  │  │
                    │  └─────────────────┘  │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │    MetaTrader 5       │
                    │    (交易执行)          │
                    └───────────────────────┘
```

## 监控服务说明

监控服务会自动执行以下检查：

| 检查类型 | 间隔 | 功能 |
|---------|------|------|
| 状态检查 | 30秒 | 策略运行状态、持仓变动通知 |
| 风险检查 | 60秒 | 浮亏预警（30%/50%/70%）、马丁层级预警 |
| 市场检查 | 5分钟 | RSI超买超卖、ATR波动率、MACD金叉死叉、布林带偏离 |
| 定时巡检 | 1小时 | 发送完整的巡检报告到Agent |

### 每小时巡检报告内容

```
定时巡检报告
当前价格: 2650.12345
总浮动盈亏: -150.00
马丁层级: 2
马丁状态: 开启
布林带偏离: 1.25倍SD
MACD值: 0.00125
```

## MCP 工具列表

| 工具名 | 说明 |
|-------|------|
| get_trading_status | 获取完整交易状态 |
| get_market_info | 获取实时行情 |
| get_config | 获取策略配置 |
| get_strategy_documentation | 获取策略逻辑文档 |
| pause_strategy | 暂停策略 |
| resume_strategy | 恢复策略 |
| close_all_positions | 平掉所有持仓 |
| get_profit_history | 获取收益历史 |
| analyze_risk | 分析风险状况 |
| get_position_details | 获取持仓详情 |
| update_config | 更新策略配置 |
| get_klines | 获取K线数据 |
| get_technical_indicators | 获取技术指标 |
| get_martin_status | 获取马丁状态 |
| enable_martin | 启用马丁 |
| disable_martin | 禁用马丁 |
| notify_owner | 通知主人（播报消息） |

## MCP 资源列表

| URI | 说明 |
|-----|------|
| trading://status | 实时交易状态 |
| trading://config | 策略配置 |
| trading://strategy-doc | 策略逻辑文档 |
| trading://source-code | 完整源代码 |

## Flask API 接口

| 接口 | 方法 | 说明 |
|-----|------|------|
| /status | GET | 获取策略状态 |
| /pause | POST | 暂停策略 |
| /resume | POST | 恢复策略 |
| /close_all | POST | 平掉所有订单 |
| /profit?days=30 | GET | 获取收益历史 |
| /config | GET | 获取策略配置 |

## 联系我们

![image-20251201173859002](image-20251201173859002.png)
注：群满加qq467665317

## 许可证

本项目采用GLP 3.0许可证。详情请参阅LICENSE文件。
