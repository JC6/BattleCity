package org.jiangc.bc.input;

import java.util.EnumSet;
import org.jiangc.bc.game.ConstructionState;
import org.jiangc.bc.game.StageSelection;
import org.jiangc.bc.input.InputHub.Button;
import org.jiangc.bc.input.ScreenInput.Frame;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.input.ControllerProfile.*;

/** Wire events for the same printed A/B pair must produce the same game actions. */
public class NintendoControlsTest {
    private record Faces(ControllerProfile profile,Button aPosition,int aCode,int aScan,
                         Button bPosition,int bCode,int bScan) {
        Button a(){return profile.button(aPosition,aScan,aCode);}
        Button b(){return profile.button(bPosition,bScan,bCode);}
    }
    private final Faces[] controllers={
        new Faces(SWITCH_PRO,Button.B,97,0x131,Button.A,96,0x130),
        new Faces(JOYCON_RIGHT,null,0,0x131,null,0,0x130),
        new Faces(JOYCON_RIGHT,null,189,0,null,188,0)
    };
    private Frame press(Button button){return new Frame(EnumSet.noneOf(Button.class),EnumSet.of(button));}
    @Test public void printedAIncreasesAndPrintedBDecreasesTheStageForEveryWireFormat(){
        for(Faces controller:controllers){
            StageSelection selection=new StageSelection();
            selection.step(press(controller.a()));assertEquals(2,selection.stage());
            selection.step(press(controller.b()));assertEquals(1,selection.stage());
        }
    }
    @Test public void printedABKeepEditorCycleDirectionsForEveryWireFormat(){
        for(Faces controller:controllers){
            ConstructionState editor=new ConstructionState();
            editor.step(press(controller.a()));assertEquals(0,editor.code());assertEquals(1,editor.tiles()[1]);
            editor.step(press(controller.a()));assertEquals(1,editor.code());
            editor.step(press(controller.b()));assertEquals(0,editor.code());
        }
    }
}
