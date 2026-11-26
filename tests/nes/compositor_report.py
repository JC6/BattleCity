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
from tv_release_gate import decision, pipeline_pass, rgb565_matches
from tv_layer_geometry import layer_geometry
from tv_presentation import reconcile
import gzip
from tv_stage_analysis import analyze, load


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
    host=run/'reference-review/hardware.json'
    if host.exists():
        h=read(host)
        sections.append('<p>本次硬件核查：本机 ADB 的设备数为 '+str(len(h['adbDevices']))+'。Windows 图形适配器为 '
            +html.escape(h['windowsAdapter'])+'，Windows Hypervisor Platform 状态为 '+str(h['windowsHypervisorPlatformInstallState'])
            +'（已关闭）。当前 Linux 环境未暴露 KVM 或 GPU 设备。公开目录中的 Google TV Amati 为虚拟设备。'
            '<a href="https://firebase.google.com/docs/test-lab/android/available-testing-devices">官方设备目录</a></p>')
    retry=run/'build-retry.json'
    if retry.is_file():
        info=read(retry)
        sections.append(f'<p>缓存版首次打包时，链接器报告 <code>{html.escape(info["error"])}</code>。修正版链接 Android NDK 的 GLESv3 库，ARM64 和 x86 均重新构建。<a href="https://github.com/JC6/BattleCity/actions/runs/{int(info["run"])}">首次构建记录</a></p>')
    values=[]
    for folder in dict.fromkeys([old,*trials,run]):
        clock=folder/'tv-device-results/prototype/clock.json'
        if not clock.is_file():continue
        for name,samples in read(clock)['windows'].items():
            row=samples[0];n=row['frames']
            if name=='producer-battle':continue
            values.append([folder.name,name,f"{100*row['emu']/row['wall']:.2f}%",f"{100*row['samples']/row['sampleRate']/row['wall']:.2f}%",
                n,row.get('nativeSize','—'),row.get('gpuFrames','—') if row.get('driver')=='android-surface-control' else '—',row['attempts'],row['presented'],row.get('completions','—'),row.get('pending','—'),
                ' / '.join(f"{row.get(k,0)/n:.2f}" for k in ('waitMs','lockMs','copyMs','postMs'))])
    sections+=[table(('运行','场景','游戏','系统 PCM','NES 帧','原生尺寸路径帧','SurfaceControl GPU 帧','尝试','提交','完成','积压','等待 / 锁定 / 绘制或复制 / 提交 ms/帧'),values),
        '<p>两次额外冷启动和八场景逐帧检查'+('已执行。' if gate['boots'] else '按预设条件跳过，前置检查未全部通过。')+'</p>']
    if (tv/'menu-samples/1080/current').is_dir():
        stable=[json.loads(line) for line in (tv/'timing/clock.jsonl').read_text().splitlines()]
        assert [r['run'] for r in stable]==[1,2,3]
        sections.append('<h2>SDL 软件渲染对照</h2><p>三个连续窗口分别记录 SDL 安装包的模拟时钟与应用输出的 WAV。设备为同一台 1080p x86 模拟器。上一表中候选路径的系统声音输出来自混音设备计数器。</p>')
        sections.append(table(('窗口','实际秒数','NES 帧','游戏速度','录制 WAV 速度'),
            [[r['run'],f"{r['wall']:.2f}",r['frames'],f"{r['speed']:.2%}",f"{r['audioSpeed']:.2%}"] for r in stable]))
    measurements=read(tv/'prototype/clock.json')
    samples=measurements['windows']
    if renderer=='egl-tv':
        measurements_rows=[]
        for scene in ('battle','explosions'):
            variants=[key for key in samples if key!='producer-battle' and (key==scene or key.endswith('-'+scene))]
            for variant in variants:
                row=samples[variant][0]
                assert measurements['battle'][variant]==measurements['battle'][scene]
                if row['driver']=='android-egl-window':
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
        if 'producer-battle' in samples:
            from tv_buffer_report import buffer_sections
            sections.extend(buffer_sections(run))
        if (tv/'presentation/clock.json').is_file():
            from tv_presentation_cost import presentation_sections
            sections.extend(presentation_sections(run))
        if 'prepared-battle' in samples:
            timing=[]
            for name,records in samples.items():
                row=records[0]
                if row['driver']!='android-egl-window':continue
                timing.append([name, f"{row['wall']:.2f}",f"{row['gameSpeed']:.2%}",f"{row['pcmSpeed']:.2%}",
                    *[f"{row[k]/row['frames']:.3f}" for k in ('uploadMs','drawCallMs','drawCheckMs','postMs')]])
            sections.append('<h2>同包逐段耗时</h2><p>每个场景使用相同的战斗起点。prepared 与 prepared-repeat 重复呈现起点画面，游戏和音频继续运行。upload 加入输入纹理上传，direct 直接绘制整数展开图，immediate 请求交换间隔 0。uncached 在支持缓存的构建上强制每帧重绘整个窗口。无前缀行为即候选版游戏路径。</p>')
            sections.append('<p>前三项耗时为 CPU 发出相应 GLES 调用的时间，异步 GPU 工作可能反映在随后交换缓冲的等待中。冻结帧读回单独运行。游戏场景的实时性及逐帧显示凭据决定是否通过。</p>')
            sections.append(table(('场景','实测秒数','游戏','系统 PCM','原生纹理上传 ms/帧','整数展开 ms/帧','最终采样及复制 ms/帧','提交 ms/帧'),timing))
        if 'uncached-battle' in samples:
            still=[samples[k][0]['gameSpeed'] for k in ('prepared-battle','prepared-repeat-battle','prepared-explosions','prepared-repeat-explosions')]
            b,e=[samples[k][0] for k in ('battle','explosions')]
            delta=[100*(row['gameSpeed']-samples['uncached-'+scene][0]['gameSpeed']) for scene,row in (('battle',b),('explosions',e))]
            sections.append(f"<p>与同包整帧重画相比，保留最终采样并整帧复制，使普通战斗与连续爆炸分别提高 {delta[0]:.2f}、{delta[1]:.2f} 个百分点。反复提交固定画面时，四个窗口为实时的 {min(still):.2%}–{max(still):.2%}。这个对照反映当前模拟器、交换间隔和完整窗口呈现路径的实测速度。</p>")
        for folder in dict.fromkeys([old,*trials]):
            prior=folder/'tv-device-results'
            clock=prior/'prototype/clock.json'
            if not clock.exists() or not (prior/'held-out/calibration-baseline-swap.ppm.gz').is_file():continue
            first=read(folder/'stages.json') if (folder/'stages.json').is_file() else analyze(prior/'held-out')
            initial=first['calibration']['stages']['system']
            initial_clock=read(clock)['windows']
            sections.append(f"<p>运行 {folder.name} 的校准图在展开后至 SDL 窗口交换前有 {initial['baselineExpandedToSwap']['differentPixels']:,} 个像素变化，该次 EGL 有 {initial['candidateExpandedToSwap']['differentPixels']:,} 个。该运行普通战斗和连续爆炸每次交换分别耗时 {initial_clock['battle'][0]['swapMsPerFrame']:.2f} 和 {initial_clock['explosions'][0]['swapMsPerFrame']:.2f} 毫秒。</p>")
            if folder.name=='45640450906' and not read(prior/'release-gate.json')['candidateControlsPassed'] and (prior/'candidate-controls/failure.png').is_file():
                sections.append('<p>首轮候选版双手柄脚本在进程重启时停止。当时的设备截图为 Google TV 的影音购买提示，游戏处于后台。复测启动代码只在该系统对话框覆盖仍在运行的游戏时恢复游戏焦点。</p>')
        device_info=[]
        for variant in samples:
            file=tv/'prototype'/(variant+'-window.txt')
            if file.is_file():device_info.append([variant,file.read_text(errors='replace').strip()])
        backend=tv/'held-out/calibration-baseline-renderer.txt'
        if backend.is_file():device_info.append(['SDL 窗口纹理',backend.read_text(errors='replace').strip()])
        if device_info:sections.append(table(('场景或采样点','驱动在设备上返回的配置'),device_info))
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
    sections.append('<h2>冻结帧的分阶段采样</h2><p>每个场景同时记录 NES 光栅、交给显示系统前的 RGB 图和整张系统截图。重复拍摄软件基线建立噪声范围。校准图包含八种颜色和单像素线。</p>')
    visuals=read(tv/'held-out/visual.json')
    sections.append(table(('场景','首个超出噪声的阶段',' / '.join(next(iter(stages.values()))['stages'])+' 超噪像素','系统色边 / 非色边误差','像素中心 / 壁纸误差'),
        [[name,item['firstDifference'],' / '.join(str(v.get('aboveRepeatNoise','缺少回读' if 'missing' in v else '尺寸不同')) for v in item['stages'].values()),
          ' / '.join(str(item['stages']['system'][k]) for k in ('atBoundary','awayFromBoundary')),
          f"{visuals[name]['differentCenters']} / {visuals[name]['differentWallpaperPixels']}"] for name,item in stages.items()]))
    black=[name for name,item in stages.items() if item['stages'].get('swap',{}).get('candidateAllBlack')]
    if black:
        sections.append(f'<p>候选版有 {len(black)}/{len(stages)} 个场景的交换前读回全黑。原始游戏光栅与展开图另列在上表。全黑缓冲无法用校准线推算采样偏移和边缘混合比例。</p>')
    original=tv/'pipeline'
    live=run/'live-readback'
    if (original/'visual.json').is_file():
        sections.append('<h2>从 GPU 输入到电视窗口</h2><p>纯绿、四色角标、校准图和第 633 帧分别记录 NES 光栅、GPU 实际整数纹理、展开缓冲、交换前窗口和系统截图。纹理列直接核对同尺寸的 RGB565 通道值。</p>')
        checks=[]
        for pipe,label in [(original,'暂停前' if 'producer-battle' in samples else '主验收'),(live/'pipeline','暂停前')]:
            if not (pipe/'visual.json').is_file():continue
            if pipe.parent==live:
                assert (live/'tested-sha256.txt').read_bytes()==(tv/'tested-sha256.txt').read_bytes()
                info=read(live/'source.json')
                sections.append(f'<p>补测复用同一对 APK 和卡带，三个 SHA-256 与主验收相同。MAME 在暂停时会添加透明覆盖层。补测提前一帧启动采样，在窗口交换后暂停游戏。<a href="https://github.com/JC6/BattleCity/actions/runs/{int(info["run"])}">同包实测</a>。</p>')
            for scene,record in read(pipe/'visual.json').items():
                src,tex,layer,swap=[load(file) if file.is_file() else None for stage in ('source','texture','layer','swap')
                    for file in [pipe/f'{scene}-candidate-{stage}.ppm.gz']]
                matching=src and tex and rgb565_matches(src,tex)
                def matches(image,stage):
                    base=pipe/f'{scene}-baseline-{stage}.ppm.gz'
                    return '逐字节相同' if image and base.is_file() and image==load(base) else '有差异或缺失'
                checks.append([label,scene,' × '.join(map(str,tex[:2])) if tex else '缺失',
                    '逐字节相同' if matching else '尺寸不同' if src and tex and src[:2]!=tex[:2] else '有差异或缺失',
                    matches(layer,'layer'),matches(swap,'swap'),record['aboveRepeatNoise']])
            paths=[pipe/f'corners-{mode}-swap.ppm.gz' for mode in ('legacy','candidate','baseline')]
            if all(p.is_file() for p in paths):
                old_frame,new_frame,expected=(load(p) for p in paths)
                sections.append(f"<p>{label}，同包切换到旧顶点着色器后，四色窗口的交换前读回{'全黑' if not any(old_frame[2]) else '含非黑像素'}。使用顶点缓冲后与 SDL 读回{'逐字节相同' if new_frame==expected else '存在差异'}。</p>")
        sections.append(table(('采样时机','场景','GPU 输入尺寸','RGB565 对 NES 光栅','展开缓冲对 SDL','交换前对 SDL','截图超噪像素'),checks))
        if (live/'pipeline/visual.json').is_file():
            match=read(live/'source.json')['sourceMatchesPaused']
            sections.append(f'<p>与原暂停采样相比，{sum(v["sameState"] for v in match.values())}/{len(match)} 个场景的帧号和 RAM 摘要相同，{sum(v["samePixels"] for v in match.values())}/{len(match)} 个场景的 NES 光栅逐字节相同。</p>')
            verdict=pipeline_pass(live/'pipeline')
            sections.append('<p>暂停前四个场景的逐段检查'+('全部通过。' if verdict else '尚有差异，详见各列和原始读回。')+'</p>')
    probe=run/'window-probe.json'
    if probe.is_file():
        local=read(probe);items=local['fixtures']
        assert all(x['referenceSha256']==x['fixedSha256'] for x in items.values())
        sections.append(f"<p>使用 SDK 随附的 {html.escape(local['driver'])} 离屏重放 {len(items)} 个历史场景。单独替换顶点输入后，全部交换前像素与 SDL 历史读回一致。旧程序在每个场景均保留清屏哨兵颜色 (51, 26, 77)。</p>")
    bench=run/'window-benchmark.json'
    if bench.is_file():
        local=read(bench)
        sections.append('<p>SDK 主机离屏缓冲的三个操作分别测量 80 次，每次等待 GLES 完成。样本大小为 1195 × 960，三种输出逐字节相同。电视窗口速度使用本报告前部的 Android 系统测量。</p>')
        sections.append(table(('离屏操作','每帧毫秒'), [[k,f'{v:.2f}'] for k,v in local['millisecondsPerFrame'].items()]))
    registration=stages['calibration']['stages']['system']
    edge_rows=[]
    for mode,title in [('baseline','软件基线'),('candidate','候选')]:
        sample=registration[mode+'Registration']
        for direction,label in [('left','左邻'),('right','右邻'),('above','上邻'),('below','下邻')]:
            if direction not in sample['edgeLeakage']:
                edge_rows.append([title,label,'无法配准','—','—'])
                continue
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
                           item.get('differentPixels','尺寸不同'),str(direct['offset']) if direct['offset'] is not None else '无法配准',
                           *[f"{direct['edgeLeakage'][d]['mean']:.3%}" if d in direct['edgeLeakage'] else '—' for d in ('left','right','above','below')]])
        sections.append('<p>校准帧还记录 SDL_RenderPresent 调用之前的软件绘制结果，以及候选路径提交给 Android 的硬件缓冲区。下表分别将两者配准到各自的系统截图。</p>')
        sections.append(table(('采样位置','缓冲尺寸','与展开缓冲差异像素','系统配准偏移','左邻','右邻','上邻','下邻'),layers))
    if renderer=='egl-tv':
        evidence=[]
        for mode,title in [('baseline','SDL 实际窗口'),('candidate','EGL 实际窗口')]:
            result=registration.get(mode+'SwapRegistration')
            if result:
                evidence.append([title,registration[mode+'ExpandedToSwap'].get('differentPixels','尺寸不同'),
                    str(result['offset']) if result['offset'] is not None else '无法配准',*[f"{result['edgeLeakage'][d]['mean']:.3%}" if d in result['edgeLeakage'] else '—' for d in ('left','right','above','below')]])
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
                output=item.get('output') or {}
                buffer=item['activeBuffer']
                layer_rows.append([mode,item['name'],f"{buffer[0]} × {buffer[1]} / {buffer[3]}",
                    str(output.get('sourceCrop') or item['hwcSource'] or item['sourceBounds']),
                    str(output.get('displayFrame') or item['hwcDestination'] or item['screenBounds']),
                    str(output.get('bufferTransform','未记录')),output.get('composition') or '未记录',item['dataspace']])
        if layer_rows:
            sections.append(table(('校准路径','Android 图层','缓冲尺寸 / 格式','源矩形','显示矩形','缓冲变换','合成方式','颜色空间'),layer_rows))
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
        for crop in sorted((run/'menu-evidence').glob('*/*/*-overlay.png')):
            platform,height=crop.relative_to(run/'menu-evidence').parts[:2]
            sections.append(picture(crop,f'{platform} {height}p · {crop.stem} · 从左到右为 Switch、旧版、新版和轮廓叠图'))
    holdout=run/'reference-review/menu-holdout.csv'
    if holdout.is_file():
        sections.append('<h2>第二位 Switch 玩家的存档标签</h2><p>独立录像先以标题定位同一页。分别记录原始取景和按菜单外框四边配准的结果，四条边的取样均在标签之外。图中红色为仅原版覆盖，青色为仅复刻版覆盖，白色为两者重合。<a href="https://www.youtube.com/watch?v=dv9axuULtdA&amp;t=1115s">原片 18:35</a></p>')
        sections.append(table(('平台','高度','原始旧版','原始新版','配准旧版','配准新版','重复截图误差'),
            [[r[k] for k in ('platform','height','raw_previous','raw_current','previous_iou','current_iou','repeat_noise')] for r in rows(holdout)]))
        worse = [r for r in rows(holdout) if float(r['previous_iou'])-float(r['current_iou']) > float(r['repeat_noise'])]
        if worse:
            differences = '、'.join(f"{r['platform']} {r['height']}p（{float(r['previous_iou']):.1%} → {float(r['current_iou']):.1%}）" for r in worse)
            sections.append('<p>独立录像中，以下存档标签的配准重合率下降，幅度超过重复采样误差。'+html.escape(differences)+'。</p>')
        sections.append(picture(run/'reference-review/switch-slot-overlay.png','独立 Switch 截图、旧版、新版和轮廓叠图'))
    validation=run/'reference-review/menu-frames.csv'
    if validation.exists():
        verification=[r for r in rows(validation) if r['role']=='validation']
        sections.append('<h2>两段实录的预留画面</h2><p>以系统菜单外框对齐录像。表中每行使用同一参考帧和平台的两次独立截图。标签斜边、上下沿及数字位置随 tab-geometry.csv 提供。</p>')
        sections.append(table(('录像','原片秒数','平台','高度','旧版','新版','达标'),
            [[r[k] for k in ('source','seconds','platform','height','previous_iou','current_iou','passed')] for r in verification]))
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
        if renderer=='egl-tv' or (run/'reference-review/coop-stage42.csv').is_file():
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
    extra_audio=run/'reference-review/visible-terminal-audio.csv'
    tally=run/'reference-review/snoley-tally.csv'
    if tally.is_file():
        observed=rows(tally)[0]
        sections.append(f"<p>Snoley 的英文 Switch 第一关显示 TOTAL {observed['count']} 和 1400 分。"
                        f"从数字首次稳定可读到 GAME OVER 为 {float(observed['total_to_word_s']):.3f} 秒，"
                        f"录像相邻帧为 {1000*float(observed['period_s']):.1f} 毫秒。随后返回标题并保留 20000 分纪录。</p>")
    if extra_audio.is_file():
        sections.append('<p>以各段录像中可见的 GAME OVER 限定搜索区间，在该处对齐同一段有声音符。相似度达到 0.70 后才测尾音，门槛与前述五段录像一致。</p>')
        sections.append(table(('录音','对齐相似度','持续静音起点 s（峰值 1.2%）','本地无损 s'),
            [[r['clip'],r['spectral_cosine'],r['tail_1_2pct'] or '无法可靠对齐',r['local_tail_1_2pct']] for r in rows(extra_audio)]))
    glyphs=run/'reference-review/195400-digits.csv'
    if glyphs.is_file():
        selected=[r for r in rows(glyphs) if r['field']=='4']
        assert len(selected)==3 and all(r['cells']=='56' and r['mismatches']=='0' for r in selected)
        sections.append('<p>英文合集 195400 的三个独立采样时刻，大号 4 各有 56/56 格匹配。画面带有 LT/LB 提示，记录为跨平台参考。</p>')
        sections.append(picture(run/'reference-review/195400-score.png','英文合集 195400，跨平台参考'))
    if (run/'reference-review/coop-stage42.csv').exists():
        pair=rows(run/'reference-review/coop-stage42.csv')[0]
        sections.append(f'<p>英文 Switch 的双人第 42 关从最后两个总数出现到 GAME OVER 为 {float(pair["switch_total_to_over_s"]):.3f} 秒，本次 Web 卡带读屏实测 {float(pair["replica_total_to_over_s"]):.3f} 秒。第 18 关两名玩家分别获得 40400 和 68100 分，游戏显示 HISCORE 68100 后回到双人标题。同一屏摄中，大号 6 的 56 格笔画在三个时刻全部匹配。</p>')
    outstanding=('隐藏留言的入口操作与返回顺序、无输入的待机过程、连续回退的逐次跨度以及大号 HISCORE 数字 2、3、4、7' if
        (run/'reference-review/coop-stage42.csv').exists() or holdout.is_file() else '双人完整结局、确定无输入的待机过程、连续回退的逐次跨度以及大号 HISCORE 数字 2、3、4、6、7')
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
                # The comparison run contributes its renderer evidence. The selected
                # run supplies the complete Web, cartridge, save and controller suites.
                if folder!=run and len(rel.parts)>1:
                    if rel.parts[0]!='tv-device-results':continue
                    if len(rel.parts)>2 and rel.parts[1] not in ('prototype','pipeline','held-out','candidate-controls','render','scenes','second'):continue
                if not f.is_file() or not (rel.parts[0] in ('tv-device-results','web-clock-and-endings','upgrade-chromium','upgrade-webkit','campaign-loop') or rel.parts[0].startswith('stage-replay-') or rel.parts[0] in ('menu-evidence','reference-review','live-readback') or (rel.parts[0]=='local-web' and f.suffix=='.log') or f.name in ('presentation-frames.csv','presentation-cost.csv','frame-boundaries.csv','build-retry.json','window-probe.json','window-benchmark.json','presentation-audit.csv','menu-sizes.csv','artifact-receipts.json','job-status.json','job-steps.json','gpu-shader.log','native-payloads.json','layer-geometry.json','stages.json','menu-regions.csv','commit.txt','run.txt','artifact.json')):continue
                if f.suffix not in ('.json','.csv','.png','.gz','.log','.txt','.jsonl','.sha256','.wav','.tsv','.jpg','.cpp','.sh'):continue
                z.write(f,str(Path(folder.name)/rel))
        for f in [root/'tail-codec.csv',root/'audio-recheck/terminal-av-sync.csv',*sorted((root/'reference-frames').glob('*.png'))]:
            z.write(f,'references/'+f.name)
        tally_method=run/'reference-review/snoley-tally.py'
        if tally_method.is_file():
            z.write(tally_method,'methods/snoley-tally.py')
        for f in (root/'research').glob('*'):
            if f.suffix in ('.tsv','.csv','.jpg'):
                z.write(f,'research/'+f.name)
        for n in ('tv_slot_calibration.py','tv_presentation_cost.py','tv_buffer_report.py','compositor_report.py','tv_stage_analysis.py','tv_layer_geometry.py','tv_presentation.py','test_tv_presentation.py','tv_release_gate.py','native_window_report.py','tv_gpu_shader.cjs','tv_window_probe.py','switch_terminal_sample.py','tv_tail_codec.py','switch_menu_regions.py','switch_score_sample.py','switch_lettering.py','switch_coop_terminal.py','ending.lua','browser-ending.cjs','browser-game.cjs','television.py','tv-scenes.lua','tv-blast-load.lua','terminal_av_sync.py','ending_audio.py','ending_calibration.py','terminal_tally.py','switch_cues.py','compare_switch_audio.py'):
            z.write(Path(__file__).with_name(n),'methods/'+n)
        for name in ('tv-damage.patch','tv-isolation.patch','tv-gpu-raster.h','tv-raster-shader.h','tv-native-window.h','tv-capture.h','tv-egl-window.h','tv-sdl-swap.patch','tv-egl.patch'):
            z.write(Path(__file__).resolve().parents[2]/'runtime'/name,'methods/'+name)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('root','run','destination'):parser.add_argument(name,type=Path)
    parser.add_argument('--trial',type=Path,action='append',default=[])
    parser.add_argument('--previous',type=Path)
    args=parser.parse_args()
    build(args.root,args.run,args.destination,args.trial,args.previous)
