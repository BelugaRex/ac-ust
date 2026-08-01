"""Verify the icon files used by the extension.

16/24/32 are hand-drawn Pixilart masters; 48/128 must be exact
nearest-neighbor derivations produced by tools/scale-pixil-logo.py.
Also guards popup.html against referencing deleted icon files.
"""
import os
import re
import struct
import zlib


icons_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'icons')
expected_sizes = (16, 24, 32, 48, 128)
png_signature = b'\x89PNG\r\n\x1a\n'


def decode_png(path):
    with open(path, 'rb') as icon_file:
        data = icon_file.read()

    assert data[:8] == png_signature, f'BAD PNG SIG: {data[:8].hex()}'

    width = height = None
    bit_depth = color_type = compression = filtering = interlace = None
    idat_data = bytearray()
    crc_errors = []
    offset = 8
    while offset < len(data):
        assert offset + 12 <= len(data), 'Truncated PNG chunk header'
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        chunk_type = data[offset + 4:offset + 8]
        chunk_end = offset + 12 + length
        assert chunk_end <= len(data), 'Truncated PNG chunk data'
        chunk_data = data[offset + 8:offset + 8 + length]
        crc_read = struct.unpack('>I', data[offset + 8 + length:chunk_end])[0]
        crc_calc = zlib.crc32(chunk_type + chunk_data) & 0xffffffff
        if crc_read != crc_calc:
            crc_errors.append(chunk_type.decode('ascii', errors='replace'))

        if chunk_type == b'IHDR':
            (width, height, bit_depth, color_type, compression,
             filtering, interlace) = struct.unpack('>IIBBBBB', chunk_data)
        elif chunk_type == b'IDAT':
            idat_data.extend(chunk_data)
        elif chunk_type == b'IEND':
            break
        offset = chunk_end

    assert width is not None and height is not None, 'PNG is missing IHDR'
    assert (bit_depth, color_type, compression, filtering, interlace) == (
        8, 6, 0, 0, 0
    ), 'Expected an 8-bit non-interlaced RGBA PNG'

    bytes_per_pixel = 4
    row_bytes = width * bytes_per_pixel
    encoded = zlib.decompress(idat_data)
    assert len(encoded) == height * (row_bytes + 1), \
        'Unexpected decompressed PNG size'

    def paeth_predictor(left, above, upper_left):
        prediction = left + above - upper_left
        distances = (
            abs(prediction - left),
            abs(prediction - above),
            abs(prediction - upper_left),
        )
        return (left, above, upper_left)[distances.index(min(distances))]

    rows = []
    offset = 0
    previous_row = bytearray(row_bytes)
    for _row_index in range(height):
        filter_type = encoded[offset]
        offset += 1
        encoded_row = encoded[offset:offset + row_bytes]
        offset += row_bytes
        decoded_row = bytearray(row_bytes)
        for byte_index, encoded_byte in enumerate(encoded_row):
            left = (decoded_row[byte_index - bytes_per_pixel]
                    if byte_index >= bytes_per_pixel else 0)
            above = previous_row[byte_index]
            upper_left = (previous_row[byte_index - bytes_per_pixel]
                          if byte_index >= bytes_per_pixel else 0)
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            elif filter_type == 4:
                predictor = paeth_predictor(left, above, upper_left)
            else:
                raise AssertionError(f'Unsupported PNG filter type: {filter_type}')
            decoded_row[byte_index] = (encoded_byte + predictor) & 0xff
        rows.append(decoded_row)
        previous_row = decoded_row

    return width, height, rows, crc_errors


images = {}
for size in expected_sizes:
    path = os.path.join(icons_dir, f'ac-ust_{size}.png')
    width, height, rows, crc_errors = decode_png(path)
    images[size] = (width, height, rows, crc_errors)
    print(f'{path}: {width}x{height}, RGBA')

all_sizes_native = all(
    images[size][0] == size and images[size][1] == size
    for size in expected_sizes
)
pngs_valid = all(not images[size][3] for size in expected_sizes)


def pixels_of(size):
    width, _height, rows, _crc = images[size]
    return [
        tuple(row[x * 4:x * 4 + 4])
        for row in rows for x in range(width)
    ]

