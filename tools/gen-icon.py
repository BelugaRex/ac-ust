#!/usr/bin/env python3
"""Generate AC-UST extension icons — pure stdlib (no Pillow).

Design (tokens from .vscode/APPLE-DESIGN.md / popup.html):
- Squircle tile in Action Blue #0066cc, 12.5% transparent padding
  (16px at 128, satisfying test/verify-icon.py padding check)
- Bold white snowflake glyph — the universal cooling/AC metaphor,
  readable when pinned at 16px toolbar size (old thin power-ring was not)
- Geometry is tuned per size, not just downscaled: the 16px icon uses
  fewer, thicker strokes (Apple HIG: simplify at small sizes)

Usage: python3 tools/gen-icon.py
Writes icons/icon16.png, icons/icon48.png, icons/icon128.png and a
preview sheet to $TMPDIR/ac-ust-icon-preview.png for visual review.
"""

import math
import os
import struct
import zlib

BLUE = (0x00, 0x66, 0xCC)   # Action Blue, popup --c-accent
WHITE = (0xFF, 0xFF, 0xFF)  # on-primary

SS = 8           # supersample factor per axis (8x8 = 64 subpixels/px)
SQUIRCLE_N = 4.5  # superellipse exponent ≈ Apple continuous-corner squircle
TILE_FRAC = 0.75  # tile width / canvas width (96/128 → 16px padding at 128)

# Per-size glyph geometry, in final-canvas units.
# R = arm tip radius, rw = stroke half-width,
# barbs = (fraction along arm, barb length), phi = barb angle from arm axis.
PARAMS = {
    128: dict(R=31.0, rw=3.6, barbs=((0.52, 12.0), (0.76, 9.0)), phi=40.0),
    48:  dict(R=11.5, rw=1.7, barbs=((0.52, 4.5), (0.76, 3.4)), phi=40.0),
    16:  dict(R=4.4, rw=1.05, barbs=((0.55, 2.2),), phi=42.0),
}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write_png(path, size, pix):
    """Write RGBA pixels (bytearray, filter 0 rows) as a standards-valid PNG."""

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b''.join(
        b'\x00' + bytes(pix[y * size * 4:(y + 1) * size * 4])
        for y in range(size))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def build_snowflake(p, ss):
    """Return capsule list [(x1,y1,x2,y2,r)] for a 6-arm snowflake.

    Coordinates are relative to the glyph center, scaled by ss.
    Arms point straight up and every 60°; barbs lean toward the arm tip.
    """
    capsules = []
    R, rw, phi = p['R'] * ss, p['rw'] * ss, math.radians(p['phi'])
    for k in range(6):
        theta = math.radians(90.0 + k * 60.0)
        ux, uy = math.cos(theta), math.sin(theta)
        tx, ty = R * ux, R * uy
        capsules.append((0.0, 0.0, tx, ty, rw))
        for t, length in p['barbs']:
            bx, by = t * R * ux, t * R * uy
            L = length * ss
            for sign in (1.0, -1.0):
                ang = theta + sign * phi
                capsules.append((bx, by, bx + L * math.cos(ang),
                                 by + L * math.sin(ang), rw))
    return capsules


def in_capsule(px, py, cap):
    x1, y1, x2, y2, r = cap
    dx, dy = x2 - x1, y2 - y1
    seg_len2 = dx * dx + dy * dy
    if seg_len2 == 0.0:
        t = 0.0
    else:
        t = ((px - x1) * dx + (py - y1) * dy) / seg_len2
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    cx, cy = x1 + t * dx - px, y1 + t * dy - py
    return cx * cx + cy * cy <= r * r


def render(size, p):
    """Render tile + glyph at size×size with SS×SS supersampled AA."""
    w = size * SS
    a = w * TILE_FRAC / 2.0  # superellipse semi-axis
    c = w / 2.0
    capsules = build_snowflake(p, SS)
    glyph_r2 = (max(abs(cap[2]) + cap[4], abs(cap[3]) + cap[4])
                for cap in capsules)
    glyph_r = max(glyph_r2) + 1.0
    glyph_r2 = glyph_r * glyph_r
    pix = bytearray(size * size * 4)
    n_sub = SS * SS
    for y in range(size):
        for x in range(size):
            n = 0
            sr = sg = sb = 0
            for sy in range(SS):
                yy = y * SS + sy + 0.5
                ay = abs((yy - c) / a) ** SQUIRCLE_N
                if ay > 1.0:
                    continue
                for sx in range(SS):
                    xx = x * SS + sx + 0.5
                    if abs((xx - c) / a) ** SQUIRCLE_N + ay > 1.0:
                        continue
                    gx, gy = xx - c, yy - c
                    col = BLUE
                    if gx * gx + gy * gy <= glyph_r2:
                        for cap in capsules:
                            if in_capsule(gx, gy, cap):
                                col = WHITE
                                break
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


