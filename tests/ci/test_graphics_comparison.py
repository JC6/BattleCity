"""Synthetic graphics comparisons, with no original-game image or private data."""
import importlib.util
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

SCRIPT = Path(__file__).resolve().parents[2] / 'tools/compare-game-graphics.py'
spec = importlib.util.spec_from_file_location('graphics_comparison', SCRIPT)
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))


def png(width, height, pixels, method=0, color=6):
    raw, stride, previous = bytearray(), width * 4, bytes(width * 4)
    for y in range(height):
        row = pixels[y * stride:(y + 1) * stride]
        raw.append(method)
        for x, value in enumerate(row):
            left, up, corner = row[x - 4] if x >= 4 else 0, previous[x], previous[x - 4] if x >= 4 else 0
            predictions = [0, left, up, (left + up) // 2]
            p = left + up - corner
            distances = [abs(p - left), abs(p - up), abs(p - corner)]
            predictions.append([left, up, corner][distances.index(min(distances))])
            raw.append((value - predictions[method]) & 255)
        previous = row
    header = struct.pack('>IIBBBBB', width, height, 8, color, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


class GraphicsComparisonTest(unittest.TestCase):
    def test_distinguishes_dimensions_outline_pattern_and_palette_without_inflating_exact(self):
        a, b, c = bytes([11,22,33,255]), bytes([44,55,66,255]), bytes([77,88,99,255])
        reference = {'same': (2,1,a+b), 'size': (2,1,a+b), 'outline': (2,1,a+b),
                     'pattern': (3,1,a+a+b), 'palette': (2,1,a+b)}
        candidate = {'same': (2,1,a+b), 'size': (1,2,a+b), 'outline': (2,1,a+bytes(4)),
                     'pattern': (3,1,a+b+b), 'palette': (2,1,b+c)}
        result = comparison.compare(reference, candidate)
        self.assertEqual(5, result['total'])
        self.assertEqual(dict(exact=1, size=1, outline=1, interior_pattern=1, palette_only=1), result['categories'])
        self.assertEqual(3, result['same_alpha_mask'])
        self.assertEqual(['same'], result['exact_keys'])
        self.assertEqual(20, result['exact_percent'])

    def test_transparent_rgb_is_still_part_of_the_strict_rgba_metric(self):
        result = comparison.compare({'a': (1,1,bytes([1,2,3,0]))}, {'a': (1,1,bytes(4))})
        self.assertEqual(0, result['categories']['exact'])
        self.assertEqual(1, result['same_alpha_mask'])

    def test_rejects_different_key_sets_instead_of_silently_changing_denominator(self):
        with self.assertRaisesRegex(ValueError, 'denominator'):
            comparison.compare({'a': (1,1,bytes(4))}, {'b': (1,1,bytes(4))})

    def test_png_filters_reconstruct_the_same_literal_rgba_bytes(self):
        pixels = bytes([0,17,255,255, 221,31,48,0, 99,245,12,255, 1,2,3,255])
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'atlas.png'
            for method in range(5):
                p.write_bytes(png(2,2,pixels,method))
                width, height, rows = comparison.read_png(p)
                self.assertEqual((2,2,pixels), (width,height,b''.join(rows)))

    def test_invalid_checksums_formats_and_regions_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); p = root / 'atlas.png'
            data = png(1,1,bytes(4));p.write_bytes(data[:-1]+bytes([data[-1]^1]))
            with self.assertRaisesRegex(ValueError, 'checksum'): comparison.read_png(p)
            p.write_bytes(png(1,1,bytes(4),color=2))
            with self.assertRaisesRegex(ValueError, 'RGBA'): comparison.read_png(p)
            p.write_bytes(data); (root/'atlas.txt').write_text('one\t0\t0\t2\t1\n')
            with self.assertRaisesRegex(ValueError, 'outside'): comparison.read_atlas(root)
            (root/'atlas.txt').write_text('one\t0\t0\t1\t1\none\t0\t0\t1\t1\n')
            with self.assertRaisesRegex(ValueError, 'duplicate'): comparison.read_atlas(root)

    def test_cli_emits_only_statistics_and_never_changes_its_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp);ref=root/'ref';candidate=root/'candidate';ref.mkdir();candidate.mkdir()
            for directory in [ref,candidate]:
                (directory/'atlas.png').write_bytes(png(1,1,bytes([1,2,3,255])))
                (directory/'atlas.txt').write_text('glyph:A\t0\t0\t1\t1\n')
            before = {p: (p.read_bytes(),p.stat().st_mtime_ns) for p in root.rglob('*') if p.is_file()}
            run = subprocess.run([sys.executable,str(SCRIPT),'--reference',str(ref),'--candidate',str(candidate)],capture_output=True,text=True)
            self.assertEqual(0,run.returncode,run.stderr)
            self.assertIn('"exact": 1',run.stdout)
            self.assertNotIn('pixels',run.stdout)
            self.assertEqual(before, {p:(p.read_bytes(),p.stat().st_mtime_ns) for p in before})
