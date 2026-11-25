"""Reproduce Android Emulator SwiftShader's window-quad behavior using the game's GLSL."""
import argparse
import ctypes as ct
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

from tv_stage_analysis import ppm

INT, UINT, FLOAT, PTR = ct.c_int, ct.c_uint, ct.c_float, ct.c_void_p


def bind(lib, name, result, *arguments):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, arguments
    return fn


def context(runtime, w, h):
    egl = ct.CDLL(str(runtime/'libEGL.so'))
    egl_get = bind(egl, 'eglGetDisplay', PTR, PTR)
    display = egl_get(None)
    attrs = lambda *v: (INT*len(v))(*v)
    config, count = PTR(), INT()
    surface_attr = attrs(0x3057,w,0x3056,h,0x3038)
    config_attr = attrs(0x3033,1,0x3040,0x40,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3038)
    assert bind(egl,'eglInitialize',UINT,PTR,PTR,PTR)(display,None,None)
    assert bind(egl,'eglChooseConfig',UINT,PTR,PTR,PTR,INT,PTR)(display,config_attr,ct.byref(config),1,ct.byref(count)) and count.value
    ctx = bind(egl,'eglCreateContext',PTR,PTR,PTR,PTR,PTR)(display,config,None,attrs(0x3098,3,0x3038))
    surface = bind(egl,'eglCreatePbufferSurface',PTR,PTR,PTR,PTR)(display,config,surface_attr)
    assert ctx and surface and bind(egl,'eglMakeCurrent',UINT,PTR,PTR,PTR,PTR)(display,surface,surface,ctx)
    return egl, display


