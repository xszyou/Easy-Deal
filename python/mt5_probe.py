"""客户端诊断快照专用 — spawn 一次 Python，跑 mt5.initialize 后立刻调
terminal_info / account_info / symbols sample，把 SDK 实际看到的状态序列
化成 JSON 输出给 stdout。

用例：用户开了多个 MT5，SDK 不能保证 attach 到 path= 指定的那个 — 这里
跑一次实测，告诉 admin SDK 到底连上了哪个 broker / 哪个账号 / 有哪些品种。

入参从 env 读：
  EASYDEAL_MT5_INSTALL_DIR — 显式 path 锁定（同 main MCP）

输出 JSON 到 stdout：
  {
    ok: bool,
    init_error: str | null,
    requested_path: str | null,
    terminal: { path, data_path, build, name, company, connected, ... },
    account: { login, server, balance, currency, ... },
    symbols_total: int,
    symbols_sample: [str, ...]    // 前 30 个，含黄金 / 主流货币的方便排查
  }
"""
import json
import os
import sys

# The bundled Windows embeddable Python uses an isolated ._pth file, which
# omits the executed script's directory.  Shared sibling modules must be made
# importable explicitly so packaged launches work from every working dir.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import mt5_lifecycle as _mt5_lifecycle

# Node reads this process's stdout as UTF-8.  A piped stdout otherwise uses the
# ANSI code page, and json.dump(ensure_ascii=False) dies half-way through the
# document on the first character it cannot encode (account name, broker, ...).
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# 0.3.200: 防 mt5.initialize 自动 launch 用户刚关掉的 MT5. 跟 orderguard_server +
# easydeal_mcp_server 同款 helper. 用 psutil 看 install_dir 下的 terminal64.exe
# 进程在不在跑.
def _ezd_terminal_is_running(install_dir):
    return bool(_mt5_lifecycle.exact_terminal_pids(install_dir))


# 0.3.228: launch-flag lifecycle 检查 — 跟 orderguard_server / easydeal_mcp_server
# 同款 md5(install_dir.lower()) 算法, 让 admin probe 命令撞到 Python attach 流程
# 期间能跳过 mt5.initialize 不去干扰 in-flight attach.
def _ezd_launching_recent(install_dir, grace_sec=120.0):
    if not install_dir:
        return False
    try:
        import hashlib
        import time as _t
        h = hashlib.md5(install_dir.lower().encode("utf-8")).hexdigest()[:12]
        fname = f"mt5-launching-{h}.flag"
        candidates = []
        data_dir = os.getenv("EASYDEAL_DATA_DIR") or ""
        if data_dir:
            candidates.append(os.path.join(data_dir, fname))
        user_data = os.getenv("EASYDEAL_USER_DATA_DIR") or ""
        if user_data:
            candidates.append(os.path.join(user_data, "data", fname))
        for flag in candidates:
            if os.path.isfile(flag):
                age = _t.time() - os.path.getmtime(flag)
                if age < grace_sec:
                    return True
        return False
    except Exception:
        return False


def _safe_jsonable(obj):
    """MT5 SDK 返回的 named tuple → dict，过滤非 JSON-able 字段"""
    if obj is None:
        return None
    if hasattr(obj, "_asdict"):
        return _safe_jsonable(obj._asdict())
    if isinstance(obj, dict):
        return {k: _safe_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_safe_jsonable(x) for x in obj]
    if isinstance(obj, (str, int, float, bool, type(None))):
        return obj
    return str(obj)


