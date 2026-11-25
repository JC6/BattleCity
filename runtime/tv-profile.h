// Optional measurements for a dedicated Android test profile.
#pragma once
#include <android/trace.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <string>
#include <time.h>

namespace battlecity_tv {
inline std::atomic<bool> measuring{false};
inline std::atomic<uint64_t> pcm_frames{0};
inline std::atomic<unsigned> pcm_rate{0};

inline int64_t now_ns()
{
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

inline int64_t thread_ns()
{
    timespec value{};
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value);
    return int64_t(value.tv_sec) * 1000000000 + value.tv_nsec;
}

struct sample {
    int64_t wall, cpu;
    double emulated;
    uint64_t frame, pcm;
};

class frame_meter {
public:
    void open(const char *directory)
    {
        if (!directory) return;
        path = std::string(directory) + "/tv-profile.jsonl";
        // Only the test harness creates this file in app-private storage.
        if (auto *file = std::fopen(path.c_str(), "r")) {
            std::fclose(file);
            instrumented = active = true;
            measuring.store(true, std::memory_order_relaxed);
        }
    }

    bool needs_boundary(double emulated) const {
        return active && emulated>=10.0 && (!start.wall || now_ns()-start.wall>=30000000000LL);
    }
    void finish(double emulated, uint64_t frame, const char *driver, bool native_size,
                int64_t began, int64_t before_present, bool presented, int vsync, int width, int height,
                int64_t lock=0, int64_t copy=0, int64_t post=0, int64_t area=0, int64_t waiting=0,
                uint64_t sent=0, uint64_t complete=0, uint64_t last_frame=0, int64_t latency=0,
                bool drained=false)
    {
        const auto wall = now_ns();
        if (emulated < 10.0) return;
        ++attempts;
        wait_ns+=waiting; lock_ns+=lock; copy_ns+=copy; post_ns+=post; copied_area+=area;
        submissions += presented;
        compact += native_size;
        render_ns += before_present - began;
        present_ns += wall - before_present;
        if (start.wall && (wall-start.wall < 30000000000LL || (sent && !drained))) return;
        sample end{wall, thread_ns(), emulated, frame, pcm_frames.load(std::memory_order_relaxed)};
        if (start.wall) {
            ++windows;
            if (auto *file = std::fopen(path.c_str(), "a")) {
                std::fprintf(file, "{\"run\":%d,\"driver\":\"%s\",\"wall\":%.9f,\"emu\":%.9f,"
                    "\"frames\":%llu,\"attempts\":%u,\"presented\":%u,\"nativeSize\":%u,\"vsync\":%d,\"bufferWidth\":%d,\"bufferHeight\":%d,"
                    "\"samples\":%llu,\"sampleRate\":%u,\"drawMs\":%.3f,\"presentMs\":%.3f,"
                    "\"coreSliceMs\":%.3f,\"threadCpuMs\":%.3f,\"lockMs\":%.3f,\"copyMs\":%.3f,\"postMs\":%.3f,\"writtenPixels\":%lld,\"waitMs\":%.3f,\"transactions\":%llu,\"completions\":%llu,\"pending\":%llu,\"lastCompletedFrame\":%llu,\"lastSubmittedFrame\":%llu,\"completionMs\":%.3f}\n",
                    windows, driver, (end.wall-start.wall)/1e9, end.emulated-start.emulated,
                    static_cast<unsigned long long>(end.frame-start.frame), attempts, submissions, compact, vsync, width, height,
                    static_cast<unsigned long long>(end.pcm-start.pcm), pcm_rate.load(std::memory_order_relaxed),
                    render_ns/1e6, present_ns/1e6, core_ns.load(std::memory_order_relaxed)/1e6,
                    (end.cpu-start.cpu)/1e6, lock_ns/1e6, copy_ns/1e6, post_ns/1e6, static_cast<long long>(copied_area),wait_ns/1e6,
                    static_cast<unsigned long long>(sent-start_sent),static_cast<unsigned long long>(complete-start_complete),
                    static_cast<unsigned long long>(sent-complete),static_cast<unsigned long long>(last_frame),
                    static_cast<unsigned long long>(frame),(latency-start_latency)/1e6);
                std::fclose(file);
            }
        }
        start=end; start_sent=sent; start_complete=complete; start_latency=latency; wait_ns=0;
        attempts=submissions=compact=0;
        render_ns=present_ns=0;
        lock_ns=copy_ns=post_ns=copied_area=0;
        core_ns.store(0, std::memory_order_relaxed);
        if (windows==3) {
            active=false;
            measuring.store(false, std::memory_order_relaxed);
        }
    }

    bool instrumented=false;
    bool active=false;
    inline static std::atomic<int64_t> core_ns{0};
private:
    std::string path;
    sample start{};
    int windows=0;
    uint64_t start_sent=0, start_complete=0;
    int64_t start_latency=0, wait_ns=0;
    unsigned attempts=0, submissions=0, compact=0;
    int64_t render_ns=0, present_ns=0;
    int64_t lock_ns=0, copy_ns=0, post_ns=0, copied_area=0;
};
} // namespace battlecity_tv
