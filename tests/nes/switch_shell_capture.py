"""Measure eight fixed English Switch shots against the cartridge's actual OAM tiles."""
import argparse
import csv
import hashlib
import re
import subprocess
import struct
import zlib
from statistics import median
from pathlib import Path

from switch_motion import FIELD, VIDEO_SHA

FIXTURE = Path(__file__).with_name('fixtures') / 'switch-shells'
ACCEPTED_ROM = '1537e0332a916dfea21627c56ad354fcefbd73e6439092436c86c194b25a842f'
DIRECTIONS = ('up', 'right', 'down', 'left')
VECTORS = ((0,-1), (1,0), (0,1), (-1,0))
# First video frame, shell bounds, and a separate five-pixel transect across the barrel.
# The last pair is the centre of that transect, selected on the tank in the first frame.
SHOTS = (
    ('up',1042,134,154,135,163), ('up',1710,70,75,71,83),
    ('right',986,122,7,117,8), ('right',1566,25,95,20,96),
    ('down',1081,198,26,199,23), ('down',2374,166,23,167,18),
    ('left',1518,78,7,89,8), ('left',1994,183,87,190,88),
)
W, H, COUNT = 54, 52, 6
# Bounds on the existing logical-shot grid. Keep these independent of the tested OAM
# so a one-pixel change in the cartridge's tile origin is visible in the comparison.
REFERENCE_ORIGIN = ((0,1), (-1,1), (0,1), (-1,1))


def ffmpeg(*args, data=None):
    return subprocess.run(['ffmpeg','-v','error','-threads','1','-filter_threads','1',*map(str,args)],
                          input=data, stdout=subprocess.PIPE, check=True).stdout


def crop(rgb, stride, x, y, w, h):
    return b''.join(rgb[3*(stride*j+x):3*(stride*j+x+w)] for j in range(y,y+h))


def strip(images, w, h):
    return b''.join(img[3*w*y:3*w*(y+1)] for y in range(h) for img in images)


def png(path, rgb, w, h):
    # Pin the PNG scanlines and compression so the archived report does not depend
    # on the runner's FFmpeg encoder version.
    if len(rgb)!=3*w*h: raise ValueError('incomplete RGB panel')
    def chunk(kind, payload):
        return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload))
    scanlines=b''.join(b'\0'+rgb[3*w*y:3*w*(y+1)] for y in range(h))
    header=struct.pack('>IIBBBBB',w,h,8,2,0,0,0)
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',header)+
                     chunk(b'IDAT',zlib.compress(scanlines,0 if h==24 else 9))+chunk(b'IEND',b''))


def origin(direction, x, y):
    dx,dy = VECTORS[DIRECTIONS.index(direction)]
    return max(0,min(208-W,x+dx*7-W//2)), max(0,min(208-H,y+dy*7-H//2))


def freeze(video, folder):
    with video.open('rb') as src:
        if hashlib.file_digest(src,'sha256').hexdigest()!=VIDEO_SHA:
            raise ValueError('unexpected Switch video digest')
    folder.mkdir(parents=True,exist_ok=True)
    frames=sorted(n for _,start,*_ in SHOTS for n in range(start,start+COUNT))
    select="select='" + '+'.join(f'eq(n,{n})' for n in frames) + "'"
    # Check the presentation timestamps actually used for the source links.
    pts=subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries',
                                 'frame=best_effort_timestamp_time','-of','csv=p=0',str(video)],text=True)
    timestamps=[float(s.split(',')[0]) for s in pts.splitlines() if s.split(',')[0]]
    if any(abs(timestamps[n]-n*1001/30000)>1e-6 for n in frames):
        raise ValueError('unexpected Switch presentation timestamp')
    def extract(selected, extra, count):
        return ffmpeg('-i',video,'-vf',selected+extra,'-an','-fps_mode','passthrough','-frames:v',count,
                      '-threads','1','-pix_fmt','rgb24','-f','rawvideo','-')
    grid=extract(select,','+FIELD,len(frames))
    starts=sorted(shot[1] for shot in SHOTS)
    native=extract("select='"+'+'.join(f'eq(n,{n})' for n in starts)+"'",'',len(starts))
    for direction,start,x,y,*_ in SHOTS:
        ox,oy=origin(direction,x,y)
        panels=[]
        for n in range(start,start+COUNT):
            offset=frames.index(n)*208*208*3
            panels.append(crop(memoryview(grid)[offset:],208,ox,oy,W,H))
        png(folder/f'{direction}-{start}.png',strip(panels,W,H),W*COUNT,H)
        offset=starts.index(start)*1280*720*3
        nx,ny=291+ox*648//208,82+oy*556//208
        nw,nh=round(W*648/208),round(H*556/208)
        png(folder/f'native-{start}.png',crop(memoryview(native)[offset:],1280,nx,ny,nw,nh),nw,nh)


