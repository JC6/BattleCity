package org.jiangc.bc.game;

import org.jiangc.bc.input.ScreenInput.Frame;
import static org.jiangc.bc.input.InputHub.Button.*;

/** C7AB, C9C0 and C49C. Logical frames continue only while the title has focus. */
public final class TitleSession {
    public static final int SCROLL=0,MENU=1,DEMO=2,CREDITS=3,CLOSING=4;
    public static final int NONE=-1,SINGLE=0,COOP=1,CONSTRUCTION=2;
    public volatile int screen=SCROLL,selected,elapsed;
    public Game demo;
    private final Level demoLevel;
    private final GameMemory memory;
    private int secret,closingAction;
    public void close(int action){closingAction=action;screen=CLOSING;elapsed=0;}
    public TitleSession(Level demoLevel,GameMemory memory){this.demoLevel=demoLevel;this.memory=memory;}
    public void returned(){screen=MENU;elapsed=secret=0;demo=null;}
    public void completedGame(){returned();screen=SCROLL;}
    public int input(Frame p1,Frame p2){
        boolean start=p1.hit(START),select=p1.hit(SELECT);
        if(screen==SCROLL || screen==DEMO){if(start || select)returned();return NONE;}
        if(screen==CREDITS || screen==CLOSING)return NONE;
        if(select || p1.hit(Y)){selected=(selected+(p1.hit(Y)?2:1))%3;elapsed=0;}
        if(p1.down(DOWN) && p2.hit(A))secret=(secret+16)&255;
        if(p1.down(RIGHT) && p2.hit(B))secret=(secret-1)&255;
        if(start){
            if(memory.constructionReturns()==7 && secret==0x74){screen=CREDITS;elapsed=0;return NONE;}
            return selected;
        }
        return NONE;
    }
    public int step(Frame p1,Frame p2){
        int before=screen,action=input(p1,p2);if(action!=NONE || screen!=before)return action;
        elapsed++;
        if(screen==CLOSING){if(elapsed>=16)return closingAction;}
        else if(screen==SCROLL){if(elapsed>=240)returned();}
        else if(screen==CREDITS){if(elapsed>=886){int result=selected;memory.resetConstructionField();returned();return result;}}
        else if(screen==DEMO){demo.step(demoInputs());if(demo.state.pendingOutcome>=0)returned();}
        else if(elapsed>=640 && memory.constructionReturns()==0){
            demo=demoLevel.start(true,30,0x1985,null);demo.state.demo=true;demo.state.demoMode=selected;demo.state.phase=GameState.PLAYING;demo.state.tick=0;
            screen=DEMO;elapsed=0;
        }
        return NONE;
    }
    private PlayerInput[] demoInputs(){
        PlayerInput[] inputs={PlayerInput.NONE,PlayerInput.NONE};
        for(int p=0;p<2;p++){
            GameState.Tank tank=demo.playerTank(p);if(tank==null || !tank.active())continue;
            int x=tank.x,y=tank.y;boolean target=false;
            if(demo.state.powerUp!=null){x=demo.state.powerUp.x();y=demo.state.powerUp.y();target=true;}
            else for(int slot:new int[]{p,p+2,p+1}){
                for(GameState.Tank enemy:demo.state.tanks)if(enemy.team==1 && enemy.enemySlot==slot && enemy.active()){x=enemy.x;y=enemy.y;target=true;break;}
                if(target)break;
            }
            if(!target)continue;
            int index=(Integer.signum(y-tank.y)+1)*3+Integer.signum(x-tank.x)+1;
            int[][] directions={{0,0,0,3,0,1,2,2,2},{3,0,1,3,0,1,3,2,1}};
            int axis=(((p<<1)^(demo.state.battleTicks/64))&2)==0?0:1,d=directions[axis][index];
            inputs[p]=new PlayerInput(d==0,d==1,d==2,d==3,tank.y<176);
        }
        return inputs;
    }
}
