"""Compare compiled stage-one CHR with calibrated Switch stills and successive spawn frames."""
import argparse
import csv
import hashlib
from pathlib import Path
import subprocess

VIDEO_SHA = '53da1aa22185034240566726ec4173691df1115c3c106a1996facf7b3f8630a0'
STILL_SHA = '678cb9c1a3d960ba747343ba6e887e75fe9afbc18ad623c5a874f1a2cd49fb7c'
# A second spawn point tests the outlines independent of the enemy animation.
SPAWNS = [(96,0,12,3),(96,0,14,2),(96,0,16,1),(96,0,18,0),
          (64,192,12,3),(64,192,13,2),(64,192,15,1),(64,192,16,0)]
FIELD = 'crop=648:556:291:82:exact=1,scale=208:208:flags=neighbor'


def rgb_frames(path, seconds=None, duration=None):
    command = ['ffmpeg','-v','error']
    if seconds is not None:
        command += ['-ss',str(seconds)]
    command += ['-i',str(path)]
    if duration:
        command += ['-t',str(duration)]
    return subprocess.check_output(command + ['-vf',FIELD,'-an','-pix_fmt','rgb24','-threads','1','-f','rawvideo','-'])


def crop(frame, x, y, width=16):
    return b''.join(frame[3*(208*(y+v)+x):3*(208*(y+v)+x+width)] for v in range(width))


