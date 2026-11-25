// Render the native RGB565 game raster directly into a compositor-owned image.
#pragma once
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>

class tv_gpu_raster
{
    EGLDisplay display=EGL_NO_DISPLAY, prior_display=EGL_NO_DISPLAY;
    EGLContext context=EGL_NO_CONTEXT, prior_context=EGL_NO_CONTEXT;
    EGLSurface pbuffer=EGL_NO_SURFACE, prior_draw=EGL_NO_SURFACE, prior_read=EGL_NO_SURFACE;
    struct target { EGLImageKHR image=EGL_NO_IMAGE_KHR; GLuint color=0, fbo=0; };
    std::array<target,3> targets{};
    GLuint program=0, texture=0, presenter=0, expanded_texture=0, expanded_fbo=0;
    GLint present_flip=-1;
    GLint geometry=-1, derivative=-1;
    int texture_h=0;
    bool upside_down=false, ready=false, initialized=false;
    PFNEGLCREATEIMAGEKHRPROC create_image=nullptr;
    PFNEGLDESTROYIMAGEKHRPROC destroy_image=nullptr;
    PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC client_buffer=nullptr;
    PFNGLEGLIMAGETARGETRENDERBUFFERSTORAGEOESPROC bind_image=nullptr;
    PFNEGLCREATESYNCKHRPROC create_sync=nullptr;
    PFNEGLDESTROYSYNCKHRPROC destroy_sync=nullptr;
    PFNEGLDUPNATIVEFENCEFDANDROIDPROC dup_fence=nullptr;

    static GLuint shader(GLenum type, const char *text) {
        GLuint name=glCreateShader(type);
        glShaderSource(name,1,&text,nullptr);
        glCompileShader(name);
        GLint ok=0;
        glGetShaderiv(name,GL_COMPILE_STATUS,&ok);
        if (!ok) { glDeleteShader(name); return 0; }
        return name;
    }

    static GLuint link(const char *vertex,const char *fragment) {
        GLuint vs=shader(GL_VERTEX_SHADER,vertex), fs=shader(GL_FRAGMENT_SHADER,fragment);
        if (!vs || !fs) { if (vs) glDeleteShader(vs); if (fs) glDeleteShader(fs); return 0; }
        GLuint linked=glCreateProgram();
        glAttachShader(linked,vs); glAttachShader(linked,fs); glLinkProgram(linked);
        glDeleteShader(vs); glDeleteShader(fs);
        GLint ok=0; glGetProgramiv(linked,GL_LINK_STATUS,&ok);
        if (!ok) { glDeleteProgram(linked); return 0; }
        return linked;
    }

    bool start() {
        if (context!=EGL_NO_CONTEXT) return initialized;
        prior_display=eglGetCurrentDisplay();
        prior_context=eglGetCurrentContext();
        prior_draw=eglGetCurrentSurface(EGL_DRAW);
        prior_read=eglGetCurrentSurface(EGL_READ);
        display=eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (display==EGL_NO_DISPLAY || !eglInitialize(display,nullptr,nullptr)) return false;
        EGLint const requirements[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT_KHR,
            EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_NONE};
        EGLConfig config{};
        EGLint count=0;
        if (!eglChooseConfig(display,requirements,&config,1,&count) || count!=1) return false;
        EGLint const ctx[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};
        EGLint const surface[]={EGL_WIDTH,1,EGL_HEIGHT,1,EGL_NONE};
        context=eglCreateContext(display,config,EGL_NO_CONTEXT,ctx);
        pbuffer=eglCreatePbufferSurface(display,config,surface);
        if (context==EGL_NO_CONTEXT || pbuffer==EGL_NO_SURFACE || !eglMakeCurrent(display,pbuffer,pbuffer,context)) return false;
        client_buffer=(PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC)eglGetProcAddress("eglGetNativeClientBufferANDROID");
        create_image=(PFNEGLCREATEIMAGEKHRPROC)eglGetProcAddress("eglCreateImageKHR");
        destroy_image=(PFNEGLDESTROYIMAGEKHRPROC)eglGetProcAddress("eglDestroyImageKHR");
        bind_image=(PFNGLEGLIMAGETARGETRENDERBUFFERSTORAGEOESPROC)eglGetProcAddress("glEGLImageTargetRenderbufferStorageOES");
        create_sync=(PFNEGLCREATESYNCKHRPROC)eglGetProcAddress("eglCreateSyncKHR");
        destroy_sync=(PFNEGLDESTROYSYNCKHRPROC)eglGetProcAddress("eglDestroySyncKHR");
        dup_fence=(PFNEGLDUPNATIVEFENCEFDANDROIDPROC)eglGetProcAddress("eglDupNativeFenceFDANDROID");
        if (!client_buffer || !create_image || !destroy_image || !bind_image) return false;
        const char *vertex=R"(#version 300 es
void main() {
    vec2 point=vec2((gl_VertexID << 1) & 2,gl_VertexID & 2);
    gl_Position=vec4(point*2.0-1.0,0.0,1.0);
})";
        const char *fragment=R"(#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D source;
uniform ivec2 geometry;
uniform ivec2 derivative;
out vec4 color;
void main() {
    ivec2 pos=ivec2(gl_FragCoord.xy);
    if (geometry.y!=0) pos.y=geometry.x-1-pos.y;
    ivec2 samplePos=(pos*derivative+derivative/2) >> 16;
    uint value=texelFetch(source,min(samplePos,textureSize(source,0)-1),0).r;
    uvec3 v=uvec3(value>>11u,(value>>5u)&63u,value&31u);
    color=vec4(vec3(v*uvec3(8,4,8)+v/uvec3(4,16,4))/255.0,1.0);
})";
        // SDL 3.4.12 presents its software window as an edge-clamped linear texture.
        const char *present_vertex=R"(#version 300 es
