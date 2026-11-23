"""Run the installed SDL/MAME TV app with two Android kernel gamepads (dedicated test device)."""
import argparse
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import time
import wave
from zipfile import ZipFile

PACKAGE = 'org.jiangc.bc.runtime'
ADB = os.environ.get('ADB', 'adb')
SOUTH, EAST, WEST, MENU, REWIND, SELECT, START = 304, 305, 307, 310, 311, 314, 315
TIMEOUT = int(os.environ.get('BATTLECITY_DEVICE_TIMEOUT', '90'))


def adb(*args, data=None, check=True):
    return subprocess.run([ADB, *args], input=data, capture_output=True, check=check, timeout=max(35, TIMEOUT)).stdout


def private(*args, **kwargs):
    return adb('exec-out', 'run-as', PACKAGE, *args, **kwargs)


def wait(read, predicate, description):
    deadline = time.monotonic() + TIMEOUT
    last = None
    while time.monotonic() < deadline:
        last = read()
        if predicate(last):
            return last
        time.sleep(.15)
    observed = f'{len(last)} bytes' if isinstance(last, bytes) else str(last)[:220]
    raise RuntimeError(f'{description}: timed out, last observation {observed}')


class Pad:
    def __init__(self, number, events):
        self.number = number
        self.events = events
        self.proc = subprocess.Popen([ADB, 'shell', '-T', 'uinput', '-'], stdin=subprocess.PIPE)
        name = f'Battle City Test Pad {number}'
        self.send({'command': 'register', 'name': name, 'vid': 0x045e, 'pid': 0x028e,
                   'bus': 'usb', 'port': f'usb/battlecity/{number}',
                   'configuration': [{'type': 100, 'data': [1, 3]},
                                     {'type': 101, 'data': [304,305,307,308,310,311,314,315]},
                                     {'type': 103, 'data': [0,1,16,17]}],
                   'abs_info': [{'code': n, 'info': {'minimum': -v, 'maximum': v}}
                                for n,v in [(0,32767),(1,32767),(16,1),(17,1)]]})
        wait(lambda: adb('shell','dumpsys','input').decode(errors='replace'),
             lambda s: name in s, name)

    def send(self, event):
        event['id'] = self.number
        self.events.write(json.dumps(event)+'\n')
        self.events.flush()
        self.proc.stdin.write((json.dumps(event)+'\n').encode())
        self.proc.stdin.flush()

    def event(self, kind, code, value):
        self.send({'command':'inject', 'events':[kind, code, value, 0, 0, 0]})

    def tap(self, code):
        self.event(1, code, 1)
        try:
            presented(3)
        finally:
            self.event(1, code, 0)
        presented(4)

    def direction(self, y):
        self.event(3, 17, y)

    def down(self):
        self.direction(1)
        try:
            presented(3)
        finally:
            self.direction(0)
        presented(4)

    def close(self):
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)


def observer(labels, directory):
    addresses = {name: int(value, 16) for value, name in
                 re.findall(r'^al (\w+) \._(\w+)$', labels.read_text(), re.M)}
    fields = [('mode',0),('players',0),('selection',0),('stage',0),('title_scroll',0),
              ('tanks',1),('tanks',14),('shots',3),('shots',7),('battle_ticks',1)]
    reads = ','.join(f'ram:read_u8({addresses[key]+offset})' for key,offset in fields)
    # Observe the game through its CPU bus. Publishing between rendered frames
    # also works while the emulated CPU is paused in the native player menu.
    return f"""
local ram=manager.machine.devices[":maincpu"].spaces.program
local tick,p1,p2=0,0,0
emu.register_frame_done(function()
  tick=tick+1
  if ram:read_u8({addresses['shots']+3})==1 then p1=tick end
  if ram:read_u8({addresses['shots']+7})==1 then p2=tick end
  if tick%3~=0 then return end
  local file=assert(io.open("{directory}/tv-observation.tmp","w"))
  file:write(table.concat({{{reads},manager.ui.menu_active and 1 or 0,p1,p2,tick}},','))
  file:close()
  assert(os.rename("{directory}/tv-observation.tmp","{directory}/tv-observation"))
end)
"""


def state():
    raw = private('cat','files/tv-observation',check=False).strip()
    if not re.fullmatch(rb'[0-9]+(,[0-9]+){13}', raw):
        return {}
    keys = 'mode players selection stage scroll y1 y2 shot1 shot2 ready menu fire1 fire2 frame'.split()
    return dict(zip(keys,map(int,raw.split(b','))))


def check(predicate, description):
    return wait(state, lambda row: row and predicate(row), description)


def presented(count):
    first = check(lambda s: True, 'display frame')['frame']
    check(lambda s: s['frame'] >= first + count, 'controller sampling')


def wait_gamepad_change(pid, action):
    # Android publishes the input device before SDL's next enumeration. A
    # button edge sent during that interval cannot reach the reconnected pad.
    pattern = re.compile(rb'Game Controller: [^\n]+\] ' + action + rb'\s*$', re.M)
    wait(lambda: adb('logcat', '-d', '--pid', pid, '-s', 'MAME:V'),
         lambda log: pattern.search(log), 'SDL gamepad ' + action.decode())


