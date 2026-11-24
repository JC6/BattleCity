"""Build the offline full-frame TV comparison from one Actions run and the measured Switch excerpts."""
import argparse
import csv
import gzip
import hashlib
import io
import json
from html import escape
from pathlib import Path
import re
import statistics
from zipfile import ZIP_DEFLATED, ZipFile

from runtime_report import inline, rows, table, timeline


def json_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def csv_text(records):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=list(records[0]))
    writer.writeheader()
    writer.writerows(records)
    return stream.getvalue()


def trace_summary(render, name):
    with gzip.open(render/(name+'-atrace.txt.gz'),'rt',errors='replace') as stream:
        trace=stream.read()
    layers=(render/(name+'-surface.txt')).read_text()
    times=set()
    for line in layers.splitlines():
        fields=line.split()
        if len(fields)==3 and all(n.isdigit() for n in fields):
            presented=int(fields[1])
            if 0<presented<2**63-1: times.add(presented)
    ordered=sorted(times)
    gaps=[(b-a)/1e6 for a,b in zip(ordered,ordered[1:])]
    return (trace.count('|BattleCity.draw'),trace.count('|BattleCity.present'),len(times),
            f'{statistics.median(gaps):.2f}' if gaps else '无可用时间戳')


def renderer_spans(render, name):
    stacks = {}
    records = []
    pattern = re.compile(r'-(\d+)\s+\([^)]*\)\s+\[\d+\].*?([0-9]+\.[0-9]+): tracing_mark_write: ([BE])(?:\|[0-9]+)?(?:\|(.*))?$')
    with gzip.open(render/(name+'-atrace.txt.gz'),'rt',errors='replace') as trace:
        for line in trace:
            if 'tracing_mark_write: ' not in line:
                continue
            match = pattern.search(line.rstrip())
            if not match: continue
            tid,stamp,action,section=match.groups()
            stamp=float(stamp)
            if tid not in stacks:
                if section not in ('BattleCity.draw','BattleCity.present'): continue
                stacks[tid]=[]
            stack=stacks[tid]
            if action=='B':
                stack.append((section,stamp))
            elif stack:
                label,start=stack.pop()
                parent=next((part for part,_ in reversed(stack) if part in ('BattleCity.draw','BattleCity.present')),None)
                if label in ('BattleCity.draw','BattleCity.present') or (parent and label in ('queueBuffer','dequeueBuffer','eglSwapBuffers')):
                    records.append({'mode':name,'section':label,'parent':parent or '', 'start_s':start,'duration_ms':round((stamp-start)*1000,4)})
    return records


def tail_chart(research):
    series=[('ending-first','native','当前卡带','#24262a'),('ending-first','switch','第一次','#00768b'),
            ('ending-english','switch','第二次','#ce7713'),('ending-last','switch','通关录像','#8063ae')]
    chart=['<svg role="img" aria-label="结束和弦 261.4 Hz 分量相对幅度" viewBox="0 0 660 190" width="660">'
           '<path d="M35 10V150H620" fill="none" stroke="#777"/>']
    for label,t in [('1.30',1.3),('1.40',1.4),('1.50',1.5),('1.60',1.6),('1.70 秒',1.7)]:
        x=35+(t-1.3)*1400
        chart.append(f'<text x="{x}" y="171" font-size="12">{label}</text>')
    for folder,source,name,color in series:
        records=[r for r in rows(research/folder/'envelope.csv') if r['source']==source]
        peak=max(float(r['level_261.4Hz']) for r in records if float(r['center_s'])<=1.5)
        points=' '.join(f"{35+(float(r['center_s'])-1.3)*1400:.1f},{150-130*float(r['level_261.4Hz'])/peak:.1f}"
                        for r in records if 1.3<=float(r['center_s'])<=1.7)
        chart.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="2"><title>{name}</title></polyline>')
    return ''.join(chart)+'</svg><p>'+ ' · '.join(f'<span style="color:{c}">{name}</span>' for _,_,name,c in series)+'</p>'


