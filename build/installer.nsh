; EasyDeal 社区版自定义 NSIS macro — 装新版 / 卸载之前先结束正在跑的社区版
; 进程（main + 它 spawn 的 python sidecar / node），否则替换安装目录文件会因
; file-in-use 失败。
;
; 只按社区版自己的可执行文件名和安装目录名匹配：同一台电脑上可能装着商业版
; EasyDeal（EasyDeal.exe），它可能正在跑真实资金，绝不能被这里误杀。
; taskkill 不带 /T：EasyDeal 通过 MT5 SDK 启动的 terminal64.exe 是它的进程树
; 后代，带 /T 会把用户正在交易的 MT5 一起杀掉。

!macro customInit
  DetailPrint "结束运行中的 EasyDeal 社区版进程 (保留 MT5)..."
  nsExec::Exec 'taskkill /F /IM "EasyDealCommunity.exe"'
  nsExec::Exec 'wmic process where "name=\'python.exe\' and commandline like \'%easydeal-community%\'" call terminate'
  nsExec::Exec 'wmic process where "name=\'pythonw.exe\' and commandline like \'%easydeal-community%\'" call terminate'
  nsExec::Exec 'wmic process where "name=\'node.exe\' and commandline like \'%easydeal-community%\'" call terminate'
  Sleep 2000
!macroend

!macro customInstall
  nsExec::Exec 'taskkill /F /IM "EasyDealCommunity.exe"'
  Sleep 500
!macroend

!macro customUnInit
  DetailPrint "结束运行中的 EasyDeal 社区版进程 (保留 MT5)..."
  nsExec::Exec 'taskkill /F /IM "EasyDealCommunity.exe"'
  nsExec::Exec 'wmic process where "name=\'python.exe\' and commandline like \'%easydeal-community%\'" call terminate'
  nsExec::Exec 'wmic process where "name=\'pythonw.exe\' and commandline like \'%easydeal-community%\'" call terminate'
  nsExec::Exec 'wmic process where "name=\'node.exe\' and commandline like \'%easydeal-community%\'" call terminate'
  Sleep 2000
!macroend

Function .onInstSuccess
  Exec '"$INSTDIR\EasyDealCommunity.exe"'
FunctionEnd