def capture_audio(results):
    # The core writes signed 16-bit PCM. A live WAV can still have
    # placeholder chunk sizes until the emulator closes the stream.
    header = private('head', '-c', '44', 'files/tv-audio.wav')
    if (header[:4], header[8:12], header[36:40]) != (b'RIFF', b'WAVE', b'data'):
        raise ValueError('Missing PCM WAV header from the installed core')
    fmt, channels, rate = struct.unpack_from('<HHI', header, 20)
    bits, = struct.unpack_from('<H', header, 34)
    assert fmt == 1 and channels in (1, 2) and bits == 16 and rate > 0
    size = rate * channels * 2
    # The producer keeps appending while adb reads. Capture a fixed endpoint
    # and align it to the last complete sample before selecting the clip.
    path = 'files/tv-audio.wav'
    end = int(private('stat', '-c', '%s', path))
    end -= (end - len(header)) % (channels * 2)
    assert end >= len(header) + size, f'only {end-len(header)} PCM bytes, need {size}'
    recording = private('head', '-c', str(end), path)
    assert len(recording) == end, f'read {len(recording)} of {end} bytes from the live WAV'
    audio = recording[-size:]
    samples = [value for value, in struct.iter_unpack('<h', audio)]
    assert max(samples) - min(samples) > 128, 'silent game audio'
    with wave.open(str(results/'game.wav'), 'wb') as output:
        output.setparams((channels, bits//8, rate, 0, 'NONE', 'not compressed'))
        output.writeframes(audio)


def shows_brick(image, bounds):
    # Sample the composited TV screen, including the thumbnail in the first slot.
    rgb = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', 'pipe:0', '-vf',
                          'scale=160:90:flags=neighbor', '-frames:v', '1', '-threads', '1',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                         input=image, capture_output=True, check=True).stdout
    assert len(rgb) == 160 * 90 * 3
    left, top, right, bottom = bounds
    count = 0
    for y in range(top, bottom):
        for x in range(left, right):
            i = (160 * y + x) * 3
            r, g, b = rgb[i:i+3]
            count += r > 85 and r > 1.3 * g and g > 1.3 * b
    return count >= 12


def launch():
    private('rm','-f','files/tv-observation')
    adb('shell','am','start','-W','-a','android.intent.action.MAIN',
        '-c','android.intent.category.LEANBACK_LAUNCHER','-n',PACKAGE+'/.GameActivity')
    check(lambda s:s['mode']==0 and not s['scroll'] and s['ready'], 'cold title')


def run(apk, labels, results):
    results.mkdir(parents=True,exist_ok=True)
    adb('install','-r',str(apk))
    directory = private('pwd').decode().strip()+'/files'
    private('mkdir','-p','files')
    with ZipFile(apk) as package:
        digest = package.read('assets/cartridge.id').decode('ascii')
    if not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid bundled cartridge identity')
    slot = f'files/states/{digest}/nes/1.sta'
    # Leave existing player files intact. A completed run removes its own slot.
    test_files = ['files/'+name for name in ('nes.ini','tv-observer.lua','tv-observation',
                                               'tv-observation.tmp','tv-audio.wav')]
    test_files.extend((slot,slot+'.png',slot+'.lock'))
    for name in test_files:
        if private('ls','-d',name,check=False).strip()==name.encode():
            raise RuntimeError('Use a clean TV test profile: found '+name)
    def write_private(name, content):
        data = content.encode()
        adb('shell','-T','run-as',PACKAGE,'sh','-c',f"'cat > files/{name}'",data=data)
        if private('cat', 'files/'+name) != data:
            raise RuntimeError('Failed to stage '+name)
    pads=[]
    def capture(name, bounds=None):
        def screen(): return adb('exec-out','screencap','-p')
        image = screen() if bounds is None else wait(
            screen, lambda data: shows_brick(data, bounds), 'visible game pixels in '+name)
        assert image.startswith(b'\x89PNG') and len(image)>1000
        (results/(name+'.png')).write_bytes(image)
    try:
        write_private('tv-observer.lua',observer(labels,directory))
        write_private('nes.ini',f'autoboot_delay 0\nautoboot_script {directory}/tv-observer.lua\nwavwrite {directory}/tv-audio.wav\n')
        (results/'device.txt').write_bytes(adb('shell','getprop'))
        with (results/'gamepads.jsonl').open('w') as events:
            for n in (1,2):
                pads.append(Pad(n,events))
            one,two=pads
            launch()
            capture('title')
            one.tap(START)
            check(lambda s:s['mode']==6,'solo stage selection')
            one.tap(START)
            check(lambda s:s['mode']==1 and s['players']==1,'solo battlefield')
            settled=check(lambda s:s['y1']==192,'solo spawn')
            check(lambda s:s['frame']>=settled['frame']+150,'rewind history')
            one.direction(-1)
            advanced=check(lambda s:s['y1']<=152,'travel before rewind')
            one.direction(0)
            one.tap(REWIND)
            check(lambda s:s['y1']>advanced['y1'] and not s['menu'],'direct shoulder rewind')
            adb('shell','am','force-stop',PACKAGE)
            launch()
            one.tap(SELECT)
            check(lambda s:s['selection']==1,'two players selected')
            one.tap(START)
            check(lambda s:s['mode']==6,'co-op stage selection')
            one.tap(START)
            check(lambda s:s['mode']==1 and s['players']==2,'co-op field')
            one.direction(-1)
            two.direction(-1)
            check(lambda s:s['y1']<188 and s['y2']<188,'independent movement')
            one.direction(0)
            two.direction(0)
            start=state()['frame']
            one.tap(SOUTH)
            two.tap(SOUTH)
            check(lambda s:min(s['fire1'],s['fire2'])>=start,'both tanks fired')
            capture_audio(results)
            capture('battle', (40,21,116,72))
            one.tap(START)
            saved=check(lambda s:s['mode']==5,'paused battle')
            one.tap(MENU)
            check(lambda s:s['menu'],'save menu')
            one.tap(SOUTH)
            one.tap(SOUTH)
            check(lambda s:not s['menu'],'saved and resumed')
            wait(lambda: private('ls',slot,check=False).strip(),
                 lambda name: name==slot.encode(), 'first slot on disk')
            preview = private('cat',slot+'.png')
            assert preview.startswith(b'\x89PNG\r\n\x1a\n'), 'missing game frame preview'
            (results/'slot-1.png').write_bytes(preview)
            one.tap(MENU)
            one.tap(SOUTH)
            one.tap(WEST)
            wait(lambda: private('ls',slot+'.lock',check=False).strip(),
                 lambda name: name==(slot+'.lock').encode(), 'slot overwrite protection')
            one.tap(SOUTH)
            check(lambda s:s['menu'],'protected slot keeps the picker open')
            capture('protected-slot', (22,37,44,58))
            adb('shell','am','force-stop',PACKAGE)
            launch()
            one.tap(MENU)
            check(lambda s:s['menu'],'load menu')
            one.down()
            one.tap(SOUTH)
            one.tap(SOUTH)
            restored=check(lambda s:not s['menu'] and s['mode']==5,'restored paused game')
            for key in ('players','stage','y1','y2'):
                assert saved[key]==restored[key],key
            one.tap(START)
            two.direction(1)
            check(lambda s:s['y2']>saved['y2'],'changed P2 input after load')
            two.direction(0)
            pid=adb('shell','pidof','-s',PACKAGE).decode().strip()
            two.close()
            wait_gamepad_change(pid, b'disconnected')
            pads[1]=two=Pad(2,events)
            wait_gamepad_change(pid, b'reconnected')
            old=state()['y2']
            two.direction(-1)
            check(lambda s:s['y2']<old-3,'reconnected player 2')
            two.direction(0)
            # Switch away from a paused field so the exact positions must survive.
            one.tap(START)
            background=check(lambda s:s['mode']==5 and s['players']==2,'pause before Home')
            adb('shell','input','keyevent','KEYCODE_HOME')
            adb('shell','am','start','-W','-a','android.intent.action.MAIN',
                '-c','android.intent.category.LEANBACK_LAUNCHER','-n',PACKAGE+'/.GameActivity')
            assert adb('shell','pidof','-s',PACKAGE).decode().strip()==pid, 'foreground return restarted SDL'
            resumed=check(lambda s:s['frame']>background['frame']+6 and s['mode']==5 and s['players']==2,
                          'foreground resume')
            for key in ('stage','y1','y2'):
                assert resumed[key]==background[key], key
            (results/'audio.txt').write_bytes(adb('shell','dumpsys','media.audio_flinger'))
            capture('restored', (40,21,116,72))
            (results/'result.json').write_text(json.dumps(
                {'saved':saved,'restored':restored,'background':background,'resumed':resumed,'result':'passed'},indent=2))
    except Exception:
        # The system log identifies early SDL, linker and Java failures even
        # when the game never reaches the cartridge observer.
        diagnostic = adb('logcat', '-d', '-s', 'SDL:V', 'SDL/APP:V', 'MAME:V', 'AndroidRuntime:E',
                         'linker:E', 'libc:F', 'DEBUG:F', check=False)
        (results/'application.log').write_bytes(diagnostic)
        (results/'app-files.txt').write_bytes(private('ls','-lR','files',check=False))
        (results/'observation.txt').write_bytes(private('cat','files/tv-observation',check=False))
        capture('failure')
        lines = diagnostic.decode(errors='replace').splitlines()
        for line in lines[-30:]:
            print('Device diagnostic:', line[:500], flush=True)
        raise
    finally:
        for pad in pads: pad.close()
        (results/'logcat.txt').write_bytes(adb('logcat','-d','-t','2500'))
        adb('shell','am','force-stop',PACKAGE)
        private('rm','-f',*test_files)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('apk','labels','results'): parser.add_argument(name,type=Path)
    args=parser.parse_args()
    run(args.apk,args.labels,args.results)
