package org.jiangc.bc;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jiangc.bc.input.ControllerManager;
import org.jiangc.bc.input.ControllerProfile.Axis;
import org.jiangc.bc.input.InputHub.Button;
import static org.junit.Assert.*;

/** Synthetic discovery only; all events use actual Activity dispatch and Android key codes. */
final class TestControllers implements ControllerManager.DeviceSource,AutoCloseable {
    private final Map<Integer,ControllerManager.Pad> pads=new LinkedHashMap<>();
    private final BattleCityApplication app;
    private final ControllerManager original;
    private final Field field;
    TestControllers(BattleCityApplication app){
        this.app=app;original=app.controllers();
        try{field=BattleCityApplication.class.getDeclaredField("controllers");field.setAccessible(true);field.set(app,new ControllerManager(app,this));}
        catch(ReflectiveOperationException e){throw new AssertionError(e);}
    }
    void connect(int id,String descriptor){
        connect(id,descriptor,0,0,List.of(new Axis(0,-1,1,.25f),new Axis(1,-1,1,.25f),new Axis(15,-1,1,0),new Axis(16,-1,1,0)));
    }
    void connect(int id,String descriptor,int vendor,int product,List<Axis> axes){
        for(ControllerManager.Pad old:devices())if(old.id()!=id && old.descriptor().equals(descriptor))disconnect(old.id());
        pads.put(id,new ControllerManager.Pad(id,descriptor,"Synthetic controller",vendor,product,axes));app.controllers().onInputDeviceAdded(id);
    }
    void joycon(int id,String descriptor,boolean left){
        connect(id,descriptor,0x057e,left?0x2006:0x2007,List.of(new Axis(left?0:11,-1,1,.25f),new Axis(left?1:14,-1,1,.25f),new Axis(15,-1,1,0),new Axis(16,-1,1,0)));
    }
    void pro(int id,String descriptor){
        connect(id,descriptor,0x057e,0x2009,List.of(new Axis(0,-1,1,.25f),new Axis(1,-1,1,.25f),
                new Axis(11,-1,1,.25f),new Axis(14,-1,1,.25f),new Axis(15,-1,1,0),new Axis(16,-1,1,0)));
    }
    void numberedJoycon(int id,String descriptor,boolean left){
        pads.put(id,new ControllerManager.Pad(id,descriptor,left?"Joy-Con (L)":"Joy-Con (R)",0x057e,left?0x2006:0x2007,
                List.of(new Axis(0,-1,1,0),new Axis(1,-1,1,0),new Axis(15,-1,1,0),new Axis(16,-1,1,0)),
                InputDevice.SOURCE_KEYBOARD,false));
        app.controllers().onInputDeviceChanged(id);
    }
    void passive(int id,String descriptor){
        pads.put(id,new ControllerManager.Pad(id,descriptor,"Synthetic input node",0,0,List.of(),
                InputDevice.SOURCE_GAMEPAD|InputDevice.SOURCE_DPAD|InputDevice.SOURCE_KEYBOARD,false));
        app.controllers().onInputDeviceAdded(id);
    }
    void sensor(int id,String descriptor){
        pads.put(id,new ControllerManager.Pad(id,descriptor,"Joy-Con (L) (IMU)",0x057e,0x2006,
                List.of(new Axis(12,-1,1,0),new Axis(13,-1,1,0)),InputDevice.SOURCE_JOYSTICK,false));
        app.controllers().onInputDeviceAdded(id);
    }
    void replaceAll(int first,String firstDescriptor,int second,String secondDescriptor){
        var axes=List.of(new Axis(0,-1,1,.25f),new Axis(1,-1,1,.25f));
        pads.clear();pads.put(first,new ControllerManager.Pad(first,firstDescriptor,"First",0,0,axes));
        pads.put(second,new ControllerManager.Pad(second,secondDescriptor,"Second",0,0,axes));app.controllers().onInputDeviceAdded(first);
    }
    void disconnect(int id){pads.remove(id);app.controllers().onInputDeviceRemoved(id);}
    public List<ControllerManager.Pad> devices(){return new ArrayList<>(pads.values());}
    public ControllerManager.Pad get(int id){return pads.get(id);}
    @Override public void close(){app.controllers().close();try{field.set(app,original);}catch(IllegalAccessException e){throw new AssertionError(e);}}
    static int key(Button b){return switch(b){
        case UP->KeyEvent.KEYCODE_DPAD_UP;case DOWN->KeyEvent.KEYCODE_DPAD_DOWN;case LEFT->KeyEvent.KEYCODE_DPAD_LEFT;case RIGHT->KeyEvent.KEYCODE_DPAD_RIGHT;
        case A->KeyEvent.KEYCODE_BUTTON_A;case B->KeyEvent.KEYCODE_BUTTON_B;case X->KeyEvent.KEYCODE_BUTTON_X;case Y->KeyEvent.KEYCODE_BUTTON_Y;
        case START->KeyEvent.KEYCODE_BUTTON_START;case SELECT->KeyEvent.KEYCODE_BUTTON_SELECT;
        default->throw new IllegalArgumentException("Unused fixture key "+b);};}
    static void key(TvGameActivity a,int id,Button b,boolean down){
        var pad=a.controllers().pad(id);
        if(pad!=null&&pad.profile().isNintendo())nintendoKey(a,id,b,down);
        else rawKey(a,id,key(b),0,down);
    }
    /** Printed Nintendo letters -> Android's wire codes, independent of the production mapper. */
    static void nintendoKey(android.view.Window.Callback a,int id,Button printed,boolean down){
        int code=switch(printed){case A->KeyEvent.KEYCODE_BUTTON_B;case B->KeyEvent.KEYCODE_BUTTON_A;
            case X->KeyEvent.KEYCODE_BUTTON_Y;case Y->KeyEvent.KEYCODE_BUTTON_X;default->key(printed);};
        int scan=switch(printed){case A->0x131;case B->0x130;case X->0x133;case Y->0x134;
            case START->0x13b;case SELECT->0x13a;case UP->0x220;case DOWN->0x221;case LEFT->0x222;case RIGHT->0x223;
            default->throw new IllegalArgumentException("Unused printed button "+printed);};
        rawKey(a,id,code,scan,down);
    }
    static void nintendoPress(android.view.Window.Callback a,int id,Button printed){
        nintendoKey(a,id,printed,true);nintendoKey(a,id,printed,false);
    }
    static void rawKey(android.view.Window.Callback a,int id,int code,int scan,boolean down){
        rawKey(a,id,code,scan,down,InputDevice.SOURCE_GAMEPAD);
    }
    static void rawKey(android.view.Window.Callback a,int id,int code,int scan,boolean down,int source){
        long now=SystemClock.uptimeMillis();assertTrue(a.dispatchKeyEvent(new KeyEvent(now,now,down?KeyEvent.ACTION_DOWN:KeyEvent.ACTION_UP,code,0,0,id,scan,0,source)));
    }
    static void numberedKey(android.view.Window.Callback a,int id,int number,boolean down){
        rawKey(a,id,KeyEvent.KEYCODE_BUTTON_1+number-1,0,down,InputDevice.SOURCE_KEYBOARD);
    }
    static void numberedPress(android.view.Window.Callback a,int id,int number){numberedKey(a,id,number,true);numberedKey(a,id,number,false);}
    static void scan(android.view.Window.Callback a,int id,int scan){rawKey(a,id,KeyEvent.KEYCODE_UNKNOWN,scan,true);rawKey(a,id,KeyEvent.KEYCODE_UNKNOWN,scan,false);}
    static void press(TvGameActivity a,int id,Button b){key(a,id,b,true);key(a,id,b,false);}
    static void axes(TvGameActivity a,int id,float x,float y,float hatX,float hatY){
        rawAxes(a,id,new int[]{MotionEvent.AXIS_X,MotionEvent.AXIS_Y,MotionEvent.AXIS_HAT_X,MotionEvent.AXIS_HAT_Y},new float[]{x,y,hatX,hatY});
    }
    static void rawAxes(android.view.Window.Callback a,int id,int[] axes,float[] values){
        MotionEvent.PointerProperties p=new MotionEvent.PointerProperties();p.id=0;p.toolType=MotionEvent.TOOL_TYPE_UNKNOWN;
        MotionEvent.PointerCoords c=new MotionEvent.PointerCoords();for(int i=0;i<axes.length;i++)c.setAxisValue(axes[i],values[i]);
        long now=SystemClock.uptimeMillis();MotionEvent e=MotionEvent.obtain(now,now,MotionEvent.ACTION_MOVE,1,new MotionEvent.PointerProperties[]{p},new MotionEvent.PointerCoords[]{c},0,0,1,1,id,0,InputDevice.SOURCE_JOYSTICK,0);
        try{assertTrue(a.dispatchGenericMotionEvent(e));}finally{e.recycle();}
    }
}
