package org.jiangc.bc;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import javax.microedition.khronos.egl.EGL10;
import javax.microedition.khronos.egl.EGLContext;
import javax.microedition.khronos.opengles.GL10;
import org.anddev.andengine.opengl.util.GLHelper;
import org.anddev.andengine.opengl.view.RenderSurfaceView;
import org.json.JSONObject;
import static org.junit.Assert.*;

/** A process-wide experiment selected only by the instrumentation APK. */
final class TestRenderMode {
    private static volatile String requested = "default";
    private static Application application;
    private static final Application.ActivityLifecycleCallbacks callbacks = new Application.ActivityLifecycleCallbacks() {
        @Override public void onActivityPostCreated(Activity activity, Bundle state) {
            if (activity instanceof TvGameActivity game && requested.equals("disabled")) {
                game.getEngine().getEngineOptions().getRenderOptions().disableExtensionVertexBufferObjects();
            }
        }
        @Override public void onActivityCreated(Activity activity, Bundle state) { }
        @Override public void onActivityStarted(Activity activity) { }
        @Override public void onActivityResumed(Activity activity) { }
        @Override public void onActivityPaused(Activity activity) { }
        @Override public void onActivityStopped(Activity activity) { }
        @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) { }
        @Override public void onActivityDestroyed(Activity activity) { }
    };

    private TestRenderMode() { }

    static void begin() {
        end();
        String mode = InstrumentationRegistry.getArguments().getString("battlecityVboMode", "default");
        if (!mode.equals("default") && !mode.equals("disabled")) {
            throw new IllegalArgumentException("battlecityVboMode must be default or disabled");
        }
        requested = mode;
        application = ApplicationProvider.getApplicationContext();
        // Application synchronizes callback registration; no synchronous UI call is needed.
        application.registerActivityLifecycleCallbacks(callbacks);
    }

    static void end() {
        if (application != null) application.unregisterActivityLifecycleCallbacks(callbacks);
        application = null;
        requested = "default";
    }

    private record State(boolean activeVbo, boolean optionsDisabled, String renderer, String version) { }

    /** Call only after PixelCopy has observed a rendered frame for this surface. */
    static void assertEffective(TvGameActivity activity) throws Exception {
        var surface = new AtomicReference<RenderSurfaceView>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                surface.set(findSurface(activity.findViewById(android.R.id.content))));
        assertNotNull("A rendered surface must exist", surface.get());
        var query = new FutureTask<>(() -> {
            EGL10 egl = (EGL10) EGLContext.getEGL();
            GL10 gl = (GL10) egl.eglGetCurrentContext().getGL();
            return new State(GLHelper.EXTENSIONS_VERTEXBUFFEROBJECTS,
                    activity.getEngine().getEngineOptions().getRenderOptions().isDisableExtensionVertexBufferObjects(),
                    gl.glGetString(GL10.GL_RENDERER), gl.glGetString(GL10.GL_VERSION));
        });
        surface.get().queueEvent(query);
        State state;
        try { state = query.get(10_000, TimeUnit.MILLISECONDS); }
        catch (TimeoutException failure) {
            query.cancel(false);
            throw DeviceTestDiagnostics.timeout("GL render-mode query timed out", 10_000, failure);
        }
        String mode = requested;
        String evidence = new JSONObject().put("requested", mode).put("activeVbo", state.activeVbo())
                .put("optionsDisabled", state.optionsDisabled()).put("renderer", state.renderer())
                .put("version", state.version()).toString();
        Log.i("BattleCityRenderMode", "BATTLECITY_RENDER_MODE " + evidence);
        assertNotNull("GL renderer must be available", state.renderer());
        assertNotNull("GL version must be available", state.version());
        assertFalse(state.renderer().isBlank());assertFalse(state.version().isBlank());
        assertEquals("Engine options must match the requested test mode", mode.equals("disabled"), state.optionsDisabled());
        assertEquals("The CI baseline must use VBO; the disabled experiment must bypass it",
                mode.equals("default"), state.activeVbo());
    }

    private static RenderSurfaceView findSurface(View view) {
        if (view instanceof RenderSurfaceView surface) return surface;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) {
            RenderSurfaceView found = findSurface(group.getChildAt(i));
            if (found != null) return found;
        }
        return null;
    }
}
