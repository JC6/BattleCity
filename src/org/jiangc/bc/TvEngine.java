package org.jiangc.bc;

import android.os.SystemClock;
import android.util.Log;
import javax.microedition.khronos.opengles.GL10;
import org.anddev.andengine.engine.Engine;
import org.anddev.andengine.engine.options.EngineOptions;

/** Freezes model updates while allowing the foreground pause overlay to animate. */
final class TvEngine extends Engine {
    private volatile boolean explicitlyPaused;
    private final boolean diagnostics;
    private final String identity;
    private volatile String activityState = "not recorded", lastStart = "none", lastStop = "none";
    private volatile boolean diagnosticRunning;
    private volatile long starts, updatesEntered, updatesCompleted, drawsEntered, drawsCompleted;
    private volatile long lastUpdateAt, lastDrawEntryAt, lastDrawCompletionAt;
    private volatile Thread renderThread, updateThread;
    // Only the render thread writes these markers; no engine monitor surrounds drawing.
    private long loggedDrawEntry = -1, loggedDrawCompletion = -1;

    TvEngine(EngineOptions options, String owner, boolean diagnostics) {
        super(options);
        this.diagnostics = diagnostics;
        identity = owner + " engine@" + Integer.toHexString(System.identityHashCode(this));
    }

    synchronized void setExplicitlyPaused(boolean paused) {
        explicitlyPaused = paused;
    }

    synchronized boolean isExplicitlyPaused() {
        return explicitlyPaused;
    }

    @Override public synchronized boolean isRunning() {
        return super.isRunning();
    }

    @Override public synchronized void start() {
        super.start();
        if (diagnostics) {
            diagnosticRunning = super.isRunning();
            starts++;
            lastStart = transition("start");
        }
    }

    @Override public synchronized void stop() {
        super.stop();
        if (diagnostics) {
            diagnosticRunning = super.isRunning();
            lastStop = transition("stop");
        }
    }

    @Override protected synchronized void onUpdate(long nanosecondsElapsed)
            throws InterruptedException {
        // The JAR checks its running flag outside the start/stop lock. Recheck
        // under that lock so an in-flight tick cannot update after stop returns.
        if (super.isRunning()) {
            if (diagnostics) {
                updateThread = Thread.currentThread();
                updatesEntered++;
                lastUpdateAt = SystemClock.uptimeMillis();
            }
            super.onUpdate(nanosecondsElapsed);
            if (diagnostics) updatesCompleted++;
        }
    }

    @Override public void setSurfaceSize(int width, int height) {
        super.setSurfaceSize(width, height);
        if (diagnostics) {
            renderThread = Thread.currentThread();
            Log.d("BattleCityLifecycle", identity + " surface changed " + width + "x" + height);
        }
    }

    @Override public void onDrawFrame(GL10 gl) throws InterruptedException {
        if (!diagnostics) { super.onDrawFrame(gl); return; }
        renderThread = Thread.currentThread();
        long generation = starts;
        drawsEntered++;
        lastDrawEntryAt = SystemClock.uptimeMillis();
        if (loggedDrawEntry != generation) {
            loggedDrawEntry = generation;
            Log.d("BattleCityLifecycle", identity + " first draw entered; start=" + generation);
        }
        // Engine.onDrawFrame waits for the update thread, which needs the engine monitor.
        super.onDrawFrame(gl);
        drawsCompleted++;
        lastDrawCompletionAt = SystemClock.uptimeMillis();
        if (loggedDrawCompletion != generation) {
            loggedDrawCompletion = generation;
            Log.d("BattleCityLifecycle", identity + " first draw completed; start=" + generation);
        }
    }

    void recordActivityState(String state) {
        if (!diagnostics) return;
        activityState = "uptime=" + SystemClock.uptimeMillis() + " " + state;
        Log.d("BattleCityLifecycle", identity + " " + activityState);
    }

    private String transition(String action) {
        String trace = "uptime=" + SystemClock.uptimeMillis() + " " + action
                + " on " + Thread.currentThread().getName() + "\n"
                + Log.getStackTraceString(new Throwable("Engine." + action + " caller"));
        Log.d("BattleCityLifecycle", identity + " " + trace);
        return trace;
    }

    /** Read cached diagnostics without waiting for the UI thread or the engine monitor. */
    String diagnosticSnapshot() {
        return identity + " diagnostics=" + diagnostics + "\n" + activityState
                + "\nrunning=" + diagnosticRunning + " explicitlyPaused=" + explicitlyPaused
                + " starts=" + starts
                + "\nupdates entered/completed=" + updatesEntered + "/" + updatesCompleted
                + " lastEntryUptime=" + lastUpdateAt
                + "\ndraws entered/completed=" + drawsEntered + "/" + drawsCompleted
                + " lastEntryUptime=" + lastDrawEntryAt + " lastCompletionUptime=" + lastDrawCompletionAt
                + "\nrenderThread=" + threadState(renderThread)
                + "\nupdateThread=" + threadState(updateThread)
                + "\nlast start: " + lastStart + "\nlast stop: " + lastStop + "\n";
    }

    private static String threadState(Thread thread) {
        return thread == null ? "not observed" : thread.getName() + " id=" + thread.getId()
                + " alive=" + thread.isAlive() + " state=" + thread.getState();
    }
}
