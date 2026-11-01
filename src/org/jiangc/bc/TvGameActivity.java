package org.jiangc.bc;

import android.graphics.Color;
import android.app.AlertDialog;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.view.View;
import android.view.View.MeasureSpec;
import android.widget.TextView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import org.anddev.andengine.engine.Engine;
import org.anddev.andengine.engine.camera.Camera;
import org.anddev.andengine.engine.options.EngineOptions;
import org.anddev.andengine.engine.options.EngineOptions.ScreenOrientation;
import org.anddev.andengine.engine.options.WakeLockOptions;
import org.anddev.andengine.opengl.view.RenderSurfaceView;
import org.anddev.andengine.ui.activity.BaseGameActivity;
import org.jiangc.bc.input.ControllerManager;
import org.jiangc.bc.input.InputHub.Button;
import java.util.EnumSet;

/** Aspect-preserving surface with a five-percent safe area and transient overlay notices. */
public abstract class TvGameActivity extends BaseGameActivity implements ControllerManager.Listener {
    private static final int CAMERA_WIDTH = 256, CAMERA_HEIGHT = 240;
    protected Camera camera;
    protected TextView hint;
    protected volatile boolean foreground;
    private boolean dialogConfirmDown,dialogBackDown;
    private final OnBackInvokedCallback backCallback = this::onBackRequested;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
    }

    @Override protected void onDestroy() {
        getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        hideNotice();
        super.onDestroy();
    }

    protected void onBackRequested() { finish(); }

    protected ControllerManager controllers() {
        return ((BattleCityApplication) getApplication()).controllers();
    }
    protected boolean isNintendoController(int id){
        ControllerManager.Pad pad=controllers().pad(id);
        return pad!=null && pad.profile().isNintendo();
    }
    protected void installDialogInput(AlertDialog dialog){
        resetDialogInput();
        dialog.setOnKeyListener((d,code,event)->{
            Button button=controllers().button(event);controllers().key(event);
            boolean down=event.getAction()==KeyEvent.ACTION_DOWN;
            if(button==Button.B){if(down&&event.getRepeatCount()==0)dialogBackDown=true;
                if(event.getAction()==KeyEvent.ACTION_UP&&dialogBackDown){dialogBackDown=false;dialog.dismiss();}return true;}
            if(button==Button.A){if(down&&event.getRepeatCount()==0)dialogConfirmDown=true;
                if(event.getAction()==KeyEvent.ACTION_UP){boolean confirm=dialogConfirmDown;dialogConfirmDown=false;if(confirm)activateDialogFocus(dialog);}return true;}
            return isNintendoController(event.getDeviceId())&&button!=null;
        });
        dialog.getWindow().getDecorView().setOnGenericMotionListener((view,event)->
                isNintendoController(event.getDeviceId()) && controllers().motion(event));
    }
    protected void resetDialogInput(){dialogConfirmDown=dialogBackDown=false;}
    protected void dialogDirection(AlertDialog dialog,int id,EnumSet<Button> pressed){
        if(!foreground || !isNintendoController(id))return;
        View focus=dialog.getCurrentFocus();if(focus==null)return;
        for(Button button:pressed){
            int code=switch(button){case UP->KeyEvent.KEYCODE_DPAD_UP;case DOWN->KeyEvent.KEYCODE_DPAD_DOWN;case LEFT->KeyEvent.KEYCODE_DPAD_LEFT;case RIGHT->KeyEvent.KEYCODE_DPAD_RIGHT;default->0;};
            if(code==0)continue;
            // Send to the focused Android view, bypassing the raw-key listener.
            // Buttons use normal focus search.
            boolean handled=focus.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN,code));
            focus.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP,code));
            if(!handled){
                int direction=switch(button){case UP->View.FOCUS_UP;case DOWN->View.FOCUS_DOWN;case LEFT->View.FOCUS_LEFT;default->View.FOCUS_RIGHT;};
                View next=focus.focusSearch(direction);if(next!=null)next.requestFocus(direction);
            }
            break;
        }
    }
    protected static void activateDialogFocus(AlertDialog dialog){
        View focus=dialog.getCurrentFocus();
        if(focus!=null)focus.performClick();
    }
    @Override public Engine onLoadEngine() {
        camera = new Camera(0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);
        EngineOptions options = new EngineOptions(true, ScreenOrientation.LANDSCAPE,
                (surface,w,h)->{
                    int scale=Math.max(1,Math.min(MeasureSpec.getSize(w)/CAMERA_WIDTH,MeasureSpec.getSize(h)/CAMERA_HEIGHT));
                    surface.setMeasuredDimensionProxy(CAMERA_WIDTH*scale,CAMERA_HEIGHT*scale);
                }, camera);
        options.setWakeLockOptions(WakeLockOptions.SCREEN_ON);
        return new TvEngine(options);
    }
    @Override protected void onSetContentView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        FrameLayout viewport = new FrameLayout(this);
        root.addView(viewport, new FrameLayout.LayoutParams(-1, -1));
        mRenderSurfaceView = new RenderSurfaceView(this);
        mRenderSurfaceView.setEGLConfigChooser(false);
        mRenderSurfaceView.setRenderer(mEngine);
        viewport.addView(mRenderSurfaceView, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        hint = new TextView(this);
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(18);
        hint.setGravity(Gravity.CENTER);
        hint.setBackgroundColor(0xCC000000);
        hint.setVisibility(View.GONE);
        root.addView(hint, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        setContentView(root);
        GameWindow.install(getWindow(), root);
    }
    private final Runnable clearNotice=()->{if(hint!=null){hint.setText("");hint.setVisibility(View.GONE);}};
    protected void notice(String message){
        if(hint==null)return;
        if(hint.getVisibility()==View.VISIBLE && message.contentEquals(hint.getText()))return;
        hint.removeCallbacks(clearNotice);hint.setText(message);hint.setVisibility(View.VISIBLE);hint.postDelayed(clearNotice,5000);
    }
    protected void hideNotice(){if(hint!=null){hint.removeCallbacks(clearNotice);clearNotice.run();}}
    @Override protected void onResume() {
        foreground = true;
        controllers().attach(this);
        super.onResume();
    }
    @Override protected void onPause() {
        foreground = false;
        controllers().detach(this);
        super.onPause();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    @Override public void onWindowFocusChanged(boolean hasFocus) {
        controllers().clear();
        resetDialogInput();
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else GameWindow.hideSystemBars(getWindow());
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        return controllers().key(event) || super.dispatchKeyEvent(event);
    }
    @Override public boolean dispatchGenericMotionEvent(MotionEvent event) {
        return controllers().motion(event) || super.dispatchGenericMotionEvent(event);
    }
    @Override public void onButtons(int deviceId, EnumSet<Button> pressed, boolean gamepad) {
        if (pressed.contains(Button.B)) onBackRequested();
    }
    @Override public void onControllerDisconnected(int player) { }
    @Override public void onInputProblem(String message) { if(foreground)notice(message); }
    @Override public void onInputChanged() { }
    @Override public void onLoadComplete() { }
}
