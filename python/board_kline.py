"""数据大屏 K 线取数(MCP 工具 get_board_klines 的实现, 由 electron/mobile-relay.js 调用)。

序列号授权给了数据大屏时, 桌面把各 MT5 实例 EA 窗口的品种去重后上传 K 线。这里只管从 MT5 取:
- 每个品种一次取 M1 / M5 / M15 / H1 / D1 五个原生周期(不做聚合), 另取 D1 最后两根给出券商当日 开/高/低/昨收;
- MT5 的时间戳是券商服务器墙上时间, 统一减去券商偏移换成 UTC 秒。偏移探测不到(休市)时用调用方带来的
  上次值; 都没有(新账号第一次就赶上休市)也照传, 暂按偏移 0(服务器时间当 UTC), 开盘探到真偏移后整段重传;
  D1 例外, 不减偏移: t = 券商日期的 UTC 0 点(日线按日期认, 不随券商时区 / 夏令时漂移, 大屏只显示日期);
- since 给了某周期服务端已有的最后一根时, 只取那根起的增量(那根可能还在走, 要带上);
- 这次用的偏移跟该品种上次上传用的不一样(暂定值换成真偏移 / 夏令时)→ 服务端已有的时间全错位了,
  忽略 since 整段重取(full), 不能把两套时间拼在一起。

不 import MetaTrader5: mt5 模块、实例切换、偏移探测都由调用方注入, 这样能在任意平台单测。
"""
from __future__ import annotations

import math
import time
from contextlib import AbstractContextManager
from typing import Any, Callable

TIMEFRAMES = {"M1": 60, "M5": 300, "M15": 900, "H1": 3600, "D1": 86400}
KEEP_BARS = 500          # 与服务端 board_kline.KEEP_BARS 一致
FALLBACK_OFFSET = 0      # 券商偏移完全未知时的暂定值: 服务器时间当 UTC


class TickOffset:
    """用新鲜 tick 反推券商偏移(秒, 服务器时间 - UTC, 取整到 30 分钟), 按券商记住最后一次探到的。

    难点是认出「新鲜」: 休市后最后一个 tick 越来越旧, tick.time - now 会被当成一个更小的偏移
    (收盘 1 小时后看就是少 1 小时)。所以只在能确定 tick 刚到时才采信:
    - 跟上次看到的不是同一个 tick, 且上次是 RECHECK_SEC 内看的 → 它是这期间到的;
    - 没有近期的对照(第一次看)→ 只有 tick.time - now 贴着半小时整数倍(±SNAP_SEC)才采信;
    - 一直是同一个 tick → 没有新行情, 沿用记住的(没有就是 None)。
    """
    RECHECK_SEC = 600
    SNAP_SEC = 90

    def __init__(self, mt5, server_key: Callable[[], str], now: Callable[[], float] = time.time):
        self._mt5, self._server_key, self._now = mt5, server_key, now
        self._seen: dict[tuple, tuple] = {}      # (券商, 品种) → (tick 时刻 ms, 上次看的时刻)
        self._known: dict[str, int] = {}         # 券商 → 偏移

    def __call__(self, symbol: str) -> int | None:
        key = self._server_key()
        try:
            tick = self._mt5.symbol_info_tick(symbol)
        except Exception:
            tick = None
        if tick is not None and getattr(tick, "time", 0):
            now = self._now()
            stamp = getattr(tick, "time_msc", 0) or int(tick.time) * 1000
            seen = self._seen.get((key, symbol))
            self._seen[(key, symbol)] = (stamp, now)
            if seen is None or seen[0] != stamp:
                raw = int(tick.time) - now
                off = int(round(raw / 1800.0) * 1800)
                arrived = seen is not None and now - seen[1] <= self.RECHECK_SEC
                if abs(off) <= 15 * 3600 and (arrived or abs(raw - off) <= self.SNAP_SEC):
                    self._known[key] = off
        return self._known.get(key)


def fetch_count(since: int | None, period_sec: int, now: float, keep: int = KEEP_BARS) -> int:
    """要从最新一根往回取多少根: 没有 since → 整段; 有 → 覆盖 since 那根到现在(多取 2 根兜时钟误差)。"""
    if not since:
        return keep
    return max(2, min(keep, math.ceil((now - since) / period_sec) + 2))


