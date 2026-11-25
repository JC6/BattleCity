"""Align the terminal cue near visible GAME OVER in three identified public recordings."""
import argparse
import csv
import hashlib
from pathlib import Path

from ending_audio import alignment, centered_frames
from switch_cues import HOP, RATE, pcm
from tv_tail_codec import tail


# HLS segment start and search interval in the original video, in seconds.
CASES = (
    ('coop-audio18', 'MnymnZA9zTc', 1280, 1297, 1303, '68630da959a58af8773233942ac594f3aa52cb8b8f99f132911546bfa7839d67'),
    ('coop-audio42', 'MnymnZA9zTc', 3056.64, 3075, 3076.96, 'f9b1dbdef6271694eb238b0c974f1b0961628646d34e6f726564c041339ea848'),
    ('archives-audio', '9d-Mw2oTvp0', 3323.732896, 3340, 3342, '09733cb11dbc27ad28f2976b6a81fa017d4fb518c3013213e008d653bd10e750'),
)


def measure(native_wav, native_onset, clips, output):
    ref = centered_frames(pcm(native_wav, native_onset, 1.48), 256)
    local_tail = tail(pcm(native_wav, native_onset, 2.15), .012)
    with output.open('w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(('clip', 'video_id', 'clip_start_s', 'sha256', 'search_start_s', 'search_end_s',
                         'best_time_s', 'spectral_cosine', 'tail_0_6pct', 'tail_1_2pct', 'tail_2_4pct', 'local_tail_1_2pct'))
        for name, video, origin, left, right, expected in CASES:
            clip = clips/(name+'.m4a')
            with clip.open('rb') as source:
                assert hashlib.file_digest(source,'sha256').hexdigest()==expected
            signal = centered_frames(pcm(clip,left-origin,right-left+1.55),256)
            stop = min(len(signal)-len(ref), round((right-left)*RATE/HOP))
            score, index = alignment(ref,signal,0,len(ref),range(stop+1))
            pos = left+index*HOP/RATE
            # Same threshold as the five Switch mixes. Background speech can obscure the cue.
            tails = [None]*3
            if score>=.7:
                data = pcm(clip,pos-origin,2.15)
                tails = [tail(data,fraction) for fraction in (.006,.012,.024)]
            writer.writerow((name,video,origin,expected,left,right,round(pos,3),round(score,4),*tails,local_tail))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('native_wav',type=Path)
    parser.add_argument('native_onset',type=float)
    parser.add_argument('clips',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    measure(args.native_wav,args.native_onset,args.clips,args.output)
