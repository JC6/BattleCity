package org.jiangc.bc.input;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.hardware.input.InputManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.List;
import java.util.ArrayList;
import org.jiangc.bc.input.ControllerProfile.Axis;
import org.jiangc.bc.input.ControllerProfile.Stick;
import org.jiangc.bc.input.InputHub.Button;

/** Application-owned device registry, shared across activities. No Bluetooth permissions needed. */
public final class ControllerManager implements InputManager.InputDeviceListener {
    public interface Listener {
        void onButtons(int deviceId, EnumSet<Button> pressed, boolean gamepad);
        void onControllerDisconnected(int player);
        void onInputChanged();
        default void onInputProblem(String message) { }
        default void onEffectiveInput() { }
    }
    public final InputHub hub = new InputHub();
    private final InputManager input;
    private final boolean debugInput;
    private Listener listener;
    public record Pad(int id,String descriptor,String name,int vendorId,int productId,List<Axis> axes,
                      int sources,boolean virtual) {
        public Pad {descriptor=descriptor==null?"":descriptor;name=name==null?"":name;axes=List.copyOf(axes);}
        public Pad(int id,String descriptor,String name,int vendorId,int productId,List<Axis> axes){
            this(id,descriptor,name,vendorId,productId,axes,ControllerProfile.GAMEPAD|ControllerProfile.JOYSTICK,false);
        }
        public ControllerProfile profile(){return ControllerProfile.detect(vendorId,productId,name);}
        public boolean eligible(){return profile().accepts(virtual,sources,name);}
        public Stick stick(){return profile().stick(axes);}
    }
    /** Raw metadata providers share the same eligibility and dispatch rules. */
    public interface DeviceSource {List<Pad> devices();Pad get(int id);}
    private final DeviceSource devices;
    private final Map<Integer,Pad> known=new HashMap<>();
    private final Map<Integer,Pad> catalog=new HashMap<>();
    private final Set<Integer> motionLogged=new HashSet<>();
    private final Set<String> remoteHeld = new HashSet<>();
    private final Set<String> remoteBlocked = new HashSet<>();

