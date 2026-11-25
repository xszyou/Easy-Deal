"""Read and edit MT5 chart profiles without starting MetaTrader.

MT5 keeps chart files below ``MQL5/Profiles/Charts/<ProfileLast>``.  Older
EasyDeal code looked in the MT4-style ``profiles/default/Last`` directory,
which made every remount look like a first mount and caused ``/config`` to
open a second chart for the same EA.

A profile directory holds one ``chartNN.chr`` per chart window plus
``order.wnd`` (window z-order, front-most first).  MT5 opens every ``.chr``
in the directory when it loads the profile, listed in ``order.wnd`` or not,
so the editing helpers below are only safe while the profile is not loaded.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path


# ENUM_TIMEFRAMES packs a unit (0 minutes, 1 hours, 2 weeks, 3 months) and a
# count; the .chr fields period_type / period_size are those two halves.  A
# day is 24 hours, which is why D1 is not a unit of its own.
PERIODS = {
    "M1": (0, 1), "M2": (0, 2), "M3": (0, 3), "M4": (0, 4), "M5": (0, 5),
    "M6": (0, 6), "M10": (0, 10), "M12": (0, 12), "M15": (0, 15),
    "M20": (0, 20), "M30": (0, 30),
    "H1": (1, 1), "H2": (1, 2), "H3": (1, 3), "H4": (1, 4), "H6": (1, 6),
    "H8": (1, 8), "H12": (1, 12),
    "D1": (1, 24), "W1": (2, 1), "MN1": (3, 1),
}
_PERIOD_BY_FIELDS = {fields: name for name, fields in PERIODS.items()}
# Chart window titles spell the three longest periods out.
_PERIOD_BY_TITLE = {"DAILY": "D1", "WEEKLY": "W1", "MONTHLY": "MN1"}

_CHART_FILE_RE = re.compile(r"^chart(\d+)\.chr$", re.I)
ORDER_FILE = "order.wnd"


def _decode_mt5_text(raw: bytes) -> str:
    if raw.startswith(b"\xff\xfe"):
        return raw[2:].decode("utf-16-le", "ignore")
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", "ignore")
    # Some MT5 files have no BOM but are still UTF-16 LE.
    if raw[:128].count(b"\x00") > max(2, len(raw[:128]) // 4):
        return raw.decode("utf-16-le", "ignore")
    return raw.decode("utf-8", "ignore")


def _read_profile_last(root: str) -> str | None:
    common_ini = Path(root) / "Config" / "common.ini"
    try:
        text = _decode_mt5_text(common_ini.read_bytes())
    except OSError:
        return None
    match = re.search(r"(?:^|\n)\s*ProfileLast\s*=\s*([^\r\n]+)", text, re.I)
    if not match:
        return None
    name = match.group(1).strip().strip('"')
    # A profile is a directory name, never an arbitrary path.
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        return None
    return name


def profile_chart_dirs(install_dir: str, data_dir: str | None = None) -> list[Path]:
    """Return active-profile chart directories in priority order.

    A configured data directory is authoritative.  Falling back to the
    executable directory when a different data directory is configured can
    read a stale portable profile and make the remount decision unsafe.
    """
    root = str(data_dir or install_dir or "").strip()
    if not root:
        return []

    active = _read_profile_last(root)
    current = Path(root) / "MQL5" / "Profiles" / "Charts" / (active or "Default")
    if current.is_dir():
        return [current]

    # ProfileLast can be stale after a manually removed profile.  Fall back
    # to Default only when the named active directory itself does not exist.
    default = Path(root) / "MQL5" / "Profiles" / "Charts" / "Default"
    if active and active.casefold() != "default" and default.is_dir():
        return [default]

    # Keep compatibility with profiles written by historical builds, but do
    # not mix these potentially stale locations with a valid current profile.
    candidates = [
        Path(root) / "profiles" / "default" / "Last",
        Path(root) / "profiles" / "Default" / "Last",
    ]

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = os.path.normcase(os.path.normpath(str(candidate)))
        if key not in seen:
            seen.add(key)
            if candidate.is_dir():
                unique.append(candidate)
    return unique


def chart_files(install_dir: str, data_dir: str | None = None) -> list[Path]:
    files: list[Path] = []
    seen: set[str] = set()
    for directory in profile_chart_dirs(install_dir, data_dir):
        try:
            entries = sorted(directory.iterdir(), key=lambda p: p.name.casefold())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_file() or entry.suffix.casefold() != ".chr":
                continue
            key = os.path.normcase(os.path.normpath(str(entry)))
            if key not in seen:
                seen.add(key)
                files.append(entry)
    return files


def _normalize_ea_name(value: str) -> str:
    name = str(value or "").strip().strip('"').replace("/", "\\")
    if name.casefold().startswith("experts\\"):
        name = name[len("experts\\"):]
    if name.casefold().endswith(".ex5"):
        name = name[:-4]
    return name.casefold()


def expert_names_from_text(text: str) -> list[str]:
    names: list[str] = []
    for match in re.finditer(r"<expert>([\s\S]*?)</expert>", text, re.I):
        block = match.group(1)
        name = re.search(r"(?:^|\n)\s*name\s*=\s*([^\r\n]+)", block, re.I)
        if name and _normalize_ea_name(name.group(1)):
            names.append(_normalize_ea_name(name.group(1)))
    return names


def find_ea_charts(install_dir: str, ea_name: str,
                   data_dir: str | None = None) -> list[Path]:
    target = _normalize_ea_name(ea_name)
    if not target:
        return []
    matches: list[Path] = []
    for chart in chart_files(install_dir, data_dir):
        try:
            names = expert_names_from_text(_decode_mt5_text(chart.read_bytes()))
        except OSError:
            continue
        if target in names:
            matches.append(chart)
    return matches


def chart_has_ea(install_dir: str, ea_name: str,
                 data_dir: str | None = None) -> bool:
    return bool(find_ea_charts(install_dir, ea_name, data_dir))


def count_mounted_experts(install_dir: str, data_dir: str | None = None) -> int:
    names: set[str] = set()
    for chart in chart_files(install_dir, data_dir):
        try:
            names.update(expert_names_from_text(_decode_mt5_text(chart.read_bytes())))
        except OSError:
            continue
    return len(names)


def plan_mount(install_dir: str, ea_name: str,
               data_dir: str | None = None) -> dict[str, object]:
    """Choose whether attachment may create a chart.

    Existing target charts always win, even for a single-EA profile.  This is
    the idempotency rule that keeps a remount on the original chart.
    """
    target_charts = find_ea_charts(install_dir, ea_name, data_dir)
    expert_count = count_mounted_experts(install_dir, data_dir)
    if target_charts:
        action = "reloaded_existing_chart"
        use_startup_ini = False
    elif expert_count >= 2:
        action = "restored_multi_ea_profile"
        use_startup_ini = False
    else:
        action = "created_new_chart"
        use_startup_ini = True
    return {
        "action": action,
        "use_startup_ini": use_startup_ini,
        "target_charts": [str(path) for path in target_charts],
        "expert_count": expert_count,
    }


def normalize_period(value) -> str | None:
    """Return the canonical period name (``H1``, ``D1`` ...) or None."""
    name = str(value or "").strip().upper()
    name = _PERIOD_BY_TITLE.get(name, name)
    return name if name in PERIODS else None


def period_from_fields(period_type, period_size) -> str:
    try:
        fields = (int(period_type), int(period_size))
    except (TypeError, ValueError):
        return ""
    return _PERIOD_BY_FIELDS.get(fields, f"{fields[0]}:{fields[1]}")


def parse_chart_title(title: str) -> tuple[str, str] | None:
    """Split a chart window title such as ``EURUSD,Daily`` into (symbol, period)."""
    symbol, sep, period = str(title or "").strip().rpartition(",")
    symbol, period = symbol.strip(), period.strip()
    if not sep or not symbol or not period:
        return None
    return symbol, normalize_period(period) or period


def profile_names(install_dir: str, data_dir: str | None = None) -> list[str]:
    root = str(data_dir or install_dir or "").strip()
    try:
        entries = sorted((Path(root) / "MQL5" / "Profiles" / "Charts").iterdir(),
                         key=lambda p: p.name.casefold())
    except OSError:
        return []
    return [entry.name for entry in entries if entry.is_dir()]


def named_profile_dir(install_dir: str, name: str,
                      data_dir: str | None = None) -> Path | None:
    """Resolve a profile by the name MT5 shows, matched case-insensitively."""
    root = str(data_dir or install_dir or "").strip()
    wanted = str(name or "").strip().casefold()
    for existing in profile_names(install_dir, data_dir):
        if existing.casefold() == wanted:
            return Path(root) / "MQL5" / "Profiles" / "Charts" / existing
    return None


def active_profile_dir(install_dir: str, data_dir: str | None = None) -> Path | None:
    """The profile MT5 loads on its next start, per ``ProfileLast``."""
    dirs = profile_chart_dirs(install_dir, data_dir)
    return dirs[0] if dirs else None


def _chart_field(text: str, key: str) -> str:
    # Chart-level fields precede the first nested block (<expert>, <window>).
    head = text.split("<expert>", 1)[0].split("<window>", 1)[0]
    match = re.search(rf"(?:^|\n)\s*{re.escape(key)}\s*=\s*([^\r\n]*)", head, re.I)
    return match.group(1).strip() if match else ""


def _chart_sort_key(path: Path):
    match = _CHART_FILE_RE.match(path.name)
    return (0, int(match.group(1)), "") if match else (1, 0, path.name.casefold())


_EXPERT_RE = re.compile(r"<expert>[\s\S]*?</expert>\r?\n?(?:\r?\n)?", re.I)


def read_expert(text: str) -> dict | None:
    """The EA attached to a chart: ``{"name", "path", "expertmode", "inputs"}``."""
    match = _EXPERT_RE.search(text)
    if not match:
        return None
    block = match.group(0)
    inputs = {}
    inputs_match = re.search(r"<inputs>([\s\S]*?)</inputs>", block, re.I)
    for line in (inputs_match.group(1) if inputs_match else "").splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip():
            inputs[key.strip()] = value.strip()
    head = block.split("<inputs>", 1)[0]

    def field(key):
        found = re.search(rf"(?:^|\n)\s*{key}\s*=\s*([^\r\n]*)", head, re.I)
        return found.group(1).strip() if found else ""

    return {"name": field("name"), "path": field("path"),
            "expertmode": field("expertmode"), "inputs": inputs}


def format_input_value(value) -> str:
    """Render an input value the way MT5 writes it into ``<inputs>``."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def expert_block_text(name: str, path: str, inputs=None) -> str:
    """An ``<expert>`` block with algo trading allowed for this chart.

    ``name`` is the bare EA name and ``path`` is relative to ``MQL5``; MT5
    resets the inputs to defaults when the two disagree.  Inputs MT5 does not
    know are dropped on its next save, missing ones get the EA's defaults.
    """
    lines = "".join(f"{key}={format_input_value(value)}\n"
                    for key, value in (inputs or {}).items())
    return (f"<expert>\nname={name}\npath={path}\nexpertmode=1\n"
            f"<inputs>\n{lines}</inputs>\n</expert>\n\n")


