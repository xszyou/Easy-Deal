"""Talk to a running MT5 terminal's chart windows through Win32 messages.

Everything here posts the same commands MT5's own menus and title-bar
buttons send, so MT5 keeps its profile files consistent by itself.  Nothing
injects keystrokes or needs the terminal to be in the foreground.

Handles are plain ints.  Posting fails with access denied when MT5 runs
elevated and the caller does not (UIPI); callers surface that as an error.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes


WM_COMMAND = 0x0111
WM_SYSCOMMAND = 0x0112
WM_INITMENUPOPUP = 0x0117
SC_CLOSE = 0xF060
MF_BYPOSITION = 0x0400
MF_CHECKED = 0x0008
SMTO_ABORTIFHUNG = 0x0002
_NO_ITEM_ID = 0xFFFFFFFF

MAIN_CLASS_PREFIX = "MetaQuotes::MetaTrader"
MDI_CLIENT_CLASS = "MDIClient"

_ENUM_PROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
_user32 = None


def _u32():
    global _user32
    if _user32 is None:
        u = ctypes.WinDLL("user32", use_last_error=True)
        u.EnumWindows.argtypes = [_ENUM_PROC, wintypes.LPARAM]
        u.EnumChildWindows.argtypes = [wintypes.HWND, _ENUM_PROC, wintypes.LPARAM]
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetParent.argtypes = [wintypes.HWND]
        u.GetParent.restype = wintypes.HWND
        u.IsWindow.argtypes = [wintypes.HWND]
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsWindowEnabled.argtypes = [wintypes.HWND]
        u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        u.SendMessageTimeoutW.argtypes = [
            wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
            wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
        u.GetMenu.argtypes = [wintypes.HWND]
        u.GetMenu.restype = wintypes.HMENU
        u.GetSubMenu.argtypes = [wintypes.HMENU, ctypes.c_int]
        u.GetSubMenu.restype = wintypes.HMENU
        u.GetMenuItemCount.argtypes = [wintypes.HMENU]
        u.GetMenuItemID.argtypes = [wintypes.HMENU, ctypes.c_int]
        u.GetMenuItemID.restype = wintypes.UINT
        u.GetMenuStringW.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.LPWSTR,
                                     ctypes.c_int, wintypes.UINT]
        u.GetMenuState.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.UINT]
        u.GetMenuState.restype = wintypes.UINT
        _user32 = u
    return _user32


def _text(hwnd) -> str:
    u = _u32()
    length = u.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    u.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def _class(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    _u32().GetClassNameW(hwnd, buf, 255)
    return buf.value


def main_window(pid: int) -> int | None:
    """The terminal's main frame, or None while it is still starting."""
    u = _u32()
    found = []

    def visit(hwnd, _lparam):
        owner = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if (owner.value == pid and u.IsWindowVisible(hwnd)
                and _class(hwnd).startswith(MAIN_CLASS_PREFIX)):
            found.append(int(hwnd))
            return False
        return True

    u.EnumWindows(_ENUM_PROC(visit), 0)
    return found[0] if found else None


def is_enabled(hwnd: int) -> bool:
    """False while a modal dialog of the terminal holds the main frame."""
    return bool(_u32().IsWindowEnabled(hwnd))


def chart_windows(main: int) -> list[dict]:
    """Open chart windows as ``{"handle", "title"}``, in MT5's own order."""
    u = _u32()
    charts = []

    def visit(hwnd, _lparam):
        parent = u.GetParent(hwnd)
        if parent and _class(parent) == MDI_CLIENT_CLASS:
            charts.append({"handle": int(hwnd), "title": _text(hwnd)})
        return True

    u.EnumChildWindows(main, _ENUM_PROC(visit), 0)
    return charts


def _post(hwnd: int, message: int, wparam: int) -> None:
    if not _u32().PostMessageW(hwnd, message, wparam, 0):
        raise ctypes.WinError(ctypes.get_last_error())


def close_chart(handle: int) -> None:
    """Close one chart the way its title-bar X does.

    SC_CLOSE, not WM_CLOSE: only the system command runs MT5's bookkeeping
    that deletes the chart's .chr.  A bare WM_CLOSE leaves the file behind
    and the chart comes back on the next start.
    """
    if not _u32().IsWindow(handle):
        raise OSError(f"window {handle:#x} no longer exists")
    _post(handle, WM_SYSCOMMAND, SC_CLOSE)


def _menu_items(menu) -> list[dict]:
    u = _u32()
    items = []
    for position in range(max(u.GetMenuItemCount(menu), 0)):
        buf = ctypes.create_unicode_buffer(260)
        u.GetMenuStringW(menu, position, buf, 259, MF_BYPOSITION)
        state = u.GetMenuState(menu, position, MF_BYPOSITION)
        items.append({
            "command_id": u.GetMenuItemID(menu, position),
            "name": buf.value.replace("&", "").strip(),
            "checked": state != _NO_ITEM_ID and bool(state & MF_CHECKED),
        })
    return items


def profile_menu(main: int, profile_names) -> list[dict]:
    """Chart profiles as ``{"name", "command_id", "checked"}``; checked = loaded.

    The submenu is found by content, not by its localized caption: it sits
    directly under a top-level menu and has exactly one check-marked item
    named after a profile.  That also rules out the nested "Remove" submenu,
    which lists the same names but deletes them.
    """
    u = _u32()
    known = {str(name).casefold() for name in profile_names}
    bar = u.GetMenu(main)
    if not bar or not known:
        return []
    for top in range(max(u.GetMenuItemCount(bar), 0)):
        top_menu = u.GetSubMenu(bar, top)
        if not top_menu:
            continue
        for position in range(max(u.GetMenuItemCount(top_menu), 0)):
            submenu = u.GetSubMenu(top_menu, position)
            if not submenu:
                continue
            # MT5 refreshes the check mark only when the popup is initialised.
            result = ctypes.c_size_t()
            u.SendMessageTimeoutW(main, WM_INITMENUPOPUP, submenu, position,
                                  SMTO_ABORTIFHUNG, 2000, ctypes.byref(result))
            profiles = [item for item in _menu_items(submenu)
                        if item["command_id"] not in (0, _NO_ITEM_ID)
                        and item["name"].casefold() in known]
            if sum(1 for item in profiles if item["checked"]) == 1:
                return profiles
    return []


def select_profile(main: int, command_id: int) -> None:
    """Load a chart profile, as picking it from File > Profiles does."""
    _post(main, WM_COMMAND, command_id)
