package org.jiangc.bc.presentation;

import java.util.*;
import org.jiangc.bc.game.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Coordinates independently read from CEF7/CE52/D17F/D951 and PPU/OAM conversion. */
public final class LayoutTest {
    private record Draw(String key,int x,int y,int width,int height) { }
    private static final class Canvas implements GameRenderer.Canvas {
        final List<Draw> draws=new ArrayList<>();
        private final Map<String,GameRenderer.Frame> frames=new HashMap<>();
        public GameRenderer.Frame frame(String key){return frames.computeIfAbsent(key,k->new GameRenderer.Frame(0,0,k.startsWith("glyph:")?8:k.startsWith("hiscore:")?32:16,k.startsWith("glyph:")?8:k.startsWith("hiscore:")?32:16));}
        public void begin(){draws.clear();}public void end(){}
        public void draw(String key,int x,int y,int w,int h,int color){draws.add(new Draw(key,x,y,w,h));}
        boolean at(String key,int x,int y){return draws.stream().anyMatch(d->d.key.equals(key)&&d.x==x&&d.y==y);}
    }
    private Game game(){Game game=new Game(new int[676],new int[20],true,1);game.state.phase=GameState.PLAYING;return game;}
    private TitleSession title(GameMemory memory){return new TitleSession(new Level(new int[676],new int[20]),memory);}
    @Test public void scoreStageTotalAndUnderlineStayOnTheirOriginalGrid(){
        Canvas c=new Canvas();GameRenderer r=new GameRenderer(c);BattleSession s=new BattleSession(game());s.screen=BattleSession.SCORE;
        r.render(s);assertTrue(c.at("glyph:S",96,40));assertTrue(c.at("glyph:1",152,40));assertTrue(c.at("glyph:T",48,184));
        assertTrue(c.draws.contains(new Draw("white",96,181,64,2)));
        assertTrue(c.at("score:3",121,165)); // Last tank ends at y=180, before the underline.
        s.game.state.stage=35;r.render(s);assertTrue(c.at("glyph:3",144,40));assertTrue(c.at("glyph:5",152,40));
    }
    @Test public void bonusNumbersAndUnitsKeepTheirSeparateColumns(){
        Canvas c=new Canvas();GameRenderer r=new GameRenderer(c);BattleSession s=new BattleSession(game());s.screen=BattleSession.SCORE;
        for(int player=0;player<2;player++){
            s.bonusPlayer=player;r.render(s);int left=player==0?24:176;
            assertTrue(c.at("glyph:B",left,200));assertTrue(c.at("glyph:1",left,208));assertTrue(c.at("glyph:P",left+40,208));
        }
    }
    @Test public void highScoreUsesSevenDigitsAndTheOriginalRightEdge(){
        Canvas c=new Canvas();GameRenderer r=new GameRenderer(c);BattleSession s=new BattleSession(game());s.screen=BattleSession.HISCORE;
        s.highScore=21000;r.render(s);assertTrue(c.at("hiscore:0:2",80,104));
        s.highScore=1000000;r.render(s);assertTrue(c.at("hiscore:0:1",16,104));
        assertEquals(7,c.draws.stream().filter(d->d.y==104).count());assertTrue(c.at("hiscore:0:0",208,104));
    }
    @Test public void titleCursorAndPreviousCoopScoreDoNotDependOnMenuHighlight(){
        Canvas c=new Canvas();GameRenderer r=new GameRenderer(c);GameMemory m=new GameMemory();TitleSession t=title(m);t.returned();
        r.title(t,m);assertTrue(c.at("glyph:0",64,24));assertTrue(c.at("glyph:0",72,24));assertTrue(c.at("word:CITY",64,88));assertTrue(c.at("player:0:0:right:0",64,132));assertFalse(c.at("glyph:Ⅱ",168,24));
        m.finishGame(game().state);t.selected=0;r.title(t,m);assertTrue(c.at("glyph:Ⅱ",168,24));
        t.selected=2;r.title(t,m);assertTrue(c.at("player:0:0:right:0",64,164));assertTrue(c.at("glyph:Ⅱ",168,24));
    }
    @Test public void selectionAndIntroUseFixedColumnsForOneAndTwoDigits(){
        Canvas c=new Canvas();GameRenderer r=new GameRenderer(c);
        for(int stage:new int[]{1,35}){
            r.selection(stage);assertTrue(c.at("glyph:S",96,112));assertTrue(c.at(stage==1?"glyph:1":"glyph:3",stage==1?152:144,112));
            Game game=game();game.state.phase=GameState.INTRO;game.state.stage=stage;
            r.render(new BattleSession(game));assertTrue(c.at("glyph:S",96,112));
            assertTrue(c.at(stage==1?"glyph:1":"glyph:3",stage==1?152:144,112));
        }
    }
    @Test public void selectionAndEditorHaveAPauseOverlayWithoutChangingTheirModels(){
        Canvas c=new Canvas();GameRenderer r=new GameRenderer(c);ConstructionState editor=new ConstructionState();int[] tiles=editor.tiles();
        r.selection(2,true,16);assertTrue(c.at("pause",100,121));r.selection(2,true,0);assertFalse(c.at("pause",100,121));
        r.construction(editor,10,true,16);assertTrue(c.at("pause",100,121));assertArrayEquals(tiles,editor.tiles());assertEquals(0,editor.x());
    }
}