def tile_pixels(rom,tile,attr,offset_x,offset_y):
    base=16+rom[4]*16384+16*(256+tile)
    points=set()
    for y in range(8):
        row=7-y if attr&128 else y
        for x in range(8):
            bit=x if attr&64 else 7-x
            color=(rom[base+row]>>bit&1)+2*(rom[base+row+8]>>bit&1)
            if color:
                if color!=2 or attr&3!=2:
                    raise ValueError('unexpected visible shell color index')
                points.add((x+offset_x,y+offset_y))
    return points


def component(pixel,x,y,threshold):
    found=set()
    todo=[(x,y)]
    while todo:
        p=todo.pop()
        if p in found: continue
        rgb=pixel(*p)
        if not rgb or min(rgb)<=threshold or max(rgb)-min(rgb)>=26: continue
        found.add(p)
        a,b=p
        todo.extend(((a+1,b),(a-1,b),(a,b+1),(a,b-1)))
    return found


def bounds(points):
    xx,yy=zip(*points)
    return min(xx),min(yy),max(xx),max(yy)


def read_oam(receipt):
    raw=receipt.read_text()
    if 'BATTLECITY_SHELLS_OK four anchored OAM silhouettes' not in raw:
        raise ValueError('OAM capture did not complete')
    pattern=r'^BATTLECITY_SHELL_OAM (\d+) (\d+) (\d+) (-?\d+) (-?\d+)$'
    oam=[tuple(map(int,m)) for m in re.findall(pattern,raw,re.M)]
    if [row[0] for row in oam]!=list(range(4)):
        raise ValueError('incomplete four-direction OAM receipt')
    return oam


def measure(cartridge,out,receipt=None,fixture=FIXTURE):
    rom=cartridge.read_bytes()
    if receipt is None or not receipt.is_file():
        if hashlib.sha256(rom).hexdigest()!=ACCEPTED_ROM:
            raise ValueError('new cartridge needs its own campaign-loop/shells.log')
        receipt=fixture/'accepted-oam.txt'
    oam=read_oam(receipt)
    out.mkdir(parents=True,exist_ok=True)
    rows=[]
    for direction,start,x,y,bx,by in SHOTS:
        index=DIRECTIONS.index(direction)
        dx,dy=VECTORS[index]
        shape=tile_pixels(rom,*oam[index][1:])
        sx,sy=REFERENCE_ORIGIN[index]
        ox,oy=origin(direction,x,y)
        data=ffmpeg('-i',fixture/f'{direction}-{start}.png','-threads','1','-pix_fmt','rgb24','-f','rawvideo','-')
        if len(data)!=3*W*COUNT*H: raise ValueError('invalid recording crop')
        panels=[]
        for i in range(COUNT):
            def pixel(a,b):
                if not (ox<=a<ox+W and oy<=b<oy+H):return b''
                p=3*((b-oy)*W*COUNT+i*W+a-ox)
                return data[p:p+3]
            if i==0:
                transect=[(bx+v*abs(dy),by+v*abs(dx)) for v in range(-2,3)]
                barrel=[a if dy else b for a,b in transect if max(pixel(a,b))>72]
                if len(barrel)!=1:raise ValueError(f'ambiguous barrel transect at {start}: {barrel}')
            xx,yy=x+4*i*dx,y+4*i*dy
            expected={(xx+a-sx,yy+b-sy) for a,b in shape}
            observed=[component(pixel,xx+1,yy+1,cut) for cut in (50,60,70)]
            actual=observed[1]
            left,top,right,bottom=bounds(actual)
            cross=(left+right)/2 if dy else (top+bottom)/2
            errors=[len(points^expected) for points in observed]
            rgb=[median(pixel(a,b)[channel] for a,b in actual) for channel in range(3)]
            rows.append((direction,start,start+i,f'{318+(start+i)*1001/30000:.6f}',left,top,
                         right-left+1,bottom-top+1,len(actual),*errors,barrel[0],cross-barrel[0],*rgb))
            def patch(kind):
                result=bytearray()
                for b in range(yy-2,yy+6):
                    for a in range(xx-2,xx+6):
                        if kind=='video': result.extend(pixel(a,b))
                        else: result.extend(bytes([180 if (a,b) in (actual if kind=='mask' else expected) else 0])*3)
                return result
            panels.append(b''.join(patch(kind) for kind in ('video','mask','game')))
        png(out/f'compare-{start}.png',strip(panels,8,24),8*COUNT,24)
    with (out/'shells.csv').open('w',newline='') as f:
        writer=csv.writer(f)
        writer.writerow(('direction','shot','frame','source_seconds','x','y','width','height','visible',
                         'errors_50','errors_60','errors_70','barrel_axis','axis_delta','median_r','median_g','median_b'))
        writer.writerows(rows)
    return rows