    public ControllerManager(Context context){this(context,null);}
    public ControllerManager(Context context,DeviceSource source) {
        input = context.getSystemService(InputManager.class);
        debugInput=(context.getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0;
        devices=source!=null?source:new DeviceSource(){
            public Pad get(int id){
                InputDevice d=input.getInputDevice(id);if(d==null)return null;
                List<Axis> axes=new ArrayList<>();
                for(InputDevice.MotionRange range:d.getMotionRanges()){
                    int flags=range.getSource();
                    if((flags&InputDevice.SOURCE_JOYSTICK)==InputDevice.SOURCE_JOYSTICK ||
                            (flags&InputDevice.SOURCE_GAMEPAD)==InputDevice.SOURCE_GAMEPAD ||
                            (flags&InputDevice.SOURCE_DPAD)==InputDevice.SOURCE_DPAD ||
                            (flags&InputDevice.SOURCE_KEYBOARD)==InputDevice.SOURCE_KEYBOARD)
                        axes.add(new Axis(range.getAxis(),range.getMin(),range.getMax(),range.getFlat()));
                }
                return new Pad(id,d.getDescriptor(),d.getName(),d.getVendorId(),d.getProductId(),axes,d.getSources(),d.isVirtual());
            }
            public List<Pad> devices(){List<Pad> result=new ArrayList<>();for(int id:input.getInputDeviceIds()){Pad p=get(id);if(p!=null)result.add(p);}return result;}
        };
        input.registerInputDeviceListener(this, new Handler(Looper.getMainLooper()));
        refresh();
    }
    public void close(){input.unregisterInputDeviceListener(this);listener=null;clear();}
    public void attach(Listener listener) { this.listener = listener; refresh(); clear(); changed(); }
    public void detach(Listener listener) { if (this.listener == listener) { clear(); this.listener = null; } }
    public void clear() {
        hub.clear();
        remoteBlocked.addAll(remoteHeld);
        remoteHeld.clear();
    }
    private Pad raw(int id){if(!catalog.containsKey(id))catalog.put(id,devices.get(id));return catalog.get(id);}
    public Pad pad(int id){Pad p=raw(id);return p!=null&&p.eligible()?p:null;}
    public Button button(KeyEvent event){
        if(systemKey(event.getKeyCode()))return null;
        Pad pad=pad(event.getDeviceId());
        InputHub.Controller controller=hub.controller(event.getDeviceId());
        if(pad!=null&&pad.profile().isJoycon()&&(controller==null||!controller.ready()))return null;
        return mappedButton(pad,event);
    }
    private Button mappedButton(Pad pad,KeyEvent event){
        Button standard=map(event.getKeyCode());
        return pad==null?standard:pad.profile().button(standard,event.getScanCode(),event.getKeyCode());
    }
    private boolean remoteCommand(Pad pad,int code){
        if(code==KeyEvent.KEYCODE_DPAD_CENTER||code==KeyEvent.KEYCODE_ENTER||code==KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)return true;
        return pad!=null&&pad.profile()==ControllerProfile.STANDARD&&hub.player(pad.id())<0&&
                (code==KeyEvent.KEYCODE_DPAD_UP||code==KeyEvent.KEYCODE_DPAD_DOWN||
                 code==KeyEvent.KEYCODE_DPAD_LEFT||code==KeyEvent.KEYCODE_DPAD_RIGHT);
    }
    private boolean joinKey(Pad pad,KeyEvent event){
        int code=event.getKeyCode();
        return code==KeyEvent.KEYCODE_BUTTON_START || (pad.profile().isNintendo()&&
                (code==KeyEvent.KEYCODE_UNKNOWN||(code>=KeyEvent.KEYCODE_BUTTON_1&&code<=KeyEvent.KEYCODE_BUTTON_16)));
    }
    public void traceRoute(int deviceId,int participant,String phase){
        if(debugInput)Log.d("ControllerInput","id="+deviceId+" joined="+hub.player(deviceId)+
                " participant="+participant+" phase="+phase);
    }
    private int register(Pad pad){
        int player=hub.player(pad.id());InputHub.Device previous=hub.device(pad.id());
        Pad old=known.put(pad.id(),pad);
        boolean changed=previous!=null&&(previous.profile!=pad.profile()||!previous.descriptor.equals(pad.descriptor())||
                (old!=null&&(!old.axes().equals(pad.axes())||old.sources()!=pad.sources())));
        if(changed)hub.reset(pad.id());
        hub.connect(pad.id(),pad.descriptor(),pad.profile());
        if(old==null||changed)tracePad(pad,changed?"reconfigured":"registered");
        return changed?player:-1;
    }
    private void refresh() {
        boolean[] before={hub.playerController(0)!=null,hub.playerController(1)!=null},lost=new boolean[2];
        Set<Integer> present = new HashSet<>();List<Pad> connected=new ArrayList<>();
        catalog.clear();
        for(Pad p:devices.devices()){
            catalog.put(p.id(),p);
            if(p.eligible()){present.add(p.id());connected.add(p);}else tracePad(p,"rejected");
        }
        for(InputHub.Device d:hub.devices())if(!present.contains(d.id)){
            int player=hub.disconnect(d.id);known.remove(d.id);motionLogged.remove(d.id);if(player>=0)lost[player]=true;
        }
        for(Pad p:connected){int player=register(p);if(player>=0)lost[player]=true;}
        if(listener!=null)for(int i=0;i<before.length;i++)if(lost[i] || (before[i]&&hub.playerController(i)==null))listener.onControllerDisconnected(i);
    }
    @Override public void onInputDeviceAdded(int id) { refresh(); changed(); }
    @Override public void onInputDeviceChanged(int id) { refresh(); changed(); }
    @Override public void onInputDeviceRemoved(int id) {
        int player = hub.disconnect(id);known.remove(id);catalog.remove(id);motionLogged.remove(id);
        if (listener != null && player >= 0) listener.onControllerDisconnected(player);
        refresh();changed();
    }
    private void changed() { if (listener != null) listener.onInputChanged(); }
    private static boolean holding(InputHub.Controller controller) {
        return controller != null && controller.ready() && !controller.held().isEmpty();
    }
    public boolean hasEffectiveHeldInput() {
        for (int player = 0; player < 2; player++) if (holding(hub.playerController(player))) return true;
        for (String source : remoteHeld) if (!remoteBlocked.contains(source)) return true;
        return false;
    }
    private void ensure(Pad pad){int player=register(pad);if(player>=0&&listener!=null)listener.onControllerDisconnected(player);}
    private static boolean systemKey(int code){
        return code==KeyEvent.KEYCODE_BACK||code==KeyEvent.KEYCODE_HOME||code==KeyEvent.KEYCODE_POWER||
                code==KeyEvent.KEYCODE_VOLUME_UP||code==KeyEvent.KEYCODE_VOLUME_DOWN||code==KeyEvent.KEYCODE_VOLUME_MUTE;
    }
    private boolean joycon(Pad pad){return pad.profile().isJoycon()||ControllerProfile.detect(0,0,pad.name()).isJoycon();}
    private void tracePad(Pad p,String reason){
        if(debugInput&&(p.eligible()||joycon(p)))Log.d("ControllerInput","id="+p.id()+" vendor="+p.vendorId()+" product="+p.productId()+
                " sources=0x"+Integer.toHexString(p.sources())+" profile="+p.profile()+" axes="+p.axes()+" reason="+reason);
    }

    public boolean key(KeyEvent event) {
        if(systemKey(event.getKeyCode()))return false;
        Pad raw=raw(event.getDeviceId()),device=raw!=null&&raw.eligible()?raw:null;
        if(raw!=null&&device==null&&joycon(raw)){tracePad(raw,"key rejected");return false;}
        if(device!=null&&device.profile().systemButton(event.getKeyCode(),event.getScanCode()))return false;
        if(device!=null)ensure(device);
        Button button = mappedButton(device,event);
        boolean gamepad = device!=null&&!remoteCommand(device,event.getKeyCode());
        if (!gamepad && button == null) return false;
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        if (event.getAction() != KeyEvent.ACTION_UP && !down) return false;
        EnumSet<Button> pressed = EnumSet.noneOf(Button.class);
        boolean effective = false;
        if (gamepad) {
            InputHub.Device d = hub.device(device.id());
            InputHub.Controller before = hub.controller(d.id);
            boolean wasHeld = button != null && before != null && before.ready() && before.held().contains(button);
            String source=event.getScanCode()>0?"scan:"+event.getScanCode():"code:"+event.getKeyCode();
            hub.key(d.id, source, button, down, event.getRepeatCount() != 0);
            if(d.takePressed().contains(Button.START)&&joinKey(device,event))hub.join(d.id);
            InputHub.Controller controller=hub.controller(d.id);
            if(controller!=null&&controller.ready())pressed=controller.takePressed();
            effective = button != null && (wasHeld || (controller != null && controller.ready()
                    && controller.held().contains(button)));
            int code=event.getKeyCode();
            boolean controllerKey=button!=null||code==KeyEvent.KEYCODE_UNKNOWN||
                    (code>=KeyEvent.KEYCODE_BUTTON_A&&code<=KeyEvent.KEYCODE_BUTTON_MODE)||
                    (code>=KeyEvent.KEYCODE_BUTTON_1&&code<=KeyEvent.KEYCODE_BUTTON_16);
            if(debugInput&&controllerKey&&event.getRepeatCount()==0)Log.d("ControllerInput","id="+d.id+
                    " source=0x"+Integer.toHexString(event.getSource())+" action="+event.getAction()+
                    " key="+event.getKeyCode()+" scan="+event.getScanCode()+" mapped="+button+
                    " ready="+(controller!=null&&controller.ready())+" player="+hub.player(d.id)+" pressed="+pressed);
            if(button==null&&down&&event.getRepeatCount()==0&&device.profile().isNintendo()&&listener!=null)
                listener.onInputProblem("收到未识别的手柄按键");
        } else {
            String source = event.getDeviceId() + ":" + event.getKeyCode();
            boolean wasHeld = remoteHeld.contains(source) && !remoteBlocked.contains(source);
            if (!down) { remoteHeld.remove(source); remoteBlocked.remove(source); }
            else if (event.getRepeatCount() == 0 && !remoteBlocked.contains(source) && remoteHeld.add(source)) pressed.add(button);
            effective = wasHeld || (remoteHeld.contains(source) && !remoteBlocked.contains(source));
        }
        if (effective && listener != null) listener.onEffectiveInput();
        if (listener != null && !pressed.isEmpty()) listener.onButtons(event.getDeviceId(), pressed, gamepad);
        changed();
        return button != null;
    }

    public boolean motion(MotionEvent event) {
        Pad device=pad(event.getDeviceId());
        if (device==null || !(event.isFromSource(InputDevice.SOURCE_JOYSTICK)
                || (device.profile().isJoycon() && (event.isFromSource(InputDevice.SOURCE_GAMEPAD)
                    || event.isFromSource(InputDevice.SOURCE_DPAD)||event.isFromSource(InputDevice.SOURCE_KEYBOARD))))
                || event.getActionMasked() != MotionEvent.ACTION_MOVE) return false;
        ensure(device);InputHub.Device d=hub.device(device.id());
        boolean wasHeld = holding(hub.controller(d.id));
        EnumSet<Button> before=debugInput?d.held():null;
        Stick stick=device.stick();
        float x=stick==null?0:event.getAxisValue(stick.xAxis()),y=stick==null?0:event.getAxisValue(stick.yAxis()),
                hatX=event.getAxisValue(MotionEvent.AXIS_HAT_X),hatY=event.getAxisValue(MotionEvent.AXIS_HAT_Y);
        hub.axes(d.id,x,y,hatX,hatY,stick==null?.25f:stick.deadZone());
        d.takePressed();InputHub.Controller controller=hub.controller(d.id);
        EnumSet<Button> pressed=controller!=null&&controller.ready()?controller.takePressed():EnumSet.noneOf(Button.class);
        if ((wasHeld || holding(controller)) && listener != null) listener.onEffectiveInput();
        if(debugInput&&(motionLogged.add(d.id)||!d.held().equals(before)))Log.d("ControllerInput","id="+d.id+
                " source=0x"+Integer.toHexString(event.getSource())+" axes=["+x+","+y+","+hatX+","+hatY+"]"+
                " ready="+(controller!=null&&controller.ready())+" player="+hub.player(d.id)+" held="+d.held());
        if (listener != null && !pressed.isEmpty()) listener.onButtons(d.id, pressed, true);
        changed();
        return true;
    }
    private static Button map(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return Button.UP;
            case KeyEvent.KEYCODE_DPAD_DOWN: return Button.DOWN;
            case KeyEvent.KEYCODE_DPAD_LEFT: return Button.LEFT;
            case KeyEvent.KEYCODE_DPAD_RIGHT: return Button.RIGHT;
            case KeyEvent.KEYCODE_DPAD_CENTER: case KeyEvent.KEYCODE_ENTER: case KeyEvent.KEYCODE_BUTTON_A: return Button.A;
            case KeyEvent.KEYCODE_BUTTON_B: return Button.B;
            case KeyEvent.KEYCODE_BUTTON_X: return Button.X;
            case KeyEvent.KEYCODE_BUTTON_Y: return Button.Y;
            case KeyEvent.KEYCODE_BUTTON_L1: return Button.L1;
            case KeyEvent.KEYCODE_BUTTON_R1: return Button.R1;
            case KeyEvent.KEYCODE_BUTTON_L2: return Button.L2;
            case KeyEvent.KEYCODE_BUTTON_R2: return Button.R2;
            case KeyEvent.KEYCODE_BUTTON_THUMBL: return Button.L3;
            case KeyEvent.KEYCODE_BUTTON_THUMBR: return Button.R3;
            case KeyEvent.KEYCODE_BUTTON_START: case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return Button.START;
            case KeyEvent.KEYCODE_BUTTON_SELECT: return Button.SELECT;
            default: return null;
        }
    }
}
