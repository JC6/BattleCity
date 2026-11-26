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


def compare_sizes(reference, samples, output, improving=('save-focus','empty-slot')):
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
            target=region in improving
            rows.append(dict(platform=platform,height=height,region=region,old_iou=round(old,6),new_iou=round(new,6),
                             delta=round(delta,6),repeat_variation=round(noise,6),
                             criterion='improvement' if target else 'no regression',
                             passed=delta>noise if target else delta>=-noise))
    with output.open('w',newline='') as f:
        writer=csv.DictWriter(f,rows[0])
        writer.writeheader()
        writer.writerows(rows)
    return rows


def register_menu_frame(reference, capture, output):
    """Align two full menus on their outside borders, independently of slot content."""
    from statistics import median

    def borders(bitmap):
        def peak(points):
            chroma=[]
            for x,y,coordinate in points:
                pos=3*(1280*y+x)
                chroma.append((bitmap[pos+2]-bitmap[pos],coordinate))
            maximum=max(value for value,_ in chroma)
            return median(coordinate for value,coordinate in chroma if value>=maximum-2)

        left,right=[median(peak((x,y,x) for x in xs) for y in range(140,336,4))
                    for xs in (range(80,110),range(1170,1201))]
        # Use the side margins of the top bar to avoid its central title lettering.
        columns=[*range(155,228,4),*range(1060,1120,4)]
        top,bottom=[median(peak((x,y,y) for y in ys) for x in columns)
                    for ys in (range(24,50),range(621,649))]
        return (left,right,top,bottom)

    a,b=borders(grid(reference)),borders(grid(capture))
    width=round(1280*(a[1]-a[0])/(b[1]-b[0]))
    height=round(720*(a[3]-a[2])/(b[3]-b[2]))
    dx,dy=round(a[0]-b[0]*width/1280),round(a[2]-b[2]*height/720)
    if not (0<=dx<=1280-width and 0<=dy<=720-height):
        raise ValueError('Held-out capture does not fit the calibrated display bounds')
    filters=f'scale=1280:720:flags=area,format=rgb24,scale={width}:{height}:flags=bilinear,pad=1280:720:{dx}:{dy}'
    subprocess.run(['ffmpeg','-v','error','-y','-filter_threads','1','-i',str(capture),'-vf',filters,
                    '-frames:v','1','-threads','1',str(output)],check=True)
    return dict(reference_edges=a,capture_edges=b,scaled_size=[width,height],offset=[dx,dy])


def save_menu_overlay(reference, previous, current, region, dest):
    """Show the three unmodified crops and their aligned Switch/current colour masks."""
    _, _, rect, colour = next(entry for entry in REGIONS if entry[0]==region)
    x0,y0,x1,y1=rect
    images=[grid(file) for file in (reference,previous,current)]
    target,observed=(mask(images[i],rect,colour) for i in (0,2))
    pixels=bytearray()
    for y in range(y0,y1):
        for rgb in images:
            pixels.extend(rgb[(1280*y+x0)*3:(1280*y+x1)*3])
        for x in range(x0,x1):
            point=(x,y)
            pixels.extend((226,226,226) if point in target and point in observed else
                          (245,81,89) if point in target else (55,203,238) if point in observed else (0,0,0))
    size=f'{(x1-x0)*4}x{y1-y0}'
    subprocess.run(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',size,
                    '-i','pipe:0','-vf','scale=iw*3:ih*3:flags=neighbor','-frames:v','1',
                    '-threads','1',str(dest)],input=pixels,check=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference',type=Path)
    parser.add_argument('output',type=Path)
    parser.add_argument('groups',nargs='+',help='label=directory containing screenshots')
    args=parser.parse_args()
    compare(args.reference,{k:Path(v) for k,v in (group.split('=',1) for group in args.groups)},args.output)
