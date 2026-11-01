package org.jiangc.bc.input;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.EnumSet;
import org.jiangc.bc.game.PlayerInput;
import org.jiangc.bc.input.InputHub.Button;

public final class BattleInputTest {
    @Test public void edgesSurviveRenderFramesButAreConsumedOnceAndPlayersStayIsolated(){
        BattleInput input=new BattleInput();input.update(0,EnumSet.of(Button.UP),false);input.update(1,EnumSet.of(Button.LEFT),true);
        PlayerInput[] first=input.consume();assertTrue(first[0].up());assertFalse(first[0].firePressed());assertTrue(first[1].left());assertTrue(first[1].firePressed());
        PlayerInput[] next=input.consume();assertTrue(next[0].up());assertTrue(next[1].left());assertFalse(next[1].firePressed());
        input.update(0,EnumSet.of(Button.A),true);input.clear();assertEquals(PlayerInput.NONE,input.consume()[0]);assertEquals(PlayerInput.NONE,input.consume()[1]);
    }
    @Test public void newShotAndNewDirectionBelongToTheSameSnapshot(){
        BattleInput input=new BattleInput();input.update(0,EnumSet.of(Button.UP),false);
        assertFalse(input.consume()[0].firePressed());
        input.update(0,EnumSet.of(Button.RIGHT,Button.A),true);
        PlayerInput shot=input.consume()[0];assertTrue(shot.right());assertFalse(shot.up());assertTrue(shot.firePressed());
        input.update(0,EnumSet.of(Button.DOWN),false);input.update(0,EnumSet.of(Button.LEFT),false);
        assertTrue(input.consume()[0].left());assertFalse(input.consume()[0].firePressed());
    }
    @Test public void laterHeldUpdatesKeepAnUnconsumedEdgeButDoNotRepeatIt(){
        BattleInput input=new BattleInput();input.update(0,EnumSet.of(Button.RIGHT,Button.A),true);
        input.update(0,EnumSet.of(Button.RIGHT),false);
        assertTrue(input.consume()[0].firePressed());assertFalse(input.consume()[0].firePressed());
    }
}
