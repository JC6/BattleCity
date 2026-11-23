"""Check the cartridge and its persistent-state identity in a deliverable."""
import argparse
from hashlib import sha256
from pathlib import Path
from zipfile import ZipFile


def verify(archive, cartridge, abi='arm64-v8a'):
    contents = cartridge.read_bytes()
    identity = sha256(contents).hexdigest()
    images = Path(__file__).resolve().parents[2] / 'runtime/android/src/main/res/drawable-nodpi'
    with ZipFile(archive) as package:
        for name in ('battle_surround.jpg','battle_stars.jpg','battle_symbols.jpg'):
            entries = [entry for entry in package.namelist() if entry.rsplit('/',1)[-1] == name]
            assert len(entries) == 1 and package.read(entries[0]) == (images/name).read_bytes(), name
        if archive.suffix == '.apk':
            assert package.read('assets/game.nes') == contents, 'APK cartridge differs'
            assert package.read('assets/cartridge.id').decode() == identity, 'APK save identity differs'
            names = set(package.namelist())
            packaged_abis = {name.split('/')[1] for name in names if name.startswith('lib/') and name.endswith('.so')}
            assert packaged_abis == {abi}, f'expected {abi}, got {packaged_abis}'
            for library in ['libmain.so', 'libSDL3.so', 'libc++_shared.so']:
                assert f'lib/{abi}/' + library in names, library
        else:
            assert identity in package.read('index.html').decode(), 'Web save identity differs'
            assert contents in package.read('battlecity.wasm'), 'WebAssembly cartridge differs'
    print(f'{archive.name} embeds {identity}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('cartridge', type=Path)
    parser.add_argument('--abi', choices=['arm64-v8a', 'x86'], default='arm64-v8a')
    args = parser.parse_args()
    verify(args.archive, args.cartridge, args.abi)
