#!/usr/bin/env python3
"""Generate AC-UST extension icons — pure stdlib (no Pillow).

Design:
- Concept: one cycle arrow = PWM automation; a centered snowflake = AC
- Toolbar geometry is authored for 16px first, then rendered at native
    20/24/32/48px sizes for high-DPI browser scaling
- Palette: HKUST blue & gold (university colours, per Wikipedia
  infobox; blue ≈ Pantone 295C, gold ≈ Pantone 116C approximations)
- Squircle tile, 12.5% transparent padding (16px at 128, satisfying
  test/verify-icon.py padding check)
- Toolbar icons use a transparent background and nearly the full canvas;
    store/extension-list icons keep the branded squircle tile

Usage:
  python3 tools/gen-icon.py                # candidate sheet → $TMPDIR
    python3 tools/gen-icon.py apply [NAME]   # write brand + toolbar icons
"""

import math
import os
import struct
import sys
import zlib

NAVY = (0x00, 0x2F, 0x6C)   # HKUST blue ≈ Pantone 295C
GOLD = (0xFF, 0xCD, 0x00)   # HKUST gold ≈ Pantone 116C
WHITE = (0xFF, 0xFF, 0xFF)

SS = 8            # supersample factor per axis
SQUIRCLE_N = 4.5  # superellipse exponent ≈ Apple continuous-corner squircle
TILE_FRAC = 0.75  # tile width / canvas width (96/128 → 16px padding at 128)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Minimum stroke full-width per output size: small sizes get bolder
# geometry instead of a blur of sub-pixel lines.
MIN_W = {128: 0.0, 48: 2.6, 32: 2.0, 24: 1.5, 20: 1.25, 16: 1.0}


# ---------------------------------------------------------------- shapes
# A layer is (shape, color_key); color_key: 'W' white, 'G' gold,
# 'N' navy, 'T' tile colour (knockout). Shapes use a 128×128 canvas
# with glyph center at (0,0), y down, scaled by size/128.

def cap(x1, y1, x2, y2, r):
    return ('cap', x1, y1, x2, y2, r)


def disc(cx, cy, r):
    return ('disc', cx, cy, r)


def elli(cx, cy, ax, ay, n=4.0):
    return ('elli', cx, cy, ax, ay, n)


def arc(cx, cy, r, w, a0, span):
    """Stroke along an arc. Angles in degrees, y-down (90° = bottom).
    span may be negative (reverse direction). Round cap at a0 only."""
    return ('arc', cx, cy, r, w, a0, span)


def tri(ax, ay, bx, by, cx, cy):
    return ('tri', ax, ay, bx, by, cx, cy)


def arrow_at(cx, cy, r, theta_deg, length, width):
    """Arrowhead triangle at arc end, pointing along the tangent of
    increasing angle."""
    t = math.radians(theta_deg)
    px, py = cx + r * math.cos(t), cy + r * math.sin(t)
    tx_, ty_ = -math.sin(t), math.cos(t)          # tangent (increasing θ)
    nx, ny = math.cos(t), math.sin(t)             # radial normal
    ax, ay = px + tx_ * length, py + ty_ * length
    bx, by = px + nx * width / 2, py + ny * width / 2
    cx2, cy2 = px - nx * width / 2, py - ny * width / 2
    return tri(ax, ay, bx, by, cx2, cy2)


def snowflake(key, radius, width):
    """Three crossing strokes forming a six-arm snowflake."""
    layers = []
    for angle in (0, 60, 120):
        t = math.radians(angle)
        dx, dy = radius * math.cos(t), radius * math.sin(t)
        layers.append((cap(-dx, -dy, dx, dy, width / 2), key))
    return layers


def _cycle2(arc_key, head_key, r=26.0, w=7.6, head_l=17.0, head_w=19.0):
    """Two chase arrows: arcs at top/bottom, oversized heads."""
    return [
        (arc(0, 0, r, w, 155, 200), arc_key),
        (arc(0, 0, r, w, 335, 200), arc_key),
        (arrow_at(0, 0, r, 355, head_l, head_w), head_key),
        (arrow_at(0, 0, r, 175, head_l, head_w), head_key),
    ]