def rates_to_bars(rates, offset_sec: int, since: int | None = None) -> list[list[float]]:
    """MT5 rates(券商时间)→ [[t(UTC 秒), o, h, l, c, 成交量], …] 旧→新, 只留 t ≥ since 的。"""
    out = []
    for r in rates if rates is not None else ():
        t = int(r["time"]) - offset_sec
        if since and t < since:
            continue
        out.append([t, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                    int(r["tick_volume"])])
    return out


def day_quote(d1_rates) -> dict | None:
    """D1 最后两根 → 今开 / 最高 / 最低 / 昨收(只有一根时没有昨收)。"""
    if d1_rates is None or len(d1_rates) == 0:
        return None
    today = d1_rates[-1]
    prev = d1_rates[-2] if len(d1_rates) >= 2 else None
    return {"open": float(today["open"]), "high": float(today["high"]), "low": float(today["low"]),
            "prev_close": float(prev["close"]) if prev is not None else None}


def _fetch_symbol(mt5, tf_consts: dict, symbol: str, since: dict | None, offset: int, now: float,
                  prev_offset: int | None = None) -> dict | None:
    info = mt5.symbol_info(symbol)
    if info is None:
        return None
    rebase = prev_offset is not None and int(prev_offset) != offset     # 时间基准变了 → 整段重取
    if rebase:
        since = None
    bars = {}
    for tf, period in TIMEFRAMES.items():
        start = (since or {}).get(tf)
        rates = mt5.copy_rates_from_pos(symbol, tf_consts[tf], 0, fetch_count(start, period, now))
        rows = rates_to_bars(rates, 0 if tf == "D1" else offset, start)
        if rows:
            bars[tf] = rows
    if not bars:
        return None
    return {"symbol": symbol, "digits": int(getattr(info, "digits", 0) or 0), "bars": bars,
            "day": day_quote(mt5.copy_rates_from_pos(symbol, tf_consts["D1"], 0, 2)),
            "offset": offset, "full": rebase}


def collect(requests: list[dict], *, mt5, tf_consts: dict,
            instance: Callable[[Any], AbstractContextManager],
            broker_offset: Callable[[str], int | None],
            offset_hints: dict | None = None, now: Callable[[], float] = time.time) -> dict:
    """requests: [{symbol, instances: [实例 id(None=默认实例), …], since: {周期: t} | None,
                   offset: 该品种上次上传用的偏移(可省)}]
    (调用方已按品种去重)。每个品种先在第一个实例取, 取不到(实例没开 / 没这个品种)再换下一个。
    → {symbols: [{symbol, digits, instance_id, bars: {周期: […]}, day, offset: 这次用的偏移, full: 整段重取了}],
       offsets: {实例: 秒}(只有探到 / 沿用的, 不含暂定值), errors: […]}"""
    hints = dict(offset_hints or {})
    pending = [{**r, "_left": list(r.get("instances") or [None])} for r in requests if r.get("symbol")]
    done: list[dict] = []
    offsets: dict[str, int] = {}
    errors: list[str] = []
    while pending:
        # 按当前候选实例分组, 一个实例只切一次
        groups: dict[Any, list[dict]] = {}
        for r in pending:
            groups.setdefault(r["_left"].pop(0), []).append(r)
        pending = []
        for inst_id, reqs in groups.items():
            ikey = inst_id or "default"
            got: set[str] = set()
            try:
                with instance(inst_id):
                    offset = None
                    for r in reqs:
                        offset = broker_offset(r["symbol"])
                        if offset is not None:
                            break
                    if offset is None:
                        offset = hints.get(ikey)
                    if offset is None:
                        offset = FALLBACK_OFFSET
                        errors.append(f"{ikey}: 券商时区未知(休市且没有上次的偏移), 暂按服务器时间上传, 探到后整段重传")
                    else:
                        offsets[ikey] = int(offset)
                    for r in reqs:
                        item = _fetch_symbol(mt5, tf_consts, r["symbol"], r.get("since"), int(offset), now(),
                                             r.get("offset"))
                        if item:
                            done.append({**item, "instance_id": inst_id})
                            got.add(r["symbol"])
            except Exception as e:                     # 实例没开 / 切换失败 → 这批品种换下一个实例
                errors.append(f"{ikey}: {e}")
            pending += [r for r in reqs if r["symbol"] not in got and r["_left"]]
    order = {r["symbol"]: i for i, r in enumerate(requests)}
    done.sort(key=lambda x: order.get(x["symbol"], 0))
    return {"symbols": done, "offsets": offsets, "errors": errors}
