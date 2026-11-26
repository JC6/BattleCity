"""Choose the Android release default from two cold boots of the same APK."""
import argparse
import gzip
import json
from pathlib import Path

CASES = {'standard','large','pixel','stretch','antialias','scanlines','firing','blast'}


DRIVERS = {'egl-tv':'android-egl-window','surface-tv':'window-surface','dirty-tv':'android-native-window','compositor-tv':'android-surface-control'}
HOLDOUTS = {'moving-626', 'moving-633'}
COMPOSITOR_HOLDOUTS = HOLDOUTS | {'moving-648', 'blast-700', 'calibration'}


def probe_pass(root, renderer='dirty-tv'):
    windows = json.loads((root/'prototype/clock.json').read_text())['windows']
    required={'battle','explosions'}
    assert required.issubset(windows)
    return all(len(windows[name])==1 and qualifying(windows[name][0],DRIVERS[renderer]) for name in required)


def qualifying(row, driver="android-native-window"):
    if driver==DRIVERS['egl-tv'] and (row.get('verifiedPresentations')!=row['frames'] or
            row.get('displayEvidence') not in ('EGL_DISPLAY_PRESENT_TIME_ANDROID','SurfaceFlinger PRESENT_FENCE')):
        return False
    if driver == DRIVERS['compositor-tv']:
        if (row['driver'] != driver or row.get('transactions') != row['frames'] or
                row.get('completions') != row['frames'] or row.get('pending') != 0 or row.get('frameIdErrors') != 0 or
                row.get('gpuFrames') != row['frames'] or
                row.get('lastCompletedFrame', 0) <= 0 or row['lastCompletedFrame'] != row.get('lastSubmittedFrame')):
            return False
    return (row['driver']==driver and row['wall']>=30 and row['sampleRate']>0 and
            row['frames']>0 and row['frames']==row['presented']==row['attempts'] and
            .99<=row['emu']/row['wall']<=1.01 and
            .99<=row['samples']/row['sampleRate']/row['wall']<=1.01)


def swap_readbacks(root):
    from tv_stage_analysis import ppm
    folder=root/'held-out'
    for scene in COMPOSITOR_HOLDOUTS:
        files=[folder/f'{scene}-{mode}-swap.ppm.gz' for mode in ('baseline','repeat','candidate')]
        if not all(path.is_file() for path in files):return False
        images=[ppm(gzip.decompress(path.read_bytes())) for path in files]
        if len({item[:2] for item in images})!=1:return False
        base,repeat,test=(item[2] for item in images)
        if base!=test and any(abs(p-c)>abs(p-r) for p,r,c in zip(base,repeat,test)):return False
    return True


def rgb565_matches(source, texture):
    if source[:2]!=texture[:2]:return False
    # Discard lower channel bits, then replicate the high bits to reconstruct RGB888.
    for c,bits in enumerate((5,6,5)):
        shift=8-bits
        lut=bytes(((v>>shift)<<shift) | ((v>>shift)>>(bits-shift)) for v in range(256))
        if source[2][c::3].translate(lut)!=texture[2][c::3]:return False
    return True


