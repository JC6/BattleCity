// One EGL producer for the existing SurfaceView. Presentation observations are
// enabled only by the private test profile, and never stall the game thread.
#pragma once
#include <deque>

class tv_egl_window {
    EGLDisplay display=EGL_NO_DISPLAY;
    EGLSurface surface=EGL_NO_SURFACE;
    EGLContext context=EGL_NO_CONTEXT;
    bool own_surface=false;
    GLuint program=0, texture=0;
    GLint geometry=-1, derivative=-1;
    int texture_w=0, texture_h=0;
    PFNEGLGETNEXTFRAMEIDANDROIDPROC next_id=nullptr;
    PFNEGLGETFRAMETIMESTAMPSANDROIDPROC timestamps=nullptr;
    bool present_supported=false;
    struct frame_id { uint64_t nes; EGLuint64KHR buffer; };
    std::deque<frame_id> pending;
    FILE *frames=nullptr, *presentations=nullptr;
    unsigned generation=0;

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
        program=texture=0; texture_w=texture_h=0;
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
        if (!eglSwapInterval(display,1)) return false;
        program=battlecity_tv::raster_program();
        if (!program) return false;
        glUseProgram(program);
        geometry=glGetUniformLocation(program,"geometry");
        derivative=glGetUniformLocation(program,"derivative");
        glUniform1i(glGetUniformLocation(program,"source"),0);
        glGenTextures(1,&texture); glBindTexture(GL_TEXTURE_2D,texture);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
        glDisable(GL_BLEND); glDisable(GL_DITHER);
        ++generation;
        next_id=(PFNEGLGETNEXTFRAMEIDANDROIDPROC)eglGetProcAddress("eglGetNextFrameIdANDROID");
        timestamps=(PFNEGLGETFRAMETIMESTAMPSANDROIDPROC)eglGetProcAddress("eglGetFrameTimestampsANDROID");
        auto supported=(PFNEGLGETFRAMETIMESTAMPSUPPORTEDANDROIDPROC)eglGetProcAddress("eglGetFrameTimestampSupportedANDROID");
        if (battlecity_tv::measuring.load(std::memory_order_relaxed)) {
            present_supported=timestamps && supported && eglSurfaceAttrib(display,surface,EGL_TIMESTAMPS_ANDROID,EGL_TRUE)
                && supported(display,surface,EGL_DISPLAY_PRESENT_TIME_ANDROID);
            const char *root=SDL_GetAndroidInternalStoragePath();
            if (root && !frames) frames=std::fopen((std::string(root)+"/tv-frame-map.csv").c_str(),"a");
            if (root && !presentations) presentations=std::fopen((std::string(root)+"/tv-present.csv").c_str(),"a");
            SDL_Log("BattleCity EGL window: generation %u, display timestamp %d",generation,present_supported);
        }
        return glGetError()==GL_NO_ERROR;
    }
    bool draw(const std::vector<uint16_t> &pixels,int iw,int ih,int w,int h,uint64_t frame,
              tv_stage_capture *capture,int64_t &before_swap) {
        if (eglGetCurrentContext()!=context && !eglMakeCurrent(display,surface,surface,context)) return false;
        EGLint sw=0,sh=0;
        if (!eglQuerySurface(display,surface,EGL_WIDTH,&sw) || !eglQuerySurface(display,surface,EGL_HEIGHT,&sh) || sw<=0 || sh<=0) return false;
        glViewport(0,0,sw,sh);
        glBindTexture(GL_TEXTURE_2D,texture);
        if (iw!=texture_w || ih!=texture_h) {
            glPixelStorei(GL_UNPACK_ALIGNMENT,2);
            glTexImage2D(GL_TEXTURE_2D,0,GL_R16UI,iw,ih,0,GL_RED_INTEGER,GL_UNSIGNED_SHORT,nullptr);
            texture_w=iw; texture_h=ih;
        }
        glTexSubImage2D(GL_TEXTURE_2D,0,0,0,iw,ih,GL_RED_INTEGER,GL_UNSIGNED_SHORT,pixels.data());
        glUniform2i(geometry,sh,1);
        glUniform2i(derivative,int(std::floor(65536.f*iw*(1.f/sw)+.5f)),int(std::floor(65536.f*ih*(1.f/sh)+.5f)));
        glDrawArrays(GL_TRIANGLES,0,3);
        if (capture && capture->needs_swap() && sw==w && sh==h) {
            std::vector<uint32_t> rgba(size_t(sw)*sh);
            glReadPixels(0,0,sw,sh,GL_RGBA,GL_UNSIGNED_BYTE,rgba.data());
            for (int y=0;y<sh/2;++y)
                std::swap_ranges(rgba.begin()+size_t(y)*sw,rgba.begin()+size_t(y+1)*sw,rgba.begin()+size_t(sh-1-y)*sw);
            capture->present_input(rgba.data(),sw,sh,sw*4,SDL_PIXELFORMAT_RGBA32);
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
