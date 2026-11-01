package org.jiangc.bc.game;

import java.util.EnumSet;
import org.jiangc.bc.input.ScreenInput;
import org.jiangc.bc.input.InputHub.Button;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.input.InputHub.Button.*;

public final class StageSelectionTest {
    private ScreenInput.Frame frame(Button held,Button pressed){
        return new ScreenInput.Frame(held==null?EnumSet.noneOf(Button.class):EnumSet.of(held),pressed==null?EnumSet.noneOf(Button.class):EnumSet.of(pressed));
    }
    @Test public void clampsToOriginalBoundsAndConsumesShortTaps(){
        StageSelection selection=new StageSelection();
        selection.step(frame(null,B));assertEquals(1,selection.stage());
        for(int i=0;i<40;i++)selection.step(frame(null,A));assertEquals(35,selection.stage());
        for(int i=0;i<40;i++)selection.step(frame(null,B));assertEquals(1,selection.stage());
    }
    @Test public void heldButtonRepeatsEveryEightTicksAndPauseDropsRepeatClock(){
        StageSelection selection=new StageSelection();selection.step(frame(A,A));assertEquals(2,selection.stage());
        for(int i=0;i<7;i++)selection.step(frame(A,null));assertEquals(2,selection.stage());
        selection.step(frame(A,null));assertEquals(3,selection.stage());
        selection.clearInput();selection.step(frame(null,null));assertEquals(3,selection.stage());
        selection.step(frame(B,B));assertEquals(2,selection.stage());
    }
    @Test public void simultaneousButtonsDoNotSelectAndClearedEdgesCannotLeak(){
        ScreenInput input=new ScreenInput();input.update(EnumSet.of(A,B),EnumSet.of(A,B));
        StageSelection selection=new StageSelection();for(int i=0;i<40;i++)selection.step(input.consume());
        assertEquals(1,selection.stage());
        input.update(EnumSet.of(A),EnumSet.of(A));input.clear();selection.step(input.consume());assertEquals(1,selection.stage());
        input.update(EnumSet.noneOf(Button.class),EnumSet.of(A));selection.step(input.consume());selection.step(input.consume());assertEquals(2,selection.stage());
    }
}
