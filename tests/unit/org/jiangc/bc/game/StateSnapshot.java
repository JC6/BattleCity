package org.jiangc.bc.game;

import java.util.*;
import org.jiangc.bc.game.GameState.*;

final class StateSnapshot {
    private static String row(Object... values) {return String.join(",",Arrays.stream(values).map(String::valueOf).toArray(String[]::new));}
    private static int b(boolean value){return value?1:0;}
    private static String ints(int[] values){return String.join(",",Arrays.stream(values).mapToObj(String::valueOf).toArray(String[]::new));}
    static String canonical(GameState s,List<GameEvent> events) {
        List<String> rows=new ArrayList<>();
        rows.add(row(s.tick,s.players.length,s.phase,s.pendingOutcome,Integer.toUnsignedLong(s.rng),s.spawned,s.killed,s.spawnTimer,s.freezeTicks,s.fortifyTicks,b(s.baseAlive),s.introTicks,s.outroTicks,s.battleTicks,s.baseExplosionTicks,s.lossBannerTicks,s.eliminationTicks));
        rows.add(ints(s.tiles));rows.add(ints(s.brickMasks));
        for(Player p:s.players) rows.add(row("p",p.index,p.score,p.lives,p.stars,p.nextExtraLife,b(p.eliminated),p.respawnTicks,ints(p.kills)));
        for(Tank t:s.tanks) rows.add(row("t",t.id,t.team,t.playerIndex,t.enemySlot,t.kind,t.x,t.y,t.direction,t.hp,t.stars,t.shieldTicks,t.spawnTicks,t.stunTicks,t.aiTicks,t.tread,b(t.aiTurn),b(t.aiTarget),t.slideTicks,b(t.moving),b(t.carryingPowerUp),t.deathTimer,t.deathPoints,b(t.directionHeld)));
        for(Bullet v:s.bullets) rows.add(row("b",v.id,v.gunSlot,v.team,v.playerIndex,v.x,v.y,v.direction,v.speed,b(v.steelPower),v.impactTicks));
        if(s.powerUp!=null) rows.add(row("u",s.powerUp.kind(),s.powerUp.x(),s.powerUp.y()));
        for(Effect e:s.effects) rows.add(row("e",e.x,e.y,e.remainingTicks,e.value));
        for(GameEvent e:events) rows.add(e.canonical());
        return String.join(";",rows);
    }
}
