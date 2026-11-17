package org.jiangc.bc;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.anddev.andengine.engine.handler.IUpdateHandler;
import org.jiangc.bc.game.BattleSession;
import org.json.JSONException;
import org.json.JSONObject;

/** Test-APK-only observations. Snapshot readers never call the UI or acquire the engine lock. */
final class TestPresentationProgress implements AutoCloseable {
    static final String MARKER = "BATTLECITY_PRESENTATION_PROGRESS ";
    record EngineSample(long uptimeMillis, long frames, String screen, int elapsed,
                        boolean explicitlyPaused, boolean running, long lastAdvanceUptimeMillis,
                        double frameSeconds) { }
    record UiSample(long uptimeMillis, boolean foreground, boolean focused,
                    boolean finishing, boolean destroyed) { }

    private final String test, activity;
    private final Supplier<UiSample> uiSampler;
    private final Consumer<String> output;
    private final long intervalMillis, logIntervalMillis;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object callbacksLock = new Object(), outputLock = new Object();
    private final Runnable sampleUi = this::sampleUi;
    private final Thread worker;
    private volatile EngineSample engine;
    private volatile UiSample ui;
    private volatile boolean closed;
    private Runnable detach = () -> { };

    static TestPresentationProgress attach(String test, Level1Activity activity) {
        var monitor = new TestPresentationProgress(test,
                activity.getClass().getSimpleName() + "@" + Integer.toHexString(System.identityHashCode(activity)),
                () -> new UiSample(SystemClock.uptimeMillis(), activity.foreground,
                        activity.hasWindowFocus(), activity.isFinishing(), activity.isDestroyed()),
                line -> Log.i("BattleCityProgress", line), 250, 1_000);
        var engine = (TvEngine) activity.getEngine();
        var scene = engine.getScene();
        var observer = new IUpdateHandler() {
            private long frames, advancedAt = SystemClock.uptimeMillis();
            private BattleSession previous;
            private int previousScreen = -1, previousElapsed = -1;
            @Override public void reset() { }
            @Override public void onUpdate(float seconds) {
                if (monitor.closed) return;
                BattleSession session = activity.session();
                if (session == null) return;
                long now = SystemClock.uptimeMillis();
                if (session != previous || session.screen != previousScreen || session.elapsed != previousElapsed) {
                    advancedAt = now;
                }
                previous = session;previousScreen = session.screen;previousElapsed = session.elapsed;
                monitor.record(new EngineSample(now, ++frames, screenName(session.screen), session.elapsed,
                        engine.isExplicitlyPaused(), engine.isRunning(), advancedAt, seconds));
            }
        };
        // attach() is called from an existing bounded test task on the engine thread.
        scene.registerUpdateHandler(observer);
        monitor.detach = () -> engine.runOnUpdateThread(() -> scene.unregisterUpdateHandler(observer));
        return monitor;
    }

    TestPresentationProgress(String test, String activity, Supplier<UiSample> uiSampler,
                             Consumer<String> output, long intervalMillis, long logIntervalMillis) {
        if (intervalMillis <= 0 || logIntervalMillis < intervalMillis) {
            throw new IllegalArgumentException("Positive sampling and logging intervals required");
        }
        this.test = test;this.activity = activity;this.uiSampler = uiSampler;this.output = output;
        this.intervalMillis = intervalMillis;this.logIntervalMillis = logIntervalMillis;
        main.post(sampleUi);
        worker = new Thread(this::run, "BattleCity test presentation");
        worker.setDaemon(true);
        worker.start();
    }

    void record(EngineSample sample) { if (!closed) engine = sample; }

    private void sampleUi() {
        synchronized (callbacksLock) {
            if (closed) return;
            ui = uiSampler.get();
            main.postDelayed(sampleUi, intervalMillis);
        }
    }

    String snapshot() {
        return snapshot("sample");
    }

    String snapshot(String event) {
        long now = SystemClock.uptimeMillis();
        EngineSample e = engine;UiSample u = ui;
        try {
            var record = new JSONObject().put("test", test).put("activity", activity)
                    .put("uptimeMillis", now).put("phase", DeviceTestDiagnostics.currentPhase()).put("event", event);
            record.put("engine", e == null ? JSONObject.NULL : new JSONObject()
                    .put("sampleUptimeMillis", e.uptimeMillis()).put("ageMillis", Math.max(0, now - e.uptimeMillis()))
                    .put("frames", e.frames()).put("screen", e.screen()).put("elapsed", e.elapsed())
                    .put("explicitlyPaused", e.explicitlyPaused()).put("running", e.running())
                    .put("lastAdvanceUptimeMillis", e.lastAdvanceUptimeMillis())
                    .put("frameSeconds", Double.isFinite(e.frameSeconds()) ? e.frameSeconds() : JSONObject.NULL));
            record.put("ui", u == null ? JSONObject.NULL : new JSONObject()
                    .put("sampleUptimeMillis", u.uptimeMillis()).put("ageMillis", Math.max(0, now - u.uptimeMillis()))
                    .put("foreground", u.foreground()).put("focused", u.focused())
                    .put("finishing", u.finishing()).put("destroyed", u.destroyed()));
            return MARKER + record;
        } catch (JSONException failure) { throw new IllegalStateException("Cannot encode test progress", failure); }
    }

    private void run() {
        long loggedAt = SystemClock.uptimeMillis();
        try {
            while (!closed) {
                Thread.sleep(intervalMillis);
                long now = SystemClock.uptimeMillis();
                if (now - loggedAt < logIntervalMillis) continue;
                synchronized (outputLock) {
                    if (closed) return;
                    output.accept(snapshot());
                    loggedAt = now;
                }
            }
        } catch (InterruptedException stopped) { Thread.currentThread().interrupt(); }
    }

    boolean isAlive() { return worker.isAlive(); }
    boolean uiSamplePending() { return main.hasCallbacks(sampleUi); }

    @Override public void close() {
        synchronized (callbacksLock) {
            if (closed) return;
            closed = true;
            main.removeCallbacks(sampleUi);
        }
        worker.interrupt();
        synchronized (outputLock) { }
        detach.run(); // Queued cleanup also works when the engine is presently paused.
        if (Thread.currentThread() != worker) {
            try { worker.join(1_000); }
            catch (InterruptedException stopped) { Thread.currentThread().interrupt(); }
        }
    }

    private static String screenName(int screen) {
        return switch (screen) {
            case BattleSession.BATTLE -> "BATTLE";
            case BattleSession.SCORE -> "SCORE";
            case BattleSession.GAME_OVER -> "GAME_OVER";
            case BattleSession.HISCORE -> "HISCORE";
            case BattleSession.DONE -> "DONE";
            default -> "UNKNOWN-" + screen;
        };
    }
}
