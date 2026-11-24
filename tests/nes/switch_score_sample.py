"""Compare recorded high-score glyphs, using the English HISCORE, 8 and 0 as calibration anchors."""
import argparse
import csv
import hashlib
from pathlib import Path
import subprocess
from typing import NamedTuple

from switch_lettering import WORDS, cartridge_tables, compiled_cells


class ScoreCapture(NamedTuple):
    sha: str
    width: int
    height: int
    score: str
    clip_start: int
    samples: tuple
    header: tuple
    digits: tuple
    pitch: tuple
    crop: str


CAPTURES={
    'commentary':ScoreCapture('0ffff2e4e93139287afc0193ed7adb1bc14e013f88a814feb662463e168f0238',
        1920,1080,'26800',796,(4.4,6.2,8.4),(509.7,191.9),(767,377.7),(16.08,14.29),'932:310:496:180'),
    'famicom-one':ScoreCapture('03bfb68ba6472d2b1c6f8eb6de4cb2af9a1c0f7cf468b43d6dbb1ef7268c49b0',
        640,480,'196500',2262,(20.4,21.0,22.6),(40,104),(120,208),(10,8),'580:182:29:91'),
    'famicom-two':ScoreCapture('fa3a6858ddb2a4fd257814197893b0984f52625621f364d1fcd0445642f13dd1',
        960,720,'441900',4104,(23.5,24.0,26.2),(133.3,150),(232.2,311),(12.36,12.32),'728:276:122:136'),
}


def observed_cells(gray, width, left, top, pitch, columns):
    sx,sy=pitch
    means=[]
    for y in range(7):
        for x in range(columns):
            px,py=left+sx*x,top+sy*y
            values=[gray[v*width+u] for v in range(round(py+.07*sy),round(py+.91*sy))
                    for u in range(round(px+.06*sx),round(px+.93*sx))]
            means.append(sum(values)/len(values))
    if max(means)<20:
        raise ValueError('blank or uncalibrated score frame')
    return bytes(m>max(means)*.28 for m in means)


def verify(video,rom,labels,out,recording):
    source=CAPTURES[recording]
    with video.open('rb') as f:
        assert hashlib.file_digest(f,'sha256').hexdigest()==source.sha, 'calibrated source excerpt required'
    out.mkdir(parents=True,exist_ok=True)
    tables=cartridge_tables(rom.read_bytes(),labels.read_text())
    english={name:h for name,_,_,_,_,h in WORDS}
    with (out/'digits.csv').open('w',newline='') as f:
        writer=csv.writer(f)
        writer.writerow(('source_seconds','field','position','cells','mismatches','mask_sha256','english_capture_anchor'))
        for seconds in source.samples:
            gray=subprocess.check_output(['ffmpeg','-v','error','-ss',str(seconds),'-i',str(video),'-frames:v','1','-threads','1',
                                          '-pix_fmt','gray','-f','rawvideo','-'])
            assert len(gray)==source.width*source.height
            fields=[('HISCORE',0,*source.header,56,288,28,4)]
            left,top=source.digits
            fields.extend((d,i+1,left+source.pitch[0]*8*i,top,8,400+4*int(d),40,0) for i,d in enumerate(source.score))
            for name,pos,left,top,columns,start,stride,dy in fields:
                mask=observed_cells(gray,source.width,left,top,source.pitch,columns)
                expected=compiled_cells(*tables,start,stride,0,dy,columns)
                errors=sum(a!=b for a,b in zip(mask,expected))
                digest=hashlib.sha256(mask).hexdigest()
                writer.writerow((source.clip_start+seconds,name,pos,len(mask),errors,digest,int(name in english)))
                if name in english: assert digest==english[name], (name,'English calibration disagrees')
                assert errors==0, (seconds,name,errors)
    subprocess.run(['ffmpeg','-v','error','-y','-ss',str(source.samples[1]),'-i',str(video),'-vf',
                    f'crop={source.crop},scale=652:-1','-frames:v','1','-threads','1',str(out/'score.png')],check=True)
    print(recording,source.score,'matches compiled brick cells and available English calibration masks at three capture times')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for n in ('video','rom','labels','out'): parser.add_argument(n,type=Path)
    parser.add_argument('--recording',choices=CAPTURES,default='commentary')
    args=parser.parse_args()
    verify(args.video,args.rom,args.labels,args.out,args.recording)
