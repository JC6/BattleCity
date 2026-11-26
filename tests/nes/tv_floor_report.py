"""Compare clear and cached blit using the same full window and ordinary EGL swaps."""
import csv
import json
import math
import re
from statistics import median

from native_window_report import table
from tv_buffer_report import frame_boundaries
from tv_swap_report import marker_strip

# NTSC NES master clock divided by the PPU dots per average frame.
NES_HZ = 21477272 / 4 / (341 * 262 - .5)
VARIANTS = ('cached', 'clear')


def evaluate(folder, output=None):
    clocks = json.loads((folder/'clock.json').read_text())
    order = [f'producer-{variant}-{n}' for n in (1, 2, 3)
             for variant in (VARIANTS if n % 2 else reversed(VARIANTS))]
    assert list(clocks['windows']) == list(clocks['battle']) == order
    assert len(set(clocks['battle'].values())) == 1
    rows, details, images = [], [], []
    for name in order:
        row, = clocks['windows'][name]
        _, variant, repeat = name.split('-')
        count, wall = row['frames'], row['wall']
        assert count > 0 and wall >= 30 and [row['width'], row['height']] == [1195, 960]
        assert (row['blits'], row['clears']) == ((count, 0) if variant == 'cached' else (0, count))
        config = (folder/(name+'-window.txt')).read_text()
        assert 'incremental=0 perFrameFlush=0 hintApi=plain' in config
        assert re.search(r'renderer=.*SwiftShader.* requestedInterval=1 ', config)
        last = row['lastSubmittedFrame']
        with (folder/(name+'-hints.csv')).open() as f:
            hints = [list(map(int, line)) for line in csv.reader(f) if last-count < int(line[1]) <= last]
        assert [h[1] for h in hints] == list(range(last-count+1, last+1))
        assert all(h[2:] == [0, 0, 0, 1195, 960] for h in hints)
        frames = frame_boundaries(folder, name, row)
        assert len(frames) == count and [frame[1] for frame in frames] == [hint[1] for hint in hints]
        times = sorted((end-swap)/1e6 for _, _, _, _, swap, end, _ in frames)
        marker = json.loads((folder/(name+'-marker.json')).read_text())
        hashes = marker['rgbSha256']
        assert len(hashes) == 4 and all(re.fullmatch('[a-f0-9]{64}', value) for value in hashes)
        images.append(hashes)
        observed = row['individuallyObserved']
        rows.append(dict(variant=variant, repeat=int(repeat), submitted=count, observed=observed,
                         observed_fps=observed/wall, swap_p50_ms=median(times),
                         swap_p95_ms=times[math.ceil(.95*count)-1], wall=wall,
                         blits=row['blits'], clears=row['clears'], evidence=row['displayEvidence'],
                         complete=row['verifiedPresentations']==observed==count,
                         pixels=marker['passed'] and marker['solidPixels']>500000 and hashes[0]==hashes[3]))
        if output is not None:
            details.extend(frames)
    rates = [[r['observed_fps'] for r in rows if r['variant']==v] for v in VARIANTS]
    spread = max(max(values)-min(values) for values in rates)
    gains = [b-a for a,b in zip(*rates)]
    matched = all(r['pixels'] for r in rows) and all(h==images[0] for h in images)
    receipts = all(r['complete'] for r in rows)
    passed = matched and receipts and min(rates[1]) >= .99*NES_HZ and min(gains) > spread
    if output is not None:
        with (output/'presentation-frames.csv').open('w',newline='') as f:
            w=csv.writer(f)
            w.writerow(('window','frame','buffer','start_ns','swap_ns','return_ns','display_ns'))
            w.writerows(details)
        with (output/'presentation-cost.csv').open('w',newline='') as f:
            w=csv.DictWriter(f,rows[0]); w.writeheader(); w.writerows(rows)
    return dict(rows=rows, matched=matched, receipts=receipts, spread=spread, gains=gains, passed=passed)


def sections(run):
    folder=run/'tv-device-results/floor'
    result=evaluate(folder,run)
    rows=result['rows']
    return ['<h2>电视整窗复制与直接清屏</h2><p>同一 EGL 窗口，普通交换，交换间隔 1。'
            'A 每帧复制完整纯色缓存，B 直接清屏。两组都在相同位置交替绘制 8 × 8 方块。</p>',
            table(('绘制','轮次','实际显示 / 提交','显示帧/秒','交换 P50 ms','交换 P95 ms','方块复原'),
                  [[r['variant'],r['repeat'],f"{r['observed']} / {r['submitted']}",f"{r['observed_fps']:.3f}",
                    f"{r['swap_p50_ms']:.3f}",f"{r['swap_p95_ms']:.3f}",r['pixels']] for r in rows]),
            f"<p>四阶段整屏像素一致 {result['matched']}。三次帧率增益为 "
            + '、'.join(f'{g:+.3f}' for g in result['gains'])
            + f"。组内最大波动 {result['spread']:.3f} 帧/秒。每次清屏均须达到 {NES_HZ*.99:.3f} 帧/秒。"
            + ('已进入实战与连续爆炸验证。' if result['passed'] else '未触发实战直绘验证。') + '</p>',
            *filter(None,(marker_strip(folder,f'producer-{v}-1') for v in VARIANTS))]
