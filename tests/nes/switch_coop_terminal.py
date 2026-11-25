"""Measure the two-player stage 42 terminal sequence in the English Switch TV recording."""
import argparse
import csv
import hashlib
import json
import subprocess
from fractions import Fraction
from pathlib import Path


def analyze(clip, trace, dest):
    with clip.open('rb') as f:
        digest=hashlib.file_digest(f,'sha256').hexdigest()
    if digest!=EXCERPT:
        raise ValueError('Expected the calibrated 720p Abuelos Gamers stage 42 excerpt')
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','stream=width,height,avg_frame_rate','-of','json',str(clip)]))['streams'][0]
    assert (probe['width'],probe['height'])==(1280,720)
    rate=Fraction(probe['avg_frame_rate'])
    start=3069
    raw=subprocess.check_output(['ffmpeg','-v','error','-threads','1','-ss',str(start-2846.72),
        '-i',str(clip),'-t','16','-vf','scale=320:180:flags=area','-pix_fmt','rgb24','-threads','1','-f','rawvideo','-'])
    pitch=320*180*3
    assert len(raw)%pitch==0 and rate>0
    frames=[memoryview(raw)[i:i+pitch] for i in range(0,len(raw),pitch)]
    def mask(frame,rect,red=False):
        left,top,right,bottom=rect
        points=set()
        for y in range(top,bottom):
            for x in range(left,right):
                i=(y*320+x)*3
                r,g,b=frame[i:i+3]
                lit=r>100 and r>g*1.35 and r>b*1.35 if red else min(r,g,b)>155
                if lit: points.add(i)
        return points
    def reference(t,rect,red=False):
        pts=mask(frames[round((t-start)*rate)],rect,red)
        assert len(pts)>10
        return pts
    # Regions avoid the TV bezel, reflections, and the scrolling collection footer.
    samples=[('both-totals',3074,(145,120,154,126),False),('right-total',3074,(181,119,190,126),False),
             ('game-over',3076,(114,48,210,102),True),('title-menu',3084,(130,88,209,117),False)]
    times={}
    for name,t,rect,red in samples:
        target=reference(t,rect,red)
        # Two consecutive frames avoid a camera scan line independently triggering an event.
        prev=False
        for n,frame in enumerate(frames):
            observed=mask(frame,rect,red)
            matches=len(observed & target)/len(observed | target)>.76
            if matches and prev:
                times[name]=start+float((n-1)/rate)
                break
            prev=matches
        if name not in times: raise ValueError(name)
    times['both-totals']=max(times.pop('right-total'),times['both-totals'])
    assert times['both-totals']<times['game-over']<times['title-menu']
    with trace.open() as f:events=list(csv.DictReader(f))
    assert [int(r['value']) for r in events if r['event']=='mode']==[1,4,7,0]
    assert any(r['event']=='two-player-title' and r['value']=='15000/68100/45800' for r in events)
    total=next(float(r['emu_s']) for r in events if r['event']=='score-total-ink' and int(r['value'])>0)
    word=next(float(r['emu_s']) for r in events if r['event']=='word-ink' and int(r['value'])>10)
    dest.mkdir(parents=True,exist_ok=True)
    with (dest/'coop-stage42.csv').open('w',newline='') as f:
        writer=csv.writer(f)
        writer.writerow(('clip_sha256','source_fps','both_totals_s','game_over_s','title_menu_s','switch_total_to_over_s','replica_total_to_over_s','difference_s'))
        observed=times['game-over']-times['both-totals']
        writer.writerow((digest,str(rate),*(round(times[k],6) for k in ('both-totals','game-over','title-menu')),round(observed,6),round(word-total,6),round(observed-(word-total),6)))
    return times


EXCERPT='777f691f0bdf0731c6ba043e101511908bb77444b762478f0f91c05851c1962d'
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('clip','trace','output'):parser.add_argument(name,type=Path)
    args=parser.parse_args()
    print(analyze(args.clip,args.trace,args.output))
