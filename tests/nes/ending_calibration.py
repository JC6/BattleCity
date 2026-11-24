"""Compare the last tally sound, music onset and both pulse silence commands."""
import argparse
import csv
import hashlib
from pathlib import Path
import statistics
import subprocess

from switch_cues import pcm, spectrum, RATE, HOP
from ending_audio import centered_frames, alignment


def frames(samples):
    result=[]
    for i in range(0,len(samples)-127,HOP):
        block=samples[i:i+128]
        center=sum(block)/len(block)
        result.append(spectrum([x-center for x in block],128))
    return result


def locate(reference, audio, onset, start):
    # Find each short tally tick in the pre-music mix, including different tally counts.
    first=max(0,start)
    measured=frames(pcm(audio,first,onset-first-.12))
    peaks=[]
    for i in range(len(measured)-len(reference)):
        shape=statistics.mean(sum(a*b for a,b in zip(x,measured[i+j][0])) for j,x in enumerate(reference))
        loud=statistics.mean(measured[i+j][1] for j in range(len(reference)))
        if shape>.78 and loud>60:peaks.append((shape,first+i*HOP/RATE))
    selected=[]
    for score,when in sorted(peaks,reverse=True):
        if all(abs(when-t)>.065 for t,_ in selected):selected.append((when,score))
    return sorted(selected)


# Crop the final kill count to the right of TOTAL. Coordinates refer to 384 × 216.
# The three excerpts end at stage 2 (0 kills), stage 1 (10), and stage 36 (0).
PICTURES = {
    'first': ('1c9360378d74fb8f49955193385ad375b9c780e1cb511a696a4795e8c377cac0', (168,159,12,8), 18,21.8,0),
    'english': ('a7c8bafb4572ed78669df2e4ebbd53a98116773e8c60b1faa812ea8f526a40e0',(162,159,18,8),18,23.7,10),
    'last': ('2077152006a652dd556a8e99e91f8c07d0cb0d69ceec93ce65cbe0ba6a3efa1a',(165,159,14,10),22,25.5,0),
}


def visible_total(video, name):
    digest,(x,y,w,h),start,reference,count=PICTURES[name]
    with video.open('rb') as f:
        if hashlib.file_digest(f,'sha256').hexdigest()!=digest:
            raise ValueError('Expected the calibrated '+name+' excerpt')
    pts=subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries',
                                 'frame=best_effort_timestamp_time','-of','csv=p=0',str(video)],text=True)
    times=[float(line.partition(',')[0]) for line in pts.splitlines() if line and line[0].isdigit()]
    raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(video),'-vf',
                                 f'scale=384:216,format=gray,crop={w}:{h}:{x}:{y}','-fps_mode','passthrough',
                                 '-threads','1','-pix_fmt','gray','-f','rawvideo','-'])
    assert len(raw)==len(times)*w*h
    masks=[bytes(v>108 for v in raw[i:i+w*h]) for i in range(0,len(raw),w*h)]
    template=masks[min(range(len(times)),key=lambda i:abs(times[i]-reference))]
    assert sum(template)>6
    accepted=[sum(a!=b for a,b in zip(m,template))<=2 for m in masks]
    onset=next(i for i,t in enumerate(times) if start<t<reference and all(accepted[i:i+3]))
    assert not accepted[onset-1] and not any(accepted[onset-10:onset])
    return times[onset],count,start


def measure(trace,wav,research,out):
    with trace.open() as f:events=list(csv.DictReader(f))
    last_tally=float(next(e['emu_s'] for e in reversed(events) if e['event']=='cue-19'))
    clip=pcm(wav,last_tally,.10)
    center=statistics.median(clip[:80])
    attack=next(i for i,x in enumerate(clip) if abs(x-center)>180)
    reference=[s for s,_ in frames(clip[attack:attack+round(.025*RATE)])]
    first_note=float(next(e['emu_s'] for e in events if e['event']=='apu-4003'))
    commands=[]
    for reg in ['apu-4000','apu-4004']:
        sequence=[e for e in events if e['event']==reg and float(e['emu_s'])>=first_note]
        last=next(i for i in reversed(range(len(sequence))) if int(sequence[i]['value'])!=16)
        mute=sequence[last+1]
        commands.append([reg,int(mute['frame']),float(mute['emu_s'])-first_note])
    out.mkdir(parents=True,exist_ok=True)
    with (out/'pulse-mute.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['control','nes_frame','seconds_after_first_timer']);w.writerows(commands)
    with (out/'tally-alignment.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['source','music_s','total_visible_s','music_after_total_s','last_count_tick_s','last_tick_cosine','quiet_after_music_s','quiet_after_total_s'])
        with (research/'ending-first/alignment.csv').open() as f:
            native_onset=float(next(csv.DictReader(f))['native_onset_s'])
        native_music=centered_frames(pcm(wav,native_onset,1.48),256)
        for name,path,origin,guess in [('native',wav,0,native_onset),('ending-first',out/'first-ending.m4a',428,451.665),
                                 ('ending-english',out/'english-ending.m4a',625,650.105),('ending-last',out/'last-ending.m4a',2587,2614.0)]:
            folder=research/('ending-first' if name=='native' else name)
            onset=guess-origin
            if name!='native':
                left=onset-.4
                encoded=centered_frames(pcm(path,left,1.48+.8),256)
                similarity,best=alignment(native_music,encoded,0,len(native_music),range(len(encoded)-len(native_music)+1))
                if similarity<.65:raise ValueError('music anchor not found in '+name)
                onset=left+best*HOP/RATE
            with (folder/'tail.csv').open() as a:quiet=float(next(r['duration_to_quiet_s'] for r in csv.DictReader(a) if r['source']==('native' if name=='native' else 'switch')))
            if name=='native':
                native_trace=out/'tally-native/events.csv'
                with native_trace.open() as stream:
                    total=float(next(e['emu_s'] for e in csv.DictReader(stream) if e['event']=='score-total-ink' and int(e['value'])>6))
                count=len([e for e in events if e['event']=='cue-19'])
                start=float(next(e['emu_s'] for e in events if e['event']=='tally'))
            else:
                label=name.removeprefix('ending-')
                total,count,start=visible_total(out/(label+'-tally.mp4'),label)
            tick=confidence=''
            if count:
                peaks=locate(reference,path,total,start)
                paired=[(t,s) for t,s in peaks if any(.135<=abs(t-other)<=.165 for other,_ in peaks)]
                if paired:
                    tick,confidence=paired[-1]
                    if name=='native':assert abs(tick-(last_tally+attack/RATE))<.012
                    tick,confidence=round(origin+tick,4),round(confidence,4)
            w.writerow([name,round(origin+onset,4),round(origin+total,4),round(onset-total,4),
                        tick,confidence,quiet,round(onset-total+quiet,4)])


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('trace','wav','research','out'):p.add_argument(name,type=Path)
    a=p.parse_args();measure(a.trace,a.wav,a.research,a.out)
