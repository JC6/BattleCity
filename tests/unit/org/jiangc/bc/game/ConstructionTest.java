package org.jiangc.bc.game;

import java.nio.file.*;
import java.util.*;
import org.jiangc.bc.input.ScreenInput;
import org.jiangc.bc.input.InputHub.Button;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.input.InputHub.Button.*;

public final class ConstructionTest {
    private ScreenInput.Frame frame(EnumSet<Button> held,Button... pressed){
        return new ScreenInput.Frame(held,pressed.length==0?EnumSet.noneOf(Button.class):EnumSet.copyOf(Arrays.asList(pressed)));
    }
    @Test public void allFourteenCodesMatchIndependentQuadrantSpecification() throws Exception {
        // Four 8px quadrants in each editor block, independently specified by DACB.
        int[] masks={10,12,5,3,15,10,12,5,3,15,15,15,15,15};
        int[] materials={1,1,1,1,1,2,2,2,2,2,3,4,5,0};
        ConstructionState state=new ConstructionState();
        for(int code=0;code<14;code++){
            state.press(1);assertEquals(code,state.code());int[] tiles=state.tiles();
            for(int q=0;q<4;q++)assertEquals((masks[code]&(1<<q))==0?0:materials[code],tiles[q/2*26+q%2]);
        }
        state.press(1);assertEquals(0,state.code());state.press(-1);assertEquals(13,state.code());
    }
    @Test public void movingResetsFirstPressEvenAtBoundaryAndDraftsAreIndependent(){
        ConstructionState state=new ConstructionState();state.press(1);state.press(1);assertEquals(1,state.code());
        state.move(-1,0);state.press(-1);assertEquals(1,state.code());assertEquals(0,state.x());
        state.press(-1);assertEquals(0,state.code());state.move(1,0);state.press(1);assertEquals(0,state.code());
        int[] original=state.tiles();int[] copy=state.tiles();copy[3]=5;assertArrayEquals(original,state.tiles());
        ConstructionState draft=state.copy();state.press(1);assertArrayEquals(original,draft.tiles());
        draft.enter();assertEquals(0,draft.x());assertEquals(0,draft.code());assertArrayEquals(original,draft.tiles());
    }
    @Test public void cursorRepeatsAtTwentyThenEveryFiveTicksAndPaintsWithoutCycling(){
        ConstructionState state=new ConstructionState();EnumSet<Button> held=EnumSet.of(RIGHT,A);
        state.step(frame(held,RIGHT,A));assertEquals(1,state.x());
        for(int i=1;i<19;i++)state.step(frame(held));assertEquals(1,state.x());
        state.step(frame(held));assertEquals(2,state.x());
        for(int i=0;i<5;i++)state.step(frame(held));assertEquals(3,state.x());assertEquals(0,state.code());
        for(int x=1;x<=3;x++){assertEquals(1,state.tiles()[x*2+1]);assertEquals(0,state.tiles()[x*2]);}
        state.clearInput();state.step(frame(EnumSet.noneOf(Button.class)));assertEquals(3,state.x());
        state.step(frame(EnumSet.noneOf(Button.class),RIGHT,A));assertEquals(4,state.x());assertEquals(1,state.tiles()[9]);
    }
    @Test public void directionChangeRetainsRepeatTimerAndGridEdgesClamp(){
        ConstructionState state=new ConstructionState();
        for(int i=0;i<18;i++)state.step(frame(EnumSet.of(RIGHT)));
        state.step(frame(EnumSet.of(DOWN)));assertEquals(1,state.y());
        state.step(frame(EnumSet.of(DOWN)));assertEquals(2,state.y());
        for(int i=0;i<200;i++)state.step(frame(EnumSet.of(DOWN)));assertEquals(12,state.y());
        for(int i=0;i<200;i++)state.step(frame(EnumSet.of(RIGHT)));assertEquals(12,state.x());
        state.step(frame(EnumSet.of(LEFT,UP)));assertEquals(11,state.x());assertEquals(12,state.y());
    }
    @Test public void overwritingBaseHidesItEvenWithEmptyBlockAndReentryKeepsDraft(){
        ConstructionState state=new ConstructionState();assertTrue(state.baseVisible());
        for(int i=0;i<6;i++)state.move(1,0);for(int i=0;i<12;i++)state.move(0,1);
        for(int i=0;i<14;i++)state.press(1);assertEquals(13,state.code());assertFalse(state.baseVisible());
        int[] tiles=state.tiles();state.enter();assertFalse(state.baseVisible());assertArrayEquals(tiles,state.tiles());
        assertTrue(new ConstructionState().baseVisible());
    }
}
