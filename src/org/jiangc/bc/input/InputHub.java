package org.jiangc.bc.input;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Physical input sources and logical player controllers. All mutations run on the UI thread. */
public final class InputHub {
    public enum Button { UP, DOWN, LEFT, RIGHT, A, B, X, Y, L1, R1, L2, R2, L3, R3, START, SELECT }

    private static final class Buttons {
        EnumSet<Button> held=EnumSet.noneOf(Button.class),pressed=EnumSet.noneOf(Button.class);
        void set(EnumSet<Button> next){
            for(Button b:next)if(!held.contains(b))pressed.add(b);
            held=next;
        }
        void clear(){held.clear();pressed.clear();}
        static EnumSet<Button> take(EnumSet<Button> set){EnumSet<Button> copy=set.clone();set.clear();return copy;}
    }
    public static final class Device {
        public final int id;
        public final String descriptor;
        public final ControllerProfile profile;
        private final Map<String,Button> sources=new HashMap<>();
        private final Set<String> blocked=new HashSet<>();
        private final Buttons buttons=new Buttons();
        private boolean neutralRequired;
        private int stickAxis;
        private Device(int id,String descriptor,ControllerProfile profile){
            this.id=id;this.descriptor=descriptor;this.profile=profile;
        }
        public EnumSet<Button> held(){return buttons.held.clone();}
        public EnumSet<Button> takePressed(){return Buttons.take(buttons.pressed);}
        private void recompute(){
            EnumSet<Button> next=EnumSet.noneOf(Button.class);next.addAll(sources.values());
            buttons.set(next);
        }
        private void clear(){
            // Change-only HID devices may send no idle motion packets. Require
            // recentering for observed held axes, rather than eating a fresh move.
            neutralRequired|=sources.keySet().stream().anyMatch(source->!source.startsWith("key:"));
            for(String source:sources.keySet())if(source.startsWith("key:"))blocked.add(source);
            sources.clear();buttons.clear();stickAxis=0;
        }
    }
    public final class Controller {
        public final boolean paired;
        private Device first,second;
        private String firstDescriptor="",secondDescriptor="";
        private boolean ready;
        private final Buttons buttons=new Buttons();
        private Controller(Device device){
            paired=device.profile.isJoycon();
            if(!paired){first=device;firstDescriptor=device.descriptor;ready=true;}
        }
        public boolean ready(){return ready;}
        public List<Integer> deviceIds(){
            List<Integer> ids=new ArrayList<>();
            if(online(first))ids.add(first.id);if(online(second))ids.add(second.id);
            return List.copyOf(ids);
        }
        public EnumSet<Button> held(){return buttons.held.clone();}
        public EnumSet<Button> takePressed(){return Buttons.take(buttons.pressed);}
        public String status(){
            if(ready)return "完整";
            if(!paired)return "已断线";
            if(ambiguousJoycons())return "请断开多余的 Joy-Con";
            if(side(ControllerProfile.JOYCON_LEFT).size()==1&&side(ControllerProfile.JOYCON_RIGHT).size()==1)return "按右侧 ＋ 重新加入";
            boolean left=online(first),right=online(second);
            return !left&&!right?"缺左、右两侧":!left?"缺左侧":"缺右侧";
        }
        private void clear(){
            if(first!=null)first.clear();if(second!=null)second.clear();buttons.clear();
        }
        private void recompute(){
            EnumSet<Button> next=EnumSet.noneOf(Button.class);
            if(ready){next.addAll(first.buttons.held);if(second!=null)next.addAll(second.buttons.held);}
            buttons.set(next);
        }
    }
    private final Map<Integer,Device> devices=new LinkedHashMap<>();
    private final List<Controller> controllers=new ArrayList<>();
    private final Controller[] slots=new Controller[2];
    private Controller joycons;