def barrel_offsets(log, shell_oam, rom):
    lines=log.read_text()
    if 'BATTLECITY_BARRELS_OK' not in lines: raise ValueError('incomplete barrel capture')
    launches = {}
    axes = {}
    for line in lines.splitlines():
        parts = line.split()
        if parts[:1] == ['BATTLECITY_LAUNCH']:
            i, x, y = map(int, parts[1:])
            if i in launches:
                raise ValueError(f'duplicate launch direction {i}')
            launches[i] = (x, y)
        elif parts[:1] == ['BATTLECITY_BARREL']:
            kind, i, value = parts[1:]
            key = kind, int(i)
            if key in axes:
                raise ValueError(f'duplicate barrel capture {key}')
            axes[key] = int(value)
    actors = ('player', 'player2', 'enemy') if ('player2', 0) in axes else ('player', 'enemy')
    if set(launches) != set(range(4)) or set(axes) != {(kind, i) for kind in actors for i in range(4)}:
        raise ValueError('incomplete barrel directions')
    result={}
    for i,tile,attr,x,y in shell_oam:
        shape=tile_pixels(rom,tile,attr,x,y)
        cross_axis=i%2
        coords=[p[cross_axis] for p in shape]
        center=launches[i][cross_axis]+(min(coords)+max(coords))/2
        for kind in actors:
            result[kind,i]=center-axes[kind,i]
    return result


def verify_player_axes(offsets):
    for kind in ('player', 'player2'):
        for i, direction in enumerate(DIRECTIONS):
            if offsets.get((kind, i)) != 0:
                raise ValueError(f'{kind} {direction} muzzle offset: {offsets.get((kind, i))}')