def main():
    out = {"ok": False}
    try:
        import MetaTrader5 as mt5
    except Exception as e:
        out["init_error"] = f"import MetaTrader5 failed: {e}"
        json.dump(out, sys.stdout, ensure_ascii=False)
        return

    install_dir = os.getenv("EASYDEAL_MT5_INSTALL_DIR") or ""
    init_kwargs = {}
    requested_path = None
    if install_dir:
        for cand in ("terminal64.exe", "terminal.exe"):
            p = os.path.join(install_dir, cand)
            if os.path.isfile(p):
                init_kwargs["path"] = p
                requested_path = p
                break
    out["requested_path"] = requested_path

    # 0.3.200: install dir 不为空但 MT5 没在跑 → 直接返 "not_running" 不调 init,
    # 否则 SDK 会自动 launch 用户刚关掉的 MT5 (每小时 hourly diag 都会撞上).
    if install_dir and not _ezd_terminal_is_running(install_dir):
        out["init_error"] = "mt5_not_running — 实例未启动, 跳过 probe 避免自动拉起"
        out["ok"] = True   # 不是错误, 是用户主动关了 — ok=True 让 admin 别误报警
        out["skipped"] = "not_running"
        json.dump(out, sys.stdout, ensure_ascii=False)
        return

    if install_dir and _mt5_lifecycle.stopped_by_user(install_dir):
        out["init_error"] = "stopped_by_user — 实例处于用户停止状态"
        out["ok"] = True
        out["skipped"] = "stopped_by_user"
        json.dump(out, sys.stdout, ensure_ascii=False)
        return

    # 0.3.228: launch-flag 检查 — Node IPC 正在
    # spawn/attach 该 install_dir 的 MT5 时, probe 也跳过 (admin 触发的 hourly
    # diag 跟 attach 撞期会干扰 in-flight init). probe 不是关键路径, 跳过无影响.
    if (install_dir and _ezd_launching_recent(install_dir)
            and os.getenv("EASYDEAL_MT5_SUPERVISOR_VERIFY") != "1"):
        out["init_error"] = "mt5_attaching — Node/Python 正在 attach, 跳过 probe 避免干扰"
        out["ok"] = True
        out["skipped"] = "launching"
        json.dump(out, sys.stdout, ensure_ascii=False)
        return

    terminal_path = init_kwargs.get("path")
    if not _mt5_lifecycle.initialize_checked(mt5, path=terminal_path, retries=5):
        out["init_error"] = f"mt5 attach blocked: {_mt5_lifecycle.LAST_ERROR}"
        json.dump(out, sys.stdout, ensure_ascii=False)
        return

    # initialize_checked already retried and verified both path + data_path.
    out["bind_attempts"] = []
    if requested_path:
        ti0 = mt5.terminal_info()
        out["bind_attempts"].append({
            "attempt": 1,
            "actual_path": getattr(ti0, "path", None),
            "actual_data_path": getattr(ti0, "data_path", None),
            "matched": True,
        })

    try:
        ti = mt5.terminal_info()
        out["terminal"] = _safe_jsonable(ti)
    except Exception as e:
        out["terminal_err"] = str(e)

    try:
        ai = mt5.account_info()
        out["account"] = _safe_jsonable(ai)
    except Exception as e:
        out["account_err"] = str(e)

    try:
        total = mt5.symbols_total()
        out["symbols_total"] = total
        # 不抓全部 — 只抓前 30 个 + 含「XAU / Gold / EUR / USD」关键字的样本，
        # 让 admin 排查时能直接对比用户配的 monitor_symbols。
        all_syms = mt5.symbols_get() or []
        names = [s.name for s in all_syms[:200]]   # SDK call 可能很慢，cap 200
        sample = names[:30]
        # 关键词样本（去重）
        kws = ("xau", "gold", "eur", "usd", "btc")
        kw_hits = []
        seen = set(sample)
        for n in names:
            ln = n.lower()
            if any(k in ln for k in kws) and n not in seen:
                kw_hits.append(n)
                seen.add(n)
                if len(kw_hits) >= 30:
                    break
        out["symbols_sample"] = sample
        out["symbols_keyword_hits"] = kw_hits
    except Exception as e:
        out["symbols_err"] = str(e)

    out["ok"] = True
    try:
        mt5.shutdown()
    except Exception:
        pass
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
