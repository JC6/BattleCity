"""Associate the measured NES frames with this SurfaceView's actual display receipts."""
import csv
import io
import struct
from collections import defaultdict

def varint(raw, pos):
    value=0
    for shift in range(0,70,7):
        byte=raw[pos]; pos+=1
        value|=(byte&127)<<shift
        if byte<128:return value,pos
    raise ValueError('invalid Perfetto varint')

def fields(raw):
    pos=0
    while pos<len(raw):
        tag,pos=varint(raw,pos);wire=tag&7
        if wire==0:value,pos=varint(raw,pos)
        elif wire in (1,5):
            size=8 if wire==1 else 4
            value=raw[pos:pos+size];pos+=size
        elif wire==2:
            size,pos=varint(raw,pos);value=raw[pos:pos+size];pos+=size
        else:raise ValueError('unexpected Perfetto wire type')
        if pos>len(raw):raise ValueError('truncated Perfetto trace')
        yield tag>>3,value

def surface_receipts(raw,package):
    # Public Perfetto TracePacket.graphics_frame_event and BufferEvent.PRESENT_FENCE.
    layers=defaultdict(dict)
    for key,packet in fields(memoryview(raw)):
        if key!=1:continue
        p=dict(fields(packet))
        if 57 not in p or 8 not in p:continue
        event=dict(fields(p[57]))
        if 1 not in event:continue
        buffer=dict(fields(event[1]))
        name=bytes(buffer.get(3,b'')).decode(errors='replace')
        if buffer.get(2)==8 and 'SurfaceView' in name and package in name:
            layers[name][buffer[1]]=p[8]
    return layers

def reconcile(rows, mapping, presented, trace, package):
    def records(raw):
        return [tuple(map(int,line)) for line in csv.reader(io.StringIO(raw.decode())) if len(line)==4]
    maps=records(mapping); native={(gen,nes,buf):ts for gen,nes,buf,ts in records(presented)}
    layers=surface_receipts(trace,package)
    for row in rows:
        last=row['lastSubmittedFrame']; count=row['frames']
        chosen=[item for item in maps if last-count<item[1]<=last]
        ids=[item[2] for item in chosen]; frames=[item[1] for item in chosen]
        valid=(len(chosen)==count and frames==list(range(last-count+1,last+1)) and
               len({a[0] for a in chosen})==1 and all(ids) and ids==list(range(ids[0],ids[0]+count)))
        times=[native.get((gen,nes,buf),0) for gen,nes,buf,_ in chosen]
        def ordered(values):
            return len(values)==count and all(t>0 for t in values) and all(a<b for a,b in zip(values,values[1:]))
        source='unverified'
        if valid and ordered(times):source='EGL_DISPLAY_PRESENT_TIME_ANDROID'
        elif valid:
            matching=[(name,[obs.get(i,0) for i in ids]) for name,obs in layers.items()]
            complete=[(name,ts) for name,ts in matching if ordered(ts)]
            if len(complete)==1:source='SurfaceFlinger PRESENT_FENCE'; row['displayLayer']=complete[0][0]
        row['displayEvidence']=source
        row['mappedFrames']=len(chosen)
        row['verifiedPresentations']=count if source!='unverified' else 0
        row['nativeTimestampCount']=sum(v>0 for v in times)
        row['systemReceiptLayers']={n:sum(i in obs for i in ids) for n,obs in layers.items()}
        row['swapMsPerFrame']=sum(a[3] for a in chosen)/1e6/max(1,len(chosen))
