"""Score native Web and TV menu captures against frozen, registered Switch masks."""
import csv
import json
import struct
import zlib
from functools import lru_cache
from pathlib import Path
from switch_menu_regions import REGIONS, grid, mask

FIXTURE=Path(__file__).with_name('fixtures')/'switch-menu/reference.json'
FOCUS_FIXTURE=FIXTURE.with_name('focus.json')
TARGETS={'empty-slot','picture-icons'}


def measure(run,previous,destination):
    references=json.loads(FIXTURE.read_text())
    floor=(run/'tv-device-results/floor/clock.json').is_file()
    targets={'save-focus'} if floor else TARGETS
    if floor:
        focus=json.loads(FOCUS_FIXTURE.read_text())
        assert len(focus)==6 and len({r['video'] for r in focus if r['role']=='validation'})==2
        references.extend(focus)
    @lru_cache(maxsize=None)
    def observed(file,region,height):
        _,_,rect,colour=next(r for r in REGIONS if r[0]==region)
        with file.open('rb') as f:header=f.read(24)
        assert header[:8]==bytes.fromhex('89504e470d0a1a0a') and struct.unpack('>II',header[16:])==({720:1280,1080:1920}[height],height),file
        return mask(grid(file),rect,colour)
    rows=[]
    for platform in ('Web','Android TV'):
        for height in (720,1080):
            for ref in references:
                region,scene=ref['region'],ref['scene']
                _,_,(x,y,X,Y),_=next(r for r in REGIONS if r[0]==region)
                bits=zlib.decompress(bytes.fromhex(ref['mask']))
                assert len(bits)==(Y-y)*(X-x)
                target={(x+i%(X-x),y+i//(X-x)) for i,b in enumerate(bits) if b}
                scores=[]
                for version in ('previous','current'):
                    for suffix in ('','-repeat'):
                        if platform=='Web':
                            folder=(previous if version=='previous' else run)/'web-clock-and-endings/screens'
                            file=folder/f'{scene}-{height}{suffix}.png'
                        else:
                            folder=run/'tv-device-results/menu-samples'/str(height)/version
                            file=folder/f'{scene}{suffix}.png'
                        pixels=observed(file,region,height)
                        scores.append(len(pixels&target)/len(pixels|target))
                old,old_repeat,new,new_repeat=scores
                delta=new-old
                noise=max(abs(old-old_repeat),abs(new-new_repeat))
                rows.append(dict(platform=platform,height=height,region=region,role=ref['role'],
                                 video=ref['video'],seconds=ref['seconds'],previous=old,current=new,
                                 previous_repeat=old_repeat,current_repeat=new_repeat,noise=noise,
                                 passed=delta>noise if region in targets else delta>=-noise))
    with destination.open('w',newline='') as f:
        w=csv.DictWriter(f,rows[0]);w.writeheader();w.writerows(rows)
    assert len(references)==(34 if floor else 28) and len(rows)==4*len(references)
    return rows


def control_samples(run, destination):
    # Exclude the Save button and changing game previews. Use the pixels of the
    # focused control and its label, including the confirmation prompt itself.
    controls={'slot-focus':(133,246,389,293), 'confirm-focus':(335,247,945,326),
              'load-focus':(471,161,809,247), 'settings-focus':(309,482,642,574)}
    rows=[]
    for platform in ('Web','Android TV'):
        for height in (720,1080):
            for scene,rect in controls.items():
                samples=[]
                for version in ('previous','current'):
                    for suffix in ('','-repeat'):
                        if platform=='Web':
                            folder='upgrade-webkit' if version=='previous' else 'web-clock-and-endings'
                            file=run/folder/'screens'/f'{scene}-{height}{suffix}.png'
                        else:
                            file=run/'tv-device-results/menu-samples'/str(height)/version/(scene+suffix+'.png')
                        with file.open('rb') as f: size=struct.unpack('>II',f.read(24)[16:])
                        assert size==({720:1280,1080:1920}[height],height),file
                        bitmap=grid(file)
                        x,y,X,Y=rect
                        samples.append(b''.join(bitmap[3*(1280*i+x):3*(1280*i+X)] for i in range(y,Y)))
                a,ar,b,br=samples
                assert len(set(a))>8 and len(set(b))>8,scene
                changed=sum(abs(v-w)>max(abs(v-vr),abs(w-wr)) for v,vr,w,wr in zip(a,ar,b,br))
                rows.append(dict(platform=platform,height=height,scene=scene,channels_above_noise=changed,passed=changed==0))
    with destination.open('w',newline='') as f:
        w=csv.DictWriter(f,rows[0]);w.writeheader();w.writerows(rows)
    return rows