uniform bool flip;
out highp vec2 uv;
void main() {
    const vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(1,1),vec2(0,0),vec2(1,1),vec2(0,1));
    uv=corners[gl_VertexID];
    vec2 target=vec2(uv.x,flip ? 1.0-uv.y : uv.y);
    gl_Position=vec4(target*2.0-1.0,0,1);
})";
        const char *present_fragment=R"(#version 300 es
precision mediump float;
uniform sampler2D expanded;
in highp vec2 uv;
out vec4 color;
void main() { color=texture(expanded,uv); }
)";
        program=link(vertex,fragment);
        presenter=link(present_vertex,present_fragment);
        if (!program || !presenter) return false;
        glUseProgram(presenter);
        present_flip=glGetUniformLocation(presenter,"flip");
        glUniform1i(glGetUniformLocation(presenter,"expanded"),0);
        glUseProgram(program);
        geometry=glGetUniformLocation(program,"geometry");
        derivative=glGetUniformLocation(program,"derivative");
        glUniform1i(glGetUniformLocation(program,"source"),0);
        glGenTextures(1,&texture);
        glBindTexture(GL_TEXTURE_2D,texture);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
        glDisable(GL_BLEND); glDisable(GL_DITHER);
        initialized=glGetError()==GL_NO_ERROR;
        return initialized;
    }
