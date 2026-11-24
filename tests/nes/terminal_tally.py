"""Measure TOTAL and GAME OVER from screen pixels, then place the mixed audio on that timeline."""
import argparse
import csv
import json
import statistics
import subprocess
from pathlib import Path

from ending_audio import note_events
from ending_calibration import visible_total
from switch_cues import pcm, RATE

CAPTURES = [
    ('first', 'S26lUv598_o', 428, 24.25),
    ('last', 'Xf02flMP7dc', 2587, 27.10),
    ('english', 'S26lUv598_o', 625, 25.70),
]


def game_over_frame(video, reference):
    # The rectangle covers the letters in both original video layouts.
    w, h = 74, 43
    size = w*h*3
    probe = subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','frame=best_effort_timestamp_time','-of','json',str(video)])
    times = [float(f['best_effort_timestamp_time']) for f in json.loads(probe)['frames']]
    raw = subprocess.check_output(['ffmpeg','-v','error','-i',str(video),'-vf',
        'scale=192:108,crop=74:43:58:29','-fps_mode','passthrough','-pix_fmt','rgb24',
        '-threads','1','-f','rawvideo','-'])
    if len(raw) != len(times)*size:
        raise ValueError('frame count does not match its timestamp table')

    def mask(i):
        frame = raw[i*size:(i+1)*size]
        return {i for i,(r,g,b) in enumerate(zip(frame[::3],frame[1::3],frame[2::3]))
                if r>44 and r>g*1.16 and r>b*1.35}

    template = mask(min(range(len(times)),key=lambda i:abs(times[i]-reference)))
    assert len(template)>500
    similarity = {}
    for i,t in enumerate(times):
        if reference-3 <= t <= reference+.5:
            frame=mask(i)
            similarity[i]=len(template & frame)/len(template | frame)
    hits = [i for i in similarity if all(similarity.get(i+j,0)>.80 for j in range(3))]
    i=hits[0]
    if similarity.get(i-1,0)>.20:
        raise ValueError('ambiguous GAME OVER transition')
    return times[i],times[i]-times[i-1],similarity[i]


def build(research, audio, output):
    with (research/'surface-research/tally-alignment.csv').open() as file:
        mixed={row['source']:row for row in csv.DictReader(file)}
    records=[]
    for name,video_id,origin,reference in CAPTURES:
        file=research/'surface-research'/(name+'-tally.mp4')
        total,count,_=visible_total(file,name)
        word,period,similarity=game_over_frame(file,reference)
        row=mixed['ending-'+name]
        music=float(row['music_s'])-origin
        records.append(dict(source=name, count=count, split='holdout' if name=='english' else 'calibration',
            url='https://www.youtube.com/watch?v='+video_id+'&t='+str(round(origin+word)),
            total=origin+total,game_over=origin+word,music=origin+music,quiet=origin+music+float(row['quiet_after_music_s']),
            last_tick=row['last_count_tick_s'],frame_period=period,word_iou=similarity))
    for version in ('old','new'):
        for name,count in [('zero-base',0),('zero-lives',0),('ten-base',10)]:
            path=audio/(version+'-'+name)
            events,notes=note_events(path/'events.csv')
            def visible(key):
                return next(float(e['emu_s']) for e in events if e['event']==key and int(e['value'])>6)
            total,word=visible('score-total-ink'),visible('word-ink')
            wave=path/'game.wav'
            anchor=notes[0][1]
            snippet=pcm(wave,anchor-.05,.18)
            level=statistics.median(snippet[:RATE//50])
            onset=anchor-.05+next(i for i,v in enumerate(snippet) if abs(v-level)>150)/RATE
            # Use the same ten consecutive 10 ms silent window criterion as the original measurements.
            from ending_audio import quiet_time
            sample=pcm(wave,onset,2)
            quiet=quiet_time(sample)
            ticks=[float(e['emu_s']) for e in events if e['event']=='cue-19']
            records.append(dict(source=version+'-'+name,count=count,split='native',url='',total=total,
                game_over=word,music=onset,quiet=onset+quiet,last_tick=ticks[-1] if ticks else '',
                frame_period=1/60.1,word_iou=''))
    for row in records:
        row.update(total_to_word=row['game_over']-row['total'],word_to_music=row['music']-row['game_over'],
                   music_to_quiet=row['quiet']-row['music'])
    original={r['source']:r for r in records}
    for source,condition in [('first','zero-base'),('last','zero-base'),('english','ten-base')]:
        direct=original[source]
        before,after=[original[v+'-'+condition] for v in ('old','new')]
        assert abs(direct['total_to_word']-after['total_to_word'])<=direct['frame_period']+.001
        assert abs(direct['total_to_word']-before['total_to_word'])>direct['frame_period']
    with output.open('w',newline='') as dest:
        writer=csv.DictWriter(dest,fieldnames=records[0])
        writer.writeheader()
        for r in records:writer.writerow({k:round(v,6) if isinstance(v,float) else v for k,v in r.items()})


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for param in ('research','audio','output'):parser.add_argument(param,type=Path)
    args=parser.parse_args()
    build(args.research,args.audio,args.output)
