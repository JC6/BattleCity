package org.jiangc.bc.game;

import java.nio.file.*;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;
import org.jiangc.bc.input.ScreenInput.Frame;
import org.jiangc.bc.input.InputHub.Button;
import static org.jiangc.bc.input.InputHub.Button.*;

public class TitleSessionTest {
    private static Frame edge(Button...buttons){return new Frame(EnumSet.noneOf(Button.class),buttons.length==0?EnumSet.noneOf(Button.class):EnumSet.copyOf(Arrays.asList(buttons)));}
    private static Frame held(Button button){return new Frame(EnumSet.of(button),EnumSet.noneOf(Button.class));}
    private TitleSession title(GameMemory memory)throws Exception{return new TitleSession(Level.read(Files.newInputStream(org.jiangc.bc.testing.GameData.path("assets/battle/demo.txt"))),memory);}
    @Test public void scrollSkipIsConsumedThenThreeMenuItemsCycle()throws Exception{
        TitleSession t=title(new GameMemory());assertEquals(-1,t.step(edge(START),edge()));assertEquals(TitleSession.MENU,t.screen);
        t.step(edge(SELECT),edge());assertEquals(1,t.selected);t.step(edge(SELECT),edge());assertEquals(2,t.selected);t.step(edge(SELECT),edge());assertEquals(0,t.selected);
        assertEquals(0,t.step(edge(START),edge()));
    }
    @Test public void demoStartsAfter640FramesIsSilentAndCannotPolluteMemory()throws Exception{
        GameMemory m=new GameMemory();TitleSession t=title(m);t.returned();for(int i=0;i<639;i++)t.step(edge(),edge());assertEquals(TitleSession.MENU,t.screen);
        t.step(edge(),edge());assertEquals(TitleSession.DEMO,t.screen);assertTrue(t.demo.state.demo);assertEquals(30,t.demo.state.stage);assertEquals(2,t.demo.state.players.length);
        for(int i=0;i<400;i++)t.step(edge(),edge());assertEquals(20000,m.highScore());assertArrayEquals(new int[]{0,0},m.lastScores());assertNull(m.customTiles());
        assertEquals(-1,t.step(edge(START),edge()));assertEquals(TitleSession.MENU,t.screen);assertNull(t.demo);
    }
    @Test public void constructionDisablesAttractUntilGameOverClearsIt()throws Exception{
        GameMemory m=new GameMemory();m.finishConstruction();TitleSession t=title(m);t.returned();for(int i=0;i<1000;i++)t.step(edge(),edge());assertEquals(TitleSession.MENU,t.screen);
        m.clearConstruction();t.returned();for(int i=0;i<640;i++)t.step(edge(),edge());assertEquals(TitleSession.DEMO,t.screen);
    }
    @Test public void originalTwoPadSecretPlaysEntireSequenceThenSelectedMode()throws Exception{
        GameMemory m=new GameMemory();for(int i=0;i<7;i++)m.finishConstruction();TitleSession t=title(m);t.returned();
        for(int i=0;i<8;i++)t.step(held(DOWN),edge(A));for(int i=0;i<12;i++)t.step(held(RIGHT),edge(B));
        assertEquals(-1,t.step(edge(START),edge()));assertEquals(TitleSession.CREDITS,t.screen);
        for(int i=0;i<885;i++)assertEquals(-1,t.step(edge(START),edge()));assertEquals(0,t.step(edge(),edge()));assertEquals(TitleSession.MENU,t.screen);
    }
    @Test public void singlePadButtonsAndSixConstructionReturnsCannotUnlockSecret()throws Exception{
        for(int returns:new int[]{6,7}){GameMemory m=new GameMemory();for(int i=0;i<returns;i++)m.finishConstruction();TitleSession t=title(m);t.returned();
            for(int i=0;i<8;i++)t.step(new Frame(EnumSet.of(DOWN),EnumSet.of(A)),edge());
            for(int i=0;i<12;i++)t.step(new Frame(EnumSet.of(RIGHT),EnumSet.of(B)),edge());assertEquals(0,t.step(edge(START),edge()));assertEquals(TitleSession.MENU,t.screen);}
    }
    @Test public void originalClosingCurtainLastsSixteenFrames()throws Exception{
        GameMemory m=new GameMemory();TitleSession t=new TitleSession(Level.read(java.nio.file.Files.newInputStream(org.jiangc.bc.testing.GameData.path("assets/battle/demo.txt"))),m);
        t.returned();t.close(TitleSession.SINGLE);org.jiangc.bc.input.ScreenInput.Frame empty=new org.jiangc.bc.input.ScreenInput().consume();
        for(int i=0;i<15;i++)assertEquals(TitleSession.NONE,t.step(empty,empty));assertEquals(TitleSession.SINGLE,t.step(empty,empty));
    }
    @Test public void completedGameScrollsButEditorAndAbortReturnDirectly()throws Exception{
        TitleSession t=title(new GameMemory());t.completedGame();assertEquals(TitleSession.SCROLL,t.screen);
        for(int i=0;i<239;i++)t.step(edge(),edge());assertEquals(TitleSession.SCROLL,t.screen);
        t.step(edge(),edge());assertEquals(TitleSession.MENU,t.screen);t.returned();assertEquals(TitleSession.MENU,t.screen);
    }
    @Test public void creditsClearFieldWithoutResettingReturnCounter()throws Exception{
        GameMemory m=new GameMemory();ConstructionState draft=new ConstructionState();draft.paint();m.saveConstruction(draft);
        for(int i=0;i<7;i++)m.finishConstruction();TitleSession t=title(m);t.screen=TitleSession.CREDITS;t.elapsed=885;t.step(edge(),edge());
        assertEquals(7,m.constructionReturns());assertArrayEquals(new int[676],m.customTiles());assertFalse(m.construction().baseVisible());
    }
    @Test public void constructionAttractUsesTheNonzeroMenuSpawnCorrection()throws Exception{
        TitleSession t=title(new GameMemory());t.returned();t.selected=2;for(int i=0;i<640;i++)t.step(edge(),edge());
        t.demo.step(new PlayerInput[]{PlayerInput.NONE,PlayerInput.NONE});assertEquals(50,t.demo.state.spawnTimer);
    }
}