def build(run, research, output, commit, default, scenes_run):
    if not re.fullmatch(r'[0-9a-f]{40}',commit) or not run.name.isdigit():
        raise ValueError('Use the full source commit and numeric Actions run directory.')
    tv = run/'tv-device-results'
    render = tv/'render'
    web = run/'web-clock-and-endings'
    clock = json.loads((render/'clock.json').read_text())
    visual = json.loads((render/'visual.json').read_text())
    scenes=scenes_run/'tv-device-results'/'scenes'
    visual.update(json.loads((scenes/'visual.json').read_text()))
    if scenes_run!=run:
        exact=(scenes.parent/'tested-sha256.txt').read_text().split()[0]
        with (output/'BattleCity-TV-x86.apk').open('rb') as stream:
            assert hashlib.file_digest(stream,'sha256').hexdigest()==exact, 'fixed scenes used another APK'
    assert set(visual)>={'firing','blast'}
    assert set(visual)>={'standard','large','pixel','stretch','antialias','scanlines'}
    assert len(set(clock['battle'].values()))==1
    assert set(clock['windows'])=={'baseline','candidate'}
    for folder in [tv,tv/'candidate-controls']:
        assert json.loads((folder/'result.json').read_text())['result']=='passed', folder
    raw = []
    for key,records in clock['windows'].items():
        assert len(records)==3
        for row in records:
            raw.append({'mode':key,**row})
    candidate = clock['windows']['candidate']
    speed_pass = all(r['pass'] for r in candidate) and all(r['nativeSize']>0 for r in candidate)
    pixel_pass = all(v['differentCenters']==0 and v['differentWallpaperPixels']==0 for v in visual.values())
    if default=='native-tv' and not (speed_pass and pixel_pass):
        raise ValueError('Candidate lacks passing full-frame and visual measurements.')
    labels = {'baseline':'默认对照','candidate':'原始分辨率候选'}
    html = ['<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>Battle City 电视全帧验收</title>'
            '<style>body{font:16px/1.65 system-ui,sans-serif;margin:32px auto;padding:0 20px;max-width:1120px;color:#222}'
            'table{border-collapse:collapse;font-size:14px}th,td{border:1px solid #aaa;padding:4px 8px;text-align:right}'
            'img{max-width:100%;height:auto}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}'
            'code,pre{overflow-wrap:anywhere;white-space:pre-wrap}audio{max-width:100%}</style>'
            '<h1>Battle City 电视全帧验收</h1>',
            f'<p>目标为 Switch 英文版《NAMCO MUSEUM ARCHIVES Vol. 2》中的《Battle City》。交付默认显示路径为'
            f' <code>{escape(default)}</code>。源码 <code>{commit}</code>。'
            f'<a href="https://github.com/JC6/BattleCity/actions/runs/{run.name}">同提交验收记录</a></p>',
            '<h2>Android TV 的游戏时钟、PCM 和画面提交</h2>'
            '<p>同一台 API 34、1080p x86 电视模拟器，两次冷启动使用相同的手柄输入。预热 10 个模拟秒后，每条路径连续测量三个至少 30 秒的窗口。'
            '游戏倍率为模拟秒除以真实秒，PCM 倍率为交给首个系统音频输出流的采样帧数除以采样率和真实秒。SDL 提交计数来自 RenderPresent 成功返回。'
            '实体电视的显示时刻及按键到画面的延迟仍待实测。</p>']
    html.append(table(('路径','窗口','SDL 驱动','秒','游戏倍率','PCM 倍率','NES 帧','成功提交','紧凑纹理帧',
                       '核心毫秒/帧','绘制毫秒/提交','呈现毫秒/提交','线程 CPU 毫秒/提交'),[
        (labels[r['mode']],r['run'],r['driver'],f"{r['wall']:.3f}",f"{r['gameSpeed']:.4f}",f"{r['pcmSpeed']:.4f}",
         r['frames'],r['presented'],r['nativeSize'],f"{r['coreSliceMs']/r['frames']:.2f}",
         *(f"{r[k]/r['attempts']:.2f}" for k in ('drawMs','presentMs','threadCpuMs'))) for r in raw]))
    passed = sum(r['pass'] for r in candidate)
    html.append(f'<p>候选有 {passed}/3 个窗口同时满足游戏和 PCM 在实时的 99% 至 101% 之间，且每个窗口完整提交画面。'
                f'定帧截图的全部游戏像素中心与游戏区外画面一致性检查结果为{"通过" if pixel_pass else "有差异"}。</p>')
    detailed = json_lines(tv/'timing/clock.jsonl')
    html.append('<p>开着 WAV 录制和每三帧一次 RAM 文件观测的相同默认路径，三个窗口的游戏倍率为 '
                + '、'.join(f"{r['speed']:.3f}" for r in detailed)+'。轻量窗口只在边界写一行累计计数。'
                '系统跟踪在第三个窗口结束后从同一前台进程采集，核心、绘制与提交耗时按各自的计数归一化。</p>')
    html.append('<h2>同帧画质和手柄</h2><p>每对截图在相同 NES 帧暂停，并核对全部 2 KiB 工作 RAM 的摘要。'
                '在可见游戏区逐一比较 256 × 224 个像素中心，同时比较完整 1080p 截图的 RGB。'
                '两个显示路径各自还用两个 Android 内核手柄执行了单人、双人、断线重连、回退、存档保护、预览和系统菜单操作。</p>')
    html.append(table(('路径','跟踪中的绘制','跟踪中的呈现','SurfaceFlinger 有效时间戳','合成间隔中位数 / 毫秒'),[
        (labels[name],*trace_summary(render,name)) for name in labels]))
    spans = [span for name in labels for span in renderer_spans(render,name)]
    trace_rows=[]
    for name in labels:
        series=[r for r in spans if r['mode']==name]
        for section in ('BattleCity.draw','BattleCity.present','dequeueBuffer','queueBuffer','eglSwapBuffers'):
            durations=sorted(r['duration_ms'] for r in series if r['section']==section)
            if durations:
                trace_rows.append((labels[name],section,len(durations),f'{statistics.median(durations):.2f}',
                                   f'{durations[(95*len(durations)+99)//100-1]:.2f}'))
    if trace_rows:
        html.append(table(('路径','跟踪区段','完整调用','中位毫秒','P95 毫秒'),trace_rows))
        html.append('<p>队列与交换操作位于绘制或呈现调用之内，耗时存在包含关系。</p>')
    case_names={'firing':'移动、护盾和实弹','blast':'坦克爆炸和基地受击','standard':'4:3','large':'Zoom','pixel':'Dot-by-Dot','stretch':'Full Screen','antialias':'抗锯齿＋星空壁纸','scanlines':'扫描线＋符号壁纸'}
    html.append(table(('场景','帧与 RAM 摘要','分辨率','不同的中心像素','整图差异像素','通道差大于 8','游戏区外差异','最大通道差','整图相同'),[
        (case_names.get(name,name),v['battle'],' × '.join(map(str,v['size'])),v['differentCenters'],v['differentOutputPixels'],v['deltaAbove8'],v['differentWallpaperPixels'],v['maxChannelError'],'是' if v['identical'] else '否')
        for name,v in visual.items()]))
    html.append('<div class="pair">'+''.join('<figure><img alt="'+labels[key]+'" src="'+inline(render/('standard-'+key+'.png'),'image/png')+'"><figcaption>'+labels[key]+'</figcaption></figure>'
                                             for key in labels)+'</div>')
    html.append('<div class="pair">'+''.join('<figure><img alt="'+case_names[key]+'" src="'+inline(scenes/(key+'-candidate.png'),'image/png')+'"><figcaption>'+case_names[key]+'</figcaption></figure>'
                                            for key in ('firing','blast'))+'</div>')
    browser_rows = []
    for engine in ('chromium','webkit'):
        for cadence in ('native','60','120'):
            samples=[r for r in json_lines(web/f'{engine}-{cadence}.jsonl') if 'lifecycle' not in r]
            assert len(samples)==3 and all(abs(r['speed']-1)<=.01 and abs(r['audioSpeed']-1)<=.01 for r in samples)
            browser_rows.extend(samples)
    def bounds(values): return f'{min(values):.4f}–{max(values):.4f}'
    html.append('<h2>Web 和卡带回放</h2>'+table(('浏览器','前台节奏','窗口数','游戏倍率','PCM 倍率'),[
        (engine,cadence,3,bounds([r['speed'] for r in browser_rows if r['engine']==engine and str(r['cadence'])==cadence]),
         bounds([r['audioSpeed'] for r in browser_rows if r['engine']==engine and str(r['cadence'])==cadence]))
        for engine in ('chromium','webkit') for cadence in ('native','60','120')]))
    cartridge = hashlib.sha256((run/'cartridge/game.nes').read_bytes()).hexdigest()
    stages = [r for file in sorted(run.glob('stage-replay-*/stages.csv')) for r in rows(file)]
    assert sorted(int(r['stage']) for r in stages)==list(range(1,36))
    html.append(table(('回放','条目','比对更新数'),[
        (label,len(group),sum(int(r['reference_updates']) for r in group)) for label,group in
        (('逐关',stages),('双人',rows(run/'stage-replay-0/coop.csv')),('无人演示',rows(run/'stage-replay-0/attract.csv')),
         ('连续两轮后回到第一关',rows(run/'campaign-loop/loop.csv')))]))
    for group in (stages,rows(run/'stage-replay-0/coop.csv'),rows(run/'stage-replay-0/attract.csv'),rows(run/'campaign-loop/loop.csv')):
        assert all(r['result']=='passed' and r['cartridge_sha256']==cartridge for r in group)
    ending_rows=[]
    for route in ('neutral','record','skip-over'):
        web_end=timeline(web/('web-'+route))
        tv_end=timeline(tv/'timing'/('tv-'+route))
        assert web_end[:-1]==tv_end[:-1], route
        ending_rows.append((route,web_end[0],web_end[1],web_end[2],web_end[4],web_end[6]))
    html.append(table(('结局输入','爆炸音','结算','乐曲指令','GAME OVER 持续帧','回到标题帧'),ending_rows))
    projectiles=rows(research/'motion/projectiles.csv')
    assert all(r['pixel_errors']=='0' for r in projectiles)
    html.append('<h2>英文 Switch 实录逐帧对照</h2><p>连续跟踪空旷区域中的弹丸，并从交付卡带解码四个方向的图形。'
                '上排为原作者的采集画面，下排为卡带像素，列顺序为上、右、下、左。</p><img width="640" alt="四方向弹丸采样" src="'
                +inline(research/'motion/projectiles.png','image/png')+'">'+table(('方向','连续采集帧','可见像素/弹丸','轮廓误差'),[
                    (direction,len([r for r in projectiles if r['direction']==direction]),10,0) for direction in ('up','right','down','left')]))
    effects=rows(research/'motion/effects.csv')
    html.append('<p>护盾会被坦克和地形遮挡。下表的交并比以可见白色区域计算，逐帧位置、阈值和测量脚本随包提供。</p>')
    html.append(table(('效果','图块','采集帧数','白色轮廓交并比'),[
        (kind,tile,len(group),bounds([float(r['iou']) for r in group])) for kind,tile in sorted({(r['effect'],r['tile']) for r in effects})
        if (group:=[r for r in effects if r['effect']==kind and r['tile']==tile])]))
    score=rows(research/'score/digits.csv')
    assert all(r['mismatches']=='0' for r in score) and {r['field'] for r in score}=={'HISCORE','2','6','8','0'}
    html.append('<h2>最高分大字</h2><p>日语解说录像出现 26800。先用已在英文录像确认的 HISCORE、8 和两个 0 校准位置，'
                '再比较 2 和 6，每个数字各 56 格。在三个不同闪烁相位中，两者与卡带均零格差异。'
                '作者标题标注 Switch，画面没有可独立确认英文合集的系统界面，因此单列为补充对照。'
                '<a href="https://www.youtube.com/watch?v=aRGjPGSfBmk&amp;t=802s">原作者录像，13 分 22 秒</a></p>'
                '<img width="600" alt="日语解说录像中可见的 HISCORE 26800" src="'+inline(research/'score/score.png','image/png')+'">')
    proxy_scores=[]
    for folder,value,views in [('score-famicom-one','196500','171.8 万'),('score-famicom-two','441900','18.9 万')]:
        entries=rows(research/folder/'digits.csv')
        assert all(r['mismatches']=='0' for r in entries)
        proxy_scores.append((value,views,len({r['source_seconds'] for r in entries}),0))
    html.append('<p>另核对 Nenriki 的两段 Famicom 录像。196500 再次出现 6，441900 的两个 4 '
                '均与卡带各 56 格匹配。播放量取本轮检索时的近似值。英文 Switch 字形仍以对应版本的画面为准。'
                '<a href="https://www.youtube.com/watch?v=fuMYsGiS33k&amp;t=2283s">一轮录像</a> · '
                '<a href="https://www.youtube.com/watch?v=Xww2jXpQSwQ&amp;t=4128s">两轮录像</a></p>'
                +table(('Famicom 分数','约播放量','采样时刻数','格差'),proxy_scores))
    html.append('<h2>结束音乐</h2>')
    audio_rows=[]
    for folder,source,origin in [('ending-first','My Gameplay Videos，第一次',318),('ending-english','My Gameplay Videos，第二次',645),
                                 ('ending-last','Crolister，通关录像',2608)]:
        align=rows(research/folder/'alignment.csv')
        tails=rows(research/folder/'tail.csv')
        whole=next(r for r in align if r['part']=='whole')
        audio_rows.append((source,f"{origin+float(whole['switch_aligned_start_s']):.3f}",whole['spectral_cosine'],
                           *(next(r['duration_to_quiet_s'] for r in tails if r['source']==k) for k in ('native','switch'))))
    html.append(table(('原始录像','原视频起音秒','整段频谱相似度','卡带至静音秒','录像至静音秒'),audio_rows))
    html.append(tail_chart(research))
    html.append('<p>曲线为混音中 261.4 Hz 的幅度，使用 40 毫秒 Hann 窗，按每条录音在 1.10 至 1.50 秒区间内的峰值归一化。'
                '两个脉冲声道在末和弦具有相同的基频。</p>')
    html.append('<p>尾音按连续十个 10 毫秒窗口均低于该段峰值的 1.2% 判定。频谱来自完整混音。'
                '两条独立录像的控制器输入和采集设备设置均未公开。当前仍缺英文 Switch 无输入演示、双人完整结局、逐次回退跨度和最高分大字 2、3、4、6、7 的直接证据。</p>'
                '<p><a href="https://www.bandainamcoent.com/games/namco-museum-archives-vol-2">万代南梦宫英文产品页</a> · '
                '<a href="https://nc.bn-ent.net/product/useful.php">官方回退说明</a> · '
                '<a href="https://www.youtube.com/watch?v=S26lUv598_o&amp;t=352s">My Gameplay Videos 实录</a> · '
                '<a href="https://www.youtube.com/watch?v=Xf02flMP7dc&amp;t=2614s">Crolister 通关实录</a></p>')
    manifest=(output/'SHA256SUMS').read_text()
    assert cartridge in manifest
    html.append('<h2>交付文件的 SHA-256</h2><pre>'+escape(manifest)+'</pre></html>')
    (output/'Switch-TV-Comparison.html').write_text(''.join(html),encoding='utf-8')
    with ZipFile(output/'Switch-TV-Measurements.zip','w',compression=ZIP_DEFLATED,compresslevel=5) as archive:
        archive.writestr('tv-clock.csv', csv_text(raw))
        archive.writestr('web-clock.csv',csv_text(browser_rows))
        if spans: archive.writestr('renderer-trace.csv',csv_text(spans))
        archive.writestr('SHA256SUMS',manifest)
        archive.writestr('source.txt',commit+'\nhttps://github.com/JC6/BattleCity/actions/runs/'+run.name+'\n')
        for path in sorted(run.rglob('*')):
            if path.is_file() and (path.suffix in {'.csv','.json','.jsonl','.gz','.png','.wav'} or path.name.endswith('-surface.txt') or path.name in {'tested-sha256.txt','device.log','device.txt'}):
                archive.write(path,'actions/'+str(path.relative_to(run)))
        if scenes_run!=run:
            archive.writestr('scenes-run.txt','https://github.com/JC6/BattleCity/actions/runs/'+scenes_run.name+'\n')
            archive.write(scenes.parent/'tested-sha256.txt','scenes/tested-sha256.txt')
            for path in sorted(scenes.iterdir()):
                if path.is_file() and path.suffix in ('.png','.json'): archive.write(path,'scenes/'+path.name)
        for folder in ['motion','score','score-famicom-one','score-famicom-two','ending-first','ending-english','ending-last']:
            for path in sorted((research/folder).iterdir()):
                if path.is_file(): archive.write(path,'switch/'+folder+'/'+path.name)
        for name in ['tv_render_report.py','runtime_report.py','switch_battle_samples.py','switch_motion.py','switch_score_sample.py','switch_lettering.py','ending_audio.py','switch_cues.py','compare_switch_audio.py']:
            archive.write(Path(__file__).with_name(name),'scripts/'+name)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('run','research','output'): parser.add_argument(name,type=Path)
    parser.add_argument('--commit',required=True)
    parser.add_argument('--default',choices=['none','native-tv'],required=True)
    parser.add_argument('--scenes-run',type=Path)
    args=parser.parse_args()
    build(args.run,args.research,args.output,args.commit,args.default,args.scenes_run or args.run)
