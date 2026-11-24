// Android candidate. Keep the full-size RGB565 image so BufferQueue may enlarge
// the requested repaint when it returns an older buffer.
#pragma once
#include <android/native_window.h>
#include <android/hardware_buffer.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

class tv_native_window
{
	using raster = software_renderer<uint16_t, 3,2,3, 11,5,0>;
	ANativeWindow *window = nullptr;
	int width = 0, height = 0, source_w = 0, source_h = 0;
	bool compact = false, fresh = true;
	std::vector<uint16_t> image, source, previous;
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

	ARect draw_changes(const render_primitive &game)
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
			auto *expanded = image.data()+top*width+left;
			for (int x = left; x < right; ++x) expanded[x-left] = row[xs[x]];
			for (int dy = top+1; dy < bottom; ++dy)
				std::memcpy(image.data()+dy*width+left,expanded,(right-left)*sizeof(*expanded));
			dirty.left = std::min(dirty.left,left); dirty.right = std::max(dirty.right,right);
			dirty.top = std::min(dirty.top,top); dirty.bottom = std::max(dirty.bottom,bottom);
		}
		source.swap(previous);
		compact = true;
		return dirty;
	}

public:
	struct timing { int64_t draw = 0, lock = 0, copy = 0, post = 0, area = 0; bool fast = false; };
	~tv_native_window() { close(); }
	void close()
	{
		if (window) ANativeWindow_release(window);
		window = nullptr;
		fresh = true; compact = false;
	}
	bool attach(SDL_Window *sdl)
	{
		auto *next = static_cast<ANativeWindow *>(SDL_GetPointerProperty(SDL_GetWindowProperties(sdl),
					SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER,nullptr));
		if (next && next == window) return true;
		close();
		if (!next) return false;
		ANativeWindow_acquire(next);
		window = next;
		if (ANativeWindow_setBuffersGeometry(window,0,0,AHARDWAREBUFFER_FORMAT_R5G6B5_UNORM) < 0 &&
			ANativeWindow_setBuffersGeometry(window,0,0,AHARDWAREBUFFER_FORMAT_R8G8B8X8_UNORM) < 0) {
			close(); return false;
		}
		return true;
	}

	bool draw(render_primitive_list &list, int w, int h, uint8_t picture, bool menu, bool reset, timing *meter)
	{
		if (w <= 0 || h <= 0 || !window) return false;
		if ((ANativeWindow_getWidth(window) != w || ANativeWindow_getHeight(window) != h) &&
			ANativeWindow_setBuffersGeometry(window,w,h,ANativeWindow_getFormat(window)) < 0) return false;
		if (w != width || h != height || reset) {
			width = w; height = h;
			image.assign(size_t(w)*h,0); fresh = true; compact = false;
		}
		const auto now = [meter]() -> int64_t { return meter ? battlecity_tv::now_ns() : 0; };
		const auto begin = now();
		list.acquire_lock();
		const auto *game = (picture || menu) ? nullptr : screen_quad(list);
		ARect dirty{0,0,w,h};
		if (game) dirty = draw_changes(*game);
		else {
			compact = false;
			raster::draw_primitives<true>(list,image.data(),w,h,w,picture);
		}
		list.release_lock();
		if (fresh) dirty = {0,0,w,h};
		else if (dirty.left >= dirty.right || dirty.top >= dirty.bottom) dirty = {0,0,1,1};
		const auto drawn = now();
		ANativeWindow_Buffer buffer{};
		if (ANativeWindow_lock(window,&buffer,&dirty) < 0) return false;
		const auto locked = now();
		bool valid = buffer.bits && buffer.width == w && buffer.height == h && buffer.stride >= w &&
			(buffer.format == AHARDWAREBUFFER_FORMAT_R5G6B5_UNORM ||
			 buffer.format == AHARDWAREBUFFER_FORMAT_R8G8B8X8_UNORM || buffer.format == AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM) &&
			dirty.left >= 0 && dirty.right <= w && dirty.top >= 0 && dirty.bottom <= h;
		if (valid) for (int y = dirty.top; y < dirty.bottom; ++y) {
			const auto *row = image.data()+size_t(y)*w;
			size_t offset = size_t(y)*buffer.stride;
			if (buffer.format == AHARDWAREBUFFER_FORMAT_R5G6B5_UNORM)
				std::memcpy(static_cast<uint16_t *>(buffer.bits)+offset+dirty.left,row+dirty.left,(dirty.right-dirty.left)*2);
			else {
				auto *dest = static_cast<uint32_t *>(buffer.bits)+offset;
				for (int x = dirty.left; x < dirty.right; ++x) {
					const unsigned c = row[x], r = c>>11, g = (c>>5)&63, b = c&31;
					dest[x] = 0xff000000U | ((b*8+b/4)<<16) | ((g*4+g/16)<<8) | (r*8+r/4);
				}
			}
		}
		const auto copied = now();
		const bool posted = ANativeWindow_unlockAndPost(window) == 0;
		if (meter) *meter = {drawn-begin,locked-drawn,copied-locked,now()-copied,
			int64_t(dirty.right-dirty.left)*(dirty.bottom-dirty.top),compact};
		fresh = !(posted && valid);
		return !fresh;
	}
};
