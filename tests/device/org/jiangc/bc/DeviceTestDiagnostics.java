package org.jiangc.bc;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Map;
import java.util.function.Consumer;

/** Test-APK-only diagnostics, including when a synchronous UI call cannot return. */
final class DeviceTestDiagnostics {
    private static volatile TvEngine observedEngine;
    private static volatile Watchdog watchdog;
    private static String testName = "not running";
    private static Thread testThread;

    private DeviceTestDiagnostics() { }

    static void begin(String name) {
        end();
        String requested = InstrumentationRegistry.getArguments()
                .getString("battlecityEngineDiagnostics", "false");
        if (!requested.equals("true") && !requested.equals("false")) {
            throw new IllegalArgumentException("battlecityEngineDiagnostics must be true or false");
        }
        TestRenderMode.begin();
        TvEngine.requestDiagnosticsForTests(Boolean.parseBoolean(requested));
        testName = name;
        testThread = Thread.currentThread();
        watchdog = new Watchdog(name, testThread, 250, 2_000, 4_000,
                DeviceTestDiagnostics::log);
    }

    static void end() {
        Watchdog previous = watchdog;
        watchdog = null;
        if (previous != null) previous.close();
        TestRenderMode.end();
        observedEngine = null;
        testName = "not running";
        testThread = null;
        TvEngine.requestDiagnosticsForTests(false);
    }

    static void phase(String phase) {
        Watchdog current = watchdog;
        if (current != null) current.phase(phase);
    }

    /** Called on the UI thread while a test is already inspecting its target activity. */
    static void observe(TvGameActivity activity) {
        if (activity.getEngine() instanceof TvEngine engine) observedEngine = engine;
    }

    static AssertionError timeout(String message, long timeoutMillis, Throwable cause) {
        Watchdog current = watchdog;
        StringBuilder details = new StringBuilder(message)
                .append(" (timeout ").append(timeoutMillis).append(" ms)")
                .append("\ntest=").append(testName)
                .append(" phase=").append(current == null ? "not running" : current.phase)
                .append("\nPID ").append(android.os.Process.myPid())
                .append(", uptime ").append(SystemClock.uptimeMillis()).append(" ms\n");
        appendThreads(details, testThread);
        String output = details.toString();
        log(output);
        return new AssertionError(output, cause);
    }

    private static void appendThreads(StringBuilder details, Thread instrumentationThread) {
        // Do not call the UI thread or acquire the engine lock: either may be the stalled thread.
        TvEngine engine = observedEngine;
        if (engine != null) details.append(engine.diagnosticSnapshot());
        var threads = new ArrayList<>(Thread.getAllStackTraces().entrySet());
        threads.sort(Comparator.comparing(entry -> entry.getKey().getName()));
        for (Map.Entry<Thread, StackTraceElement[]> entry : threads) {
            Thread thread = entry.getKey();
            String name = thread.getName();
            if (!name.equals("main") && !name.equals("UpdateThread")
                    && !name.startsWith("GLThread") && !name.equals("BattleCity audio")
                    && thread != instrumentationThread && thread != Thread.currentThread()) continue;
            details.append('"').append(name).append("\" state=").append(thread.getState()).append('\n');
            for (StackTraceElement frame : entry.getValue()) details.append("    at ").append(frame).append('\n');
        }
    }

    private static void log(String output) {
        // Every line carries the sample identity even if other logcat messages interleave.
        String prefix = output.substring(0, output.indexOf('\n'));
        for (String line : output.split("\n")) Log.e("BattleCityTest", prefix + " | " + line);
    }

