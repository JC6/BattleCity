package org.jiangc.bc.input;

import org.junit.Before;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.input.InputHub.Button.*;

public class InputHubTest {
    @Test public void inactiveInputNodesCannotFillTheSecondPlayerSlot(){
        for(boolean pairFirst:new boolean[]{true,false}){
            InputHub h=new InputHub();h.connect(9,"passive");
            h.connect(1,"left",ControllerProfile.JOYCON_LEFT);h.connect(2,"right",ControllerProfile.JOYCON_RIGHT);
            h.connect(3,"pro",ControllerProfile.SWITCH_PRO);
            assertEquals(0,h.join(pairFirst?2:3));
            assertFalse("A connected node is not a joined player",h.hasPlayers(2));
            assertNull(h.playerController(1));assertEquals(-1,h.player(9));
            assertEquals(1,h.join(pairFirst?3:2));assertTrue(h.hasPlayers(2));
            assertEquals(-1,h.player(9));
        }
    }
    @Test public void playerQueriesNeverJoinEvenOneConnectedController(){
        InputHub h=new InputHub();h.connect(1,"connected");
        assertFalse(h.hasPlayers(1));assertEquals(-1,h.player(1));
    }
    @Test public void unknownKeysWithDifferentScansKeepIndependentLifetimes(){
        InputHub h=new InputHub();h.connect(1,"left");
        h.key(1,"scan:546",A,true,false);h.key(1,"scan:545",B,true,false);
        assertEquals(java.util.EnumSet.of(A,B),h.device(1).held());
        h.key(1,"scan:546",A,false,false);assertEquals(java.util.EnumSet.of(B),h.device(1).held());
        h.clear();h.key(1,"scan:545",B,true,true);assertTrue(h.device(1).held().isEmpty());
        h.key(1,"scan:545",B,false,false);h.key(1,"scan:545",B,true,false);assertTrue(h.device(1).takePressed().contains(B));
    }
    private InputHub hub;
    @Before public void setUp() {
        hub = new InputHub();
        hub.connect(10, "one");
        hub.connect(20, "two");
    }
    @Test public void independentPlayersAndEdges() {
        assertEquals(0, hub.join(10));
        assertEquals(1, hub.join(20));
        hub.key(10, 96, A, true, false);
        hub.key(20, 97, B, true, false);
        assertTrue(hub.playerController(0).held().contains(A));
        assertFalse(hub.playerController(0).held().contains(B));
        assertTrue(hub.playerController(1).takePressed().contains(B));
        assertTrue(hub.playerController(1).takePressed().isEmpty());
        hub.key(10, 96, A, false, false);
        assertFalse(hub.playerController(0).held().contains(A));
        assertTrue(hub.playerController(1).held().contains(B));
    }
    @Test public void repeatsNeverProduceAnotherPress() {
        InputHub.Device d = hub.device(10);
        hub.key(10, 96, A, true, false);
        d.takePressed();
        hub.key(10, 96, A, true, true);
        hub.key(10, 96, A, true, false);
        assertTrue(d.takePressed().isEmpty());
    }
    @Test public void dpadKeyAndHatHaveIndependentLifetimes() {
        hub.key(10, 21, LEFT, true, false);
        hub.axes(10, 0, 0, -1, 0, 0.25f);
        hub.key(10, 21, LEFT, false, false);
        assertTrue(hub.device(10).held().contains(LEFT));
        hub.axes(10, 0, 0, 0, 0, 0.25f);
        assertTrue(hub.device(10).held().isEmpty());
    }
    @Test public void deadZonePreventsDrift() {
        hub.axes(10, 0.2f, -0.24f, 0, 0, 0.1f);
        assertTrue(hub.device(10).held().isEmpty());
        hub.axes(10, 0.8f, 0, 0, 0, 0.25f);
        assertTrue(hub.device(10).takePressed().contains(RIGHT));
    }
    @Test public void sceneChangeRequiresKeyReleaseAndStickCenter() {
        hub.key(10, 96, A, true, false);
        hub.axes(10, 1, 0, 0, 0, 0.25f);
        hub.clear();
        hub.key(10, 96, A, true, false);
        hub.axes(10, 1, 0, 0, 0, 0.25f);
        assertTrue(hub.device(10).held().isEmpty());
        hub.key(10, 96, A, false, false);
        hub.key(10, 96, A, true, false);
        hub.axes(10, 0, 0, 0, 0, 0.25f);
        hub.axes(10, 1, 0, 0, 0, 0.25f);
        assertTrue(hub.device(10).held().contains(A));
        assertTrue(hub.device(10).held().contains(RIGHT));
    }
    @Test public void disconnectClearsAndUniqueDescriptorReclaimsSlot() {
        hub.join(10); hub.join(20);
        hub.key(10, 96, A, true, false);
        assertEquals(0, hub.disconnect(10));
        assertNull(hub.playerController(0));
        hub.connect(30, "one");
        assertEquals(0, hub.player(30));
        assertTrue(hub.playerController(0).held().isEmpty());
        assertEquals(1, hub.player(20));
    }
    @Test public void ambiguousDescriptorsRequireExplicitJoin() {
        hub = new InputHub();
        hub.connect(1, "same"); hub.connect(2, "same");
        hub.join(1); hub.join(2);
        hub.disconnect(1); hub.disconnect(2);
        hub.connect(3, "same");
        assertEquals(-1, hub.player(3));
        assertEquals(0, hub.join(3));
    }
    @Test public void noThirdPlayerAndNoUnknownDeviceJoin() {
        assertEquals(-1, hub.join(99));
        hub.join(10); hub.join(20);
        hub.connect(30, "three");
        assertEquals(-1, hub.join(30));
        assertEquals(0, hub.join(10));
    }
    @Test public void onlyExplicitJoinsFillPlayerSlots(){
        InputHub h=new InputHub();h.connect(10,"passive");h.connect(20,"active");h.connect(30,"second");
        h.join(20);assertFalse(h.hasPlayers(2));assertEquals(-1,h.player(10));assertNull(h.playerController(1));
        assertEquals(1,h.join(30));assertTrue(h.hasPlayers(2));assertEquals(-1,h.player(10));
        h.disconnect(30);assertFalse(h.hasPlayers(2));assertTrue(h.hasPlayers(1));
    }
    @Test public void menuReclaimsOfflinePairAndPromotesRemainingPlayer(){
        InputHub h=new InputHub();h.connect(1,"left",ControllerProfile.JOYCON_LEFT);h.connect(2,"right",ControllerProfile.JOYCON_RIGHT);h.join(2);
        h.connect(3,"pro");h.join(3);h.disconnect(1);h.disconnect(2);
        assertEquals(1,h.player(3));h.prepareMenu();assertEquals(0,h.player(3));assertTrue(h.hasPlayers(1));
        h.connect(4,"another");assertEquals(1,h.join(4));assertTrue(h.hasPlayers(2));
    }
    @Test public void menuKeepsTwoOnlineAssignmentsAndDiscardsOfflineStandardReservations(){
        InputHub h=new InputHub();h.connect(1,"a");h.connect(2,"b");h.join(1);h.join(2);h.prepareMenu();
        assertEquals(0,h.player(1));assertEquals(1,h.player(2));h.disconnect(1);h.prepareMenu();assertEquals(0,h.player(2));
        h.connect(3,"c");assertEquals(1,h.join(3));
    }
    @Test public void analogDiagonalsUseTheDominantAxisInsteadOfHorizontalPriority(){
        hub.axes(10,.30f,-1,0,0,.25f);assertEquals(java.util.EnumSet.of(UP),hub.device(10).held());
        hub.axes(10,-.95f,-.4f,0,0,.25f);assertEquals(java.util.EnumSet.of(LEFT),hub.device(10).held());
        hub.axes(10,0,0,0,0,.25f);assertTrue(hub.device(10).held().isEmpty());
    }
    @Test public void analogAxisHysteresisDoesNotDelayReleaseOrAFullTurn(){
        hub.axes(10,.8f,-.75f,0,0,.25f);assertEquals(java.util.EnumSet.of(RIGHT),hub.device(10).held());
        hub.axes(10,.75f,-.8f,0,0,.25f);assertEquals(java.util.EnumSet.of(RIGHT),hub.device(10).held());
        hub.axes(10,.7f,-.95f,0,0,.25f);assertEquals(java.util.EnumSet.of(UP),hub.device(10).held());
        hub.axes(10,-1,0,0,0,.25f);assertEquals(java.util.EnumSet.of(LEFT),hub.device(10).held());
        hub.axes(10,.25f,.25f,0,0,.25f);assertTrue(hub.device(10).held().isEmpty());
        hub.axes(10,.8f,.8f,0,0,.25f);assertEquals(java.util.EnumSet.of(RIGHT),hub.device(10).held());
    }
    @Test public void digitalHatDiagonalsAndKeysKeepTheirIndependentStates(){
        hub.axes(10,0,0,1,-1,.25f);assertEquals(java.util.EnumSet.of(UP,RIGHT),hub.device(10).held());
        hub.key(10,21,LEFT,true,false);hub.axes(10,0,0,0,0,.25f);
        assertEquals(java.util.EnumSet.of(LEFT),hub.device(10).held());
        hub.key(10,21,LEFT,false,false);assertTrue(hub.device(10).held().isEmpty());
    }
    @Test public void invalidAxesCannotLatchMovementOrPreventNeutralRecovery(){
        hub.axes(10,1,0,0,0,.25f);hub.clear();
        hub.axes(10,Float.NaN,Float.POSITIVE_INFINITY,0,0,.25f);
        hub.axes(10,0,-1,0,0,Float.NaN);assertEquals(java.util.EnumSet.of(UP),hub.device(10).held());
    }
}
