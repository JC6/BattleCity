"""Compare visible events in the 5:18–11:19 English recording with isolated cartridge sounds."""
import argparse
import csv
from array import array
from functools import lru_cache
import math
from pathlib import Path
import statistics
import subprocess
import sys

from compare_switch_audio import fft

# Times in the cached video are relative to 5:18. Short search ranges account for
# capture and audio offsets. Overlapping tank motors remain part of the video mix.
EVENTS = (
    ('shot', 33.0, 36.8, 3.00, .105, 128),
    ('player-explosion', 123.0, 124.6, 5.98, .44, 128),
    ('tally', 102.25, 102.83, 8.98, .025, 64),
    ('game-over', 132.85, 133.90, 11.97, 1.24, 256),
)
RATE=8000
HOP=40


def pcm(path, start, seconds):
    command=['ffmpeg','-v','error','-ss',str(start),'-i',str(path),'-t',str(seconds),
             '-vn','-ac','1','-ar',str(RATE),'-f','s16le','-']
    values=array('h',subprocess.check_output(command))
    if sys.byteorder!='little':
        values.byteswap()
    return values


@lru_cache
def hann(n):
    return [.5-.5*math.cos(2*math.pi*i/(n-1)) for i in range(n)]


def spectrum(samples, n):
    bands=[abs(v) for v in fft([a*b for a,b in zip(samples,hann(n))])[1:n//2]]
    norm=math.sqrt(sum(v*v for v in bands))
    rms=math.sqrt(sum(v*v for v in samples)/n)
    return [v/norm if norm else 0 for v in bands],rms


def frames(values,n):
    return [spectrum(values[i:i+n],n) for i in range(0,len(values)-n+1,HOP)]


def compare(video,native):
    for name,left,right,native_start,duration,n in EVENTS:
        values=pcm(native,native_start,duration+.12)
        onset=next((i for i in range(0,len(values)-8,8) if max(map(abs,values[i:i+8]))>150),None)
        if onset is None or len(values)-onset<round(RATE*duration):
            raise ValueError('missing native cue: '+name)
        ref=frames(values[onset:onset+round(RATE*duration)],n)
        stream=frames(pcm(video,left,right-left+duration),n)
        if len(stream)<len(ref) or not any(level>10 for _,level in stream):
            raise ValueError('missing Switch audio in '+name+' window')
        def similarity(i):
            return statistics.mean(sum(a*b for a,b in zip(frame[0],stream[i+j][0])) for j,frame in enumerate(ref))
        score,index=max((similarity(i),i) for i in range(len(stream)-len(ref)+1))
        matched=stream[index:index+len(ref)]
        def energy(shape):
            peak=max(frame[1] for frame in shape)
            return [frame[1]/peak if peak else 0 for frame in shape]
        envelope=statistics.mean(abs(a-b) for a,b in zip(energy(ref),energy(matched)))
        def peak_band(s):
            return max(range(len(s)),key=s.__getitem__)
        peak_delta=statistics.median(abs(peak_band(a[0])-peak_band(b[0]))*RATE/n for a,b in zip(ref,matched))
        yield (name,round(left+index*HOP/RATE,3),round(native_start+onset/RATE,3),duration,len(ref),
               round(score,3),round(envelope,3),round(peak_delta,1))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('switch_clip',type=Path)
    parser.add_argument('native_wav',type=Path)
    args=parser.parse_args()
    writer=csv.writer(sys.stdout)
    writer.writerow(('cue','switch_clip_s','native_s','window_s','windows','mean_spectral_cosine',
                     'normalized_envelope_mae','median_peak_band_difference_hz'))
    writer.writerows(compare(args.switch_clip,args.native_wav))
