// Run the Android program on an ES 3 compatible context with the captured NES
// input, and compare every output channel to the unmodified software renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createRequire} = require('node:module');
const {chromium}=createRequire(path.resolve(__dirname,'../../web/package.json'))('@playwright/test');
const header=fs.readFileSync(path.resolve(__dirname,'../../runtime/tv-gpu-raster.h'),'utf8');
const shaders=[...header.matchAll(/const char \*(?:vertex|fragment)=R"\(([\s\S]*?)\)";/g)].map(match=>match[1]);
assert.equal(shaders.length,2);
function ppm(file) {
    const raw=zlib.gunzipSync(fs.readFileSync(file)), prefix=/^P6\n(\d+) (\d+)\n255\n/.exec(raw.toString('ascii',0,40));
    assert.ok(prefix);
    const data=raw.subarray(prefix[0].length), w=Number(prefix[1]), h=Number(prefix[2]);
    assert.equal(data.length,w*h*3);
    return {data:data.toString('base64'),w,h};
}
// Compare three rotating, retained targets against a fresh full presentation. Mutations
// at opposing borders also exercise the orientation of the GLES scissor rectangle.
async function retainedTargets(page) {
    const result=await page.evaluate(({shaders})=>{
        const gl=document.createElement('canvas').getContext('webgl2');
        function program(sources) {
            const p=gl.createProgram();
            sources.forEach((source,i)=>{
                const shader=gl.createShader(i===0?gl.VERTEX_SHADER:gl.FRAGMENT_SHADER);
                gl.shaderSource(shader,source);gl.compileShader(shader);
                if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
                gl.attachShader(p,shader);
            });
            gl.linkProgram(p);
            if (!gl.getProgramParameter(p,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
            return p;
        }
        const raster=program(shaders);
        const sw=21,sh=19,w=95,h=82;
        gl.disable(gl.DITHER);gl.viewport(0,0,w,h);
        function target() {
            const texture=gl.createTexture(), fbo=gl.createFramebuffer();
            gl.bindTexture(gl.TEXTURE_2D,texture);
            gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,w,h);
            for (const key of [gl.TEXTURE_MAG_FILTER,gl.TEXTURE_MIN_FILTER]) gl.texParameteri(gl.TEXTURE_2D,key,gl.LINEAR);
            for (const key of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,key,gl.CLAMP_TO_EDGE);
            gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
            if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw Error('Incomplete retained target');
            return {texture,fbo};
        }
        const slots=[target(),target(),target()], expected=target();
        const input=gl.createTexture(), colors=new Uint16Array(sw*sh);
        gl.bindTexture(gl.TEXTURE_2D,input);
        for(const key of [gl.TEXTURE_MAG_FILTER,gl.TEXTURE_MIN_FILTER]) gl.texParameteri(gl.TEXTURE_2D,key,gl.NEAREST);
        gl.texStorage2D(gl.TEXTURE_2D,1,gl.R16UI,sw,sh);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT,2);
        gl.useProgram(raster);
        gl.uniform2i(gl.getUniformLocation(raster,'derivative'),Math.round(65536*sw/w),Math.round(65536*sh/h));
        const full=[0,0,w,h], geometry=gl.getUniformLocation(raster,'geometry');
        function render(dest,rect,flip) {
            if (!rect) return;
            const [x,y,right,bottom]=rect;
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(x,flip?h-bottom:y,right-x,bottom-y);
            gl.bindTexture(gl.TEXTURE_2D,input);
            gl.bindFramebuffer(gl.FRAMEBUFFER,dest.fbo);
            gl.uniform2i(geometry,h,Number(flip));
            gl.drawArrays(gl.TRIANGLES,0,3);
        }
        function read(t) {
            const bytes=new Uint8Array(w*h*4);
            gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo);
            gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
            return bytes;
        }
        let checks=0,idles=0;
        for (const flip of [false,true]) {
            let damage=[full,full,full];
            colors.fill(0);
            for(const [i,point] of [[0,0],[20,18],[10,10],null,null,null,null,[0,18],[20,0],
                'reset',[7,11],[8,12],null,null,null,null].entries()) {
                if (point==='reset') {
                    colors.fill(0x781f);damage=[full,full,full];
                } else if (point) {
                    const [sx,sy]=point;
                    colors[sy*sw+sx]=0xffe0;
                    const loX=Math.max(0,Math.floor(sx*w/sw)-1),loY=Math.max(0,Math.floor(sy*h/sh)-1);
                    const hiX=Math.min(w,Math.ceil((sx+1)*w/sw)+1),hiY=Math.min(h,Math.ceil((sy+1)*h/sh)+1);
                    damage=damage.map(old=>old?[Math.min(old[0],loX),Math.min(old[1],loY),Math.max(old[2],hiX),Math.max(old[3],hiY)]:[loX,loY,hiX,hiY]);
                }
                gl.bindTexture(gl.TEXTURE_2D,input);
                gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,sw,sh,gl.RED_INTEGER,gl.UNSIGNED_SHORT,colors);
                const slot=i%3;
                if (!damage[slot]) idles++;
                render(slots[slot],damage[slot],flip);
                damage[slot]=null;
                render(expected,full,flip);
                const actual=read(slots[slot]),ref=read(expected);
                if (!actual.every((v,n)=>v===ref[n])) throw Error('Stale retained pixel at step '+i+' flipped='+flip);
                if (!ref.some((v,n)=>n%4!==3 && v!==0)) throw Error('Missing coloured sample');
                checks++;
            }
        }
        if(gl.getError()!==gl.NO_ERROR) throw Error('Retained presentation failed');
        return {checks,idles};
    },{shaders});
    assert.equal(result.checks,32);
    assert.ok(result.idles>=4);
    console.log(result.checks,'retained presentations match full renders, including',result.idles,'unchanged buffers');
}
async function main() {
    const browser=await chromium.launch({args:['--enable-unsafe-swiftshader']});
    try {
        const page=await browser.newPage(),dir=process.argv[2];
        await retainedTargets(page);
        const inputs=fs.readdirSync(dir).filter(name=>name.endsWith('-baseline-source.ppm.gz'));
        for (const frame of [626,633,648]) assert.ok(inputs.includes(`moving-${frame}-baseline-source.ppm.gz`));
        for (const input of inputs) {
            const source=ppm(path.join(dir,input));
            const expanded=ppm(path.join(dir,input.replace('-source.','-expanded.')));
            const diff=await page.evaluate(({source,expanded,shaders})=>{
                const gl=document.createElement('canvas').getContext('webgl2');
                if (!gl) throw Error('WebGL 2 unavailable');
                const program=gl.createProgram();
                for(const [i,type] of [gl.VERTEX_SHADER,gl.FRAGMENT_SHADER].entries()) {
                    const s=gl.createShader(type);gl.shaderSource(s,shaders[i]);gl.compileShader(s);
                    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
                    gl.attachShader(program,s);
                }
                gl.linkProgram(program);
                if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
                const target=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,target);
                gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,expanded.w,expanded.h);
                gl.bindFramebuffer(gl.FRAMEBUFFER,gl.createFramebuffer());
                gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
                const nes=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,nes);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
                const bytes=atob(source.data), colors=new Uint16Array(source.w*source.h);
                for(let i=0;i<colors.length;i++) colors[i]=((bytes.charCodeAt(i*3)>>3)<<11) |
                    ((bytes.charCodeAt(i*3+1)>>2)<<5) | (bytes.charCodeAt(i*3+2)>>3);
                gl.texImage2D(gl.TEXTURE_2D,0,gl.R16UI,source.w,source.h,0,gl.RED_INTEGER,gl.UNSIGNED_SHORT,colors);
                gl.useProgram(program);gl.disable(gl.DITHER);gl.viewport(0,0,expanded.w,expanded.h);
                gl.uniform1i(gl.getUniformLocation(program,'source'),0);
                gl.uniform2i(gl.getUniformLocation(program,'geometry'),expanded.h,0);
                gl.uniform2i(gl.getUniformLocation(program,'derivative'),Math.round(65536*source.w/expanded.w),Math.round(65536*source.h/expanded.h));
                gl.drawArrays(gl.TRIANGLES,0,3);
                const pixels=new Uint8Array(expanded.w*expanded.h*4);
                gl.readPixels(0,0,expanded.w,expanded.h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
                if(gl.getError()!==gl.NO_ERROR) throw Error('GLES command failed');
                const expected=atob(expanded.data);let different=0;
                for(let i=0;i<pixels.length/4;i++) {
                    if(pixels[i*4]!==expected.charCodeAt(i*3) || pixels[i*4+1]!==expected.charCodeAt(i*3+1) ||
                       pixels[i*4+2]!==expected.charCodeAt(i*3+2)) different++;
                }
                return different;
            },{source,expanded,shaders});
            assert.equal(diff,0,input);
            console.log(input,expanded.w*expanded.h,'RGB pixels match');
        }
    } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
