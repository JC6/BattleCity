"""Reproduce the Switch comparison from extracted GitHub Actions artifacts."""
import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import shutil
import sys
from html import escape
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests/nes'))
from ending_parity import BASELINE as ENDING_BASELINE, ROUTES, verify as verify_endings
from native_window_report import picture, rows, table
from package import verify
from switch_menu_acceptance import FIXTURE, FOCUS_FIXTURE, control_samples, measure
from switch_shell_capture import FIXTURE as SHELL_FIXTURE, report as shell_report
from tv_release_gate import decision
from tv_swap_report import sections


def sha(file):
    with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def add_evidence(archive,name,source=None,data=None):
    # A GitHub artifact can be extracted on any filesystem. Archive order,
    # permissions and timestamps must not depend on the extraction machine.
    info=ZipInfo(Path(name).as_posix(),(1980,1,1,0,0,0))
    info.create_system=3
    info.external_attr=0o100644<<16
    info.compress_type=ZIP_DEFLATED
    with archive.open(info,'w') as target:
        if source is None:
            target.write(data)
        else:
            with source.open('rb') as stream:
                shutil.copyfileobj(stream,target)


def certificate(signer,apk):
    output=subprocess.check_output([signer,'verify','--print-certs',str(apk)],text=True)
    match=re.search(r'^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})$',output,re.M)
    if not match:raise ValueError(f'Missing APK signer for {apk}')
    return match[1]


