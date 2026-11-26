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
    GLuint window_texture=0, window_fbo=0;
    int window_w=0,window_h=0;
    bool cache_window=true, incremental=false, sync_log=false;
    PFNEGLSWAPBUFFERSWITHDAMAGEKHRPROC swap_damage=nullptr;
    ARect changes[8]{}, surface_change{};
    unsigned history_size=0, history_next=0, log_count=0;
    bool count_repairs=false, report_damage=false, verify_marker=false;
    FILE *swap_hints=nullptr;
    uint64_t partial_copies=0, full_copies=0;
    static bool has_extension(const char *extensions,const char *name) {
        if (!extensions) return false;
        const size_t n=std::strlen(name);
        for (const char *p=extensions; (p=std::strstr(p,name)); p+=n)
            if ((p==extensions || p[-1]==' ') && (p[n]==0 || p[n]==' ')) return true;
        return false;
    }
    static bool empty(ARect r) { return r.left>=r.right || r.top>=r.bottom; }
    static ARect merged(ARect a, ARect b) {
        if (empty(a)) return b;
        if (empty(b)) return a;
        return {std::min(a.left,b.left),std::min(a.top,b.top),
                std::max(a.right,b.right),std::max(a.bottom,b.bottom)};
    }
    // Rectangles here are in EGL's bottom-left window coordinates.
    void copy_window(ARect delta,int w,int h) {
        const ARect all{0,0,w,h};
        surface_change=history_size ? delta : all;
        ARect repair=all;
        EGLint age=0;
        if (incremental && eglQuerySurface(display,surface,EGL_BUFFER_AGE_EXT,&age) &&
                age>0 && history_size && unsigned(age-1)<=history_size) {
            repair=delta;
            for (int i=1;i<age;++i)
                repair=merged(repair,changes[(history_next+8-i)%8]);
        }
        if (count_repairs) {
            if (repair.left==0 && repair.top==0 && repair.right==w && repair.bottom==h) ++full_copies;
            else ++partial_copies;
        }
        if (!empty(repair)) {
            glBindFramebuffer(GL_READ_FRAMEBUFFER,window_fbo);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0);
            glBlitFramebuffer(repair.left,repair.top,repair.right,repair.bottom,
                              repair.left,repair.top,repair.right,repair.bottom,GL_COLOR_BUFFER_BIT,GL_NEAREST);
        }
        glBindFramebuffer(GL_FRAMEBUFFER,0);
    }
    void flush_logs() {
        for (FILE *f : {frames,boundaries,presentations,swap_hints}) if (f) std::fflush(f);

    }
    GLint geometry=-1, derivative=-1;
    int native_w=0,native_h=0;
    enum class profile_mode { game, prepared, upload, direct };
    profile_mode mode=profile_mode::game;
    std::string fixed_marker;
    bool prepared=false, measure_producer=false, producer_complete=false;
    FILE *boundaries=nullptr;
    std::string producer_path;
    GLint viewport=-1;
    int texture_w=0, texture_h=0;
    PFNEGLGETNEXTFRAMEIDANDROIDPROC next_id=nullptr;
    PFNEGLGETFRAMETIMESTAMPSANDROIDPROC timestamps=nullptr;
    bool present_supported=false;
    struct frame_id { uint64_t nes; EGLuint64KHR buffer; };
    std::deque<frame_id> pending;
    FILE *frames=nullptr, *presentations=nullptr;
    static FILE *open_log(const std::string &path) {
        FILE *file=std::fopen(path.c_str(),"a");
        if (file) std::setvbuf(file,nullptr,_IOFBF,128*1024);
        return file;
    }
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
        if (sync_log && presentations) std::fflush(presentations);
    }
