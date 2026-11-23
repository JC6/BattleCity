"""Check displayed stage tiles and replay full input-only battles in native MAME."""
import argparse
import csv
import gzip
import hashlib
import os
import re
import shutil
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
FIXTURES = HERE/'fixtures/stages'
REFERENCE = 'e1061c9241b06a965fb7845cb951d921aca010ef'
# Reference PPU tile numbers and the corresponding tiles in the independently drawn CHR.
TILES = {0x00:0, 0x20:0, 0x0f:1, 0x10:2, 0x12:3, 0x22:4, 0x21:5,
         0xc8:8, 0xca:9, 0xc9:10, 0xcb:11, 0x6a:12, 0x11:14}


def canonical(payload, classic):
    *rows, positions = payload.split('/')
    if len(rows)!=27 or len(rows[-1])!=40 or any(len(r)!=52 for r in rows[:-1]):
        raise ValueError('incomplete arena or HUD snapshot')
    if classic:
        rows = [bytes(TILES[tile] for tile in bytes.fromhex(row)).hex() for row in rows]
    return '/'.join([*rows,positions])


def compare_field(stage, want, got):
    if want==got: return
    for y,(left,right) in enumerate(zip(want.split('/'),got.split('/'))):
        if left==right: continue
        if y==27: raise ValueError(f'stage {stage}, spawn positions expected {left}, got {right}')
        for x,(a,b) in enumerate(zip(bytes.fromhex(left),bytes.fromhex(right))):
            if a!=b: raise ValueError(f'stage {stage}, row {y}, column {x}: expected {a}, got {b}')


def mame(args, work, suite, env, seconds):
    process=subprocess.run([args.mame,'nes','-cart',str(args.rom),'-video','none','-sound','none',
                            '-nothrottle','-skip_gameinfo','-seconds_to_run',str(seconds),
                            *(['-frameskip', '10'] if suite == 'campaign' else []),
                            '-autoboot_delay','0','-autoboot_script',str(HERE/(suite+'.lua'))],
                           stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,cwd=work,env=env)
    lines=process.stdout.splitlines()
    failed = next((line for line in lines if '_FAILED' in line or '[LUA ERROR]' in line),None)
    if process.returncode or failed: raise RuntimeError(failed or process.stdout)
    return lines


def fixture_base(fixtures, stage, players, suite='battle'):
    if suite in ('loop','attract'):
        return fixtures / suite
    return fixtures / (f'{stage:02d}' if players == 1 else f'{stage:02d}-coop')


REPORT_HEADER = ['cartridge_sha256','stage','players','suite','result','reference_updates','first_difference','detail']


def report_row(identity, fixtures, stage, players, suite, error):
    updates = ''
    trace = fixture_base(fixtures, stage, players, suite).with_suffix('.csv.gz')
    if suite != 'field' and trace.is_file():
        with gzip.open(trace, 'rt') as stream:
            updates = sum(',end,' not in line for line in stream)
    first = re.search(r'BATTLECITY_CAMPAIGN_FAILED \w+ update (\d+),', error)
    stage_label = {'loop':'1-70-1','attract':'demo'}.get(suite,stage)
    return [identity,stage_label,2 if suite=='attract' else players,suite,'failed' if error else 'passed',updates,
            first.group(1) if first else '',error]


