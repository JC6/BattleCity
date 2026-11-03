package org.jiangc.bc;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Expected stalls are bounded and collected in memory, not emitted as ANR reports. */
@RunWith(AndroidJUnit4.class)
public class DeviceTestDiagnosticsTest {
    @Test public void watchdogSamplesBlockedUiRecoversAndStopsWithoutResidualCallbacks() throws Exception {
        var samples = new LinkedBlockingQueue<String>();
        var sampler = new AtomicReference<Thread>();
        Thread testThread = Thread.currentThread();
        var watchdog = new DeviceTestDiagnostics.Watchdog("watchdog self-test", testThread,
                25, 200, 400, output -> {
                    sampler.set(Thread.currentThread());
                    samples.add(output);
                });
        try {
            awaitAcknowledged(watchdog, 5);
            assertTrue("Healthy heartbeats must not emit samples", samples.isEmpty());
            watchdog.phase("expected first stall");
            long before;
            try (MainBlock block = new MainBlock()) {
                block.awaitEntered();
                String first = samples.poll(1, TimeUnit.SECONDS);
                String second = samples.poll(1, TimeUnit.SECONDS);
                assertNotNull("An independent thread must sample a blocked UI", first);
                assertNotNull("A persistent stall must receive a second sample", second);
                assertTrue(first, first.contains("test=watchdog self-test sample=1"));
                assertTrue(first, first.contains("stallSample=1"));
                assertTrue(second, second.contains("sample=2") && second.contains("stallSample=2"));
                assertTrue(first, first.contains("phase=expected first stall"));
                assertTrue(first, first.contains("\"main\" state="));
                assertTrue(first, first.contains("CountDownLatch.await"));
                assertTrue(first, first.contains('"' + testThread.getName() + "\" state="));
                assertNotSame(testThread, sampler.get());
                assertNotSame(Looper.getMainLooper().getThread(), sampler.get());
                assertNull("One blocked heartbeat must produce at most two samples",
                        samples.poll(300, TimeUnit.MILLISECONDS));
                before = watchdog.acknowledgedHeartbeats();
            }
            awaitAcknowledged(watchdog, before + 2);
            assertTrue("Recovery must not emit an old pending sample", samples.isEmpty());
            watchdog.phase("expected second stall");
            try (MainBlock block = new MainBlock()) {
                block.awaitEntered();
                String recovered = samples.poll(1, TimeUnit.SECONDS);
                assertNotNull("A later stall must rearm sampling", recovered);
                assertTrue(recovered, recovered.contains("sample=3") && recovered.contains("stallSample=1"));
                assertTrue(recovered, recovered.contains("phase=expected second stall"));
                assertTrue("The UI heartbeat must still be outstanding", watchdog.heartbeatPending());
                watchdog.close();
                int remaining = samples.size();
                assertFalse("Watchdog thread must stop", watchdog.isAlive());
                assertFalse("Stop must remove its pending heartbeat", watchdog.heartbeatPending());
                SystemClock.sleep(450);
                assertEquals("Stop must suppress later sampling", remaining, samples.size());
            }
            long stoppedAt = watchdog.acknowledgedHeartbeats();
            SystemClock.sleep(100);
            assertEquals("A stale callback must not acknowledge after stop", stoppedAt,
                    watchdog.acknowledgedHeartbeats());
        } finally {
            watchdog.close();
        }
    }

    private static void awaitAcknowledged(DeviceTestDiagnostics.Watchdog watchdog, long target) {
        long deadline = SystemClock.uptimeMillis() + 5_000;
        while (watchdog.acknowledgedHeartbeats() < target) {
            assertTrue("Main thread must acknowledge the watchdog heartbeat",
                    SystemClock.uptimeMillis() < deadline);
            SystemClock.sleep(10);
        }
    }

    private static final class MainBlock implements AutoCloseable {
        private final Handler main = new Handler(Looper.getMainLooper());
        private final CountDownLatch entered = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final CountDownLatch exited = new CountDownLatch(1);
        private final AtomicBoolean hardTimeout = new AtomicBoolean();
        private final Runnable block = () -> {
            entered.countDown();
            try {
                if (!release.await(2_500, TimeUnit.MILLISECONDS)) hardTimeout.set(true);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                hardTimeout.set(true);
            } finally {
                exited.countDown();
            }
        };

        MainBlock() { main.post(block); }

        void awaitEntered() throws InterruptedException {
            assertTrue("Controlled main-thread block must start", entered.await(1, TimeUnit.SECONDS));
        }

        @Override public void close() throws InterruptedException {
            release.countDown();
            main.removeCallbacks(block);
            if (entered.getCount() == 0) {
                assertTrue("The main thread must leave the controlled block", exited.await(1, TimeUnit.SECONDS));
            }
            assertFalse("Controlled blocks must be released before their hard limit", hardTimeout.get());
        }
    }
}