class WindowProbe:
    def __init__(self, runtime):
        self.lib = ct.CDLL(str(runtime/'libGLESv2.so'))
        def use(name, result, *args):
            return bind(self.lib,'gl'+name,result,*args)
        self.use = use
        self.program = use('CreateProgram',UINT)
        self.shader = use('CreateShader',UINT,UINT)
        self.source = use('ShaderSource',None,UINT,INT,PTR,PTR)
        self.compile = use('CompileShader',None,UINT)
        self.attach = use('AttachShader',None,UINT,UINT)
        self.link = use('LinkProgram',None,UINT)
        self.status = use('GetProgramiv',None,UINT,UINT,PTR)
        self.select = use('UseProgram',None,UINT)
        self.location = use('GetUniformLocation',INT,UINT,ct.c_char_p)
        self.uniform2 = use('Uniform2f',None,INT,FLOAT,FLOAT)
        self.uniform1 = use('Uniform1i',None,INT,INT)
        self.read = use('ReadPixels',None,INT,INT,INT,INT,UINT,UINT,PTR)
        self.upload = use('TexSubImage2D',None,UINT,INT,INT,INT,INT,INT,UINT,UINT,PTR)
        self.clear = use('Clear',None,UINT)
        self.clear_color = use('ClearColor',None,FLOAT,FLOAT,FLOAT,FLOAT)
        self.draw = use('DrawArrays',None,UINT,INT,INT)
        self.error = use('GetError',UINT)
        self.viewport = use('Viewport',None,INT,INT,INT,INT)
        self.storage = use('TexImage2D',None,UINT,INT,INT,INT,INT,INT,UINT,UINT,PTR)
        self.driver = use('GetString',ct.c_char_p,UINT)(0x1F01).decode()
        use('Disable',None,UINT)(0x0BD0)
        vertices = (FLOAT*12)(0,0,1,0,1,1,0,0,1,1,0,1)
        buffer, texture = UINT(), UINT()
        use('GenBuffers',None,INT,PTR)(1,ct.byref(buffer))
        use('BindBuffer',None,UINT,UINT)(0x8892,buffer)
        use('BufferData',None,UINT,ct.c_ssize_t,PTR,UINT)(0x8892,ct.sizeof(vertices),vertices,0x88E4)
        use('VertexAttribPointer',None,UINT,INT,UINT,ct.c_ubyte,INT,PTR)(0,2,0x1406,0,0,None)
        use('EnableVertexAttribArray',None,UINT)(0)
        use('GenTextures',None,INT,PTR)(1,ct.byref(texture))
        self.texture = texture
        use('BindTexture',None,UINT,UINT)(0x0DE1,texture)
        parameter = use('TexParameteri',None,UINT,UINT,INT)
        for key in (0x2800,0x2801):
            parameter(0x0DE1,key,0x2601)
        for key in (0x2802,0x2803):
            parameter(0x0DE1,key,0x812F)

    def make_program(self, vertex, fragment):
        program = self.program()
        for kind, text in ((0x8B31,vertex),(0x8B30,fragment)):
            shader = self.shader(kind)
            string = ct.c_char_p(text.encode())
            self.source(shader,1,ct.byref(string),None)
            self.compile(shader)
            self.attach(program,shader)
        self.link(program)
        ok = INT()
        self.status(program,0x8B82,ct.byref(ok))
        assert ok.value, 'window program did not link'
        return program

    def paint(self, program, w, h, rgb):
        self.select(program)
        self.use('BindTexture',None,UINT,UINT)(0x0DE1,self.texture)
        self.viewport(0,0,w,h)
        rgba = bytearray([255])*(w*h*4)
        for c in range(3):
            rgba[c::4] = rgb[c::3]
        array = (ct.c_ubyte*len(rgba)).from_buffer(rgba)
        self.storage(0x0DE1,0,0x8058,w,h,0,0x1908,0x1401,None)
        self.upload(0x0DE1,0,0,0,w,h,0x1908,0x1401,array)
        self.uniform1(self.location(program,b'source'),0)
        self.uniform2(self.location(program,b'viewport'),w,h)
        self.clear_color(0.2,0.1,0.3,1)
        self.clear(0x4000)
        self.draw(4,0,6)
        self.read(0,0,w,h,0x1908,0x1401,array)
        assert self.error()==0
        top = b''.join(rgba[4*y*w:4*(y+1)*w] for y in reversed(range(h)))
        out = bytearray(w*h*3)
        for c in range(3):
            out[c::3] = top[c::4]
        return bytes(out)

    def expand_native(self, program, source, w, h):
        sw,sh,rgb=source
        use=self.use
        inputs=(ct.c_uint16*(sw*sh))(*((r>>3)<<11 | (g>>2)<<5 | (b>>3)
            for r,g,b in zip(rgb[::3],rgb[1::3],rgb[2::3])))
        tex,fbo=UINT(),UINT()
        use('GenTextures',None,INT,PTR)(1,ct.byref(tex))
        use('BindTexture',None,UINT,UINT)(0x0DE1,tex)
        parameter=use('TexParameteri',None,UINT,UINT,INT)
        for key in (0x2800,0x2801):parameter(0x0DE1,key,0x2600)
        use('PixelStorei',None,UINT,INT)(0x0CF5,2)
        self.storage(0x0DE1,0,0x8234,sw,sh,0,0x8D94,0x1403,inputs)
        use('GenFramebuffers',None,INT,PTR)(1,ct.byref(fbo))
        bind_fbo=use('BindFramebuffer',None,UINT,UINT)
        bind_fbo(0x8D40,fbo)
        use('FramebufferTexture2D',None,UINT,UINT,UINT,UINT,INT)(0x8D40,0x8CE0,0x0DE1,tex,0)
        assert use('CheckFramebufferStatus',UINT,UINT)(0x8D40)==0x8CD5
        readback=(UINT*(sw*sh*4))()
        self.read(0,0,sw,sh,0x8D99,0x1405,readback)
        assert self.error()==0 and readback[::4]==inputs[:], 'native integer texture readback differs'
        bind_fbo(0x8D40,0)
        self.select(program)
        self.viewport(0,0,w,h)
        uniform=use('Uniform2i',None,INT,INT,INT)
        uniform(self.location(program,b'geometry'),h,0)
        uniform(self.location(program,b'derivative'),round(65536*sw/w),round(65536*sh/h))
        self.uniform1(self.location(program,b'source'),0)
        use('DisableVertexAttribArray',None,UINT)(0)
        self.draw(4,0,3)
        rgba=(ct.c_ubyte*(w*h*4))()
        self.read(0,0,w,h,0x1908,0x1401,rgba)
        assert self.error()==0
        use('EnableVertexAttribArray',None,UINT)(0)
        use('DeleteFramebuffers',None,INT,PTR)(1,ct.byref(fbo))
        use('DeleteTextures',None,INT,PTR)(1,ct.byref(tex))
        data=bytes(rgba)
        out=bytearray(w*h*3)
        for c in range(3):out[c::3]=data[c::4]
        return bytes(out)

    def benchmark(self, w, h, frames):
        # paint() left a fully drawn pbuffer and the expanded source bound.
        use=self.use
        bind_fbo=use('BindFramebuffer',None,UINT,UINT)
        bind_texture=use('BindTexture',None,UINT,UINT)
        finish=use('Finish',None)
        blit=use('BlitFramebuffer',None,*([INT]*8),UINT,UINT)
        scissor=use('Scissor',None,INT,INT,INT,INT)
        enable=use('Enable',None,UINT)
        disable=use('Disable',None,UINT)
        def read():
            result=(ct.c_ubyte*(w*h*4))()
            self.read(0,0,w,h,0x1908,0x1401,result)
            return bytes(result)
        baseline=read()
        tex,fbo=UINT(),UINT()
        use('GenTextures',None,INT,PTR)(1,ct.byref(tex))
        bind_texture(0x0DE1,tex)
        use('TexStorage2D',None,UINT,INT,UINT,INT,INT)(0x0DE1,1,0x8058,w,h)
        use('GenFramebuffers',None,INT,PTR)(1,ct.byref(fbo))
        bind_fbo(0x8D40,fbo)
        use('FramebufferTexture2D',None,UINT,UINT,UINT,UINT,INT)(0x8D40,0x8CE0,0x0DE1,tex,0)
        assert use('CheckFramebufferStatus',UINT,UINT)(0x8D40)==0x8CD5
        bind_texture(0x0DE1,self.texture)
        self.draw(4,0,6)
        finish()
        results={}
        for mode in ('draw','blit','partial-blit'):
            bind_fbo(0x8D40,0)
            self.clear(0x4000)
            finish()
            start=time.perf_counter()
            for _ in range(frames):
                if mode=='draw':
                    self.draw(4,0,6)
                else:
                    if mode=='partial-blit':
                        bind_fbo(0x8D40,fbo)
                        enable(0x0C11)
                        scissor(100,100,50,50)
                        self.draw(4,0,6)
                        disable(0x0C11)
                    bind_fbo(0x8CA8,fbo)
                    bind_fbo(0x8CA9,0)
                    blit(0,0,w,h,0,0,w,h,0x4000,0x2600)
                finish()
            results[mode]=1000*(time.perf_counter()-start)/frames
            bind_fbo(0x8D40,0)
            assert self.error()==0 and read()==baseline,mode
        return dict(driver=self.driver,dimensions=[w,h],framesPerMethod=frames,
                    millisecondsPerFrame=results,rgbaSha256=hashlib.sha256(baseline).hexdigest())


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('runtime',type=Path,help='Android SDK emulator/lib64/gles_swiftshader')
    parser.add_argument('fixtures',type=Path,help='held-out directory with SDL baseline readbacks')
    parser.add_argument('output',type=Path)
    parser.add_argument('--benchmark',type=Path,help='write timings of 80 completed draws per offscreen method')
    args=parser.parse_args()
    runtime=args.runtime.resolve()
    if str(runtime) not in os.getenv('LD_LIBRARY_PATH','').split(':'):
        env=dict(os.environ,LD_LIBRARY_PATH=os.pathsep.join([str(runtime),str(runtime.parent),os.getenv('LD_LIBRARY_PATH','')]))
        os.execve(sys.executable,[sys.executable,*sys.argv],env)
    source=(Path(__file__).resolve().parents[2]/'runtime/tv-egl-window.h').read_text()
    shaders=dict(re.findall(r'const char \*(vertex|fragment|legacy)=R"\((.*?)\)";',source,re.S))
    paths=sorted(args.fixtures.glob('*-baseline-layer.ppm.gz'))
    assert len(paths)>=5
    w,h,_=ppm(gzip.decompress(paths[0].read_bytes()))
    egl,display=context(runtime,w,h)
    try:
        gl=WindowProbe(runtime)
        programs={mode:gl.make_program(shaders[mode],shaders['fragment']) for mode in ('legacy','vertex')}
        raster_source=(Path(__file__).resolve().parents[2]/'runtime/tv-raster-shader.h').read_text()
        raster=gl.make_program(*re.findall(r'const char \*(?:vertex|fragment)=R"\((.*?)\)";',raster_source,re.S))
        report={'driver':gl.driver,'fixtures':{}}
        for path in paths:
            width,height,rgb=ppm(gzip.decompress(path.read_bytes()))
            assert (width,height)==(w,h)
            _,_,expected=ppm(gzip.decompress(path.with_name(path.name.replace('-layer.','-swap.')).read_bytes()))
            native=ppm(gzip.decompress(path.with_name(path.name.replace('-layer.','-source.')).read_bytes()))
            integer=gl.expand_native(raster,native,w,h)
            assert integer==rgb,path.name
            fixed=gl.paint(programs['vertex'],w,h,rgb)
            legacy=gl.paint(programs['legacy'],w,h,rgb)
            assert fixed==expected,path.name
            sentinel=legacy[:3]
            untouched=legacy==sentinel*(w*h)
            assert untouched and sentinel==bytes((51,26,77)),path.name
            report['fixtures'][path.name.split('-baseline-')[0]]={'pixels':w*h,'fixedSha256':hashlib.sha256(fixed).hexdigest(),
                'referenceSha256':hashlib.sha256(expected).hexdigest(),'legacyClearRGB':list(sentinel),'integerExpansionSha256':hashlib.sha256(integer).hexdigest(),
                'nativeTexelsVerified':native[0]*native[1]}
        if args.benchmark:
            assert gl.paint(programs['vertex'],w,h,rgb)==expected
            timings=gl.benchmark(w,h,80)
            args.benchmark.write_text(json.dumps(timings,indent=2)+'\n')
        args.output.write_text(json.dumps(report,indent=2)+'\n')
        print(gl.driver,len(report['fixtures']),'device readbacks matched; legacy quad left clear colour untouched')
    finally:
        bind(egl,'eglTerminate',UINT,PTR)(display)


if __name__=='__main__':
    main()
