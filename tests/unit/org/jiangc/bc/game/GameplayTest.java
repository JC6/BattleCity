package org.jiangc.bc.game;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.List;
import org.jiangc.bc.game.GameState.*;
import static org.jiangc.bc.game.GameState.*;

public final class GameplayTest {
    private Game arena(boolean coop){Game g=new Game(new int[676],new int[20],coop,1);g.state.phase=PLAYING;g.state.spawnTimer=10000;for(Tank t:g.state.tanks){t.spawnTicks=0;t.shieldTicks=0;}return g;}
    private void step(Game g){g.step(new PlayerInput[]{PlayerInput.NONE,PlayerInput.NONE});}
    private Bullet shot(Game g,int team,int player,int x,int y){Bullet b=new Bullet();b.id=999;b.team=team;b.playerIndex=player;b.gunSlot=team==0?player:2;b.x=x;b.y=y;b.speed=4;g.state.bullets.add(b);return b;}
    @Test public void friendlyFireStunsButDoesNotKillAndShieldConsumesShot(){
        Game g=arena(true);Tank p=g.playerTank(1);p.x=128;p.y=100;shot(g,0,0,136,108);g.resolveBullets();
        assertEquals(200,p.stunTicks);assertEquals(2,g.state.players[1].lives);assertTrue(g.state.tanks.contains(p));
        g.state.bullets.clear();p.shieldTicks=50;p.stunTicks=0;shot(g,1,-1,136,108);g.resolveBullets();
        assertTrue(g.state.bullets.isEmpty());assertEquals(0,p.stunTicks);assertTrue(g.state.tanks.contains(p));
    }
    @Test public void brickHitRemovesOnlyItsEntryQuadrantsAndTripleStarBreaksSteel(){
        Game g=arena(false);int i=10*26+10;g.state.tiles[i]=1;g.state.brickMasks[i]=15;
        Bullet b=shot(g,0,0,84,87);g.resolveBullets();assertEquals(3,g.state.brickMasks[i]);assertEquals(1,g.state.tiles[i]);
        g.state.bullets.clear();g.state.tiles[i]=2;b=shot(g,0,0,84,87);g.resolveBullets();assertEquals(2,g.state.tiles[i]);
        g.state.bullets.clear();b=shot(g,0,0,84,87);b.steelPower=true;g.resolveBullets();assertEquals(0,g.state.tiles[i]);
    }
    @Test public void opposingShotsCancelAndUpgradedPrimaryUsesSecondarySlot(){
        Game g=arena(false);Bullet a=shot(g,0,0,40,40),b=shot(g,1,-1,42,40);b.id=998;g.resolveBullets();assertTrue(g.state.bullets.isEmpty());
        Tank p=g.playerTank(0);p.stars=2;g.fire(p);g.fire(p);g.fire(p);assertEquals(2,g.state.bullets.size());
        assertEquals(8,g.state.bullets.get(0).gunSlot);assertEquals(0,g.state.bullets.get(1).gunSlot);assertEquals(4,g.state.bullets.get(1).speed);
    }
    @Test public void threeDeathsConsumeSparesThenEliminateWithoutRevivalAfterGameOver(){
        Game g=arena(false);
        for(int death=0;death<3;death++){
            Tank p=g.playerTank(0);p.spawnTicks=0;p.shieldTicks=0;g.state.bullets.clear();shot(g,1,-1,p.x+8,p.y+8);g.resolveBullets();
            assertNull(g.playerTank(0));for(int t=0;t<40 && !g.state.players[0].eliminated && g.playerTank(0)==null;t++)step(g);
        }
        assertTrue(g.state.players[0].eliminated);g.addScore(0,20000);assertTrue(g.state.players[0].eliminated);assertEquals(0,g.state.players[0].respawnTicks);
        int lives=g.state.players[0].lives;g.addScore(0,40000);assertEquals(lives,g.state.players[0].lives);
    }
    @Test public void allSixItemsApplyWithPlayerTwoPickupPriority(){
        for(int kind=0;kind<6;kind++){
            Game g=arena(true);Tank p=g.playerTank(1);g.playerTank(0).x=p.x;p.y=g.playerTank(0).y;
            Tank enemy=new Tank();enemy.id=100;enemy.team=1;enemy.enemySlot=5;enemy.spawnTicks=0;enemy.x=16;enemy.y=16;enemy.carryingPowerUp=true;g.state.tanks.add(enemy);
            Tank spawning=new Tank();spawning.id=101;spawning.team=1;spawning.enemySlot=4;g.state.tanks.add(spawning);
            g.state.tick=63;g.state.powerUp=new PowerUp(kind,p.x,p.y);g.collectPowerUp();assertNull(g.state.powerUp);
            assertEquals(0,g.state.players[0].score);assertEquals(500,g.state.players[1].score);
            switch(kind){case 0:assertEquals(577,p.shieldTicks);break;case 1:assertEquals(577,g.state.freezeTicks);break;
                case 2:assertEquals(1217,g.state.fortifyTicks);assertEquals(2,g.state.tiles[609]);break;
                case 3:assertEquals(1,p.stars);break;case 4:assertTrue(enemy.deathTimer>0);assertTrue(g.state.tanks.contains(spawning));assertEquals(0,g.state.killed);assertEquals(0,Arrays.stream(g.state.players[1].kills).sum());break;
                case 5:assertEquals(3,g.state.players[1].lives);break;default:fail();}
        }
    }
    @Test public void lossOverridesPendingWinWithoutCoopBonus(){
        Game g=arena(true);g.state.killed=20;g.state.players[0].kills[0]=12;g.state.players[1].kills[0]=8;step(g);assertEquals(WON,g.state.pendingOutcome);assertEquals(128,g.state.outroTicks);
        g.state.baseAlive=false;step(g);assertEquals(LOST,g.state.pendingOutcome);for(int i=0;i<127;i++)step(g);
        assertEquals(LOST,g.state.phase);assertEquals(0,g.state.players[0].score);step(g);assertEquals(0,g.state.players[0].score);
    }
    @Test public void lossKeepsOneWorldAndScoreWaitsForEveryCount(){
        Game g=arena(true);g.state.baseAlive=false;g.state.players[0].kills[0]=18;g.state.players[1].kills[1]=2;
        BattleSession session=new BattleSession(g);session.step(new PlayerInput[0]);
        assertEquals(256,g.state.outroTicks);
        for(int i=0;i<255;i++)session.step(new PlayerInput[0]);assertEquals(BattleSession.BATTLE,session.screen);
        session.step(new PlayerInput[0]);assertEquals(BattleSession.SCORE,session.screen);
        String finalState=StateSnapshot.canonical(g.state,List.of());
        int duration=session.scoreCompletion();assertEquals(475,duration);
        for(int i=0;i<duration-1;i++)session.step(new PlayerInput[0]);assertEquals(BattleSession.SCORE,session.screen);
        assertEquals(finalState,StateSnapshot.canonical(g.state,List.of()));
        session.step(new PlayerInput[0]);assertEquals(BattleSession.GAME_OVER,session.screen);
        for(int i=0;i<109;i++)session.step(new PlayerInput[0]);assertEquals(BattleSession.DONE,session.screen);
    }
    @Test public void turningCannotSnapThroughWallAndExistingSpawnOverlapCanEscape(){
        Game g=arena(true);Tank p=g.playerTank(0),other=g.playerTank(1);p.x=64;p.y=80;other.x=64;other.y=80;
        assertTrue(g.canOccupy(p,63,80));other.x=48;assertFalse(g.canOccupy(p,63,80));
        g.state.tiles[10*26+7]=2;assertFalse(g.canOccupy(p,63,80));
    }
}
