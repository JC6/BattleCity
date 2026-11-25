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
    photographed: bool = False


CAPTURES={
    'english-switch-crolister':ScoreCapture('20bc479997d6270b908e425de7b1538542229bab70757c00619f0cc411378da2',
        1280,720,'185900',2574,(43.35,44.3,46.2),(243.47,133.1),(356.52,291.6),(14.13,12.2),'798:262:248:125'),
    'english-switch-abuelos':ScoreCapture('af33db31fb538e663887929e9685d7d8f2b1a440b9a1b585d86d817a0df50fbe',
        1280,720,'68100',1280,(24,26,28),(0,0),(16,13),(1,1),'665:225:320:140',True),
    'commentary':ScoreCapture('0ffff2e4e93139287afc0193ed7adb1bc14e013f88a814feb662463e168f0238',
        1920,1080,'26800',796,(4.4,6.2,8.4),(509.7,191.9),(767,377.7),(16.08,14.29),'932:310:496:180'),
    'famicom-one':ScoreCapture('03bfb68ba6472d2b1c6f8eb6de4cb2af9a1c0f7cf468b43d6dbb1ef7268c49b0',
        640,480,'196500',2262,(20.4,21.0,22.6),(40,104),(120,208),(10,8),'580:182:29:91'),
    'famicom-two':ScoreCapture('fa3a6858ddb2a4fd257814197893b0984f52625621f364d1fcd0445642f13dd1',
        960,720,'441900',4104,(23.5,24.0,26.2),(133.3,150),(232.2,311),(12.36,12.32),'728:276:122:136'),
    'archives-ps4':ScoreCapture('54601c89c63136f43f110a5c9993d53a3d70c1bd995b800aca2faf6a29ba558c',
        640,360,'430200',3710,(115,116.6,120),(110,70),(170,154),(7.5,6.45),'440:146:101:61'),
    'famicom-guide':ScoreCapture('d0920a0e8d9ff00af673a691415ddd8d56db634d3238d8f29837cee9bda29445',
        640,360,'256700',1760,(7.4,9,12.2),(253.5,70),(305,154),(6.43,6.45),'385:146:241:61'),
}


def observed_cells(gray, width, left, top, pitch, columns, photographed=False):
    sx,sy=pitch
    means=[]
    for y in range(7):
        for x in range(columns):
            px,py=left+sx*x,top+sy*y
            if photographed:
                # The TV was filmed obliquely. The known H/I/E stroke edges give the
                # horizontal pitch at both sides and its change down the glass.
                u,v=px,py
                px=324.1+u*(11.82-.0057*u)+v*(-.13+.0101*u)
                py=153.0-(px-336)*.0055+v*9.85
                area=(round(px+2),round(py+2),round(px+9),round(py+8))
            else:
                area=(round(px+.06*sx),round(py+.07*sy),round(px+.93*sx),round(py+.91*sy))
            values=[gray[row*width+col] for row in range(area[1],area[3]) for col in range(area[0],area[2])]
            means.append(sum(values)/len(values))
    if max(means)<20:
        raise ValueError('blank or uncalibrated score frame')
    # Filming a TV raises black levels. Calibrate contrast inside the same glyph.
    threshold=(max(means)+min(means))/2 if photographed else max(means)*.28
    return bytes(m>threshold for m in means)


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
                mask=observed_cells(gray,source.width,left,top,source.pitch,columns,source.photographed)
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
