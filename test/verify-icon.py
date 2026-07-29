"""Verify icon128.png meets Chrome Web Store guidelines."""
import os
import struct
import zlib

icons_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'icons')
path = os.path.join(icons_dir, 'icon128.png')

# 1. Raw PNG structure check
with open(path, 'rb') as f:
    sig = f.read(8)
    assert sig == b'\x89PNG\r\n\x1a\n', f'BAD PNG SIG: {sig.hex()}'

    crc_errors = []
    idat_data = bytearray()
    while True:
        length = struct.unpack('>I', f.read(4))[0]
        chunk_type = f.read(4)
        data = f.read(length)
        crc_read = struct.unpack('>I', f.read(4))[0]
        crc_calc = zlib.crc32(chunk_type + data) & 0xffffffff
        if crc_read != crc_calc:
            crc_errors.append(chunk_type.decode('ascii', errors='replace'))

        if chunk_type == b'IHDR':
            w, h, bitd, ct, compression, filtering, interlace = struct.unpack('>IIBBBBB', data)
            ct_names = {0:'grayscale', 2:'RGB', 3:'indexed', 4:'grayscale+alpha', 6:'RGBA'}
            print(f'IHDR: {w}x{h}  bit_depth={bitd}  color_type={ct} ({ct_names.get(ct,"?")})')

        if chunk_type == b'IDAT':
            idat_data.extend(data)

        if chunk_type == b'IEND':
            break

# 2. Decode the 8-bit non-interlaced RGBA scanlines with the standard library.
assert bitd == 8 and ct == 6, f'Expected 8-bit RGBA PNG, got bit_depth={bitd}, color_type={ct}'
assert compression == 0 and filtering == 0 and interlace == 0, 'Unsupported PNG encoding'

bytes_per_pixel = 4
row_bytes = w * bytes_per_pixel
raw = zlib.decompress(idat_data)
assert len(raw) == h * (row_bytes + 1), 'Unexpected decompressed PNG size'

def paeth_predictor(left, above, upper_left):
    prediction = left + above - upper_left
    left_distance = abs(prediction - left)
    above_distance = abs(prediction - above)
    upper_left_distance = abs(prediction - upper_left)
    if left_distance <= above_distance and left_distance <= upper_left_distance:
        return left
    if above_distance <= upper_left_distance:
        return above
    return upper_left

rows = []
offset = 0
previous_row = bytearray(row_bytes)
for _row_index in range(h):
    filter_type = raw[offset]
    offset += 1
    encoded_row = raw[offset:offset + row_bytes]
    offset += row_bytes
    decoded_row = bytearray(row_bytes)
    for byte_index, encoded_byte in enumerate(encoded_row):
        left = decoded_row[byte_index - bytes_per_pixel] if byte_index >= bytes_per_pixel else 0
        above = previous_row[byte_index]
        upper_left = previous_row[byte_index - bytes_per_pixel] if byte_index >= bytes_per_pixel else 0
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

def alpha_at(x, y):
    return rows[y][x * bytes_per_pixel + 3]

print(f'Decoded: mode=RGBA size=({w}, {h})')

# 16px is the primary browser-toolbar size. It is pixel-authored with no
# antialiasing so the cycle arrow and snowflake remain separate.
toolbar16_path = os.path.join(icons_dir, 'action16.png')
with open(toolbar16_path, 'rb') as f:
    toolbar16 = f.read()
toolbar16_pos = 8
toolbar16_idat = bytearray()
while toolbar16_pos < len(toolbar16):
    chunk_len = struct.unpack('>I', toolbar16[toolbar16_pos:toolbar16_pos + 4])[0]
    chunk_type = toolbar16[toolbar16_pos + 4:toolbar16_pos + 8]
    chunk_data = toolbar16[toolbar16_pos + 8:toolbar16_pos + 8 + chunk_len]
    toolbar16_pos += chunk_len + 12
    if chunk_type == b'IHDR':
        toolbar16_w, toolbar16_h, _, _, _, _, _ = struct.unpack('>IIBBBBB', chunk_data)
    elif chunk_type == b'IDAT':
        toolbar16_idat.extend(chunk_data)

toolbar16_raw = zlib.decompress(toolbar16_idat)
toolbar16_stride = toolbar16_w * 4
assert toolbar16_w == 16 and toolbar16_h == 16, 'Expected 16x16 toolbar icon'
assert len(toolbar16_raw) == toolbar16_h * (toolbar16_stride + 1), \
    'Invalid 16px scanlines'
