"""Choose the Android release default from two cold boots of the same APK."""
import argparse
import json
from pathlib import Path

CASES = {'standard','large','pixel','stretch','antialias','scanlines','firing','blast'}


DRIVERS = {'surface-tv':'window-surface','dirty-tv':'android-native-window','compositor-tv':'android-surface-control'}
HOLDOUTS = {'moving-626', 'moving-633'}
COMPOSITOR_HOLDOUTS = HOLDOUTS | {'moving-648', 'blast-700', 'calibration'}


def probe_pass(root, renderer='dirty-tv'):
    windows = json.loads((root/'prototype/clock.json').read_text())['windows']
    required={'battle','explosions'}
    assert set(windows) in (required, required | {'full-battle','full-explosions'})
    return all(len(windows[name])==1 and qualifying(windows[name][0],DRIVERS[renderer]) for name in required)


def qualifying(row, driver="android-native-window"):
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


def preliminary(root,renderer):
    heldout=json.loads((root/'held-out/visual.json').read_text())
    assert set(heldout)==(COMPOSITOR_HOLDOUTS if renderer=='compositor-tv' else HOLDOUTS)
    assert len({r['battle'] for k,r in heldout.items() if k!='calibration'})==len(heldout)-('calibration' in heldout)
    controls=json.loads((root/'candidate-controls/result.json').read_text())['result']
    assert controls in ('passed','failed')
    return {'prototypePassed':probe_pass(root,renderer),
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
        if not diagnostics['prototypePassed'] or (renderer=='compositor-tv' and not all(diagnostics.values())):
            return {'default':'none',**({'candidate':renderer} if renderer=='compositor-tv' else {}),**diagnostics,'boots':[],'tested':identity}
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
    return {'default':renderer if passed else 'none',**({'candidate':renderer} if renderer=='compositor-tv' else {}),**diagnostics,'boots':records,'tested':identity}


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
