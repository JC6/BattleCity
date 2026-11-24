"""Measure the complete in-game ending against the Switch mix, preserving overlapping voices."""
import argparse
import csv
import math
from pathlib import Path
import statistics
import subprocess

from compare_switch_audio import fft
from switch_cues import spectrum, hann, pcm, RATE, HOP


def note_events(trace):
    events=list(csv.DictReader(trace.open()))
    notes=[]
    low={}
    for e in events:
        if not e['event'].startswith('apu-'):
            continue
        address=int(e['event'][4:],16)
        if address%4==2:
            low[address]=int(e['value'])
        elif address%4==3 and address-1 in low:
            period=low[address-1]+((int(e['value'])&7)<<8)
            channel={0x4003:'pulse1',0x4007:'pulse2',0x400b:'triangle'}[address]
            hz=1789772.727/((32 if channel=='triangle' else 16)*(period+1))
            notes.append((int(e['frame']),float(e['emu_s']),channel,hz))
    return events,notes


def centered_frames(values,n):
    windows=[]
    for i in range(0,len(values)-n+1,HOP):
        window=values[i:i+n]
        mean=sum(window)/n
        windows.append(spectrum([v-mean for v in window],n))
    return windows


def alignment(reference, switch, start, stop, candidates):
    def score(offset):
        return statistics.mean(sum(x*y for x,y in zip(reference[i][0],switch[i+offset][0]))
                               for i in range(start,stop))
    return max((score(i),i) for i in candidates)


def peaks(samples):
    # Zero padding refines peak placement. Actual resolution is set by the 64 ms window.
    n=512
    mean=sum(samples)/len(samples)
    magnitudes=[abs(z) for z in fft([(s-mean)*w for s,w in zip(samples,hann(n))]+[0]*(2048-n))[:1024]]
    floor=max(magnitudes)*.045
    return [(i*RATE/2048,magnitudes[i]) for i in range(2,1023)
            if magnitudes[i]>floor and magnitudes[i-1]<magnitudes[i]>=magnitudes[i+1]]


def envelope(path, sources, notes):
    # The two pulse voices share a pitch in the last chord. Report power in
    # the mix at each distinct fundamental rather than assigning it to a voice.
    last = max(frame for frame,_,_,_ in notes)
    pitches = sorted({round(hz,1) for frame,_,_,hz in notes if frame==last})
    length = round(.04*RATE)
    weights = hann(length)
    kernels = [[complex(math.cos(2*math.pi*hz*n/RATE),-math.sin(2*math.pi*hz*n/RATE))*weights[n]
                for n in range(length)] for hz in pitches]
    with path.open('w',newline='') as file:
        writer = csv.writer(file)
        writer.writerow(('source','center_s','rms',*(f'level_{hz}Hz' for hz in pitches)))
        for source,recording,offset in sources:
            samples = pcm(recording,offset,2.0)
            for center in range(1100,1801,10):
                pos = round(RATE*center/1000)-length//2
                window = samples[pos:pos+length]
                mean = sum(window)/length
                rms = statistics.pstdev(window)
                amps = [2*abs(sum((v-mean)*k for v,k in zip(window,kernel)))/sum(weights) for kernel in kernels]
                writer.writerow((source,center/1000,round(rms,2),*(round(a,2) for a in amps)))


def compare(video, trace, wave, out, search=(132.85,133.90)):
    left,right = search
    if not 0 <= left < right:
        raise ValueError("expected increasing source times in seconds")
    events, notes=note_events(trace)
    start=notes[0][1]
    # Native WAV sample 0 is machine boot. Locate the first audible sample close to
    # the first APU write, independently of the uploaded video's capture origin.
    snippet=pcm(wave,start-.05,.18)
    baseline=statistics.median(snippet[:RATE//50])
    first=next(i for i,v in enumerate(snippet) if abs(v-baseline)>150)
    native_onset=start-.05+first/RATE
    length=1.48
    reference=centered_frames(pcm(wave,native_onset,length),256)
    captured=pcm(video,left,right-left+length+.10)
    switch=centered_frames(captured,256)
    if len(switch)<len(reference)+(right-left)*RATE/HOP or max(map(abs,captured))<150:
        raise ValueError('incomplete or silent Switch capture')
    offsets=range(1+round((right-left)*RATE/HOP))
    score,index=alignment(reference,switch,0,len(reference),offsets)
    onset=left+index*HOP/RATE
    evidence={}
    for name,a,b in [('first',0,len(reference)//3),('last-pitch-change',round(.82*RATE/HOP),round(1.11*RATE/HOP))]:
        value,ix=alignment(reference,switch,a,b,range(max(0,index-18),min(len(offsets),index+19)))
        evidence[name]=(left+ix*HOP/RATE,value)
    out.mkdir(parents=True,exist_ok=True)
    with (out/'alignment.csv').open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(('part','switch_aligned_start_s','spectral_cosine','native_onset_s'))
        writer.writerow(('whole',f'{onset:.3f}',f'{score:.3f}',f'{native_onset:.6f}'))
        for name,(time,cosine) in evidence.items():writer.writerow((name,f'{time:.3f}',f'{cosine:.3f}',f'{native_onset:.6f}'))
    flat_notes=sorted(set(frame for frame,_,_,_ in notes))
    with (out/'notes.csv').open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(('nes_frame','time_from_first_note_s','channel','timer_fundamental_hz',
           'frames_to_next_attack','switch_peak_near_fundamental_hz','second_harmonic_visible'))
        for frame,t,channel,hz in notes:
            dt=t-start
            idx=round((onset-left+dt+.013)*RATE)
            measured=peaks(captured[idx:idx+512])
            nearby=[h for h in measured if abs(math.log2(h[0]/hz))<.065]
            next_attack=next((k-frame for k in flat_notes if k>frame),'')
            peak=max(nearby,key=lambda pair:pair[1])[0] if nearby else None
            harmonic=any(abs(h-2*hz)<max(12,2*hz*.035) for h,_ in measured)
            writer.writerow((frame,round(dt,4),channel,round(hz,1),next_attack,round(peak,1) if peak else '',int(harmonic)))
    # Measure the audible tail using AC energy. The cartridge WAV has a
    # constant nonzero level during silence.
    with (out/'tail.csv').open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(('source','duration_to_quiet_s','quiet_threshold_fraction','window_ms'))
        for file,offset,name in ((wave,native_onset,'native'),(video,onset,'switch')):
            values=pcm(file,offset,2.0)
            levels=[statistics.pstdev(values[i:i+80]) for i in range(0,len(values)-79,80)]
            limit=max(levels)*.012
            quiet=next((i for i in range(120,len(levels)-9) if max(levels[i:i+10])<limit),None)
            writer.writerow((name,round(quiet*.01,3) if quiet is not None else '',.012,10))
    envelope(out/'envelope.csv',[('native',wave,native_onset),('switch',video,onset)],notes)
    for file,offset,name in ((wave,native_onset,'native'),(video,onset,'switch')):
        subprocess.run(['ffmpeg','-v','error','-y','-ss',str(offset-.12),'-i',str(file),'-t','1.96',
                        '-vn','-af','highpass=f=25','-ac','1','-ar','24000',str(out/(name+'.wav'))],check=True)
    print('whole, first third, last third',round(onset,3),evidence,'score',round(score,3))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('video','trace','wav','output'): parser.add_argument(key,type=Path)
    parser.add_argument("--search",type=float,nargs=2,metavar=("START","END"),default=(132.85,133.90))
    a=parser.parse_args()
    compare(a.video,a.trace,a.wav,a.output,a.search)
