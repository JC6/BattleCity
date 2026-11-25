"""Run the installed SDL/MAME TV app with two Android kernel gamepads (dedicated test device)."""
import argparse
import gzip
import math
import shlex
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


def wait(read, predicate, description, interval=.15):
    deadline = time.monotonic() + TIMEOUT
    last = None
    while time.monotonic() < deadline:
        last = read()
        if predicate(last):
            return last
        time.sleep(interval)
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

    def tap_hat(self, axis, value):
        # Host adb acknowledgments can take long enough to trigger UI repeat.
        self.event(3, axis, value)
        self.send({'command':'delay','duration':120})
        self.event(3, axis, 0)
        presented(5)

    def down(self):
        self.tap_hat(17, 1)

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
    rewind = Path(__file__).with_name('rewind-state.lua').read_text()
    return f"""
local function checkpoint_report(kind,stamp,matched)
    local f=assert(io.open("{directory}/rewind.csv","a"))
    f:write(string.format("%s,%.8f,%d\\n",kind,stamp,matched))
    f:close()
end
{rewind}
local ram=manager.machine.devices[":maincpu"].spaces.program
local tick,p1,p2=0,0,0
emu.register_frame_done(function()
  tick=tick+1
  if ram:read_u8({addresses['shots']+3})==1 then p1=tick end
  if ram:read_u8({addresses['shots']+7})==1 then p2=tick end
  if tick%3~=0 then return end
  local file=assert(io.open("{directory}/tv-observation.tmp","w"))
  file:write(table.concat({{{reads},manager.ui.menu_active and 1 or 0,p1,p2,tick,math.floor(manager.machine.time:as_double()*1000000)}},','))
  file:close()
  assert(os.rename("{directory}/tv-observation.tmp","{directory}/tv-observation"))
end)
"""


def state():
    raw = private('cat','files/tv-observation',check=False).strip()
    if not re.fullmatch(rb'[0-9]+(,[0-9]+){14}', raw):
        return {}
    keys = 'mode players selection stage scroll y1 y2 shot1 shot2 ready menu fire1 fire2 frame emu_us'.split()
    return dict(zip(keys,map(int,raw.split(b','))))


def check(predicate, description):
    return wait(state, lambda row: row and predicate(row), description)


def open_system_menu(pad):
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        if state().get('menu'): return
        pad.event(1, MENU, 1)
        try:
            until = time.monotonic() + 1.5
            while time.monotonic() < until:
                if state().get('menu'): return
                time.sleep(.08)
        finally:
            pad.event(1, MENU, 0)
            presented(4)
    raise RuntimeError('left shoulder failed to open the system menu')


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


def screen_rgb(image, size):
    return subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', 'pipe:0',
                           '-vf', f'scale={size}', '-frames:v', '1', '-threads', '1',
                           '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                          input=image, capture_output=True, check=True).stdout


def credits_title_y(image):
    # Only the collection title has saturated cyan lettering on a black page.
    rgb = screen_rgb(image, '320:180')
    corner = (320 * 8 + 25) * 3
    if max(rgb[corner:corner+3]) > 12:
        return None
    rows = []
    for y in range(23, 158):
        for x in range(70, 250):
            offset = (320*y+x)*3
            r, g, b = rgb[offset:offset+3]
            if g > 62 and r*4 < g < b < 2*g:
                rows.append(y)
    return sum(rows) / len(rows) if len(rows) >= 30 else None


def shows_brick(image, bounds):
    # Sample the composited TV screen, including the thumbnail in the first slot.
    rgb = screen_rgb(image, '160:90')
    assert len(rgb) == 160 * 90 * 3
    left, top, right, bottom = bounds
    count = 0
    for y in range(top, bottom):
        for x in range(left, right):
            i = (160 * y + x) * 3
            r, g, b = rgb[i:i+3]
            count += r > 85 and r > 1.3 * g and g > 1.3 * b
    return count >= 12


