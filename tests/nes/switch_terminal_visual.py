"""Measure stable TOTAL and GAME OVER masks in fixed English Switch excerpts."""
import argparse
import csv
import hashlib
import re
import subprocess
from pathlib import Path

# Video SHA-256, HLS start, local search time, kill count, and two reference frames.
CASES = {
    'audap': ('17dffc750f2d8f70fee60b4ed87b79c199a851333026d98500bfc9c9a605be8d',
              425.716665,196,15,(96,106,18,7),625.0,627.5),
    'snoley': ('9b22d68d85f367931c0ba264b0286a1822e6f8c5dafcaba1cae9764106646854',
               288.799962,155,14,(98,106,15,7),447.7,449.8),
}


def onset(clip, origin, seek, bounds, anchor, red):
    x,y,w,h=bounds
    filters=f'scale=240:135,format=rgb24,crop={w}:{h}:{x}:{y},showinfo'
    p=subprocess.run(['ffmpeg','-hide_banner','-v','info','-threads','2','-ss',str(seek),'-i',str(clip),
                      '-t','8.2','-an','-vf',filters,'-fps_mode','passthrough','-threads','1',
                      '-f','rawvideo','-'],check=True,capture_output=True)
    times=[float(t)+origin+seek for t in re.findall(rb'pts_time:([-\d.]+)',p.stderr)]
    frame_size=w*h*3
    count,extra=divmod(len(p.stdout),frame_size)
    if extra or len(times)<count:raise ValueError('Missing video presentation timestamps')
    masks=[]
    for pos in range(0,len(p.stdout),frame_size):
        image=p.stdout[pos:pos+frame_size]
        pixels=enumerate(zip(image[0::3],image[1::3],image[2::3]))
        if red:
            masks.append({i for i,(r,g,b) in pixels if r>44 and r>g*1.16 and r>b*1.35})
        else:
            masks.append({i for i,p in pixels if min(p)>105})
    target=masks[min(range(count),key=lambda i:abs(times[i]-anchor))]
    assert len(target)>6
    overlap=[len(target & frame)/len(target | frame) for frame in masks]
    first=next(i for i in range(count-2) if min(overlap[i:i+3])>.80)
    assert first>5 and max(overlap[first-5:first])<.20
    return times[first],times[first]-times[first-1],overlap[first]


def measure(case,clip,output):
    digest,origin,seek,count,bounds,anchor,game_over=CASES[case]
    with clip.open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=digest:raise ValueError('Unexpected video excerpt')
    total,period,t_score=onset(clip,origin,seek,bounds,anchor,False)
    end,_,e_score=onset(clip,origin,seek,(75,37,90,57),game_over,True)
    with output.open('w',newline='') as f:
        w=csv.writer(f)
        w.writerow(('source','sha256','kills','total_s','game_over_s','frame_period_s','total_iou','word_iou','interval_s'))
        w.writerow((case,digest,count,round(total,6),round(end,6),round(period,6),round(t_score,6),round(e_score,6),round(end-total,6)))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case',choices=CASES)
    parser.add_argument('clip',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    measure(args.case,args.clip,args.output)
