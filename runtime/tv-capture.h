// Enabled only by an app-private file created by the frozen-frame device test.
#pragma once
#include <unistd.h>

class tv_stage_capture
{
    using raster = software_renderer<uint32_t,0,0,0,16,8,0>;
    std::string directory;
    bool pattern = false, captured = false, presented = false;
    std::vector<uint32_t> calibration;

    bool write_ppm(const char *name, const void *pixels, int w, int h, int pitch, SDL_PixelFormat format)
    {
        std::vector<uint8_t> rgb(size_t(w)*h*3);
        if (!SDL_ConvertPixels(w,h,format,pixels,pitch,SDL_PIXELFORMAT_RGB24,rgb.data(),w*3)) return false;
        FILE *file = std::fopen((directory+name).c_str(),"wb");
        if (!file) return false;
        bool ok = std::fprintf(file,"P6\n%d %d\n255\n",w,h)>0 &&
            std::fwrite(rgb.data(),1,rgb.size(),file)==rgb.size();
        return std::fclose(file)==0 && ok;
    }
public:
    void open(const char *dir)
    {
        if (!dir) return;
        const std::string path=std::string(dir)+"/tv-capture";
        if (FILE *file=std::fopen(path.c_str(),"r")) {
            pattern=std::fgetc(file)=='P';
            std::fclose(file);
            directory=std::string(dir)+"/";
        }
    }
    bool done() const { return captured; }
    bool armed() const {
        return !directory.empty() && (!captured || pattern) && ::access((directory+"tv-fixed").c_str(),F_OK)==0;
    }
    // The primitive list can be shared. Restore the texture before releasing the list lock.
    struct replacement {
        render_primitive *primitive = nullptr;
        render_texinfo texture{};
        uint32_t flags = 0;
        void restore() { if (primitive) { primitive->texture=texture; primitive->flags=flags; } }
    };
    void source(render_primitive_list &list, replacement &saved)
    {
        for (auto &p:list) {
            if (!PRIMFLAG_GET_SCREENTEX(p.flags) || p.texture.width!=256 ||
                (p.texture.height!=224 && p.texture.height!=240)) continue;
            int w=p.texture.width, h=p.texture.height;
            if (pattern) {
                if (calibration.size()!=size_t(w*h)) {
                    calibration.resize(w*h);
                    constexpr uint32_t bars[]={0,0xffffff,0xff0000,0x00ff00,0x0000ff,0xcc7f35,0x456789,0x808080};
                    for (int y=0;y<h;++y) for(int x=0;x<w;++x)
                        calibration[y*w+x] = y<h/2 ? bars[(8*x)/w] : ((x%17==0 || y%13==0) ? 0xffffff : 0);
                }
                saved={&p,p.texture,p.flags};
                p.texture.base=calibration.data(); p.texture.rowpixels=w; p.texture.palette=nullptr;
                p.flags=(p.flags & ~PRIMFLAG_TEXFORMAT_MASK) | PRIMFLAG_TEXFORMAT(TEXFORMAT_RGB32);
            }
            if (!captured) {
                render_primitive copy=p;
                copy.bounds={0,0,float(w),float(h)};
                std::vector<uint32_t> rgb(size_t(w)*h);
                raster::draw_game_quad(copy,rgb.data(),w,h,w,0);
                write_ppm("tv-source.ppm",rgb.data(),w,h,w*4,SDL_PIXELFORMAT_XRGB8888);
            }
            break;
        }
    }
    void present_input(const void *pixels,int w,int h,int pitch,SDL_PixelFormat format) {
        if (!presented && write_ppm("tv-layer.tmp",pixels,w,h,pitch,format))
            presented=std::rename((directory+"tv-layer.tmp").c_str(),(directory+"tv-layer.ppm").c_str())==0;
    }
    void software_present_input(SDL_Renderer *renderer) {
        if (presented || !renderer) return;
        if (auto *surface=SDL_RenderReadPixels(renderer,nullptr)) {
            present_input(surface->pixels,surface->w,surface->h,surface->pitch,surface->format);
            SDL_DestroySurface(surface);
        }
    }
    void expanded(const void *pixels,int w,int h,int pitch,SDL_PixelFormat format)
    {
        if (captured) return;
        if (write_ppm("tv-expanded.tmp",pixels,w,h,pitch,format))
            captured=std::rename((directory+"tv-expanded.tmp").c_str(),(directory+"tv-expanded.ppm").c_str())==0;
    }
};
