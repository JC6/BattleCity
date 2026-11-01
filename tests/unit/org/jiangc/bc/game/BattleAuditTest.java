package org.jiangc.bc.game;

import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.game.GameState.*;
import org.jiangc.bc.game.GameState.*;
import org.jiangc.bc.input.BattleInput;
import org.jiangc.bc.input.InputHub.Button;

/** Explicit boundary expectations from DB75, E051, E910, E972 and E3A7.
 * Tests never read a reference atlas or use another game implementation as oracle. */
public final class BattleAuditTest {
    private static final PlayerInput NONE=PlayerInput.NONE;
    private static PlayerInput direction(int d,boolean fire){return new PlayerInput(d==0,d==1,d==2,d==3,fire);}
    private Game arena(boolean coop){
        Game g=new Game(new int[676],new int[20],coop,1);g.state.phase=PLAYING;g.state.spawnTimer=100000;
        for(Tank p:g.state.tanks){p.spawnTicks=0;p.shieldTicks=0;}return g;
    }
    private Bullet shot(Game g,int slot,int x,int y,int dir,int speed){
        Bullet b=new Bullet();b.id=100+g.state.bullets.size();b.gunSlot=slot;b.team=slot<2 || slot>=8?0:1;
        b.playerIndex=b.team==0?slot&1:-1;b.x=x;b.y=y;b.direction=dir;b.speed=speed;g.state.bullets.add(b);return b;
    }
    private Tank carrier(Game g){Tank t=new Tank();t.id=80;t.team=1;t.enemySlot=0;t.x=t.y=144;t.spawnTicks=0;t.hp=1;t.carryingPowerUp=true;g.state.tanks.add(t);return t;}
    @Test public void turningAndFireUseTheSameEligibleInputWithoutChangingTheOriginalSkipFrame(){
        for(int phase=0;phase<4;phase++){
            Game g=arena(false);Tank p=g.playerTank(0);p.x=64;p.y=80;g.state.tick=phase;
            BattleInput input=new BattleInput();input.update(0,EnumSet.of(Button.UP),false);
            input.update(0,EnumSet.of(Button.RIGHT,Button.A),true);g.step(input.consume());
            boolean eligible=((phase+1)&3)!=2;
            assertEquals(eligible?1:0,p.direction);assertEquals(eligible?65:64,p.x);
            assertEquals(1,g.state.bullets.size());assertEquals(p.direction,g.state.bullets.get(0).direction);
            assertFalse(input.consume()[0].firePressed());
        }
    }
    @Test public void perpendicularTurnsAlignButReversalsDoNotTeleport(){
        for(int offset=0;offset<8;offset++)for(int from=0;from<4;from++)for(int to=0;to<4;to++){
            Game g=arena(false);Tank p=g.playerTank(0);p.x=64+offset;p.y=80+offset;p.direction=from;
            int x=p.x,y=p.y;
            if((from&1)!=(to&1)){x=(x+4)&~7;y=(y+4)&~7;}
            x+=new int[]{0,1,0,-1}[to];y+=new int[]{-1,0,1,0}[to];
            g.step(new PlayerInput[]{direction(to,false)});assertEquals(x,p.x);assertEquals(y,p.y);assertEquals(to,p.direction);
        }
    }
    @Test public void wallsStopTravelWithoutAddingATurnDelay(){
        Game g=arena(false);Tank p=g.playerTank(0);p.x=64;p.y=80;g.state.tiles[10*26+10]=2;
        g.step(new PlayerInput[]{direction(1,false)});assertEquals(1,p.direction);assertEquals(64,p.x);assertFalse(p.moving);
        g.step(new PlayerInput[]{direction(3,false)});assertEquals(1,p.direction); // original skipped tick 2
        g.step(new PlayerInput[]{direction(3,false)});assertEquals(3,p.direction);assertEquals(63,p.x);
    }
    @Test public void crossingShotsCancelAtBothOriginalSpeedsAndOnAllAxes(){
        for(int direction=0;direction<4;direction++)for(int a:new int[]{2,4})for(int b:new int[]{2,4}){
            Game g=arena(false);int dx=new int[]{0,1,0,-1}[direction],dy=new int[]{-1,0,1,0}[direction];
            shot(g,0,80,80,direction,a);shot(g,2,80+dx*8,80+dy*8,(direction+2)&3,b);
            g.step(new PlayerInput[]{NONE});assertTrue(g.state.bullets.isEmpty());
        }
    }
    @Test public void bulletContactUsesStrictSixPixelBoundsAndPreservesSameOwnerShots(){
        for(int dx:new int[]{5,6})for(int dy:new int[]{5,6}){
            Game g=arena(false);shot(g,0,80,80,1,4);shot(g,2,80+dx,80+dy,3,4);g.resolveBullets();
            assertEquals(dx==5 && dy==5?0:2,g.state.bullets.size());
        }
        for(int[] slots:new int[][]{{0,8},{1,9},{2,3},{0,1}}){
            Game g=arena(false);shot(g,slots[0],80,80,1,4);shot(g,slots[1],82,80,3,4);g.resolveBullets();
            assertEquals(slots[0]==0 && slots[1]==1?0:2,g.state.bullets.size());
        }
    }
    @Test public void originalGunScanCanCancelSeveralNearbyShotsInOneFrame(){
        Game g=arena(false);shot(g,0,80,80,1,4);shot(g,2,82,80,3,4);shot(g,3,83,80,3,4);
        g.resolveBullets();assertTrue(g.state.bullets.isEmpty()); // E962 clears, E969 continues scanning.
    }
    @Test public void terrainHitsResolveBeforeShotCancellation(){
        Game g=arena(false);g.state.tiles[10*26+10]=2;Bullet wall=shot(g,0,84,80,1,4),other=shot(g,2,89,80,3,4);
        g.resolveBullets();assertEquals(9,wall.impactTicks);assertEquals(-1,other.impactTicks);assertEquals(2,g.state.bullets.size());
    }
    @Test public void deadEnemiesCannotAwardTwoKillsForSimultaneousPlayerHits(){
        Game g=arena(true);Tank t=carrier(g);t.carryingPowerUp=false;
        shot(g,0,152,152,0,4);shot(g,1,152,152,0,4);
        // Separate the shots outside their mutual collision box, but inside the tank's contact box.
        g.state.bullets.get(0).x=146;g.state.bullets.get(1).x=158;
        g.resolveBullets();assertEquals(1,g.state.players[1].kills[0]);assertEquals(0,g.state.players[0].kills[0]);
        assertEquals(100,g.state.players[1].score);assertTrue(t.deathTimer>0);
    }
    @Test public void friendlyHitsStunWithoutKillingOrRefreshingAndShieldReleasesTheGun(){
        Game g=arena(true);Tank p=g.playerTank(1);p.x=p.y=80;
        shot(g,0,88,88,1,4);g.resolveBullets();assertEquals(200,p.stunTicks);assertEquals(2,g.state.players[1].lives);
        g.state.bullets.clear();p.stunTicks=100;shot(g,0,88,88,1,4);g.resolveBullets();assertEquals(100,p.stunTicks);
        g.state.bullets.clear();p.shieldTicks=20;shot(g,2,88,88,1,4);g.resolveBullets();assertTrue(g.state.bullets.isEmpty());
        assertEquals(0,p.deathTimer);
    }
    @Test public void itemVisibilityDoesNotGiveUncollectedItemsAnExpiry(){
        Game g=arena(false);g.state.spawned=20;PowerUp item=new PowerUp(3,24,24);g.state.powerUp=item;
        for(int i=0;i<1800;i++)g.step(new PlayerInput[]{NONE});assertSame(item,g.state.powerUp);assertEquals(0,g.state.players[0].score);
    }
    @Test public void onlyBonusCarrierBirthsClearTheBonusSlotIncludingItsPickupPoints(){
        for(int number:new int[]{3,4,10,11,17,18}){
            Game g=arena(false);g.state.spawned=number-1;g.state.spawnTimer=0;PowerUp item=new PowerUp(3,24,24);g.state.powerUp=item;
            Effect score=new Effect();score.value=500;score.remainingTicks=50;g.state.effects.add(score);
            g.step(new PlayerInput[]{NONE});boolean bonus=number==4 || number==11 || number==18;
            assertEquals(number,g.state.spawned);if(bonus)assertNull(g.state.powerUp);else assertSame(item,g.state.powerUp);
            assertEquals(bonus,g.state.effects.isEmpty());
        }
    }
    @Test public void spawningAndExplodingPlayersDoNotExcludeAnOtherwiseValidDrop(){
        for(boolean dying:new boolean[]{false,true}){
            Game g=arena(false);Tank p=g.playerTank(0);p.x=p.y=72;if(dying)p.deathTimer=0x73;else p.spawnTicks=20;
            carrier(g);shot(g,0,152,152,0,4);g.resolveBullets();
            assertNotNull(g.state.powerUp);assertEquals(72,g.state.powerUp.x());assertEquals(72,g.state.powerUp.y());
            assertEquals(100,g.state.players[0].score); // Hit credit, not a pickup.
        }
    }
    @Test public void randomDropsNeverAutoCollectAndAreLimitedToTheSixteenNativePositions(){
        for(int seed=1;seed<=512;seed++){
            Game g=arena(true);g.state.rng=seed;g.state.freezeTicks=10000;g.playerTank(0).x=g.playerTank(0).y=72;g.playerTank(1).x=120;g.playerTank(1).y=72;
            carrier(g);shot(g,0,152,152,0,4);List<GameEvent> events=g.step(new PlayerInput[]{NONE,NONE});
            PowerUp item=g.state.powerUp;assertNotNull("seed "+seed,item);assertEquals(0,(item.x()-24)%48);assertEquals(0,(item.y()-24)%48);
            assertTrue(item.x()>=24 && item.x()<=168 && item.y()>=24 && item.y()<=168);
            assertFalse(events.stream().anyMatch(e->e.type.equals("powerup") && e.action.equals("pickup")));
        }
    }
    @Test public void pickupUsesStrictTwelvePixelBoundsAndOnlyAwardsOnce(){
        Game g=arena(false);Tank p=g.playerTank(0);p.x=p.y=80;g.state.powerUp=new PowerUp(3,92,80);
        g.collectPowerUp();assertNotNull(g.state.powerUp);g.state.powerUp=new PowerUp(3,91,80);g.collectPowerUp();g.collectPowerUp();
        assertNull(g.state.powerUp);assertEquals(500,g.state.players[0].score);assertEquals(1,p.stars);
        assertEquals(1,g.state.effects.size());assertEquals(50,g.state.effects.get(0).remainingTicks);
    }
    @Test public void aNewDropReplacesOldPickupPointsWithoutChangingEnemyScore(){
        Game g=arena(false);g.state.powerUp=new PowerUp(3,64,192);g.collectPowerUp();assertEquals(1,g.state.effects.size());
        carrier(g);shot(g,0,152,152,0,4);g.resolveBullets();assertTrue(g.state.effects.isEmpty());assertNotNull(g.state.powerUp);
        assertEquals(600,g.state.players[0].score);
    }
}
