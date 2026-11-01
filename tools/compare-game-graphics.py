#!/usr/bin/env python3
"""Read-only atlas comparison. Reports counts and keys, never reference pixels.

Both directories must contain an 8-bit RGBA atlas.png and tab-separated
atlas.txt regions. A reference is optional for the build, required for this CLI.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import struct
import zlib


def read_png(path):
    encoded = path.read_bytes()
    if encoded[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Invalid PNG signature')
    offset, compressed, header, ended = 8, bytearray(), None, False
    while offset < len(encoded):
        if offset + 12 > len(encoded):
            raise ValueError('Truncated PNG chunk')
        size = struct.unpack_from('>I', encoded, offset)[0]
        end = offset + size + 12
        if end > len(encoded):
            raise ValueError('Truncated PNG data')
        kind, body = encoded[offset + 4:offset + 8], encoded[offset + 8:end - 4]
        if zlib.crc32(kind + body) != struct.unpack_from('>I', encoded, end - 4)[0]:
            raise ValueError('Invalid PNG checksum')
        if kind == b'IHDR':
            if header is not None or len(body) != 13:
                raise ValueError('Invalid PNG header')
            header = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            compressed.extend(body)
        elif kind == b'IEND':
            ended = True
            break
        offset = end
    if not ended or header is None:
        raise ValueError('Incomplete PNG')
    width, height, depth, color, compression, filtering, interlace = header
    if (depth, color, compression, filtering, interlace) != (8, 6, 0, 0, 0):
        raise ValueError('Expected a non-interlaced 8-bit RGBA PNG')
    if min(width, height) < 1 or width * height > 16777216:
        raise ValueError('Invalid atlas dimensions')
    raw, stride, rows = zlib.decompress(compressed), width * 4, []
    if len(raw) != (stride + 1) * height:
        raise ValueError('Invalid decoded PNG size')
    previous = bytes(stride)
    for y in range(height):
        start = y * (stride + 1)
        method, row = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        if method > 4:
            raise ValueError('Invalid PNG filter')
        for x in range(stride):
            left = row[x - 4] if x >= 4 else 0
            up, corner = previous[x], previous[x - 4] if x >= 4 else 0
            prediction = 0
            if method == 1:
                prediction = left
            elif method == 2:
                prediction = up
            elif method == 3:
                prediction = (left + up) // 2
            elif method == 4:
                p = left + up - corner
                distances = (abs(p - left), abs(p - up), abs(p - corner))
                prediction = (left, up, corner)[distances.index(min(distances))]
            row[x] = (row[x] + prediction) & 255
        rows.append(bytes(row))
        previous = row
    return width, height, rows


def read_atlas(directory):
    directory = Path(directory)
    width, height, rows = read_png(directory / 'atlas.png')
    frames = {}
    for line in (directory / 'atlas.txt').read_text().splitlines():
        fields = line.split('\t')
        if len(fields) != 5 or not fields[0] or fields[0] in frames:
            raise ValueError('Invalid or duplicate atlas key')
        name = fields[0]
        x, y, w, h = map(int, fields[1:])
        if min(x, y) < 0 or min(w, h) < 1 or x + w > width or y + h > height:
            raise ValueError('Atlas region outside image: ' + name)
        pixels = b''.join(row[x * 4:(x + w) * 4] for row in rows[y:y + h])
        frames[name] = (w, h, pixels)
    if not frames:
        raise ValueError('Empty atlas')
    return frames


def category(reference, candidate):
    if reference == candidate:
        return 'exact'
    if reference[:2] != candidate[:2]:
        return 'size'
    if reference[2][3::4] != candidate[2][3::4]:
        return 'outline'
    forward, reverse = {}, {}
    for i in range(0, len(reference[2]), 4):
        if not reference[2][i + 3]:
            continue
        a, b = reference[2][i:i + 3], candidate[2][i:i + 3]
        if a in forward and forward[a] != b or b in reverse and reverse[b] != a:
            return 'interior_pattern'
        forward[a], reverse[b] = b, a
    return 'palette_only'


def compare(reference, candidate):
    if reference.keys() != candidate.keys():
        raise ValueError('Atlas key sets differ; comparison denominator would change')
    counts = Counter({key: 0 for key in ('exact', 'size', 'outline', 'interior_pattern', 'palette_only')})
    groups, exact = {}, []
    for name in sorted(reference):
        result = category(reference[name], candidate[name])
        counts[result] += 1
        group = groups.setdefault(name.split(':')[0], dict(total=0, exact=0))
        group['total'] += 1
        if result == 'exact':
            exact.append(name)
            group['exact'] += 1
    return dict(kind='Atlas entry equality, not overall game similarity', total=len(reference),
                categories=dict(counts), exact_percent=100 * len(exact) / len(reference),
                same_alpha_mask=len(reference) - counts['size'] - counts['outline'],
                groups=groups, exact_keys=exact)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = compare(read_atlas(args.reference), read_atlas(args.candidate))
    except (OSError, ValueError, zlib.error, struct.error) as error:
        parser.exit(2, 'Comparison failed: ' + str(error) + '\n')
    result['reference_sha256'] = {name: hashlib.sha256((args.reference / name).read_bytes()).hexdigest()
                                  for name in ('atlas.png', 'atlas.txt')}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
