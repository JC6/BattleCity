// Keep a complete CPU image. Lock the entire window buffer for replacement so
// Android can discard its old contents instead of copying unchanged regions.
#pragma once
#include <android/native_window.h>
#include <android/hardware_buffer.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>
#include "tv-capture.h"
#include "tv-surface-queue.h"

class tv_native_window
{
	using raster = software_renderer<uint16_t, 3,2,3, 11,5,0>;
	ANativeWindow *window = nullptr;
	tv_surface_queue queue;
	bool layered = false;
    bool watching = false;
    std::atomic<bool> exposed{false};
    static bool SDLCALL on_window_event(void *context,SDL_Event *event) {
        if (event->type==SDL_EVENT_DID_ENTER_FOREGROUND || event->type==SDL_EVENT_WINDOW_RESTORED ||
            event->type==SDL_EVENT_WINDOW_EXPOSED)
            static_cast<tv_native_window *>(context)->exposed.store(true,std::memory_order_relaxed);
        return true;
    }
	int width = 0, height = 0, source_w = 0, source_h = 0;
	bool compact = false, fresh = true;
	std::vector<uint16_t> image, source, previous;
	std::vector<uint32_t> rgba;
	int format = 0, last_buffer_format = 0;
	std::vector<int> xs, ys;

	static void map_axis(std::vector<int> &map, int output, int input)
	{
		map.resize(output);
		// Same 16.16 derivative and half-texel origin as MAME's nearest sampler.
		const int step = int(std::floor(65536.0f * input * (1.0f / output) + .5f));
		for (int i = 0; i < output; ++i)
			map[i] = std::min(input-1, int((int64_t(i)*step + step/2) >> 16));
	}

	const render_primitive *screen_quad(const render_primitive_list &list) const
	{
		const render_primitive *screen = nullptr;
		for (auto const &p : list) {
			if (p.type != render_primitive::QUAD || screen) return nullptr;
			if (!p.texture.base) continue; // covered by the subsequent opaque screen
			if (!PRIMFLAG_GET_SCREENTEX(p.flags) || p.color.a != 1.0f ||
				PRIMFLAG_GET_BLENDMODE(p.flags) != BLENDMODE_NONE ||
				p.texture.width != 256 || (p.texture.height != 224 && p.texture.height != 240) ||
				std::lround(p.bounds.x0) != 0 || std::lround(p.bounds.y0) != 0 ||
				std::lround(p.bounds.x1) != width || std::lround(p.bounds.y1) != height ||
				p.texcoords.tl.u != 0 || p.texcoords.tl.v != 0 || p.texcoords.tr.u != 1 ||
				p.texcoords.tr.v != 0 || p.texcoords.bl.u != 0 || p.texcoords.bl.v != 1)
				return nullptr;
			screen = &p;
		}
		return screen;
	}

	ARect draw_changes(const render_primitive &game, bool expand)
	{
		const int w = game.texture.width, h = game.texture.height;
		if (!compact || source_w != w || source_h != h) {
			source_w = w; source_h = h;
			source.resize(w*h); previous.resize(w*h);
			map_axis(xs, width, w); map_axis(ys, height, h);
			fresh = true;
		}
		render_primitive p = game;
		p.bounds = {0, 0, float(w), float(h)};
		raster::draw_game_quad(p, source.data(), w, h, w, 0);
		ARect dirty{width,height,0,0};
		for (int y = 0; y < h; ++y) {
			const uint16_t *row = source.data()+y*w;
			const uint16_t *old = previous.data()+y*w;
			int first = 0, end = w;
			if (!fresh) {
				if (!std::memcmp(row, old, w*sizeof(*row))) continue;
				while (row[first] == old[first]) ++first;
				while (row[end-1] == old[end-1]) --end;
			}
			const int left = std::lower_bound(xs.begin(),xs.end(),first)-xs.begin();
			const int right = std::lower_bound(xs.begin()+left,xs.end(),end)-xs.begin();
			const int top = std::lower_bound(ys.begin(),ys.end(),y)-ys.begin();
			const int bottom = std::upper_bound(ys.begin()+top,ys.end(),y)-ys.begin();
			if (right <= left || bottom <= top) continue;
			if (expand) {
				auto *expanded = image.data()+top*width+left;
				for (int x = left; x < right; ++x) expanded[x-left] = row[xs[x]];
				for (int dy = top+1; dy < bottom; ++dy)
					std::memcpy(image.data()+dy*width+left,expanded,(right-left)*sizeof(*expanded));
			}
			dirty.left = std::min(dirty.left,left); dirty.right = std::max(dirty.right,right);
			dirty.top = std::min(dirty.top,top); dirty.bottom = std::max(dirty.bottom,bottom);
		}
		source.swap(previous);
		compact = true;
		return dirty;
	}

