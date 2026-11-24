"""Build an offline comparison from real package measurements and public Switch captures."""
import argparse
import base64
import csv
from html import escape
import json
from pathlib import Path
import wave


def rows(path):
    with path.open(newline='') as stream:
        return list(csv.DictReader(stream))


def table(head, data):
    return '<table><thead><tr>'+''.join('<th>'+escape(str(v))+'</th>' for v in head)+'</tr></thead><tbody>'+''.join(
        '<tr>'+''.join('<td>'+escape(str(v))+'</td>' for v in row)+'</tr>' for row in data)+'</tbody></table>'


def inline(path, mime):
    return f'data:{mime};base64,'+base64.b64encode(path.read_bytes()).decode()


def timeline(path):
    records=rows(path/'events.csv')
    def first(name,value=None):
        return next(r for r in records if r['event']==name and (value is None or r['value']==value))
    hit=int(first('shot')['frame'])
    word=int(first('word-ink','708')['frame'])
    end=next(int(r['frame']) for r in records if r['event']=='word-ink' and r['value']=='0' and int(r['frame'])>word)
    record=any(r['event']=='mode' and r['value']=='8' for r in records)
    with wave.open(str(path/'game.wav')) as f:
        rate=f.getframerate()
        assert f.getnframes()>rate*20
    return (int(first('cue-7')['frame'])-hit,int(first('tally')['frame'])-hit,int(first('cue-24')['frame'])-hit,
            word-hit,end-word,record,int(first('title')['frame'])-hit,rate)


