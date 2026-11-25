"""Compare static menu details on the same 1280 by 720 grid as the English Switch capture."""
import argparse
import csv
from functools import lru_cache
from pathlib import Path
import struct
import subprocess


@lru_cache(maxsize=12)
def grid(file):
    return subprocess.check_output(['ffmpeg','-v','error','-threads','1','-i',str(file),'-vf',
        'scale=1280:720:flags=area','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-threads','1','-'])


# Middle slot two stays empty in the keyboard and two-controller fixtures.
# The preview frame is measured outside its changing game image.
REGIONS=[
    ('title-tab','system-menu',(258,42,1024,96),'navy'),
    ('save-focus','system-menu',(471,91,809,178),'cyan'),
    ('slot-tab','system-menu',(408,261,583,291),'blue'),
    ('empty-slot','system-menu',(449,359,584,397),'red'),
    ('preview-rim','screen-settings',(487,130,793,308),'rim'),
    ('picture-icons','screen-settings',(799,129,856,214),'colour'),
]


def mask(rgb,rect,kind):
    x0,y0,x1,y1=rect
    marked=set()
    for y in range(y0,y1):
        for x in range(x0,x1):
            r,g,b=rgb[(1280*y+x)*3:(1280*y+x)*3+3]
            if kind=='navy': match=18<=b<112 and b-r>15 and b-g>9
            elif kind=='cyan': match=g>90 and b>115 and b-r>48
            elif kind=='blue': match=b>55 and b-g>23 and b-r>35
            elif kind=='red': match=r>53 and r-g>20 and r-b>12
            elif kind=='rim': match=(x<509 or x>771 or y<142 or y>294) and max(r,g,b)>28
            else: match=max(r,g,b)>44 and max(r,g,b)-min(r,g,b)>27
            if match:marked.add((x,y))
    return marked


def compare(reference, groups, output):
    rows=[]
    for name,scene,rect,kind in REGIONS:
        target=mask(grid(reference/(scene+'.png')),rect,kind)
        assert target,name
        for system,path in groups.items():
            img=path/(scene+'.png')
            if not img.is_file():
                if scene=='system-menu' and (path/'protected-slot.png').is_file() and name!='save-focus':
                    img=path/'protected-slot.png'
                else:continue
            actual=mask(grid(img),rect,kind)
            union=target|actual
            rows.append(dict(region=name,platform=system,frame=img.name,reference_pixels=len(target),
                       measured_pixels=len(actual),intersection_over_union=round(len(target&actual)/len(union),4)))
    with output.open('w',newline='') as f:
        w=csv.DictWriter(f,rows[0]);w.writeheader();w.writerows(rows)


def compare_sizes(reference, samples, output):
    """Measure menu changes against the same Switch frame at each native display size.

    Each sample maps a scene to the old frame, its repeat, the new frame and its repeat.
    """
    rows=[]
    for (platform,height), scenes in samples.items():
        width={720:1280,1080:1920}[height]
        for region,scene,rect,kind in REGIONS:
            reference_mask=mask(grid(reference/(scene+'.png')),rect,kind)
            files=scenes[scene]
            if not reference_mask or len(files)!=4:
                raise ValueError(f'Incomplete menu region {platform} {height} {region}')
            masks=[]
            for file in files:
                with file.open('rb') as f:
                    header=f.read(24)
                if header[:8]!=b'\x89PNG\r\n\x1a\n' or struct.unpack('>II',header[16:24])!=(width,height):
                    raise ValueError(f'Expected {width} × {height} PNG at {file}')
                masks.append(mask(grid(file),rect,kind))
            values=[len(observed & reference_mask)/len(observed | reference_mask) for observed in masks]
            old,old_repeat,new,new_repeat=values
            noise=max(abs(old-old_repeat),abs(new-new_repeat))
            delta=new-old
            target=region in ('save-focus','empty-slot')
            rows.append(dict(platform=platform,height=height,region=region,old_iou=round(old,6),new_iou=round(new,6),
                             delta=round(delta,6),repeat_variation=round(noise,6),
                             criterion='improvement' if target else 'no regression',
                             passed=delta>noise if target else delta>=-noise))
    with output.open('w',newline='') as f:
        writer=csv.DictWriter(f,rows[0])
        writer.writeheader()
        writer.writerows(rows)
    return rows


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference',type=Path)
    parser.add_argument('output',type=Path)
    parser.add_argument('groups',nargs='+',help='label=directory containing screenshots')
    args=parser.parse_args()
    compare(args.reference,{k:Path(v) for k,v in (group.split('=',1) for group in args.groups)},args.output)
