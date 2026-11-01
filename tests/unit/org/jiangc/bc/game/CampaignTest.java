package org.jiangc.bc.game;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.game.GameState.*;

public final class CampaignTest {
    private static final PlayerInput[] NONE={PlayerInput.NONE,PlayerInput.NONE};
    private Campaign campaign(boolean coop) throws Exception { return new Campaign(LevelCatalogTest.catalog(),coop,()->123,1,null,new GameMemory()); }
    private void score(Campaign campaign) {
        BattleSession session=campaign.session();session.game.state.phase=WON;
        session.screen=BattleSession.SCORE;session.elapsed=0;
    }
    private void finishScore(Campaign campaign) {
        BattleSession session=campaign.session();
        int remaining=session.scoreCompletion()-session.elapsed;
        for(int i=0;i<remaining;i++)campaign.step(NONE);
    }
    private void win(Campaign campaign) { score(campaign);finishScore(campaign); }

    @Test public void scoreCompletesBeforeAutomaticAdvanceAndCarriesBothPlayers() throws Exception {
        Campaign campaign=campaign(true);BattleSession previous=campaign.session();
        Player first=previous.game.state.players[0],second=previous.game.state.players[1];
        first.score=23400;first.lives=0;first.stars=3;first.nextExtraLife=-1;first.kills[0]=12;
        second.score=1200;second.lives=4;second.stars=1;second.kills[1]=8;

        score(campaign);
        for(int i=0;i<previous.scoreCompletion()-1;i++)campaign.step(NONE);
        assertSame(previous,campaign.session());assertEquals(BattleSession.SCORE,previous.screen);
        PlayerCarry[] expected=PlayerCarry.capture(previous.game.state);
        assertEquals(24400,expected[0].score());
        campaign.step(NONE);
        assertNotSame(previous,campaign.session());assertEquals(2,campaign.session().game.state.stage);
        assertArrayEquals(expected,PlayerCarry.capture(campaign.session().game.state));
        assertEquals(3,campaign.session().game.playerTank(0).stars);
        assertEquals(1,campaign.session().game.playerTank(1).stars);
        assertEquals(0,campaign.session().game.state.tick);
    }
    @Test public void newStageResetsTransientStateAndLeavesResultUntouched() throws Exception {
        Campaign campaign=campaign(false);GameState old=campaign.session().game.state;
        Arrays.fill(old.tiles,5);Arrays.fill(old.brickMasks,0);old.killed=20;old.spawned=20;
        old.freezeTicks=300;old.fortifyTicks=600;old.spawnTimer=99;old.tick=5000;
        old.powerUp=new PowerUp(3,64,100);old.bullets.add(new Bullet());old.effects.add(new Effect());
        old.players[0].kills[3]=20;old.players[0].respawnTicks=20;
        score(campaign);String result=StateSnapshot.canonical(old,List.of());finishScore(campaign);
        Game game=campaign.session().game;GameState next=game.state;
        assertEquals(result,StateSnapshot.canonical(old,List.of()));
        assertEquals(INTRO,next.phase);assertEquals(96,next.introTicks);assertEquals(-1,next.pendingOutcome);
        assertEquals(0,next.tick);assertEquals(0,next.spawned);assertEquals(0,next.killed);assertEquals(0,next.spawnTimer);
        assertEquals(0,next.freezeTicks);assertEquals(0,next.fortifyTicks);assertEquals(0,next.outroTicks);
        assertNull(next.powerUp);assertTrue(next.bullets.isEmpty());assertTrue(next.effects.isEmpty());assertTrue(next.baseAlive);
        assertArrayEquals(new int[4],next.players[0].kills);assertEquals(0,next.players[0].respawnTicks);
        assertEquals(1,next.tanks.size());assertEquals(28,game.playerTank(0).spawnTicks);
        Game expected=LevelCatalogTest.catalog().level(2).start(false,2,123,null);
        assertArrayEquals(expected.state.tiles,next.tiles);assertArrayEquals(expected.state.brickMasks,next.brickMasks);
        assertArrayEquals(expected.state.enemyQueue,next.enemyQueue);
    }
    @Test public void eliminatedPlayerStaysOutUntilAnEarnedRevival() throws Exception {
        Campaign campaign=campaign(true);Game first=campaign.session().game;
        first.state.players[0].lives=0;first.state.players[0].eliminated=true;
        first.state.tanks.remove(first.playerTank(0));win(campaign);
        Game next=campaign.session().game;
        assertTrue(next.state.players[0].eliminated);assertNull(next.playerTank(0));assertNotNull(next.playerTank(1));
        assertEquals(0,next.state.players[0].respawnTicks);
        next.addScore(0,20000);assertFalse(next.state.players[0].eliminated);
        assertEquals(1,next.state.players[0].respawnTicks);win(campaign);
        Game revived=campaign.session().game;
        assertNotNull(revived.playerTank(0));assertEquals(0,revived.state.players[0].lives);
        assertEquals(-1,revived.state.players[0].nextExtraLife);
    }
    @Test public void coopBonusAndScoreLifeAreCarriedWithoutBeingAwardedAgain() throws Exception {
        Campaign campaign=campaign(true);Game game=campaign.session().game;
        game.state.phase=PLAYING;game.state.spawnTimer=10000;game.state.killed=20;
        game.state.players[0].score=19500;game.state.players[0].kills[0]=12;game.state.players[1].kills[0]=8;
        for(int i=0;i<129;i++)campaign.step(NONE);
        assertEquals(BattleSession.SCORE,campaign.session().screen);
        assertEquals(19500,game.state.players[0].score);assertEquals(2,game.state.players[0].lives);
        finishScore(campaign);Game next=campaign.session().game;
        assertEquals(20500,next.state.players[0].score);assertEquals(3,next.state.players[0].lives);
        assertEquals(-1,next.state.players[0].nextExtraLife);
        next.addScore(0,20000);assertEquals(3,next.state.players[0].lives);
        win(campaign);assertEquals(40500,campaign.session().game.state.players[0].score);
    }
    @Test public void seventyWinsReturnToStageOneWithProgressAndFreshSeeds() throws Exception {
        LevelCatalog levels=LevelCatalogTest.catalog();
        for(boolean coop:new boolean[]{false,true}) {
            AtomicInteger seeds=new AtomicInteger(100);Campaign campaign=new Campaign(levels,coop,seeds::getAndIncrement,1,null,new GameMemory());
            campaign.session().game.state.players[0].score=23400;
            campaign.session().game.state.players[0].lives=1;
            campaign.session().game.state.players[0].stars=3;
            campaign.session().game.state.players[0].nextExtraLife=-1;
            for(int stage=1;stage<=70;stage++) {
                assertEquals(stage,campaign.session().game.state.stage);win(campaign);
                GameState state=campaign.session().game.state;
                int nextStage=stage==70?1:stage+1;
                assertEquals(nextStage,state.stage);assertEquals(100+stage,state.rng);
                assertEquals(23400,state.players[0].score);assertEquals(1,state.players[0].lives);
                assertEquals(3,state.players[0].stars);assertEquals(-1,state.players[0].nextExtraLife);
                Game expected=levels.level(nextStage).start(coop,nextStage,1,null);
                assertArrayEquals(expected.state.tiles,state.tiles);assertArrayEquals(expected.state.enemyQueue,state.enemyQueue);
            }
            assertEquals(171,seeds.get());
        }
    }
    @Test public void lossStopsTheCampaignAndNewGameRestoresInitialState() throws Exception {
        LevelCatalog levels=LevelCatalogTest.catalog();GameMemory memory=new GameMemory();
        AtomicInteger seeds=new AtomicInteger(10);Campaign campaign=new Campaign(levels,true,seeds::getAndIncrement,1,null,memory);
        win(campaign);BattleSession lost=campaign.session();GameState state=lost.game.state;
        state.phase=PLAYING;state.baseAlive=false;state.players[0].score=12300;state.players[0].lives=0;state.players[0].stars=3;
        for(int i=0;i<257;i++)campaign.step(NONE);
        assertEquals(BattleSession.SCORE,lost.screen);assertEquals(2,lost.game.state.stage);
        assertEquals(BattleSession.SCORE,lost.screen);finishScore(campaign);
        assertEquals(BattleSession.GAME_OVER,lost.screen);
        for(int i=0;i<200;i++)campaign.step(NONE);
        assertSame(lost,campaign.session());assertEquals(BattleSession.DONE,lost.screen);assertEquals(12,seeds.get());
        for(int i=0;i<10;i++)campaign.step(NONE);
        assertSame(lost,campaign.session());assertEquals(BattleSession.DONE,lost.screen);assertEquals(12,seeds.get());
        assertArrayEquals(new int[]{12300,0},memory.lastScores());assertEquals(20000,memory.highScore());
        Campaign next=new Campaign(levels,true,seeds::getAndIncrement,1,memory.customTiles(),memory);
        GameState fresh=next.session().game.state;
        assertNotSame(lost,next.session());assertSame(lost,campaign.session());assertEquals(13,seeds.get());
        assertEquals(1,fresh.stage);assertEquals(INTRO,fresh.phase);assertEquals(12,fresh.rng);
        assertEquals(2,fresh.players.length);assertTrue(fresh.baseAlive);
        assertArrayEquals(levels.level(1).start(true,1,12,null).state.tiles,fresh.tiles);
        assertArrayEquals(new int[]{12300,0},memory.lastScores());assertEquals(20000,memory.highScore());
        for(Player player:fresh.players) {
            assertEquals(0,player.score);assertEquals(2,player.lives);assertEquals(0,player.stars);
            assertEquals(20000,player.nextExtraLife);assertFalse(player.eliminated);
        }
    }
    @Test public void selectedStageStartsFreshAndCustomMapIsUsedOnlyOnce() throws Exception {
        LevelCatalog levels=LevelCatalogTest.catalog();GameMemory memory=new GameMemory();
        ConstructionState construction=new ConstructionState();construction.press(1);memory.saveConstruction(construction);
        int[] draft=memory.customTiles();draft[636]=2;draft[637]=2;draft[662]=2;draft[663]=2;draft[609]=0;
        AtomicInteger seeds=new AtomicInteger(100);
        Campaign campaign=new Campaign(levels,true,seeds::getAndIncrement,35,draft,memory);
        GameState first=campaign.session().game.state;
        assertEquals(35,first.stage);assertEquals(100,first.rng);assertEquals(101,seeds.get());
        assertEquals(1,first.tiles[1]);assertEquals(0,first.tiles[609]);
        for(int index:new int[]{636,637,662,663})assertEquals(0,first.tiles[index]);
        assertArrayEquals(levels.level(35).enemies(),first.enemyQueue);
        assertEquals(0,first.players[0].score);assertEquals(2,first.players[0].lives);
        first.players[0].score=12300;first.players[0].stars=2;first.players[1].lives=1;
        first.tiles[1]=0;assertEquals(1,draft[1]);win(campaign);
        GameState next=campaign.session().game.state;
        assertEquals(36,next.stage);assertEquals(12300,next.players[0].score);assertEquals(2,next.players[0].stars);assertEquals(1,next.players[1].lives);
        assertArrayEquals(levels.level(36).start(true,36,123,null).state.tiles,next.tiles);
        assertEquals(1,memory.customTiles()[1]);
    }
    @Test public void allSelectableStagesUseTheirOwnEnemyQueueAndInvalidChoicesFail() throws Exception {
        LevelCatalog levels=LevelCatalogTest.catalog();
        for(int stage=1;stage<=35;stage++)for(boolean coop:new boolean[]{false,true}){
            Campaign campaign=new Campaign(levels,coop,()->42,stage,null,new GameMemory());
            assertEquals(stage,campaign.session().game.state.stage);
            assertArrayEquals(levels.level(stage).enemies(),campaign.session().game.state.enemyQueue);
        }
        for(int stage:new int[]{0,36})assertThrows(IllegalArgumentException.class,()->new Campaign(levels,false,()->1,stage,null,new GameMemory()));
    }
}