def set_chart_expert(text: str, block: str | None) -> str:
    """Return the chart text with its ``<expert>`` block replaced, added or removed.

    MT5 keeps the block between the chart-level fields and the first
    ``<window>``; a chart saved without price data has no ``<window>`` at all,
    so ``</chart>`` is the fallback anchor.
    """
    text = _EXPERT_RE.sub("", text, count=1)
    if not block:
        return text
    for anchor in ("<window>", "</chart>"):
        index = text.find(anchor)
        if index >= 0:
            return text[:index] + block + text[index:]
    return text + block


def write_chart_expert(path, block: str | None) -> None:
    path = Path(path)
    write_chart_file(path, set_chart_expert(_decode_mt5_text(path.read_bytes()), block))


def read_chart(path) -> dict | None:
    path = Path(path)
    try:
        text = _decode_mt5_text(path.read_bytes())
    except OSError:
        return None
    expert = read_expert(text)
    return {
        "file": path.name,
        "path": str(path),
        "chart_id": _chart_field(text, "id"),
        "symbol": _chart_field(text, "symbol"),
        "period": period_from_fields(_chart_field(text, "period_type"),
                                     _chart_field(text, "period_size")),
        "ea_name": (expert or {}).get("name") or None,
        "ea_path": (expert or {}).get("path") or None,
        "ea_inputs": (expert or {}).get("inputs") or {},
    }


