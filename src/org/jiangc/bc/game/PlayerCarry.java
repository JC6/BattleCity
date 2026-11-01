package org.jiangc.bc.game;

/** Only these player values survive a stage boundary. */
public record PlayerCarry(int score, int lives, int stars, int nextExtraLife, boolean eliminated) {
    public static PlayerCarry[] capture(GameState state) {
        PlayerCarry[] result=new PlayerCarry[state.players.length];
        for(int i=0;i<result.length;i++) {
            GameState.Player p=state.players[i];
            result[i]=new PlayerCarry(p.score,p.lives,p.stars,p.nextExtraLife,p.eliminated);
        }
        return result;
    }
}
