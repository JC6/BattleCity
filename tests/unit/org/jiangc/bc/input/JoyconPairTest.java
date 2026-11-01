package org.jiangc.bc.input;

import java.util.EnumSet;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.input.InputHub.Button.*;
import static org.jiangc.bc.input.ControllerProfile.*;

public class JoyconPairTest {
    private final InputHub hub=new InputHub();
    private void left(int id,String descriptor){hub.connect(id,descriptor,JOYCON_LEFT);}
    private void right(int id,String descriptor){hub.connect(id,descriptor,JOYCON_RIGHT);}
    private InputHub.Controller pair(){left(1,"left");right(2,"right");assertEquals(0,hub.join(2));return hub.playerController(0);}
    private void center(int id){hub.axes(id,0,0,0,0,.25f);}
    @Test public void oneHalfCannotJoinOrCountAsAPlayer(){
        left(1,"left");assertEquals(-1,hub.join(1));assertFalse(hub.hasPlayers(1));assertNull(hub.playerController(0));assertTrue(hub.joyconProblem().contains("缺右"));
        right(2,"right");assertFalse(hub.hasPlayers(2));assertFalse(hub.hasPlayers(1));
        assertEquals(0,hub.join(2));assertTrue(hub.hasPlayers(1));
        assertEquals(0,hub.player(1));assertEquals(0,hub.player(2));assertEquals(List.of(1,2),hub.playerController(0).deviceIds());assertNull(hub.playerController(1));
    }
    @Test public void rightCanConnectBeforeLeft(){
        right(2,"right");assertTrue(hub.joyconProblem().contains("缺左"));assertEquals(-1,hub.join(2));
        left(1,"left");assertEquals(0,hub.join(2));assertEquals(0,hub.player(1));assertEquals(List.of(1,2),hub.playerController(0).deviceIds());
    }
    @Test public void movingAndFiringFromDifferentHalvesMergeAndReleaseIndependently(){
        InputHub.Controller c=pair();center(1);hub.axes(1,1,0,0,0,.25f);hub.key(2,"fire",A,true,false);
        assertEquals(EnumSet.of(RIGHT,A),c.held());
        hub.axes(2,-1,1,-1,1,.25f);assertEquals(EnumSet.of(RIGHT,A),c.held());
        hub.key(2,"fire",A,false,false);assertEquals(EnumSet.of(RIGHT),c.held());
        center(1);assertTrue(c.held().isEmpty());
    }
    @Test public void sharedLogicalButtonProducesOnePressAndOneFinalRelease(){
        InputHub.Controller c=pair();hub.key(1,"one",L1,true,false);assertEquals(EnumSet.of(L1),c.takePressed());
        hub.key(2,"two",L1,true,false);assertTrue(c.takePressed().isEmpty());
        hub.key(1,"one",L1,false,false);assertEquals(EnumSet.of(L1),c.held());assertTrue(c.takePressed().isEmpty());
        hub.key(2,"two",L1,false,false);assertTrue(c.held().isEmpty());assertTrue(c.takePressed().isEmpty());
    }
    @Test public void losingEitherHalfClearsTheEntirePairAndNotifiesOnce(){
        InputHub.Controller c=pair();center(1);hub.axes(1,1,0,0,0,.25f);hub.key(2,"fire",A,true,false);
        assertEquals(0,hub.disconnect(1));assertNull(hub.playerController(0));assertSame(c,hub.assignedController(0));assertTrue(c.held().isEmpty());assertTrue(hub.device(2).held().isEmpty());
        assertTrue(c.status().contains("缺左"));assertEquals(-1,hub.disconnect(2));assertTrue(c.status().contains("缺左、右"));
    }
    @Test public void rightDisconnectAlsoDropsReadiness(){
        InputHub.Controller c=pair();assertEquals(0,hub.disconnect(2));assertFalse(c.ready());assertTrue(c.status().contains("缺右"));
    }
    @Test public void uniqueDescriptorsReconnectToTheSamePlayerWithNewDeviceIds(){
        InputHub.Controller c=pair();hub.disconnect(1);left(3,"left");assertSame(c,hub.playerController(0));assertEquals(List.of(3,2),c.deviceIds());assertEquals(0,hub.player(3));
        assertTrue(c.held().isEmpty());assertTrue(c.takePressed().isEmpty());
        hub.axes(3,1,0,0,0,.25f);assertTrue(c.held().isEmpty());center(3);hub.axes(3,1,0,0,0,.25f);assertEquals(EnumSet.of(RIGHT),c.held());
    }
    @Test public void changedDescriptorNeedsExplicitRejoinAndFreshStart(){
        InputHub.Controller c=pair();hub.disconnect(1);left(3,"replacement");assertNull(hub.playerController(0));assertTrue(c.status().contains("重新加入"));
        hub.key(2,"plus",START,true,false);assertEquals(0,hub.join(2));assertSame(c,hub.playerController(0));assertTrue(c.takePressed().isEmpty());
        hub.key(2,"plus",START,false,false);hub.key(2,"plus",START,true,false);assertEquals(EnumSet.of(START),c.takePressed());
    }
    @Test public void incompletePairReservesItsPlayerWhileProCanUseTheOtherSlot(){
        InputHub.Controller c=pair();hub.disconnect(1);hub.connect(3,"pro",SWITCH_PRO);assertEquals(1,hub.join(3));
        assertSame(c,hub.assignedController(0));assertFalse(hub.hasPlayers(2));assertTrue(hub.hasPlayers(1));assertEquals(1,hub.player(3));
    }
    @Test public void proAndPairCountAsTwoControllersAndNeverThree(){
        hub.connect(3,"pro",SWITCH_PRO);assertEquals(0,hub.join(3));left(1,"left");right(2,"right");assertEquals(1,hub.join(2));
        assertEquals(1,hub.player(1));assertEquals(1,hub.player(2));assertTrue(hub.hasPlayers(2));
        hub.connect(4,"other");assertEquals(-1,hub.join(4));
    }
    @Test public void extraSameSideBlocksGuessingAndClearsActiveInput(){
        InputHub.Controller c=pair();hub.key(2,"fire",A,true,false);left(3,"extra");
        assertFalse(c.ready());assertTrue(c.held().isEmpty());assertEquals(-1,hub.join(3));assertTrue(hub.joyconProblem().contains("多余"));
        assertEquals(-1,hub.disconnect(3));assertSame(c,hub.playerController(0));assertEquals(List.of(1,2),c.deviceIds());assertTrue(c.held().isEmpty());
    }
    @Test public void inputsHeldBeforePairFormationAreNotReplayed(){
        right(2,"right");hub.key(2,"plus",START,true,false);assertEquals(-1,hub.join(2));left(1,"left");
        assertEquals(0,hub.join(2));InputHub.Controller c=hub.playerController(0);assertTrue(c.takePressed().isEmpty());assertTrue(c.held().isEmpty());
        hub.key(2,"plus",START,true,true);assertTrue(c.held().isEmpty());hub.key(2,"plus",START,false,false);hub.key(2,"plus",START,true,false);assertEquals(EnumSet.of(START),c.takePressed());
    }
    @Test public void dpadAndStickKeepTheNormalVerticalLayout(){
        InputHub.Controller c=pair();center(1);hub.axes(1,1,0,0,0,.25f);assertEquals(EnumSet.of(RIGHT),c.held());
        hub.key(1,"right",RIGHT,true,false);center(1);assertEquals(EnumSet.of(RIGHT),c.held());hub.key(1,"right",RIGHT,false,false);assertTrue(c.held().isEmpty());
        hub.axes(1,0,-1,0,0,.25f);assertEquals(EnumSet.of(UP),c.held());
    }
    @Test public void sceneBoundaryBlocksBothHalvesUntilReleaseAndRecentering(){
        InputHub.Controller c=pair();center(1);hub.axes(1,1,0,0,0,.25f);hub.key(2,"fire",A,true,false);hub.clear();
        hub.axes(1,1,0,0,0,.25f);hub.key(2,"fire",A,true,true);assertTrue(c.held().isEmpty());
        center(1);hub.key(2,"fire",A,false,false);hub.axes(1,1,0,0,0,.25f);hub.key(2,"fire",A,true,false);assertEquals(EnumSet.of(RIGHT,A),c.held());
    }
    @Test public void identicalDescriptorsDoNotSilentlyRestoreAMissingHalf(){
        left(1,"same");right(2,"same");hub.join(2);hub.disconnect(1);left(3,"same");assertNull(hub.playerController(0));
        assertEquals(0,hub.join(2));assertEquals(List.of(3,2),hub.playerController(0).deviceIds());
    }
    @Test public void lateIdentityMetadataReplacesTheStandardDeviceInsteadOfKeepingAStaleProfile(){
        hub.connect(1,"left");hub.join(1);hub.key(1,"held",A,true,false);
        left(1,"left");right(2,"right");hub.prepareMenu();
        assertEquals(JOYCON_LEFT,hub.device(1).profile);assertFalse(hub.hasPlayers(1));assertEquals(0,hub.join(2));assertTrue(hub.hasPlayers(1));assertFalse(hub.hasPlayers(2));
        assertEquals(List.of(1,2),hub.playerController(0).deviceIds());
        hub.key(1,"held",A,true,false);assertTrue(hub.playerController(0).held().isEmpty());
        hub.key(1,"held",A,false,false);hub.key(1,"held",LEFT,true,false);
        assertEquals(EnumSet.of(LEFT),hub.playerController(0).held());
    }
    @Test public void resetKeepsOwnershipButRequiresFreshKeysAndCenteredAxes(){
        InputHub.Controller c=pair();center(1);hub.axes(1,1,0,0,0,.25f);hub.key(2,"fire",A,true,false);
        hub.reset(2);assertSame(c,hub.playerController(0));assertTrue(c.held().isEmpty());
        hub.axes(1,1,0,0,0,.25f);hub.key(2,"fire",A,true,false);assertTrue(c.held().isEmpty());
        center(1);hub.key(2,"fire",A,false,false);hub.key(2,"fire",B,true,false);
        assertEquals(EnumSet.of(B),c.held());
    }
    @Test public void stableDeviceIdWithAChangedDescriptorDoesNotKeepTheOldIdentity(){
        InputHub.Controller c=pair();right(2,"replacement");
        assertEquals("replacement",hub.device(2).descriptor);assertNull(hub.playerController(0));assertSame(c,hub.assignedController(0));
        assertEquals(0,hub.join(2));assertSame(c,hub.playerController(0));assertTrue(c.held().isEmpty());
    }
    @Test public void idleChangeOnlyHidNeedsNoDummyCenterPacketBeforeItsFirstFreshMove(){
        InputHub.Controller c=pair();hub.clear();
        hub.axes(1,1,0,0,0,.25f);
        assertEquals(EnumSet.of(RIGHT),c.held());
        hub.clear();hub.axes(1,1,0,0,0,.25f);assertTrue(c.held().isEmpty());
        center(1);hub.axes(1,1,0,0,0,.25f);assertEquals(EnumSet.of(RIGHT),c.held());
    }
    @Test public void proIsAnIndependentControllerEvenWithAnIncompleteJoyconPair(){
        left(1,"left");hub.connect(3,"pro",SWITCH_PRO);
        assertEquals(0,hub.join(3));assertFalse(hub.playerController(0).paired);
        assertEquals(List.of(3),hub.playerController(0).deviceIds());assertTrue(hub.joyconProblem().contains("缺右"));
        right(2,"right");assertEquals(1,hub.join(2));assertTrue(hub.playerController(1).paired);
        assertTrue(hub.hasPlayers(2));assertNull(hub.joyconProblem());
    }
    @Test public void twoProControllersNeverNeedJoyconPairing(){
        hub.connect(1,"one",SWITCH_PRO);hub.connect(2,"two",SWITCH_PRO);
        assertEquals(0,hub.join(1));assertEquals(1,hub.join(2));assertNull(hub.joyconProblem());
        assertFalse(hub.playerController(0).paired);assertFalse(hub.playerController(1).paired);
        hub.axes(1,1,0,0,0,.25f);assertEquals(EnumSet.of(RIGHT),hub.playerController(0).held());
    }

}