def list_profile_charts(profile_dir) -> list[dict]:
    """Every chart MT5 will open from this profile, in file order."""
    try:
        files = [p for p in Path(profile_dir).iterdir()
                 if p.is_file() and p.suffix.casefold() == ".chr"]
    except OSError:
        return []
    charts = [read_chart(path) for path in sorted(files, key=_chart_sort_key)]
    return [chart for chart in charts if chart]


def _encode_mt5_text(text: str) -> bytes:
    normalized = text.replace("\r\n", "\n").replace("\n", "\r\n")
    return b"\xff\xfe" + normalized.encode("utf-16-le")


def _read_order(profile_dir: Path) -> list[str]:
    try:
        text = _decode_mt5_text((profile_dir / ORDER_FILE).read_bytes())
    except OSError:
        return []
    return [line.strip() for line in text.lstrip("﻿").splitlines() if line.strip()]


def _write_order(profile_dir: Path, names: list[str]) -> None:
    (profile_dir / ORDER_FILE).write_bytes(
        _encode_mt5_text("".join(f"{name}\n" for name in names)))


def new_chart_id(taken=()) -> int:
    """MT5 chart ids are FILETIME stamps; any unused 64-bit value works."""
    used = {str(value) for value in taken}
    chart_id = int((time.time() + 11644473600) * 10_000_000)
    while str(chart_id) in used:
        chart_id += 1
    return chart_id


