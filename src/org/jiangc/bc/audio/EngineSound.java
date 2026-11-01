package org.jiangc.bc.audio;

import org.jiangc.bc.game.GameState;

/** DB38 tests direction input while a player tank exists, including a blocked move. */
public final class EngineSound {
    private EngineSound(){}
    public static int cue(GameState state){
        if(state.demo || state.phase!=GameState.PLAYING || state.pendingOutcome>=0)return -1;
        for(GameState.Tank tank:state.tanks)if(tank.team==0 && tank.active() && tank.directionHeld)return 17;
        return 18;
    }
}