def chr_square(rom, index):
    start = 16 + rom[4]*16384 + index*16
    result = []
    for y in range(16):
        for x in range(16):
            tile = start + 16*(2*(y//8)+x//8) + y%8
            bit = 7-x%8
            result.append((rom[tile]>>bit & 1) | (rom[tile+8]>>bit & 1)*2)
    return result


def output_strip(path, samples):
    # Each column shows video pixels, the older CHR, and the current CHR.
    w = 16*len(samples)
    raw = b''.join(data[row][48*y:48*y+48] for row in range(3) for y in range(16) for data in samples)
    subprocess.run(['ffmpeg','-v','error','-y','-f','rawvideo','-s',f'{w}x48','-pix_fmt','rgb24',
                    '-i','-','-vf','scale=iw*5:ih*5:flags=neighbor','-frames:v','1','-threads','1',str(path)],
                   input=raw, check=True)


def compare(video, still, previous, current, out):
    for file, digest in [(video,VIDEO_SHA),(still,STILL_SHA)]:
        with file.open('rb') as stream:
            assert hashlib.file_digest(stream,'sha256').hexdigest()==digest, f'unexpected source {file}'
    out.mkdir(parents=True,exist_ok=True)
    old, new = previous.read_bytes(),current.read_bytes()
    frames = rgb_frames(video,31.3,.8)
    size=208*208*3
    rows, panels = [], []
    for x,y,frame,phase in SPAWNS:
        capture=crop(frames[size*frame:size*(frame+1)], x,y)
        mask=[min(capture[i:i+3])>=125 for i in range(0,len(capture),3)]
        old_chr, new_chr = (chr_square(rom,416+4*phase) for rom in (old,new))
        row = [sum((val!=0)!=pixel for val,pixel in zip(glyph,mask)) for glyph in (old_chr,new_chr)]
        rows.append(('enemy' if x==96 else 'player',phase,frame,*row))
        panels.append([capture,*(b''.join(bytes([255 if v else 0])*3 for v in glyph) for glyph in (old_chr,new_chr))])
    output_strip(out/'spawn.png',panels)
    with (out/'spawn.csv').open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(('spawn','phase','frame_after_seek_31_3s','previous_pixel_errors','current_pixel_errors'))
        writer.writerows(rows)
    assert all(row[-1]==0 for row in rows), 'Switch spawn silhouette differs from the cartridge'

    # Two consecutive recorded fields show both shield phases, partly masked by
    # the player's body. Compare visible white pixels; retain the video colors.
    shield_frames=rgb_frames(video,34.1,.09)
    shield_panels=[]
    with (out/'shield.csv').open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(('frame_after_seek_34_1s','x','y','phase','previous_white_iou','current_white_iou'))
        for n,x,phase in ((0,106,1),(1,108,0)):
            sample=crop(shield_frames[n*size:(n+1)*size],x,169)
            white={i for i in range(256) if sample[3*i+2]>150 and abs(sample[3*i]-sample[3*i+2])<45}
            glyphs=[chr_square(rom,432+4*phase) for rom in (old,new)]
            masks=[{i for i,v in enumerate(glyph) if v==3} for glyph in glyphs]
            scores=[len(white & mask)/len(white | mask) for mask in masks]
            writer.writerow((n,x,169,phase,*[round(v,3) for v in scores]))
            assert scores[1]>scores[0], 'shield silhouette regressed'
            shield_panels.append([sample,*(b''.join(bytes([255 if v else 0])*3 for v in glyph) for glyph in glyphs)])
    output_strip(out/'shield.png',shield_panels)

    # Stage-two player explosion on a brick/forest border. White-core overlap
    # is meaningful here even though the recording mixes the darker colors.
    blast_frames=rgb_frames(video,123.15,.8)
    strips=[]
    with (out/'blast.csv').open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(('frame_after_seek_123_15s','x','y','phase','white_core_iou'))
        for n,index in ((17,458),(19,474)):
            sample=crop(blast_frames[n*size:(n+1)*size],56,129,32)
            quads=[chr_square(new,index+4*q) for q in range(4)]
            shape=[quads[x//16+2*(y//16)][x%16+16*(y%16)] for y in range(32) for x in range(32)]
            observed={i for i in range(1024) if min(sample[3*i:3*i+3])>=158}
            rendered={i for i,v in enumerate(shape) if v==3}
            writer.writerow((n,56,129,index,round(len(observed&rendered)/len(observed|rendered),3)))
            strips.append((sample,b''.join(bytes([(255 if v==3 else 0)])*3 for v in shape)))
    raster=b''.join(col[row][96*y:96*y+96] for row in range(2) for y in range(32) for col in strips)
    subprocess.run(['ffmpeg','-v','error','-y','-f','rawvideo','-s','64x64','-pix_fmt','rgb24','-i','-',
                    '-vf','scale=320:320:flags=neighbor','-frames:v','1','-threads','1',str(out/'blast.png')],
                   input=raster,check=True)

    # Track the non-overlapping upward projectile through the empty corridor.
    shots=rgb_frames(video,34.8,.24)
    shot_panels=[]
    # The old sprite starts at the nominal shell coordinate. The directional
    # sprite is anchored three pixels earlier on each axis in the OAM.
    def shell_mask(rom, anchor):
        tile=chr_square(rom,440)
        return {(x+anchor,y+anchor) for y in range(8) for x in range(8) if tile[y*16+x]}
    old_shell, new_shell = shell_mask(old,0),shell_mask(new,-3)
    with (out/'shot.csv').open('w',newline='') as f:
        writer=csv.writer(f)
        writer.writerow(('frame_after_seek_34_8s','left','top','width','height','visible_pixels',
                         'previous_pixel_errors','current_pixel_errors'))
        for n in range(1,7):
            frame=shots[n*size:(n+1)*size]
            points=set()
            for y in range(85,150):
                for x in range(130,140):
                    pixel=frame[3*(208*y+x):3*(208*y+x)+3]
                    if min(pixel)>60 and max(pixel)-min(pixel)<26: points.add((x,y))
            xs,ys=zip(*points)
            left,top=min(xs),min(ys)
            # Align the visible tip and compare the rest of the silhouette.
            def aligned(shape):
                dx=left-min(x for x,y in shape)
                dy=top-min(y for x,y in shape)
                return {(x+dx,y+dy) for x,y in shape}
            previous,current=aligned(old_shell),aligned(new_shell)
            writer.writerow((n,left,top,max(xs)-left+1,max(ys)-top+1,len(points),
                             len(points^previous),len(points^current)))
            assert points==current, f'Switch upward shell differs in capture frame {n}'
            shot_panels.append([crop(frame,left-6,top-6),*[
                b''.join(bytes([170 if (left+x-6,top+y-6) in shape else 0])*3
                         for y in range(16) for x in range(16)) for shape in (previous,current)]])
    output_strip(out/'shot.png',shot_panels)
    # Consecutive poses in an unobstructed corridor after the shield has expired.
    tread_frames=rgb_frames(video,38,.07)
    positions=((163,88,1),(164,88,0))
    tread_panels=[]
    palette=[(0,0,0),(95,94,3),(231,152,36),(240,238,152)]
    for n,(x,y,phase) in enumerate(positions):
        sample=crop(tread_frames[n*size:(n+1)*size],x,y)
        target=chr_square(new,260+phase*8)
        rendered=b''.join(bytes(palette[v]) for v in target)
        tread_panels.append([sample,rendered,b''.join(bytes([255 if v else 0])*3 for v in target)])
    output_strip(out/'treads.png',tread_panels)

    # The official screenshot shows the player facing right. Measure the dark field
    # behind the tank separately from its non-black track and gun pixels.
    img=crop(rgb_frames(still),80,96)
    mask=[max(img[i:i+3])>60 for i in range(0,len(img),3)]
    palette=[(0,0,0),(95,94,3),(231,152,36),(240,238,152)]
    errors=[]
    for phase in (0,1):
        tile=chr_square(new,260+8*phase)
        errors.append(sum((v!=0)!=p for v,p in zip(tile,mask)))
    best=min(range(2),key=errors.__getitem__)
    converted=b''.join(bytes(palette[v]) for v in chr_square(new,260+8*best))
    output_strip(out/'player.png',[[img,converted,b''.join(bytes([255 if yes else 0])*3 for yes in mask)]])
    (out/'player.csv').write_text('tread_phase,pixel_errors,total_pixels\n'+''.join(f'{i},{e},256\n' for i,e in enumerate(errors)))
    print('Switch spawn pixel errors', [r[-1] for r in rows], 'player silhouette',errors)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('video','still','previous','current','output'): parser.add_argument(key,type=Path)
    a=parser.parse_args()
    compare(a.video,a.still,a.previous,a.current,a.output)
