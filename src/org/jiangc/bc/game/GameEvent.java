package org.jiangc.bc.game;

/** Semantic effects, consumed by audio after a simulation tick. */
public final class GameEvent {
    public final String type;
    public String team = "", enemyKind = "", target = "", tankTeam = "", owner = "", action = "", kind = "", reason = "";
    public int playerIndex = -1, stars, gunSlot = -1, targetPlayerIndex = -1;
    public boolean steelPower;
    GameEvent(String type) { this.type = type; }
    public String canonical() {
        return String.join(",", "v", type, team, ""+playerIndex, enemyKind, ""+stars, target,
                ""+gunSlot, steelPower?"1":"0", tankTeam, ""+targetPlayerIndex, owner, action, kind, reason);
    }
}
