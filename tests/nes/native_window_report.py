"""Assemble the Native Window and Switch terminal-tally acceptance report from the tested release."""
import argparse
import base64
import csv
import hashlib
import html
import io
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from runtime_report import timeline
from tv_release_gate import decision


def rows(path):
    with path.open() as file:
        return list(csv.DictReader(file))


def table(headers, values):
    def cells(tag,row):
        return ''.join(f'<{tag}>{html.escape(str(value))}</{tag}>' for value in row)
    return '<table><thead><tr>'+cells('th',headers)+'</tr></thead><tbody>'+''.join(
        '<tr>'+cells('td',row)+'</tr>' for row in values)+'</tbody></table>'


def picture(path, caption):
    data=base64.b64encode(path.read_bytes()).decode()
    return f'<figure><img alt="{html.escape(caption)}" src="data:image/png;base64,{data}"><figcaption>{html.escape(caption)}</figcaption></figure>'


def build(root,run,dest,commit,trial=None):
    tv=run/'tv-device-results'
    gate=decision(tv,require_prototype=True)
    assert gate==json.loads((tv/'release-gate.json').read_text())
    selected='原生窗口' if gate['default']=='dirty-tv' else 'SDL 软件渲染'
    rom=hashlib.sha256((dest/'game.nes').read_bytes()).hexdigest()
    layout=json.loads((root/'rom-layout.json').read_text())
    upgrade=json.loads((tv/'upgrade.json').read_text())
    assert layout['current']==rom==upgrade['cartridge'] and upgrade['previousCartridge']==layout['previous']
    assert upgrade['thumbnailPreserved'] and upgrade['lockPreserved']
    sections=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>坦克大战 · 电视渲染与结算时序验收</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:1120px;margin:28px auto;padding:0 18px;color:#212529}h2{margin-top:2em}table{border-collapse:collapse;display:block;overflow:auto}td,th{padding:4px 9px;border:1px solid #bac0c5;text-align:right;white-space:nowrap}figure{margin:.7em 0}img{max-width:100%;height:auto}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}</style>',
        '<h1>坦克大战 · 电视渲染与结算时序验收</h1>',
        f'<p>本次默认电视渲染为 <strong>{selected}</strong>。Web 和 Android TV 共用卡带 <code>{rom}</code>。'
        f'验收提交 <code>{commit}</code>。<a href="https://github.com/JC6/BattleCity/actions/runs/{run.name}">同提交构建与验收</a></p>',
        '<h2>电视速度与逐帧提交</h2><p>1080p、API 34 x86 Android TV 模拟器。100% 为实时。系统音频以实际交给 Android 输出流的采样帧计，显示提交以成功发送给显示系统的缓冲计。通过要求为两者同时达到实时的 99%–101%，且每个 NES 帧提交一次。</p>']
    clocks=[]
    def add_clocks(phase,file):
        windows=json.loads(file.read_text())['windows']
        for mode,values in windows.items():
            for r in values:clocks.append({'phase':phase,'mode':mode,**r})
    if trial and trial!=run and (trial/'tv-device-results/prototype/clock.json').exists():
        add_clocks('初次原型',trial/'tv-device-results/prototype/clock.json')
    add_clocks('本次原型',tv/'prototype/clock.json')
    if gate['prototypePassed']:
        for n,b in enumerate((tv,tv/'second'),1):add_clocks(f'独立冷启动 {n}',b/'render/clock.json')
    scenarios={'battle':'普通战斗','explosions':'连续爆炸','candidate':'候选','baseline':'软件基准',
               'gpu-full':'GPU 全图','native':'原始纹理','low-buffer':'系统放大小缓冲'}
    sections.append(table(('试验','场景／路径','驱动','窗口','秒','游戏速度','系统音频','NES / 提交 / 尝试',
        '绘图 ms/帧','锁定 ms/帧','复制 ms/帧','提交 ms/帧','局部绘图帧'),[
        (r['phase'],scenarios.get(r['mode'],r['mode']),r['driver'],r['run'],f"{r['wall']:.2f}",
         f"{100*r['gameSpeed']:.2f}%",f"{100*r['pcmSpeed']:.2f}%",f"{r['frames']} / {r['presented']} / {r['attempts']}",
         *(f"{r.get(k,0)/r['attempts']:.2f}" for k in ('drawMs','lockMs','copyMs','postMs')),r['nativeSize']) for r in clocks]))
    if not gate['prototypePassed']:
        sections.append('<p>普通战斗和连续爆炸的原型门槛未全部达到，完整双冷启动晋级测试未启动。离线参考及候选 APK 随包提供。</p>')
    sections.append('<p>首轮局部锁定使用原生 RGB565。复测继续在 CPU 上只更新发生变化的图像，改为整块锁定并写入窗口，允许 Android 直接丢弃旧缓冲。32 位窗口显式展开 RGB565 的通道高位。窗口大小变化时会重新提交下一帧。</p>')
    sections.append('<h2>同帧画质和双手柄</h2><p>每幅图对齐 NES 帧与 2 KiB 工作 RAM 摘要，比较 57,344 个游戏像素中心、壁纸和整个截图。重复拍摄默认软件路径，逐像素估计系统噪声。</p>')
    images=[]
    def read_visual(phase,folder):
        for name,v in json.loads((folder/'visual.json').read_text()).items():
            images.append((phase,name,v['battle'],v['nativePixels'],v['differentCenters'],
                           v['differentWallpaperPixels'],v['aboveRepeatNoise'],v['repeat']['differentOutputPixels']))
    read_visual('保留验证帧',tv/'held-out')
    for n in range(1,len(gate['boots'])+1):
        directory=tv if n==1 else tv/'second'
        for sub in ('render','scenes'):read_visual(f'冷启动 {n}',directory/sub)
    sections.append(table(('批次','场景','帧与 RAM','中心总数','不同中心','不同壁纸像素','超噪声像素','重复截图差异'),images))
    sections.append('<div class="pair">'+''.join(picture(tv/'held-out'/f'moving-633-{k}.png',label)
                    for k,label in [('baseline','软件基准 · 第 633 帧'),('candidate','原生窗口候选 · 第 633 帧')])+'</div>')
    controls='通过' if gate['candidateControlsPassed'] else '未通过'
    sections.append(f'<p>软件基准通过电视双手柄、存读档、重连、回退及前后台恢复。原生窗口候选的相同操作测试{controls}。上一版双人存档、缩略图、写保护与原目录均通过默认软件包的覆盖安装检验。</p>')
    sections.append('<h2>结算画面与结束音乐</h2><p>只有最终败北的计分画面多停留三个 NES 帧。取 TOTAL 数字首次稳定可见到 GAME OVER 字样出现的时差，分开检查画面节奏与混音延迟。</p>')
    a=rows(root/'terminal-tally.csv')
    sync=rows(root/'terminal-av-sync.csv')
    sources={'first':'My Gameplay Videos · 第 2 关','last':'Crolister · 第 36 关','english':'My Gameplay Videos · 自建地图',
             'review-ending':'Xupgeeks · 第 1 关','montage-ending':'itFredda · 第 1 关'}
    timing=[(sources.get(r['source'],r['source']),r['count'],r['split'],f"{float(r['total_to_word']):.3f}",f"{float(r['frame_period'])*1000:.1f}")
            for r in a]
    timing.extend((sources[r['source']],r['observed_total'],'独立复验',f"{float(r['total_to_word']):.3f}",
                   f"{float(r['frame_period'])*1000:.1f}") for r in sync if r.get('observed_total'))
    sections.append(table(('录像或卡带','最终击毁数','用途','TOTAL 至 GAME OVER 秒','每采集帧毫秒'),timing))
    sections.append(table(('同一音画文件','原始字样至音乐 秒','计分声相对数字 秒','校准后相对本作 毫秒','至静音 秒'),[
        (sources[r['source']],r['raw_word_to_music'],r['retail_tick_minus_digit'] or '无计分声',
         f"{float(r['residual_vs_native'])*1000:+.1f}" if r['residual_vs_native'] else '—',r['music_to_quiet']) for r in sync]))
    sections.append('<p>十和十三次连续计分、十五次计分及上一关最后六次计分，为四段混音分别提供独立标记。剩余起音差在一个采集帧以内。尾音按连续十个 10 毫秒窗口低于峰值 1.2% 判定。卡带为 1.58 秒，实录为 1.63–1.64 秒。原始数据另列四种阈值。</p>')
    for r in sync:
        link='https://www.youtube.com/watch?v='+r['video_id']+'&amp;t='+str(round(float(r['clip_origin'])+float(r['word'])))
        sections.append(f'<a href="{link}">{sources[r["source"]]}</a> ')
    if (root/'reference-frames').exists():
        sections.append('<div class="pair">'+''.join(picture(f,'英文 Switch · '+f.stem) for f in sorted((root/'reference-frames').glob('*.png')))+'</div>')
    sections.append('<h2>关卡、键盘和存档升级</h2>')
    native_log=(root/'native-controls-final.log').read_text().splitlines()
    assert all(f'campaign {name} neutral passed' in native_log for name in ('solo','coop'))
    stages=[r for f in sorted(run.glob('stage-replay-*/stages.csv')) for r in rows(f)]
    assert sorted(int(r['stage']) for r in stages)==list(range(1,36))
    groups=[('35 关逐关回放',stages),('双人关卡',rows(run/'stage-replay-0/coop.csv')),
        ('无人演示',rows(run/'stage-replay-0/attract.csv')),('连续两轮',rows(run/'campaign-loop/loop.csv'))]
    for _,records in groups:assert all(r['result']=='passed' and r['cartridge_sha256']==rom for r in records)
    sections.append(table(('轨迹','记录数','比对战斗更新数'),[(label,len(records),sum(int(r['reference_updates']) for r in records)) for label,records in groups]))
    web=run/'web-clock-and-endings'
    web_clocks=[]
    for engine in ('chromium','webkit'):
        for cadence in ('native','60','120'):
            series=[r for line in (web/f'{engine}-{cadence}.jsonl').read_text().splitlines() if 'lifecycle' not in (r:=json.loads(line))]
            assert len(series)==3 and all(abs(r['speed']-1)<=.01 and abs(r['audioSpeed']-1)<=.01 for r in series)
            web_clocks.extend(series)
        assert 'passed previous-release save upgrade' in (run/f'upgrade-{engine}.log').read_text()
    sections.append(table(('浏览器','窗口数','游戏速度','音频速度'),[(engine,len(records),
        *(f"{min(r[k] for r in records)*100:.3f}%–{max(r[k] for r in records)*100:.3f}%" for k in ('speed','audioSpeed')))
        for engine in ('chromium','webkit') if (records:=[r for r in web_clocks if r['engine']==engine])]))
    endings=[]
    for route in ('neutral','record','skip-over'):
        w=timeline(web/('web-'+route));t=timeline(tv/'timing'/('tv-'+route))
        assert w[:-1]==t[:-1],route
        endings.append((route,w[1],w[2],w[4],w[6]))
    sections.append(table(('终局输入','进入结算帧','第一条乐曲指令帧','字样持续帧','返回标题帧'),endings))
    sections.append(f'<p>新卡带保留上一版的 {layout["preservedNamedSymbols"]} 个命名地址、CHR 和中断向量。两端分别从真实旧版创建双人存档，用新版加载、恢复移动，并检查旧槽、新槽、预览和锁。Web 在同源下使用 IndexedDB，Android 使用应用私有目录。</p>')
    sections.append('<p>英文 Switch 的完整双人结局、无人操作演示、连续回退跨度及五个最高分大数字仍缺直接证据。'
                    '<a href="https://nc.bn-ent.net/title-lineup/title.php?tit=battle-city">官方双人说明</a> · <a href="https://nc.bn-ent.net/product/useful.php">官方回退与存档说明</a></p>')
    manifest=(dest/'SHA256SUMS').read_text()
    sections.append('<h2>安装包与卡带校验</h2><pre>'+html.escape(manifest)+'</pre></html>')
    (dest/'Switch-TV-Comparison.html').write_text(''.join(sections),encoding='utf-8')
    with ZipFile(dest/'Switch-TV-Measurements.zip','w',ZIP_DEFLATED,compresslevel=5) as z:
        def add_csv(name,items):
            buf=io.StringIO()
            fields=list(dict.fromkeys(k for row in items for k in row))
            writer=csv.DictWriter(buf,fieldnames=fields);writer.writeheader();writer.writerows(items)
            z.writestr(name,buf.getvalue())
        add_csv('tv-clock.csv',clocks);add_csv('web-clock.csv',web_clocks)
        z.writestr('source.txt',commit+'\nhttps://github.com/JC6/BattleCity/actions/runs/'+run.name+'\n')
        z.writestr('SHA256SUMS',manifest)
        for f in ('terminal-tally.csv','terminal-av-sync.csv','tail-thresholds.csv','rom-layout.json','native-controls-final.log'):
            z.write(root/f,'measurements/'+f)
        for sub in ('references','reference-frames','native-matches','audio'):
            for f in sorted((root/sub).rglob('*')):
                if f.is_file() and f.suffix in ('.csv','.png','.txt','.log') and f.stat().st_size and not (sub=='references' and f.suffix=='.log'):
                    z.write(f,'measurements/'+str(f.relative_to(root)))
        for section in [tv,web,run/'cartridge',run/'campaign-loop',*sorted(run.glob('stage-replay-*'))]:
            for f in sorted(section.rglob('*')):
                if f.is_file() and (f.suffix in ('.json','.jsonl','.csv','.png','.gz','.wav') or f.name in ('tested-sha256.txt','previous-sha256.txt','device.log')):
                    z.write(f,'actions/'+str(f.relative_to(run)))
        if trial and trial != run and (trial/'tv-device-results/prototype/clock.json').is_file():
            z.write(trial/'tv-device-results/prototype/clock.json','trial/'+trial.name+'/clock.json')
        for name in ('upgrade-chromium.log','upgrade-webkit.log'):
            z.write(run/name,'browser/'+name)
        for name in ('native_window_report.py','tv_release_gate.py','terminal_tally.py','terminal_av_sync.py','ending_calibration.py','ending_audio.py','switch_cues.py','runtime_report.py','television.py','tv-scenes.lua','tv-blast-load.lua','ending.lua'):
            z.write(Path(__file__).with_name(name),'scripts/'+name)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for field in ('root','run','dest'):parser.add_argument(field,type=Path)
    parser.add_argument('--commit',required=True)
    parser.add_argument('--trial',type=Path)
    args=parser.parse_args()
    build(args.root,args.run,args.dest,args.commit,args.trial)