def read_png(path):
    """Minimal RGBA PNG decoder (non-interlaced, 8-bit, all filters)."""
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'bad PNG signature'
    pos, idat, w, h = 8, b'', 0, 0
    while pos < len(data):
        ln, tag = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        if tag == b'IHDR':
            w, h, depth, ctype = struct.unpack('>IIBB', body[:10])
            assert depth == 8 and ctype == 6, 'expected 8-bit RGBA'
        elif tag == b'IDAT':
            idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * 4
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    for y in range(h):
        base = y * (stride + 1)
        ftype = raw[base]
        line = bytearray(raw[base + 1:base + 1 + stride])
        for i in range(stride):
            left = line[i - 4] if i >= 4 else 0
            up = prev[i]
            ul = prev[i - 4] if i >= 4 else 0
            if ftype == 1:
                line[i] = (line[i] + left) & 0xFF
            elif ftype == 2:
                line[i] = (line[i] + up) & 0xFF
            elif ftype == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif ftype == 4:
                pa, pb = abs(up - ul), abs(left - ul)
                pred = left if pa >= pb and abs(left + up - 2 * ul) >= pb else (
                    up if pa > abs(left + up - 2 * ul) or pb > pa else ul)
                line[i] = (line[i] + pred) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def compose_sheet(icons, path):
    """Preview sheet: each icon on white + dark (#202124) strips,
    small sizes nearest-neighbor upscaled for pixel-accurate review."""
    cell, gap = 160, 16
    entries = []
    for size in (128, 48, 16):
        scale = max(1, 128 // size)  # 128→1x, 48→2x, 16→8x
        entries.append((size, scale))
    sheet_w = gap + len(entries) * 2 * (cell + gap)
    sheet_h = gap + cell + gap
    pix = bytearray(b'\xFF' * (sheet_w * sheet_h * 4))

    def fill(dst_x, dst_y, side, bg):
        for yy in range(side):
            o = ((dst_y + yy) * sheet_w + dst_x) * 4
            pix[o:o + side * 4] = bg * side

    def blit(dst_x, dst_y, src_size, src, scale, bg):
        side = src_size * scale
        for yy in range(side):
            for xx in range(side):
                o_src = ((yy // scale) * src_size + (xx // scale)) * 4
                a = src[o_src + 3]
                if a == 255:
                    col = src[o_src:o_src + 3]
                elif a == 0:
                    continue
                else:
                    col = bytes((src[o_src + i] * a + bg[i] * (255 - a)) // 255
                                for i in range(3))
                o = ((dst_y + yy) * sheet_w + dst_x + xx) * 4
                pix[o:o + 3] = col

    x = gap
    for size, scale in entries:
        src_size, _, src = icons[size]
        off = (cell - src_size * scale) // 2
        for bg in (b'\xFF\xFF\xFF', b'\x20\x21\x24'):
            fill(x, gap, cell, bg)
            blit(x + off, gap + off, src_size, src, scale, bg)
            x += cell + gap
    # sheet is rectangular; write raw RGBA via dedicated path
    raw = b''.join(
        b'\x00' + bytes(pix[y * sheet_w * 4:(y + 1) * sheet_w * 4])
        for y in range(sheet_h))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', sheet_w, sheet_h,
                                          8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def main():
    icons = {}
    for size in (128, 48, 16):
        pix = render(size, PARAMS[size])
        out = os.path.join(ROOT, 'icons', f'icon{size}.png')
        write_png(out, size, pix)
        icons[size] = (size, size, pix)
        print(f'wrote {out} ({size}x{size})')
    tmp = os.environ.get('TMPDIR', '/tmp')
    preview = os.path.join(tmp, 'ac-ust-icon-preview.png')
    compose_sheet(icons, preview)
    print(f'preview sheet: {preview}')


if __name__ == '__main__':
    main()
