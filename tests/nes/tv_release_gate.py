"""Choose the Android release default from two cold boots of the same APK."""
import argparse
import json
from pathlib import Path

CASES = {'standard','large','pixel','stretch','antialias','scanlines','firing','blast'}


def decision(root):
    records = []
    identity = (root/'tested-sha256.txt').read_text()
    for boot in (root, root/'second'):
        assert (boot/'tested-sha256.txt').read_text() == identity, 'APK or cartridge changed between boots'
        windows = json.loads((boot/'render/clock.json').read_text())['windows']['candidate']
        screens = {}
        for suite in ('render','scenes'):
            screens.update(json.loads((boot/suite/'visual.json').read_text()))
        assert set(screens) == CASES and [w['run'] for w in windows] == [1,2,3]
        timing = all(w['driver']=='window-surface' and w['wall']>=30 and
                     w['frames']==w['presented']==w['attempts'] and
                     .99<=w['emu']/w['wall']<=1.01 and
                     .99<=w['samples']/w['sampleRate']/w['wall']<=1.01 for w in windows)
        failed = [name for name,r in screens.items() if r['nativePixels']!=256*224 or
                  any(r[k] for k in ('differentCenters','differentWallpaperPixels','aboveRepeatNoise'))]
        records.append({'clockPassed':timing,'differentScenes':failed})
    for path in (root,root/'candidate-controls'):
        assert json.loads((path/'result.json').read_text())['result']=='passed'
    passed = all(r['clockPassed'] and not r['differentScenes'] for r in records)
    return {'default':'surface-tv' if passed else 'none','boots':records,'tested':identity}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results',type=Path)
    directory=parser.parse_args().results
    gate=decision(directory)
    (directory/'release-gate.json').write_text(json.dumps(gate,indent=2)+'\n')
    print(json.dumps(gate))