def measure_clock(results):
    path = 'files/tv-audio.wav'
    header = private('head', '-c', '44', path)
    channels, rate = struct.unpack_from('<HI', header, 22)
    assert channels in (1, 2) and rate > 0

    def sample():
        before = time.monotonic()
        snapshot = check(lambda row: not row['menu'], 'active TV clock')
        size = int(private('stat', '-c', '%s', path))
        return (before + time.monotonic()) / 2, snapshot, size

    rows = []
    wall, state_before, size = sample()
    for run in range(1, 4):
        time.sleep(30)
        now, current, end_size = sample()
        interval = now-wall
        elapsed = (current['emu_us']-state_before['emu_us']) / 1e6
        pcm = (end_size-size)/(2*channels*rate)
        rows.append(dict(run=run, wall=interval, emu=elapsed, frames=current['frame']-state_before['frame'],
                         pcm=pcm, sampleRate=rate, speed=elapsed/interval, audioSpeed=pcm/interval))
        wall, state_before, size = now, current, end_size
    (results/'clock.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
    assert all(row['emu'] > 0 and abs(row['pcm']-row['emu']) < .2 for row in rows)


def ending_trace(route):
    # ending.lua writes the CSV on completion and has its own 3,900-frame
    # limit. Slow AVDs can take longer than the host timeout to reach it.
    last_size = 0
    byte_rate = 0
    last_progress = time.monotonic()
    while time.monotonic() - last_progress < TIMEOUT:
        trace = private('cat', 'files/ending.csv', check=False)
        if trace.startswith(b'frame,emu_s,event,value') and b',title,' in trace:
            return trace
        size_text = private('stat', '-c', '%s', 'files/ending.wav', check=False).strip()
        size = int(size_text) if size_text.isdigit() else 0
        if size > last_size:
            if not byte_rate:
                header = private('head', '-c', '44', 'files/ending.wav', check=False)
                if len(header) == 44 and header[:4] == b'RIFF':
                    byte_rate, = struct.unpack_from('<I', header, 28)
            if byte_rate and size - 44 > byte_rate * 66:
                raise RuntimeError(f'TV ending {route} passed the cartridge fixture frame limit without a trace')
            last_size = size
            last_progress = time.monotonic()
        time.sleep(.5)
    raise RuntimeError(f'TV ending {route} stalled at {last_size} WAV bytes')


def record_endings(labels, directory, results, write_private):
    script = Path(__file__).with_name('ending.lua').read_text()
    write_private('ending.lbl', labels.read_text())
    for route in ('neutral', 'record', 'skip-over'):
        adb('shell','am','force-stop',PACKAGE)
        private('rm','-f','files/ending.csv','files/ending.wav')
        values = {'BATTLECITY_LABELS':directory+'/ending.lbl','BATTLECITY_SCENARIO':'base',
                  'BATTLECITY_END_INPUT':route,'BATTLECITY_AV_TRACE':directory+'/ending.csv'}
        entries = ','.join('['+json.dumps(k)+']='+json.dumps(v) for k,v in values.items())
        # SDL has no process environment arguments for Lua in the Leanback launcher.
        shim = 'local getenv=os.getenv; local env={'+entries+'}; os.getenv=function(k) return env[k] or getenv(k) end\n'
        write_private('tv-observer.lua', shim + script)
        write_private('nes.ini',f'autoboot_delay 0\nautoboot_script {directory}/tv-observer.lua\nwavwrite {directory}/ending.wav\n')
        adb('shell','am','start','-W','-a','android.intent.action.MAIN',
            '-c','android.intent.category.LEANBACK_LAUNCHER','-n',PACKAGE+'/.GameActivity')
        trace = ending_trace(route)
        out = results/('tv-'+route)
        out.mkdir(exist_ok=True)
        (out/'events.csv').write_bytes(trace)
        def finished_wav():
            raw = private('cat','files/ending.wav',check=False)
            return raw if len(raw)>44 and raw[:4]==b'RIFF' and struct.unpack_from('<I',raw,4)[0]==len(raw)-8 else None
        (out/'game.wav').write_bytes(wait(finished_wav, bool, 'closed TV WAV '+route))


def launch():
    private('rm','-f','files/tv-observation')
    adb('shell','am','start','-W','-a','android.intent.action.MAIN',
        '-c','android.intent.category.LEANBACK_LAUNCHER','-n',PACKAGE+'/.GameActivity')
    check(lambda s:s['mode']==0 and not s['scroll'] and s['ready'], 'cold title')


def start_fixture():
    adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN',
        '-c', 'android.intent.category.LEANBACK_LAUNCHER', '-n', PACKAGE+'/.GameActivity')