def report(cartridge, directory, receipt=None, barrels=None):
    from ending_parity import BASELINE, FIELDS, read_events
    from native_window_report import picture, table
    rows=measure(cartridge,directory,receipt)
    rom=cartridge.read_bytes()
    if not barrels or not barrels.is_file():
        if hashlib.sha256(rom).hexdigest()!=ACCEPTED_ROM: raise ValueError('missing current barrel capture')
        barrels=FIXTURE/'accepted-barrels.txt'
    oam=read_oam(receipt if receipt and receipt.is_file() else FIXTURE/'accepted-oam.txt')
    offsets=barrel_offsets(barrels,oam,rom)
    current = hashlib.sha256(rom).hexdigest() != ACCEPTED_ROM
    if current:
        verify_player_axes(offsets)
        from tank_poses import verify
        pose_count = verify(rom, barrels)
    # The two faint extra pixels are in the source recording. The 70-level
    # extraction of the same frames resolves their ambiguity independently.
    for row in rows:
        allowed=1 if row[2] in (1081,1084) else 0
        if row[10]>allowed or row[11]!=0 or row[13]!=0:
            raise ValueError(f'Switch shell differs at {row[0]} frame {row[2]}: {row[9:14]}')
    names={'up':'上','right':'右','down':'下','left':'左'}
    parts=['<h2>炮弹与炮口的逐像素对照</h2>',
           '<p>同一段英文 Switch 实录中，每个方向各取两次发射，每次保留六帧。'
           '场地校准为 208×208 格。沿飞行方向，每采集帧前进四格。法向位置另从车身炮管的一条横截线读取。'
           '视频的采集率为 30000/1001 帧/秒，首次按下开火键的 NES 帧仍未知。</p>',
           table(('方向','逐格相同','宽×高','复刻可见格数','Switch 炮弹中心距炮管轴线','复刻同类坦克偏移（格）'),
                 [[names[d],f'{sum(r[10]==0 for r in rows if r[0]==d)}/12',
                   '3×4' if d in ('up','down') else '4×3',10,'0 格',offsets['player' if d in ('up','left') else 'enemy',DIRECTIONS.index(d)]] for d in DIRECTIONS]),
           '<p>使用既有灰色阈值 60 时，向下第 1081、1084 帧各多一个灰像素。阈值升至 70 后，'
           '全部 48 帧逐格一致。CSV 同时记录阈值 50、60、70、每帧坐标和可见区域的 RGB 中位数。'
           '复刻图按核心实际写入的精灵属性及卡带图块解码，灰色表示 NES 精灵调色板 2 的颜色索引 2。</p>']
    for d,n,*_ in SHOTS:
        r=next(r for r in rows if r[1]==n)
        parts.append(f'<h3>向{names[d]} · <a href="https://www.youtube.com/watch?v=S26lUv598_o&amp;t={int(float(r[3]))}s">原片 {r[3]} 秒</a></h3>')
        parts.extend((picture(FIXTURE/f'native-{n}.png','原始分辨率，第一帧的炮口和弹体'),
                      picture(directory/f'compare-{n}.png','六个连续帧，自上而下为实录、实录灰色轮廓、交付卡带图块')))
    accepted=[event for route,*event in read_events(BASELINE,('route',*FIELDS)) if route=='neutral']
    trial=list(read_events(FIXTURE/'trial-neutral.csv',FIELDS))
    diff=[]
    if len(trial)!=len(accepted):
        raise ValueError('archived rendering trial has an incomplete neutral ending')
    for i,(a,b) in enumerate(zip(accepted,trial),1):
        if tuple(a)!=b:
            diff.append([i,a[0],a[2],a[1],b[1]])
    parts.extend(['<h3>玩家坦克炮口定位试验</h3>',
                  '<p>运行 45915496575 的卡带中，初级玩家坦克朝上、朝左时炮弹中心分别在炮管左方一格和下方一格。'
                  '试验将朝上的车身左移一格，并把朝左的车身改为水平镜像。'
                  '同一交付 Web 核心分别加载两张卡带后重播中性结局。正式版的 179 个事件与留档逐字节相同。'
                  '试验保住了事件与帧号，改变了三个事件在帧内的执行时间，该次试验未进入交付。</p>',
                  table(('事件序号','显示帧','事件','基准模拟秒','试验模拟秒'),diff),
                  '<p>数据包附有试验补丁、固定输入下的完整事件序列、裁图和验收基线。'
                  '两次向上和两次向左的发射分别来自同一段录像中的不同时间。</p>'])
    if current:
        parts.extend(['<h3>本次交付的双人炮口与精灵</h3>',
                      f'<p>两位初级玩家的四向炮口偏移均为 0 格。{pose_count} 组精灵像素、位置、'
                      '调色板和前后景优先级通过检查，覆盖两帧履带、升级、树林、护盾、边缘及精灵占满。'
                      '实录取样只覆盖上表中的发射，其余姿态以已交付卡带为对照。</p>'])
    return parts


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cartridge',type=Path)
    parser.add_argument('output',type=Path)
    parser.add_argument('--video',type=Path,help='re-extract the frozen crops from the original recording')
    parser.add_argument('--fixture',type=Path,default=FIXTURE)
    parser.add_argument('--oam',type=Path)
    args=parser.parse_args()
    if args.video:freeze(args.video,args.fixture)
    result=measure(args.cartridge,args.output,args.oam,args.fixture)
    print(f'{sum(row[10]==0 for row in result)}/{len(result)} exact shell silhouettes')
