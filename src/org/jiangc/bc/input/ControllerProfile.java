package org.jiangc.bc.input;

import java.util.List;
import java.util.Locale;
import org.jiangc.bc.input.InputHub.Button;

/** Physical layout conversion, independent of Android dispatch and player ownership. */
public enum ControllerProfile {
    STANDARD, SWITCH_PRO, JOYCON_LEFT, JOYCON_RIGHT;
    // Android source/key IDs; the conversion and discovery rules also run on the JVM.
    public static final int KEYBOARD=0x101,DPAD=0x201,GAMEPAD=0x401,JOYSTICK=0x1000010;
    public static final int UNKNOWN=0,BUTTON_A=96,BUTTON_B=97,BUTTON_X=99,BUTTON_Y=100,
            BUTTON_Z=101,BUTTON_MODE=110,BUTTON_1=188,BUTTON_16=203;
    // Android MotionEvent axis IDs. Keep the layout calculations usable on the JVM.
    public static final int X=0,Y=1,Z=11,RX=12,RY=13,RZ=14;
    public record Axis(int id,float min,float max,float flat) {
        boolean signed(){return Float.isFinite(min)&&Float.isFinite(max)&&min<0&&max>0;}
    }
    public record Stick(int xAxis,int yAxis,float deadZone) {}
    public boolean isJoycon(){return this==JOYCON_LEFT||this==JOYCON_RIGHT;}
    public boolean isNintendo(){return this!=STANDARD;}

    public boolean accepts(boolean virtual,int sources,String name){
        if(virtual)return false;
        String n=name==null?"":name.trim().toLowerCase(Locale.ROOT);
        if(n.endsWith(" (imu)") || n.endsWith(" imu") || n.endsWith(" accelerometer") || n.endsWith(" gyroscope"))return false;
        return source(sources,GAMEPAD)||source(sources,JOYSTICK)||
                (isJoycon()&&(source(sources,DPAD)||source(sources,KEYBOARD)));
    }
    private static boolean source(int sources,int expected){return (sources&expected)==expected;}
    public static ControllerProfile detect(int vendor,int product,String name){
        if(vendor==0x057e){
            if(product==0x2006)return JOYCON_LEFT;
            if(product==0x2007)return JOYCON_RIGHT;
            if(product==0x2009)return SWITCH_PRO;
        }
        if(vendor!=0 && product!=0)return STANDARD;
        String n=name==null?"":name.trim().toLowerCase(Locale.ROOT);
        return switch(n){
            case "joy-con (l)","nintendo switch joy-con (l)","nintendo switch left joy-con"->JOYCON_LEFT;
            case "joy-con (r)","nintendo switch joy-con (r)","nintendo switch right joy-con"->JOYCON_RIGHT;
            default->STANDARD;
        };
    }
    public Stick stick(List<Axis> axes){
        int[][] pairs=!isJoycon()?new int[][]{{X,Y}}:this==JOYCON_RIGHT?
                new int[][]{{Z,RZ},{X,Y},{RX,RY}}:new int[][]{{X,Y},{Z,RZ},{RX,RY}};
        for(int[] pair:pairs){
            Axis x=null,y=null;
            for(Axis a:axes)if(a.signed()){if(a.id()==pair[0])x=a;if(a.id()==pair[1])y=a;}
            if(x!=null && y!=null)return new Stick(pair[0],pair[1],Math.max(.25f,Math.min(.95f,Math.max(flat(x),flat(y)))));
        }
        return null;
    }
    private static float flat(Axis a){return Float.isFinite(a.flat())?Math.max(0,a.flat()):0;}
    /** Output letters always mean the printing on an identified Nintendo controller. */
    public Button button(Button standard,int scanCode,int keyCode){
        if(!isNintendo())return standard;
        if(systemButton(keyCode,scanCode))return null;
        int number=number(keyCode,scanCode);
        if(number!=0)return numberedButton(number);
        if(standard!=null){
            if(this!=JOYCON_LEFT && (keyCode==BUTTON_A||keyCode==BUTTON_B||keyCode==BUTTON_X||keyCode==BUTTON_Y)){
                Button face=face(scanCode);
                if(face!=null)return face;
                // Android's standard positions: south=A, east=B, west=X, north=Y.
                return switch(standard){case A->Button.B;case B->Button.A;case X->Button.Y;case Y->Button.X;default->standard;};
            }
            return standard;
        }
        return keyCode==UNKNOWN?nativeButton(scanCode):null;
    }
    private int number(int keyCode,int scanCode){
        if(!isJoycon())return 0;
        if(keyCode>=BUTTON_1&&keyCode<=BUTTON_16)return keyCode-BUTTON_1+1;
        if(keyCode==UNKNOWN)for(int base:new int[]{0x100,0x120})
            if(scanCode>=base&&scanCode<base+16)return scanCode-base+1;
        return 0;
    }
    private Button numberedButton(int number){
        // Simple HID usages, decoded per event without selecting a device-wide layout.
        return this==JOYCON_LEFT?switch(number){
            case 1->Button.DOWN;case 2->Button.RIGHT;case 3->Button.LEFT;case 4->Button.UP;
            case 9->Button.SELECT;case 11->Button.L3;case 15->Button.L1;case 16->Button.L2;default->null;
        }:switch(number){
            case 1->Button.B;case 2->Button.A;case 3->Button.Y;case 4->Button.X;
            case 10->Button.START;case 12->Button.R3;case 15->Button.R1;case 16->Button.R2;default->null;
        };
    }
    private Button face(int scanCode){
        return switch(scanCode){case 0x130->Button.B;case 0x131->Button.A;case 0x133->Button.X;case 0x134->Button.Y;default->null;};
    }
    private Button nativeButton(int scanCode){
        if(this!=JOYCON_LEFT){Button face=face(scanCode);if(face!=null)return face;}
        return switch(scanCode){
            case 0x220->this!=JOYCON_RIGHT?Button.UP:null;
            case 0x221->this!=JOYCON_RIGHT?Button.DOWN:null;
            case 0x222->this!=JOYCON_RIGHT?Button.LEFT:null;
            case 0x223->this!=JOYCON_RIGHT?Button.RIGHT:null;
            case 0x136->this!=JOYCON_RIGHT?Button.L1:null;
            case 0x138->this!=JOYCON_RIGHT?Button.L2:null;
            case 0x13a->this!=JOYCON_RIGHT?Button.SELECT:null;
            case 0x13d->this!=JOYCON_RIGHT?Button.L3:null;
            case 0x137->this!=JOYCON_LEFT?Button.R1:null;
            case 0x139->this!=JOYCON_LEFT?Button.R2:null;
            case 0x13b->this!=JOYCON_LEFT?Button.START:null;
            case 0x13e->this!=JOYCON_LEFT?Button.R3:null;
            default->null;
        };
    }
    public boolean systemButton(int keyCode,int scanCode){
        if(!isNintendo())return false;
        if(keyCode==BUTTON_MODE||keyCode==BUTTON_Z)return true;
        int number=number(keyCode,scanCode);
        if((this==JOYCON_RIGHT&&number==13)||(this==JOYCON_LEFT&&number==14))return true;
        return keyCode==UNKNOWN&&((this!=JOYCON_LEFT&&scanCode==0x13c)||(this!=JOYCON_RIGHT&&scanCode==0x135));
    }
}