def concept_cycle2_duotone(_size):
    """Navy tile, white arcs, gold heads — colour-separated arrowheads."""
    return NAVY, _cycle2('W', 'G')


def concept_cycle1_duotone(_size):
    """Navy tile, single 300° arc + one big gold head (simplest)."""
    r, w = 27.0, 8.0
    layers = [
        (arc(0, 0, r, w, 60, 300), 'W'),
        (arrow_at(0, 0, r, 0, 19.0, 21.0), 'G'),
    ]
    return NAVY, layers


def concept_cycle2_allgold(_size):
    """Navy tile, whole cycle glyph in gold."""
    return NAVY, _cycle2('G', 'G')


def concept_cycle2_inverted(_size):
    """Gold tile, navy glyph (inverted HKUST pairing)."""
    return GOLD, _cycle2('N', 'N')


def concept_snow_cycle(_size):
    """Branded tile with a cycle arrow surrounding an AC snowflake."""
    layers = [
        (arc(0, 0, 29, 8, 60, 270), 'W'),
        (arrow_at(0, 0, 29, 330, 18, 20), 'G'),
    ]
    layers.extend(snowflake('G', 15, 5))
    return NAVY, layers


def concept_toolbar_snow_cycle(size):
    """Transparent, full-canvas cycle/snowflake mark for browser chrome."""
    layers = [
        (arc(0, 0, 43, 24, 60, 270), 'W'),
        (arc(0, 0, 43, 15, 60, 270), 'N'),
        (arrow_at(0, 0, 43, 330, 28, 30), 'N'),
        (arrow_at(0, 0, 43, 330, 20, 19), 'G'),
    ]
    if size <= 16:
        snow_outer = (25, 16)
        snow_inner = (22, 9)
    elif size <= 20:
        snow_outer = (23, 15)
        snow_inner = (20, 8)
    else:
        snow_outer = (19, 13)
        snow_inner = (16, 6)
    layers.extend(snowflake('N', *snow_outer))
    layers.extend(snowflake('G', *snow_inner))
    return None, layers


CONCEPTS = {
    'snow-cycle': concept_snow_cycle,
    'cycle2-duotone': concept_cycle2_duotone,
    'cycle1-duotone': concept_cycle1_duotone,
    'cycle2-allgold': concept_cycle2_allgold,
    'cycle2-inverted': concept_cycle2_inverted,
}
PREVIEW_CONCEPTS = {
    'toolbar-snow-cycle': concept_toolbar_snow_cycle,
    **CONCEPTS,
}

# The concept that produced the shipped icons/.
CURRENT_CONCEPT = 'snow-cycle'

COLOR_KEYS = {'W': WHITE, 'G': GOLD, 'N': NAVY}


# ------------------------------------------------------------ rasterizer

def _angle_in(theta, a0, span):
    d = (theta - a0) % 360.0
    if span >= 0:
        return d <= span
    return d >= 360.0 + span


def covers(shape, x, y):
    kind = shape[0]
    if kind == 'cap':
        _, x1, y1, x2, y2, r = shape
        dx, dy = x2 - x1, y2 - y1
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else ((x - x1) * dx + (y - y1) * dy) / seg2
        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
        cx, cy = x1 + t * dx - x, y1 + t * dy - y
        return cx * cx + cy * cy <= r * r
    if kind == 'disc':
        _, cx, cy, r = shape
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    if kind == 'elli':
        _, cx, cy, ax, ay, n = shape
        return abs((x - cx) / ax) ** n + abs((y - cy) / ay) ** n <= 1.0
    if kind == 'arc':
        _, cx, cy, r, w, a0, span = shape
        d = math.hypot(x - cx, y - cy)
        if abs(d - r) > w / 2:
            return False
        theta = math.degrees(math.atan2(y - cy, x - cx)) % 360.0
        if _angle_in(theta, a0, span):
            return True
        t0 = math.radians(a0)
        sx, sy = cx + r * math.cos(t0), cy + r * math.sin(t0)
        return (x - sx) ** 2 + (y - sy) ** 2 <= (w / 2) ** 2
    if kind == 'tri':
        _, ax, ay, bx, by, cx, cy = shape
        d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
        d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
        d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
        neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (neg and pos)
    raise ValueError(f'unknown shape {kind}')


