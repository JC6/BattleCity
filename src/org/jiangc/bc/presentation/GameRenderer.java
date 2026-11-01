package org.jiangc.bc.presentation;

import java.util.*;
import org.jiangc.bc.game.*;
import org.jiangc.bc.game.GameState.*;

/** Pure layout shared by the actual GL display and JVM pixel acceptance tests. */
public class GameRenderer {
    public record Frame(int x,int y,int width,int height) { }
    public interface Canvas {Frame frame(String key);void begin();void draw(String key,int x,int y,int w,int h,int color);void end();}
    private final Canvas canvas;
    public GameRenderer(Canvas canvas){this.canvas=canvas;}
    private static final int WHITE=0xfcfcfc,GRAY=0x666666,BLACK=0,RED=0xbc3410,YELLOW=0xf8b800,GREEN=0x80d010;
    private void draw(String key,int x,int y){Frame f=canvas.frame(key);draw(key,x,y,f.width(),f.height(),0xffffff);}
    private void draw(String key,int x,int y,int width,int height,int color){canvas.draw(key,x,y,width,height,color);}
    private void centered(String key,int x,int y){Frame size=canvas.frame(key);draw(key,x-size.width()/2,y-size.height()/2);}
    private void rect(int x,int y,int w,int h,int color){if(w>0 && h>0)draw("white",x,y,w,h,color);}
    private void text(String text,int x,int y,int color){for(int i=0;i<text.length();i++){String key="glyph:"+text.charAt(i);if(canvas.frame(key)!=null)draw(key,x+i*8,y,8,8,color);}}
    private void finish(){canvas.end();}
    // DA2B writes centerY - 8 to OAM; the PPU displays it one scanline later.
    // Model coordinates are relative to the playfield's background at y=16.
    private static int spriteY(int y){return 17+y;}
    private void stage(int stage,int y,int color){text("STAGE",96,y,color);number(stage,160,y,color);}
    private void pause(boolean paused,int tick){if(paused && (tick&16)!=0)draw("pause",100,121);}
    public void selection(int stage){selection(stage,false,0);}
    public void selection(int stage,boolean paused,int tick){canvas.begin();rect(0,0,256,240,GRAY);stage(stage,112,BLACK);pause(paused,tick);finish();}
    public void construction(ConstructionState state,int tick){construction(state,tick,false,0);}
    public void construction(ConstructionState state,int tick,boolean paused,int pauseTick){
        canvas.begin();rect(0,0,256,240,GRAY);rect(16,16,208,208,BLACK);
        int[] tiles=state.tiles();
        for(int i=0;i<tiles.length;i++){
            String key=switch(tiles[i]){case 1->"brick:15";case 2->"steel";case 3->"water:"+((tick&32)==0?2:1);case 4->"forest";case 5->"ice";default->null;};
            if(key!=null)draw(key,16+i%26*8,16+i/26*8);
        }
        if(state.baseVisible())draw("base:alive",112,208);
        if((tick&16)!=0)draw("player:0:0:up:0",16+state.x()*16,spriteY(state.y()*16));pause(paused,pauseTick);finish();
    }
    private void highScore(BattleSession session){
        rect(0,0,256,240,BLACK);int phase=session.elapsed&3;
        String title="HISCORE",score=""+session.highScore;
        for(int i=0;i<title.length();i++)draw("hiscore:"+phase+":"+title.charAt(i),16+i*32,52);
        int size=32,left=16+(7-score.length())*32;
        for(int i=0;i<score.length();i++)draw("hiscore:"+phase+":"+score.charAt(i),left+i*size,104,size,size,0xffffff);
    }
    public void render(BattleSession session){render(session,false,0);}
    public void render(BattleSession session,boolean paused,int pauseTick){
        canvas.begin();
        if(session.screen==BattleSession.SCORE || session.screen==BattleSession.DONE) score(session);
        else if(session.screen==BattleSession.GAME_OVER){rect(0,0,256,240,BLACK);draw("word:GAME",60,72);draw("word:OVER",60,124);}
        else if(session.screen==BattleSession.HISCORE)highScore(session);
        else {
            GameState s=session.game.state;
            world(s);
            if(s.phase==GameState.INTRO){
                if(s.introTicks>=GameState.OPEN_FRAMES+GameState.SETUP_FRAMES){rect(0,0,256,240,GRAY);stage(s.stage,112,BLACK);}
                else {int cover=Math.max(0,Math.min(112,(s.introTicks-GameState.SETUP_FRAMES)*8));rect(0,0,256,cover,GRAY);rect(0,240-cover,256,cover,GRAY);}
            }
            if(s.lossBannerTicks>0)draw("loss",104,233-Math.min(127,256-s.lossBannerTicks));
        }
        pause(paused,pauseTick);
        finish();
    }
    private void world(GameState s){
        rect(0,0,256,240,GRAY);rect(16,16,208,208,BLACK);
        for(int i=0;i<s.tiles.length;i++){
            String key=switch(s.tiles[i]){case 1->"brick:"+s.brickMasks[i];case 2->"steel";case 3->"water:"+((s.tick&32)==0?2:1);case 5->"ice";default->null;};
            if(key!=null)draw(key,16+i%26*8,16+i/26*8);
        }
        draw(s.baseAlive?"base:alive":"base:dead",112,208);
        for(Tank t:s.tanks){int x=16+t.x,y=spriteY(t.y);
            if(s.phase==GameState.INTRO || t.deathTimer>0)continue;
            if(t.spawnTicks>0)draw("spawn:"+Math.min(3,Math.abs(((28-t.spawnTicks)%14)-7)/2),x,y);
            else {if(t.team==0 && t.stunTicks>0 && (s.tick&8)!=0)continue;int tread=t.tread;
                // DFD7/E003 alternate the armor palette on every frame.
                int armorPalette=(s.tick&1)==0?t.hp:t.hp==2?4:1;
                String key=t.team==0?"player:"+t.playerIndex+":"+t.stars:
                        "enemy:"+GameState.KINDS[t.kind]+":"+(t.carryingPowerUp && (s.tick&8)!=0?"flash":t.kind==3?"hp"+armorPalette:"normal");
                draw(key+":"+GameState.DIRECTIONS[t.direction]+":"+tread,x,y);
                if(t.shieldTicks>0)draw("shield:"+((s.tick>>1)&1),x,y);}
        }
        for(Bullet b:s.bullets)if(b.impactTicks<=0)centered("bullet:"+GameState.DIRECTIONS[b.direction],16+b.x,spriteY(b.y));
        for(int i=0;i<s.tiles.length;i++)if(s.tiles[i]==4)draw("forest",16+i%26*8,16+i/26*8);
        for(Bullet b:s.bullets)if(b.impactTicks>0)draw("impact:"+Math.min(2,(9-b.impactTicks)/3),16+b.x-8,spriteY(b.y-8));
        for(Tank t:s.tanks){int x=16+t.x,y=spriteY(t.y);
            if(t.deathTimer>0){
                int stage=t.deathTimer>>4;
                if(stage==1 && t.deathPoints>0)centered("points:"+t.deathPoints,x+8,y+8);
                else {int phase=switch(stage){case 7->0;case 6->1;case 5,2->2;case 4->3;case 3->4;default->0;};centered("explosion:"+phase,x+8,y+8);}
                continue;
            }
        }
        if(s.powerUp!=null && (s.tick&8)!=0)draw("item:"+GameState.POWERS[s.powerUp.kind()],16+s.powerUp.x(),spriteY(s.powerUp.y()));
        if(s.baseExplosionTicks>0){int phase=5-Math.abs((s.baseExplosionTicks>>2)-5);
            if(phase>0){Frame f=canvas.frame("explosion:"+(phase-1));draw("explosion:"+(phase-1),120-f.width()/2,217-f.height()/2);}}
        for(Effect e:s.effects){centered("points:"+e.value,16+e.x,spriteY(e.y));}
        if(s.eliminationTicks>0 && !s.demo){int progress=Math.min(63,208-s.eliminationTicks);draw("loss",s.eliminationPlayer==0?24+progress:184-progress,209);}
        if(s.phase==GameState.INTRO && s.introTicks>GameState.SETUP_FRAMES)return;
        for(int i=0;i<Math.max(0,s.enemyQueue.length-s.spawned);i++)draw("enemy-icon",232+i%2*8,24+i/2*8);
        for(Player p:s.players){int y=136+p.index*24;draw("hud-player:"+p.index,232,y);draw("life:"+p.index,232,y+8);text(""+(p.eliminated?0:p.lives),240,y+8,BLACK);}
        draw("flag",232,184);String stage=""+s.stage;text(stage,248-stage.length()*8,200,BLACK);
    }
    private void score(BattleSession session){
        GameState s=session.game.state;rect(0,0,256,240,BLACK);
        text("HI-SCORE",64,24,RED);number(session.highScore,192,24,YELLOW);stage(s.stage,40,WHITE);
        for(Player p:s.players){boolean right=p.index==1;int offset=right?144:0;
            text(right?"Ⅱ-PLAYER":"Ⅰ-PLAYER",right?168:24,56,right?GREEN:RED);number(p.score,88+offset,72,YELLOW);
            for(int row=0;row<4;row++){int y=96+row*24,count=session.count(row,p.index);text("PTS",64+offset,y,WHITE);
                if(count>=0){number(count*(row+1)*100,56+offset,y,WHITE);number(count,right?160:112,y,WHITE);}}
        }
        rect(96,181,64,2,WHITE);
        for(int r=0;r<4;r++){draw("arrow",112,96+r*24,8,8,WHITE);if(s.players.length==2)draw("arrow-right",136,96+r*24,8,8,WHITE);}
        for(int r=0;r<4;r++)draw("score:"+r,121,93+r*24);
        text("TOTAL",48,184,WHITE);
        if(session.totalVisible())for(Player p:s.players)number(Arrays.stream(p.kills).sum(),p.index==0?112:160,184,WHITE);
        if(session.bonusPlayer>=0){int x=session.bonusPlayer==0?24:176;text("BONUS!",x,200,RED);text("1000",x,208,WHITE);text("PTS",x+40,208,WHITE);}
    }
    private void number(int value,int right,int y,int color){String s=""+(value%1000000);text(s,right-s.length()*8,y,color);}
    private void menuNumber(int value,int right,int y,int color){String s=value%1000000==0?"00":""+(value%1000000);text(s,right-s.length()*8,y,color);}
    public void title(TitleSession title,GameMemory memory){
        if(title.screen==TitleSession.DEMO){canvas.begin();world(title.demo.state);finish();return;}
        if(title.screen==TitleSession.CREDITS){credits(title.elapsed);return;}
        canvas.begin();rect(0,0,256,240,BLACK);int y=title.screen==TitleSession.SCROLL?240-title.elapsed:0;
        int[] scores=memory.lastScores();text("Ⅰ-",16,24+y,WHITE);menuNumber(scores[0],80,24+y,WHITE);text("HI-",88,24+y,WHITE);menuNumber(memory.highScore(),160,24+y,WHITE);
        if(memory.lastCoop()){text("Ⅱ-",168,24+y,WHITE);menuNumber(scores[1],232,24+y,WHITE);}
        draw("word:BATTLE",24,48+y);draw("word:CITY",64,88+y);
        text("1 PLAYER",88,136+y,WHITE);text("2 PLAYERS",88,152+y,WHITE);text("CONSTRUCTION",88,168+y,WHITE);
        draw("player:0:0:right:"+(title.elapsed/4%2),64,132+title.selected*16+y);
        draw("namcot",88,184+y);text("© 1980 1985 NAMCO LTD.",32,200+y,WHITE);text("ALL RIGHTS RESERVED",48,216+y,WHITE);
        if(title.screen==TitleSession.CLOSING){int cover=Math.min(120,title.elapsed*8);rect(0,0,256,cover,GRAY);rect(0,240-cover,256,cover,GRAY);}
        finish();
    }
    private void credits(int tick){
        canvas.begin();rect(0,0,256,240,BLACK);
        String[] lines={"THIS PROGRAM WAS","WRITTEN BY","OPEN-REACH","WHO LOVES NORIKO"};
        for(int i=0;i<lines.length;i++)if(tick>=128+i*64)text(lines[i],64,64+i*16,WHITE);
        for(int i=0;i<5;i++)if(tick>=384+i*64)text(".",64+i*8,128,WHITE);
        if(tick>=640){int t=tick-640;if(t<28)draw("spawn:"+(3-Math.abs(3-t/4)),112,23);else draw("credits",112,23+t-28);}
        finish();
    }
}
