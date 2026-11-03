package org.jiangc.bc;

import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;
import static org.junit.Assert.*;

public final class ScreenAwakePolicyTest {
    private final AtomicLong now = new AtomicLong();
    private final ScreenAwakePolicy policy = new ScreenAwakePolicy(now::get, 600_000);

    @Test public void inactiveAndUnfocusedScreensReleaseEvenWithHeldInput() {
        assertFalse(policy.keepAwake(true, true));
        policy.setAllowed(true);
        assertFalse(policy.keepAwake(false, true));
        policy.setAllowed(false);
        policy.effectiveInput();
        assertFalse(policy.keepAwake(true, true));
    }

    @Test public void expiresAtTheTenMinuteBoundary() {
        policy.setAllowed(true);
        now.set(599_999);
        assertTrue(policy.keepAwake(true, false));
        assertEquals(1, policy.nextCheckDelayMillis());
        now.incrementAndGet();
        assertFalse(policy.keepAwake(true, false));
    }

    @Test public void effectiveInputExtendsAndRestoresTheDeadline() {
        policy.setAllowed(true);
        now.set(500_000);policy.effectiveInput();
        now.set(600_000);assertTrue(policy.keepAwake(true, false));
        now.set(1_100_000);assertFalse(policy.keepAwake(true, false));
        policy.effectiveInput();assertTrue(policy.keepAwake(true, false));
        assertEquals(600_000, policy.nextCheckDelayMillis());
    }

    @Test public void aHeldControlRemainsActiveUntilItIsReleased() {
        policy.setAllowed(true);
        now.set(700_000);assertTrue(policy.keepAwake(true, true));
        now.set(1_200_000);assertTrue(policy.keepAwake(true, true));
        now.set(1_799_999);assertTrue(policy.keepAwake(true, false));
        now.incrementAndGet();assertFalse(policy.keepAwake(true, false));
    }

    @Test public void lifecycleChecksDoNotRenewButExplicitRestartDoes() {
        policy.setAllowed(true);
        now.set(590_000);assertFalse(policy.keepAwake(false, false));
        now.set(600_000);assertFalse(policy.keepAwake(true, false));
        policy.setAllowed(true);assertFalse(policy.keepAwake(true, false));
        policy.setAllowed(false);policy.setAllowed(true);
        assertTrue(policy.keepAwake(true, false));
    }
}
