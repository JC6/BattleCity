"""Compare moving projectiles, shield phases and explosions with the English Switch capture."""
import argparse
import csv
import hashlib
from pathlib import Path
import subprocess

from switch_motion import FIELD, VIDEO_SHA, chr_square, crop, rgb_frames

# After a 30 s seek in the source clip. Each entry gives the first component's
# top-left corner and the measured displacement between 29.97 Hz capture frames.
TRACKS = [
    ('up', 143, 39, 134, 154, 0, -4, 440),
    ('right', 670, 33, 75, 7, 4, 0, 510),
    ('down', 1953, 36, 70, 61, 0, 4, 511),
    ('left', 945, 31, 136, 7, -4, 0, 510),
]


def normalize(points):
    left = min(x for x,y in points)
    top = min(y for x,y in points)
    return {(x-left,y-top) for x,y in points}


def component(frame, left, top, dx):
    width,height = (4,3) if dx else (3,4)
    # Follow connected neutral pixels, including any excess ink outside the
    # expected box. An overlap with terrain makes the selected sample invalid.
    pending = [(left+width//2, top+height//2)]
    marked, pixels = set(), set()
    while pending:
        x,y = pending.pop()
        if (x,y) in marked or x<0 or y<0 or x>=208 or y>=208:
            continue
        marked.add((x,y))
        pos = 3*(y*208+x)
        color = frame[pos:pos+3]
        if min(color)<=60 or max(color)-min(color)>=26:
            continue
        pixels.add((x,y))
        pending.extend(((x-1,y),(x+1,y),(x,y-1),(x,y+1)))
    return pixels


def effects(video, rom, output):
    size = 208*208*3
    with (output/'effects.csv').open('w',newline='') as file:
        writer = csv.writer(file)
        writer.writerow(('effect','clip_seek_s','capture_frame','left','top','tile','visible_white','tile_white','intersection','union','iou'))
        def measure(raw,seek,n,x,y,width,index,kind):
            frame = raw[n*size:(n+1)*size]
            quadrants = [chr_square(rom,index+q*4) for q in range((width//16)**2)]
            observed, model = set(),set()
            for v in range(width):
                for u in range(width):
                    pos = 3*((y+v)*208+x+u)
                    r,g,b = frame[pos:pos+3]
                    white = b>150 and abs(r-b)<45 if kind=='shield' else min(r,g,b)>=158
                    if white: observed.add((u,v))
                    quad = quadrants[u//16+(v//16)*(width//16)]
                    if quad[u%16+16*(v%16)]==3: model.add((u,v))
            shared = len(observed & model)
            union = len(observed | model)
            writer.writerow((kind,seek,n,x,y,index,len(observed),len(model),shared,union,round(shared/union,4)))

        raw = rgb_frames(video,32.35,2.15)
        # Player travels right through the same corridor; both phases are partly occluded.
        for i in range(31):
            measure(raw,32.35,32+i,76+(3*i+1)//2,169,16,432+4*(1-i%2),'shield')
        raw = rgb_frames(video,123.15,1.05)
        for n,index in [(11,408),(12,408),(13,412),(14,412),(17,458),(18,458),(19,474),(20,474),
                        (23,408),(24,408),(25,408),(26,408)]:
            width = 32 if index>=458 else 16
            measure(raw,123.15,n,72-width//2,145-width//2,width,index,'blast')


def verify(video, image, output):
    with video.open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=VIDEO_SHA:
            raise ValueError('Choose the calibrated My Gameplay Videos excerpt starting at 05:18.')
    rom = image.read_bytes()
    assert rom[:4]==b'NES\x1a'
    output.mkdir(parents=True,exist_ok=True)
    size = 208*208*3
    wanted = {n for _,first,count,*_ in TRACKS for n in range(first, first+count)}
    captured = {}
    with subprocess.Popen(['ffmpeg','-v','error','-ss','30','-i',str(video),'-vf',FIELD,'-frames:v',
                           str(max(wanted)+1),'-an','-pix_fmt','rgb24','-threads','1','-f','rawvideo','-'],
                          stdout=subprocess.PIPE) as decoder:
        for frame in range(max(wanted)+1):
            raw = decoder.stdout.read(size)
            if len(raw)!=size:
                raise ValueError(f'incomplete Switch capture at frame {frame}')
            if frame in wanted:
                captured[frame] = raw
        if decoder.wait():
            raise RuntimeError('Switch capture decoding failed')
    panels = []
    with (output/'projectiles.csv').open('w', newline='') as file:
        writer = csv.writer(file)
        writer.writerow(('direction','capture_index_after_seek_30s','source_seconds','left','top','visible_pixels','pixel_errors'))
        for direction,first,count,x,y,dx,dy,index in TRACKS:
            start = 16+rom[4]*16384+16*index
            tile = rom[start:start+16]
            glyph = normalize({(7-u if direction=='left' else u, v) for v in range(8) for u in range(8)
                               if (tile[v] | tile[v+8]) & (128>>u)})
            for i in range(count):
                frame = captured[first+i]
                left,top = x+dx*i,y+dy*i
                observed = component(frame,left,top,dx)
                expected = {(left+u,top+v) for u,v in glyph}
                errors = len(observed ^ expected)
                writer.writerow((direction,first+i,f'{318+(900+first+i)*1001/30000:.3f}',left,top,len(observed),errors))
                assert errors==0, (direction,i,left,top,errors)
                if i==count//2:
                    origin_x, origin_y = left-6,top-6
                    sample = crop(frame,origin_x,origin_y)
                    model = b''.join(bytes([160 if (origin_x+u,origin_y+v) in expected else 0])*3
                                     for v in range(16) for u in range(16))
                    panels.append((sample,model))
    strip = b''.join(column[row][48*y:48*y+48] for row in range(2) for y in range(16) for column in panels)
    subprocess.run(['ffmpeg','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','64x32','-i','-',
                    '-vf','scale=640:320:flags=neighbor','-threads','1','-frames:v','1',str(output/'projectiles.png')],
                   input=strip,check=True)
    effects(video,rom,output)
    print(sum(track[2] for track in TRACKS),'Switch capture frames match all four compiled projectile masks')


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('video','rom','output'):
        parser.add_argument(name,type=Path)
    args = parser.parse_args()
    verify(args.video,args.rom,args.output)
