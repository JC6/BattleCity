package org.jiangc.bc.game;

import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.game.GameState.*;

/** Regression expectations from DC52/DD11, C728/C238 and E2D2, independent of exports. */
public class BattleRegressionTest {
    private static final PlayerInput[] NONE={PlayerInput.NONE,PlayerInput.NONE};
    private static final PlayerInput UP=new PlayerInput(true,false,false,false,false);
    private Game arena(boolean coop){Game g=new Game(new int[676],new int[20],coop,1);g.state.phase=PLAYING;g.state.spawnTimer=10000;for(Tank t:g.state.tanks){t.spawnTicks=0;t.shieldTicks=0;}return g;}
    private Tank enemy(Game g){Tank t=new Tank();t.id=80;t.team=1;t.enemySlot=0;t.spawnTicks=0;t.kind=1;t.x=41;t.y=40;t.direction=2;g.state.tanks.add(t);return t;}
    @Test public void hqExplosionAndGameOverKeepEnemiesRunningUntilScore(){
        Game g=arena(false);Tank e=enemy(g),p=g.playerTank(0);p.shieldTicks=1000;
        Bullet b=new Bullet();b.id=90;b.gunSlot=2;b.team=1;b.speed=4;b.direction=2;b.x=104;b.y=190;g.state.bullets.add(b);
        BattleSession session=new BattleSession(g);
        session.step(new PlayerInput[]{UP});assertFalse(g.state.baseAlive);assertEquals(38,g.state.baseExplosionTicks);
        assertEquals(0,g.state.lossBannerTicks);int playerY=p.y,enemyY=e.y;
        for(int i=0;i<37;i++)session.step(new PlayerInput[]{UP});
        assertTrue("Enemy keeps moving throughout HQ explosion",e.y>enemyY);assertEquals(playerY,p.y);
        assertEquals(BattleSession.BATTLE,session.screen);assertEquals(0,g.state.lossBannerTicks);
        session.step(NONE);assertEquals(256,g.state.lossBannerTicks);
        for(int i=0;i<255;i++)session.step(NONE);assertEquals(BattleSession.BATTLE,session.screen);
        session.step(NONE);assertEquals(BattleSession.SCORE,session.screen);
    }
    @Test public void flightBulletAfterLossCountsBeforeAuthoritativeScoreFreezes(){
        Game g=arena(false);Tank e=enemy(g);g.state.freezeTicks=1000;g.state.baseAlive=false;g.state.players[0].score=19900;
        BattleSession session=new BattleSession(g);session.step(NONE);
        Bullet b=new Bullet();b.id=90;b.gunSlot=0;b.team=0;b.playerIndex=0;b.speed=4;b.x=e.x+8;b.y=e.y+12;g.state.bullets.add(b);
        session.step(NONE);assertEquals(20100,g.state.players[0].score);assertEquals(1,g.state.players[0].kills[1]);
        assertEquals("No extra life after loss",2,g.state.players[0].lives);
        for(int i=0;i<255;i++)session.step(NONE);assertEquals(BattleSession.SCORE,session.screen);
        String frozen=StateSnapshot.canonical(g.state,List.of());for(int i=0;i<100;i++)session.step(NONE);
        assertEquals(frozen,StateSnapshot.canonical(g.state,List.of()));
    }
    @Test public void onlySurvivingPartnerGetsHorizontalEliminationBanner(){
        for(boolean coop:new boolean[]{false,true}){
            Game g=arena(coop);g.state.players[0].lives=0;g.playerTank(0).deathTimer=0x11;g.step(NONE);
            assertTrue(g.state.players[0].eliminated);
            assertEquals(coop?208:0,g.state.eliminationTicks);
            assertEquals(coop?0:256,g.state.lossBannerTicks);
            if(coop){g.state.players[1].lives=0;g.playerTank(1).deathTimer=0x11;g.step(NONE);g.step(NONE);
                assertEquals(0,g.state.eliminationTicks);assertEquals(256,g.state.lossBannerTicks);}
        }
    }
    @Test public void anyRemainingBrickQuarterBlocksTheWholeTerrainCell(){
        for(int mask=1;mask<16;mask++){
            Game g=arena(false);Tank p=g.playerTank(0);p.x=80;p.y=88;
            int i=10*26+10;g.state.tiles[i]=1;g.state.brickMasks[i]=mask;g.step(new PlayerInput[]{UP});
            assertEquals("mask "+mask,88,p.y);assertEquals(1,p.tread);
            g.state.tiles[i]=0;g.state.brickMasks[i]=0;g.step(new PlayerInput[]{UP});g.step(new PlayerInput[]{UP});assertEquals(87,p.y);
        }
    }
    @Test public void wallTreadsToggleOnEligiblePlayerUpdatesAndStopOnRelease(){
        Game g=arena(false);Tank p=g.playerTank(0);p.y=0;
        int[] frames={1,1,0,1};for(int expected:frames){g.step(new PlayerInput[]{UP});assertEquals(expected,p.tread);assertEquals(0,p.y);}
        g.step(NONE);assertEquals(1,p.tread);
    }
    @Test public void blockedEnemyWaitsTwoEligibleUpdatesBeforeRetry(){
        Game g=arena(false);Tank e=enemy(g);e.y=192;e.direction=2;g.state.rng=1;
        g.step(NONE);assertEquals(2,e.aiTicks);int tread=e.tread;
        g.step(NONE);assertEquals(1,e.aiTicks);assertEquals(tread,e.tread);
        g.step(NONE);assertEquals(0,e.aiTicks);assertEquals(tread,e.tread);
        assertEquals(192,e.y);
    }
    @Test public void alignedEnemyReverseSchedulesTurnBeforeMoving(){
        Game g=arena(false);Tank e=enemy(g);e.x=40;e.y=192;e.direction=2;
        boolean found=false;
        for(int seed=1;seed<100 && !found;seed++){
            g.state.rng=seed;e.aiTicks=0;e.aiTurn=false;e.direction=2;g.step(NONE);found=e.aiTurn;
        }
        assertTrue(found);assertEquals(0,e.direction);int x=e.x,y=e.y,tread=e.tread;
        g.step(NONE);assertFalse(e.aiTurn);assertEquals(x,e.x);assertEquals(y,e.y);assertEquals(tread,e.tread);
    }
    @Test public void introUsesMapAttributesCurtainAndSetupWithoutAdvancingBattleClock()throws Exception{
        LevelCatalog levels=LevelCatalogTest.catalog();
        for(boolean custom:new boolean[]{false,true}){
            Campaign c=new Campaign(levels,false,()->1,1,custom?new int[676]:null,new GameMemory());Game g=c.session().game;
            int duration=custom?83:96;
            for(int i=0;i<duration-1;i++)c.step(NONE);assertEquals(INTRO,g.state.phase);assertEquals(0,g.state.battleTicks);
            c.step(NONE);assertEquals(PLAYING,g.state.phase);assertEquals(0,g.state.battleTicks);
            c.step(NONE);assertEquals(1,g.state.battleTicks);
        }
    }
}
