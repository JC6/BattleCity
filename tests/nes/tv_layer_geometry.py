"""Extract frozen Android 14 SurfaceFlinger buffer geometry from its public layer dump."""
import gzip
import struct
from tv_presentation import fields

def layer_geometry(path):
    raw=gzip.decompress(path.read_bytes())
    if not raw.startswith(b'\x09LYRTRACE'):
        return []
    result=[]
    for key,entry in fields(raw):
        if key!=2:continue
        snapshot=dict(fields(entry))
        for tag,data in fields(snapshot.get(3,b'')):
            if tag!=1:continue
            layer=dict(fields(data))
            name=bytes(layer.get(2,b'')).decode(errors='replace')
            if 'org.jiangc.bc.runtime' not in name and 'BattleCity NES' not in name:continue
            if 27 not in layer:continue
            def numbers(tag,count,floating=False):
                if tag not in layer:return None
                values=dict(fields(layer[tag]))
                values=[values.get(i,0) for i in range(1,count+1)]
                if floating:return [round(struct.unpack('<f',v)[0],7) if isinstance(v,(bytes,memoryview)) else v for v in values]
                return [v-(1<<64) if v>=(1<<63) else v for v in values]
            transform=dict(fields(layer.get(43,b'')))
            result.append({'name':name,'id':layer.get(1),'parent':layer.get(25),
                'activeBuffer':numbers(27,4),'position':numbers(11,2,True),
                'crop':numbers(14,4),'hwcDestination':numbers(30,4),'hwcSource':numbers(31,4,True),
                'effectiveTransform':numbers(43,4,True),'transformType':transform.get(5),
                'sourceBounds':numbers(44,4,True),'screenBounds':numbers(46,4,True),
                'scalingMode':layer.get(40),'dataspace':bytes(layer.get(18,b'')).decode(errors='replace')})
    return result
