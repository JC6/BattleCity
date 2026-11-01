"""Validate the Android adapter in a checkout with no ROM, private pack or npm modules."""

import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[2]


class GeneratedDataTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'tools/templates').mkdir(parents=True)
        for name in ('export-android.mjs', 'templates/ic_launcher.xml'):
            shutil.copy2(ROOT / 'tools' / name, self.root / 'tools' / name)
        shutil.copytree(ROOT / 'web/src', self.root / 'web/src')
        self.output = self.root / 'build/generated/game-data'

    def generate(self, *args, output=None):
        return subprocess.run(['node', str(self.root / 'tools/export-android.mjs'),
                               '--output', str(output or self.output), *args], cwd=self.root,
                              capture_output=True, text=True, timeout=30)

    def hashes(self):
        return {str(p.relative_to(self.output)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.output.rglob('*') if p.is_file()}

    def regions(self):
        return {line.split('\t')[0]: tuple(map(int, line.split('\t')[1:]))
                for line in (self.output / 'assets/battle/atlas.txt').read_text().splitlines()}

    def png(self):
        data = (self.output / 'assets/battle/atlas.png').read_bytes()
        self.assertEqual(b'\x89PNG\r\n\x1a\n', data[:8])
        compressed = bytearray()
        i = 8
        while i < len(data):
            size = struct.unpack_from('>I', data, i)[0]
            kind, body = data[i + 4:i + 8], data[i + 8:i + 8 + size]
            self.assertEqual(zlib.crc32(kind + body), struct.unpack_from('>I', data, i + 8 + size)[0])
            if kind == b'IHDR':
                width, height, depth, color, *_ = struct.unpack('>IIBBBBB', body)
                self.assertEqual((8, 6), (depth, color))
            if kind == b'IDAT':
                compressed.extend(body)
            i += size + 12
        rows = zlib.decompress(compressed)
        self.assertEqual((width * 4 + 1) * height, len(rows))
        pixels = bytearray()
        for y in range(height):
            offset = y * (width * 4 + 1)
            self.assertEqual(0, rows[offset])
            pixels.extend(rows[offset + 1:offset + 1 + width * 4])
        return width, height, pixels

    def test_complete_game_generation_has_no_external_data_or_npm_dependency(self):
        run = self.generate()
        self.assertEqual(0, run.returncode, run.stderr)
        self.assertEqual(42, len(self.hashes()))
        self.assertEqual(335, len(self.regions()))
        self.assertEqual(36, len(list((self.output / 'assets/battle').glob('*.txt'))) - 1)
        self.assertTrue((self.output / 'java/org/jiangc/bc/audio/AudioCues.java').is_file())
        self.assertTrue((self.output / 'res/mipmap-anydpi/ic_launcher.xml').is_file())
        self.assertFalse((self.root / 'web/node_modules').exists())
        self.assertFalse((self.output / 'reference').exists())
        self.assertFalse((self.output / 'dataset-kind').exists())
        self.assertFalse(list(self.output.rglob('*.chr')))
        self.assertFalse(list(self.output.rglob('*.bin')))

    def test_generation_is_repeatable_and_check_does_not_rewrite_files(self):
        self.assertEqual(0, self.generate().returncode)
        before = self.hashes()
        mtimes = {p: p.stat().st_mtime_ns for p in self.output.rglob('*') if p.is_file()}
        self.assertEqual(0, self.generate('--check').returncode)
        self.assertEqual(mtimes, {p: p.stat().st_mtime_ns for p in mtimes})
        self.assertEqual(0, self.generate().returncode)
        self.assertEqual(before, self.hashes())

    def test_check_rejects_corruption_without_repairing_it(self):
        self.assertEqual(0, self.generate().returncode)
        target = self.output / 'assets/battle/atlas.png'
        target.write_bytes(b'corrupted')
        run = self.generate('--check')
        self.assertNotEqual(0, run.returncode)
        self.assertIn('Outdated generated data', run.stderr)
        self.assertEqual(b'corrupted', target.read_bytes())

    def test_output_guard_preserves_private_files_and_rejects_old_source_argument(self):
        private = self.root / 'private'
        private.mkdir()
        (private / 'keep').write_text('preserve me')
        run = self.generate(output=private)
        self.assertNotEqual(0, run.returncode)
        self.assertIn('build/ directory', run.stderr)
        self.assertEqual(['keep'], [p.name for p in private.iterdir()])
        self.assertEqual('preserve me', (private / 'keep').read_text())
        self.assertNotEqual(0, self.generate('--source', str(private)).returncode)
        self.assertFalse(self.output.exists())

    def test_missing_shared_source_fails_without_a_fallback(self):
        (self.root / 'web/src/game/pixel-assets.ts').unlink()
        run = self.generate()
        self.assertNotEqual(0, run.returncode)
        self.assertFalse(self.output.exists())

    def test_shared_image_map_and_audio_changes_reach_android(self):
        self.assertEqual(0, self.generate().returncode)
        before = self.hashes()
        edits = {
            'game/pixel-assets.ts': ('yellow: 0xf8b800', 'yellow: 0xf7b600'),
            'data/original.ts': ('[13,13,13,13,13,13,13,13,13,13,13,13,13]', '[12,13,13,13,13,13,13,13,13,13,13,13,13]'),
            'platform/audio-cues.ts': ('[0x02, 0x82, 0x7f, 0x40', '[0x02, 0x83, 0x7f, 0x40'),
        }
        for relative, (old, new) in edits.items():
            p = self.root / 'web/src' / relative
            source = p.read_text()
            self.assertIn(old, source)
            p.write_text(source.replace(old, new, 1))
        self.assertEqual(0, self.generate().returncode)
        after = self.hashes()
        for relative in ['assets/battle/atlas.png', 'assets/battle/stage1.txt',
                         'java/org/jiangc/bc/audio/AudioCues.java', 'res/drawable/ic_launcher_foreground.xml']:
            self.assertNotEqual(before[relative], after[relative], relative)

    def test_atlas_regions_and_observed_animations_are_valid(self):
        self.assertEqual(0, self.generate().returncode)
        width, height, _ = self.png()
        self.assertEqual((512, 512), (width, height))
        regions = self.regions()
        entries = list(regions.items())
        for i, (key, (x, y, w, h)) in enumerate(entries):
            self.assertGreater(min(x, y, w, h), 0, key)
            self.assertLess(x + w, width, key)
            self.assertLess(y + h, height, key)
            for other, (xx, yy, ww, hh) in entries[i + 1:]:
                self.assertTrue(x + w <= xx or xx + ww <= x or y + h <= yy or yy + hh <= y, (key, other))
        for phase in range(5):
            self.assertEqual((16, 16) if phase < 3 else (32, 32), regions[f'explosion:{phase}'][2:])
        for direction in ('up', 'right', 'down', 'left'):
            self.assertEqual((8, 16), regions[f'bullet:{direction}'][2:])

    def test_generated_maps_audio_and_pixels_match_independent_web_reads(self):
        self.assertEqual(0, self.generate().returncode)
        script = self.root / 'read-web.mjs'
        script.write_text("""import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const web=new URL('./web/src/',import.meta.url).href;
registerHooks({resolve(s,c,next){return next(s.startsWith('.')&&c.parentURL?.startsWith(web)&&!s.split('/').at(-1).includes('.')?s+'.ts':s,c);},load(url,c,next){return url===web+'core/types.ts'?{format:'module',source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform'}),shortCircuit:true}:next(url,c);}});
const {getLevel}=await import(web+'data/levels.ts');
const audio=await import(web+'platform/audio-cues.ts');
const p=await import(web+'game/pixel-assets.ts');
const cases=[['player:0:2:right:1',{team:'player',playerIndex:0,stars:2,direction:'right'},1],['enemy:armor:hp4:left:1',{team:'enemy',kind:'armor',hp:4,carryingPowerUp:false,direction:'left'},1]];
const samples=cases.map(([key,tank,tread])=>{
 const pixels=Array(16*16*4).fill(0);let color;
 p.drawBitmap({fillStyle(c){color=c;},fillRect(x,y,w,h){for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){const i=(yy*16+xx)*4;pixels.splice(i,4,color>>>16,color>>>8&255,color&255,255);}}},p.tankBitmap(tank,tread),0,0,p.tankColors(tank,10));
 return {key,pixels};
});
for(const [prefix,frames,colors] of [['spawn:',p.SPAWN_FRAMES,{W:p.PALETTE.white}],['shield:',p.SHIELD_FRAMES,{W:p.PALETTE.white}],['explosion:',p.EXPLOSION_FRAMES,p.BURST_COLORS],['impact:',p.IMPACT_FRAMES,p.BURST_COLORS],['points:',p.POINT_BITMAPS,{W:p.PALETTE.white}]]){
 for(const [index,rows] of Object.entries(frames)){
  const width=rows[0].length,height=rows.length,pixels=Array(width*height*4).fill(0);let color;
  p.drawBitmap({fillStyle(c){color=c;},fillRect(x,y,w,h){for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){pixels.splice((yy*width+xx)*4,4,color>>>16,color>>>8&255,color&255,255);}}},rows,0,0,colors);
  samples.push({key:prefix+index,pixels});
 }
}
console.log(JSON.stringify({levels:Array.from({length:70},(_,i)=>getLevel(i+1)),notes:audio.NOTE_PERIODS,tracks:audio.AUDIO_TRACKS,samples}));
""")
        run = subprocess.run(['node', str(script)], cwd=self.root, capture_output=True, text=True, timeout=30)
        self.assertEqual(0, run.returncode, run.stderr)
        expected = json.loads(run.stdout)
        kinds = ['basic', 'fast', 'power', 'armor']
        for stage, level in enumerate(expected['levels'], 1):
            terrain = (self.output / f'assets/battle/stage{(stage - 1) % 35 + 1}.txt').read_text().splitlines()[0]
            enemies = (self.output / f'assets/battle/stage{min(stage, 35)}.txt').read_text().splitlines()[1]
            self.assertEqual(level['tiles'], list(map(int, terrain.split(','))), stage)
            self.assertEqual([kinds.index(k) for k in level['enemies']], list(map(int, enemies.split(','))), stage)
        java = (self.output / 'java/org/jiangc/bc/audio/AudioCues.java').read_text()
        notes = re.search(r'NOTES = \{([^}]+)\}', java).group(1)
        self.assertEqual(expected['notes'], list(map(int, notes.split(','))))
        body = java.split('TRACKS = {', 1)[1].split('};', 1)[0]
        tracks = [list(map(int, values.split(','))) if values else None
                  for values, null in re.findall(r'\{([0-9,]+)\}|(null)', body)]
        self.assertEqual(expected['tracks'], tracks)
        width, _, pixels = self.png()
        for sample in expected['samples']:
            x, y, w, h = self.regions()[sample['key']]
            actual = b''.join(pixels[((y + row) * width + x) * 4:((y + row) * width + x + w) * 4] for row in range(h))
            self.assertEqual(bytes(sample['pixels']), actual, sample['key'])


if __name__ == '__main__':
    unittest.main()
