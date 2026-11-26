"""Audit fixed SurfaceView sizes and associate diagnostic frame boundaries with display receipts."""
import csv
import gzip
import json
from statistics import median

from native_window_report import table
from tv_presentation import csv_records, reconcile, surface_receipts

PACKAGE = 'org.jiangc.bc.runtime'
CASES = {'corners', 'calibration', 'moving-633', 'blast-700'}


def frame_boundaries(folder, name, row):
    mapping = (folder / (name+'-frame-map.csv')).read_bytes()
    shown = (folder / (name+'-present.csv')).read_bytes()
    trace = gzip.decompress((folder / (name+'-display.pftrace.gz')).read_bytes())
    audit = row.copy()
    reconcile([audit], mapping, shown, trace, PACKAGE)
    assert all(row[k] == audit[k] for k in ('displayEvidence','verifiedPresentations','individuallyObserved'))
    last = row['lastSubmittedFrame']
    sent = {nes:(gen,buffer) for gen,nes,buffer,_ in csv_records(mapping) if last-row['frames'] < nes <= last}
    egl = {(gen,nes,buf):time for gen,nes,buf,time in csv_records(shown)}
    layer = audit.get('displayLayer')
    system = surface_receipts(trace, PACKAGE)[layer] if layer else {}
    with (folder/(name+'-boundaries.csv')).open() as file:
        bounds = {nes:(gen,begin,swap,end) for gen,nes,begin,swap,end in
                  (map(int,r) for r in csv.reader(file)) if nes in sent}
    assert set(bounds)==set(sent)
    output=[]
    for nes,(gen,buf) in sent.items():
        generation,begin,swap,end=bounds[nes]
        assert generation==gen and 0<begin<=swap<=end
        stamp = system.get(buf, 0) if layer else 0
        if audit['displayEvidence'] == 'EGL_DISPLAY_PRESENT_TIME_ANDROID':
            stamp = egl.get((gen, nes, buf), 0)
        output.append([name,nes,buf,begin,swap,end,stamp if stamp>0 else ''])
    assert sum(bool(r[-1]) for r in output) == audit['verifiedPresentations']
    return output


def buffer_sections(run):
    tv=run/'tv-device-results'
    folder=tv/'prototype'
    evidence=json.loads((tv/'geometry/visual.json').read_text())
    assert set(evidence)=={'layout','scale1','scale2','scale3','scale4'}
    cells=[]
    for size,scenes in evidence.items():
        assert set(scenes)==CASES
        for name,sample in scenes.items():
            assert sample['battle']==evidence['layout'][name]['battle']
            cells.append([size,name,' × '.join(map(str,sample['bufferSize'])),sample['geometryMatched'],
                          sample['differentCenters'],sample['differentWallpaperPixels'],sample['aboveRepeatNoise']])
    windows=json.loads((folder/'clock.json').read_text())['windows']
    producer=windows['producer-battle'][0]
    core=windows['core-battle'][0]
    assert producer['wall']>=30 and core['driver']=='core-audio-only' and core['presented']==0
    boundary_rows=[]
    timings=[]
    for name,records in windows.items():
        if name=='producer-battle' or records[0]['driver']=='android-egl-window':
            frames = frame_boundaries(folder, name, records[0])
            boundary_rows.extend(frames)
            draw = [(swap-begin)/1e6 for _,_,_,begin,swap,_,_ in frames]
            exchange = [(end-swap)/1e6 for _,_,_,_,swap,end,_ in frames]
            intervals = [(b[-1]-a[-1])/1e6 for a,b in zip(frames, frames[1:]) if a[-1] and b[-1]]
            timings.append([name, len(frames), f'{median(draw):.3f}', f'{median(exchange):.3f}',
                            f'{median(intervals):.3f}' if intervals else '—'])
    with (run/'frame-boundaries.csv').open('w',newline='') as file:
        writer=csv.writer(file)
        writer.writerow(['scene','frame_id','egl_buffer','render_start_ns','swap_start_ns','swap_return_ns','display_ns'])
        writer.writerows(boundary_rows)
    return [
        '<h2>分离测量游戏核心与窗口</h2>',
        f"<p>只运行核心和音频时游戏为原速的 {core['gameSpeed']:.2%}，系统 PCM 为 {core['pcmSpeed']:.2%}。"
        f"暂停推进模拟并连续提交预制画面时，{producer['wall']:.3f} 秒提交 {producer['frames']} 帧，"
        f"每秒 {producer['presentationsPerSecond']:.3f} 帧，其中 {producer['individuallyObserved']} 帧可关联实际显示。"
        "该窗口使用独立的预制帧序号。普通战斗、连续爆炸另按 NES 帧计量。</p>",
        ("<p>完整窗口单独呈现预制画面的速度已低于原机约 60 帧/秒。拆分游戏与显示线程无法消除本次测到的显示开销。</p>"
         if producer['presentationsPerSecond'] < 0.99 * core['frames']/core['emu'] else ''),
        table(('窗口','帧数','开始绘制到交换 ms（中位数）','交换调用 ms（中位数）','连续显示间隔 ms（中位数）'),timings),
        '<h2>1080p 显示缓冲尺寸筛选</h2><p>比较同一帧的系统截图与重复采集的 SDL 基准，每项检查 57,344 个像素中心。缓冲尺寸来自当前 EGL 窗口。</p>',
        table(('方案','场景','实测缓冲','尺寸正确','像素中心差异','壁纸差异','整图超噪像素'),cells)]