assert all(toolbar16_raw[y * (toolbar16_stride + 1)] == 0
           for y in range(toolbar16_h)), \
    'Expected unfiltered 16px scanlines'
toolbar16_rows = [
    toolbar16_raw[y * (toolbar16_stride + 1) + 1:
                  (y + 1) * (toolbar16_stride + 1)]
    for y in range(toolbar16_h)
]

toolbar16_pixels = [
    tuple(row[x * 4:x * 4 + 4])
    for row in toolbar16_rows for x in range(16)
]
transparent = (0, 0, 0, 0)
navy = (0, 47, 108, 255)
gold = (255, 205, 0, 255)
toolbar16_hard_edged = set(toolbar16_pixels) <= {transparent, navy, gold}
visible16 = [
    (index % 16, index // 16)
    for index, pixel in enumerate(toolbar16_pixels) if pixel != transparent
]
toolbar16_full_canvas = (
    min(x for x, _ in visible16) == 0
    and max(x for x, _ in visible16) == 15
    and min(y for _, y in visible16) <= 1
    and max(y for _, y in visible16) >= 14
)
toolbar16_centroid = (
    sum(x for x, _ in visible16) / len(visible16),
    sum(y for _, y in visible16) / len(visible16),
)
toolbar16_centered = all(abs(value - 7.5) <= 0.15 for value in toolbar16_centroid)

def is_gold16(x, y):
    return toolbar16_pixels[y * 16 + x] == gold

snowflake_visible = sum(is_gold16(x, y) for y in range(5, 12)
                        for x in range(5, 12)) >= 15
arrowhead_visible = sum(is_gold16(x, y) for y in range(2, 5)
                        for x in range(11, 16)) >= 8
toolbar_icon_legible = (toolbar16_hard_edged and toolbar16_full_canvas
                        and toolbar16_centered
                        and snowflake_visible and arrowhead_visible)

toolbar_sizes_native = True
for toolbar_size in (16, 20, 24, 32, 48):
    toolbar_path = os.path.join(icons_dir, f'action{toolbar_size}.png')
    with open(toolbar_path, 'rb') as f:
        toolbar_header = f.read(24)
    toolbar_w, toolbar_h = struct.unpack('>II', toolbar_header[16:24])
    toolbar_sizes_native &= toolbar_w == toolbar_size and toolbar_h == toolbar_size

# 3. Edge transparency check (16px padding should be transparent)
edge_transparent = True
for x in range(128):
    for y in list(range(16)) + list(range(112, 128)):
        if alpha_at(x, y) > 0:
            edge_transparent = False
            break
for y in range(128):
    for x in list(range(16)) + list(range(112, 128)):
        if alpha_at(x, y) > 0:
            edge_transparent = False
            break

# 4. Center content opacity
center_opaque = 0
center_total = 0
for x in range(24, 104):
    for y in range(24, 104):
        center_total += 1
        if alpha_at(x, y) > 200:
            center_opaque += 1
opaque_pct = center_opaque / center_total * 100
print(f'Center 80x80 opaque ratio: {opaque_pct:.0f}%')

# 5. Verdict
checks = [
    ('16px toolbar snowflake + cycle glyph is hard-edged', toolbar_icon_legible),
    ('16/20/24/32/48px toolbar icons are native-sized', toolbar_sizes_native),
    ('PNG signature valid', sig == b'\x89PNG\r\n\x1a\n'),
    ('Size 128x128', w == 128 and h == 128),
    ('RGBA color mode', bitd == 8 and ct == 6),
    ('All CRC checksums OK', len(crc_errors) == 0),
    ('16px transparent padding', edge_transparent),
    ('Center content opaque >70%', opaque_pct > 70),
]

print()
all_ok = True
for label, ok in checks:
    mark = 'PASS' if ok else 'FAIL'
    print(f'[{mark}] {label}')
    if not ok:
        all_ok = False
        if label == 'All CRC checksums OK':
            print(f'      Bad chunks: {crc_errors}')

print()
if all_ok:
    print('ALL CHECKS PASSED - icon meets Chrome Web Store guidelines')
else:
    print('SOME CHECKS FAILED - see above')
    exit(1)