def render_fixture(labels, directory, tick, freeze=False, scene=None):
    mode = int(re.search(r'^al (\w+) \._mode$', labels.read_text(), re.M)[1], 16)
    controls = Path(__file__).with_name('clock-input.lua').read_text()
    scenario = ''
    if scene:
        assert scene in ('firing','motion','blast')
        names = ('tanks','shots','shot_fast','tread','ruined')
        addresses = {key:int(value,16) for value,key in re.findall(r'^al (\w+) \._(\w+)$',labels.read_text(),re.M)}
        definitions = ','.join(f'{key}={addresses[key]}' for key in names)
        scenario = f'\nlocal scene="{scene}"\nlocal addr={{{definitions}}}\n' + Path(__file__).with_name('tv-scenes.lua').read_text()
    scene_check = f"""
    local ok,reason=pcall(verify_scene)
    if not ok then
        local output=assert(io.open("{directory}/tv-fixed","w"))
        output:write("ERROR "..tostring(reason))
        output:close()
        emu.pause()
        return
    end""" if scene else ''
    return controls + scenario + f"""
local ram = manager.machine.devices[":maincpu"].spaces.program
local frames = 0
visual_fixture = emu.add_machine_frame_notifier(function()
    frames = frames + 1
    {'update_scene(frames)' if scene else ''}
    if frames ~= {tick} then return end
    {scene_check}
    local hash = 0
    for address=0,2047 do hash = (hash * 33 + ram:read_u8(address)) & 0xffffffff end
    local handle = assert(io.open("{directory}/tv-fixed", "w"))
    handle:write(string.format("%d,%d,%08x", frames, ram:read_u8({mode}), hash))
    handle:close()
    {'emu.pause()' if freeze else ''}
end)
"""


