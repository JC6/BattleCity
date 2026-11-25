"""Locate each held-out difference at the native raster, expanded buffer or Android screenshot."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import statistics


def ppm(data):
    magic, dims, maximum, rgb = data.split(b'\n',3)
    w,h=map(int,dims.split())
    if magic!=b'P6' or maximum!=b'255' or len(rgb)!=w*h*3:
        raise ValueError('incomplete RGB image')
    return w,h,rgb


def load(path):
    if path.suffix=='.gz':
        return ppm(gzip.decompress(path.read_bytes()))
    return ppm(subprocess.check_output(['ffmpeg','-v','error','-threads','1','-i',str(path),
        '-frames:v','1','-pix_fmt','rgb24','-c:v','ppm','-f','image2pipe','-threads','1','-']))


def compare(images):
    (w,h,data),(bw,bh,repeat),(cw,ch,test)=images
    hashes=[hashlib.sha256(row[2]).hexdigest() for row in images]
    result={'dimensions':[[r[0],r[1]] for r in images],'rgbSha256':hashes}
    if (w,h)!=(bw,bh) or (w,h)!=(cw,ch):
        return {**result,'geometryMismatch':True}
    if hashes[0]==hashes[1]==hashes[2]:
        return {**result,**dict.fromkeys(("differentPixels","repeatPixels","aboveRepeatNoise","atBoundary","awayFromBoundary","maxChannelError"),0),"mostFrequentColorChanges":[]}
    errors=Counter()
    different=boundary=above_noise=noisy=0
    largest=0
    pitch=3*w
    # All three buffers have the same coordinates. A boundary has a
    # differently coloured four-connected neighbour in the software baseline.
    for i in range(0,len(data),3):
        p=data[i:i+3]; b=repeat[i:i+3]; c=test[i:i+3]
        noisy+=p!=b
        if p==c:continue
        different+=1
        deltas=[abs(x-y) for x,y in zip(p,c)]
        above_noise+=any(d>abs(x-y) for d,x,y in zip(deltas,p,b))
        largest=max(largest,max(deltas))
        x=(i%pitch)//3
        edge=((x>0 and p!=data[i-3:i]) or (x+1<w and p!=data[i+3:i+6]) or
              (i>=pitch and p!=data[i-pitch:i-pitch+3]) or (i+pitch<len(data) and p!=data[i+pitch:i+pitch+3]))
        boundary+=bool(edge)
        errors[(p.hex(),c.hex())]+=1
    return {**result,'differentPixels':different,'repeatPixels':noisy,'aboveRepeatNoise':above_noise,
            'atBoundary':boundary,'awayFromBoundary':different-boundary,'maxChannelError':largest,
            'mostFrequentColorChanges':[[*pair,count] for pair,count in errors.most_common(5)]}


def calibration_edges(expanded, system):
    """Register the buffer on the display, then measure leakage across isolated edges."""
    w,h,src=expanded
    sw,sh,screen=system
    def pixel(data,width,x,y):
        offset=3*(y*width+x)
        return data[offset:offset+3]
    # Exclude the clipped overscan and compare sparse black/white line boundaries.
    edges=[]
    for y in range(h//2+10,h-50,3):
        for x in range(4,w-4,5):
            point=pixel(src,w,x,y)
            adjacent=[pixel(src,w,x+dx,y+dy) for dx,dy in ((-1,0),(1,0),(0,-1),(0,1))]
            changed=[i for i,n in enumerate(adjacent) if max(abs(a-b) for a,b in zip(point,n))>180]
            if len(changed)==1:edges.append((x,y,point[0],changed[0],adjacent[changed[0]][0]))
    if len(edges)<=200:
        return {'offset':None,'edgeLeakage':{},'status':'insufficient calibration edges'}
    def error(dx,dy):
        return sum(abs(pixel(screen,sw,x+dx,y+dy)[0]-v) for x,y,v,_,_ in edges)
    matches=sorted((error(x,y),x,y) for x in range((sw-w)//2-1,(sw-w)//2+3)
                   for y in range((sh-h)//2-1,(sh-h)//2+3))
    if matches[0][0]==matches[1][0]:
        return {'offset':None,'edgeLeakage':{},'status':'ambiguous alignment'}
    _,dx,dy=matches[0]
    values=[[] for _ in range(4)]
    for x,y,expected,d,neighbor in edges:
        observed=pixel(screen,sw,x+dx,y+dy)[0]
        values[d].append((observed-expected)/(neighbor-expected))
    stats={}
    for axis,weights in zip(('left','right','above','below'),values):
        if weights:
            weights.sort()
            stats[axis]={'edges':len(weights),'mean':round(statistics.mean(weights),6),
                         'p95':round(weights[int(.95*(len(weights)-1))],6)}
    return {'offset':[dx,dy],'edgeLeakage':stats}

def analyze(folder):
    rows={}
    cases=json.loads((folder/'visual.json').read_text())
    expects_swap=any(folder.glob('*-layers.txt.gz'))
    modes=('baseline','repeat','candidate')
    for name,visual in cases.items():
        stages={}
        for stage in ('source','expanded','layer',*(('swap',) if expects_swap else ()), 'system'):
            tail='.png' if stage=='system' else '-'+stage+'.ppm.gz'
            files=[folder/(name+'-'+mode+tail) for mode in modes]
            missing=[mode for mode,path in zip(modes,files) if not path.is_file()]
            if missing:
                stages[stage]={'missing':missing}
                continue
            imgs=[load(path) for path in files]
            stages[stage]=compare(imgs)
            if stage=='swap':
                stages[stage]['candidateAllBlack']=not any(imgs[-1][2])
            if name=='calibration' and stage=='source':
                w,h,rgb=imgs[0]
                bars=[rgb[(h//4*w+(2*n+1)*w//16)*3:][:3].hex() for n in range(8)]
                assert bars==['000000','ffffff','ff0000','00ff00','0000ff','cc7f35','456789','808080'],bars
        if name=='calibration':
            for mode in ('baseline','candidate'):
                expanded=load(folder/f'{name}-{mode}-expanded.ppm.gz')
                info=calibration_edges(expanded,load(folder/f'{name}-{mode}.png'))
                stages['system'][mode+'Registration']=info
                layer=folder/f'{name}-{mode}-layer.ppm.gz'
                if layer.is_file():
                    before=load(layer)
                    stages['system'][mode+'BeforePresent']=compare([expanded,expanded,before])
                    stages['system'][mode+'LayerRegistration']=calibration_edges(before,load(folder/f'{name}-{mode}.png'))
                swap=folder/f'{name}-{mode}-swap.ppm.gz'
                if swap.is_file():
                    buf=load(swap)
                    stages['system'][mode+'SwapRegistration']=calibration_edges(buf,load(folder/f'{name}-{mode}.png'))
                    stages['system'][mode+'ExpandedToSwap']=compare([expanded,expanded,buf])
        assert stages['system']['aboveRepeatNoise']==visual['aboveRepeatNoise']
        first='identical'
        for stage,result in stages.items():
            if result.get('missing'):
                first='unverified from '+stage
                break
            if result.get('geometryMismatch') or result['aboveRepeatNoise']:
                first=stage
                break
        rows[name]={'battle':visual['battle'],'firstDifference':first,'stages':stages}
    return rows


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('held_out',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    args.output.write_text(json.dumps(analyze(args.held_out),indent=2)+'\n')