    public Device connect(int id,String descriptor){return connect(id,descriptor,ControllerProfile.STANDARD);}
    public Device connect(int id,String descriptor,ControllerProfile profile){
        Device previous=devices.get(id);
        String identity=descriptor==null?"":descriptor;
        if(previous!=null && previous.profile==profile && previous.descriptor.equals(identity))return previous;
        Set<String> blocked=new HashSet<>();
        if(previous!=null){
            blocked.addAll(previous.blocked);
            for(String source:previous.sources.keySet())if(source.startsWith("key:"))blocked.add(source);
            disconnect(id);
        }
        Device device=new Device(id,descriptor==null?"":descriptor,profile);devices.put(id,device);
        device.blocked.addAll(blocked);device.neutralRequired=previous!=null;
        if(profile.isJoycon()){
            if(joycons!=null&&assigned(joycons)>=0)device.neutralRequired=true;
            if(joycons==null){joycons=new Controller(device);controllers.add(joycons);}
            reconcileJoycons(false);
        }else{
            Controller candidate=null;int matches=0;
            for(Controller c:controllers)if(!c.paired&&!c.ready&&assigned(c)>=0&&!device.descriptor.isEmpty()&&c.firstDescriptor.equals(device.descriptor)){candidate=c;matches++;}
            if(matches==1&&descriptorCount(device.descriptor)==1){
                candidate.first=device;candidate.ready=true;candidate.clear();
            }else controllers.add(new Controller(device));
        }
        return device;
    }
    /** Input metadata changes clear both halves without moving their player slot. */
    public void reset(int id){
        Controller c=controller(id);
        if(c!=null)c.clear();else if(devices.containsKey(id))devices.get(id).clear();
    }
    private boolean online(Device d){return d!=null&&devices.get(d.id)==d;}
    private long descriptorCount(String descriptor){return devices.values().stream().filter(d->d.descriptor.equals(descriptor)).count();}
    private List<Device> side(ControllerProfile profile){return devices.values().stream().filter(d->d.profile==profile).toList();}
    private boolean ambiguousJoycons(){return side(ControllerProfile.JOYCON_LEFT).size()>1||side(ControllerProfile.JOYCON_RIGHT).size()>1;}
    private boolean reconnects(Device next,Device previous,String descriptor){
        return next==previous || (!descriptor.isEmpty()&&descriptor.equals(next.descriptor)&&descriptorCount(descriptor)==1);
    }
    private int assigned(Controller controller){if(controller!=null)for(int i=0;i<slots.length;i++)if(slots[i]==controller)return i;return -1;}
    private void reconcileJoycons(boolean explicitJoin){
        if(joycons==null)return;
        List<Device> left=side(ControllerProfile.JOYCON_LEFT),right=side(ControllerProfile.JOYCON_RIGHT);
        boolean wasReady=joycons.ready;
        Device oldLeft=joycons.first,oldRight=joycons.second;
        boolean bound=assigned(joycons)>=0;
        if(!ambiguousJoycons()){
            if(left.size()==1&&(!bound||explicitJoin||reconnects(left.get(0),oldLeft,joycons.firstDescriptor)))joycons.first=left.get(0);
            if(right.size()==1&&(!bound||explicitJoin||reconnects(right.get(0),oldRight,joycons.secondDescriptor)))joycons.second=right.get(0);
        }
        joycons.ready=!ambiguousJoycons()&&online(joycons.first)&&online(joycons.second);
        if(!bound||explicitJoin){
            if(online(joycons.first))joycons.firstDescriptor=joycons.first.descriptor;
            if(online(joycons.second))joycons.secondDescriptor=joycons.second.descriptor;
        }
        if(wasReady!=joycons.ready || oldLeft!=joycons.first || oldRight!=joycons.second){
            if(oldLeft!=null)oldLeft.clear();if(oldRight!=null)oldRight.clear();joycons.clear();
        }
    }
    /** Notify a player only when a previously complete controller becomes unavailable. */
    public int disconnect(int id){
        Controller controller=controller(id);boolean ready=controller!=null&&controller.ready;
        devices.remove(id);
        if(controller!=null&&!controller.paired){controller.ready=false;controller.clear();}
        reconcileJoycons(false);
        return ready&&controller!=null&&!controller.ready?assigned(controller):-1;
    }
    public int join(int id){
        Device d=devices.get(id);if(d==null)return -1;
        if(d.profile.isJoycon())reconcileJoycons(true);
        Controller c=controller(id);if(c==null||!c.ready)return -1;
        int current=assigned(c);if(current>=0)return current;
        for(int i=0;i<slots.length;i++){
            // An incomplete pair reserves its player; ordinary disconnected pads
            // retain the existing explicit-rejoin behavior.
            if(slots[i]==null||(!slots[i].paired&&!slots[i].ready)){slots[i]=c;return i;}
        }
        return -1;
    }
    /** Title only: an offline reservation must not prevent a new game. */
    public void prepareMenu(){
        for(int i=0;i<slots.length;i++)if(slots[i]!=null&&!slots[i].ready)slots[i]=null;
        if(slots[0]==null){slots[0]=slots[1];slots[1]=null;}
        controllers.removeIf(c->!c.paired&&!c.ready&&assigned(c)<0);
        reconcileJoycons(false);
    }
    /** Discovery never joins players. Only confirmed slots count toward a new game. */
    public boolean hasPlayers(int count){
        int ready=0;for(Controller c:slots)if(c!=null&&c.ready)ready++;
        return ready>=count;
    }
    public Controller controller(int id){
        Device device=devices.get(id);if(device==null)return null;
        for(Controller c:controllers)if(c.first==device||c.second==device)return c;
        return null;
    }
    public int player(int id){return assigned(controller(id));}
    public Controller assignedController(int player){return slots[player];}
    public Controller playerController(int player){Controller c=slots[player];return c!=null&&c.ready?c:null;}
    public Device device(int id){return devices.get(id);}
    public List<Device> devices(){return new ArrayList<>(devices.values());}
    public String joyconProblem(){
        return joycons!=null&&!joycons.ready&&devices.values().stream().anyMatch(d->d.profile.isJoycon())?joycons.status():null;
    }
    private void update(Device device){Controller c=controller(device.id);if(c!=null)c.recompute();}