def compare_raster(base, other, w, h, width, height):
    changed = outside = significant = largest = 0
    x0, y0 = (w-width)//2, (h-height)//2
    for i in range(0,len(base),3):
        old,new = base[i:i+3],other[i:i+3]
        if old==new: continue
        changed += 1
        diff = max(abs(a-b) for a,b in zip(old,new))
        largest = max(largest,diff)
        significant += diff>8
        y,x = divmod(i//3,w)
        outside += not (x0<=x<x0+width and y0<=y<y0+height)
    return {'differentOutputPixels':changed,'deltaAbove8':significant,'differentWallpaperPixels':outside,
            'maxChannelError':largest,'identical':changed==0}


def calibration_grid(rgb, screen_width, xs, ys):
    def sample(x, y):
        offset=3*(ys[y]*screen_width+xs[x])
        return rgb[offset:offset+3]
    expected=('000000','ffffff','ff0000','00ff00','0000ff','cc7f35','456789','808080')
    bars=[sample(16+i*32,40) for i in range(8)]
    colour_error=max(abs(x-y) for a,b in zip(bars,expected) for x,y in zip(a,bytes.fromhex(b)))
    # A white column every 17 source pixels gives 30 transitions across 256 pixels.
    transitions=[]
    for y in (145,160,175):
        white=[min(sample(x,y))>220 for x in range(256)]
        transitions.append(sum(a!=b for a,b in zip(white,white[1:])))
    horizontal=sum(min(sample(7,y))>220 for y in range(140,218))
    return {'bars':[b.hex() for b in bars],'largestColorError':colour_error,
            'verticalTransitions':transitions,'whiteRowsIn78':horizontal,
            'valid':colour_error<=8 and 30 in transitions and 5<=horizontal<=7}


def record_render(results, labels, directory, write_private, scenes_only=False, prototype=False, held_out=False, formal=False):
    ini = (f'autoboot_delay 0\nautoboot_script {directory}/tv-observer.lua\n'
           'autoframeskip 0\nframeskip 0\npause_brightness 1.0\n')
    # A missing override exercises the installed candidate's packaged default.
    modes = {'baseline':'none', 'gpu-full':'gpu-full', 'native':'native-tv',
             'candidate':None, 'low-buffer':'surface-tv'}
    if formal:
        modes = {'candidate':None}
    if prototype:
        modes = {'battle':None, 'explosions':None}
    def select(mode, scale):
        if mode == 'low-buffer':
            write_private('tv-low-buffer', '1')
        else:
            private('rm','-f','files/tv-low-buffer')
        write_private('nes.ini', ini + (f'scalemode {scale}\n' if scale else ''))
    def stop():
        adb('shell','am','force-stop',PACKAGE)
        private('rm','-f','files/tv-fixed','files/tv-profile.jsonl','files/tv-capture','files/tv-expanded.ppm','files/tv-source.ppm','files/tv-expanded.tmp')
    def marker():
        last_launch = time.monotonic()
        def read():
            nonlocal last_launch
            stamp = private('cat','files/tv-fixed',check=False).decode().strip()
            if stamp.startswith('ERROR '): raise RuntimeError(stamp)
            if re.fullmatch(r'\d+,1,[a-f0-9]{8}',stamp):
                return stamp
            # The API 34 launcher can asynchronously open its first-run store
            # dialog over a newly resumed game. Recover only that known window.
            focus = adb('shell','dumpsys','window','displays').decode(errors='replace')
            current = next((line for line in focus.splitlines() if 'mCurrentFocus=' in line),'')
            if 'com.google.android.tvlauncher/' in current and time.monotonic()-last_launch>2:
                if 'ShowDialogsActivity' in current:
                    adb('shell','input','keyevent','KEYCODE_BACK')
                start_fixture()
                last_launch = time.monotonic()
            return None
        return wait(read,bool,'fixed solo battle frame',interval=.8)
    def profile_rows():
        raw = private('cat','files/tv-profile.jsonl',check=False)
        return [json.loads(line) for line in raw.splitlines(keepends=True) if line.endswith(b'\n')]
    summaries = {}
    markers = {}
    for name, scale in (() if scenes_only else modes.items()):
        stop()
        select(name, scale)
        fixture = render_fixture(labels, directory, 560)
        if name == 'explosions':
            addresses = dict((k,int(v,16)) for v,k in re.findall(r'^al (\w+) \._(\w+)$',labels.read_text(),re.M))
            fixture += f'\nlocal mode_address={addresses["mode"]}\nlocal tank_address={addresses["tanks"]}\n'
            fixture += f'local stress_path="{directory}/tv-stress"\n'+Path(__file__).with_name('tv-blast-load.lua').read_text()
        write_private('tv-observer.lua',fixture)
        write_private('tv-profile.jsonl','')
        start_fixture()
        markers[name] = marker()
        print('Measuring full frames:', name, markers[name], flush=True)
        rows = []
        for number in range(1,2 if prototype else 4):
            rows = wait(profile_rows, lambda r: len(r)>=number, f'{name} 30-second window {number}',interval=1.0)
            (results/(name+'.jsonl')).write_bytes(private('cat','files/tv-profile.jsonl'))
        assert [r['run'] for r in rows]==([1] if prototype else [1,2,3])
        for row in rows:
            assert row['wall']>=30 and row['frames']>0 and row['sampleRate']>0 and row['samples']>0, row
            assert row['driver'] and 0<row['presented']<=row['attempts'], row
            row['gameSpeed'] = row['emu']/row['wall']
            row['pcmSpeed'] = row['samples']/row['sampleRate']/row['wall']
            row['pass'] = (0.99<=row['gameSpeed']<=1.01 and 0.99<=row['pcmSpeed']<=1.01
                           and row['presented']==row['attempts'] and row['presented']==row['frames'])
        if name == 'explosions':
            assert int(private('cat','files/tv-stress')) >= 720, 'blast fixture never ran in battle'
        summaries[name] = rows
        layers = adb('shell','dumpsys','SurfaceFlinger','--list').decode().splitlines()
        prefix = results/(name+'-surface.txt')
        with prefix.open('wb') as f:
            for layer in layers:
                if PACKAGE in layer and 'SurfaceView' in layer:
                    f.write((layer+'\n').encode())
                    f.write(adb('shell','dumpsys','SurfaceFlinger','--latency',shlex.quote(layer),check=False))
        # The foreground process and GL context are already warm. This trace
        # starts after every wall-clock sample and cannot perturb its counters.
        with gzip.open(results/(name+'-atrace.txt.gz'),'wb') as output:
            output.write(adb('shell','atrace','-b','4096','-t','3','-a',PACKAGE,'gfx',check=False))
    if not scenes_only:
        assert len(set(markers.values()))==1, markers
        (results/'clock.json').write_text(json.dumps({'battle':markers,'windows':summaries},indent=2))
    if prototype:
        stop()
        return
    # Separate launches keep the frozen visual fixtures out of the clock samples.
    display = 'shared_prefs/display.xml'
    stop()
    existed = private('ls','-d',display,check=False).strip()==display.encode()
    original = private('cat',display) if existed else None
    private('mkdir','-p','shared_prefs')
    def set_display(data):
        adb('shell','-T','run-as',PACKAGE,'sh','-c',f"'cat > {display}'",data=data)
        assert private('cat',display)==data
    cases = [('standard',0,0,0),('large',1,0,0),('pixel',2,0,0),('stretch',3,0,0),
             ('antialias',0,1,1),('scanlines',0,2,2)]
    if scenes_only:
        cases = [('firing',0,0,0),('blast',0,0,0)]
    if held_out:
        cases = [('moving-626',0,0,0),('moving-633',0,0,0),('moving-648',0,0,0),('calibration',0,0,0),('blast-700',0,0,0)]
    visual = {}
    small_visual = {}
    try:
        for case,aspect,picture,wallpaper in cases:
            pair = {}
            outputs = [('baseline','none'),('repeat','none'),('candidate',None)]
            if not (held_out or formal):
                outputs.append(('low-buffer','surface-tv'))
            for name,scale in outputs:
                stop()
                set_display((f'<map><int name="mode" value="{aspect}"/><int name="picture" value="{picture}"/>'
                             f'<int name="wallpaper" value="{wallpaper}"/></map>').encode())
                select(name, scale)
                tick = {'firing':621,'blast':696,'moving-626':626,'moving-633':633,'moving-648':648,'blast-700':700,'calibration':626}.get(case,705)
                write_private('tv-observer.lua',render_fixture(labels,directory,tick,True,("blast" if case=="blast-700" else "motion" if held_out else case) if scenes_only else None))
                stages = held_out and (name in ('baseline','candidate','repeat') or case=='calibration')
                if stages:
                    write_private('tv-capture','P' if case=='calibration' else 'G')
                start_fixture()
                try:
                    fingerprint = marker()
                except RuntimeError:
                    (results/f'{case}-{name}-foreground.txt').write_bytes(adb('shell','dumpsys','window','displays'))
                    (results/f'{case}-{name}-failure.png').write_bytes(adb('exec-out','screencap','-p'))
                    raise
                if stages:
                    wait(lambda: private('ls','files/tv-expanded.ppm',check=False).strip(),
                         lambda data:data==b'files/tv-expanded.ppm','frozen raster stages')
                    for stage in ('source','expanded'):
                        data=private('cat',f'files/tv-{stage}.ppm')
                        header,dimensions,scale,pixels=data.split(b'\n',3)
                        sw,sh=map(int,dimensions.split())
                        assert header==b'P6' and scale==b'255' and len(pixels)==3*sw*sh
                        (results/f'{case}-{name}-{stage}.ppm.gz').write_bytes(gzip.compress(data,mtime=0))
                time.sleep(.4)
                png = adb('exec-out','screencap','-p')
                assert png.startswith(b'\x89PNG')
                (results/f'{case}-{name}.png').write_bytes(png)
                w,h = struct.unpack('>II',png[16:24])
                rgb = screen_rgb(png,f'{w}:{h}')
                pair[name] = (fingerprint,w,h,rgb)
            stamp,w,h,base = pair['baseline']
            repeat = pair['repeat'][3]
            assert all(item[:3]==(stamp,w,h) for item in pair.values())
            ratio = 256/224 if aspect==2 else 4/3
            width = w if aspect==3 else min(w,math.floor(h*(1 if aspect==1 else .83)*ratio+.5))
            height = h if aspect==3 else math.floor(width/ratio+.5)
            xs = [int((w-width)/2+(x+.5)*width/256) for x in range(256)]
            ys = [int((h-height)/2+(y+.5)*height/224) for y in range(224)]
            pixels = [3*(y*w+x) for y in ys for x in xs]
            noise = compare_raster(base,repeat,w,h,width,height)
            for mode,output in [('candidate',visual),('low-buffer',small_visual)]:
                if mode not in pair: continue
                other = pair[mode][3]
                mismatches = sum(base[i:i+3]!=other[i:i+3] for i in pixels)
                excess = sum(any(abs(a-c)>abs(a-b) for a,b,c in zip(base[i:i+3],repeat[i:i+3],other[i:i+3]))
                             for i in range(0,len(base),3) if base[i:i+3]!=other[i:i+3])
                output[case] = {'battle':stamp,'size':[w,h],'nativePixels':len(pixels),'differentCenters':mismatches,
                                'aboveRepeatNoise':excess,'repeat':noise,**compare_raster(base,other,w,h,width,height)}
                if case=='calibration':
                    reference=calibration_grid(base,w,xs,ys)
                    assert reference['valid'],reference
                    output[case]['referenceCalibration']=reference
                    output[case]['calibration']=calibration_grid(other,w,xs,ys)
                dest = 'visual.json' if mode=='candidate' else 'low-buffer.json'
                (results/dest).write_text(json.dumps(output,indent=2))
    finally:
        stop()
        if existed: set_display(original)
        else: private('rm','-f',display)


def run(apk, labels, results, suite, previous=None, formal=False):
    results.mkdir(parents=True,exist_ok=True)
    adb('install','-r',str(previous or apk))
    directory = private('pwd').decode().strip()+'/files'
    private('mkdir','-p','files')
    with ZipFile(apk) as package:
        digest = package.read('assets/cartridge.id').decode('ascii')
    if not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid bundled cartridge identity')
    current_slot = f'files/states/{digest}/nes/1.sta'
    slot = current_slot
    if previous:
        with ZipFile(previous) as package:
            prior = package.read('assets/cartridge.id').decode('ascii')
        assert re.fullmatch(r'[a-f0-9]{64}',prior)
        slot = f'files/states/{prior}/nes/1.sta'
    # Leave existing player files intact. A completed run removes its own slot.
    test_files = ['files/'+name for name in ('nes.ini','tv-observer.lua','tv-observation',
                                               'tv-observation.tmp','tv-audio.wav','ending.csv','ending.lbl','ending.wav','rewind.csv','tv-profile.jsonl','tv-fixed','tv-low-buffer','tv-capture','tv-expanded.ppm','tv-source.ppm','tv-expanded.tmp')]
    test_files.extend((slot,slot+'.png',slot+'.lock'))
    if slot!=current_slot: test_files.extend((current_slot,current_slot+'.png',current_slot+'.lock'))
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
        if suite in ('render','scenes','prototype','held-out'):
            record_render(results,labels,directory,write_private,scenes_only=suite in ('scenes','held-out'),
                          prototype=suite=='prototype',held_out=suite=='held-out',formal=formal)
            return
        write_private('tv-observer.lua',observer(labels,directory))
        ini=f'autoboot_delay 0\nautoboot_script {directory}/tv-observer.lua\nwavwrite {directory}/tv-audio.wav\n'
        if suite == 'controls': ini+='scalemode none\n'
        if suite == 'auto-frameskip': ini+='autoframeskip 1\n'
        write_private('nes.ini',ini)
        (results/'device.txt').write_bytes(adb('shell','getprop'))
        if suite in ('timing','auto-frameskip'):
            adb('shell','am','force-stop',PACKAGE)
            clock_input = Path(__file__).with_name('clock-input.lua').read_text()
            write_private('tv-observer.lua', clock_input+'\n'+observer(labels,directory))
            launch()
            check(lambda s:s['emu_us']>=9_000_000 and s['mode']==1,'clock entry into solo battle')
            measure_clock(results)
            if suite == 'timing': record_endings(labels, directory, results, write_private)
            return
        with (results/'gamepads.jsonl').open('w') as events:
            for n in (1,2):
                pads.append(Pad(n,events))
            one,two=pads
            launch()
            capture('title')
            open_system_menu(one)
            # A presented SDL frame does not guarantee the next menu has opened.
            # Wait for its cyan cursor before sending another directional edge.
            check(lambda s:s['menu'],'system menu opened')
            capture('system-menu')
            save_button=(.389,.164,.222,.061)
            load_button=(.389,.253,.222,.061)
            settings_button=(.262,.702,.221,.061)
            screen_card=(.106,.350,.180,.215)
            staff_card=(.106+.203*3,.350,.180,.215)
            def focused(rect):
                rgb=screen_rgb(adb('exec-out','screencap','-p'),'320:180')
                x,y,w,h=rect
                corners=0
                for a in (x-.004,x+w+.004):
                    for b in (y-.008,y+h+.008):
                        cx,cy=round(a*320),round(b*180)
                        count=0
                        for yy in range(cy-4,cy+5):
                            for xx in range(cx-5,cx+6):
                                r,g,blue=rgb[3*(320*yy+xx):3*(320*yy+xx)+3]
                                count+=g>95 and blue>120 and blue-r>70 and g-r>35
                        corners+=count>=2
                return corners>=3
            def reach(rect,action,label):
                for _ in range(12):
                    if focused(rect): return
                    action()
                raise RuntimeError('gamepad did not reach '+label)
            wait(lambda:focused(save_button),bool,'initial Save cursor')
            reach(settings_button,one.down,'Settings')
            reach(screen_card,lambda:one.tap(SOUTH),'Screen Settings card')
            one.tap(SOUTH)
            def shooter_width():
                image=adb('exec-out','screencap','-p')
                rgb=screen_rgb(image,'320:180')
                xs=[x for y in range(33,78) for x in range(122,198)
                    if (lambda r,g,b: (r>60 and g>115 and b<65) or (35<r<90 and g<95 and b>150))(
                        *rgb[(320*y+x)*3:(320*y+x)*3+3])]
                return max(xs)-min(xs)+1 if xs else 0
            def select_width(width):
                for _ in range(8):
                    if abs(shooter_width()-width)<=3: return
                    one.tap_hat(16,1)
                    one.tap(SOUTH)
                raise RuntimeError('screen sample did not reach width '+str(width))
            wait(shooter_width,lambda w:abs(w-36)<=3,'default screen sample')
            for width in (41,31,64): select_width(width)
            capture('screen-settings')
            select_width(36)
            one.tap(EAST)
            reach(staff_card,lambda:one.tap_hat(16,-1),'Staff Credits card')
            one.tap(SOUTH)
            def read_credits():
                image=adb('exec-out','screencap','-p')
                return credits_title_y(image), image
            y, _ = wait(read_credits, lambda frame: frame[0] is not None and frame[0] > 70,
                        'cyan collection title above the bottom border')
            _, credit_image = wait(read_credits, lambda frame: frame[0] is not None and frame[0] < y-12,
                                   'collection title visibly moved upward')
            (results/'staff-credits.png').write_bytes(credit_image)
            one.direction(1)
            try:
                time.sleep(21)
                capture('staff-credits-middle')
                time.sleep(37.5)
                def final_card():
                    image=adb('exec-out','screencap','-p')
                    rgb=screen_rgb(image,'320:180')
                    points=[(x,y) for y in range(180) for x in range(320)
                            if min(rgb[(320*y+x)*3:(320*y+x)*3+3])>95]
                    return image if (points and 86<=min(y for x,y in points)<=91
                            and max(y for x,y in points)<=95 and min(x for x,y in points)<100
                            and max(x for x,y in points)>220) else None
                final=wait(final_card, bool, 'centered final producer card')
                (results/'staff-credits-final.png').write_bytes(final)
            finally:
                one.direction(0)
            time.sleep(4.5)
            for _ in range(2):
                one.tap(EAST)
            check(lambda s:not s['menu'],'return from staff credits to the title')
            one.tap(START)
            check(lambda s:s['mode']==6,'solo stage selection')
            one.tap(START)
            check(lambda s:s['mode']==1 and s['players']==1,'solo battlefield')
            settled=check(lambda s:s['y1']==192,'solo spawn')
            check(lambda s:s['frame']>=settled['frame']+150,'rewind history')
            one.direction(-1)
            advanced=check(lambda s:s['y1']<=152,'travel before rewind')
            one.direction(0)
            # Schedule both shoulder taps on the device. Host-side screenshots
            # or adb polling between them can span a whole checkpoint interval.
            for _ in range(2):
                one.event(1,REWIND,1)
                one.send({'command':'delay','duration':90})
                one.event(1,REWIND,0)
                one.send({'command':'delay','duration':90})
            check(lambda s:s['y1']>advanced['y1'] and not s['menu'],'direct shoulder rewind')
            def restored_twice():
                trace=private('cat','files/rewind.csv',check=False).decode()
                loads=[row.split(',') for row in trace.splitlines() if row.startswith('load,')]
                if len(loads)<2: return None
                assert all(row[2]=='1' for row in loads[-2:]), 'restored work RAM differs'
                assert float(loads[-1][1])<float(loads[-2][1]), 'second shoulder rewind did not go back'
                return trace
            trace=wait(restored_twice,bool,'two direct shoulder rewinds')
            (results/'rewind.csv').write_text(trace)
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
            open_system_menu(one)
            check(lambda s:s['menu'],'save menu')
            one.tap(SOUTH)
            one.tap(SOUTH)
            check(lambda s:s['menu'],'pending save confirmation')
            capture('save-confirmation')
            one.tap(SOUTH)
            check(lambda s:not s['menu'],'saved and resumed')
            wait(lambda: private('ls',slot,check=False).strip(),
                 lambda name: name==slot.encode(), 'first slot on disk')
            preview = private('cat',slot+'.png')
            assert preview.startswith(b'\x89PNG\r\n\x1a\n'), 'missing game frame preview'
            (results/'slot-1.png').write_bytes(preview)
            open_system_menu(one)
            one.tap(SOUTH)
            one.tap(WEST)
            wait(lambda: private('ls',slot+'.lock',check=False).strip(),
                 lambda name: name==(slot+'.lock').encode(), 'slot overwrite protection')
            one.tap(SOUTH)
            check(lambda s:s['menu'],'protected slot keeps the picker open')
            capture('protected-slot', (22,37,44,58))
            adb('shell','am','force-stop',PACKAGE)
            if previous:
                import hashlib
                before = private('cat',slot)
                adb('install','-r',str(apk))
                assert before==private('cat',slot) and preview==private('cat',slot+'.png')
                assert private('ls',slot+'.lock').strip()==(slot+'.lock').encode()
            launch()
            if previous:
                assert wait(lambda: private('cat',current_slot,check=False),lambda data: data==before,'copied previous slot')==before
                assert private('cat',current_slot+'.png')==preview and private('ls',current_slot+'.lock',check=False).strip()==(current_slot+'.lock').encode()
                assert private('cat',slot)==before and private('cat',slot+'.png')==preview
                (results/'upgrade.json').write_text(json.dumps({'slotSha256':hashlib.sha256(before).hexdigest(),
                                                              'previousCartridge':prior,'cartridge':digest,
                                                              'thumbnailPreserved':True,'lockPreserved':True}))
            open_system_menu(one)
            check(lambda s:s['menu'],'load menu')
            reach(load_button,one.down,'Load')
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
    parser.add_argument('--suite',action='append',choices=('controls','timing','auto-frameskip','render','scenes','candidate-controls','prototype','held-out'))
    parser.add_argument('--formal',action='store_true',help='measure the packaged candidate and capture its software reference')
    parser.add_argument('--record-candidate-failure',action='store_true',
                        help='record a failing optional candidate control run for the release selector')
    parser.add_argument('--previous',type=Path)
    parser.add_argument('--stable',type=Path)
    args=parser.parse_args()
    errors=[]
    for suite in args.suite or ('controls','timing','render','scenes','candidate-controls'):
        folder=args.results if suite=='controls' else args.results/suite
        try:
            app = args.stable if suite=='controls' and args.stable else args.apk
            run(app,args.labels,folder,suite,args.previous if suite=='controls' else None,formal=args.formal)
        except Exception as error:
            if args.record_candidate_failure and suite=='candidate-controls':
                folder.mkdir(parents=True,exist_ok=True)
                (folder/'result.json').write_text(json.dumps({'result':'failed','error':str(error)})+'\n')
                print('::warning::Candidate controls failed: '+str(error),flush=True)
            else:
                errors.append(error)
    if errors:
        raise ExceptionGroup('Android TV acceptance',errors)