def render(size, tile_rgb, layers_at_128):
    """Render an optional squircle tile + glyph with SS×SS antialiasing."""
    s = size / 128.0

    def scale_shape(shape):
        kind = shape[0]
        if kind in ('cap', 'disc'):
            scaled = [v * s for v in shape[1:]]
            scaled[-1] = max(scaled[-1], MIN_W[size] / 2)
            return (kind, *scaled)
        if kind == 'elli':
            return (kind, *(v * s for v in shape[1:5]), shape[5])
        if kind == 'arc':
            _, cx, cy, r, w, a0, span = shape
            return (kind, cx * s, cy * s, r * s,
                    max(w * s, MIN_W[size]), a0, span)
        if kind == 'tri':
            return (kind, *(v * s for v in shape[1:]))
        raise ValueError(kind)

    layers = [(scale_shape(sh), key) for sh, key in layers_at_128]
    half = size * TILE_FRAC / 2.0
    c = size / 2.0
    pix = bytearray(size * size * 4)
    n_sub = SS * SS
    for y in range(size):
        for x in range(size):
            n = 0
            sr = sg = sb = 0
            for sy in range(SS):
                yy = y + (sy + 0.5) / SS
                ay_ = abs((yy - c) / half) ** SQUIRCLE_N if tile_rgb else 0
                if tile_rgb and ay_ > 1.0:
                    continue
                for sx in range(SS):
                    xx = x + (sx + 0.5) / SS
                    if (tile_rgb and
                            abs((xx - c) / half) ** SQUIRCLE_N + ay_ > 1.0):
                        continue
                    gx, gy = xx - c, yy - c
                    col = tile_rgb
                    for sh, key in layers:
                        if covers(sh, gx, gy):
                            col = tile_rgb if key == 'T' else COLOR_KEYS[key]
                    if col is None:
                        continue
                    sr += col[0]
                    sg += col[1]
                    sb += col[2]
                    n += 1
            if n:
                o = (y * size + x) * 4
                pix[o] = sr // n
                pix[o + 1] = sg // n
                pix[o + 2] = sb // n
                pix[o + 3] = round(n / n_sub * 255)
    return pix


def render_toolbar_16():
    """Pixel-authored 16px mark: no scaling and no antialiasing."""
    navy = set()
    for y, x0, x1 in (
        (1, 4, 10), (2, 3, 11), (3, 2, 4), (4, 1, 3),
        (5, 1, 2), (5, 13, 14), (6, 0, 2), (6, 13, 14),
        (7, 0, 1), (7, 13, 15), (8, 0, 1), (8, 14, 15),
        (9, 0, 2), (9, 13, 15), (10, 1, 2), (10, 13, 14),
        (11, 1, 3), (11, 12, 14), (12, 2, 4), (12, 11, 13),
        (13, 3, 12), (14, 5, 10),
    ):
        navy.update((x, y) for x in range(x0, x1 + 1))

    gold = {(12, 2)}
    gold.update((x, 3) for x in range(11, 14))
    gold.update((x, 4) for x in range(10, 15))
    gold.update((x, 8) for x in range(5, 12))
    gold.update((8, y) for y in range(5, 12))
    gold.update({(6, 6), (10, 6), (6, 10), (10, 10)})

    pix = bytearray(16 * 16 * 4)
    for points, color in ((navy, NAVY), (gold, GOLD)):
        for x, y in points:
            o = (y * 16 + x) * 4
            pix[o:o + 4] = bytes((*color, 255))
    return pix