def build_chart_text(symbol: str, period: str, *, chart_id: int | None = None,
                     expert: str | None = None,
                     description: str | None = None) -> str:
    """Text of a default-looking chart, optionally with an ``<expert>`` block.

    MT5 recomputes the symbol-dependent fields (digits, scale) on load.
    """
    period_name = normalize_period(period)
    if not period_name:
        raise ValueError(f"unsupported period: {period}")
    period_type, period_size = PERIODS[period_name]
    if chart_id is None:
        chart_id = new_chart_id()
    expert = expert or ""
    return f"""<chart>
id={chart_id}
symbol={symbol}
description={description or f"{symbol} chart"}
period_type={period_type}
period_size={period_size}
digits=2
tick_size=0.010000
position_time=0
scale_fix=0
scale_fixed_min=0.000000
scale_fixed_max=0.000000
scale_fix11=0
scale_bar=0
scale_bar_val=1.000000
scale=16
mode=1
fore=0
grid=1
volume=1
scroll=1
shift=0
shift_size=19.279279
fixed_pos=0.000000
ticker=1
ohlc=0
one_click=0
one_click_btn=1
bidline=1
askline=0
lastline=0
days=0
descriptions=0
tradelines=1
tradehistory=1
window_left=0
window_top=0
window_right=0
window_bottom=0
window_type=1
floating=0
floating_left=0
floating_top=0
floating_right=0
floating_bottom=0
floating_type=1
floating_toolbar=1
floating_tbstate=
background_color=0
foreground_color=16777215
barup_color=65280
bardown_color=65280
bullcandle_color=0
bearcandle_color=16777215
chartline_color=65280
volumes_color=3329330
grid_color=10061943
bidline_color=10061943
askline_color=255
lastline_color=49152
stops_color=255
windows_total=1

{expert}<window>
height=100.000000
objects=0

<indicator>
name=Main
path=
apply=1
show_data=1
scale_inherit=0
scale_line=0
scale_line_percent=50
scale_line_value=0.000000
scale_fix_min=0
scale_fix_min_val=0.000000
scale_fix_max=0
scale_fix_max_val=0.000000
expertmode=0
fixed_height=-1
</indicator>
</window>
</chart>
"""


def write_chart_file(path, text: str) -> None:
    """MT5 only accepts chart and template files as UTF-16 LE + BOM, CRLF."""
    Path(path).write_bytes(_encode_mt5_text(text))


def add_charts(profile_dir, specs) -> list[dict]:
    """Append one chart per ``{"symbol", "period", "expert"?}`` spec to an unloaded profile.

    Existing charts are left untouched, so calling this again adds more.
    """
    profile_dir = Path(profile_dir)
    profile_dir.mkdir(parents=True, exist_ok=True)
    existing = list_profile_charts(profile_dir)
    taken_ids = [chart["chart_id"] for chart in existing]
    index = max((int(m.group(1)) for m in
                 (_CHART_FILE_RE.match(chart["file"]) for chart in existing) if m),
                default=0)
    added = []
    for spec in specs:
        index += 1
        chart_id = new_chart_id(taken_ids)
        taken_ids.append(chart_id)
        path = profile_dir / f"chart{index:02d}.chr"
        write_chart_file(path, build_chart_text(
            spec["symbol"], spec["period"], chart_id=chart_id, expert=spec.get("expert")))
        added.append(read_chart(path))
    if added:
        # Newest first, so the charts just opened end up in front.
        names = [chart["file"] for chart in reversed(added)]
        _write_order(profile_dir, names + [
            name for name in _read_order(profile_dir) if name not in names])
    return added


def remove_charts(profile_dir, files) -> list[dict]:
    """Delete the named chart files from an unloaded profile.

    The survivors are renumbered ``chart01..chartNN`` so the directory looks
    like one MT5 saved itself, and ``order.wnd`` follows the renames.
    """
    profile_dir = Path(profile_dir)
    wanted = {str(name).casefold() for name in files}
    charts = list_profile_charts(profile_dir)
    removed = [chart for chart in charts if chart["file"].casefold() in wanted]
    if not removed:
        return []
    for chart in removed:
        Path(chart["path"]).unlink()
    kept = [chart for chart in charts if chart["file"].casefold() not in wanted]
    renames = {}
    for index, chart in enumerate(kept, start=1):
        target = f"chart{index:02d}.chr"
        if chart["file"] != target:
            renames[chart["file"]] = target
    # Two passes through temporary names: a target may still be occupied.
    for old in renames:
        (profile_dir / old).rename(profile_dir / f"{old}.moving")
    for old, new in renames.items():
        (profile_dir / f"{old}.moving").rename(profile_dir / new)
    final = [renames.get(chart["file"], chart["file"]) for chart in kept]
    order = [renames.get(name, name) for name in _read_order(profile_dir)
             if name.casefold() not in wanted]
    order = [name for name in order if name in final]
    _write_order(profile_dir, order + [name for name in final if name not in order])
    return removed
