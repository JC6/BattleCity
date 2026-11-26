"""Summarize the three matched A/B/C windows for each television presentation workload."""
import argparse
import csv
import json
import math
import re
from pathlib import Path
from statistics import median

from native_window_report import table
from tv_buffer_report import frame_boundaries


def window_summary(name, path, row):
    frames = frame_boundaries(path, name, row)
    times = sorted((end - swap) / 1e6 for _, _, _, _, swap, end, _ in frames)
    config = (path / (name + '-window.txt')).read_text()
    capability = re.findall(r'bufferAge=(\d) swapDamage=(\d) incremental=(\d) perFrameFlush=(\d)', config)
    if not capability or not times:
        raise ValueError(f'{name} is missing its EGL configuration or measured frames')
    case, variant, repeat = name.split('-')[:3]
    age, damage, incremental, sync = map(int, capability[-1])
    if sync != (variant == 'sync') or incremental != (variant == 'damage' and age):
        raise ValueError(f'{name} ran with unexpected EGL settings: {capability[-1]}')
    copies = re.findall(r'copiesFull=(\d+) copiesPartial=(\d+)', config)
    sizes = re.findall(r'logical=\d+x\d+ egl=(\d+)x(\d+)', config)
    if not copies or not sizes or sizes[-1] != ('1195', '960'):
        raise ValueError(f'{name} is missing full-window geometry or copy counts')
    full, partial = map(int, copies[-1])
    if (partial and not incremental) or full+partial == 0:
        raise ValueError(f'{name} reported inconsistent copy counts')
    return dict(scene=case, variant=variant, repeat=int(repeat), wall=row['wall'],
                submitted=row['frames'], observed=row['individuallyObserved'], evidence=row['displayEvidence'],
                observed_fps=round(row['individuallyObserved']/row['wall'], 4),
                game=row.get('gameSpeed'), pcm=row.get('pcmSpeed'), swap_p50_ms=round(median(times), 4),
                swap_p95_ms=round(times[math.ceil(.95*len(times))-1], 4),
                buffer_age=age, swap_damage=damage, incremental=incremental,
                width=int(sizes[-1][0]), height=int(sizes[-1][1]),
                full_at_last_counter=full, partial_at_last_counter=partial), frames


def presentation_sections(run):
    folder=run/'tv-device-results/presentation'
    clocks=json.loads((folder/'clock.json').read_text())
    assert len(set(clocks['battle'].values())) == 1
    summaries=[]
    with (run/'presentation-frames.csv').open('w',newline='') as file:
        writer=csv.writer(file)
        writer.writerow(['window','frame','buffer','start_ns','swap_ns','return_ns','display_ns'])
        for name,rows in clocks['windows'].items():
            assert len(rows) == 1
            info,frames=window_summary(name,folder,rows[0])
            summaries.append(info)
            writer.writerows(frames)
    assert {(r['scene'],r['variant'],r['repeat']) for r in summaries} == {
        (s,v,n) for s in ('producer','battle','explosions') for v in ('sync','batch','damage') for n in (1,2,3)}
    with (run/'presentation-cost.csv').open('w',newline='') as file:
        writer=csv.DictWriter(file,fieldnames=summaries[0])
        writer.writeheader()
        writer.writerows(summaries)
    labels={'producer':'预制画面与交替色块','battle':'普通战斗','explosions':'连续爆炸',
            'sync':'全图，逐帧刷新日志','batch':'全图，分批刷新日志','damage':'驱动选择复制范围，分批刷新日志'}
    cells=[]
    medians=[]
    for case in ('producer','battle','explosions'):
        for variant in ('sync','batch','damage'):
            group=sorted((r for r in summaries if r['scene']==case and r['variant']==variant),key=lambda r:r['repeat'])
            rates=[r['observed_fps'] for r in group]
            def speed(key):
                values=[r[key] for r in group if r[key] is not None]
                return f'{median(values):.2%}' if values else '—'
            medians.append([labels[case],labels[variant],f'{median(rates):.2f}',
                            f'{min(rates):.2f}–{max(rates):.2f}',speed('game'),speed('pcm')])
            for r in group:
                cells.append([labels[case], labels[variant], r['repeat'], f"{r['observed']}/{r['submitted']}",
                    f"{r['observed_fps']:.2f}", '—' if r['game'] is None else f"{r['game']:.2%}",
                    '—' if r['pcm'] is None else f"{r['pcm']:.2%}", r['swap_p50_ms'], r['swap_p95_ms'],
                    '局部' if r['partial_at_last_counter'] else '全图'])
    capabilities=summaries[0]
    seen=sum(r['observed'] for r in summaries)
    submitted=sum(r['submitted'] for r in summaries)
    interpretation=('本次驱动未提供缓冲年龄，所有实测窗口均执行整帧复制。局部复制的收益仍需在支持缓冲年龄的设备上测量。'
                    if not any(r['buffer_age'] for r in summaries) else '')
    return ['<h2>日志刷新和窗口复制的独立对照</h2><p>三组均使用同一安装包、同一原始状态与完整 EGL 窗口。'
            '预制画面以交替色块标识连续提交，帧率按系统可逐一关联的显示回执计算。'
            f"驱动报告缓冲年龄支持为 {capabilities['buffer_age']}，带变化矩形的交换支持为 {capabilities['swap_damage']}。"
            f'{interpretation}共提交 {submitted:,} 帧，实际关联 {seen:,} 个显示回执。'
            '每种组合单独启动三次，汇总三个窗口的中位数和范围。日志刷新使用 C 标准库 fflush。最后一列取自每 128 帧记录的累计复制计数。</p>',
            table(('场景','路径','显示帧/秒中位数','显示帧/秒范围','游戏速度中位数','系统 PCM 中位数'),medians),
            table(('场景','路径','轮次','已显示 / 提交','实际显示帧/秒','游戏速度','系统 PCM',
                   '交换中位数 ms','交换 P95 ms','实际复制'),cells)]


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run',type=Path,help='extracted run directory containing tv-device-results/presentation')
    directory=parser.parse_args().run
    presentation_sections(directory)
    print(directory/'presentation-cost.csv',directory/'presentation-frames.csv',sep='\n')
