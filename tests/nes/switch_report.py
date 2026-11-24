"""Create an offline three-column report from cached footage and packaged-player captures."""
import argparse
import base64
import csv
from hashlib import sha256
from html import escape
from pathlib import Path
import subprocess

# Local clips start at these source times. Counts were recorded on 2026-11-23.
SOURCES={
    'settings-clip.mp4':('S26lUv598_o',62,872,'6cde50dd77aa9e0dbf9d6851171254d72186c33f3116093e862d84f6d2324b66'),
    'battle.mp4':('S26lUv598_o',318,872,'53da1aa22185034240566726ec4173691df1115c3c106a1996facf7b3f8630a0'),
    'last-stage.mp4':('Xf02flMP7dc',2320,178,'7ab723e4051cb7ab88ccb8f7dc961b59533bdb3ccc0159a1575e7061466a4c7f'),
}


def media(path, args, before=()):
    return subprocess.check_output(['ffmpeg','-v','error','-threads','1',*before,'-i',str(path),*args])


def picture(path, time=None):
    if not path.is_file():
        return '<p>缺少此项截图</p>'
    before=['-ss',str(time)] if time is not None else []
    filters='scale=640:-2:flags=area'
    if path.suffix=='.bgra':
        before=['-f','rawvideo','-pix_fmt','bgra','-s','256x240']
        filters='crop=256:224:0:8,scale=512:448:flags=neighbor'
    jpeg=media(path,['-an','-frames:v','1','-vf',filters,'-c:v','mjpeg','-q:v','3','-f','image2pipe','-'],before)
    return '<img alt="对照取样" src="data:image/jpeg;base64,'+base64.b64encode(jpeg).decode()+'">'


def duration(path,start,reference,crop,rate):
    # Compare the red brickwork with a stable full-word frame. Ignore moving cursor pixels.
    raw=media(path,['-t','9','-an','-vf','crop='+crop+',scale=64:48:flags=area',
                    '-f','rawvideo','-pix_fmt','rgb24','-'],['-ss',str(start)])
    size=64*48*3
    def red(frame):
        return {i//3 for i in range(0,len(frame),3) if frame[i]>38 and
                frame[i]>1.35*frame[i+2] and frame[i]>1.16*frame[i+1]}
    masks=[red(raw[i:i+size]) for i in range(0,len(raw),size)]
    target=masks[round((reference-start)*rate)]
    if len(target)<400:
        raise ValueError('stable frame does not contain the complete GAME OVER')
    visible=[i for i,m in enumerate(masks) if len(m & target)>=.93*len(m | target)]
    if not visible or visible!=list(range(visible[0],visible[-1]+1)) or visible[0]==0 or visible[-1]==len(masks)-1:
        raise ValueError('incomplete ending sample')
    return len(visible),len(visible)/rate


