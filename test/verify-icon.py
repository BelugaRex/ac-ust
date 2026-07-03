"""Verify icon128.png meets Chrome Web Store guidelines."""
from PIL import Image
import struct, zlib, os

icons_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'icons')
path = os.path.join(icons_dir, 'icon128.png')

# 1. Raw PNG structure check
with open(path, 'rb') as f:
    sig = f.read(8)
    assert sig == b'\x89PNG\r\n\x1a\n', f'BAD PNG SIG: {sig.hex()}'

    crc_errors = []
    while True:
        length = struct.unpack('>I', f.read(4))[0]
        chunk_type = f.read(4)
        data = f.read(length)
        crc_read = struct.unpack('>I', f.read(4))[0]
        crc_calc = zlib.crc32(chunk_type + data) & 0xffffffff
        if crc_read != crc_calc:
            crc_errors.append(chunk_type.decode('ascii', errors='replace'))

        if chunk_type == b'IHDR':
            w, h = struct.unpack('>II', data[:8])
            bitd, ct = struct.unpack('>BB', data[8:10])
            ct_names = {0:'grayscale', 2:'RGB', 3:'indexed', 4:'grayscale+alpha', 6:'RGBA'}
            print(f'IHDR: {w}x{h}  bit_depth={bitd}  color_type={ct} ({ct_names.get(ct,"?")})')

        if chunk_type == b'IEND':
            break

# 2. Pillow checks
img = Image.open(path)
print(f'Pillow: mode={img.mode} size={img.size}')

# 3. Edge transparency check (16px padding should be transparent)
px = img.load()
edge_transparent = True
for x in range(128):
    for y in list(range(16)) + list(range(112, 128)):
        if px[x, y][3] > 0:
            edge_transparent = False
            break
for y in range(128):
    for x in list(range(16)) + list(range(112, 128)):
        if px[x, y][3] > 0:
            edge_transparent = False
            break

# 4. Center content opacity
center_opaque = 0
center_total = 0
for x in range(24, 104):
    for y in range(24, 104):
        center_total += 1
        if px[x, y][3] > 200:
            center_opaque += 1
opaque_pct = center_opaque / center_total * 100
print(f'Center 80x80 opaque ratio: {opaque_pct:.0f}%')

# 5. Verdict
checks = [
    ('PNG signature valid', sig == b'\x89PNG\r\n\x1a\n'),
    ('Size 128x128', w == 128 and h == 128),
    ('RGBA color mode', img.mode == 'RGBA'),
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