def pipeline_pass(folder):
    from tv_stage_analysis import load
    if not (folder/'visual.json').is_file():return False
    visuals=json.loads((folder/'visual.json').read_text())
    scenes={'solid','corners','calibration','moving-633'}
    if set(visuals)!=scenes:return False
    for name,row in visuals.items():
        if any(row[k] for k in ('differentCenters','aboveRepeatNoise','differentWallpaperPixels')):return False
        required=[folder/f'{name}-candidate-{stage}.ppm.gz' for stage in ('source','texture')]
        if not all(p.is_file() for p in required):return False
        source,texture=map(load,required)
        if not rgb565_matches(source,texture):return False
        for stage in ('layer','swap'):
            files=[folder/f'{name}-{mode}-{stage}.ppm.gz' for mode in ('baseline','repeat','candidate')]
            if not all(p.is_file() for p in files):return False
            images=list(map(load,files))
            if len({i[:2] for i in images})!=1:return False
            expected,control,actual=[i[2] for i in images]
            if expected!=actual and any(abs(e-a)>abs(e-r) for e,r,a in zip(expected,control,actual)):return False
        if name in ('solid','corners'):
            w,h,rgb=texture
            indices=[3*((j*h//4)*w+i*w//4) for j in (1,3) for i in (1,3)]
            palette=[rgb[i:i+3].hex() for i in indices]
            if palette!=(['00ff00']*4 if name=='solid' else ['ffffff','ff0000','00ff00','0000ff']):return False
    return True


def preliminary(root,renderer):
    heldout=json.loads((root/'held-out/visual.json').read_text())
    assert set(heldout)==(COMPOSITOR_HOLDOUTS if renderer in ('compositor-tv','egl-tv') else HOLDOUTS)
    assert len({r['battle'] for k,r in heldout.items() if k!='calibration'})==len(heldout)-('calibration' in heldout)
    controls=json.loads((root/'candidate-controls/result.json').read_text())['result']
    assert controls in ('passed','failed')
    sampling=renderer=='egl-tv' and 'prepared-battle' in json.loads((root/'prototype/clock.json').read_text())['windows']
    measured={}
    cost=root/'presentation/clock.json'
    if cost.is_file():
        windows=json.loads(cost.read_text())['windows']
        required=[f'{scene}-damage-{i}'+('-explosions' if scene=='explosions' else '')
                  for scene in ('battle','explosions') for i in (1,2,3)]
        measured['presentationPassed']=all(len(windows.get(key,[]))==1 and
            qualifying(windows[key][0],DRIVERS[renderer]) for key in required)
    return {**measured,**({'pipelinePassed':pipeline_pass(root/'pipeline')} if sampling or (root/'pipeline').is_dir() else {}),
            **({'windowReadbackPassed':swap_readbacks(root)} if renderer=='egl-tv' else {}),
            'prototypePassed':probe_pass(root,renderer),
            'heldOutPassed':all(r['nativePixels']==256*224 and r.get('calibration',{'valid':True})['valid'] and not any(r[k] for k in
                 ('differentCenters','differentWallpaperPixels','aboveRepeatNoise')) for r in heldout.values()),
            'candidateControlsPassed':controls=='passed'}


def decision(root, require_prototype=False, renderer=None):
    records = []
    identity = (root/'tested-sha256.txt').read_text()
    assert json.loads((root/'result.json').read_text())['result']=='passed'
    if renderer is None:
        renderer='dirty-tv' if require_prototype or (root/'prototype').exists() else 'surface-tv'
    diagnostics = {}
    if renderer!='surface-tv':
        diagnostics=preliminary(root,renderer)
        if not diagnostics['prototypePassed'] or (renderer in ('compositor-tv','egl-tv') and not all(diagnostics.values())):
            return {'default':'none',**({'candidate':renderer} if renderer in ('compositor-tv','egl-tv') else {}),**diagnostics,'boots':[],'tested':identity}
    for boot in (root, root/'second'):
        assert (boot/'tested-sha256.txt').read_text() == identity, 'APK or cartridge changed between boots'
        windows = json.loads((boot/'render/clock.json').read_text())['windows']['candidate']
        screens = {}
        for suite in ('render','scenes'):
            screens.update(json.loads((boot/suite/'visual.json').read_text()))
        assert set(screens) == CASES and [w['run'] for w in windows] == [1,2,3]
        timing = all(qualifying(w,DRIVERS[renderer]) for w in windows)
        failed = [name for name,r in screens.items() if r['nativePixels']!=256*224 or
                  any(r[k] for k in ('differentCenters','differentWallpaperPixels','aboveRepeatNoise'))]
        records.append({'clockPassed':timing,'differentScenes':failed})
    passed = all(diagnostics.values()) and json.loads((root/'candidate-controls/result.json').read_text())['result']=='passed' and all(r['clockPassed'] and not r['differentScenes'] for r in records)
    return {'default':renderer if passed else 'none',**({'candidate':renderer} if renderer in ('compositor-tv','egl-tv') else {}),**diagnostics,'boots':records,'tested':identity}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results',type=Path)
    parser.add_argument('--require-prototype',action='store_true')
    parser.add_argument('--renderer',choices=sorted(DRIVERS))
    args=parser.parse_args()
    directory=args.results
    gate=decision(directory,args.require_prototype,args.renderer)
    (directory/'release-gate.json').write_text(json.dumps(gate,indent=2)+'\n')
    print(json.dumps(gate))
