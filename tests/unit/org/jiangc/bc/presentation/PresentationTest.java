package org.jiangc.bc.presentation;

import java.io.*;
import org.jiangc.bc.presentation.GameRenderer.Frame;
import java.util.zip.*;
import java.nio.file.*;
import java.util.*;
import org.jiangc.bc.game.*;
import org.jiangc.bc.input.ScreenInput;
import org.junit.Test;
import static org.junit.Assert.*;

public class PresentationTest {
    /** Reads the exporter's explicit RGBA8/filter-0 PNG format, including chunk CRCs. */
    static final class Png {
        int width,height;int[] pixels;
        Png(Path path)throws Exception{
            ByteArrayOutputStream compressed=new ByteArrayOutputStream();
            try(DataInputStream in=new DataInputStream(Files.newInputStream(path))){
                assertEquals(0x89504e470d0a1a0aL,in.readLong());
                while(true){int length=in.readInt();byte[] type=new byte[4],data=new byte[length];in.readFully(type);in.readFully(data);
                    CRC32 crc=new CRC32();crc.update(type);crc.update(data);assertEquals(crc.getValue(),Integer.toUnsignedLong(in.readInt()));
                    String name=new String(type,java.nio.charset.StandardCharsets.US_ASCII);
                    if(name.equals("IHDR")){DataInputStream header=new DataInputStream(new ByteArrayInputStream(data));width=header.readInt();height=header.readInt();assertEquals(8,header.readByte());assertEquals(6,header.readByte());}
                    if(name.equals("IDAT"))compressed.write(data);if(name.equals("IEND"))break;
                }
            }
            pixels=new int[width*height];try(DataInputStream raw=new DataInputStream(new InflaterInputStream(new ByteArrayInputStream(compressed.toByteArray())))){
                for(int y=0;y<height;y++){assertEquals(0,raw.readUnsignedByte());for(int x=0;x<width;x++){int rgba=raw.readInt();pixels[y*width+x]=(rgba>>>8)|(rgba<<24);}}assertEquals(-1,raw.read());
            }
        }
        int getRGB(int x,int y){return pixels[y*width+x];}
    }
    static final class Surface implements GameRenderer.Canvas {
        final Png atlas=new Png(org.jiangc.bc.testing.GameData.path("assets/battle/atlas.png"));
        final Map<String,Frame> regions=new HashMap<>();
        final int[] pixels=new int[256*240];
        final List<String> commands=new ArrayList<>();
        Surface()throws Exception{for(String line:Files.readAllLines(org.jiangc.bc.testing.GameData.path("assets/battle/atlas.txt"))){String[] p=line.split("\t");regions.put(p[0],new Frame(Integer.parseInt(p[1]),Integer.parseInt(p[2]),Integer.parseInt(p[3]),Integer.parseInt(p[4])));}}
        public Frame frame(String key){return regions.get(key);}
        public void begin(){commands.clear();Arrays.fill(pixels,0);}
        public void end(){}
        public void draw(String key,int x,int y,int w,int h,int color){
            Frame r=regions.get(key);assertNotNull("Missing resource "+key,r);commands.add(key);
            for(int yy=0;yy<h;yy++)for(int xx=0;xx<w;xx++){if(x+xx<0 || x+xx>=256 || y+yy<0 || y+yy>=240)continue;
                int rgba=atlas.getRGB(r.x()+xx*r.width()/w,r.y()+yy*r.height()/h);if((rgba>>>24)==0)continue;
                int red=(rgba>>16&255)*(color>>16&255)/255,green=(rgba>>8&255)*(color>>8&255)/255,blue=(rgba&255)*(color&255)/255;
                pixels[(y+yy)*256+x+xx]=0xff000000|red<<16|green<<8|blue;
            }
        }
    }
    private TitleSession title(GameMemory memory)throws Exception{return new TitleSession(Level.read(Files.newInputStream(org.jiangc.bc.testing.GameData.path("assets/battle/demo.txt"))),memory);}
    @Test public void stunnedPlayerAndConstructionCursorUseOriginalBlinkBits()throws Exception{
        Surface surface=new Surface();GameRenderer renderer=new GameRenderer(surface);Game g=new Game(new int[676],new int[20],false,1);g.state.phase=GameState.PLAYING;
        GameState.Tank p=g.playerTank(0);p.spawnTicks=0;p.stunTicks=200;BattleSession s=new BattleSession(g);
        g.state.tick=0;renderer.render(s);assertTrue(surface.commands.contains("player:0:0:up:0"));int[] visible=surface.pixels.clone();
        g.state.tick=8;renderer.render(s);assertFalse(surface.commands.contains("player:0:0:up:0"));assertFalse(Arrays.equals(visible,surface.pixels));
        renderer.construction(new ConstructionState(),0);assertFalse(surface.commands.contains("player:0:0:up:0"));
        renderer.construction(new ConstructionState(),16);assertTrue(surface.commands.contains("player:0:0:up:0"));
    }
    @Test public void deathFramesShowExplosionBeforePointsAndAllScenesHaveResources()throws Exception{
        Surface surface=new Surface();GameRenderer renderer=new GameRenderer(surface);Game g=new Game(new int[676],new int[20],true,1);g.state.phase=GameState.PLAYING;
        GameState.Tank t=g.playerTank(0);t.deathTimer=0x73;t.deathPoints=400;BattleSession s=new BattleSession(g);
        GameState.Bullet bullet=new GameState.Bullet();g.state.bullets.add(bullet);
        renderer.render(s);assertTrue(surface.commands.contains("bullet:up"));
        bullet.impactTicks=9;renderer.render(s);assertFalse(surface.commands.contains("bullet:up"));assertTrue(surface.commands.contains("impact:0"));
        GameState.Tank armor=new GameState.Tank();armor.team=1;armor.kind=3;armor.hp=4;armor.spawnTicks=0;g.state.tanks.add(armor);
        g.state.tick=0;renderer.render(s);assertTrue(surface.commands.contains("enemy:armor:hp4:up:0"));
        g.state.tick=1;renderer.render(s);assertTrue(surface.commands.contains("enemy:armor:hp1:up:0"));
        for(int stage=7;stage>=1;stage--){t.deathTimer=(stage<<4)|3;renderer.render(s);assertEquals(stage==1,surface.commands.contains("points:400"));}
        for(int screen:new int[]{BattleSession.SCORE,BattleSession.GAME_OVER,BattleSession.HISCORE}){s.screen=screen;renderer.render(s);}
        s.screen=BattleSession.SCORE;s.bonusPlayer=1;s.elapsed=s.bonusAt();renderer.render(s);assertTrue(surface.commands.contains("arrow-right"));assertTrue(surface.commands.contains("glyph:!"));
    }
    @Test public void creditsAppearOnTheOriginalTimelineAndFinishWithSprite()throws Exception{
        Surface surface=new Surface();GameRenderer renderer=new GameRenderer(surface);GameMemory m=new GameMemory();TitleSession t=title(m);t.screen=TitleSession.CREDITS;
        t.elapsed=127;renderer.title(t,m);assertEquals(List.of("white"),surface.commands);
        t.elapsed=128;renderer.title(t,m);assertTrue(surface.commands.contains("glyph:T"));
        t.elapsed=640;renderer.title(t,m);assertTrue(surface.commands.contains("spawn:0"));
        t.elapsed=668;renderer.title(t,m);assertTrue(surface.commands.contains("credits"));
    }
    @Test public void demoLogoUsesDestructibleWebGlyphMasksInsteadOfAnOverlay()throws Exception{
        Surface surface=new Surface();GameRenderer renderer=new GameRenderer(surface);GameMemory memory=new GameMemory();TitleSession t=title(memory);t.returned();t.elapsed=639;
        ScreenInput.Frame empty=new ScreenInput().consume();t.step(empty,empty);
        // Shared Web B begins 01111110 / 01100011; each bit occupies a 4px brick quadrant.
        int cell=7*26+1;assertArrayEquals(new int[]{10,7,3,13},Arrays.copyOfRange(t.demo.state.brickMasks,cell,cell+4));
        renderer.title(t,memory);int[] intact=surface.pixels.clone();assertFalse(surface.commands.contains("word:BATTLE"));
        t.demo.state.tiles[cell]=0;t.demo.state.brickMasks[cell]=0;renderer.title(t,memory);
        assertFalse("A destroyed title brick must visibly disappear",Arrays.equals(intact,surface.pixels));
    }
    @Test public void waterAlternatesSharedWebFramesEvery32Ticks()throws Exception{
        Surface surface=new Surface();GameRenderer renderer=new GameRenderer(surface);int[] tiles=new int[676];tiles[0]=3;
        Game g=new Game(tiles,new int[20],false,1);g.state.phase=GameState.PLAYING;BattleSession s=new BattleSession(g);
        for(int tick:new int[]{0,31,32,63,64,95,96}){
            g.state.tick=tick;renderer.render(s);assertTrue(surface.commands.contains("water:"+((tick&32)==0?2:1)));
            assertFalse(surface.commands.contains("water:0"));
        }
    }
}
