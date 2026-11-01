package org.jiangc.bc.presentation;

import java.util.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.regex.Pattern;
import org.junit.Test;
import static org.junit.Assert.*;
import org.jiangc.bc.game.*;
import org.jiangc.bc.game.GameState.*;
import org.jiangc.bc.presentation.PresentationTest.Surface;

/** Reference frame hashes and independent composition at fixed coordinates. */
public final class WebGraphicsTest {
    @Test public void everyGeneratedFrameMatchesTheFixedReferenceWithoutExternalAssets()throws Exception{
        Surface s=new Surface();
        String data=Files.readString(Path.of("web/tests/game/fixtures/native-golden.json"));
        data=data.substring(data.indexOf("\"referenceFrames\": {"));
        var entries=Pattern.compile("\"([^\"]+)\": \\{\\s*\"width\": (\\d+),\\s*\"height\": (\\d+),\\s*\"sha256\": \"([0-9a-f]{64})\"").matcher(data);
        Set<String> keys=new HashSet<>();
        while(entries.find()){
            String key=entries.group(1);assertTrue(key,keys.add(key));
            assertSize(s,key,Integer.parseInt(entries.group(2)),Integer.parseInt(entries.group(3)));
            MessageDigest hash=MessageDigest.getInstance("SHA-256");
            for(int argb:patch(s,key))hash.update(new byte[]{(byte)(argb>>16),(byte)(argb>>8),(byte)argb,(byte)(argb>>>24)});
            assertEquals(key,entries.group(4),HexFormat.of().formatHex(hash.digest()));
        }
        assertEquals(335,keys.size());assertEquals(keys,s.regions.keySet());
    }
    private void assertSize(Surface s,String key,int w,int h){assertEquals(w,s.frame(key).width());assertEquals(h,s.frame(key).height());}
    private Game arena(){Game g=new Game(new int[676],new int[20],false,1);g.state.phase=GameState.PLAYING;g.state.tanks.clear();return g;}
    private void stamp(Surface s,int[] pixels,String key,int left,int top){
        GameRenderer.Frame f=s.frame(key);assertNotNull(key,f);
        for(int y=0;y<f.height();y++)for(int x=0;x<f.width();x++){
            int color=s.atlas.getRGB(f.x()+x,f.y()+y),xx=left+x,yy=top+y;
            if((color>>>24)!=0 && xx>=0 && yy>=0 && xx<256 && yy<240)pixels[yy*256+xx]=color;
        }
    }
    private void centered(Surface s,int[] pixels,String key,int x,int y){GameRenderer.Frame f=s.frame(key);stamp(s,pixels,key,x-f.width()/2,y-f.height()/2);}
    private int[] patch(Surface s,String key){GameRenderer.Frame f=s.frame(key);int[] p=new int[f.width()*f.height()];for(int y=0;y<f.height();y++)for(int x=0;x<f.width();x++)p[y*f.width()+x]=s.atlas.getRGB(f.x()+x,f.y()+y);return p;}
    @Test public void animationsHaveDistinctFramesAndHudBackgroundsStayGray()throws Exception{
        Surface s=new Surface();
        assertSame("Atlas bounds must be cached",s.frame("steel"),s.frame("steel"));
        for(var group:Map.of("spawn:",4,"shield:",2,"explosion:",5).entrySet()){
            Set<String> unique=new HashSet<>();
            for(int i=0;i<group.getValue();i++)unique.add(Arrays.toString(patch(s,group.getKey()+i)));
            assertEquals(group.getKey(),group.getValue().intValue(),unique.size());
        }
        for(int value=100;value<=500;value+=100)assertSize(s,"points:"+value,16,16);
        for(int i=0;i<5;i++)assertSize(s,"explosion:"+i,i<3?16:32,i<3?16:32);
        for(String key:List.of("enemy-icon","life:0","life:1"))assertEquals(0xff666666,patch(s,key)[0]);
        assertEquals(0xff666666,patch(s,"flag")[15]);
        for(char c:"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ- .!©ⅠⅡ".toCharArray())assertSize(s,"glyph:"+c,8,8);
    }
    @Test public void actualBattleCentersFourBulletDirectionsAndKeepsTheGrayHud()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);Game g=arena();BattleSession session=new BattleSession(g);
        r.render(session);int[] expected=s.pixels.clone();
        String[] directions={"up","right","down","left"};
        for(int d=0;d<4;d++){
            Bullet b=new Bullet();b.x=32+d*40;b.y=40;b.direction=d;g.state.bullets.add(b);
            stamp(s,expected,"bullet:"+directions[d],44+d*40,49);
        }
        r.render(session);assertArrayEquals(expected,s.pixels);
        assertEquals(0xff666666,s.pixels[24*256+232]);assertEquals(0xff666666,s.pixels[184*256+247]);
    }
    @Test public void shieldAlternatesEveryTwoFramesOverTheActualTankPixels()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);Game g=arena();BattleSession session=new BattleSession(g);
        r.render(session);int[] background=s.pixels.clone();Tank p=new Tank();p.playerIndex=0;p.x=64;p.y=80;p.spawnTicks=0;p.shieldTicks=100;g.state.tanks.add(p);
        for(int tick=0;tick<8;tick++){
            g.state.tick=tick;int[] expected=background.clone();stamp(s,expected,"player:0:0:up:0",80,97);stamp(s,expected,"shield:"+(tick/2%2),80,97);
            r.render(session);assertArrayEquals(expected,s.pixels);
        }
    }
    @Test public void tankAndSpawnOriginsStayAlignedAtAllFourCorners()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);Game g=arena();BattleSession session=new BattleSession(g);
        r.render(session);int[] background=s.pixels.clone();
        for(int x:new int[]{0,192})for(int y:new int[]{0,192})for(int phase=0;phase<5;phase++){
            g.state.tanks.clear();Tank t=new Tank();t.playerIndex=0;t.x=x;t.y=y;t.spawnTicks=phase==4?0:28-phase*2;g.state.tanks.add(t);
            int[] expected=background.clone();stamp(s,expected,phase==4?"player:0:0:up:0":"spawn:"+(3-phase),16+x,17+y);
            r.render(session);assertArrayEquals("corner / phase "+phase,expected,s.pixels);
        }
    }
    @Test public void differentExplosionAndPointSizesKeepTheirCentersAndLeaveNoResidue()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);Game g=arena();BattleSession session=new BattleSession(g);
        r.render(session);int[] background=s.pixels.clone();Tank t=new Tank();t.team=1;t.x=t.y=64;t.deathPoints=400;g.state.tanks.add(t);
        for(int stage=7;stage>=1;stage--){
            t.deathTimer=stage*16+3;int[] expected=background.clone();
            centered(s,expected,stage==1?"points:400":"explosion:"+new int[]{0,0,2,4,3,2,1,0}[stage],88,89);
            r.render(session);assertArrayEquals("death stage "+stage,expected,s.pixels);
        }
        g.state.tanks.clear();g.state.baseAlive=false;r.render(session);background=s.pixels.clone();int[] ticks={39,32,28,24,20};
        for(int phase=0;phase<5;phase++){
            g.state.baseExplosionTicks=ticks[phase];int[] expected=background.clone();centered(s,expected,"explosion:"+phase,120,217);
            r.render(session);assertArrayEquals("base phase "+phase,expected,s.pixels);
        }
        g.state.baseExplosionTicks=0;r.render(session);assertArrayEquals(background,s.pixels);
    }
    @Test public void impactPowerupsAndPointsUseTheVisibleSpriteOrigin()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);Game g=arena();BattleSession session=new BattleSession(g);g.state.tick=8;
        r.render(session);int[] background=s.pixels.clone();Bullet b=new Bullet();b.x=b.y=72;g.state.bullets.add(b);
        for(int phase=0;phase<3;phase++){
            b.impactTicks=9-phase*3;int[] expected=background.clone();stamp(s,expected,"impact:"+phase,80,81);r.render(session);assertArrayEquals(expected,s.pixels);
        }
        g.state.bullets.clear();
        for(int kind=0;kind<6;kind++){
            g.state.powerUp=new PowerUp(kind,64,64);int[] expected=background.clone();stamp(s,expected,"item:"+GameState.POWERS[kind],80,81);r.render(session);assertArrayEquals(expected,s.pixels);
        }
        g.state.powerUp=null;Effect e=new Effect();e.x=e.y=72;e.value=500;g.state.effects.add(e);
        int[] expected=background.clone();stamp(s,expected,"points:500",80,81);r.render(session);assertArrayEquals(expected,s.pixels);
    }
    @Test public void constructionCursorMovesWithoutMovingTerrain()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);ConstructionState state=new ConstructionState();
        for(int corner=0;corner<2;corner++){
            r.construction(state,0);int[] expected=s.pixels.clone();stamp(s,expected,"player:0:0:up:0",16+192*corner,17+192*corner);
            r.construction(state,16);assertArrayEquals(expected,s.pixels);state.move(12,12);
        }
    }
    @Test public void forestCoversTankInkButExplosionsStayAboveTheForest()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);Game g=arena();BattleSession session=new BattleSession(g);
        for(int y=8;y<12;y++)for(int x=8;x<12;x++)g.state.tiles[y*26+x]=4;
        r.render(session);int[] background=s.pixels.clone(),expected=background.clone();Tank t=new Tank();t.playerIndex=0;t.spawnTicks=0;t.x=t.y=64;g.state.tanks.add(t);
        stamp(s,expected,"player:0:0:up:0",80,81);
        for(int y=80;y<112;y+=8)for(int x=80;x<112;x+=8)stamp(s,expected,"forest",x,y);
        r.render(session);assertArrayEquals(expected,s.pixels);
        t.deathTimer=0x43;expected=background.clone();centered(s,expected,"explosion:3",88,89);r.render(session);assertArrayEquals(expected,s.pixels);
    }
    @Test public void pauseBlinksWithoutAdvancingTheSimulationOrLeavingPixels()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);Game g=arena();BattleSession session=new BattleSession(g);
        r.render(session);int[] background=s.pixels.clone();
        for(int tick=0;tick<48;tick++){
            int[] expected=background.clone();if((tick&16)!=0)stamp(s,expected,"pause",100,121);
            r.render(session,true,tick);assertEquals(0,g.state.tick);assertArrayEquals(expected,s.pixels);
        }
    }
    @Test public void scoreTanksFitAboveTheUnderlineAndUseTheirNativeSize()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);BattleSession session=new BattleSession(arena());session.screen=BattleSession.SCORE;r.render(session);
        for(int row=0;row<4;row++){
            int[] frame=patch(s,"score:"+row);
            for(int y=0;y<16;y++)for(int x=0;x<16;x++)assertEquals(frame[y*16+x]>>>24==0?0xff000000:frame[y*16+x],s.pixels[(93+row*24+y)*256+121+x]);
        }
        assertEquals(0xfffcfcfc,s.pixels[181*256+120]);
        assertEquals(0xfffcfcfc,s.pixels[96*256+116]);
        assertEquals(0xff000000,s.pixels[96*256+112]);
    }
    @Test public void lossMessagesSlideAtFixedCoordinatesAndOpeningHidesSpawns()throws Exception{
        Surface s=new Surface();GameRenderer r=new GameRenderer(s);Game g=arena();BattleSession session=new BattleSession(g);r.render(session);int[] background=s.pixels.clone();
        for(int player=0;player<2;player++)for(int remaining:new int[]{208,144,1}){
            g.state.eliminationPlayer=player;g.state.eliminationTicks=remaining;int progress=Math.min(63,208-remaining);int[] expected=background.clone();
            stamp(s,expected,"loss",player==0?24+progress:184-progress,209);r.render(session);assertArrayEquals(expected,s.pixels);
        }
        g.state.eliminationTicks=0;
        for(int remaining:new int[]{256,200,1}){
            g.state.lossBannerTicks=remaining;int[] expected=background.clone();stamp(s,expected,"loss",104,233-Math.min(127,256-remaining));r.render(session);assertArrayEquals(expected,s.pixels);
        }
        Game intro=new Game(new int[676],new int[20],false,1);intro.state.introTicks=10;r.render(new BattleSession(intro));
        assertFalse(s.commands.stream().anyMatch(key->key.startsWith("spawn:")));assertFalse(s.commands.contains("enemy-icon"));
    }
}