toolbar16_rows = images[16][2]
toolbar16_pixels = [
    tuple(row[x * 4:x * 4 + 4])
    for row in toolbar16_rows for x in range(16)
]
transparent = (0, 0, 0, 0)
blue = (0, 116, 188, 255)
cyan = (99, 202, 225, 255)
snowflake = (239, 240, 240, 255)
gold = (255, 212, 0, 255)
background = (180, 180, 180, 255)
expected_palette = {transparent, blue, cyan, snowflake, gold, background}
toolbar16_palette = set(toolbar16_pixels)
toolbar16_hard_edged = toolbar16_palette <= expected_palette
visible16 = [
    (index % 16, index // 16)
    for index, pixel in enumerate(toolbar16_pixels) if pixel != transparent
]
toolbar16_bounds = (
    min(x for x, _ in visible16) == 0
    and max(x for x, _ in visible16) == 15
    and min(y for _, y in visible16) == 0
    and max(y for _, y in visible16) == 15
)
toolbar16_centroid = (
    sum(x for x, _ in visible16) / len(visible16),
    sum(y for _, y in visible16) / len(visible16),
)
toolbar16_centered = all(abs(value - 7.5) <= 0.4
                          for value in toolbar16_centroid)


def is_gold16(x, y):
    return toolbar16_pixels[y * 16 + x] == gold


def is_snowflake16(x, y):
    return toolbar16_pixels[y * 16 + x] == snowflake


snowflake_visible = sum(
    is_snowflake16(x, y) for y in range(2, 14) for x in range(2, 14)
) >= 30
arrowhead_visible = sum(
    is_gold16(x, y) for y in range(2, 6) for x in range(12, 16)
) >= 8
cycle_visible = sum(
    toolbar16_pixels[y * 16 + x] in {blue, cyan}
    for y in range(16) for x in range(16)
) >= 40
toolbar_icon_legible = (
    toolbar16_hard_edged
    and toolbar16_bounds
    and toolbar16_centered
    and snowflake_visible
    and arrowhead_visible
    and cycle_visible
)


def nearest_neighbor_derivation(master_size, factor, canvas_size):
    """Expected pixels when the master is upscaled x factor (nearest
    neighbor) and centered on a transparent canvas_size canvas."""
    _width, _height, master_rows, _crc = images[master_size]
    margin = (canvas_size - master_size * factor) // 2
    canvas = [transparent] * (canvas_size * canvas_size)
    for y in range(master_size * factor):
        master_row = master_rows[y // factor]
        for x in range(master_size * factor):
            source_x = x // factor
            canvas[(margin + y) * canvas_size + margin + x] = tuple(
                master_row[source_x * 4:source_x * 4 + 4]
            )
    return canvas


derived_icons_exact = (
    pixels_of(48) == nearest_neighbor_derivation(24, 2, 48)
    and pixels_of(128) == nearest_neighbor_derivation(32, 3, 128)
)

popup_path = os.path.join(os.path.dirname(icons_dir), 'popup.html')
with open(popup_path, encoding='utf-8') as popup_file:
    popup_icon_refs = sorted(set(
        re.findall(r'icons/([A-Za-z0-9_-]+\.png)', popup_file.read())
    ))
missing_popup_icons = [
    ref for ref in popup_icon_refs
    if not os.path.isfile(os.path.join(icons_dir, ref))
]
popup_icons_exist = not missing_popup_icons

checks = [
    ('16/24/32/48/128px icons are all native-sized', all_sizes_native),
    ('PNG signatures, encoding, and CRC checksums are valid', pngs_valid),
    ('16px toolbar palette and snowflake + cycle glyph are legible',
     toolbar_icon_legible),
    ('48/128px icons are nearest-neighbor derivations of the 24/32px '
     'masters (tools/scale-pixil-logo.py)', derived_icons_exact),
    ('popup.html references only existing icon files', popup_icons_exist),
]

print()
all_ok = True
for label, ok in checks:
    mark = 'PASS' if ok else 'FAIL'
    print(f'[{mark}] {label}')
    if not ok:
        all_ok = False
        if label.startswith('PNG'):
            bad_files = [
                f'ac-ust_{size}.png: {images[size][3]}'
                for size in expected_sizes if images[size][3]
            ]
            print(f'      Bad files: {bad_files}')
        elif label.startswith('popup.html'):
            print(f'      Missing files: {missing_popup_icons}')

print()
if all_ok:
    print('ALL CHECKS PASSED - extension icons are ready for the store')
else:
    print('SOME CHECKS FAILED - see above')
    raise SystemExit(1)