def replay(args, stage, work, env):
    base = fixture_base(args.fixtures, stage, args.players, args.suite)
    recording=base.with_suffix('.pads.gz')
    trace=base.with_suffix('.csv.gz')
    updates=work/'updates.csv'
    if args.suite=='attract':
        env.update(BATTLECITY_SCENARIO='attract',BATTLECITY_GOAL='title')
        frames=12000
    else:
        tape=work/'input.pads'
        tape.write_bytes(gzip.decompress(recording.read_bytes()))
        frames=len(''.join(tape.read_text().split()))//4
        scenario='loop' if args.suite=='loop' else ('solo' if args.players==1 else 'coop')
        goal='loop' if args.suite=='loop' else 'stage-'+str(stage%70+1)
        env.update(BATTLECITY_SCENARIO=scenario,BATTLECITY_INPUT=str(tape),BATTLECITY_GOAL=goal,BATTLECITY_FOLLOW='90')
    if args.reference: env['BATTLECITY_TRACE']=str(updates)
    else:
        with gzip.open(trace,'rb') as source, updates.open('wb') as dest:
            shutil.copyfileobj(source,dest)
        env['BATTLECITY_GOLDENS']=str(updates)
    lines=mame(args,work,'campaign',env,(frames+2000)//60+10)
    if 'BATTLECITY_CAMPAIGN_OK' not in lines: raise ValueError(f'Incomplete battle: {lines[-3:]}')
    if args.reference:
        # A running verification must never see a partly written reference file.
        with tempfile.NamedTemporaryFile(dir=trace.parent, delete=False) as pending:
            with gzip.GzipFile(filename='',fileobj=pending,mode='wb',mtime=0) as dest, updates.open('rb') as source:
                shutil.copyfileobj(source,dest)
        Path(pending.name).replace(trace)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rom',type=Path)
    parser.add_argument('--labels',type=Path)
    parser.add_argument('--mame',default=os.getenv('MAME','mame'))
    parser.add_argument('--report',type=Path,help='write the result and first difference for each completed stage to CSV')
    parser.add_argument('--fixtures',type=Path,default=FIXTURES)
    parser.add_argument('--reference',action='store_true',help='capture expected results from the verified reference')
    parser.add_argument('--players', type=int, choices=(1, 2), default=1, help='controller recording for battle replays')
    parser.add_argument('--suite',choices=['field','battle','both','attract','loop'],default='both')
    parser.add_argument('--stages',type=int,nargs='+')
    args=parser.parse_args()
    if args.suite in ('loop','attract'):
        if args.stages or args.players!=1:
            parser.error('loop and attract start from power on and select their own players and stages')
        args.stages=[1]
    elif args.stages is None:
        args.stages=list(range(1,36))
    args.rom=args.rom.resolve()
    args.fixtures=args.fixtures.resolve()
    if not all(1<=n<=35 for n in args.stages): parser.error('select a stage from 1 through 35')
    if args.reference and hashlib.sha1(args.rom.read_bytes()).hexdigest()!=REFERENCE:
        parser.error('reference digest mismatch')
    if args.reference: args.fixtures.mkdir(exist_ok=True,parents=True)
    labels=(args.labels or args.rom.with_suffix('.lbl')).resolve()
    errors=[]
    if args.report:
        identity=hashlib.sha256(args.rom.read_bytes()).hexdigest()
        with args.report.open('w',newline='') as stream:
            csv.writer(stream).writerow(REPORT_HEADER)
    for stage in args.stages:
        with tempfile.TemporaryDirectory() as temporary:
            env={k:v for k,v in os.environ.items() if not k.startswith('BATTLECITY_')}
            env.update(SDL_VIDEODRIVER='dummy', BATTLECITY_STAGE=str(stage),
                       BATTLECITY_CLASSIC=str(int(args.reference)),BATTLECITY_LABELS=str(labels))
            detail=''
            try:
                if args.suite in ('field','both'):
                    rows=mame(args,temporary,'stage-field',env,28)
                    prefix='BATTLECITY_STAGE_FIELD '
                    payload=canonical(next(r[len(prefix):] for r in rows if r.startswith(prefix)),args.reference)
                    fixture=args.fixtures/f'{stage:02d}.field'
                    if args.reference: fixture.write_text(payload+'\n')
                    else: compare_field(stage,fixture.read_text().strip(),payload)
                if args.suite!='field':
                    replay(args,stage,Path(temporary),env)
                print(f'{stage:02d} {args.suite} passed',flush=True)
            except (RuntimeError,OSError,ValueError,StopIteration) as error:
                detail=str(error) or type(error).__name__
                errors.append((stage,detail))
                print(f'{stage:02d} {args.suite} failed: {detail}',flush=True)
            if args.report:
                with args.report.open('a',newline='') as stream:
                    csv.writer(stream).writerow(report_row(identity,args.fixtures,stage,args.players,args.suite,detail))
    if errors: raise SystemExit(1)


if __name__=='__main__': main()
