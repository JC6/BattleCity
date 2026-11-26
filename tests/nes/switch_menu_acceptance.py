"""Score native Web and TV menu captures against frozen, registered Switch masks."""
import csv
import json
import struct
import zlib
from functools import lru_cache
from pathlib import Path
from switch_menu_regions import REGIONS, grid, mask

FIXTURE=Path(__file__).with_name('fixtures')/'switch-menu/reference.json'
TARGETS={'empty-slot','picture-icons'}


def measure(run,previous,destination):
    references=json.loads(FIXTURE.read_text())
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
                                 passed=delta>noise if region in TARGETS else delta>=-noise))
    with destination.open('w',newline='') as f:
        w=csv.DictWriter(f,rows[0]);w.writeheader();w.writerows(rows)
    assert len(references)==28 and len(rows)==112
    return rows
