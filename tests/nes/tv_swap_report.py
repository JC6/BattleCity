"""Audit matched full-copy swap calls and their individual display receipts."""
import base64
import csv
import json
import re
from statistics import median
from native_window_report import table
from tv_presentation_cost import window_summary


def marker_observation(images,width,height):
    base,left,right,clear=images
    assert all(len(rgb)==width*height*3 for rgb in images)
    def square(image):
        # Scan RGB-aligned positions, including wallpaper, without assuming an inset.
        return {(p%width,p//width) for p in range(width*height)
                if image[3*p]>240 and image[3*p+1]<16 and image[3*p+2]>240
                and base[3*p:3*p+3]!=image[3*p:3*p+3]}
    a,b=square(left),square(right)
    def bounds(points):
        if not points:return []
        x,y=zip(*points)
        return [min(x),min(y),max(x)+1,max(y)+1]
    aa,bb=bounds(a),bounds(b)
    def restored(frame,points):
        return all(frame[i:i+3]==base[i:i+3] for x,y in points for i in [3*(y*width+x)])
    valid=bool(aa and bb and len(a)==len(b)==64 and
               (aa[2]-aa[0],aa[3]-aa[1])==(8,8) and
               { (x+24,y) for x,y in a }==b and
               restored(right,a) and restored(left,b) and restored(clear,a|b))
    return dict(size=[width,height],left=aa,right=bb,leftPixels=len(a),rightPixels=len(b),passed=valid)


def audit(folder,output=None):
    clocks=json.loads((folder/'clock.json').read_text())
    cases=('producer','battle','explosions')
    expected={f'{case}-{variant}-{n}'+('-explosions' if case=='explosions' else '')
              for case in cases for variant in ('plain','hinted') for n in (1,2,3)}
    assert set(clocks['windows'])==set(clocks['battle'])==expected and len(set(clocks['battle'].values()))==1
    summaries=[]; details=[]
    for name,windows in clocks['windows'].items():
        assert len(windows)==1 and windows[0]['wall']>=30
        row=windows[0]
        info,frames=window_summary(name,folder,row)
        api=re.findall(r'hintApi=(plain|KHR|EXT)',(folder/(name+'-window.txt')).read_text())
        assert api and len(set(api))==1
        info['hint_api']=api[-1]
        assert (api[-1]=='plain')==(info['variant']=='plain' or not info['swap_damage'])
        count,last=row['frames'],row['lastSubmittedFrame']
        assert len(frames)==count
        def read(suffix):
            with (folder/(name+suffix)).open() as f:
                return [list(map(int,line)) for line in csv.reader(f) if last-count<int(line[1])<=last]
        mapped=read('-frame-map.csv')
        hints=read('-hints.csv')
        assert len(hints)==count and [r[:2] for r in hints]==[r[:2] for r in mapped]
        full=info['width']*info['height']
        called=0;partial=0;areas=[]
        for frame,(gen,number,hinted,x,y,w,h) in zip(frames,hints):
            assert number==frame[1] and hinted in (0,1) and 0<=x<x+w<=info['width'] and 0<=y<y+h<=info['height']
            assert hinted or (x,y,w,h)==(0,0,info['width'],info['height'])
            called+=hinted;partial+=w*h<full;areas.append(w*h)
            if output is not None:details.append([*frame,gen,hinted,x,y,w,h])
        plain=info['variant']=='plain'
        assert not plain or called==0
        exercised=plain or bool(info['swap_damage'] and called and partial)
        marker=None
        if info['scene']=='producer':
            marker=json.loads((folder/(name+'-marker.json')).read_text())['passed']
            if not plain and info['swap_damage']:
                exercised=exercised and all(r[2:]==[1,192,120,32,8] for r in hints[1:]) and areas[0]==full
        info.update(hinted_calls=called,partial_rectangles=partial,median_pixels=median(areas),
                    mean_area_fraction=sum(areas)/(count*full),marker=marker,exercised=exercised,
                    all_displayed=row['verifiedPresentations']==count)
        summaries.append(info)
    if output is not None:
        with (output/'presentation-frames.csv').open('w',newline='') as f:
            w=csv.writer(f);w.writerow(('window','frame','buffer','start_ns','swap_ns','return_ns','display_ns',
                                        'generation','hinted','x','y','width','height'));w.writerows(details)
        with (output/'presentation-cost.csv').open('w',newline='') as f:
            w=csv.DictWriter(f,summaries[0]);w.writeheader();w.writerows(summaries)
    return summaries


def marker_strip(folder, name):
    observation=json.loads((folder/(name+'-marker.json')).read_text())
    bounds=[box for box in (observation['left'],observation['right']) if box]
    if len(bounds)!=2:return None
    width,height=observation['size']
    left=max(0,min(b[0] for b in bounds)-4)
    top=max(0,min(b[1] for b in bounds)-4)
    w=min(width,max(b[2] for b in bounds)+4)-left
    h=min(height,max(b[3] for b in bounds)+4)-top
    if w>128 or h>64:return None
    # Embed the measured PNGs verbatim. Browsers crop them in layout, so the
    # report hash does not depend on the host's PNG encoder or zlib version.
    frames=[]
    for phase,label in enumerate(('初始','左','右','复原')):
        file=folder/f'{name}-marker-{phase}.png'
        data=base64.b64encode(file.read_bytes()).decode('ascii')
        frames.append(f'<span style="position:relative;overflow:hidden;width:25%;aspect-ratio:{w}/{h}">'
                      f'<img alt="{label}" src="data:image/png;base64,{data}" '
                      f'style="position:absolute;max-width:none;width:{100*width/w:.8f}%;height:auto;'
                      f'left:{-100*left/w:.8f}%;top:{-100*top/h:.8f}%;image-rendering:pixelated"></span>')
    return (f'<figure><div class="marker-strip" style="display:flex;max-width:{16*w}px">'
            + ''.join(frames) + f'</div><figcaption>{name} · 初始、左、右、复原（实拍局部放大）</figcaption></figure>')


def sections(run):
    folder=run/'tv-device-results/presentation'
    rows=audit(folder,run)
    pairs=[]
    for scene in ('producer','battle','explosions'):
        for n in range(1,4):
            pair={r['variant']:r for r in rows if r['scene']==scene and r['repeat']==n}
            a,b=pair['plain'],pair['hinted']
            def delta(field):
                return b[field]-a[field]
            pairs.append([scene,n,f"{delta('observed_fps'):+.2f}",f"{delta('swap_p50_ms'):+.3f}",
                          f"{delta('swap_p95_ms'):+.3f}",f"{100*delta('game'):+.2f}" if a['game'] is not None else '—',
                          f"{100*delta('pcm'):+.2f}" if a['pcm'] is not None else '—'])
    strips=[marker_strip(folder,f'producer-{variant}-1') for variant in ('plain','hinted')]
    return ['<h2>电视全图复制与交换范围</h2><p>同一安装包、同一初始战斗状态、1195 × 960 缓冲。每次交换使用分批日志，面积按实际调用参数计算。</p>',
            table(('场景','交换','实际接口','轮次','显示 / 提交','显示帧/秒','局部提示 / 总提示','平均面积','游戏速度','PCM 速度','交换 P50 ms','交换 P95 ms','方块复原'),
                  [[r['scene'],r['variant'],r['hint_api'],r['repeat'],f"{r['observed']} / {r['submitted']}",f"{r['observed_fps']:.2f}",
                    f"{r['partial_rectangles']} / {r['hinted_calls']}",f"{r['mean_area_fraction']:.2%}",
                    f"{r['game']:.2%}" if r['game'] is not None else '—',f"{r['pcm']:.2%}" if r['pcm'] is not None else '—',
                    r['swap_p50_ms'],r['swap_p95_ms'],r['marker'] if r['marker'] is not None else '—'] for r in rows]),
            '<h3>同轮差值</h3><p>各项取带矩形交换减普通交换。游戏与 PCM 速度列以百分点为单位。</p>',
            table(('场景','轮次','显示帧/秒差','交换 P50 差 ms','交换 P95 差 ms','游戏差','PCM 差'),pairs),
            *[strip for strip in strips if strip]]