public:
    ~tv_gpu_raster() {
        reset();
        if (context!=EGL_NO_CONTEXT) {
            if (eglGetCurrentContext()==context) {
                if (texture) glDeleteTextures(1,&texture);
                if (program) glDeleteProgram(program);
                if (presenter) glDeleteProgram(presenter);
                if (prior_context!=EGL_NO_CONTEXT) eglMakeCurrent(prior_display,prior_draw,prior_read,prior_context);
                else eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
            }
            eglDestroyContext(display,context);
        }
        if (pbuffer!=EGL_NO_SURFACE) eglDestroySurface(display,pbuffer);
        if (display!=EGL_NO_DISPLAY && prior_display==EGL_NO_DISPLAY) eglTerminate(display);
    }
    void reset() {
        ready=false;
        if (expanded_fbo) glDeleteFramebuffers(1,&expanded_fbo);
        if (expanded_texture) glDeleteTextures(1,&expanded_texture);
        expanded_fbo=expanded_texture=0;
        for (auto &t:targets) {
            if (t.fbo) glDeleteFramebuffers(1,&t.fbo);
            if (t.color) glDeleteRenderbuffers(1,&t.color);
            if (t.image!=EGL_NO_IMAGE_KHR) destroy_image(display,t.image);
            t={};
        }
    }
    bool configure(const std::array<AHardwareBuffer *,3> &buffers,int w,int h) {
        if (!start()) return false;
        for (unsigned i=0;i<targets.size();++i) {
            auto &t=targets[i];
            const EGLClientBuffer client=client_buffer(buffers[i]);
            if (!client) return false;
            t.image=create_image(display,EGL_NO_CONTEXT,EGL_NATIVE_BUFFER_ANDROID,client,nullptr);
            if (t.image==EGL_NO_IMAGE_KHR) return false;
            glGenRenderbuffers(1,&t.color); glBindRenderbuffer(GL_RENDERBUFFER,t.color);
            bind_image(GL_RENDERBUFFER,t.image);
            glGenFramebuffers(1,&t.fbo); glBindFramebuffer(GL_FRAMEBUFFER,t.fbo);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,t.color);
            if (glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE) return false;
        }
        glGenTextures(1,&expanded_texture); glBindTexture(GL_TEXTURE_2D,expanded_texture);
        glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,w,h,0,GL_RGBA,GL_UNSIGNED_BYTE,nullptr);
        for (auto parameter:{GL_TEXTURE_MIN_FILTER,GL_TEXTURE_MAG_FILTER})
            glTexParameteri(GL_TEXTURE_2D,parameter,GL_LINEAR);
        for (auto parameter:{GL_TEXTURE_WRAP_S,GL_TEXTURE_WRAP_T})
            glTexParameteri(GL_TEXTURE_2D,parameter,GL_CLAMP_TO_EDGE);
        glGenFramebuffers(1,&expanded_fbo); glBindFramebuffer(GL_FRAMEBUFFER,expanded_fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,expanded_texture,0);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE) return false;
        // Read one pixel of the first target to establish its actual row order.
        glBindFramebuffer(GL_FRAMEBUFFER,targets[0].fbo);
        glEnable(GL_SCISSOR_TEST);
        glScissor(0,0,1,1); glClearColor(1,0,0,1); glClear(GL_COLOR_BUFFER_BIT);
        glScissor(0,h-1,1,1); glClearColor(0,0,1,1); glClear(GL_COLOR_BUFFER_BIT);
        glDisable(GL_SCISSOR_TEST); glFinish();
        if (glGetError()!=GL_NO_ERROR) return false;
        void *address=nullptr;
        ARect first{0,0,1,1};
        if (AHardwareBuffer_lock(buffers[0],AHARDWAREBUFFER_USAGE_CPU_READ_RARELY,-1,&first,&address)!=0) return false;
        auto *bytes=static_cast<const uint8_t *>(address);
        bool const red=bytes[0]>240 && bytes[2]<10, blue=bytes[2]>240 && bytes[0]<10;
        if (AHardwareBuffer_unlock(buffers[0],nullptr)!=0 || (!red && !blue)) return false;
        upside_down=blue;
        ready=true;
        return true;
    }
    bool available() const { return ready; }
    bool draw(unsigned index,const std::vector<uint16_t> &input,int w,int h,ARect dirty,int &acquire,tv_stage_capture *capture,battlecity_tv::gpu_cost *cost) {
        auto const timestamp=[cost]() { return cost ? battlecity_tv::now_ns() : int64_t(0); };
        const auto started=timestamp();
        int const rows=int(input.size()/256);
        glBindTexture(GL_TEXTURE_2D,texture);
        if (texture_h!=rows) {
            glTexImage2D(GL_TEXTURE_2D,0,GL_R16UI,256,rows,0,GL_RED_INTEGER,GL_UNSIGNED_SHORT,nullptr);
            texture_h=rows;
        }
        glTexSubImage2D(GL_TEXTURE_2D,0,0,0,256,rows,GL_RED_INTEGER,GL_UNSIGNED_SHORT,input.data());
        const auto uploaded=timestamp();
        glBindFramebuffer(GL_FRAMEBUFFER,expanded_fbo);
        glViewport(0,0,w,h);
        glUseProgram(program);
        glUniform2i(geometry,h,0);
        glUniform2i(derivative,int(std::floor(65536.f*256*(1.f/w)+.5f)),int(std::floor(65536.f*rows*(1.f/h)+.5f)));
        glEnable(GL_SCISSOR_TEST);
        glScissor(dirty.left,dirty.top,dirty.right-dirty.left,dirty.bottom-dirty.top);
        glDrawArrays(GL_TRIANGLES,0,3);
        const bool snapshot=capture && !capture->done();
        std::vector<uint32_t> pixels;
        if (snapshot) {
            pixels.resize(size_t(w)*h);
            glReadPixels(0,0,w,h,GL_RGBA,GL_UNSIGNED_BYTE,pixels.data());
            capture->expanded(pixels.data(),w,h,w*4,SDL_PIXELFORMAT_RGBA32);
        }
        glBindFramebuffer(GL_FRAMEBUFFER,targets[index].fbo);
        glBindTexture(GL_TEXTURE_2D,expanded_texture);
        glUseProgram(presenter);
        glUniform1i(present_flip,upside_down);
        glScissor(dirty.left,upside_down ? h-dirty.bottom : dirty.top,dirty.right-dirty.left,dirty.bottom-dirty.top);
        glDrawArrays(GL_TRIANGLES,0,6);
        glDisable(GL_SCISSOR_TEST);
        const auto drawn=timestamp();
        if (snapshot) {
            glReadPixels(0,0,w,h,GL_RGBA,GL_UNSIGNED_BYTE,pixels.data());
            if (upside_down) for (int y=0;y<h/2;++y)
                std::swap_ranges(pixels.begin()+size_t(y)*w,pixels.begin()+size_t(y+1)*w,pixels.begin()+size_t(h-y-1)*w);
            capture->present_input(pixels.data(),w,h,w*4,SDL_PIXELFORMAT_RGBA32);
        }
        if (glGetError()!=GL_NO_ERROR) { glFinish(); ready=false; return false; }
        if (create_sync && destroy_sync && dup_fence) {
            EGLSyncKHR sync=create_sync(display,EGL_SYNC_NATIVE_FENCE_ANDROID,nullptr);
            if (sync!=EGL_NO_SYNC_KHR) {
                glFlush(); acquire=dup_fence(display,sync); destroy_sync(display,sync);
            }
        }
        if (acquire<0) {
            glFinish();
            if (cost) ++cost->finishes;
        }
        if (cost) {
            cost->upload+=uploaded-started;
            cost->draw+=drawn-uploaded;
            cost->sync+=timestamp()-drawn;
        }
        return true;
    }
};
