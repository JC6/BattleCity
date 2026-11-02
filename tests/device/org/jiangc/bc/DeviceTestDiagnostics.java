package org.jiangc.bc;

import android.os.SystemClock;
import android.util.Log;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Map;

/** Capture live threads before a failed wait unwinds and closes its ActivityScenario. */
final class DeviceTestDiagnostics {
    private static volatile TvEngine observedEngine;

    private DeviceTestDiagnostics() { }

    static void begin() {
        end();
        String requested = InstrumentationRegistry.getArguments()
                .getString("battlecityEngineDiagnostics", "false");
        if (!requested.equals("true") && !requested.equals("false")) {
            throw new IllegalArgumentException("battlecityEngineDiagnostics must be true or false");
        }
        TvEngine.requestDiagnosticsForTests(Boolean.parseBoolean(requested));
    }

    static void end() {
        observedEngine = null;
        TvEngine.requestDiagnosticsForTests(false);
    }

    /** Called on the UI thread while a test is already inspecting its target activity. */
    static void observe(TvGameActivity activity) {
        if (activity.getEngine() instanceof TvEngine engine) observedEngine = engine;
    }

    static AssertionError timeout(String message, long timeoutMillis, Throwable cause) {
        StringBuilder details = new StringBuilder(message)
                .append(" (timeout ").append(timeoutMillis).append(" ms)")
                .append("\nPID ").append(android.os.Process.myPid())
                .append(", uptime ").append(SystemClock.uptimeMillis()).append(" ms\n");
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
                    && thread != Thread.currentThread()) continue;
            details.append('"').append(name).append("\" state=").append(thread.getState()).append('\n');
            for (StackTraceElement frame : entry.getValue()) details.append("    at ").append(frame).append('\n');
        }
        String output = details.toString();
        // Logcat limits individual messages; the assertion also retains the complete dump in JUnit XML.
        for (String line : output.split("\n")) Log.e("BattleCityTest", line);
        return new AssertionError(output, cause);
    }
}
