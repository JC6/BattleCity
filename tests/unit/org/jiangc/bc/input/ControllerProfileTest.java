package org.jiangc.bc.input;

import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.input.ControllerProfile.*;
import org.jiangc.bc.input.InputHub.Button;

public class ControllerProfileTest {
    private Axis axis(int id){return new Axis(id,-1,1,.1f);}
    @Test public void identitiesAreExactAndNamesOnlyFillMissingJoyconIds(){
        assertEquals(JOYCON_LEFT,detect(0x057e,0x2006,"anything"));
        assertEquals(JOYCON_RIGHT,detect(0x057e,0x2007,"anything"));
        assertEquals(SWITCH_PRO,detect(0x057e,0x2009,"Joy-Con (L)"));
        assertEquals(STANDARD,detect(123,456,"Joy-Con (R)"));
        assertEquals(JOYCON_LEFT,detect(0,0,"Joy-Con (L)"));
        assertEquals(JOYCON_RIGHT,detect(0x057e,0,"Nintendo Switch Right Joy-Con"));
        for(String name:new String[]{null,"Pro Controller","Nintendo Switch Pro Controller","Joy-Con","Joy-Con (L) IMU","Joy-Con (R) clone"})
            assertEquals(STANDARD,detect(0,0,name));
        assertEquals(STANDARD,detect(123,456,"Pro Controller"));
    }
    @Test public void onlyJoyconHalvesRequirePairing(){
        assertTrue(JOYCON_LEFT.isJoycon());assertTrue(JOYCON_RIGHT.isJoycon());
        assertFalse(SWITCH_PRO.isJoycon());assertFalse(STANDARD.isJoycon());
        assertTrue(SWITCH_PRO.isNintendo());assertFalse(STANDARD.isNintendo());
    }
    @Test public void standardStartAndSelectCannotBecomeThumbClicks(){
        assertEquals(Button.START,JOYCON_RIGHT.button(Button.START,0x13b,108));
        assertEquals(Button.SELECT,JOYCON_LEFT.button(Button.SELECT,0x13a,109));
        assertEquals(Button.START,SWITCH_PRO.button(Button.START,0x13a,108));
        assertEquals(Button.R2,JOYCON_RIGHT.button(Button.R2,0x139,105));
        assertEquals(Button.L2,JOYCON_LEFT.button(Button.L2,0x138,104));
    }
    @Test public void standardDirectionsAndOtherSemanticKeysBeatConflictingScans(){
        assertEquals(Button.UP,JOYCON_LEFT.button(Button.UP,0x221,19));
        assertEquals(Button.A,JOYCON_LEFT.button(Button.A,0x220,BUTTON_A));
        assertEquals(Button.L1,JOYCON_RIGHT.button(Button.L1,0x131,102));
        assertEquals(Button.A,SWITCH_PRO.button(Button.A,0x131,23)); // remote center is not a face key
        assertNull(JOYCON_RIGHT.button(null,0x13b,29)); // a text key is not unknown
    }
    @Test public void nativeLeftUnknownScansKeepTheirUprightRoles(){
        int[] scans={0x220,0x221,0x222,0x223,0x13a,0x13d,0x136,0x138};
        Button[] buttons={Button.UP,Button.DOWN,Button.LEFT,Button.RIGHT,Button.SELECT,Button.L3,Button.L1,Button.L2};
        for(int i=0;i<scans.length;i++)assertEquals(buttons[i],JOYCON_LEFT.button(null,scans[i],UNKNOWN));
        assertNull(JOYCON_LEFT.button(null,0x131,UNKNOWN));
        assertNull(JOYCON_LEFT.button(null,999,UNKNOWN));
    }
    @Test public void nativeFacesAreAlreadyPrintedLettersAndAreNotSwappedTwice(){
        int[] scans={0x130,0x131,0x133,0x134};
        Button[] letters={Button.B,Button.A,Button.X,Button.Y};
        for(ControllerProfile p:new ControllerProfile[]{JOYCON_RIGHT,SWITCH_PRO})for(int i=0;i<scans.length;i++)
            assertEquals(letters[i],p.button(null,scans[i],UNKNOWN));
        assertEquals(Button.START,JOYCON_RIGHT.button(null,0x13b,UNKNOWN));
        assertEquals(Button.R3,JOYCON_RIGHT.button(null,0x13e,UNKNOWN));
        assertEquals(Button.R1,JOYCON_RIGHT.button(null,0x137,UNKNOWN));
        assertEquals(Button.R2,JOYCON_RIGHT.button(null,0x139,UNKNOWN));
    }
    @Test public void standardAndroidFacePositionsBecomePrintedLettersWithoutScans(){
        int[] codes={BUTTON_A,BUTTON_B,BUTTON_X,BUTTON_Y};
        Button[] positions={Button.A,Button.B,Button.X,Button.Y},letters={Button.B,Button.A,Button.Y,Button.X};
        for(ControllerProfile p:new ControllerProfile[]{JOYCON_RIGHT,SWITCH_PRO})for(int i=0;i<codes.length;i++)
            assertEquals(letters[i],p.button(positions[i],0,codes[i]));
    }
    @Test public void knownNativeFaceScansResolveVendorFaceLabelsOnly(){
        assertEquals(Button.A,SWITCH_PRO.button(Button.A,0x131,BUTTON_A));
        assertEquals(Button.X,JOYCON_RIGHT.button(Button.X,0x133,BUTTON_X));
        assertEquals(Button.B,SWITCH_PRO.button(Button.A,0x13b,BUTTON_A));
        assertEquals(Button.START,SWITCH_PRO.button(Button.START,0x131,108));
    }
    @Test public void numberedButtonsNeedNoCapabilityOrLayoutState(){
        Button[] directions={Button.DOWN,Button.RIGHT,Button.LEFT,Button.UP};
        Button[] letters={Button.B,Button.A,Button.Y,Button.X};
        for(int i=0;i<4;i++){
            assertEquals(directions[i],JOYCON_LEFT.button(null,0,BUTTON_1+i));
            assertEquals(letters[i],JOYCON_RIGHT.button(null,0,BUTTON_1+i));
        }
        assertEquals(Button.SELECT,JOYCON_LEFT.button(null,0,BUTTON_1+8));
        assertEquals(Button.START,JOYCON_RIGHT.button(null,0,BUTTON_1+9));
        assertEquals(Button.START,JOYCON_RIGHT.button(null,0x13a,BUTTON_1+9));
        assertNull(JOYCON_LEFT.button(null,0,BUTTON_1+4));
        assertNull(SWITCH_PRO.button(null,0,BUTTON_1+9));
    }
    @Test public void onlyNonOverlappingUnknownScanFamiliesUseNumberedFallback(){
        for(int base:new int[]{0x100,0x120}){
            assertEquals(Button.UP,JOYCON_LEFT.button(null,base+3,UNKNOWN));
            assertEquals(Button.A,JOYCON_RIGHT.button(null,base+1,UNKNOWN));
            assertEquals(Button.SELECT,JOYCON_LEFT.button(null,base+8,UNKNOWN));
            assertEquals(Button.START,JOYCON_RIGHT.button(null,base+9,UNKNOWN));
        }
        assertEquals(Button.R2,JOYCON_RIGHT.button(null,0x139,UNKNOWN));
        assertEquals(Button.START,JOYCON_RIGHT.button(null,0x13b,UNKNOWN));
        assertEquals(Button.L3,JOYCON_LEFT.button(null,0x13d,UNKNOWN));
        assertNull(JOYCON_RIGHT.button(null,0x129,29));
    }
    @Test public void homeAndCaptureAreKnownSystemFunctionsNotGameButtons(){
        for(ControllerProfile p:new ControllerProfile[]{SWITCH_PRO,JOYCON_LEFT,JOYCON_RIGHT}){
            assertTrue(p.systemButton(BUTTON_MODE,0));assertTrue(p.systemButton(BUTTON_Z,0));
            assertNull(p.button(null,0,BUTTON_MODE));assertNull(p.button(null,0,BUTTON_Z));
            assertFalse(p.systemButton(UNKNOWN,0x777));
        }
        assertTrue(JOYCON_RIGHT.systemButton(BUTTON_1+12,0));
        assertTrue(JOYCON_LEFT.systemButton(BUTTON_1+13,0));
        assertTrue(JOYCON_RIGHT.systemButton(UNKNOWN,0x13c));
        assertTrue(JOYCON_LEFT.systemButton(UNKNOWN,0x135));
        assertTrue(SWITCH_PRO.systemButton(UNKNOWN,0x13c));assertTrue(SWITCH_PRO.systemButton(UNKNOWN,0x135));
        assertTrue(JOYCON_RIGHT.systemButton(UNKNOWN,0x10c));assertTrue(JOYCON_LEFT.systemButton(UNKNOWN,0x12d));
        assertFalse(JOYCON_LEFT.systemButton(UNKNOWN,0x13d));
        assertFalse(JOYCON_RIGHT.systemButton(108,0x13c));
        assertFalse(STANDARD.systemButton(BUTTON_MODE,0x13c));
    }
    @Test public void ordinaryControllersKeepTheirAndroidMapping(){
        for(Button b:Button.values())assertEquals(b,STANDARD.button(b,0x222,BUTTON_A));
        assertNull(STANDARD.button(null,0x131,UNKNOWN));
        assertNull(STANDARD.button(null,0,BUTTON_1+9));
    }
    @Test public void validLeftAndProStickAxesAreAlwaysAvailable(){
        for(ControllerProfile p:new ControllerProfile[]{STANDARD,SWITCH_PRO,JOYCON_LEFT})
            assertEquals(new Stick(X,Y,.25f),p.stick(List.of(axis(X),axis(Y),axis(Z),axis(RZ))));
        assertEquals(Z,JOYCON_RIGHT.stick(List.of(axis(X),axis(Y),axis(Z),axis(RZ))).xAxis());
        assertEquals(X,JOYCON_RIGHT.stick(List.of(axis(X),axis(Y),axis(Z))).xAxis());
        assertEquals(RX,JOYCON_RIGHT.stick(List.of(axis(RX),axis(RY))).xAxis());
        assertNull(JOYCON_RIGHT.stick(List.of(axis(X),axis(RZ))));
        assertNull(SWITCH_PRO.stick(List.of(axis(Z),axis(RZ))));
    }
    @Test public void unsignedTriggerAndInvalidRangesCannotBecomeMovement(){
        assertNull(JOYCON_RIGHT.stick(List.of(new Axis(Z,0,1,0),new Axis(RZ,0,1,0))));
        assertNull(JOYCON_LEFT.stick(List.of(new Axis(X,Float.NaN,1,0),axis(Y))));
        assertEquals(.4f,JOYCON_LEFT.stick(List.of(new Axis(X,-1,1,.4f),axis(Y))).deadZone(),0);
        assertEquals(.25f,JOYCON_LEFT.stick(List.of(axis(X),axis(Y))).deadZone(),0);
    }
    @Test public void keyboardOnlyJoyconsDoNotPromoteOrdinaryKeyboardsOrProNames(){
        assertTrue(JOYCON_LEFT.accepts(false,KEYBOARD,"Joy-Con (L)"));
        assertTrue(JOYCON_RIGHT.accepts(false,DPAD,"Joy-Con (R)"));
        assertTrue(SWITCH_PRO.accepts(false,GAMEPAD|JOYSTICK,"Pro Controller"));
        assertFalse(SWITCH_PRO.accepts(false,KEYBOARD,"Pro Controller"));
        assertFalse(STANDARD.accepts(false,KEYBOARD,"Keyboard"));
        assertFalse(STANDARD.accepts(false,DPAD,"Remote"));
        assertFalse(JOYCON_LEFT.accepts(true,GAMEPAD|JOYSTICK,"Joy-Con (L)"));
    }
    @Test public void sensorNodesCannotBecomeExtraHalvesEvenWithMatchingProductIds(){
        assertFalse(detect(0x057e,0x2006,"Joy-Con (L) (IMU)").accepts(false,JOYSTICK,"Joy-Con (L) (IMU)"));
        assertFalse(STANDARD.accepts(false,JOYSTICK,"Joy-Con (L) (IMU)"));
        assertFalse(JOYCON_RIGHT.accepts(false,GAMEPAD|JOYSTICK,"Joy-Con (R) IMU"));
        assertFalse(JOYCON_RIGHT.accepts(false,0,"Joy-Con (R)"));
    }
}