def package(run,previous,out,identity,arm_dir=None,signer=None,reference_arm=None):
    out.mkdir(parents=True,exist_ok=True)
    tv=run/'tv-device-results'
    ending_counts=verify_endings(run/'web-clock-and-endings',tv/'timing')
    gate=decision(tv,renderer='egl-tv')
    assert gate==json.loads((tv/'release-gate.json').read_text())
    tested={path:digest for digest,path in (line.split() for line in gate['tested'].splitlines())}
    cartridge=run/'cartridge/game.nes'
    digest=sha(cartridge)
    assert tested['build/shared/game.nes']==digest
    expected_certificate=certificate(signer,reference_arm) if arm_dir else None
    promoted=gate['default']=='egl-tv'
    files={'game.nes':cartridge,'game.lbl':run/'cartridge/game.lbl',
           'BattleCity-Web.zip':run/'game-web/BattleCity-Web.zip'}
    verify(files['BattleCity-Web.zip'],cartridge)
    for candidate in (False,True):
        tag='-candidate' if candidate else ''
        label='' if promoted==candidate else '-Baseline' if promoted else '-Candidate'
        for abi,folder,base,dest in [('x86','game-tv-emulator','tv-emulator','BattleCity-TV-x86'),
                                      ('arm64-v8a','game-tv','tv','BattleCity-TV')]:
            source=run/folder/(base+tag+'.apk')
            if abi=='x86':assert sha(source)==tested['deliverable/'+source.name]
            if abi=='arm64-v8a' and arm_dir:
                signed=arm_dir/source.name
                # Re-signing may change ZIP layout. Check every payload entry.
                def payload(path):
                    with ZipFile(path) as z:return {f:hashlib.sha256(z.read(f)).digest() for f in z.namelist()
                                                    if not f.endswith('/') and not f.startswith('META-INF/')}
                assert certificate(signer,signed)==expected_certificate and payload(signed)==payload(source)
                source=signed
            verify(source,cartridge,abi)
            files[dest+label+'.apk']=source
    stages=[r for n in range(5) for r in rows(run/f'stage-replay-{n}/stages.csv')]
    assert {int(r['stage']) for r in stages}==set(range(1,36)) and len(stages)==35
    loop=rows(run/'campaign-loop/loop.csv')
    assert len(loop)==1 and loop[0]['stage']=='1-70-1'
    assert all(r['result']=='passed' and r['cartridge_sha256']==digest for r in stages+loop)
    clocks=[]
    for engine in ('chromium','webkit'):
        assert 'passed previous-release save upgrade' in (run/f'upgrade-{engine}/upgrade-{engine}.log').read_text()
        for hz in ('native','60','120'):
            data=[json.loads(l) for l in (run/f'web-clock-and-endings/{engine}-{hz}.jsonl').read_text().splitlines() if l.startswith('{')]
            data=[r for r in data if 'run' in r]
            assert [r['run'] for r in data]==[1,2,3]
            assert all(.99<=r['speed']<=1.01 and .99<=r['audioSpeed']<=1.01 for r in data)
            clocks.extend(data)
    upgrade=json.loads((tv/'upgrade.json').read_text())
    assert upgrade['cartridge']==digest and upgrade['thumbnailPreserved'] and upgrade['lockPreserved']
    endings=[]
    for platform,folder in [('web',run/'web-clock-and-endings'),('tv',tv/'timing')]:
        for case in ROUTES:
            capture=folder/f'{platform}-{case}'
            events=rows(capture/'events.csv')
            assert events and (capture/'game.wav').stat().st_size>44
            titles=[r['value'] for r in events if r['event']=='two-player-title']
            if case.startswith('coop-'):
                assert titles[-1]=={'coop-stage18':'40400/68100/68100','coop-stage42':'15000/68100/45800'}[case]
            endings.append([platform,case,len(events),titles[-1] if titles else '—'])
    study=ROOT/'tests/nes/fixtures/switch-terminal'
    visual=rows(study/'audap-visual.csv')[0]
    audio=rows(study/'audap-audio.csv')[0]
    trial=run/'focus-trial'
    retained=(trial/'identity.json').is_file()
    if retained:
        trial_id=json.loads((trial/'identity.json').read_text())
        assert str(trial_id['run']).isdigit() and re.fullmatch('[a-f0-9]{40}',trial_id['revision'])
        experiment=measure(trial,previous,out/'focus-trial.csv',focus_round=True)
        rejected=[r for r in experiment if r['region']=='save-focus' and r['role']!='calibration' and not r['passed']]
        assert rejected, 'The experimental focus passed. A rollback would need separate justification.'
    measured=measure(run,previous,out/'menu-sizes.csv',retained_focus=retained)
    failed=[r for r in measured if r['role']!='calibration' and not r['passed']]
    floor=(tv/'floor/clock.json').is_file()
    if floor:
        from tv_floor_report import sections as floor_sections
        swap=floor_sections(run)
        controls=control_samples(run,out/'menu-controls.csv')
        swap.append('<h2>菜单相邻焦点回归</h2>'+table(('平台','屏高','画面','超过重复波动的色值'),
                    [[r['platform'],r['height'],r['scene'],r['channels_above_noise']] for r in controls]))
    else:
        swap=sections(run)
    html=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Battle City · Switch 复刻验收</title>',
          '<style>body{font:16px/1.55 system-ui;max-width:1180px;margin:auto;padding:28px}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #adb4ba;padding:4px 8px}img{max-width:100%;height:auto}img[alt^="六个连续帧"]{width:288px;image-rendering:pixelated}figure{display:inline-block;width:42%;margin:1em}</style>',
          '<h1>Battle City · Web 与 Android TV 验收</h1>',
          f'<p>验收提交与运行 {escape(identity)}。正式电视包采用 '+('EGL' if promoted else 'SDL')+'。Android TV 显示测量来自 API 34 x86 电视模拟器。</p>',
          table(('项目','结果'),[(k,v) for k,v in gate.items() if k.endswith('Passed')]),
          *swap,'<h2>Switch 菜单</h2><p>像素交并比按相同分辨率的前一版、当前版和两次重复截图计算。独立留验包含两位作者的系统菜单，以及英文合集共用的画面设置。</p>',
          table(('平台','屏高','区域','前一版','当前版','验收'),[[r['platform'],r['height'],r['region'],f"{r['previous']:.2%}",f"{r['current']:.2%}",r['passed']] for r in measured if r['role']=='anchor']),
          f'<p>锚点及留验共 {sum(r["role"]!="calibration" for r in measured)} 项，其中 {len(failed)} 项未达到预设条件。逐项结果见数据包。</p>',
          '<h2>回归</h2>',f'<p>35 个独立关卡，连续 70 关（{loop[0]["reference_updates"]} 次更新），两个浏览器的旧存档升级，以及电视旧存档升级。</p>',
          table(('浏览器','刷新模式','轮次','游戏速度','PCM 速度'),[[r['engine'],r['cadence'],r['run'],f"{r['speed']:.2%}",f"{r['audioSpeed']:.2%}"] for r in clocks])]
    if retained:
        html.extend(['<h3>已撤回的 Save 焦点试验</h3>',
                     f"<p>试验运行 {trial_id['run']}，提交 {escape(trial_id['revision'])}。"
                     "候选四角在独立留验帧出现退步。交付包恢复上版四角，并逐像素复核两端、两档屏高的焦点掩模。</p>",
                     table(('平台','屏高','录像时间（秒）','原版','试验','重复波动'),
                           [[r['platform'],r['height'],r['seconds'],f"{r['previous']:.3%}",f"{r['current']:.3%}",
                             f"{r['noise']:.3%}"] for r in rejected])])
    for scene in ('system-menu','screen-settings'):
        for h in (720,1080):
            html.append(picture(run/f'web-clock-and-endings/screens/{scene}-{h}.png',f'Web · {scene} · {h}p'))
    html.extend(shell_report(cartridge,out/'switch-shells',run/'campaign-loop/shells.log',run/'campaign-loop/barrels.log'))
    html.extend(['<h2>结算画面与音频</h2>',
                 f'<p>五条结局的 {sum(ending_counts.values())} 个事件逐行匹配两端与已验收基线，包括帧号、模拟时间、事件名称和值。改变事件值、移动一帧和删除一行的三个打包负例均在首个差异处中止。</p>',
                 table(('平台','结局','记录事件','双人标题分数'),endings),
                 f'<p>新核对的英文 Switch 第二关实录显示 15 击毁。TOTAL 15 首次连续可读为 {float(visual["total_s"]):.3f} 秒，'
                 f'GAME OVER 为 {float(visual["game_over_s"]):.3f} 秒，间隔 {float(visual["interval_s"]):.3f} 秒。'
                 '<a href="https://www.youtube.com/watch?v=qb1BUVeAquI&amp;t=624s">原始实录</a></p>',
                 f'<p>结束音乐的频谱相似度为 {audio["spectral_cosine"]}。在 2.4% 阈值下，录像的可听尾音为 '
                 f'{audio["tail_2_4pct"]} 秒，复刻为 {audio["local_tail_2_4pct"]} 秒。录像在 0.6% 和 1.2% 阈值下均未达到持续静音条件。'
                 '这份混合音轨仍无法将差异定位到具体的音符或声道。</p>',
                 '<p>连续两次回退的落点、无人操作待机、隐藏留言的进入与退出，以及大号结算数字 2、3、4、7，'
                 '仍待英文 Switch 目标版本直接核验。本轮设备证据限于 x86 电视模拟器。</p></html>'])
    report=out/'Switch-TV-Comparison.html'
    report.write_text('\n'.join(html))
    archive=out/'Switch-TV-Measurements.zip'
    with ZipFile(archive,'w',ZIP_DEFLATED,compresslevel=6) as z:
        for f in (out/'menu-sizes.csv',run/'presentation-frames.csv',run/'presentation-cost.csv',FIXTURE,*([FOCUS_FIXTURE,out/'menu-controls.csv'] if floor else [])):
            add_evidence(z,f.name,source=f)
        if retained:
            for f in (out/'focus-trial.csv',trial/'identity.json'):
                add_evidence(z,'focus-trial/'+f.name,source=f)
            for folder in (trial/'web-clock-and-endings/screens',trial/'tv-device-results/menu-samples'):
                for f in sorted(folder.rglob('*.png')):
                    if f.name.startswith(('system-menu','screen-settings')):
                        add_evidence(z,'focus-trial/'+str(f.relative_to(trial)),source=f)
        for folder in [tv,run/'web-clock-and-endings',run/'campaign-loop',*sorted(run.glob('stage-replay-*')),*sorted(run.glob('upgrade-*'))]:
            for f in sorted(folder.rglob('*')):
                if f.is_file() and f.name not in ('artifact.json','emulator.log','logcat.txt','device.log'):
                    add_evidence(z,f.relative_to(run),source=f)
        for f in sorted((previous/'web-clock-and-endings/screens').glob('*.png')):
            if any(f.name.startswith(scene+'-') for scene in ('system-menu','screen-settings')):
                add_evidence(z,'previous/web-clock-and-endings/screens/'+f.name,source=f)
        for f in (ENDING_BASELINE,ENDING_BASELINE.with_name('negative-controls.json'),ENDING_BASELINE.with_suffix('.md')):
            add_evidence(z,'ending/'+f.name,source=f)
        for folder in (SHELL_FIXTURE,out/'switch-shells'):
            for f in sorted(folder.iterdir()):
                add_evidence(z,'switch-shells/'+f.name,source=f)
        for f in sorted(study.iterdir()):
            add_evidence(z,'switch-terminal/'+f.name,source=f)
        add_evidence(z,'identity.txt',data=(identity+'\n').encode())
    for name,source in files.items():
        dest=out/name
        if dest.exists() and sha(dest)==sha(source):continue
        if dest.exists():raise ValueError(f'Destination already contains a different {dest}')
        try:os.link(source,dest)
        except OSError:shutil.copyfile(source,dest)
    (out/'SHA256SUMS').write_text(''.join(f'{sha(f)}  {f.name}\n' for f in sorted([out/n for n in files]+[report,archive])))
    if floor and not all(r['passed'] for r in controls):
        raise SystemExit('Menu control regression; see menu-controls.csv')
    if failed:
        raise SystemExit('Reserved menu acceptance failed: '+str([(r['platform'],r['height'],r['region'],r['seconds']) for r in failed]))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('current','previous','output'):parser.add_argument(name,type=Path)
    parser.add_argument('--identity',required=True)
    parser.add_argument('--signed-arm',type=Path)
    parser.add_argument('--signing-reference',type=Path,help='installed ARM64 release with the required certificate')
    parser.add_argument('--apksigner',default=shutil.which('apksigner'))
    args=parser.parse_args()
    if args.signed_arm and not (args.signing_reference and args.apksigner):
        parser.error('--signed-arm requires --signing-reference and apksigner')
    package(args.current,args.previous,args.output,args.identity,args.signed_arm,args.apksigner,args.signing_reference)
