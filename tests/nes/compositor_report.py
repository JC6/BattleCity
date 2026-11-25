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
from tv_layer_geometry import layer_geometry
from tv_presentation import reconcile
import gzip
from tv_stage_analysis import analyze


def read(path):
    return json.loads(path.read_text())


def rows(path):
    with path.open() as f:
        return list(csv.DictReader(f))


def sha(file):
    with file.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()


def build(root, run, dest, trials, previous=None):
    run_id=run.name
    tv=run/'tv-device-results'
    renderer=read(tv/'release-gate.json').get('candidate','compositor-tv')
    gate=decision(tv,renderer=renderer)
    recorded=read(tv/'release-gate.json')
    assert gate==recorded or (gate['default']==recorded['default']=='none' and {k:v for k,v in gate.items() if k!='windowReadbackPassed'}==recorded)
    identity=sha(dest/'game.nes')
    assert identity==sha(run/'cartridge/game.nes')
    web=sha(dest/'BattleCity-Web.zip')
    old=previous or root.parent/'tv-native-window/ci/45426153747'
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
    if renderer=='egl-tv':
        sections[-1]='<h2>电视帧率与音频</h2><p>游戏和系统 PCM 均须达到实时的 99%–101%。每个 NES 帧须在同一 SurfaceView 逐一匹配 EGL 显示时间戳或 SurfaceFlinger 的 PRESENT_FENCE。应用交换缓冲的次数单列记录。</p>'
    values=[]
    for folder in dict.fromkeys([old,*trials,run]):
        clock=folder/'tv-device-results/prototype/clock.json'
        if not clock.is_file():continue
        for name,samples in read(clock)['windows'].items():
            row=samples[0];n=row['frames']
            values.append([folder.name,name,f"{100*row['emu']/row['wall']:.2f}%",f"{100*row['samples']/row['sampleRate']/row['wall']:.2f}%",
                n,row.get('gpuFrames','—'),row['attempts'],row['presented'],row.get('completions','—'),row.get('pending','—'),
                ' / '.join(f"{row.get(k,0)/n:.2f}" for k in ('waitMs','lockMs','copyMs','postMs'))])
    sections+=[table(('运行','场景','游戏','系统 PCM','NES 帧','GPU 帧','尝试','提交','完成','积压','等待 / 锁定 / 绘制或复制 / 提交 ms/帧'),values),
        '<p>两次额外冷启动和八场景逐帧检查'+('已执行。' if gate['boots'] else '按预设条件跳过，前置检查未全部通过。')+'</p>',
        '<h2>冻结帧的分阶段采样</h2><p>每个场景同时记录 NES 光栅、交给显示系统前的 RGB 图和整张系统截图。重复拍摄软件基线建立噪声范围。校准图包含八种颜色和单像素线。</p>']
    if (tv/'menu-samples/1080/current').is_dir():
        stable=[json.loads(line) for line in (tv/'timing/clock.jsonl').read_text().splitlines()]
        assert [r['run'] for r in stable]==[1,2,3]
        sections.append('<h2>默认电视安装包</h2><p>三个连续窗口分别记录默认 APK 的模拟时钟与应用输出的 WAV。设备为同一台 1080p x86 模拟器。上一表中候选路径的系统声音输出来自混音设备计数器。</p>')
        sections.append(table(('窗口','实际秒数','NES 帧','游戏速度','录制 WAV 速度'),
            [[r['run'],f"{r['wall']:.2f}",r['frames'],f"{r['speed']:.2%}",f"{r['audioSpeed']:.2%}"] for r in stable]))
    measurements=read(tv/'prototype/clock.json')
    samples=measurements['windows']
    if renderer=='egl-tv':
        measurements_rows=[]
        for scene in ('battle','explosions'):
            variants=['software-'+scene,'child-'+scene,scene]
            if 'fifo-'+scene in samples:variants.append('fifo-'+scene)
            for variant in variants:
                row=samples[variant][0]
                assert measurements['battle'][variant]==measurements['battle'][scene]
                if variant in (scene,'fifo-'+scene):
                    raw=tv/'prototype'
                    reconcile([row],(raw/(variant+'-frame-map.csv')).read_bytes(),
                              (raw/(variant+'-present.csv')).read_bytes(),
                              gzip.decompress((raw/(variant+'-display.pftrace.gz')).read_bytes()),'org.jiangc.bc.runtime')
                    if gate['default']==renderer and variant==scene:assert row['verifiedPresentations']==row['frames']
                measurements_rows.append([variant,row['driver'],row['frames'],row['presented'],
                    row.get('identifiedBuffers','—'),row.get('nativeTimestampCount','—'),
                    row.get('individuallyObserved','—'),row.get('verifiedPresentations','—'),row.get('displayEvidence','未采集'),
                    f"{row['swapMsPerFrame']:.2f}" if row.get('mappedFrames') else '—'])
        sections.append(table(('场景','实际驱动','NES 帧','成功提交','已记录提交 ID','有效 EGL 时间戳','可逐帧关联','完整窗口确认','呈现凭据','交换耗时 ms/帧'),measurements_rows))
    if 'full-battle' in samples:
        timing=[]
        for scene in ('battle','explosions'):
            assert measurements['battle'][scene]==measurements['battle']['full-'+scene]
            for variant in ('full-'+scene,scene):
                row=samples[variant][0]
                n=row['frames']
                area=row['writtenPixels']/(row['bufferWidth']*row['bufferHeight']*n)
                assert 0<=area<=1 and row['finishFallbacks']<=n
                timing.append([variant,n,f'{area:.2%}',*[f"{row[k]/n:.3f}" for k in
                    ('uploadMs','drawCallMs','fenceMs','releaseWaitMs','postMs')],row['finishFallbacks']])
        sections.append('<h2>同一 APK 的整帧和局部绘制</h2><p>每对窗口从相同的战斗状态开始，按实际模拟帧数归一化。绘制栏测量 CPU 提交绘制调用所花的时间。同步栏包含取得 Android 原生栅栏或同步等待 GPU 完成所花的时间。</p>')
        sections.append(table(('场景','NES 帧','缓冲区写入面积','上传 ms/帧','绘制调用 ms/帧','同步 ms/帧','等待释放 ms/帧','事务提交 ms/帧','同步回退次数'),timing))
        if 'flushMs' in samples['battle'][0]:
            fields=('drawCheckMs','createFenceMs','flushMs','exportFenceMs')
            sections.append(table(('场景','检查 ms/帧','创建栅栏 ms/帧','提交 GPU 指令 ms/帧','导出与释放栅栏 ms/帧'),[
                [mode,*[f"{records[0][key]/records[0]['frames']:.3f}" for key in fields]]
                for mode,records in samples.items()]))
    visuals=read(tv/'held-out/visual.json')
    sections.append(table(('场景','首个超出噪声的阶段',' / '.join(next(iter(stages.values()))['stages'])+' 超噪像素','系统色边 / 非色边误差','像素中心 / 壁纸误差'),
        [[name,item['firstDifference'],' / '.join(str(v.get('aboveRepeatNoise','缺少回读' if 'missing' in v else '尺寸不同')) for v in item['stages'].values()),
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
    if 'candidateBeforePresent' in registration:
        layers=[]
        for mode,label in [('baseline','SDL 软件渲染器提交前回读'),('candidate','候选缓冲区回读')]:
            if mode+'BeforePresent' not in registration:
                continue
            item=registration[mode+'BeforePresent']
            direct=registration[mode+'LayerRegistration']
            layers.append([label,' × '.join(map(str,item['dimensions'][-1])),
                           item.get('differentPixels','尺寸不同'),str(direct['offset']),
                           *[f"{direct['edgeLeakage'][d]['mean']:.3%}" for d in ('left','right','above','below')]])
        sections.append('<p>校准帧还记录 SDL_RenderPresent 调用之前的软件绘制结果，以及候选路径提交给 Android 的硬件缓冲区。下表分别将两者配准到各自的系统截图。</p>')
        sections.append(table(('采样位置','缓冲尺寸','与展开缓冲差异像素','系统配准偏移','左邻','右邻','上邻','下邻'),layers))
    if renderer=='egl-tv':
        evidence=[]
        for mode,title in [('baseline','SDL 实际窗口'),('candidate','EGL 实际窗口')]:
            result=registration.get(mode+'SwapRegistration')
            if result:
                evidence.append([title,registration[mode+'ExpandedToSwap'].get('differentPixels','尺寸不同'),
                    str(result['offset']),*[f"{result['edgeLeakage'][d]['mean']:.3%}" for d in ('left','right','above','below')]])
            else:evidence.append([title,'缺少交换前回读',*['—']*5])
        sections.append('<p>SDL 在实际窗口纹理绘制后、交换前回读。候选版在 EGL 窗口交换前回读。后四列测量从该回读到系统截图之间的边缘变化。各路径的原始 SurfaceFlinger 图层记录随测量包提供。</p>')
        sections.append(table(('采样位置','展开到交换前差异像素','截图配准偏移','左邻','右邻','上邻','下邻'),evidence))
        geometry={}
        for path in sorted((tv/'held-out').glob('calibration-*-layers.pb.gz')):
            geometry[path.name.split('-')[1]]=layer_geometry(path)
        (run/'layer-geometry.json').write_text(json.dumps(geometry,indent=2)+'\n')
        layer_rows=[]
        for mode,records in geometry.items():
            for item in records:
                layer_rows.append([mode,item['name'],str(item['activeBuffer']),str(item['hwcSource'] or item['sourceBounds']),
                    str(item['hwcDestination'] or item['screenBounds']),str(item['effectiveTransform']),str(item['scalingMode'])])
        if layer_rows:
            sections.append(table(('校准路径','Android 图层','宽、高、步距和格式','源矩形','显示矩形','有效变换系数','缩放模式'),layer_rows))
        else:
            sections.append('<p>图层二进制记录未提供可解码的活动缓冲区几何。保留系统文本输出供核查。</p>')
    sections.append(picture(tv/'held-out/moving-633-baseline.png','软件基线，第 633 帧')+picture(tv/'held-out/moving-633-candidate.png','候选输出，同一帧'))
    sections.extend(['<h2>菜单、双手柄和存档</h2>',
        '<p>两种浏览器分别从上次发布的 ZIP 创建受保护的双人存档，再用本次 ZIP 读档、解锁并操作二号玩家。Android 以覆盖安装验证同一组数据。卡带摘要相同，本次直接使用原存档目录。</p>',
        '<p>空槽标志、顶栏、选中框和画面预览使用同一套菜单代码。表中数值为指定区域颜色掩模的交并比，1 为重合。电视菜单的新旧软件版在同一台模拟器上以相同分辨率分别采样。</p>'])
    if (run/'menu-regions.csv').is_file():
        sections.append(table(('区域','设备/版本','交并比'),[[r['region'],r['platform'],r['intersection_over_union']] for r in rows(run/'menu-regions.csv')]))
    if (run/'menu-sizes.csv').is_file():
        sizes=rows(run/'menu-sizes.csv')
        assert len(sizes)==24
        sections.append('<p>下表比较同一英文 Switch 截图上的六处菜单区域。每个分辨率均独立启动旧、新画面并重复截图。每项按预设标准与重复截图波动比较。</p>')
        sections.append(table(('平台','像素高度','区域','旧版 IoU','新版 IoU','变化','重复波动','达标'),
            [[r['platform'],r['height'],r['region'],r['old_iou'],r['new_iou'],r['delta'],r['repeat_variation'],'是' if r['passed']=='True' else '否'] for r in sizes]))
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
    supplemental=run/'reference-review/tv-coop-endings'
    for route,title in [('coop-stage18','双人第 18 关刷新纪录'),('coop-stage42','双人第 42 关保留纪录')]:
        browser=run/f'web-clock-and-endings/web-{route}'
        if not browser.is_dir(): browser=run/f'reference-review/web-{route}'
        device=tv/f'timing/tv-{route}'
        if not device.is_dir(): device=supplemental/f'coop-endings/tv-{route}'
        if (run/'reference-review/coop-stage42.csv').is_file():
            assert (browser/'events.csv').is_file() and (device/'events.csv').is_file(),route
        if browser.is_dir() and device.is_dir():
            events=[[(r['frame'],r['event'],r['value']) for r in rows(folder/'events.csv')] for folder in (browser,device)]
            assert events[0] and events[0]==events[1],route
            wavs=[]
            for folder in (browser,device):
                with wave.open(str(folder/'game.wav')) as stream:wavs.append(f'{stream.getnframes()/stream.getframerate():.2f}')
            endings.append([title,len(events[0]),*wavs])
    if supplemental.is_dir():
        hashes=dict(line.split()[::-1] for line in (supplemental/'tested.sha256').read_text().splitlines())
        assert hashes['cartridge/game.nes']==identity and hashes['deliverable/tv-emulator.apk']==sha(run/'game-tv-emulator/tv-emulator.apk')
        run_ref=(supplemental/'run.txt').read_text().strip()
        assert run_ref.isdecimal()
        sections.append(f'<p>双人录像补测使用本次构建的电视 APK。<a href="https://github.com/JC6/BattleCity/actions/runs/{run_ref}">电视补测 {run_ref}</a></p>')
    sections.append(table(('结局','两端相同帧与事件数','Web 录音秒数','TV 录音秒数'),endings))
    sections.append(table(('浏览器','回调频率','窗口数','游戏','系统 PCM'),web_clocks))
    sections.append('<p>电视软件版覆盖安装保留了双人存档。当前候选版的完整双手柄测试'+('通过' if gate['candidateControlsPassed'] else '未通过')+'。覆盖安装后核对了缩略图与写保护，并用二号手柄恢复操作。</p>')
    for scene in ('system-menu','screen-settings'):
        for file,label in ((root/'reference-frames'/(scene+'.png'),'英文 Switch'),(run/'web-clock-and-endings/screens'/(scene+'.png'),'Web'),(tv/'menu-samples/1080/current'/(scene+'.png'),'Android TV')):
            if file.is_file():sections.append(picture(file,label+' · '+scene))
            elif label=='Android TV' and scene=='system-menu':sections.append(picture(tv/'candidate-controls/protected-slot.png','Android TV · 已写保护的存档槽'))
    if (run/'reference-review/findings.csv').is_file():
        findings=rows(run/'reference-review/findings.csv')
        sections.append('<h2>目标版本与其他录像复核</h2>')
        sections.append(table(('来源','观察到的播放量','画面或作者说明','可验证范围'),
            [[r['title'],r['views'],r['observed'],r['scope']] for r in findings]))
        sections.append('<p>'+ ' · '.join(f'<a href="{html.escape(r["url"],quote=True)}">{html.escape(r["title"])}</a>' for r in findings)+'</p>')
    sections+=['<h2>结算音乐与参考资料</h2><p>用本项目的无损 WAV，按五段参考视频各自的 AAC 码率、声道和采样率重新编码；先用有声音符定位起点，再测持续 100 ms 的低能量区间。另以 25 Hz 高通去除无损 WAV 的直流偏置，作为录制链路的对照。</p>']
    audio=[r for r in rows(root/'tail-codec.csv') if r['threshold']=='0.012']
    sections.append(table(('采样','编码输入','码率 bps','相关度','无损 s','再编码 s','Switch 录像 s'),
        [[r['source'],r['control'],r['bitrate'],r['onset_cosine'],r['lossless'],r['encoded'] or '无连续静音',r['switch_video']] for r in audio]))
    if (run/'reference-review/coop-stage42.csv').exists():
        pair=rows(run/'reference-review/coop-stage42.csv')[0]
        sections.append(f'<p>英文 Switch 的双人第 42 关从最后两个总数出现到 GAME OVER 为 {float(pair["switch_total_to_over_s"]):.3f} 秒，本次 Web 卡带读屏实测 {float(pair["replica_total_to_over_s"]):.3f} 秒。第 18 关两名玩家分别获得 40400 和 68100 分，游戏显示 HISCORE 68100 后回到双人标题。同一屏摄中，大号 6 的 56 格笔画在三个时刻全部匹配。</p>')
    outstanding=('无输入的待机过程、连续回退的逐次跨度以及大号 HISCORE 数字 2、3、4、7' if
        (run/'reference-review/coop-stage42.csv').exists() else '双人完整结局、确定无输入的待机过程、连续回退的逐次跨度以及大号 HISCORE 数字 2、3、4、6、7')
    sections+=[f'<p>音色和音源释放时序维持现有实现。{outstanding}，仍缺英文 Switch 直接证据。</p>',
        '<p>日版 Switch 录像中，第 35 关的单人结算接入下一关，后来在地图编辑器入口显示了原作隐藏留言。该录像采用日版合集界面。<a href="https://www.youtube.com/watch?v=90hI6s_3iZ4&t=7166s">日版关末</a> · <a href="https://www.youtube.com/watch?v=90hI6s_3iZ4&t=7375s">日版隐藏留言</a></p>',
        '<p><a href="https://www.nintendo.com/us/store/products/namco-museum-archives-vol-2-switch/">任天堂游戏页</a> · <a href="https://nc.bn-ent.net/product/useful.php">万代南梦宫功能说明</a> · <a href="https://www.youtube.com/watch?v=S26lUv598_o&t=657s">系统菜单原片</a> · <a href="https://www.youtube.com/watch?v=uc_If5fksfA&t=270s">Xupgeeks 英文 Switch 结算录像</a></p>',
        '<p>测量压缩包附本地复核脚本。托管验收所用源码以报告开头的提交为准。</p>',
        '<h2>安装包</h2><pre>'+html.escape('\n'.join(f'{sha(p)}  {p.name}' for p in sorted(dest.iterdir()) if p.suffix in ('.nes','.lbl','.apk') or p.name=='BattleCity-Web.zip'))+'</pre></html>']
    (dest/'Switch-TV-Comparison.html').write_text('\n'.join(sections))
    with ZipFile(dest/'Switch-TV-Measurements.zip','w',ZIP_DEFLATED,compresslevel=5) as z:
        for folder in dict.fromkeys([*trials,run]):
            for f in sorted(folder.rglob('*')):
                rel=f.relative_to(folder)
                if not f.is_file() or not (rel.parts[0] in ('tv-device-results','web-clock-and-endings','upgrade-chromium','upgrade-webkit','campaign-loop') or rel.parts[0].startswith('stage-replay-') or rel.parts[0] in ('menu-evidence','reference-review') or (rel.parts[0]=='local-web' and f.suffix=='.log') or f.name in ('menu-sizes.csv','artifact-receipts.json','job-status.json','job-steps.json','gpu-shader.log','native-payloads.json','layer-geometry.json','stages.json','menu-regions.csv','commit.txt','run.txt','artifact.json')):continue
                if f.suffix not in ('.json','.csv','.png','.gz','.log','.txt','.jsonl','.sha256','.wav','.tsv','.jpg','.cpp','.sh'):continue
                z.write(f,str(Path(folder.name)/rel))
        for f in [root/'tail-codec.csv',root/'audio-recheck/terminal-av-sync.csv',*sorted((root/'reference-frames').glob('*.png'))]:
            z.write(f,'references/'+f.name)
        for f in (root/'research').glob('*'):
            if f.suffix in ('.tsv','.csv','.jpg'):
                z.write(f,'research/'+f.name)
        for n in ('compositor_report.py','tv_stage_analysis.py','tv_layer_geometry.py','tv_presentation.py','test_tv_presentation.py','tv_release_gate.py','native_window_report.py','tv_gpu_shader.cjs','tv_tail_codec.py','switch_menu_regions.py','switch_score_sample.py','switch_lettering.py','switch_coop_terminal.py','ending.lua','browser-ending.cjs','browser-game.cjs','television.py','tv-scenes.lua','tv-blast-load.lua','terminal_av_sync.py','ending_audio.py','ending_calibration.py','terminal_tally.py','switch_cues.py','compare_switch_audio.py'):
            z.write(Path(__file__).with_name(n),'methods/'+n)
        for name in ('tv-gpu-raster.h','tv-raster-shader.h','tv-egl-window.h','tv-sdl-swap.patch','tv-egl.patch'):
            z.write(Path(__file__).resolve().parents[2]/'runtime'/name,'methods/'+name)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('root','run','destination'):parser.add_argument(name,type=Path)
    parser.add_argument('--trial',type=Path,action='append',default=[])
    parser.add_argument('--previous',type=Path)
    args=parser.parse_args()
    build(args.root,args.run,args.destination,args.trial,args.previous)
