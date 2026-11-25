// One EGL producer for the existing SurfaceView. Presentation observations are
// enabled only by the private test profile, and never stall the game thread.
#pragma once
#include <deque>

class tv_egl_window {
    EGLDisplay display=EGL_NO_DISPLAY;
    EGLSurface surface=EGL_NO_SURFACE;
    EGLContext context=EGL_NO_CONTEXT;
    bool own_surface=false;
    GLuint program=0, raster=0, native=0, expanded=0, framebuffer=0, corners=0;
    GLint geometry=-1, derivative=-1;
    int native_w=0,native_h=0;
    enum class profile_mode { game, prepared, upload, direct };
    profile_mode mode=profile_mode::game;
    std::string fixed_marker;
    bool prepared=false;
    GLint viewport=-1;
    int texture_w=0, texture_h=0;
    PFNEGLGETNEXTFRAMEIDANDROIDPROC next_id=nullptr;
    PFNEGLGETFRAMETIMESTAMPSANDROIDPROC timestamps=nullptr;
    bool present_supported=false;
    struct frame_id { uint64_t nes; EGLuint64KHR buffer; };
    std::deque<frame_id> pending;
    FILE *frames=nullptr, *presentations=nullptr;
    unsigned generation=0;

    static void texture(GLuint &id, GLint filter) {
        glGenTextures(1,&id);
        glBindTexture(GL_TEXTURE_2D,id);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,filter);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,filter);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
    }

    void poll_presentations() {
        while (!pending.empty()) {
            auto const item=pending.front();
            const EGLint field=EGL_DISPLAY_PRESENT_TIME_ANDROID;
            EGLnsecsANDROID time=EGL_TIMESTAMP_INVALID_ANDROID;
            const bool ok=timestamps(display,surface,item.buffer,1,&field,&time);
            if (ok && time==EGL_TIMESTAMP_PENDING_ANDROID && pending.size()<64) break;
            std::fprintf(presentations,"%u,%llu,%llu,%lld\n",generation,
                (unsigned long long)item.nes,(unsigned long long)item.buffer,(long long)(ok ? time : EGL_TIMESTAMP_INVALID_ANDROID));
            pending.pop_front();
        }
        if (presentations) std::fflush(presentations);
    }
public:
    ~tv_egl_window() {
        close();
        if (frames) std::fclose(frames);
        if (presentations) std::fclose(presentations);
    }
    void close() {
        if (display!=EGL_NO_DISPLAY && context!=EGL_NO_CONTEXT) {
            if (eglGetCurrentContext()==context) {
                eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
            }
            eglDestroyContext(display,context);
        }
        if (own_surface && surface!=EGL_NO_SURFACE) eglDestroySurface(display,surface);
        context=EGL_NO_CONTEXT; surface=EGL_NO_SURFACE;
        // SDL also uses the default display and owns its process-wide lifetime.
        display=EGL_NO_DISPLAY; own_surface=false;
        program=raster=native=expanded=framebuffer=corners=0;
        texture_w=texture_h=native_w=native_h=0; prepared=false; mode=profile_mode::game;
        pending.clear(); present_supported=false;
    }
    bool open(ANativeWindow *window,EGLSurface existing) {
        if (context!=EGL_NO_CONTEXT && program) return true;
        close();
        display=eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (display==EGL_NO_DISPLAY || !eglInitialize(display,nullptr,nullptr)) return false;
        EGLConfig config{}; EGLint n=0;
        EGLint id=0;
        const EGLint desired[]={EGL_SURFACE_TYPE,EGL_WINDOW_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT_KHR,
            EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
        if (existing!=EGL_NO_SURFACE && !eglQuerySurface(display,existing,EGL_CONFIG_ID,&id)) return false;
        const EGLint by_id[]={EGL_CONFIG_ID,id,EGL_NONE};
        if (!eglChooseConfig(display,id ? by_id : desired,&config,1,&n) || n!=1) return false;
        const EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};
        context=eglCreateContext(display,config,EGL_NO_CONTEXT,attrs);
        if (context==EGL_NO_CONTEXT) return false;
        own_surface=existing==EGL_NO_SURFACE;
        surface=own_surface ? eglCreateWindowSurface(display,config,window,nullptr) : existing;
        if (surface==EGL_NO_SURFACE || !eglMakeCurrent(display,surface,surface,context)) return false;
        const char *root=SDL_GetAndroidInternalStoragePath();
        const bool measuring=battlecity_tv::measuring.load(std::memory_order_relaxed);
        const bool immediate=measuring && root && ::access((std::string(root)+"/tv-egl-immediate").c_str(),F_OK)==0;
        if (!eglSwapInterval(display,immediate ? 0 : 1)) return false;
        if (measuring && root) {
            fixed_marker=std::string(root)+"/tv-fixed";
            if (::access((std::string(root)+"/tv-egl-prepared").c_str(),F_OK)==0) mode=profile_mode::prepared;
            if (::access((std::string(root)+"/tv-egl-upload").c_str(),F_OK)==0) mode=profile_mode::upload;
            if (::access((std::string(root)+"/tv-egl-direct").c_str(),F_OK)==0) mode=profile_mode::direct;
        }
        const char *vertex=R"(#version 300 es
uniform highp vec2 viewport;
out highp vec2 uv;
layout(location=0) in vec2 corner;
void main() {
    uv=corner;
    vec2 pos=uv*viewport;
    gl_Position=vec4(pos*(vec2(2.0,-2.0)/viewport)+vec2(-1.0,1.0),0.0,1.0);
})";
        const char *fragment=R"(#version 300 es
