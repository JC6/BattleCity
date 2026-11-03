package org.jiangc.bc;

import java.util.function.LongSupplier;

/** Monotonic inactivity deadline; the activity owns window and lifecycle effects. */
final class ScreenAwakePolicy {
    private final LongSupplier clock;
    private final long timeoutMillis;
    private long lastInputAt;
    private boolean allowed;

    ScreenAwakePolicy(LongSupplier clock, long timeoutMillis) {
        if (timeoutMillis <= 0) throw new IllegalArgumentException("Positive idle timeout required");
        this.clock = clock;
        this.timeoutMillis = timeoutMillis;
        lastInputAt = clock.getAsLong();
    }

    void setAllowed(boolean allowed) {
        if (allowed && !this.allowed) effectiveInput();
        this.allowed = allowed;
    }

    void effectiveInput() { lastInputAt = clock.getAsLong(); }

    boolean keepAwake(boolean interactive, boolean heldInput) {
        if (!allowed || !interactive) return false;
        if (heldInput) effectiveInput();
        return clock.getAsLong() - lastInputAt < timeoutMillis;
    }

    long nextCheckDelayMillis() {
        return Math.max(1, timeoutMillis - (clock.getAsLong() - lastInputAt));
    }
}
