"""Locate source-row and edge discrepancies in a pair of frozen Android TV screenshots."""
import argparse
import csv
import json
from pathlib import Path
from television import screen_rgb


def analyze(directory, output):
    output.mkdir(parents=True,exist_ok=True)
    summaries={}
    with (output/'sampling-rows.csv').open('w',newline='') as stream:
        writer=csv.writer(stream)
        writer.writerow(['case','nes_y','changed_centers','above_8','shift_up_match','shift_down_match'])
        for case,width in [('large',1440),('stretch',1920)]:
            base,other=[screen_rgb((directory/f'{case}-{path}.png').read_bytes(),'1920:1080') for path in ('baseline','candidate')]
            centers=big=up=down=rows=0
            def pixel(data,x,y):
                start=3*(1920*y+x)
                return data[start:start+3]
            def near(a,b):
                return max(abs(i-j) for i,j in zip(a,b))<=8
            xs=[int((1920-width)/2+(x+.5)*width/256) for x in range(256)]
            for row in range(224):
                y=int((row+.5)*1080/224)
                changed=large=above=below=0
                for x in xs:
                    a,b=pixel(base,x,y),pixel(other,x,y)
                    changed+=a!=b
                    if not near(a,b):
                        large+=1
                        above+=any(near(a,pixel(other,x,y-d)) for d in (1,2) if y>=d)
                        below+=any(near(a,pixel(other,x,y+d)) for d in (1,2) if y+d<1080)
                writer.writerow([case,row,changed,large,above,below])
                centers+=changed;big+=large;up+=above;down+=below;rows+=bool(changed)
            summaries[case]={'centers':centers,'strong':big,'affectedRows':rows,'upMatch':up,'downMatch':down}
    (output/'sampling.json').write_text(json.dumps(summaries,indent=2)+'\n')
    return summaries


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('render',type=Path);p.add_argument('out',type=Path)
    args=p.parse_args();print(analyze(args.render,args.out))
