# EasyDeal MT5 智能交易系统

## 项目概述

EasyDeal 是一套结合了 MetaTrader 5 (MT5) 专家顾问 (EA) 与 Python MCP Server 的现代自动化交易解决方案。

- **核心交易端 (EA)**: 由 `GMarket_0.21.mq5` (也可以替换成自己的，或者**进群**获取更多)负责，直接在 MT5 终端运行。它执行核心的交易逻辑（双向开仓、马丁格尔策略、风险控制）、提供图形化操作界面 (UI)，并内置了财经日历新闻过滤功能。
- **智能监控端 (MCP Server)**: 由 `easydeal_mcp_server.py` 负责。它作为 AI Agent (如 Claude Desktop, Fay) 的连接器，通过 MCP 协议提供实时的策略状态监控、异常告警、日志分析及一致性校验功能。

这种架构确保了交易的稳定性（EA 独立运行，不受 Python 端影响），同时赋予了系统强大的 AI 扩展能力（通过 MCP 进行自然语言交互和智能风控）。

## 主要特点

### 核心策略 (EA)

- **双向对冲策略**：同时捕捉多空机会，顺势爬梯止盈，逆势马丁解套。
- **智能风控**：
  - **新闻过滤**：自动读取财经日历，在重大数据（如非农、利率决议）发布前后暂停加仓。
  - **技术指标过滤**：结合 ATR 波动率和布林带偏离度，避免在极端行情下盲目加仓。
  - **最大回撤保护**：设定最大浮亏金额，触及阈值自动清仓止损。
- **图形化控制面板 (UI)**：
  - 实时显示马丁层级、交易方向、ATR/布林带状态及当前盈利。
  - 快捷按钮：一键暂停策略、开关马丁功能、强制重载状态。
- **断点续传**：EA 具备自动状态恢复功能，重启 MT5 后可自动识别并接管已有订单。

### 智能监控 (MCP Server)

- **AI Agent 集成**：支持通过 MCP 协议接入 Claude Desktop 或 Fay 数字人，实现"对话式"交易监控。
- **全方位告警**：
  - **状态异常**：EA 停止运行、终端掉线通知。
  - **风险预警**：浮亏比例预警 (30%/50%/70%)、马丁层级过高预警。
  - **技术信号**：RSI 超买超卖、MACD 金叉死叉提示。
- **一致性校验**：每日自动比对 EA 交易日志与策略规则，生成执行合规性报告。
- **Web API**：提供 HTTP 接口供其他系统调用。

## 项目文件结构

```
easy-deal/
├── GMarket_0.21.mq5         # [核心] MT5 专家顾问 (EA) 源码
├── easydeal_mcp_server.py   # [可选] MCP Server (监控与AI接口)
├── requirements.txt         # Python 依赖
├── README.md                # 项目文档
└── logs/
    ├── easydeal.log         # 监控日志
    └── strategy_review.md   # 每日策略校验报告
```

## 安装与使用

### 第一步：部署交易策略 (EA)

1. **准备 MT5 环境**：
   
   - 确保已安装 MetaTrader 5 终端并登录交易账户。
   - 确保 **"工具" -> "选项" -> "专家顾问"** 中已勾选 **"允许自动交易"** 和 **"允许 DLL 导入"** (如果使用了 DLL)。

