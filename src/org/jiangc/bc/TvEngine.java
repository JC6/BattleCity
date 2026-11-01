package org.jiangc.bc;

import org.anddev.andengine.engine.Engine;
import org.anddev.andengine.engine.options.EngineOptions;

/** Freezes model updates while allowing the foreground pause overlay to animate. */
final class TvEngine extends Engine {
    private boolean explicitlyPaused;

    TvEngine(EngineOptions options) {
        super(options);
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

    @Override protected synchronized void onUpdate(long nanosecondsElapsed)
            throws InterruptedException {
        // The JAR checks its running flag outside the start/stop lock. Recheck
        // under that lock so an in-flight tick cannot update after stop returns.
        if (super.isRunning()) super.onUpdate(nanosecondsElapsed);
    }
}
