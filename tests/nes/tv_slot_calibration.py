"""Compare the shared save-slot drawing against registered English Switch menu frames."""
import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
from statistics import median

from switch_menu_regions import REGIONS, grid, mask

_, _, REGION, COLOR = next(r for r in REGIONS if r[0]=='slot-tab')


def overlap(reference, observed):
    return len(reference & observed) / len(reference | observed)


def geometry(rgb):
    outline=mask(rgb, (408,259,612,303), COLOR)
    # The top of the second slot is wider than its number and the lock.
    rows={y:sorted(x for x,yy in outline if yy==y) for y in range(259,303)}
    top=next((y for y,xs in rows.items() if len(xs)>100),None)
    join=next((y for y,xs in rows.items() if sum(x>590 for x in xs)>=10),None)
    def edge(y):
        return max(rows[y],default=0)
    digits=[]
    for y in range(271,288):
        for x in range(539,559):
            r,g,b=rgb[(1280*y+x)*3:(1280*y+x)*3+3]
            if r>145 and g>150 and b>145:
                digits.append((x,y))
    return dict(top_y=top, left_x=min(rows[285],default=0), right_x=edge(289),
                card_join_y=join, slope_dx=edge(286)-edge(270),
                digit_x=round(median(x for x,_ in digits),2) if digits else None,
                digit_y=round(median(y for _,y in digits),2) if digits else None)


def compare_frames(run):
    folder=run/'reference-review'
    sources=json.loads((folder/'frames.json').read_text())
    groups=Counter((f['source'],f['role']) for f in sources)
    if groups != {(author,role):2 for author in ('S26lUv598_o','dv9axuULtdA') for role in ('calibration','validation')}:
        raise ValueError('Expected two calibration frames and two reserved frames per recording')
    scores=[]
    outlines=[]
    observations={}
    for platform in ('Web','Android TV'):
        for height in (720,1080):
            samples=run/'menu-evidence'/platform/str(height)
            masks=[]
            for version in ('previous','current'):
                for suffix in ('','-repeat'):
                    bitmap=grid(samples/version/('system-menu'+suffix+'.png'))
                    masks.append(mask(bitmap,REGION,COLOR))
                    if not suffix:
                        outlines.append(dict(image=f'{platform}-{height}-{version}', **geometry(bitmap)))
            observations[platform,height]=masks
    for frame in sources:
        with (folder/frame['raw']).open('rb') as raw:
            if hashlib.file_digest(raw,'sha256').hexdigest() != frame['sha256']:
                raise ValueError(f"Reference digest mismatch for {frame['raw']}")
        path=folder/frame['aligned']
        bitmap=grid(path)
        target=mask(bitmap,REGION,COLOR)
        outlines.append(dict(image=path.name, **geometry(bitmap)))
        for (platform,height),masks in observations.items():
            old,old_repeat,new,new_repeat=(overlap(target,m) for m in masks)
            noise=max(abs(old-old_repeat),abs(new-new_repeat))
            improve=frame['source']=='dv9axuULtdA' and height==720
            scores.append(dict(source=frame['source'],seconds=frame['seconds'],role=frame['role'],
                platform=platform,height=height,previous_iou=round(old,6),current_iou=round(new,6),
                noise=round(noise,6),passed=new-old>noise if improve else new-old>=-noise))
    for name,rows in [('menu-frames.csv',scores),('tab-geometry.csv',outlines)]:
        with (folder/name).open('w',newline='') as file:
            writer=csv.DictWriter(file,fieldnames=rows[0])
            writer.writeheader()
            writer.writerows(rows)
    return scores


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run',type=Path,help='extracted run directory with reference-review and menu-evidence')
    scores=compare_frames(parser.parse_args().run)
    failed=[r for r in scores if r['role']=='validation' and not r['passed']]
    if failed:
        raise SystemExit(f'Failed reserved comparisons: {failed}')
    print(f'{len(scores)} frame comparisons, all reserved comparisons passed')