# ---------------------------------------------------------------- output

def write_png(path, w, h, pix):
    expected_len = w * h * 4
    if len(pix) != expected_len:
        raise ValueError(
            f'RGBA buffer has {len(pix)} bytes; expected {expected_len}')

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b''.join(
        b'\x00' + bytes(pix[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def candidate_sheet(path):
    """Rows = concepts; cols = 128, 48, 16-on-light, 16-on-dark.
    Small sizes nearest-neighbor upscaled for pixel-accurate review."""
    cell, gap = 168, 14
    cols = [(128, 1, b'\xF5\xF5\xF7'), (48, 2, b'\xF5\xF5\xF7'),
            (16, 8, b'\xF5\xF5\xF7'), (16, 8, b'\x20\x21\x24')]
    sheet_w = gap + len(cols) * (cell + gap)
    sheet_h = gap + len(PREVIEW_CONCEPTS) * (cell + gap)
    pix = bytearray(b'\xFF' * (sheet_w * sheet_h * 4))

    def fill(dst_x, dst_y, bg):
        rgba_row = (bg + b'\xFF') * cell
        for yy in range(cell):
            o = ((dst_y + yy) * sheet_w + dst_x) * 4
            pix[o:o + cell * 4] = rgba_row

    def blit(dst_x, dst_y, size, src, scale, bg):
        side = size * scale
        for yy in range(side):
            for xx in range(side):
                o_src = ((yy // scale) * size + (xx // scale)) * 4
                a = src[o_src + 3]
                if a == 0:
                    continue
                if a == 255:
                    col = src[o_src:o_src + 3]
                else:
                    col = bytes((src[o_src + i] * a + bg[i] * (255 - a)) // 255
                                for i in range(3))
                o = ((dst_y + yy) * sheet_w + dst_x + xx) * 4
                pix[o:o + 3] = col

    row = 0
    for name, make in PREVIEW_CONCEPTS.items():
        y = gap + row * (cell + gap)
        for ci, (size, scale, bg) in enumerate(cols):
            x = gap + ci * (cell + gap)
            fill(x, y, bg)
            tile_rgb, layers = make(size)
            if name == 'toolbar-snow-cycle' and size == 16:
                src = render_toolbar_16()
            else:
                src = render(size, tile_rgb, layers)
            off = (cell - size * scale) // 2
            blit(x + off, y + off, size, src, scale, bg)
        row += 1
    write_png(path, sheet_w, sheet_h, pix)


def apply(concept):
    make = CONCEPTS[concept]
    for size in (16, 48, 128):
        tile_rgb, layers = make(size)
        pix = render(size, tile_rgb, layers)
        out = os.path.join(ROOT, 'icons', f'icon{size}.png')
        write_png(out, size, size, pix)
        print(f'wrote {out} ({size}x{size})')
    for size in (16, 20, 24, 32, 48):
        toolbar_rgb, toolbar_layers = concept_toolbar_snow_cycle(size)
        pix = render_toolbar_16() if size == 16 else render(
            size, toolbar_rgb, toolbar_layers)
        out = os.path.join(ROOT, 'icons', f'action{size}.png')
        write_png(out, size, size, pix)
        print(f'wrote {out} ({size}x{size})')


def main():
    args = sys.argv[1:]
    if args and args[0] == 'apply':
        concept = args[1] if len(args) == 2 else CURRENT_CONCEPT
        if len(args) > 2 or concept not in CONCEPTS:
            raise SystemExit(
                f'usage: gen-icon.py apply [{"|".join(CONCEPTS)}]')
        apply(concept)
        return
    tmp = os.environ.get('TMPDIR', '/tmp')
    sheet = os.path.join(tmp, 'ac-ust-icon-candidates.png')
    candidate_sheet(sheet)
    print(f'candidate sheet (rows: {", ".join(PREVIEW_CONCEPTS)}): {sheet}')


if __name__ == '__main__':
    main()
