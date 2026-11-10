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
    private Tank spawn(Game g,int number,int kind){
        g.state.enemyQueue[number-1]=kind;g.state.spawned=number-1;g.state.spawnTimer=0;g.state.freezeTicks=100000;g.step(NONE);
        return g.state.tanks.stream().filter(t->t.team==1).reduce((a,b)->b).orElseThrow();
    }
    private void finishSpawning(Game g,Tank tank){for(int i=0;i<64 && tank.spawnTicks>0;i++)g.step(NONE);assertTrue(tank.active());}
    @Test public void realSpawnPreservesKindHealthAcrossBonusBoundaries(){
        // E3F4–E402: bonus flag and armor count occupy independent state bits.
        for(int kind=0;kind<4;kind++)for(int number:new int[]{3,4,5,10,11,12,17,18,19}){
            Game g=arena(false);PowerUp item=new PowerUp(3,24,24);g.state.powerUp=item;
            Effect points=new Effect();points.value=500;points.remainingTicks=50;g.state.effects.add(points);
            Tank tank=spawn(g,number,kind);boolean carrier=number==4 || number==11 || number==18;
            assertEquals(kind==3?4:1,tank.hp);assertEquals(carrier,tank.carryingPowerUp);
            assertEquals(28,tank.spawnTicks);assertEquals(number,g.state.spawned);
            assertSame(carrier?null:item,g.state.powerUp);assertEquals(carrier?0:1,g.state.effects.size());
        }
    }
    @Test public void realArmoredCarrierDropsOnceAndCreditsOnlyTheFourthHit(){
        // E7D1–E7F2: first hit drops the bonus and leaves three armor hits.
        for(boolean coop:new boolean[]{false,true})for(boolean steel:new boolean[]{false,true})for(int shooter=0;shooter<(coop?2:1);shooter++){
            Game g=arena(coop);Tank tank=spawn(g,4,3);finishSpawning(g,tank);int drops=0;PowerUp item=null;
            for(int hit=1;hit<=4;hit++){
                g.state.bullets.clear();Bullet b=new Bullet();b.id=100+hit;b.gunSlot=shooter;b.playerIndex=shooter;
                b.x=tank.x+8;b.y=tank.y+8;b.speed=steel?4:2;b.steelPower=steel;g.state.bullets.add(b);
                List<GameEvent> events=g.step(NONE);drops+=events.stream().filter(e->e.type.equals("powerup") && e.action.equals("appear")).count();
                assertEquals(4-hit,tank.hp);assertFalse(tank.carryingPowerUp);assertEquals(hit==4,tank.deathTimer>0);
                if(hit==1){item=g.state.powerUp;assertNotNull(item);}else assertSame(item,g.state.powerUp);
                for(int p=0;p<g.state.players.length;p++){
                    assertEquals(hit==4 && p==shooter?400:0,g.state.players[p].score);
                    assertEquals(hit==4 && p==shooter?1:0,g.state.players[p].kills[3]);
                }
                assertEquals(hit==4?400:0,tank.deathPoints);assertEquals(0,g.state.killed);
            }
            assertEquals(1,drops);for(int i=0;i<96;i++)g.step(NONE);assertEquals(1,g.state.killed);
        }
    }
    @Test public void grenadeDestroysBornCarrierWithoutDropOrKillCreditAndProtectsBirth(){
        Game g=arena(false);Tank active=spawn(g,4,3);finishSpawning(g,active);Tank birth=spawn(g,11,3);
        assertTrue(active.carryingPowerUp);assertTrue(birth.carryingPowerUp);assertEquals(28,birth.spawnTicks);
        Tank player=g.playerTank(0);g.state.powerUp=new PowerUp(4,player.x,player.y);
        List<GameEvent> events=g.step(NONE);
        assertTrue(active.deathTimer>0);assertEquals(0,active.deathPoints);assertEquals(0,birth.deathTimer);assertEquals(4,birth.hp);
        assertNull(g.state.powerUp);assertEquals(500,g.state.players[0].score);assertArrayEquals(new int[4],g.state.players[0].kills);
        assertEquals(0,events.stream().filter(e->e.type.equals("powerup") && e.action.equals("appear")).count());
    }
    @Test public void sevenDigitScoreDiscardsCarryWithoutRearmingTheFirstScoreLife(){
        for(int amount:new int[]{100,400,500,1000}){
            Game g=arena(false);Player p=g.state.players[0];p.score=19900;int lives=p.lives;
            assertNotNull(g.addScore(0,100));assertEquals(lives+1,p.lives);assertEquals(-1,p.nextExtraLife);
            p.score=9999900;assertNull(g.addScore(0,amount));assertEquals(amount-100,p.score);
            assertNull(g.addScore(0,20000-p.score));assertEquals(20000,p.score);assertEquals(lives+1,p.lives);assertEquals(-1,p.nextExtraLife);
        }
    }
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