	void expand_rgba(ARect dirty) {
		for (int y = dirty.top; y < dirty.bottom; ++y) {
			const auto *row = image.data()+size_t(y)*width;
			auto *dest = rgba.data()+size_t(y)*width;
			for (int x = dirty.left; x < dirty.right; ++x) {
				const unsigned c = row[x], r = c>>11, g = (c>>5)&63, b = c&31;
				// SDL's software RGB565-to-888 conversion replicates the high bits.
				dest[x] = 0xff000000U | ((b*8+b/4)<<16) | ((g*4+g/16)<<8) | (r*8+r/4);
			}
		}
	}

public:
	struct timing { tv_surface_queue::timing transaction{}; int64_t draw = 0, lock = 0, copy = 0, post = 0, area = 0; bool fast = false; };
	~tv_native_window() { if (watching) SDL_RemoveEventWatch(on_window_event,this); close(); }
	void close()
	{
		queue.close();
		if (window) ANativeWindow_release(window);
		window = nullptr;
		fresh = true; compact = false;
	}
	bool attach(SDL_Window *sdl, bool use_layer = false)
	{
		auto *next = static_cast<ANativeWindow *>(SDL_GetPointerProperty(SDL_GetWindowProperties(sdl),
					SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER,nullptr));
		if (next && next == window && layered == use_layer) return true;
		close();
		if (!next) return false;
		ANativeWindow_acquire(next);
		window = next;
		layered = use_layer;
		if (layered) {
            if (!watching) watching=SDL_AddEventWatch(on_window_event,this);
            width=height=0; return true;
        }
		for (int choice : { AHARDWAREBUFFER_FORMAT_R8G8B8X8_UNORM, AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM,
				AHARDWAREBUFFER_FORMAT_R5G6B5_UNORM }) {
			if (ANativeWindow_setBuffersGeometry(window,0,0,choice) == 0) {
				format = choice;
				width = height = 0;
				return true;
			}
		}
		close();
		return false;
	}

	bool draw(render_primitive_list &list, int w, int h, uint8_t picture, bool menu, bool reset, timing *meter, uint64_t frame=0, bool drain=false, tv_stage_capture *capture=nullptr)
	{
		if (w <= 0 || h <= 0 || !window) return false;
		if (exposed.exchange(false,std::memory_order_relaxed)) {
            if (layered) queue.close();
            reset=true;
        }
		if (w != width || h != height || reset) {
			if (layered) {
				if (!queue.configure(window,w,h)) return false;
			} else if (ANativeWindow_setBuffersGeometry(window,w,h,format) < 0) return false;
			width = w; height = h;
			image.resize(size_t(w)*h);
			rgba.resize(size_t(w)*h);
			fresh = true; compact = false;
		}
		const auto now = [meter]() -> int64_t { return meter ? battlecity_tv::now_ns() : 0; };
		const auto begin = now();
		list.acquire_lock();
		tv_stage_capture::replacement saved;
		if (capture) capture->source(list,saved);
		const auto *game = (picture || menu) ? nullptr : screen_quad(list);
		ARect dirty{0,0,w,h};
		const bool gpu_game = game && layered && queue.gpu_available();
		if (game) dirty = draw_changes(*game,!gpu_game);
		else {
			compact = false;
			raster::draw_primitives<true>(list,image.data(),w,h,w,picture);
		}
		saved.restore();
		list.release_lock();
		if (fresh) dirty = {0,0,w,h};
		if (layered) {
			if (!gpu_game) expand_rgba(dirty);
			const auto drawn = now();
			tv_surface_queue::timing txn{};
			const auto restore_cpu_image = [&] {
				for (int y=0; y<h; ++y) {
					auto *row = previous.data()+size_t(ys[y])*source_w;
					for (int x=0; x<w; ++x) image[size_t(y)*w+x]=row[xs[x]];
				}
				expand_rgba({0,0,w,h});
			};
			if (gpu_game && capture && !capture->done()) {
                restore_cpu_image();
                capture->expanded(rgba.data(),w,h,w*4,SDL_PIXELFORMAT_RGBA32);
            }
            const bool ok = queue.present(rgba,compact ? &previous : nullptr,dirty,frame,drain,txn,capture,restore_cpu_image);
			if (meter) *meter = {txn,drawn-begin,txn.lock,txn.copy,txn.post,txn.pixels,compact};
			fresh = !ok;
			return ok;
		}
		const auto drawn = now();
		ANativeWindow_Buffer buffer{};
		if (ANativeWindow_lock(window,&buffer,nullptr) < 0) { fresh = true; return false; }
		const auto locked = now();
		const bool rgb565 = buffer.format == AHARDWAREBUFFER_FORMAT_R5G6B5_UNORM;
		const bool valid = buffer.bits && buffer.width == w && buffer.height == h && buffer.stride >= w &&
			(rgb565 || buffer.format == AHARDWAREBUFFER_FORMAT_R8G8B8X8_UNORM || buffer.format == AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM);
		if (valid) {
			if (buffer.format != last_buffer_format) dirty = {0,0,w,h};
			last_buffer_format = buffer.format;
			if (!rgb565) expand_rgba(dirty);
			const size_t bytes = rgb565 ? sizeof(uint16_t) : sizeof(uint32_t);
			const auto *src = rgb565 ? reinterpret_cast<const uint8_t *>(image.data()) :
				reinterpret_cast<const uint8_t *>(rgba.data());
			auto *dest = static_cast<uint8_t *>(buffer.bits);
			if (buffer.stride == w) std::memcpy(dest,src,size_t(w)*h*bytes);
			else for (int y=0; y<h; ++y)
				std::memcpy(dest+size_t(y)*buffer.stride*bytes,src+size_t(y)*w*bytes,size_t(w)*bytes);
		}
		const auto copied = now();
		const bool posted = ANativeWindow_unlockAndPost(window) == 0;
		if (meter) *meter = {{},drawn-begin,locked-drawn,copied-locked,now()-copied,
			valid ? int64_t(w)*h : 0,compact};
		fresh = !(posted && valid);
		return !fresh;
	}
};
