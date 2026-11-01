package org.jiangc.bc.game;

import java.util.List;
import java.util.function.IntSupplier;

/** Engine-thread campaign clock. Pause remains external: do not call step. */
public final class Campaign {
    private final LevelCatalog levels;
    private final boolean coop;
    private final IntSupplier seeds;
    private final GameMemory memory;
    private BattleSession session;

    public Campaign(LevelCatalog levels,boolean coop,IntSupplier seeds,int stage,int[] customTiles,GameMemory memory) {
        if(stage<1 || stage>35)throw new IllegalArgumentException("Starting stage must be 1..35");
        this.levels=levels;this.coop=coop;this.seeds=seeds;this.memory=memory;
        Level initial=levels.level(stage);
        if(customTiles!=null){
            if(customTiles.length!=676)throw new IllegalArgumentException("Invalid construction size");
            int[] tiles=customTiles.clone();
            for(int cell:new int[]{636,637,662,663})tiles[cell]=0;
            initial=new Level(tiles,initial.enemies());
        }
        session=new BattleSession(initial.start(coop,stage,seeds.getAsInt(),null),memory.highScore());
        if(customTiles!=null)session.game.state.introTicks-=GameState.MAP_FRAMES;
    }
    public BattleSession session() { return session; }
    public void skipGameOver(){session.skipGameOver();}
    private void start(int stage,PlayerCarry[] players) {
        int normalized=LevelCatalog.normalize(stage);
        session=new BattleSession(levels.level(normalized).start(coop,normalized,seeds.getAsInt(),players),memory.highScore());
    }
    public List<GameEvent> step(PlayerInput[] input) {
        int before=session.screen;
        List<GameEvent> events=session.step(input);
        if(before==BattleSession.SCORE && session.screen==BattleSession.GAME_OVER)memory.clearConstruction();
        if(before==BattleSession.GAME_OVER && session.screen!=before)memory.finishGame(session.game.state);
        if(session.screen==BattleSession.DONE && session.game.state.phase==GameState.WON) {
            GameState finished=session.game.state;
            start(finished.stage+1,PlayerCarry.capture(finished));
        }
        return events;
    }
}
