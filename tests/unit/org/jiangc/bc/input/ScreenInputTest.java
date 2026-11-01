package org.jiangc.bc.input;

import java.util.EnumSet;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.input.InputHub.Button.*;

public final class ScreenInputTest {
    @Test public void snapshotsAreIndependentAndShortPressesSurviveRelease(){
        ScreenInput input=new ScreenInput();EnumSet<InputHub.Button> held=EnumSet.of(RIGHT);
        input.held(held);held.clear();assertTrue(input.consume().down(RIGHT));held.add(RIGHT);
        EnumSet<InputHub.Button> edges=EnumSet.of(A);
        input.update(held,edges);held.clear();edges.clear();
        ScreenInput.Frame first=input.consume();assertTrue(first.hit(A));assertTrue(first.down(RIGHT));
        first.held().clear();assertTrue(input.consume().down(RIGHT));assertFalse(input.consume().hit(A));
        input.update(EnumSet.of(B),EnumSet.of(B));input.held(EnumSet.noneOf(InputHub.Button.class));assertTrue(input.consume().hit(B));
        input.update(EnumSet.of(A),EnumSet.of(A));input.clear();assertFalse(input.consume().hit(A));
        // An engine tick between onButtons and onInputChanged must not move twice.
        org.jiangc.bc.game.ConstructionState editor=new org.jiangc.bc.game.ConstructionState();
        input.update(EnumSet.of(RIGHT),EnumSet.of(RIGHT));editor.step(input.consume());
        input.held(EnumSet.of(RIGHT));editor.step(input.consume());assertEquals(1,editor.x());
    }
}
