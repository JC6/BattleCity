package org.jiangc.bc.game;

/** Application-process lifetime only: no preferences, files, or Android dependencies. */
public final class GameMemory {
    private int highScore=20000,constructionReturns;
    private int[] lastScores={0,0};
    private ConstructionState draft;
    private boolean completedGame,lastCoop;
    public synchronized int highScore(){return highScore;}
    public synchronized int[] lastScores(){return lastScores.clone();}
    public synchronized void finishGame(GameState state){
        lastScores=new int[2];completedGame=true;lastCoop=state.players.length==2;
        for(GameState.Player player:state.players){lastScores[player.index]=player.score;highScore=Math.max(highScore,player.score);}
    }
    public synchronized boolean lastCoop(){return lastCoop;}
    public synchronized boolean takeCompletedGame(){boolean result=completedGame;completedGame=false;return result;}
    public synchronized void resetConstructionField(){draft=ConstructionState.emptyField();}
    public synchronized ConstructionState construction(){return draft==null?new ConstructionState():draft.copy();}
    public synchronized void saveConstruction(ConstructionState state){draft=state.copy();}
    public synchronized int[] customTiles(){return draft==null?null:draft.tiles();}
    public synchronized int constructionReturns(){return constructionReturns;}
    public synchronized void finishConstruction(){constructionReturns=(constructionReturns+1)&255;}
    public synchronized void clearConstruction(){draft=null;constructionReturns=0;}
}
