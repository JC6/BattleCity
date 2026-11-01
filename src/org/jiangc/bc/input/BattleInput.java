package org.jiangc.bc.input;

import java.util.EnumSet;
import org.jiangc.bc.game.PlayerInput;
import org.jiangc.bc.input.InputHub.Button;

/** UI writes held directions/edges, engine consumes edges exactly once per tick. */
public final class BattleInput {
    private final PlayerInput[] held={PlayerInput.NONE,PlayerInput.NONE};
    private final boolean[] fire=new boolean[2];
    /** One controller snapshot: a new firing edge never exposes stale directions. */
    public synchronized void update(int player,EnumSet<Button> buttons,boolean firePressed){
        held[player]=new PlayerInput(buttons.contains(Button.UP),buttons.contains(Button.RIGHT),buttons.contains(Button.DOWN),buttons.contains(Button.LEFT),false);
        fire[player]|=firePressed;
    }
    public synchronized PlayerInput[] consume(){PlayerInput[] result=new PlayerInput[2];for(int i=0;i<2;i++){PlayerInput p=held[i];result[i]=new PlayerInput(p.up(),p.right(),p.down(),p.left(),fire[i]);fire[i]=false;}return result;}
    public synchronized void clear(){held[0]=held[1]=PlayerInput.NONE;fire[0]=fire[1]=false;}
}