public:
    void finish_sample() { flush_logs(); }
    ~tv_egl_window() {
        close();
        if (swap_hints) std::fclose(swap_hints);
        if (boundaries) std::fclose(boundaries);
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
        window_texture=window_fbo=0; window_w=window_h=0; cache_window=true;
        texture_w=texture_h=native_w=native_h=0; prepared=false; mode=profile_mode::game;
        flush_logs();
        pending.clear(); present_supported=false;
        history_size=history_next=0; incremental=false; swap_damage=nullptr;
        count_repairs=report_damage=verify_marker=false;
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
        const auto *extensions=eglQueryString(display,EGL_EXTENSIONS);
        const bool age_supported=has_extension(extensions,"EGL_EXT_buffer_age") ||
            has_extension(extensions,"EGL_KHR_partial_update");
        const bool khr_damage=has_extension(extensions,"EGL_KHR_swap_buffers_with_damage");
        if (khr_damage)
            swap_damage=reinterpret_cast<PFNEGLSWAPBUFFERSWITHDAMAGEKHRPROC>(eglGetProcAddress("eglSwapBuffersWithDamageKHR"));
        else if (has_extension(extensions,"EGL_EXT_swap_buffers_with_damage"))
            swap_damage=reinterpret_cast<PFNEGLSWAPBUFFERSWITHDAMAGEKHRPROC>(eglGetProcAddress("eglSwapBuffersWithDamageEXT"));
        incremental=age_supported && !(measuring && root && ::access((std::string(root)+"/tv-egl-full-copy").c_str(),F_OK)==0);
        report_damage=swap_damage && !(measuring && root && ::access((std::string(root)+"/tv-plain-swap").c_str(),F_OK)==0);
        verify_marker=measuring && root && ::access((std::string(root)+"/tv-moving-check").c_str(),F_OK)==0;
        sync_log=measuring && root && ::access((std::string(root)+"/tv-sync-log").c_str(),F_OK)==0;
        count_repairs=measuring;
        const bool immediate=measuring && root && ::access((std::string(root)+"/tv-egl-immediate").c_str(),F_OK)==0;
        if (!eglSwapInterval(display,immediate ? 0 : 1)) return false;
        if (measuring && root) {
            cache_window=::access((std::string(root)+"/tv-egl-uncached").c_str(),F_OK)!=0;
            fixed_marker=std::string(root)+"/tv-fixed";
            measure_producer=::access((std::string(root)+"/tv-producer-only").c_str(),F_OK)==0;
            producer_path=std::string(root)+"/tv-producer.json";
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
        if (cache_window) {
            texture(window_texture,GL_NEAREST);
            glGenFramebuffers(1,&window_fbo);
        }
        glDisable(GL_BLEND); glDisable(GL_DITHER);
        ++generation;
        next_id=(PFNEGLGETNEXTFRAMEIDANDROIDPROC)eglGetProcAddress("eglGetNextFrameIdANDROID");
        timestamps=(PFNEGLGETFRAMETIMESTAMPSANDROIDPROC)eglGetProcAddress("eglGetFrameTimestampsANDROID");
        auto supported=(PFNEGLGETFRAMETIMESTAMPSUPPORTEDANDROIDPROC)eglGetProcAddress("eglGetFrameTimestampSupportedANDROID");
        if (battlecity_tv::measuring.load(std::memory_order_relaxed)) {
            present_supported=timestamps && supported && eglSurfaceAttrib(display,surface,EGL_TIMESTAMPS_ANDROID,EGL_TRUE)
                && supported(display,surface,EGL_DISPLAY_PRESENT_TIME_ANDROID);
            if (root && !boundaries) boundaries=open_log(std::string(root)+"/tv-boundaries.csv");
            if (root && !swap_hints) swap_hints=open_log(std::string(root)+"/tv-hints.csv");
            if (root && !frames) frames=open_log(std::string(root)+"/tv-frame-map.csv");
            if (root && !presentations) presentations=open_log(std::string(root)+"/tv-present.csv");
            EGLint minimum=0,maximum=0;
            eglGetConfigAttrib(display,config,EGL_MIN_SWAP_INTERVAL,&minimum);
            eglGetConfigAttrib(display,config,EGL_MAX_SWAP_INTERVAL,&maximum);
            if (root) {
                if (FILE *file=std::fopen((std::string(root)+"/tv-window.txt").c_str(),"a")) {
                    std::fprintf(file,"bufferAge=%d swapDamage=%d incremental=%d perFrameFlush=%d hintApi=%s\n",
                                 age_supported,swap_damage!=nullptr,incremental,sync_log,
                                 report_damage ? (khr_damage ? "KHR" : "EXT") : "plain");
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
        surface_change={};
        const bool direct=mode==profile_mode::direct;
        if (!prepared && (direct || changed)) {
            glBindFramebuffer(GL_FRAMEBUFFER,direct ? 0 : framebuffer);
            glViewport(0,0,direct ? sw : w,direct ? sh : h);
            glDisableVertexAttribArray(0);
            glUseProgram(raster);
            glUniform2i(geometry,h,direct ? 1 : 0);
            glUniform2i(derivative,int(std::floor(65536.f*iw*(1.f/w)+.5f)),int(std::floor(65536.f*ih*(1.f/h)+.5f)));
            if (!direct) {
                glEnable(GL_SCISSOR_TEST);
                glScissor(dirty.left,dirty.top,dirty.right-dirty.left,dirty.bottom-dirty.top);
            }
            glDrawArrays(GL_TRIANGLES,0,3);
            glDisable(GL_SCISSOR_TEST);
        }
        if (capture && capture->needs_present() && !direct) {
            glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);
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
            // Keep the fully sampled window, including unchanged pixels. A native
            // same-size blit writes every pixel of each newly acquired back buffer.
            const bool resized=window_w!=sw || window_h!=sh;
            if (resized) history_size=history_next=0;
            if (cache_window && resized) {
                glBindTexture(GL_TEXTURE_2D,window_texture);
                glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,sw,sh,0,GL_RGBA,GL_UNSIGNED_BYTE,nullptr);
                glBindFramebuffer(GL_FRAMEBUFFER,window_fbo);
                glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,window_texture,0);
                if (glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE) return false;
            }
            window_w=sw; window_h=sh;
            if (!cache_window || resized || (!prepared && changed)) {
                glBindFramebuffer(GL_FRAMEBUFFER,cache_window ? window_fbo : 0);
                glViewport(0,0,sw,sh);
                glBindTexture(GL_TEXTURE_2D,expanded);
                glUseProgram(program);
                glEnableVertexAttribArray(0);
                glUniform2f(viewport,float(sw),float(sh));
                if (cache_window && !resized && sw==w && sh==h) {
                    // Linear sampling can move a changed input texel into a neighbour.
                    const int left=std::max(0,int(dirty.left)-1), right=std::min(w,int(dirty.right)+1);
                    const int top=std::max(0,int(dirty.top)-1), bottom=std::min(h,int(dirty.bottom)+1);
                    glEnable(GL_SCISSOR_TEST);
                    glScissor(left,h-bottom,right-left,bottom-top);
                }
                glDrawArrays(GL_TRIANGLES,0,6);
                glDisable(GL_SCISSOR_TEST);
            }
            if (cache_window) {
                ARect delta{};
                if (resized || sw!=w || sh!=h) delta={0,0,sw,sh};
                else if (changed && !prepared)
                    delta={std::max(0,int(dirty.left)-1),std::max(0,h-int(dirty.bottom)-1),
                           std::min(w,int(dirty.right)+1),std::min(h,h-int(dirty.top)+1)};
                copy_window(delta,sw,sh);
            }
        }
        if (!prepared && (mode==profile_mode::prepared || mode==profile_mode::upload) &&
                ::access(fixed_marker.c_str(),F_OK)==0) prepared=true;
        if (cost) {
            cost->upload=uploaded-start;
            cost->draw=expanded_at-uploaded;
            cost->check=now()-expanded_at;
        }
        if (capture && capture->needs_swap()) {
            std::vector<uint32_t> rgba(size_t(sw)*sh);
            glReadPixels(0,0,sw,sh,GL_RGBA,GL_UNSIGNED_BYTE,rgba.data());
            for (int y=0;y<sh/2;++y)
                std::swap_ranges(rgba.begin()+size_t(y)*sw,rgba.begin()+size_t(y+1)*sw,rgba.begin()+size_t(sh-1-y)*sw);
            capture->swap_input(rgba.data(),sw,sh,sw*4,SDL_PIXELFORMAT_RGBA32);
        }
        if (window_w!=logged_width || window_h!=logged_height) {
            logged_width=window_w; logged_height=window_h;
            const char *dir=SDL_GetAndroidInternalStoragePath();
            if (frames && dir) {
                if (auto *log=std::fopen((std::string(dir)+"/tv-window.txt").c_str(),"a")) {
                    std::fprintf(log,"logical=%dx%d egl=%dx%d\n",w,h,sw,sh);
                    std::fclose(log);
                }
            }
        }
        // Once the fixture is ready, hold the emulation thread inside this bounded
        // producer loop. Frame numbers here are synthetic and never enter gameplay metrics.
        if (measure_producer && !producer_complete && ::access(fixed_marker.c_str(),F_OK)==0) {
            producer_complete=true;
            constexpr uint64_t first=uint64_t(1)<<40;
            auto start_time=battlecity_tv::now_ns();
            uint64_t count=0;
            int64_t last=start_time;
            // Both positions are inside the visible crop. Restore the previous
            // square from the cached game image before drawing its new position.
            const ARect left{192,120,200,128}, right{216,120,224,128};
            const ARect movement=merged(left,right);
            auto paint_marker=[&](ARect spot) {
                glEnable(GL_SCISSOR_TEST);
                glScissor(spot.left,spot.top,spot.right-spot.left,spot.bottom-spot.top);
                glClearColor(1.f,0.f,1.f,1.f);
                glClear(GL_COLOR_BUFFER_BIT);
                glDisable(GL_SCISSOR_TEST);
            };
            do {
                const auto render_start=battlecity_tv::now_ns();
                copy_window(count ? movement : ARect{0,0,sw,sh},sw,sh);
                paint_marker((count & 1) ? right : left);
                int64_t swap_start=0;
                if (!swap(first+count,render_start,swap_start)) return false;
                ++count;
                last=battlecity_tv::now_ns();
            } while (last-start_time<30000000000LL);
            flush_logs();
            // Restore the prepared image before returning to normal emulation.
            copy_window({0,0,sw,sh},sw,sh);
            const auto temp=producer_path+".tmp";
            if (auto *file=std::fopen(temp.c_str(),"w")) {
                std::fprintf(file,"{\"frames\":%llu,\"lastSubmittedFrame\":%llu,\"wall\":%.9f,\"width\":%d,\"height\":%d}\n",
                    (unsigned long long)count,(unsigned long long)(first+count-1),(last-start_time)/1e9,sw,sh);
                if (std::fclose(file)==0) std::rename(temp.c_str(),producer_path.c_str());
            }
            if (verify_marker) {
                for (int phase=0;phase<4;++phase) {
                    copy_window(phase ? movement : ARect{0,0,sw,sh},sw,sh);
                    if (phase==1 || phase==2) paint_marker(phase==1 ? left : right);
                    int64_t stamp=0;
                    if (!swap(0,0,stamp)) return false;
                    const auto ready=fixed_marker+"-probe-"+std::to_string(phase);
                    FILE *flag=std::fopen(ready.c_str(),"w");
                    if (!flag) return false;
                    std::fclose(flag);
                    const auto deadline=battlecity_tv::now_ns()+90000000000LL;
                    while (::access(ready.c_str(),F_OK)==0) {
                        if (battlecity_tv::now_ns()>deadline) return false;
                        SDL_Delay(20);
                    }
                }
                copy_window({0,0,sw,sh},sw,sh);
            }
        }
        return swap(frame,start,before_swap);
    }
private:
    int logged_width=0,logged_height=0;
    bool swap(uint64_t frame,int64_t render_start,int64_t &before_swap) {
        EGLuint64KHR id=0;
        if (frame && frames && next_id && !next_id(display,surface,&id)) id=0;
        before_swap=frame ? battlecity_tv::now_ns() : 0;
        EGLBoolean success;
        const bool hinted=report_damage && cache_window && !empty(surface_change);
        if (hinted) {
            EGLint rect[]={surface_change.left,surface_change.top,surface_change.right-surface_change.left,
                           surface_change.bottom-surface_change.top};
            success=swap_damage(display,surface,rect,1);
        } else success=eglSwapBuffers(display,surface);
        if (!success) { history_size=history_next=0; return false; }
        changes[history_next]=surface_change;
        history_next=(history_next+1)%8;
        history_size=std::min(history_size+1,8u);
        if (frame && frames) {
            const auto after_swap=battlecity_tv::now_ns();
            if (boundaries) {
                std::fprintf(boundaries,"%u,%llu,%lld,%lld,%lld\n",generation,(unsigned long long)frame,
                    (long long)render_start,(long long)before_swap,(long long)after_swap);

            }
            std::fprintf(frames,"%u,%llu,%llu,%lld\n",generation,(unsigned long long)frame,(unsigned long long)id,
                         (long long)(after_swap-before_swap));
            if (swap_hints) {
                const ARect reported=hinted ? surface_change : ARect{0,0,window_w,window_h};
                std::fprintf(swap_hints,"%u,%llu,%d,%d,%d,%d,%d\n",generation,(unsigned long long)frame,
                    int(hinted),reported.left,reported.top,reported.right-reported.left,reported.bottom-reported.top);
            }
            if ((log_count+1)%128==0 && count_repairs) {
                const char *dir=SDL_GetAndroidInternalStoragePath();
                if (dir) if (auto *f=std::fopen((std::string(dir)+"/tv-window.txt").c_str(),"a")) {
                    std::fprintf(f,"copiesFull=%llu copiesPartial=%llu\n",
                                 (unsigned long long)full_copies,(unsigned long long)partial_copies);
                    std::fclose(f);
                }
            }
            ++log_count;
            if (sync_log || log_count%128==0) flush_logs();
            if (id && present_supported && presentations) pending.push_back({frame,id});
        }
        if (!pending.empty()) poll_presentations();
        return true;
    }
};
