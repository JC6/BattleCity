"""Compare the ending music with an audible/visible tally tick from the same multiplexed Switch clip."""
import argparse
import csv
import hashlib
import json
import statistics
import subprocess
from pathlib import Path

from ending_audio import centered_frames, alignment, note_events, quiet_time
from ending_calibration import frames
from switch_cues import HOP, RATE, pcm
from terminal_tally import CAPTURES, game_over_frame

# x, y, w, h cover only the final number drawn next to the enemy, before its TOTAL.
# The stage 35 score immediately precedes stage 36 in the original longplay.
ROWS = {
    'english': ('count-ten',10,(161,87,16,9),21.5,18.0,22.0),
    'last': ('count-six',6,(163,144,13,10),11.9,7.0,13.0),
    'review-ending': ('count-thirteen',13,(155,84,20,10),19.0,14.5,21.0),
    'montage-ending': ('count-fifteen',15,(155,84,20,10),19.0,13.0,20.7),
}


def final_count_frame(video, rect, reference, start, end):
    x,y,w,h=rect
    times=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','frame=best_effort_timestamp_time','-of','json',str(video)]))
    pts=[float(frame['best_effort_timestamp_time']) for frame in times['frames']]
    raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(video),'-vf',
        f'scale=384:216,format=gray,crop={w}:{h}:{x}:{y}','-fps_mode','passthrough',
        '-pix_fmt','gray','-threads','1','-f','rawvideo','-'])
    assert len(raw)==len(pts)*w*h
    masks=[{j for j,b in enumerate(raw[i:i+w*h]) if b>118} for i in range(0,len(raw),w*h)]
    template=masks[min(range(len(pts)),key=lambda i:abs(pts[i]-reference))]
    assert len(template)>15
    indexes=[i for i,t in enumerate(pts) if start<t<end and
             len(masks[i]&template)/len(masks[i]|template)>.85]
    assert len(indexes)>=15 and indexes==list(range(indexes[0],indexes[-1]+1))
    return pts[indexes[0]]


def calibration(audio, video, config):
    route,count,rect,anchor,start,end=config
    path=audio/route
    events,notes=note_events(path/'events.csv')
    cue=float([r for r in events if r['event']=='cue-19'][-1]['emu_s'])
    snippet=pcm(path/'game.wav',cue,.1)
    dc=statistics.median(snippet[:80])
    attack=next(i for i,v in enumerate(snippet) if abs(v-dc)>180)
    visual=next(float(r['emu_s']) for r in events if r['event']=='count-mask' and float(r['emu_s'])>=cue)
    reference=[s for s,_ in frames(snippet[attack:attack+round(.025*RATE)])]
    clocks=frames(pcm(video,start,end-start))
    scores=[statistics.mean(sum(a*b for a,b in zip(s,clocks[i+j][0])) for j,s in enumerate(reference))
            for i in range(len(clocks)-len(reference))]
    ink=final_count_frame(video,rect,anchor,start,end)
    # Search an entire count sequence. The original supplies nine VBlanks between ticks.
    # Leave at least one full quiet interval to either side of the last tick when comparing aliases.
    def train(index):
        hits=[scores[index-round(j*.15*RATE/HOP)] for j in range(count)]
        return statistics.mean(hits),hits
    candidates=[i for i in range(len(scores)) if abs(start+i*HOP/RATE-ink)<.6 and
                i>=round((count-1)*.15*RATE/HOP)]
    best=max(candidates,key=lambda i:train(i)[0])
    quality,hits=train(best)
    alternatives=[train(i)[0] for i in candidates if abs(i-best)*HOP/RATE>.07]
    assert quality>.67 and quality>max(alternatives), (quality,max(alternatives))
    tick=start+best*HOP/RATE
    return {'count':count,'last_visible':ink,'last_audible':tick,'native_tick_minus_digit':cue+attack/RATE-visual,
            'retail_tick_minus_digit':tick-ink,'sequence_cosine':quality,'alternative_cosine':max(alternatives),
            'per_tick_cosine':' '.join(f'{value:.3f}' for value in reversed(hits))}


def build(root):
    with (root/'terminal-tally.csv').open() as f:native=next(r for r in csv.DictReader(f) if r['source']=='new-zero-base')
    music=centered_frames(pcm(root/'audio/new-zero-base/game.wav',float(native['music']),1.48),256)
    records=[]
    cases=[(n,v,o,t,n+'-mixed.mp4') for n,v,o,t in CAPTURES]
    cases.extend([('review-ending','uc_If5fksfA',250,22.8,'review-ending.mp4'),
                  ('montage-ending','hlJ4skgnFko',287,22.8,'montage-ending.mp4')])
    for name,video_id,origin,ref,filename in cases:
        file=root/'references'/filename
        metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=codec_type,start_time','-of','json',str(file)]))
        starts={r['codec_type']:float(r['start_time']) for r in metadata['streams']}
        assert set(starts)>={'audio','video'} and starts['audio']==0
        word,period,similarity=game_over_frame(file,ref)
        start=word-.7
        block=centered_frames(pcm(file,start,3),256)
        quality,index=alignment(music,block,0,len(music),range(len(block)-len(music)+1))
        assert quality>.7
        onset=start+index*HOP/RATE
        row=dict(source=name,video_id=video_id,clip_origin=origin,sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                 video_pts0=starts['video'],audio_pts0=starts['audio'],word=word,music=onset,
                 raw_word_to_music=onset-word,music_cosine=quality,music_to_quiet=quiet_time(pcm(file,onset,2)),
                 word_iou=similarity,frame_period=period)
        if name in ('review-ending','montage-ending'):
            total=final_count_frame(file,(155,168,21,10),20.3,15,23)
            row['observed_total']=13 if name=='review-ending' else 17
            row['total']=total
            row['total_to_word']=word-total
            row['residual_vs_fixed_tally']=word-total-float(native['total_to_word'])
            assert abs(row['residual_vs_fixed_tally'])<=period+.001
        if name in ROWS:
            row.update(calibration(root/'audio',file,ROWS[name]))
            row['adjusted_word_to_music']=onset-word-row['retail_tick_minus_digit']+row['native_tick_minus_digit']
            row['residual_vs_native']=row['adjusted_word_to_music']-float(native['word_to_music'])
        records.append(row)
    fields=list(dict.fromkeys(key for row in records for key in row))
    with (root/'terminal-av-sync.csv').open('w',newline='') as out:
        w=csv.DictWriter(out,fields);w.writeheader()
        for r in records:w.writerow({k:round(v,6) if isinstance(v,float) else v for k,v in r.items()})


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('measurements',type=Path)
    build(parser.parse_args().measurements)
