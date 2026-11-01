package org.jiangc.bc.game;

import org.junit.Test;
import static org.junit.Assert.*;
import static org.jiangc.bc.game.GameState.*;

public final class GameMemoryTest {
    private static final PlayerInput[] NONE={PlayerInput.NONE,PlayerInput.NONE};
    private Campaign campaign(GameMemory memory,boolean coop) throws Exception {
        return new Campaign(LevelCatalogTest.catalog(),coop,()->123,1,memory.customTiles(),memory);
    }
    private void lose(Campaign campaign,int first,int second){
        BattleSession session=campaign.session();session.game.state.phase=LOST;
        session.game.state.players[0].score=first;
        if(session.game.state.players.length>1)session.game.state.players[1].score=second;
        session.screen=BattleSession.SCORE;session.elapsed=session.scoreCompletion()-1;campaign.step(NONE);
    }
    @Test public void recordsCommitAfterGameOverAndNewRecordRunsExactly461Ticks() throws Exception {
        GameMemory memory=new GameMemory();ConstructionState draft=new ConstructionState();draft.press(1);memory.saveConstruction(draft);
        Campaign campaign=campaign(memory,true);lose(campaign,21000,35000);BattleSession session=campaign.session();
        assertNull(memory.customTiles());assertEquals(20000,memory.highScore());assertEquals(20000,session.highScore);
        for(int i=0;i<108;i++)campaign.step(NONE);assertEquals(20000,memory.highScore());
        campaign.step(NONE);assertEquals(BattleSession.HISCORE,session.screen);assertEquals(35000,memory.highScore());
        assertArrayEquals(new int[]{21000,35000},memory.lastScores());
        for(int i=0;i<460;i++)campaign.step(NONE);assertEquals(BattleSession.HISCORE,session.screen);
        campaign.step(NONE);assertEquals(BattleSession.DONE,session.screen);
        session.game.state.players[0].score=90000;for(int i=0;i<20;i++)campaign.step(NONE);assertEquals(35000,memory.highScore());
        assertEquals(35000,campaign(memory,false).session().highScore);
        assertEquals(20000,new GameMemory().highScore());
    }
    @Test public void equalOrLowerScoresDoNotCelebrateAndAbortedRunsDoNotCommit() throws Exception {
        for(int score:new int[]{0,19900,20000}){
            GameMemory memory=new GameMemory();Campaign campaign=campaign(memory,false);lose(campaign,score,0);
            for(int i=0;i<109;i++)campaign.step(NONE);
            assertEquals(BattleSession.DONE,campaign.session().screen);assertEquals(20000,memory.highScore());
            int[] snapshot=memory.lastScores();snapshot[0]=99999;assertEquals(score,memory.lastScores()[0]);
            Campaign abandoned=campaign(memory,false);abandoned.session().game.state.players[0].score=50000;
            assertEquals(20000,campaign(memory,false).session().highScore);
        }
    }
    @Test public void constructionSurvivesMenuAndAbandonButSnapshotsDoNotMutateMemory() throws Exception {
        GameMemory memory=new GameMemory();assertNull(memory.customTiles());
        ConstructionState state=memory.construction();state.press(1);memory.saveConstruction(state);
        int[] draft=memory.customTiles();state.press(1);assertArrayEquals(draft,memory.customTiles());
        ConstructionState reopened=memory.construction();assertEquals(0,reopened.x());assertEquals(0,reopened.code());
        campaign(memory,false).session().game.state.tiles[1]=0;assertArrayEquals(draft,memory.customTiles());
        draft[1]=5;assertEquals(1,memory.customTiles()[1]);memory.clearConstruction();assertNull(memory.customTiles());
    }
    @Test public void completedReturnIsConsumedOnceAndRemembersLastPlayerCount(){
        GameMemory m=new GameMemory();assertFalse(m.lastCoop());assertFalse(m.takeCompletedGame());
        Game g=new Game(new int[676],new int[20],true,1);m.finishGame(g.state);assertTrue(m.lastCoop());assertTrue(m.takeCompletedGame());assertFalse(m.takeCompletedGame());
        m.finishGame(new Game(new int[676],new int[20],false,1).state);assertFalse(m.lastCoop());
    }
}