    static final class Watchdog implements AutoCloseable {
        private final Object stateLock = new Object(), outputLock = new Object();
        private final Handler main = new Handler(Looper.getMainLooper());
        private final Runnable heartbeat = this::acknowledge;
        private final String name;
        private final Thread instrumentationThread, worker;
        private final long intervalMillis, firstSampleMillis, secondSampleMillis;
        private final Consumer<String> output;
        private volatile boolean closed;
        private volatile String phase = "setup";
        private boolean pending;
        private long sentAt, lastAcknowledged = SystemClock.uptimeMillis(), heartbeatId;
        private long acknowledged, totalSamples;
        private int stallSamples;

        Watchdog(String name, Thread instrumentationThread, long intervalMillis,
                long firstSampleMillis, long secondSampleMillis, Consumer<String> output) {
            if (intervalMillis <= 0 || firstSampleMillis < intervalMillis
                    || secondSampleMillis <= firstSampleMillis) {
                throw new IllegalArgumentException("Increasing positive watchdog intervals required");
            }
            this.name = name;
            this.instrumentationThread = instrumentationThread;
            this.intervalMillis = intervalMillis;
            this.firstSampleMillis = firstSampleMillis;
            this.secondSampleMillis = secondSampleMillis;
            this.output = output;
            worker = new Thread(this::run, "BattleCity test watchdog");
            worker.setDaemon(true);
            worker.start();
        }

        void phase(String phase) { this.phase = phase; }

        long acknowledgedHeartbeats() {
            synchronized (stateLock) { return acknowledged; }
        }

        boolean heartbeatPending() {
            synchronized (stateLock) { return pending; }
        }

        boolean isAlive() { return worker.isAlive(); }

        private void acknowledge() {
            synchronized (stateLock) {
                if (closed) return;
                lastAcknowledged = SystemClock.uptimeMillis();
                acknowledged++;
                pending = false;
                stallSamples = 0;
            }
        }

        private record Sample(long heartbeatId, long number, int stallSample,
                long uptime, long waiting, long lastAcknowledged, String phase) { }

        private void run() {
            try {
                while (!closed) {
                    Sample sample = null;
                    synchronized (stateLock) {
                        if (closed) return;
                        long now = SystemClock.uptimeMillis();
                        if (!pending) {
                            pending = true;
                            sentAt = now;
                            heartbeatId++;
                            main.post(heartbeat);
                        } else if (stallSamples < 2 && now - sentAt >=
                                (stallSamples == 0 ? firstSampleMillis : secondSampleMillis)) {
                            sample = new Sample(heartbeatId, ++totalSamples, ++stallSamples,
                                    now, now - sentAt, lastAcknowledged, phase);
                        }
                    }
                    if (sample != null) emit(sample);
                    Thread.sleep(intervalMillis);
                }
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
            }
        }

        private void emit(Sample sample) {
            StringBuilder details = new StringBuilder("watchdog test=").append(name)
                    .append(" sample=").append(sample.number())
                    .append(" heartbeat=").append(sample.heartbeatId())
                    .append(" stallSample=").append(sample.stallSample())
                    .append("\nphase=").append(sample.phase())
                    .append(" pid=").append(android.os.Process.myPid())
                    .append(" uptime=").append(sample.uptime())
                    .append(" waitingMillis=").append(sample.waiting())
                    .append(" lastAcknowledgedUptime=").append(sample.lastAcknowledged()).append('\n');
            // Neither stack collection nor logging holds the heartbeat lock used by the UI thread.
            appendThreads(details, instrumentationThread);
            synchronized (outputLock) {
                synchronized (stateLock) {
                    if (closed || !pending || heartbeatId != sample.heartbeatId()) return;
                }
                output.accept(details.toString());
            }
        }

        @Override public void close() {
            synchronized (stateLock) {
                closed = true;
                main.removeCallbacks(heartbeat);
                pending = false;
            }
            worker.interrupt();
            // Finish an already-emitting sample before returning; later samples are discarded.
            synchronized (outputLock) { }
            if (Thread.currentThread() != worker) {
                try { worker.join(1_000); }
                catch (InterruptedException stopped) { Thread.currentThread().interrupt(); }
            }
        }
    }
}
