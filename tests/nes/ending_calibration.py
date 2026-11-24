"""Compare the last tally sound, music onset and both pulse silence commands."""
import argparse
import csv
from pathlib import Path
import statistics

from switch_cues import pcm, spectrum, RATE, HOP
from ending_audio import centered_frames, alignment


def frames(samples):
    result=[]
    for i in range(0,len(samples)-127,HOP):
        block=samples[i:i+128]
        center=sum(block)/len(block)
        result.append(spectrum([x-center for x in block],128))
    return result


def locate(reference, audio, onset):
    # Find each short tally tick in the pre-music mix, including different tally counts.
    first=max(0,onset-19)
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
        w=csv.writer(f);w.writerow(['source','published_music_time','last_tick_time','last_tick_cosine','matching_ticks','paired_ticks','music_after_tick','quiet_after_music','quiet_after_tick'])
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
            peaks=locate(reference,path,onset)
            paired=[(t,s) for t,s in peaks if any(.135<=abs(t-other)<=.165 for other,_ in peaks)]
            # An isolated peak in a commentary mix cannot establish the offset.
            if paired:
                tick,confidence=paired[-1]
                if name=='native':assert abs(tick-(last_tally+attack/RATE))<.012
                w.writerow([name,round(origin+onset,4),round(origin+tick,4),round(confidence,4),len(peaks),len(paired),round(onset-tick,4),quiet,round(onset-tick+quiet,4)])
            else:w.writerow([name,round(origin+onset,4),'','',len(peaks),0,'',quiet,''])


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('trace','wav','research','out'):p.add_argument(name,type=Path)
    a=p.parse_args();measure(a.trace,a.wav,a.research,a.out)