def render(args):
    parts=['''<!doctype html><html lang="zh"><meta charset="utf-8"><title>英文 Switch 版对照</title>
<style>body{font:16px system-ui,sans-serif;max-width:1400px;margin:2em auto;padding:0 1em;color:#19212a}
table{border-collapse:collapse;width:100%;margin:1em 0}th,td{padding:.5em;border:1px solid #bbb}td{vertical-align:middle}
img{width:100%;display:block;max-height:330px;object-fit:contain;background:black}a{color:#195798}</style>
<h1>英文 Switch 版《坦克大战》对照</h1>''']
    parts.append('<p>验收提交 <code>'+escape(args.commit)+'</code>。Web 与电视使用同一份卡带。</p>')
    for name,(video,start,views,digest) in SOURCES.items():
        file=args.footage/name
        if file.is_file() and sha256(file.read_bytes()).hexdigest()!=digest:
            raise ValueError('unexpected cached clip: '+name)
    parts.append('<table><tr><th>项目</th><th>Switch 取样</th><th>上轮成品</th><th>本轮成品</th></tr>')
    scenes=[('显示设置','settings-clip.mp4',3,'Screen-Settings.png','zoom-720.png'),
            ('系统菜单','battle.mp4',339,'System-Menu.png','system-menu.png'),
            ('HISCORE 185900','last-stage.mp4',296.55,'record.bgra','record.bgra')]
    for title,source,at,old,new in scenes:
        video,start,views,_=SOURCES[source]
        parts.append(f'<tr><th>{title}<br><a href="https://www.youtube.com/watch?v={video}&amp;t={int(start+at)}s">录像 {start+at:.2f} 秒</a></th>')
        for cell in (picture(args.footage/source,at),picture(args.previous/old),picture(args.current/new)):
            parts.append('<td>'+cell+'</td>')
        parts.append('</tr>')
    parts.append('</table><p>两份菜单截图来自 Web 成品。显示设置的 Switch 与本轮主预览均选中 Zoom，上轮留存截图选中 Dot-by-Dot；四档缩略图可逐一横向对照。最高分用例将失守前的累计分数设为 185900，由卡带完成失守、结算、破纪录和回标题。砖字检测覆盖 1,008 格标题与结束字样、392 格 HISCORE 和五种有录像的数字共 280 格。截图中的字色随采样相位变化。</p>')
    parts.append('<h2>本轮成品片尾</h2><table><tr><th>带重音姓名</th><th>制作方定格</th></tr><tr>')
    for name in ('staff-accent.png','staff-credits-final.png'):
        parts.append('<td>'+picture(args.current/name)+'</td>')
    parts.append('</tr></table>')
    parts.append('<h2>结束画面</h2><ul>')
    for name,start,reference,crop,rate in [('last-stage.mp4',290,294,'245:146:198:87',30),
                                         ('battle.mp4',130,134,'500:300:385:210',30000/1001),
                                         ('battle.mp4',329,332.7,'500:300:385:210',30000/1001)]:
        if (args.footage/name).is_file():
            frames,seconds=duration(args.footage/name,start,reference,crop,rate)
            parts.append(f'<li>{name}，片段 {reference:.1f} 秒附近，{frames} 个采集帧，{seconds:.3f} 秒，采样间隔 {1000/rate:.1f} 毫秒。</li>')
        else:
            parts.append('<li>'+name+' 缺少录像缓存。</li>')
    parts.append('</ul><p>本作基地失守用例为 117 个 NES 显示帧。两次录像的后续分别进入最高分和标题，输入未同步，保留现有计时。</p>')
    if args.audio:
        with args.audio.open() as f:
            rows=list(csv.reader(f))
        parts.append('<h2>音效取样</h2><table>')
        for row in rows:
            parts.append('<tr>'+''.join('<td>'+escape(v)+'</td>' for v in row)+'</tr>')
        parts.append('</table><p>时间以录像 5:18 为零点，window_s 是所比较的片段长度。限定画面事件附近搜索频谱匹配最高的窗口，开炮与爆炸含同时发声的其他通道。频谱余弦、相对包络及主频差在所列时窗内计算，无法据此推断电视实体延迟。</p>')
    if args.tv:
        parts.append('<h2>API 34 电视模拟器双手柄取样</h2><table><tr><th>显示设置</th><th>片尾中段</th><th>制作方</th></tr><tr>')
        for name in ('screen-settings.png','staff-credits-middle.png','staff-credits-final.png'):
            parts.append('<td>'+picture(args.tv/name)+'</td>')
        parts.append('</tr></table>')
    for label,audio in [('Web 开场',args.web_wav),('电视游戏录音',args.tv/'game.wav' if args.tv else None)]:
        if audio and audio.is_file():
            samples=base64.b64encode(audio.read_bytes()).decode()
            parts.append(f'<p>{label} <audio controls preload="none" src="data:audio/wav;base64,{samples}"></audio></p>')
    parts.append('<h2>仍缺少 Switch 同步记录</h2><p>无人演示的完整固定输入、双人结局、回退触发前后的确切跨度、电视实体输入延迟。当前每模拟秒保存一次回退点。</p>')
    parts.append('<h2>来源</h2><ul>')
    for name,(video,start,views,digest) in SOURCES.items():
        parts.append(f'<li><a href="https://www.youtube.com/watch?v={video}&amp;t={start}s">{name}</a>，起点 {start} 秒，取样时约 {views} 次观看。缓存 SHA-256 <code>{digest}</code></li>')
    parts.append('</ul></html>')
    args.output.write_text('\n'.join(parts),encoding='utf-8')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('footage','previous','current','output'):
        parser.add_argument(name,type=Path)
    parser.add_argument('--commit',required=True)
    parser.add_argument('--audio',type=Path)
    parser.add_argument('--tv',type=Path,help='extracted TV acceptance artifact')
    parser.add_argument('--web-wav',type=Path,help='audio captured from the packaged Web player')
    render(parser.parse_args())
