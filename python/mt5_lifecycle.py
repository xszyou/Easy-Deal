"""Fail-closed MT5 SDK attachment helpers shared by all sidecars.

MetaTrader5.initialize(path=...) may start a terminal.  Background EasyDeal
services are attach-only, so they must prove that the exact executable is
already running and then verify both terminal_info.path and data_path.
"""

from __future__ import annotations

import hashlib
import os
import time
from typing import Any


LAST_ERROR = ""


def norm_path(value: Any) -> str:
    return os.path.normcase(os.path.normpath(str(value or ""))).rstrip("\\/")


def launch_allowed() -> bool:
    return os.getenv("EASYDEAL_MT5_ALLOW_LAUNCH", "0").strip() == "1"


def configured_launch_mode(
    install_dir: str = "",
    data_dir: str | None = None,
    launch_mode: str | None = None,
) -> str:
    """Resolve launch mode, allowing per-instance callers to bypass defaults.

    The MCP process environment describes the default MT5 instance.  Multi-MT5
    callers must pass the target instance's data directory and launch mode or a
    rebind would be validated against the default instance and fail closed.
    """
    mode = (
        launch_mode
        if launch_mode is not None
        else os.getenv("EASYDEAL_MT5_LAUNCH_MODE", "")
    ).strip().lower()
    if mode in ("portable", "standard"):
        return mode
    data_dir = (
        str(data_dir)
        if data_dir is not None
        else os.getenv("EASYDEAL_MT5_DATA_DIR", "")
    ).strip()
    if install_dir and data_dir:
        return "portable" if norm_path(install_dir) == norm_path(data_dir) else "standard"
    return "unverified"


def portable_for(install_dir: str) -> bool:
    return configured_launch_mode(install_dir) == "portable"


def validate_config(
    install_dir: str,
    data_dir: str = "",
    launch_mode: str | None = None,
):
    data_dir = data_dir or os.getenv("EASYDEAL_MT5_DATA_DIR", "").strip()
    mode = configured_launch_mode(install_dir, data_dir, launch_mode)
    if mode not in ("portable", "standard"):
        return False, "launch_mode_unverified"
    if not install_dir or not data_dir:
        return False, "install_or_data_dir_missing"
    if mode == "portable":
        if norm_path(install_dir) != norm_path(data_dir):
            return False, "portable_data_dir_mismatch"
        return True, ""
    if norm_path(install_dir) == norm_path(data_dir):
        return False, "standard_data_dir_equals_install_dir"
    origin_file = os.path.join(data_dir, "origin.txt")
    try:
        with open(origin_file, "r", encoding="utf-16") as handle:
            origin = handle.read().lstrip("\ufeff").strip()
    except Exception:
        return False, "standard_data_dir_origin_missing"
    if norm_path(origin) != norm_path(install_dir):
        return False, f"standard_data_dir_origin_mismatch expected={install_dir} actual={origin}"
    return True, ""


def _kill_flag_candidates(install_dir: str):
    digest = hashlib.md5(str(install_dir or "").lower().encode("utf-8")).hexdigest()[:12]
    name = f"mt5-killed-{digest}.flag"
    data_dir = os.getenv("EASYDEAL_DATA_DIR", "").strip()
    if data_dir:
        yield os.path.join(data_dir, name)
    user_data = os.getenv("EASYDEAL_USER_DATA_DIR", "").strip()
    if user_data:
        yield os.path.join(user_data, "data", name)


def _launch_flag_candidates(install_dir: str):
    digest = hashlib.md5(str(install_dir or "").lower().encode("utf-8")).hexdigest()[:12]
    name = f"mt5-launching-{digest}.flag"
    data_dir = os.getenv("EASYDEAL_DATA_DIR", "").strip()
    if data_dir:
        yield os.path.join(data_dir, name)
    user_data = os.getenv("EASYDEAL_USER_DATA_DIR", "").strip()
    if user_data:
        yield os.path.join(user_data, "data", name)


def stopped_by_user(install_dir: str) -> bool:
    if not install_dir:
        return False
    return any(os.path.isfile(p) for p in _kill_flag_candidates(install_dir))


def launch_in_progress(install_dir: str, max_age_sec: float = 300.0) -> bool:
    if not install_dir:
        return False
    now = time.time()
    for candidate in _launch_flag_candidates(install_dir):
        try:
            if os.path.isfile(candidate) and now - os.path.getmtime(candidate) < max_age_sec:
                return True
        except OSError:
            return True
    return False


def exact_terminal_pids(install_dir: str):
    """Return exact-path terminal PIDs.  Errors and unknown paths fail closed."""
    if not install_dir:
        return []
    try:
        import psutil
    except Exception:
        return []
    wanted = norm_path(install_dir)
    found = []
    try:
        for proc in psutil.process_iter(["pid", "name", "exe"]):
            try:
                name = (proc.info.get("name") or "").lower()
                if name not in ("terminal64.exe", "terminal.exe"):
                    continue
                exe = proc.info.get("exe") or ""
                if exe and norm_path(os.path.dirname(exe)) == wanted:
                    found.append(int(proc.info.get("pid") or proc.pid))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        return []
    return found


def all_terminal_pids():
    """Return every observable MT5 PID without relying on executable paths."""
    try:
        import psutil
    except Exception:
        return []
    found = []
    try:
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                if (proc.info.get("name") or "").lower() in ("terminal64.exe", "terminal.exe"):
                    found.append(int(proc.info.get("pid") or proc.pid))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        return []
    return found


