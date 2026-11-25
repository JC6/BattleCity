"""Run the local ending through the audio formats measured in the Switch clips."""
import argparse
import csv
import json
from pathlib import Path
import statistics
import subprocess
from tempfile import TemporaryDirectory

from ending_audio import centered_frames
from switch_cues import HOP, RATE, pcm


def tail(samples, fraction):
    levels = [statistics.pstdev(samples[i:i+80]) for i in range(0,len(samples)-79,80)]
    limit = max(levels)*fraction
    return next((i/100 for i in range(120,len(levels)-9) if max(levels[i:i+10])<limit), None)


def measure(baseline, output):
    with (baseline/'terminal-tally.csv').open() as f:
        onset = float(next(row['music'] for row in csv.DictReader(f) if row['source']=='new-zero-base'))
    with (baseline/'terminal-av-sync.csv').open() as f:
        sources = list(csv.DictReader(f))
    recording = baseline/'audio/new-zero-base/game.wav'
    rows = []
    with TemporaryDirectory() as tmp:
        encoded = Path(tmp)/'control.m4a'
        ac_recording = Path(tmp)/'ac-control.wav'
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(recording),'-af','highpass=f=25',
                        '-c:a','pcm_s24le',str(ac_recording)],check=True)
        controls=[(name,file,pcm(file,onset,2)) for name,file in [('direct',recording),('25Hz',ac_recording)]]
        for row in sources:
            name=row['source']
            video=baseline/'references'/(name+('.mp4' if name.endswith('-ending') else '-mixed.mp4'))
            cmd=['ffprobe','-v','error','-select_streams','a:0','-show_entries',
                 'stream=codec_name,sample_rate,channels,bit_rate','-of','json',str(video)]
            stream=json.loads(subprocess.check_output(cmd))['streams'][0]
            if stream['codec_name']!='aac':
                raise ValueError('Uncalibrated codec '+stream['codec_name'])
            captured=pcm(video,float(row['music']),2)
            for control_name,control_file,samples in controls:
                reference=centered_frames(samples,256)
                subprocess.run(['ffmpeg','-v','error','-y','-ss',str(onset-.25),'-i',str(control_file),
                                '-t','2.55','-c:a','aac','-b:a',stream['bit_rate'],'-ar',stream['sample_rate'],
                                '-ac',str(stream['channels']),str(encoded)],check=True)
                data=pcm(encoded,0,2.5)
                control=centered_frames(data,256)
                # Silence has no spectrum to correlate. Locate the cue using only
                # active notes, with a 75 ms allowance on each side of the trim point.
                level=max(r[1] for r in reference[:180])*.1
                active=[j for j in range(180) if reference[j][1]>level]
                assert len(active)>50
                def match(i):
                    return statistics.mean(sum(x*y for x,y in zip(reference[j][0],control[i+j][0])) for j in active)
                cosine,index=max((match(i),i) for i in range(35,66))
                assert cosine>.93 and abs(index*HOP/RATE-.25)<=.025, (name,cosine,index)
                offset=index*HOP
                for threshold in (.006,.012,.024,.05):
                    rows.append(dict(source=name,control=control_name,rate=stream['sample_rate'],bitrate=stream['bit_rate'],
                           channels=stream['channels'],threshold=threshold,onset_cosine=round(cosine,4),
                           lossless=tail(samples,threshold),encoded=tail(data[offset:offset+2*RATE],threshold),
                           switch_video=tail(captured,threshold)))
    with output.open('w',newline='') as f:
        writer=csv.DictWriter(f,rows[0]);writer.writeheader();writer.writerows(rows)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    measure(args.baseline,args.output)