2. **安装 EA**：
   
   - 将 `GMarket_0.21.mq5` 文件复制到 MT5 数据文件夹下的 `MQL5\Experts\` 目录中。（在 MT5 中点击 "文件" -> "打开数据文件夹" 即可找到）。
   - 在 MT5 "导航器" 面板中右键刷新，找到 `GMarket_0.21`。
   - 双击或拖拽 EA 到 `XAUUSD` (或其他品种) 的图表上。

3. **配置参数 (Inputs)**：
   
   - `InpIsPaused`: 初始是否暂停策略。
   - `InpMartinEnabled`: 是否开启马丁功能。
   - `InpNewsFilterEnabled`: 是否开启新闻过滤（推荐开启）。
   - 其他参数如首单手数 (`firstLots`)、马丁间距 (`martinInterval`) 等可根据资金量调整。
   - 点击 **确定** 启动 EA。图表左下角将显示状态面板，右下角显示控制按钮。

### 第二步：部署监控服务 (MCP Server) - 可选

如果您希望通过 AI Agent (如 Fay) 监控交易，请执行此步。

1. **环境要求**：
   
   - Windows 操作系统
   - Python 3.12+

2. **安装依赖**：
   
   ```bash
   pip install -r requirements.txt
   ```

3. **连接 AI Agent**：
   
   - **Claude Desktop**: 修改配置文件，添加 MCP Server 指向。
   
   - **Fay (数字人)**:
     
     1. 依照 https://github.com/xszyou/fay 安装并运行 Fay (记得给 Fay 点个 Star 哦)。
     
     2. 在 Fay 界面配置 MCP 服务器：
        
        ```json
        [
            {
                "id": 1,
                "name": "easy deal",
                "transport": "stdio",
                "command": "python",
                "args": [
                    "easydeal_mcp_server.py"
                ],
                "cwd": "D:/Projects/easy_deal_agent/easy-deal", 
                "env": {}
            }
        ]
        ```

---

## 账户开通及 MT5 下载教程

- 访问 exness 官网（可能需要 VPN，VPN 不能使用美国、伊朗、朝鲜、欧盟、英国）：https://one.exnessonelink.com/a/r6fx3vgje1

- 点击右上角登录 --> 开立账户 --> 注册 --> 个人专区
  
  - ![image-20251201164439332](image-20251201164439332.png)

- 我的账户 --> 模拟 --> 交易 --> Meta Trader 5（此处保存好交易账号信息及服务器信息）--> 下载安装 MT5 平台 --> 运行 exness5setup.exe --> 等待安装完成
  
  - ![image-20251201164751516](image-20251201164751516.png)
  - ![image-20251201165907714](image-20251201165907714.png)

- 运行 MT5 终端 --> 关闭开设账户弹窗 --> 导航栏 --> exness --> 账户 -- 右键 --> 登录到交易账户（注意，此处填写的登录名为上文选择 mt5 交易时记录的那串数字账号，服务器也需注意选择正确）
  
  - ![image-20251201171300979](image-20251201171300979.png)
  - 主窗口交闭除 XAUUSDm,H1 外的其他窗口，并全屏。（若关多了，可以在左侧交易品种右键重新打开交易窗口）
    - ![image-20251201171802594](image-20251201171802594.png)

- 选择 XAUUSDm 窗口并将 EA 拖入。

---

## MCP 工具列表 (For Agent)

| 工具名                          | 说明                          |
| ---------------------------- | --------------------------- |
| `get_trading_logs`           | 获取交易日志，支持按日期和类型（开仓/平仓/警告）筛选 |
| `get_trading_status`         | 获取账户资金、持仓摘要及 EA 运行状态        |
| `get_market_info`            | 获取当前品种实时行情（买卖价、点差）          |
| `get_config`                 | 获取当前监控配置参数                  |
| `get_strategy_documentation` | 获取策略逻辑说明文档                  |
| `get_profit_history`         | 获取指定天数内的收益历史统计              |
| `analyze_risk`               | AI 自动分析当前账户风险等级（基于浮亏比例）     |
| `get_position_details`       | 获取所有持仓订单的详细信息               |
| `update_config`              | 动态更新监控配置（如风控阈值、魔术号过滤等）      |
| `get_klines`                 | 获取 K 线/蜡烛图数据（支持多周期）         |
| `notify_owner`               | 通过数字人播报紧急消息                 |

## 许可证

本项目采用 GLP 3.0 许可证。

## 联系我们

![image-20251201173859002](image-20251201173859002.png)
注：群满加 qq467665317