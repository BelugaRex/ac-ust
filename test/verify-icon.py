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
