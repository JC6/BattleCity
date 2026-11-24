"""Choose the Android release default from two cold boots of the same APK."""
import argparse
import json
from pathlib import Path

CASES = {'standard','large','pixel','stretch','antialias','scanlines','firing','blast'}


def probe_pass(root):
    windows = json.loads((root/'prototype/clock.json').read_text())['windows']
    assert set(windows) == {'battle','explosions'}
    return all(len(records)==1 and qualifying(records[0]) for records in windows.values())


def qualifying(row, driver="android-native-window"):
    return (row['driver']==driver and row['wall']>=30 and
            row['frames']>0 and row['frames']==row['presented']==row['attempts'] and
            .99<=row['emu']/row['wall']<=1.01 and
            .99<=row['samples']/row['sampleRate']/row['wall']<=1.01)


def decision(root, require_prototype=False):
    records = []
    identity = (root/'tested-sha256.txt').read_text()
    assert json.loads((root/'result.json').read_text())['result']=='passed'
    controls=json.loads((root/'candidate-controls/result.json').read_text())['result']
    assert controls in ('passed','failed')
    native = require_prototype or (root/'prototype').exists()
    diagnostics = {}
    heldout_pass = True
    if native:
        heldout=json.loads((root/'held-out/visual.json').read_text())
        assert set(heldout)=={'moving-626','moving-633'}
        assert heldout['moving-626']['battle'] != heldout['moving-633']['battle']
        heldout_pass=all(r['nativePixels']==256*224 and not any(r[k] for k in
                         ('differentCenters','differentWallpaperPixels','aboveRepeatNoise')) for r in heldout.values())
        diagnostics={'prototypePassed':probe_pass(root),'heldOutPassed':heldout_pass,'candidateControlsPassed':controls=='passed'}
        if not diagnostics['prototypePassed']:
            return {'default':'none',**diagnostics,'boots':[],'tested':identity}
    for boot in (root, root/'second'):
        assert (boot/'tested-sha256.txt').read_text() == identity, 'APK or cartridge changed between boots'
        windows = json.loads((boot/'render/clock.json').read_text())['windows']['candidate']
        screens = {}
        for suite in ('render','scenes'):
            screens.update(json.loads((boot/suite/'visual.json').read_text()))
        assert set(screens) == CASES and [w['run'] for w in windows] == [1,2,3]
        timing = all(qualifying(w, "android-native-window" if native else "window-surface") for w in windows)
        failed = [name for name,r in screens.items() if r['nativePixels']!=256*224 or
                  any(r[k] for k in ('differentCenters','differentWallpaperPixels','aboveRepeatNoise'))]
        records.append({'clockPassed':timing,'differentScenes':failed})
    passed = controls=='passed' and heldout_pass and all(r['clockPassed'] and not r['differentScenes'] for r in records)
    return {'default':('dirty-tv' if native else 'surface-tv') if passed else 'none',**diagnostics,'boots':records,'tested':identity}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results',type=Path)
    parser.add_argument('--require-prototype',action='store_true')
    args=parser.parse_args()
    directory=args.results
    gate=decision(directory,args.require_prototype)
    (directory/'release-gate.json').write_text(json.dumps(gate,indent=2)+'\n')
    print(json.dumps(gate))
