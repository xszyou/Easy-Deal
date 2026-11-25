"""One-shot MT5 stats snapshot.

Spawned by electron/stats-collector.js every hour. Reads:
  - account_info()
  - positions_get()
  - history_deals_get(today_start..now)

and writes a single JSON object to stdout. Exits.

Env:
  EASYDEAL_MT5_INSTALL_DIR  configured executable directory
  EASYDEAL_MT5_DATA_DIR     configured data directory
  EASYDEAL_MT5_LAUNCH_MODE  portable | standard
"""

import json
import os
import sys
from datetime import datetime, timezone

# The bundled Windows embeddable Python uses an isolated ._pth file, which
# omits the executed script's directory.  Shared sibling modules must be made
# importable explicitly so packaged launches work from every working dir.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import mt5_lifecycle as _mt5_lifecycle

# Force unbuffered UTF-8 to play nice with Node parent's stdout pipe.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def fail(msg, **extra):
    sys.stdout.write(json.dumps({"ok": False, "error": msg, **extra},
                                ensure_ascii=False))
    sys.exit(0)


try:
    import MetaTrader5 as mt5
except ImportError:
    fail("MetaTrader5_module_not_installed: pip install MetaTrader5")


def _detect_portable_mode(install_dir):
    """Use explicit lifecycle configuration; never sniff mutable folders."""
    return _mt5_lifecycle.portable_for(install_dir)


def init_mt5():
    install_dir = os.environ.get("EASYDEAL_MT5_INSTALL_DIR") or ""
    terminal_path = None
    if install_dir:
        # Initialize against a specific terminal exe if provided.
        exe = os.path.join(install_dir, "terminal64.exe")
        if os.path.isfile(exe):
            terminal_path = exe
    if not _mt5_lifecycle.initialize_checked(mt5, path=terminal_path, retries=5):
        fail(f"mt5_attach_blocked: {_mt5_lifecycle.LAST_ERROR}")


def main():
    init_mt5()
    try:
        term = mt5.terminal_info()
        info = mt5.account_info()
        # terminal_info().connected = 终端跟券商交易服务器的连接状态 (跟「终端进程在不在跑」
        # 是两回事 — 进程在、但断网/掉线时这个为 False)。
        connected = bool(getattr(term, "connected", False)) if term else False
        now = datetime.now(timezone.utc)
        # Pull deals over a configurable lookback (default 30 days). The Node
        # collector slices per-EA by `deal.time >= last_loaded_at` to compute
        # "since this version was loaded" pnl/trades, so the lookback just
        # needs to reach far enough back to cover the oldest mounted EA's
        # last load. 30 days is a safe upper bound for active strategies.
        try:
            lookback_days = int(os.environ.get("EASYDEAL_STATS_LOOKBACK_DAYS", "30"))
        except ValueError:
            lookback_days = 30
        from datetime import timedelta
        since = now - timedelta(days=max(1, lookback_days))

        positions_raw = mt5.positions_get()
        deals_raw = mt5.history_deals_get(since, now)
        positions = positions_raw or []
        deals = deals_raw or []
        # ⚠ history_deals_get 取历史失败 (常见于跟券商断连) 返 None；连着但确实没成交返 []。
        # 之前 `or []` 把 None 也抹成「0 笔成交」→ ok:true 上传 → Node 按 0 deals 算
        # 每只 EA pnl/trades=0 → 上传 server → metric 归零 → UI 累计盈利变 0 / 收益率算歪。
        # 用户 + 本机实盘都踩过 MT5 断连后数据不准。
        deals_fetch_failed = deals_raw is None
        _err = mt5.last_error()

        # 埋点: 每次运行往 stderr 打一行连接状态 + 计数 (Node 父进程 proc.stderr 会捕获并 log)。
        sys.stderr.write(
            f"[stats_collector] connected={connected} "
            f"account={'yes' if info else 'NONE'} "
            f"positions={len(positions)} "
            f"deals={'FETCH_FAILED(None)' if deals_fetch_failed else len(deals)} "
            f"last_error={_err}\n"
        )

        # 闸门: 断连 / 拿不到账户 / 取历史失败 → 数据不可靠, 标 ok:false。
        # Node (stats-collector.js: `if(!j.ok) reject`) 会跳过本次上传 + 不重写本地 records,
        # 保留 server 上次好数据 (跟「MT5 没在跑就 skip snapshot」同款安全语义, 不会把统计归零)。
        if (not connected) or (info is None) or deals_fetch_failed:
            fail(
                f"mt5_disconnected_or_unreliable (connected={connected}, "
                f"account={'y' if info else 'n'}, deals_fetch_failed={deals_fetch_failed}, "
                f"last_error={_err})",
                connected=connected,
                account_present=(info is not None),
                deals_fetch_failed=deals_fetch_failed,
                positions_count=len(positions),
                mt5_last_error=str(_err),
                hint="MT5 跟券商断连/取历史失败 → 跳过本次快照, 不上传, 保留上次统计 (避免归零)",
            )

        out = {
            "ok": True,
            "connected": connected,
            "ts": int(now.timestamp()),
            "lookback_days": lookback_days,
            "account": ({
                "login":    info.login,
                "balance":  info.balance,
                "equity":   info.equity,
                "profit":   info.profit,
                "currency": info.currency,
                "server":   info.server,
            } if info else None),
            "positions": [
                {
                    "ticket": p.ticket, "magic": p.magic, "symbol": p.symbol,
                    "volume": p.volume, "type": p.type, "price_open": p.price_open,
                    "profit": p.profit, "swap": p.swap,
                }
                for p in positions
            ],
            "deals_count": len(deals),
            # Each deal's `time` is unix seconds (broker server time, often UTC).
            # Renamed `deals_today` → `deals` since it now spans the lookback window.
            "deals": [
                {
                    "ticket": d.ticket, "magic": d.magic, "symbol": d.symbol,
                    "volume": d.volume, "profit": d.profit, "swap": d.swap,
                    "commission": d.commission,
                    "time": d.time, "type": d.type, "entry": d.entry,
                }
                for d in deals
            ],
        }
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        fail(f"unexpected: {type(e).__name__}: {e}")
