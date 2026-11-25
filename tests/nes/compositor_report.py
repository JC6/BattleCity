"""Build the TV and Web acceptance report using the exact tested packages."""
import argparse
import csv
import hashlib
import html
import json
import wave
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from native_window_report import picture, table
from tv_release_gate import decision
from tv_stage_analysis import analyze


def read(path):
    return json.loads(path.read_text())


def rows(path):
    with path.open() as f:
        return list(csv.DictReader(f))


def sha(file):
    with file.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()


def build(root, run, dest, trials):
    run_id=run.name
    tv=run/'tv-device-results'
    gate=decision(tv,renderer='compositor-tv')
    assert gate==read(tv/'release-gate.json')
    identity=sha(dest/'game.nes')
    assert identity==sha(run/'cartridge/game.nes')
    web=sha(dest/'BattleCity-Web.zip')
    old=root.parent/'tv-native-window/ci/45426153747'
    receipt_lines=(run/'upgrade-chromium/packages.sha256').read_text().splitlines()
    assert receipt_lines==(run/'upgrade-webkit/packages.sha256').read_text().splitlines()
    receipts={path:digest for digest,path in (l.split() for l in receipt_lines)}
    assert receipts=={'previous/BattleCity-Web.zip':sha(old/'game-web/BattleCity-Web.zip'),
                      'current/BattleCity-Web.zip':web,'cartridge/game.nes':identity}
    for engine in ('chromium','webkit'):
        assert 'passed previous-release save upgrade' in (run/f'upgrade-{engine}/upgrade-{engine}.log').read_text()
    upgrade=read(tv/'upgrade.json')
    assert upgrade['previousCartridge']==upgrade['cartridge']==identity and upgrade['thumbnailPreserved'] and upgrade['lockPreserved']
    stages=analyze(tv/'held-out')
    (run/'stages.json').write_text(json.dumps(stages,indent=2)+'\n')
    sections=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<title>坦克大战 · Android TV 与 Web 验收</title><style>body{max-width:1120px;margin:auto;padding:24px;font:16px/1.6 system-ui;color:#172335}h1,h2{line-height:1.25}section{overflow-x:auto}table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid #bbc7d5;padding:5px 10px;text-align:left}figure{margin:6px;display:inline-block;max-width:min(100%,430px)}img{max-width:100%}small{color:#44576f}code{overflow-wrap:anywhere}pre{white-space:pre-wrap}a{color:#16457f}</style>',
        '<h1>坦克大战 · Android TV 与 Web 验收</h1>',
        '<p>目标为英文《南梦宫博物馆档案 Vol. 2》Switch 版。Web 使用键盘，Android TV 使用手柄，两端内嵌相同卡带。</p>',
        f'<p>电视默认使用 <b>{html.escape(gate["default"] if gate["default"]!="none" else "SDL 软件渲染")}</b>。测量设备为 API 34、1080p、x86 Android TV 模拟器。ARM64 安装包验证签名及内嵌卡带。物理屏幕延迟和电视音响延迟仍待测量。</p>',
        f'<p><a href="https://github.com/JC6/BattleCity/actions/runs/{run_id}">验收运行 {run_id}</a> · <code>{(run/"commit.txt").read_text().strip()}</code></p>',
        '<h2>电视帧率与音频</h2><p>游戏和系统 PCM 输出均需落在实时的 99%–101%。每个 NES 帧须对应一次提交和一次合成完成回调，窗口结束时不得积压。回调时间测量到 Android 合成服务。</p>']
    values=[]
    for folder in [old,*trials,run]:
        clock=folder/'tv-device-results/prototype/clock.json'
        if not clock.is_file():continue
        for name,samples in read(clock)['windows'].items():
            row=samples[0];n=row['frames']
            values.append([folder.name,name,f"{100*row['emu']/row['wall']:.2f}%",f"{100*row['samples']/row['sampleRate']/row['wall']:.2f}%",
                n,row.get('gpuFrames','—'),row['attempts'],row['presented'],row.get('completions','—'),row.get('pending','—'),
                ' / '.join(f"{row.get(k,0)/n:.2f}" for k in ('waitMs','lockMs','copyMs','postMs'))])
    sections+=[table(('运行','场景','游戏','系统 PCM','NES 帧','GPU 帧','尝试','提交','完成','积压','等待 / 锁定 / 绘制或复制 / 提交 ms/帧'),values),
        '<p>两次额外冷启动和八场景逐帧检查'+('已执行。' if gate['boots'] else '按预设条件跳过，前置检查未全部通过。')+'</p>',
        '<h2>冻结帧的三次采样</h2><p>每个场景同时记录 NES 光栅、交给显示系统前的 RGB 图和整张系统截图。重复拍摄软件基线建立噪声范围。校准图包含八种颜色和单像素线。</p>']
    visuals=read(tv/'held-out/visual.json')
    sections.append(table(('场景','首个超出噪声的阶段','源 / 展开 / 系统超噪像素','系统色边 / 非色边误差','像素中心 / 壁纸误差'),
        [[name,item['firstDifference'],' / '.join(str(v.get('aboveRepeatNoise','尺寸不同')) for v in item['stages'].values()),
          ' / '.join(str(item['stages']['system'][k]) for k in ('atBoundary','awayFromBoundary')),
          f"{visuals[name]['differentCenters']} / {visuals[name]['differentWallpaperPixels']}"] for name,item in stages.items()]))
    registration=stages['calibration']['stages']['system']
    edge_rows=[]
    for mode,title in [('baseline','软件基线'),('candidate','候选')]:
        sample=registration[mode+'Registration']
        for direction,label in [('left','左邻'),('right','右邻'),('above','上邻'),('below','下邻')]:
            edge=sample['edgeLeakage'][direction]
            edge_rows.append([title,label,edge['edges'],f"{edge['mean']:.3%}",f"{edge['p95']:.3%}"])
    sections.append('<p>将缓冲与系统截图配准后，在黑白校准线两侧测量相邻像素对输出颜色的贡献。数值按黑白边缘的亮度差归一化。</p>')
    sections.append(table(('显示路径','相邻方向','采样边数','平均贡献','第 95 百分位'),edge_rows))
    sections.append(picture(tv/'held-out/moving-633-baseline.png','软件基线，第 633 帧')+picture(tv/'held-out/moving-633-candidate.png','候选输出，同一帧'))
    sections.extend(['<h2>菜单、双手柄和存档</h2>',
        '<p>两种浏览器分别从上次发布的 ZIP 创建受保护的双人存档，再用本次 ZIP 读档、解锁并操作二号玩家。Android 以覆盖安装验证同一组数据。卡带摘要相同，本次直接使用原存档目录。</p>',
        '<p>空槽标志、顶栏、选中框和画面预览使用同一套菜单代码。表中数值为指定区域颜色掩模的交并比，1 为重合。电视旧版截图取自覆盖安装前，本次电视截图取自当前候选 APK 的双手柄测试。</p>'])
    if (run/'menu-regions.csv').is_file():
        sections.append(table(('区域','设备/版本','交并比'),[[r['region'],r['platform'],r['intersection_over_union']] for r in rows(run/'menu-regions.csv')]))
    web_clocks=[]
    for engine in ('chromium','webkit'):
        for cadence in ('native','60','120'):
            log=run/f'web-clock-and-endings/{engine}-{cadence}.jsonl'
            samples=[r for l in log.read_text().splitlines() if l.startswith('{') for r in [json.loads(l)] if 'run' in r]
            assert [r['run'] for r in samples]==[1,2,3]
            assert all(r['engine']==engine and str(r['cadence'])==cadence for r in samples)
            assert all(.99<=r[k]<=1.01 for r in samples for k in ('speed','audioSpeed'))
            web_clocks.append([engine,cadence,len(samples),
                '–'.join(f'{v:.2%}' for v in (min(r['speed'] for r in samples),max(r['speed'] for r in samples))),
                '–'.join(f'{v:.2%}' for v in (min(r['audioSpeed'] for r in samples),max(r['audioSpeed'] for r in samples)))])
    stage_rows=[r for i in range(5) for r in rows(run/f'stage-replay-{i}/stages.csv')]
    assert sorted(int(r['stage']) for r in stage_rows)==list(range(1,36))
    coop=rows(run/'stage-replay-0/coop.csv')
    campaign=rows(run/'campaign-loop/loop.csv')
    assert len(coop)==len(campaign)==1 and coop[0]['players']=='2' and campaign[0]['stage']=='1-70-1'
    assert all(r['cartridge_sha256']==identity and r['result']=='passed' and not r['first_difference']
               for r in stage_rows+coop+campaign)
    sections.append(f"<p>35 关独立回放、首关双人回放均通过。连续 70 关再回到第一关，共核对 {int(campaign[0]['reference_updates']):,} 次战斗更新。</p>")
    endings=[]
    for route,label in [('neutral','自然结束'),('record','刷新最高分'),('skip-over','按键跳过')]:
        events=[]
        durations=[]
        for folder in [run/f'web-clock-and-endings/web-{route}',tv/f'timing/tv-{route}']:
            events.append([(r['frame'],r['event'],r['value']) for r in rows(folder/'events.csv')])
            with wave.open(str(folder/'game.wav')) as stream:
                durations.append(f'{stream.getnframes()/stream.getframerate():.2f}')
        assert events[0] and events[0]==events[1], route
        endings.append([label,len(events[0]),*durations])
    sections.append(table(('结局','两端相同帧与事件数','Web 录音秒数','TV 录音秒数'),endings))
    sections.append(table(('浏览器','回调频率','窗口数','游戏','系统 PCM'),web_clocks))
    sections.append('<p>电视软件版覆盖安装保留了双人存档。当前候选版的完整双手柄测试'+('通过' if gate['candidateControlsPassed'] else '未通过')+'。覆盖安装后核对了缩略图与写保护，并用二号手柄恢复操作。</p>')
    for scene in ('system-menu','screen-settings'):
        for file,label in ((root/'reference-frames'/(scene+'.png'),'英文 Switch'),(run/'web-clock-and-endings/screens'/(scene+'.png'),'Web'),(tv/'candidate-controls'/(scene+'.png'),'Android TV')):
            if file.is_file():sections.append(picture(file,label+' · '+scene))
            elif label=='Android TV' and scene=='system-menu':sections.append(picture(tv/'candidate-controls/protected-slot.png','Android TV · 已写保护的存档槽'))
    sections+=['<h2>结算音乐与参考资料</h2><p>用本项目的无损 WAV，按五段参考视频各自的 AAC 码率、声道和采样率重新编码；先用有声音符定位起点，再测持续 100 ms 的低能量区间。另以 25 Hz 高通去除无损 WAV 的直流偏置，作为录制链路的对照。</p>']
    audio=[r for r in rows(root/'tail-codec.csv') if r['threshold']=='0.012']
    sections.append(table(('采样','编码输入','码率 bps','相关度','无损 s','再编码 s','Switch 录像 s'),
        [[r['source'],r['control'],r['bitrate'],r['onset_cosine'],r['lossless'],r['encoded'] or '无连续静音',r['switch_video']] for r in audio]))
    sections+=['<p>音色和音源释放时序维持现有实现。双人完整结局、确定无输入的待机过程、连续回退的逐次跨度以及大号 HISCORE 数字 2、3、4、6、7，仍缺英文 Switch 直接证据。</p>',
        '<p>日版 Switch 录像中，第 35 关的单人结算接入下一关，后来在地图编辑器入口显示了原作隐藏留言。该录像采用日版合集界面。<a href="https://www.youtube.com/watch?v=90hI6s_3iZ4&t=7166s">日版关末</a> · <a href="https://www.youtube.com/watch?v=90hI6s_3iZ4&t=7375s">日版隐藏留言</a></p>',
        '<p><a href="https://www.nintendo.com/us/store/products/namco-museum-archives-vol-2-switch/">任天堂游戏页</a> · <a href="https://nc.bn-ent.net/product/useful.php">万代南梦宫功能说明</a> · <a href="https://www.youtube.com/watch?v=S26lUv598_o&t=657s">系统菜单原片</a> · <a href="https://www.youtube.com/watch?v=uc_If5fksfA&t=270s">Xupgeeks 英文 Switch 结算录像</a></p>',
        '<h2>安装包</h2><pre>'+html.escape('\n'.join(f'{sha(p)}  {p.name}' for p in sorted(dest.iterdir()) if p.suffix in ('.nes','.lbl','.apk') or p.name=='BattleCity-Web.zip'))+'</pre></html>']
    (dest/'Switch-TV-Comparison.html').write_text('\n'.join(sections))
    with ZipFile(dest/'Switch-TV-Measurements.zip','w',ZIP_DEFLATED,compresslevel=5) as z:
        for folder in dict.fromkeys([*trials,run]):
            for f in sorted(folder.rglob('*')):
                rel=f.relative_to(folder)
                if not f.is_file() or not (rel.parts[0] in ('tv-device-results','web-clock-and-endings','upgrade-chromium','upgrade-webkit','campaign-loop') or rel.parts[0].startswith('stage-replay-') or f.name in ('artifact-receipts.json','job-status.json','gpu-shader.log','stages.json','menu-regions.csv','commit.txt','run.txt','artifact.json')):continue
                if f.suffix not in ('.json','.csv','.png','.gz','.log','.txt','.jsonl','.sha256','.wav'):continue
                z.write(f,str(Path(folder.name)/rel))
        for f in [root/'tail-codec.csv',root/'audio-recheck/terminal-av-sync.csv',*sorted((root/'reference-frames').glob('*.png'))]:
            z.write(f,'references/'+f.name)
        for f in (root/'research').glob('*'):
            if f.suffix in ('.tsv','.csv','.jpg'):
                z.write(f,'research/'+f.name)
        for n in ('compositor_report.py','tv_stage_analysis.py','tv_release_gate.py','native_window_report.py','tv_gpu_shader.cjs','tv_tail_codec.py','switch_menu_regions.py','television.py','tv-scenes.lua','tv-blast-load.lua','terminal_av_sync.py','ending_audio.py','ending_calibration.py','terminal_tally.py','switch_cues.py','compare_switch_audio.py'):
            z.write(Path(__file__).with_name(n),'methods/'+n)
        z.write(Path(__file__).resolve().parents[2]/'runtime/tv-gpu-raster.h','methods/tv-gpu-raster.h')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('root','run','destination'):parser.add_argument(name,type=Path)
    parser.add_argument('--trial',type=Path,action='append',default=[])
    args=parser.parse_args()
    build(args.root,args.run,args.destination,args.trial)