    public void key(int id,int keyCode,Button button,boolean down,boolean repeat){key(id,Integer.toString(keyCode),button,down,repeat);}
    public void key(int id,String physicalKey,Button button,boolean down,boolean repeat){
        Device d=devices.get(id);if(d==null)return;
        String source="key:"+physicalKey;
        if(!down){d.blocked.remove(source);d.sources.remove(source);}
        else if(!repeat&&!d.blocked.contains(source)&&button!=null)d.sources.put(source,button);
        d.recompute();update(d);
    }
    public void axes(int id,float x,float y,float hatX,float hatY,float deadZone){
        Device d=devices.get(id);if(d==null)return;
        // The right stick has no movement role in this game.
        if(d.profile==ControllerProfile.JOYCON_RIGHT)x=y=hatX=hatY=0;
        x=finite(x);y=finite(y);hatX=finite(hatX);hatY=finite(hatY);
        float threshold=Float.isFinite(deadZone)?Math.max(.25f,Math.min(.95f,deadZone)):.25f;
        float ax=Math.abs(x),ay=Math.abs(y);
        boolean neutral=ax<=threshold&&ay<=threshold&&Math.abs(hatX)<.5f&&Math.abs(hatY)<.5f;
        if(d.neutralRequired){if(neutral)d.neutralRequired=false;return;}
        // The NES has four directions. Normalize analog diagonals before the
        // game's digital priority, with amplitude hysteresis, never a time delay.
        if(ax<=threshold && ay<=threshold)d.stickAxis=0;
        else if(d.stickAxis==1 && ax>threshold && ay<=ax+.10f)d.stickAxis=1;
        else if(d.stickAxis==2 && ay>threshold && ax<=ay+.10f)d.stickAxis=2;
        else d.stickAxis=ax>=ay?1:2;
        axis(d,"stickX",d.stickAxis==1?x:0,threshold,Button.LEFT,Button.RIGHT);
        axis(d,"stickY",d.stickAxis==2?y:0,threshold,Button.UP,Button.DOWN);
        axis(d,"hatX",hatX,.5f,Button.LEFT,Button.RIGHT);axis(d,"hatY",hatY,.5f,Button.UP,Button.DOWN);
        d.recompute();update(d);
    }
    private static float finite(float value){return Float.isFinite(value)?value:0;}
    private void axis(Device d,String source,float value,float threshold,Button negative,Button positive){
        if(value < -threshold)d.sources.put(source,negative);
        else if(value > threshold)d.sources.put(source,positive);else d.sources.remove(source);
    }
    public void clear(){for(Device d:devices.values())d.clear();for(Controller c:controllers)c.buttons.clear();}
}
