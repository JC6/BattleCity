package org.jiangc.bc.game;

import java.util.Arrays;
import org.jiangc.bc.input.ScreenInput.Frame;
import static org.jiangc.bc.input.InputHub.Button.*;

/** Volatile 13x13 editor. Game terrain is always a separate 26x26 snapshot. */
public final class ConstructionState {
    private final int[] terrain=new int[676],paintedCodes=new int[169];
    private int x,y,code,held,holdTicks;
    private boolean baseVisible=true,acted;
    public ConstructionState(){
        Arrays.fill(paintedCodes,-1);
        for(int row=23;row<=25;row++)for(int col=11;col<=14;col++)
            if(row==23 || col==11 || col==14)terrain[row*26+col]=1;
    }
    /** C55D/C9B0 clear the field without drawing HQ or resetting the return counter. */
    public static ConstructionState emptyField(){
        ConstructionState state=new ConstructionState();Arrays.fill(state.terrain,0);state.baseVisible=false;return state;
    }
    private ConstructionState(ConstructionState other){
        System.arraycopy(other.terrain,0,terrain,0,676);
        System.arraycopy(other.paintedCodes,0,paintedCodes,0,169);
        baseVisible=other.baseVisible;
    }
    public ConstructionState copy(){return new ConstructionState(this);}
    public int[] tiles(){return terrain.clone();}
    public int x(){return x;}
    public int y(){return y;}
    public int code(){return code;}
    public boolean baseVisible(){return baseVisible;}
    public void clearInput(){held=holdTicks=0;}
    public void enter(){x=y=code=0;acted=false;clearInput();}
    public void move(int dx,int dy){acted=false;x=Math.max(0,Math.min(12,x+dx));y=Math.max(0,Math.min(12,y+dy));}
    public void press(int direction){if(acted)code=(code+direction+14)%14;acted=true;paint();}
    public void paint(){
        int block=y*13+x;if(paintedCodes[block]==code)return;
        int mask=code<10?new int[]{10,12,5,3,15}[code%5]:15;
        int tile=code<5?1:code<10?2:code==10?3:code==11?4:code==12?5:0;
        int cell=y*52+x*2;
        for(int q=0;q<4;q++)terrain[cell+(q/2)*26+q%2]=(mask&(1<<q))!=0?tile:0;
        paintedCodes[block]=code;if(x==6 && y==12)baseVisible=false;
    }
    public void step(Frame input){
        int next=(input.down(RIGHT)?1:0)|(input.down(LEFT)?2:0)|(input.down(DOWN)?4:0)|(input.down(UP)?8:0);
        // An edge also moves once when press and release both arrive between ticks.
        int movement=next&~held;
        if(input.hit(RIGHT))movement|=1;if(input.hit(LEFT))movement|=2;
        if(input.hit(DOWN))movement|=4;if(input.hit(UP))movement|=8;
        held=next;
        if(next!=0){acted=false;holdTicks++;}
        else {holdTicks=0;if(movement==0 && (input.hit(A)||input.hit(B)))press(input.hit(A)?1:-1);}
        if(holdTicks==20){holdTicks=15;movement=next;}
        if((movement&1)!=0)move(1,0);else if((movement&2)!=0)move(-1,0);
        else if((movement&4)!=0)move(0,1);else if((movement&8)!=0)move(0,-1);
        if((next!=0 || movement!=0) && (input.down(A)||input.down(B)||input.hit(A)||input.hit(B)))paint();
    }
}
