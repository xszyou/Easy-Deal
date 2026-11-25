"""Generate the EasyDeal app icon variants from pure-Python geometry.

Outputs:
  - assets/icon-16.png, icon-24.png, icon-32.png, icon-48.png, icon-64.png,
    icon-128.png, icon-256.png  (also icon-512.png for HiDPI)
  - assets/app.ico            (multi-size Windows icon, sizes 16..256)
  - assets/tray.png           (32x32, used by the tray)
  - assets/tray@2x.png        (64x64 for HiDPI)

Why not render the SVG with cairosvg / wand?
  Avoiding extra system deps (cairo, gs). The logo is geometric — a rounded
  square + a chevron + a baseline — so PIL.ImageDraw can reproduce it
  faithfully at any size with crisp edges and proper antialiasing.

Run: python assets/build_icons.py
"""
import math
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# ----- Brand tokens -----
BG_TOP    = (0xFF, 0x73, 0x73, 0xFF)   # #FF7373 (gradient start)
BG_BOTTOM = (0xE8, 0x4F, 0x4F, 0xFF)   # #E84F4F (gradient end)
FG        = (0xFF, 0xFF, 0xFF, 0xFF)   # white chevron / baseline
BASELINE  = (0xFF, 0xFF, 0xFF, 0xEC)   # baseline 92% alpha


def render(size: int) -> Image.Image:
    """Render the icon at the given square size (px)."""
    # Render at 4× supersampling then downsample to get crisp anti-aliasing
    # for very small sizes (16 / 24).
    ss = 4 if size <= 64 else 2
    px = size * ss

    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = int(px * 0.22)
    _rounded_rect_gradient(img, draw, px, radius)

    # Chevron geometry — proportional to canvas
    cx = px / 2
    arrow_top_y    = px * 0.31
    arrow_bot_y    = px * 0.56
    arrow_half_w   = px * 0.25
    stroke_w       = max(1, int(px * 0.11))
    baseline_y     = px * 0.72
    baseline_x0    = px * 0.25
    baseline_x1    = px * 0.75
    baseline_w     = max(1, int(px * 0.085))

    # Up chevron: two rounded line segments meeting at the top
    p_left   = (cx - arrow_half_w, arrow_bot_y)
    p_top    = (cx,                arrow_top_y)
    p_right  = (cx + arrow_half_w, arrow_bot_y)
    _rounded_line(draw, p_left,  p_top,   stroke_w, FG)
    _rounded_line(draw, p_top,   p_right, stroke_w, FG)
    # Round caps at the three control points
    for pt in (p_left, p_top, p_right):
        _disc(draw, pt, stroke_w / 2, FG)

    # Baseline
    _rounded_line(draw, (baseline_x0, baseline_y),
                       (baseline_x1, baseline_y), baseline_w, BASELINE)
    _disc(draw, (baseline_x0, baseline_y), baseline_w / 2, BASELINE)
    _disc(draw, (baseline_x1, baseline_y), baseline_w / 2, BASELINE)

    if ss != 1:
        img = img.resize((size, size), Image.LANCZOS)
    return img


def _rounded_rect_gradient(img: Image.Image, draw: ImageDraw.ImageDraw,
                           size: int, radius: int) -> None:
    """Fill a rounded square with a vertical gradient (top → bottom)."""
    # Start with a transparent layer, draw rect, then paint gradient inside.
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(BG_TOP[0] * (1 - t) + BG_BOTTOM[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOTTOM[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOTTOM[2] * t)
        grad.putpixel((0, y), (r, g, b, 255))
    grad = grad.resize((size, size))

    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)

    img.paste(grad, (0, 0), mask)


def _rounded_line(draw: ImageDraw.ImageDraw, p0, p1, width: int, color) -> None:
    """Draw an anti-aliased thick line. PIL's `line` is OK for this; the
    rounded caps are added separately as discs at endpoints."""
    draw.line([p0, p1], fill=color, width=width)


def _disc(draw: ImageDraw.ImageDraw, center, radius: float, color) -> None:
    cx, cy = center
    r = max(1, radius)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)


def main() -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256, 512]
    images = {}
    for s in sizes:
        img = render(s)
        images[s] = img
        out = os.path.join(OUT_DIR, f"icon-{s}.png")
        img.save(out, "PNG")
        print(f"wrote {out}")

    # Multi-resolution Windows .ico
    ico_sizes = [(s, s) for s in [16, 24, 32, 48, 64, 128, 256]]
    ico_path = os.path.join(OUT_DIR, "app.ico")
    images[256].save(ico_path, format="ICO", sizes=ico_sizes)
    print(f"wrote {ico_path}")

    # Tray (1× + 2× HiDPI)
    images[32].save(os.path.join(OUT_DIR, "tray.png"))
    images[64].save(os.path.join(OUT_DIR, "tray@2x.png"))
    # Tray .ico for the Windows tray API which prefers .ico
    images[32].save(os.path.join(OUT_DIR, "tray.ico"),
                    format="ICO", sizes=[(16, 16), (24, 24), (32, 32)])
    print("wrote tray.png / tray@2x.png / tray.ico")


if __name__ == "__main__":
    main()
