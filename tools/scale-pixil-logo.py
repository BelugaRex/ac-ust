#!/usr/bin/env python3
"""Derive the 48/128px extension icons from the hand-drawn Pixilart masters.

The 16px toolbar/popup icon and the 24/32px derivation masters are pixel art
drawn natively on pixilart.com and must never be overwritten with scaled
output. This tool only derives the two larger icons used by the extensions
management page and the Chrome Web Store:

- icons/ac-ust_48.png  — ac-ust_24.png upscaled x2, full-bleed transparent
- icons/ac-ust_128.png — ac-ust_32.png upscaled x3 (96px), centered on a
                         128px canvas with a 16px transparent margin, per
                         Chrome Web Store icon guidance

Nearest-neighbor sampling keeps the hard pixel-art edges and palette.
Pure stdlib (no Pillow).
"""

import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
# (master size, integer scale factor, output canvas size)
DERIVED_SPECS = (
    (24, 2, 48),
    (32, 3, 128),
)
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def read_png(path):
    data = path.read_bytes()
    if data[:8] != PNG_SIGNATURE:
        raise ValueError(f'{path} is not a PNG file')

    width = height = None
    idat = bytearray()
    offset = 8
    while offset < len(data):
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack('>I', data[offset + 8 + length:offset + 12 + length])[0]
        if zlib.crc32(kind + payload) & 0xffffffff != crc:
            raise ValueError(f'{path} contains a bad {kind.decode()} CRC')
        if kind == b'IHDR':
            width, height, depth, color_type, compression, filtering, interlace = struct.unpack(
                '>IIBBBBB', payload
            )
            if (depth, color_type, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError('expected an 8-bit non-interlaced RGBA PNG')
        elif kind == b'IDAT':
            idat.extend(payload)
        offset += length + 12

    if width is None or height is None:
        raise ValueError('PNG is missing IHDR')

    stride = width * 4
    encoded = zlib.decompress(idat)
    if len(encoded) != height * (stride + 1):
        raise ValueError('PNG scanline data has an unexpected length')

    pixels = bytearray(width * height * 4)
    previous = bytearray(stride)
    offset = 0
    for y in range(height):
        filter_type = encoded[offset]
        offset += 1
        row = encoded[offset:offset + stride]
        offset += stride
        decoded = bytearray(stride)
        for index, value in enumerate(row):
            left = decoded[index - 4] if index >= 4 else 0
            above = previous[index]
            upper_left = previous[index - 4] if index >= 4 else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            elif filter_type == 4:
                estimate = left + above - upper_left
                distances = (
                    abs(estimate - left),
                    abs(estimate - above),
                    abs(estimate - upper_left),
                )
                predictor = (left, above, upper_left)[distances.index(min(distances))]
            else:
                raise ValueError(f'unsupported PNG filter type: {filter_type}')
            decoded[index] = (value + predictor) & 0xff
        pixels[y * stride:(y + 1) * stride] = decoded
        previous = decoded

    return width, height, pixels


def png_chunk(kind, payload):
    return (struct.pack('>I', len(payload)) + kind + payload +
            struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff))


def write_derived(path, source_pixels, source_size, factor, canvas_size):
    """Upscale a square master by an integer factor and center it on a
    transparent canvas (zero margin when content fills the canvas)."""
    content_size = source_size * factor
    if content_size > canvas_size:
        raise ValueError(
            f'{source_size}x{factor} exceeds the {canvas_size}px canvas'
        )
    margin = (canvas_size - content_size) // 2
    canvas = bytearray(canvas_size * canvas_size * 4)
    for y in range(content_size):
        source_y = y // factor
        for x in range(content_size):
            source_x = x // factor
            source_offset = (source_y * source_size + source_x) * 4
            target_offset = ((margin + y) * canvas_size + margin + x) * 4
            canvas[target_offset:target_offset + 4] = source_pixels[
                source_offset:source_offset + 4
            ]

    scanlines = b''.join(
        b'\x00' + bytes(canvas[y * canvas_size * 4:(y + 1) * canvas_size * 4])
        for y in range(canvas_size)
    )
    png = (PNG_SIGNATURE +
           png_chunk(b'IHDR', struct.pack('>IIBBBBB', canvas_size, canvas_size,
                                          8, 6, 0, 0, 0)) +
           png_chunk(b'IDAT', zlib.compress(scanlines, 9)) +
           png_chunk(b'IEND', b''))
    path.write_bytes(png)
    print(f'wrote {path} ({canvas_size}x{canvas_size}, '
          f'from {source_size}px master x{factor}, margin {margin}px)')


def main():
    for source_size, factor, canvas_size in DERIVED_SPECS:
        source_path = ROOT / 'icons' / f'ac-ust_{source_size}.png'
        width, height, pixels = read_png(source_path)
        if (width, height) != (source_size, source_size):
            raise ValueError(
                f'expected a {source_size}x{source_size} master, '
                f'got {width}x{height}'
            )
        write_derived(ROOT / 'icons' / f'ac-ust_{canvas_size}.png',
                      pixels, source_size, factor, canvas_size)


if __name__ == '__main__':
    main()