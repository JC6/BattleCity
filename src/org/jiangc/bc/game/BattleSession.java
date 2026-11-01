package org.jiangc.bc.game;

import java.util.List;
import java.util.ArrayList;
import java.util.Arrays;
import org.jiangc.bc.audio.ApuDriver;

/** Single-stage presentation clock. Pause is external: simply do not step this session. */
public final class BattleSession {
    public static final int BATTLE=0,SCORE=1,GAME_OVER=2,DONE=3,HISCORE=4;
    public final Game game;
    public int screen=BATTLE,elapsed;
    public int highScore;
    public int bonusPlayer=-1;
    private boolean bonusChecked,skipRequested;
    private int musicScreen=-1;
    private final ApuDriver music=new ApuDriver((c,r,v)->{});
    public void skipGameOver(){if(screen==GAME_OVER)skipRequested=true;}
    public BattleSession(Game game){this(game,20000);}
    public BattleSession(Game game,int highScore){this.game=game;this.highScore=highScore;}
    public List<GameEvent> step(PlayerInput[] input) {
        if(screen==BATTLE){
            List<GameEvent> events=game.step(input);
            if(game.state.phase==GameState.LOST || game.state.phase==GameState.WON){screen=SCORE;elapsed=0;}
            return events;
        }
        elapsed++;
        if(screen==GAME_OVER || screen==HISCORE){
            if(musicScreen!=screen){music.reset();music.trigger(screen==GAME_OVER?24:21);musicScreen=screen;}
            music.tick();
        }
        List<GameEvent> result=new ArrayList<>();
        if(screen==SCORE && !bonusChecked && elapsed>=bonusAt()){
            bonusChecked=true;bonusPlayer=eligibleBonusPlayer();
            if(bonusPlayer>=0){
                GameEvent life=game.addScore(bonusPlayer,1000);if(life!=null)result.add(life);
                GameEvent e=new GameEvent("score-bonus");e.playerIndex=bonusPlayer;result.add(e);
            }
        }
        if(screen==SCORE && elapsed>=scoreCompletion()) {screen=game.state.phase==GameState.LOST?GAME_OVER:DONE;elapsed=0;}
        else if(screen==GAME_OVER && (skipRequested || !music.active(24))){
            int best=highScore;for(GameState.Player player:game.state.players)best=Math.max(best,player.score);
            screen=best>highScore?HISCORE:DONE;highScore=best;elapsed=0;
        }
        else if(screen==HISCORE && !music.active(21)){screen=DONE;elapsed=0;}
        return List.copyOf(result);
    }
    // CCD4–CEE7: 30-frame lead; one row setup, nine frames per count,
    // one final zero/finished iteration, 20 between rows, 30 before TOTAL,
    // 15 before BONUS, then 120 before leaving the score screen.
    private int rowStart(int row){int start=31;for(int r=0;r<row;r++)start+=9*(maxKills(r)+1)+(r<3?21:30);return start;}
    private int maxKills(int row){int max=0;for(GameState.Player p:game.state.players)max=Math.max(max,p.kills[row]);return max;}
    public int count(int row,int player){int start=rowStart(row);return elapsed<start?-1:Math.min(game.state.players[player].kills[row],1+(elapsed-start)/9);}
    public int cueCount(){int count=0;for(int r=0;r<4;r++)if(elapsed>=rowStart(r))count+=Math.min(maxKills(r),1+(elapsed-rowStart(r))/9);return count;}
    public boolean totalVisible(){return elapsed>=rowStart(4);}
    public int bonusAt(){return rowStart(4)+15;}
    public int scoreCompletion(){return bonusAt()+120;}
    private int eligibleBonusPlayer(){
        if(game.state.phase!=GameState.WON || game.state.players.length!=2)return -1;
        int a=Arrays.stream(game.state.players[0].kills).sum(),b=Arrays.stream(game.state.players[1].kills).sum();
        if(a==b)return -1;int winner=a>b?0:1;
        return game.state.players[winner].eliminated?-1:winner;
    }
}