def report(player, motion, audio, tv, output, ci, clocks):
    html=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
          '<title>坦克大战 · Switch 实时时序和战斗动画对照</title><style>body{max-width:960px;margin:2rem auto;padding:0 1rem;font:16px/1.65 system-ui;color:#17222a}table{border-collapse:collapse;margin:1rem 0;display:block;overflow:auto;font-variant-numeric:tabular-nums}td,th{padding:.25rem .6rem;border:1px solid #bbc6ca;text-align:left;white-space:nowrap}th{background:#eef3f5}img{max-width:100%;height:auto;image-rendering:pixelated}audio{vertical-align:middle;max-width:100%}h2{margin-top:2rem}code{overflow-wrap:anywhere}figure{margin:1em 0}a{color:#24558b}</style>',
          '<h1>《坦克大战》英文 Switch 版对照</h1>',
          '<p>目标为《南梦宫博物馆档案 Vol. 2》。Web 与 Android TV 使用同一份卡带。以下数据取自本轮成品、原生 NES 核心和标明出处的 Switch 录像。</p>',
          '<h2>游戏速度与声音</h2><p>在解压后的 Web 成品中同步记录模拟器时钟、实际经过时间和交给音频输出的 PCM。native 使用浏览器实际刷新回调，60 和 120 使用标称刷新率调度。每组连续测三次，每次约 30 秒。目标为游戏及音频速度均在实际时间的 ±1% 以内。</p>']
    data=[]
    for path in sorted(clocks.glob('*.jsonl')):
        for line in path.read_text().splitlines():
            entry=json.loads(line)
            if 'speed' not in entry: continue
            data.append((entry['engine'],entry['cadence'],entry['run'],f"{entry['wall']:.3f}",f"{entry['emu']:.3f}",entry['frames'],
                         entry['sampleRate'],f"{entry['pcm']:.3f}",f"{(entry['speed']-1)*100:+.2f}%",f"{(entry['audioSpeed']-1)*100:+.2f}%"))
    if tv and (tv/'clock.jsonl').exists():
        for line in (tv/'clock.jsonl').read_text().splitlines():
            v=json.loads(line);data.append(('TV API 34','模拟器',v['run'],f"{v['wall']:.3f}",f"{v['emu']:.3f}",v['frames'],v['sampleRate'],f"{v['pcm']:.3f}",f"{(v['speed']-1)*100:+.2f}%",f"{(v['audioSpeed']-1)*100:+.2f}%"))
    html.append(table(('平台','调度 Hz','次数','实际秒','模拟秒','帧数','采样率','PCM 秒','游戏偏差','音频偏差'),data))
    html.append('<h2>基地失守后的三条路径</h2><p>各平台运行相同的最后一击和控制器输入。以下各时刻均以中弹为第 0 帧。逐帧读取屏幕中完整字样的像素并记录音频寄存器，显示帧数包含首帧，止于第一次消失。</p>')
    routes=('neutral','record','skip-over')
    data=[]
    for source,folder in [('native',player),('web',player),('tv',tv)]:
        if folder is None: continue
        for route in routes:
            path=folder/(source+'-'+route)
            if not (path/'events.csv').exists(): continue
            values=list(timeline(path))
            values[5]='是' if values[5] else '否'
            data.append((source,route,*values))
    html.append(table(('平台','路径','爆炸音','结算','结束乐指令','字样出现','字样持续','最高分','返标题','PCM Hz'),data))
    html.append('<p>Switch 自然结束画面在三次录像中可见 54、54、56 个采集帧，约 1.80–1.87 秒。两次来自同一作者，均无按键记录。当前保留原计时。</p>')
    align=rows(audio/'alignment.csv')
    html.append(table(('用于对齐的乐段','Switch 片段起点（秒）','频谱相似度'),[(r['part'],r['switch_aligned_start_s'],r['spectral_cosine']) for r in align]))
    html.append('<p>两段录音按单声道分析。去除每个窗口的直流偏置，再比较频谱。按 10 毫秒窗口寻找连续 100 毫秒低于峰值 1.2% 的区间，测得结束乐尾音如下。</p>')
    html.append(table(('录音','首音至安静（秒）'),[(r['source'],r['duration_to_quiet_s'] or '未分离') for r in rows(audio/'tail.csv')]))
    for name,caption in [('switch','Switch 实录'),('native','共享卡带')]:
        html.append('<p>'+caption+' <audio controls src="'+inline(audio/(name+'.wav'),'audio/wav')+'"></audio></p>')
    html.append('<details><summary>逐音符计时与基频</summary><p>基频来自三条 NES 声道的定时器。录像列仅报告混合录音中附近可辨认的频谱峰。两个脉冲声道同音时无法从录像单独判断每个声道音高。</p>')
    html.append(table(('帧','声道','定时器 Hz','至下一起音（帧）','实录附近峰 Hz'),[(r['nes_frame'],r['channel'],r['timer_fundamental_hz'],r['frames_to_next_attack'] or '—',r['switch_peak_near_fundamental_hz'] or '—') for r in rows(audio/'notes.csv')])+'</details>')
    html.append('<h2>战斗画面</h2>')
    for file,caption in [('spawn','出生闪光。上行是 Switch 实录，中行是上版，下行是本版。前四列为敌车，后四列为玩家。'),
                         ('shield','护盾的连续两帧。上、中、下分别为实录、上版和本版。坦克遮住护盾的一部分。'),
                         ('player','任天堂第一关截图中的右向玩家坦克、本版及官方截图轮廓。'),
                         ('treads','清晰可见的连续履带姿态。上行为实录，中行为同向卡带图块，下行为轮廓。'),
                         ('blast','玩家爆炸的两个阶段。上行为 Switch 录像，下行为本版亮部遮罩。')]:
        html.append('<figure><img alt="'+caption+'" src="'+inline(motion/(file+'.png'),'image/png')+'"><figcaption>'+caption+'</figcaption></figure>')
    html.append(table(('出生点','阶段','上版错格','本版错格'),[(r['spawn'],r['phase'],r['previous_pixel_errors'],r['current_pixel_errors']) for r in rows(motion/'spawn.csv')]))
    html.append(table(('护盾阶段','上版白色区域交并比','本版白色区域交并比'),[(r['phase'],r['previous_white_iou'],r['current_white_iou']) for r in rows(motion/'shield.csv')]))
    html.append(table(('爆炸采集帧','亮部交并比'),[(r['frame_after_seek_123_15s'],r['white_core_iou']) for r in rows(motion/'blast.csv')]))
    html.append(table(('向上炮弹采集帧','场地 X','场地 Y','宽','高','可见像素'),[(r['frame_after_seek_34_8s'],r['left'],r['top'],r['width'],r['height'],r['visible_pixels']) for r in rows(motion/'shot.csv')]))
    html.append('<h2>证据边界与成品</h2><p>高分大字 2、3、4、6、7，完整的双人 Switch 结局、无人演示、每次回退的准确跨度及实体电视输入延迟仍缺直接测量。公开视频只提供离散姿态，压缩和遮挡会改变颜色分界。</p>')
    if tv and (tv/'rewind.csv').is_file():
        loads=[r for r in csv.reader((tv/'rewind.csv').read_text().splitlines()) if r and r[0]=='load']
        html.append(table(('TV 回退','匹配的检查点（模拟秒）','工作 RAM 字节一致'),[(n+1,r[1],'是' if r[2]=='1' else '否') for n,r in enumerate(loads)]))
    html.append('<p>SHA-256</p><pre>'+escape((player/'SHA256SUMS').read_text())+'</pre>')
    html.append('<p><a href="https://www.nintendo.com/eu/media/images/06_screenshots/games_5/nintendo_switch_download_software_2/nswitchds_namcomuseumarchivesvolume2/NSwitchDS_NamcoMuseumArchivesVolume2_01.jpg">任天堂原图</a> · <a href="https://www.youtube.com/watch?v=S26lUv598_o&amp;t=349s">英文战斗实录</a> · <a href="https://www.youtube.com/watch?v=Xf02flMP7dc&amp;t=2613s">单人通关结局</a> · <a href="https://nc.bn-ent.net/product/useful.php">官方回退说明</a>')
    if ci: html.append(' · <a href="'+escape(ci,quote=True)+'">本轮验收运行</a>')
    output.write_text(''.join(html)+'</p></html>',encoding='utf-8')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('player','motion','audio','output'): parser.add_argument(key,type=Path)
    parser.add_argument('--tv',type=Path);parser.add_argument('--clocks',type=Path);parser.add_argument('--ci')
    a=parser.parse_args()
    report(a.player,a.motion,a.audio,a.tv,a.output,a.ci,a.clocks or a.player)
