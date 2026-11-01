package org.jiangc.bc.game;

import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.game.GameState.*;
import org.jiangc.bc.audio.EngineSound;

/** Expectations derived from the original routines, not a second game implementation. */
public class OriginalRulesTest {
    private static final PlayerInput[] NONE={PlayerInput.NONE,PlayerInput.NONE};
    private Game arena(boolean coop){Game g=new Game(new int[676],new int[20],coop,1);g.state.phase=PLAYING;g.state.tick=120;g.state.spawnTimer=10000;for(Tank t:g.state.tanks){t.spawnTicks=t.shieldTicks=0;}return g;}
    @Test public void pursuitUses64FrameCounterAndEightBitWrap(){
        Game g=arena(false);int[][] cases={{1535,0},{1536,1},{3007,1},{3008,2},{16383,2},{16384,0}};
        for(int[] c:cases){g.state.battleTicks=c[0];assertEquals("battle tick "+c[0],c[1],g.pursuit());}
    }
    @Test public void bonusRequiresWinStrictLeaderAndSurvivingPlayerAndIsAwardedDuringScore(){
        for(int outcome:new int[]{WON,LOST})for(boolean dead:new boolean[]{false,true})for(boolean tie:new boolean[]{false,true}){
            Game g=arena(true);g.state.phase=outcome;g.state.players[0].score=19500;g.state.players[0].eliminated=dead;
            g.state.players[0].kills[0]=12;g.state.players[1].kills[0]=tie?12:8;
            BattleSession s=new BattleSession(g);s.screen=BattleSession.SCORE;
            for(int i=0;i<s.bonusAt()-1;i++)s.step(NONE);assertEquals(19500,g.state.players[0].score);
            boolean eligible=outcome==WON && !dead && !tie;
            List<GameEvent> events=s.step(NONE);assertEquals(eligible?20500:19500,g.state.players[0].score);
            assertEquals(eligible?0:-1,s.bonusPlayer);assertEquals(dead,g.state.players[0].eliminated);
            assertEquals(eligible?1:0,events.stream().filter(e->e.type.equals("score-bonus")).count());
            assertEquals(eligible?1:0,events.stream().filter(e->e.type.equals("extra-life") && e.reason.equals("score")).count());
            assertEquals(eligible?3:2,g.state.players[0].lives);
            for(int i=0;i<1000;i++)s.step(NONE);assertEquals(eligible?20500:19500,g.state.players[0].score);
        }
    }
    @Test public void enemySlotSurvivesExplosionThenPointsBeforeReplacement(){
        Game g=arena(false);g.state.spawnTimer=0;g.state.freezeTicks=1000;
        Tank dead=null;for(int slot=0;slot<4;slot++){Tank t=new Tank();t.id=10+slot;t.team=1;t.enemySlot=slot;t.spawnTicks=0;t.x=slot*32;t.y=40;g.state.tanks.add(t);dead=t;}
        g.destroyEnemy(dead,0);assertEquals(0x73,dead.deathTimer);assertEquals(0,g.state.killed);assertTrue(g.state.effects.isEmpty());
        for(int i=0;i<36;i++)g.step(NONE);assertTrue(g.state.tanks.contains(dead));assertEquals(1,dead.deathTimer>>4);assertEquals(0,g.state.spawned);
        for(int i=0;i<12;i++)g.step(NONE);assertFalse(g.state.tanks.contains(dead));assertEquals(1,g.state.killed);assertEquals(1,g.state.spawned);
    }
    @Test public void lastEnemyDoesNotWinUntilItsPresentationFinishes(){
        Game g=arena(false);g.state.killed=19;g.state.spawned=20;Tank t=new Tank();t.id=8;t.team=1;t.enemySlot=0;t.spawnTicks=0;t.x=20;t.y=20;g.state.tanks.add(t);g.destroyEnemy(t,0);
        for(int i=0;i<46;i++)g.step(NONE);assertEquals(-1,g.state.pendingOutcome);g.step(NONE);assertEquals(WON,g.state.pendingOutcome);
    }
    @Test public void lastLifeIsAvailableToAFlightBulletUntilDeathAnimationEnds(){
        Game g=arena(false);Player p=g.state.players[0];p.lives=0;p.score=19900;Tank t=g.playerTank(0);
        t.deathTimer=0x73;g.addScore(0,100);assertEquals(1,p.lives);
        for(int i=0;i<32;i++)g.step(NONE);assertFalse(p.eliminated);assertEquals(0,p.lives);assertNotNull(g.playerTank(0));assertEquals(-1,g.state.pendingOutcome);
    }
    @Test public void spawnCountdownReturnsOnTheTickItReachesZero(){
        Game g=arena(false);g.state.spawnTimer=1;g.step(NONE);assertEquals(0,g.state.spawned);g.step(NONE);assertEquals(1,g.state.spawned);assertEquals(186,g.state.spawnTimer);
    }
    @Test public void movementSoundUsesHeldDirectionAtWallAndStopsOnRelease(){
        Game g=arena(false);Tank p=g.playerTank(0);p.y=0;
        g.step(new PlayerInput[]{new PlayerInput(true,false,false,false,false)});assertFalse(p.moving);assertEquals(17,EngineSound.cue(g.state));
        g.step(NONE);assertEquals(18,EngineSound.cue(g.state));g.state.demo=true;assertEquals(-1,EngineSound.cue(g.state));
    }
    @Test public void gameOverSkipHonorsRecordAndMusicRunsWithoutAudioHardware(){
        for(boolean record:new boolean[]{false,true}){
            Game g=arena(false);g.state.phase=LOST;g.state.players[0].score=record?20100:19000;
            BattleSession s=new BattleSession(g);s.screen=BattleSession.GAME_OVER;s.skipGameOver();s.step(NONE);
            assertEquals(record?BattleSession.HISCORE:BattleSession.DONE,s.screen);
            if(record){for(int i=0;i<460;i++)s.step(NONE);assertEquals(BattleSession.HISCORE,s.screen);s.step(NONE);assertEquals(BattleSession.DONE,s.screen);}
        }
    }
    @Test public void grenadeCannotKillOrScoreTheSameExplodingTankTwice(){
        Game g=arena(false);Tank t=new Tank();t.id=100;t.team=1;t.enemySlot=0;t.spawnTicks=0;g.state.tanks.add(t);
        g.destroyEnemy(t,-1);g.destroyEnemy(t,0);assertEquals(0,g.state.players[0].score);assertEquals(0,t.deathPoints);
    }
}
