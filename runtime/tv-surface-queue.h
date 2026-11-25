// Three independently owned buffers, submitted directly to a SurfaceView child.
// API 34 returns a previous buffer's release fence with the replacing transaction.
#pragma once
#include <android/data_space.h>
#include <android/hardware_buffer.h>
#include <android/surface_control.h>
#include <array>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <poll.h>
#include <cerrno>
#include <unistd.h>

class tv_surface_queue
{
	struct slot {
		AHardwareBuffer *buffer = nullptr;
		uint32_t stride = 0;
		int fence = -1;
		bool available = true;
		ARect damage{};
		~slot() {
			if (buffer) AHardwareBuffer_release(buffer);
			if (fence >= 0) ::close(fence);
		}
	};
	struct pool {
		ASurfaceControl *control = nullptr;
		std::array<slot,3> slots;
		std::mutex mutex;
		std::condition_variable changed;
		unsigned next = 0;
		int previous = -1;
		uint64_t sent = 0, completed = 0, last_frame = 0;
		int64_t latency = 0;
		~pool() { if (control) ASurfaceControl_release(control); }
	};
	struct receipt {
		std::shared_ptr<pool> owner;
		int replaces;
		uint64_t frame;
		int64_t start;
	};
	std::shared_ptr<pool> current;
	int width = 0, height = 0;
	static bool empty(ARect r) { return r.right<=r.left || r.bottom<=r.top; }
	static ARect combined(ARect a, ARect b) {
		if (empty(a)) return b;
		if (empty(b)) return a;
		return {std::min(a.left,b.left),std::min(a.top,b.top),std::max(a.right,b.right),std::max(a.bottom,b.bottom)};
	}
	static void on_complete(void *ctx, ASurfaceTransactionStats *stats) {
		std::unique_ptr<receipt> item(static_cast<receipt *>(ctx));
		auto &p = *item->owner;
		int fence = item->replaces < 0 ? -1 : ASurfaceTransactionStats_getPreviousReleaseFenceFd(stats,p.control);
		std::lock_guard<std::mutex> lock(p.mutex);
		if (item->replaces >= 0) {
			auto &s = p.slots[item->replaces];
			s.fence = fence;
			s.available = true;
		}
		++p.completed;
		p.last_frame = std::max(p.last_frame,item->frame);
		p.latency += battlecity_tv::now_ns()-item->start;
		p.changed.notify_all();
	}
public:
	struct timing {
		int64_t wait=0, lock=0, copy=0, post=0, pixels=0;
		uint64_t submitted=0, completed=0, last_frame=0;
		int64_t latency=0;
	};
	~tv_surface_queue() { close(); }
	void close() {
		if (!current) return;
		auto *tx=ASurfaceTransaction_create();
		ASurfaceTransaction_setVisibility(tx,current->control,ASURFACE_TRANSACTION_VISIBILITY_HIDE);
		ASurfaceTransaction_reparent(tx,current->control,nullptr);
		ASurfaceTransaction_apply(tx);
		ASurfaceTransaction_delete(tx);
		current.reset();
	}
	bool configure(ANativeWindow *parent,int w,int h) {
		if (current && w==width && h==height) return true;
		close();
		auto p=std::make_shared<pool>();
		p->control=ASurfaceControl_createFromWindow(parent,"BattleCity NES");
		if (!p->control) { SDL_Log("BattleCity: SurfaceControl parent unavailable"); return false; }
		AHardwareBuffer_Desc desc{};
		desc.width=w; desc.height=h; desc.layers=1;
		desc.format=AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM;
		desc.usage=AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN | AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE;
		for (auto &s:p->slots) {
			if (int error=AHardwareBuffer_allocate(&desc,&s.buffer)) { SDL_Log("BattleCity: AHardwareBuffer allocation %d",error); return false; }
			AHardwareBuffer_Desc actual{};
			AHardwareBuffer_describe(s.buffer,&actual);
			s.stride=actual.stride;
			s.damage={0,0,w,h};
		}
		auto *tx=ASurfaceTransaction_create();
		ASurfaceTransaction_setEnableBackPressure(tx,p->control,true);
		ASurfaceTransaction_setBufferDataSpace(tx,p->control,ADATASPACE_SRGB);
		ASurfaceTransaction_setVisibility(tx,p->control,ASURFACE_TRANSACTION_VISIBILITY_SHOW);
		ASurfaceTransaction_setZOrder(tx,p->control,1);
		ASurfaceTransaction_apply(tx);
		ASurfaceTransaction_delete(tx);
		current=std::move(p); width=w; height=h;
		return true;
	}
	bool present(const std::vector<uint32_t> &rgba, ARect changed, uint64_t frame,bool drain,timing &t) {
		auto &p=*current;
		// Only the producer touches damage. Account for changes even on slots
		// that are still being read by the compositor.
		for (auto &s:p.slots) s.damage=combined(s.damage,changed);
		const auto start=battlecity_tv::now_ns();
		std::unique_lock<std::mutex> lock(p.mutex);
		int index=-1;
		if (!p.changed.wait_for(lock,std::chrono::milliseconds(250),[&] {
			for (unsigned i=0;i<p.slots.size();++i) {
				const unsigned n=(p.next+i)%p.slots.size();
				if (p.slots[n].available) { index=n; return true; }
			}
			return false;
		})) return false;
		auto &s=p.slots[index];
		s.available=false;
		p.next=(index+1)%p.slots.size();
		lock.unlock();
		auto ready=battlecity_tv::now_ns();
		const ARect dirty=s.damage;
		int acquire=-1;
		const bool repaint=!empty(dirty);
		auto locked=ready;
		int status=0;
		if (repaint) {
			void *pixels=nullptr;
			if (s.fence>=0) {
                pollfd release{s.fence,POLLIN,0};
                int result;
                do { result=poll(&release,1,250); } while (result<0 && errno==EINTR);
                if (result<=0 || !(release.revents&POLLIN)) {
                    lock.lock(); s.available=true; p.changed.notify_all(); return false;
                }
                ::close(s.fence); s.fence=-1;
                ready=battlecity_tv::now_ns();
            }
            status=AHardwareBuffer_lock(s.buffer,AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN,-1,&dirty,&pixels);
			locked=battlecity_tv::now_ns();
			if (!status) {
				for (int y=dirty.top;y<dirty.bottom;++y)
					std::memcpy(static_cast<uint32_t *>(pixels)+size_t(y)*s.stride+dirty.left,
						rgba.data()+size_t(y)*width+dirty.left,(dirty.right-dirty.left)*sizeof(uint32_t));
				status=AHardwareBuffer_unlock(s.buffer,&acquire);
			}
		}
		if (status) {
			if (acquire>=0) ::close(acquire);
			lock.lock(); s.available=true; p.changed.notify_all();
			return false;
		}
		if (!repaint) { acquire=s.fence; s.fence=-1; }
		if (s.fence>=0) { ::close(s.fence); s.fence=-1; }
		s.damage={};
		const auto copied=battlecity_tv::now_ns();
		auto *tx=ASurfaceTransaction_create();
		auto *ack=new receipt{current,p.previous,frame,copied};
		ASurfaceTransaction_setBuffer(tx,p.control,s.buffer,acquire);
		ASurfaceTransaction_setDamageRegion(tx,p.control,repaint ? &dirty : nullptr,repaint ? 1 : 0);
		ASurfaceTransaction_setOnComplete(tx,ack,on_complete);
		p.previous=index;
		lock.lock();
		const uint64_t ticket=++p.sent;
		lock.unlock();
		ASurfaceTransaction_apply(tx);
		ASurfaceTransaction_delete(tx);
		const auto posted=battlecity_tv::now_ns();
		lock.lock();
		if (drain)
			p.changed.wait_for(lock,std::chrono::milliseconds(500),[&] { return p.completed==ticket; });
		t={ready-start,locked-ready,copied-locked,posted-copied,repaint ? int64_t(dirty.right-dirty.left)*(dirty.bottom-dirty.top) : 0,
		   ticket,p.completed,p.last_frame,p.latency};
		return true;
	}
};
