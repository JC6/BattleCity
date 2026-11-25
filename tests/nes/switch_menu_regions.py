"""Compare static menu details on the same 1280 by 720 grid as the English Switch capture."""
import argparse
import csv
from functools import lru_cache
from pathlib import Path
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


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference',type=Path)
    parser.add_argument('output',type=Path)
    parser.add_argument('groups',nargs='+',help='label=directory containing screenshots')
    args=parser.parse_args()
    compare(args.reference,{k:Path(v) for k,v in (group.split('=',1) for group in args.groups)},args.output)