precision mediump float;
in highp vec2 uv;
uniform sampler2D source;
out vec4 color;
void main() { color=texture(source,uv); }
)";
        const char *legacy=R"(#version 300 es
uniform highp vec2 viewport;
out highp vec2 uv;
void main() {
    const vec2 positions[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(1,1),vec2(0,0),vec2(1,1),vec2(0,1));
    uv=positions[gl_VertexID];
    gl_Position=vec4((uv*viewport)*(vec2(2.0,-2.0)/viewport)+vec2(-1.0,1.0),0.0,1.0);
})";
        const bool reproduce=root && ::access((std::string(root)+"/tv-egl-legacy").c_str(),F_OK)==0;
        program=battlecity_tv::link(reproduce ? legacy : vertex,fragment);
        if (!program) return false;
        glUseProgram(program);
        viewport=glGetUniformLocation(program,"viewport");
        glUniform1i(glGetUniformLocation(program,"source"),0);
        raster=battlecity_tv::raster_program();
        if (!raster) return false;
        glUseProgram(raster);
        geometry=glGetUniformLocation(raster,"geometry");
        derivative=glGetUniformLocation(raster,"derivative");
        glUniform1i(glGetUniformLocation(raster,"source"),0);
        // The emulator's ES 3 SwiftShader leaves the framebuffer untouched when
        // the six screen corners are fetched from a shader-local indexed array.
        constexpr GLfloat vertices[]={0,0,1,0,1,1,0,0,1,1,0,1};
        glGenBuffers(1,&corners);
        glBindBuffer(GL_ARRAY_BUFFER,corners);
        glBufferData(GL_ARRAY_BUFFER,sizeof(vertices),vertices,GL_STATIC_DRAW);
        glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,nullptr);
        texture(native,GL_NEAREST);
        texture(expanded,GL_LINEAR);
        glGenFramebuffers(1,&framebuffer);
        glDisable(GL_BLEND); glDisable(GL_DITHER);
        ++generation;
        next_id=(PFNEGLGETNEXTFRAMEIDANDROIDPROC)eglGetProcAddress("eglGetNextFrameIdANDROID");
        timestamps=(PFNEGLGETFRAMETIMESTAMPSANDROIDPROC)eglGetProcAddress("eglGetFrameTimestampsANDROID");
        auto supported=(PFNEGLGETFRAMETIMESTAMPSUPPORTEDANDROIDPROC)eglGetProcAddress("eglGetFrameTimestampSupportedANDROID");
        if (battlecity_tv::measuring.load(std::memory_order_relaxed)) {
            present_supported=timestamps && supported && eglSurfaceAttrib(display,surface,EGL_TIMESTAMPS_ANDROID,EGL_TRUE)
                && supported(display,surface,EGL_DISPLAY_PRESENT_TIME_ANDROID);
            if (root && !frames) frames=std::fopen((std::string(root)+"/tv-frame-map.csv").c_str(),"a");
            if (root && !presentations) presentations=std::fopen((std::string(root)+"/tv-present.csv").c_str(),"a");
            EGLint minimum=0,maximum=0;
            eglGetConfigAttrib(display,config,EGL_MIN_SWAP_INTERVAL,&minimum);
            eglGetConfigAttrib(display,config,EGL_MAX_SWAP_INTERVAL,&maximum);
            if (root) {
                if (FILE *file=std::fopen((std::string(root)+"/tv-window.txt").c_str(),"a")) {
                    std::fprintf(file,"generation=%u renderer=%s requestedInterval=%d configMin=%d configMax=%d displayTimestamps=%d\n",
                        generation,reinterpret_cast<const char *>(glGetString(GL_RENDERER)),immediate ? 0 : 1,minimum,maximum,present_supported);
                    std::fclose(file);
                }
            }
            SDL_Log("BattleCity EGL window: generation %u, display timestamp %d",generation,present_supported);
        }
        return glGetError()==GL_NO_ERROR;
    }
    bool hold_input(int iw,int ih,int w,int h) const {
        return prepared && mode==profile_mode::prepared && native_w==iw && native_h==ih && texture_w==w && texture_h==h;
    }

    bool draw(const std::vector<uint16_t> &pixels,int iw,int ih,ARect dirty,int w,int h,uint64_t frame,
              tv_stage_capture *capture,int64_t &before_swap,battlecity_tv::gpu_cost *cost) {
        if (eglGetCurrentContext()!=context && !eglMakeCurrent(display,surface,surface,context)) return false;
        EGLint sw=0,sh=0;
        if (!eglQuerySurface(display,surface,EGL_WIDTH,&sw) || !eglQuerySurface(display,surface,EGL_HEIGHT,&sh) || sw<=0 || sh<=0) return false;
        const auto now=[cost](){return cost ? battlecity_tv::now_ns() : int64_t(0);};
        const auto start=now();
        glActiveTexture(GL_TEXTURE0);
        if (texture_w!=w || texture_h!=h) {
            glBindTexture(GL_TEXTURE_2D,expanded);
            glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,w,h,0,GL_RGBA,GL_UNSIGNED_BYTE,nullptr);
            glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);
            glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,expanded,0);
            if (glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE) return false;
            texture_w=w; texture_h=h; dirty={0,0,w,h}; prepared=false;
        }
        glBindTexture(GL_TEXTURE_2D,native);
        if (native_w!=iw || native_h!=ih) {
            glPixelStorei(GL_UNPACK_ALIGNMENT,2);
            glTexImage2D(GL_TEXTURE_2D,0,GL_R16UI,iw,ih,0,GL_RED_INTEGER,GL_UNSIGNED_SHORT,nullptr);
            native_w=iw; native_h=ih; dirty={0,0,w,h}; prepared=false;
        }
        bool changed=dirty.left<dirty.right && dirty.top<dirty.bottom;
        if (!hold_input(iw,ih,w,h) && (changed || mode==profile_mode::upload || capture))
            glTexSubImage2D(GL_TEXTURE_2D,0,0,0,iw,ih,GL_RED_INTEGER,GL_UNSIGNED_SHORT,pixels.data());
        const auto uploaded=now();
        const bool direct=mode==profile_mode::direct;
        if (!prepared && (direct || changed || capture)) {
            glBindFramebuffer(GL_FRAMEBUFFER,direct ? 0 : framebuffer);
            glViewport(0,0,direct ? sw : w,direct ? sh : h);
            glDisableVertexAttribArray(0);
            glUseProgram(raster);
            glUniform2i(geometry,h,direct ? 1 : 0);
            glUniform2i(derivative,int(std::floor(65536.f*iw*(1.f/w)+.5f)),int(std::floor(65536.f*ih*(1.f/h)+.5f)));
            if (!direct && !capture) {
                glEnable(GL_SCISSOR_TEST);
                glScissor(dirty.left,dirty.top,dirty.right-dirty.left,dirty.bottom-dirty.top);
            }
            glDrawArrays(GL_TRIANGLES,0,3);
            glDisable(GL_SCISSOR_TEST);
        }
        if (capture && capture->needs_present()) {
            std::vector<uint32_t> readback(size_t(w)*h);
            glReadPixels(0,0,w,h,GL_RGBA,GL_UNSIGNED_BYTE,readback.data());
            capture->present_input(readback.data(),w,h,w*4,SDL_PIXELFORMAT_RGBA32);
            // Integer texture readback requires the implementation's integer format.
            glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,native,0);
            if (glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE) {
                std::vector<uint32_t> texels(size_t(iw)*ih*4);
                glReadPixels(0,0,iw,ih,GL_RGBA_INTEGER,GL_UNSIGNED_INT,texels.data());
                if (glGetError()==GL_NO_ERROR) {
                    std::vector<uint16_t> rgb(size_t(iw)*ih);
                    for (size_t i=0;i<rgb.size();i++) rgb[i]=uint16_t(texels[4*i]);
                    capture->texture_input(rgb.data(),iw,ih);
                }
            }
            glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,expanded,0);
        }
        const auto expanded_at=now();
        if (!direct) {
            glBindFramebuffer(GL_FRAMEBUFFER,0);
            glViewport(0,0,sw,sh);
            glBindTexture(GL_TEXTURE_2D,expanded);
            glUseProgram(program);
            glEnableVertexAttribArray(0);
            glUniform2f(viewport,float(sw),float(sh));
            glDrawArrays(GL_TRIANGLES,0,6);
        }
        if (!prepared && (mode==profile_mode::prepared || mode==profile_mode::upload) &&
                ::access(fixed_marker.c_str(),F_OK)==0) prepared=true;
        if (cost) {
            cost->upload=uploaded-start;
            cost->draw=expanded_at-uploaded;
            cost->check=now()-expanded_at;
        }
        if (capture && capture->needs_swap() && sw==w && sh==h) {
            std::vector<uint32_t> rgba(size_t(sw)*sh);
            glReadPixels(0,0,sw,sh,GL_RGBA,GL_UNSIGNED_BYTE,rgba.data());
            for (int y=0;y<sh/2;++y)
                std::swap_ranges(rgba.begin()+size_t(y)*sw,rgba.begin()+size_t(y+1)*sw,rgba.begin()+size_t(sh-1-y)*sw);
            capture->swap_input(rgba.data(),sw,sh,sw*4,SDL_PIXELFORMAT_RGBA32);
        }
        EGLuint64KHR id=0;
        if (frame && frames && next_id && !next_id(display,surface,&id)) id=0;
        before_swap=frame ? battlecity_tv::now_ns() : 0;
        if (!eglSwapBuffers(display,surface)) return false;
        if (frame && frames) {
            std::fprintf(frames,"%u,%llu,%llu,%lld\n",generation,(unsigned long long)frame,(unsigned long long)id,
                         (long long)(battlecity_tv::now_ns()-before_swap));
            std::fflush(frames);
            if (id && present_supported && presentations) pending.push_back({frame,id});
        }
        if (!pending.empty()) poll_presentations();
        return true;
    }
};