def unreadable_terminal_pids():
    """MT5 PIDs whose executable path is hidden, typically an elevated terminal.

    exact_terminal_pids() skips these, so "not running" cannot be trusted for
    any instance while one exists.
    """
    try:
        import psutil
    except Exception:
        return []
    found = []
    try:
        for proc in psutil.process_iter(["pid", "name", "exe"]):
            try:
                name = (proc.info.get("name") or "").lower()
                if name in ("terminal64.exe", "terminal.exe") and not proc.info.get("exe"):
                    found.append(int(proc.info.get("pid") or proc.pid))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        return []
    return found


def terminal_process_age_sec(pid: int) -> float:
    """Return process age, or -1 when it cannot be proven safely."""
    try:
        import psutil
        return max(0.0, time.time() - float(psutil.Process(int(pid)).create_time()))
    except Exception:
        return -1.0


def _terminate_unexpected_pids(pids):
    """Remove only terminals that appeared during a prohibited SDK attach."""
    try:
        import psutil
    except Exception:
        return
    for pid in pids:
        try:
            proc = psutil.Process(int(pid))
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except psutil.TimeoutExpired:
                proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue


def any_terminal_running() -> bool:
    try:
        import psutil
    except Exception:
        return False
    try:
        for proc in psutil.process_iter(["name"]):
            try:
                if (proc.info.get("name") or "").lower() in ("terminal64.exe", "terminal.exe"):
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        return False
    return False


def validate_terminal_info(info, install_dir: str = "", data_dir: str = ""):
    if info is None:
        return False, "terminal_info_unavailable"
    actual_install = norm_path(getattr(info, "path", ""))
    actual_data = norm_path(getattr(info, "data_path", ""))
    if install_dir and actual_install != norm_path(install_dir):
        return False, f"install_path_mismatch expected={install_dir} actual={getattr(info, 'path', '')}"
    if data_dir and actual_data != norm_path(data_dir):
        return False, f"data_path_mismatch expected={data_dir} actual={getattr(info, 'data_path', '')}"
    return True, ""


def initialize_checked(
    mt5,
    path: str | None = None,
    retries: int = 0,
    data_dir: str | None = None,
    launch_mode: str | None = None,
    **extra,
) -> bool:
    """Attach to the configured instance and fail closed on identity mismatch."""
    global LAST_ERROR
    LAST_ERROR = ""
    install_dir = os.path.dirname(path) if path else os.getenv("EASYDEAL_MT5_INSTALL_DIR", "").strip()
    data_dir = (
        str(data_dir)
        if data_dir is not None
        else os.getenv("EASYDEAL_MT5_DATA_DIR", "")
    ).strip()
    allow_launch = launch_allowed()

    if install_dir:
        config_ok, config_error = validate_config(
            install_dir, data_dir, launch_mode
        )
        if not config_ok:
            LAST_ERROR = config_error
            return False

    if not allow_launch:
        if install_dir and stopped_by_user(install_dir):
            LAST_ERROR = "stopped_by_user"
            return False
        if install_dir:
            supervisor_verify = os.getenv("EASYDEAL_MT5_SUPERVISOR_VERIFY", "") == "1"
            explicit_owner = os.getenv("EASYDEAL_MT5_EXPLICIT_OWNER", "") == "1"
            if launch_in_progress(install_dir) and not (supervisor_verify or explicit_owner):
                LAST_ERROR = "launch_in_progress"
                return False
            before_pids = exact_terminal_pids(install_dir)
            if not before_pids:
                LAST_ERROR = "target_terminal_not_running"
                return False
            if len(before_pids) != 1:
                LAST_ERROR = f"multiple_target_terminals:{before_pids}"
                return False
            try:
                min_age = max(0.0, float(os.getenv("EASYDEAL_MT5_MIN_PROCESS_AGE_SEC", "60")))
            except ValueError:
                min_age = 60.0
            age = terminal_process_age_sec(before_pids[0])
            if age < min_age:
                LAST_ERROR = f"target_terminal_booting:age={age:.1f}:required={min_age:.1f}"
                return False
        elif not any_terminal_running():
            LAST_ERROR = "no_terminal_running"
            return False
        else:
            before_pids = []
    else:
        before_pids = []

    kwargs = dict(extra)
    if path is not None:
        kwargs["path"] = path
    if path and "portable" not in kwargs:
        mode = configured_launch_mode(install_dir, data_dir, launch_mode)
        if mode not in ("portable", "standard"):
            LAST_ERROR = "launch_mode_unverified"
            return False
        kwargs["portable"] = mode == "portable"

    attempts = max(0, int(retries)) + 1
    for attempt in range(attempts):
        if attempt and not allow_launch and install_dir and not exact_terminal_pids(install_dir):
            LAST_ERROR = "target_terminal_exited_during_retry"
            return False
        before_all_pids = set(all_terminal_pids()) | set(before_pids)
        initialized = mt5.initialize(**kwargs)
        if not allow_launch and install_dir:
            # The SDK may ignore the requested path and start the OS-default
            # terminal elsewhere, even when initialize() itself returns False.
            # Compare the global PID set so both outcomes are contained.
            unexpected = sorted(set(all_terminal_pids()) - before_all_pids)
            if unexpected:
                try:
                    mt5.shutdown()
                except Exception:
                    pass
                _terminate_unexpected_pids(unexpected)
                LAST_ERROR = f"unexpected_sdk_spawn:{unexpected}"
                return False
        if initialized:
            try:
                ok, reason = validate_terminal_info(mt5.terminal_info(), install_dir, data_dir)
            except Exception as exc:
                ok, reason = False, f"terminal_info_error:{exc}"
            if ok:
                return True
            LAST_ERROR = reason
            try:
                mt5.shutdown()
            except Exception:
                pass
        else:
            try:
                LAST_ERROR = f"initialize_failed:{mt5.last_error()}"
            except Exception:
                LAST_ERROR = "initialize_failed"
        if attempt + 1 < attempts:
            time.sleep(0.5)
    return False
