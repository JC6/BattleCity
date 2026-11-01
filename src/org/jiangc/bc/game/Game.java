package org.jiangc.bc.game;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.jiangc.bc.game.GameState.*;
import static org.jiangc.bc.game.GameState.*;

/** Native stage rules. No Android or wall clock. */
public final class Game {
    public static final double TICK_RATE = 60.0988, TICK_SECONDS = 1 / TICK_RATE;
    private static final int[] DX = {0,1,0,-1}, DY = {-1,0,1,0};
    private static final int[] FORTRESS = {609,610,611,612,635,638,661,664};
    private static final Comparator<Tank> TANK_ORDER=Comparator.comparingInt(Tank::slot).reversed();
    private static final Comparator<Bullet> BULLET_ORDER=Comparator.comparingInt((Bullet b)->b.gunSlot).reversed();
    private static final int[][] TARGET_DIRECTIONS={{0,0,0,3,0,1,2,2,2},{3,0,1,3,0,1,3,2,1}};
    private static final int[] POWER_TABLE = {0,1,2,3,4,5,4,3};
    public final GameState state;
    private final List<GameEvent> events = new ArrayList<>();
    private int id;

    public Game(int[] tiles, int[] enemies, boolean coop, int seed) {
        this(tiles,enemies,coop,1,seed,null);
    }
    public Game(int[] tiles, int[] enemies, boolean coop, int stage, int seed, PlayerCarry[] carries) {
        if(tiles.length != 676 || enemies.length == 0) throw new IllegalArgumentException("Invalid level");
        if(carries!=null && carries.length!=(coop?2:1)) throw new IllegalArgumentException("Invalid player count");
        state = new GameState(); state.tiles=tiles.clone(); state.enemyQueue=enemies.clone(); state.rng=seed;
        state.stage=LevelCatalog.normalize(stage);
        state.brickMasks=Arrays.stream(tiles).map(t -> t==1?15:0).toArray();
        state.players=new Player[coop?2:1];
        for(int i=0;i<state.players.length;i++) {
            Player p=new Player();p.index=i;
            if(carries!=null) {
                PlayerCarry carry=carries[i];p.score=carry.score();p.lives=carry.lives();p.stars=carry.stars();
                p.nextExtraLife=carry.nextExtraLife();p.eliminated=carry.eliminated();
            }
            state.players[i]=p;if(!p.eliminated)spawnPlayer(i);
        }
    }
    public List<GameEvent> step(PlayerInput[] inputs) {
        events.clear();
        if(state.phase==WON || state.phase==LOST) return List.of();
        state.tick++;
        if(state.phase==INTRO) {
            if(--state.introTicks==0) { state.phase=PLAYING; event("stage-start"); }
            return List.copyOf(events);
        }
        state.battleTicks++;
        timers();
        List<Tank> actors=orderedTanks();
        for(Tank t:actors) {
            t.moving=false;t.directionHeld=false; if(!t.active()) continue;
            if(t.team==0) movePlayer(t,state.pendingOutcome!=LOST && t.playerIndex<inputs.length?inputs[t.playerIndex]:PlayerInput.NONE); else moveEnemy(t);
        }
        advanceBullets();
        {
            for(int i=state.players.length-1;i>=0;i--) {
                Tank t=playerTank(i); if(state.pendingOutcome!=LOST && t!=null && i<inputs.length && inputs[i].firePressed()) fire(t);
            }
            for(Tank t:actors) if(t.team==1) enemyFire(t);
            for(Player p:state.players) if(!p.eliminated && playerTank(p.index)==null && state.tanks.stream().noneMatch(t->t.team==0 && t.playerIndex==p.index)) {
                if(p.respawnTicks>1) p.respawnTicks--; else if(p.respawnTicks==1) spawnPlayer(p.index);
            }
            spawnEnemy();
        }
        resolveBullets();
        collectPowerUp();
        outcome();
        return List.copyOf(events);
    }
    private GameEvent event(String type) { GameEvent e=new GameEvent(type); events.add(e); return e; }
    private String team(int team) { return team==0?"player":"enemy"; }
    private List<Tank> orderedTanks() { List<Tank> list=new ArrayList<>(state.tanks); list.sort(TANK_ORDER); return list; }
    public Tank playerTank(int index) { for(Tank t:state.tanks) if(t.team==0 && t.playerIndex==index && t.deathTimer==0) return t; return null; }
    private int random(int limit) {
        int v=state.rng==0?0x6d2b79f5:state.rng; v^=v<<13; v^=v>>>17; v^=v<<5; state.rng=v;
        return (int)(Integer.toUnsignedLong(v)%limit);
    }
    private boolean playerTick() { return (state.tick&3)!=2; }
    private boolean enemyTick(Tank t) { return ((state.tick^t.enemySlot)&1)!=0; }
    private int duration(int max) { return max-(state.tick&63); }
    private int spawnInterval() { return 190-Math.min(state.stage,35)*4-((state.demo?state.demoMode!=0:state.players.length==2)?20:0); }
    private void clearSpawn(int x,int y) {
        for(int row=y/8;row<(y+16)/8;row++) for(int col=x/8;col<(x+16)/8;col++) {
            int i=row*26+col; state.tiles[i]=0; state.brickMasks[i]=0;
        }
    }
    private void spawnPlayer(int index) {
        Tank t=new Tank(); t.id=++id; t.playerIndex=index; t.x=index==0?64:128; t.y=192; t.stars=state.players[index].stars;
        clearSpawn(t.x,t.y); state.tanks.add(t); state.players[index].respawnTicks=0;
    }
    private void spawnEnemy() {
        if(state.spawnTimer>0){state.spawnTimer--;return;}
        int max=state.demo?4:state.players.length==2?6:4;
        boolean[] occupied=new boolean[max]; int count=0;
        for(Tank t:state.tanks) if(t.team==1) { occupied[t.enemySlot]=true; count++; }
        if(state.spawned>=state.enemyQueue.length || count>=max) return;
        int slot=max-1; while(occupied[slot]) slot--;
        Tank t=new Tank(); t.id=++id; t.team=1; t.enemySlot=slot; t.kind=state.enemyQueue[state.spawned];
        t.hp=t.kind==3?4:1; t.x=new int[]{96,192,0}[state.spawned%3]; t.direction=2;
        t.carryingPowerUp=state.spawned==3 || state.spawned==10 || state.spawned==17;
        if(t.carryingPowerUp){clearPowerUp();if(t.kind==3)t.hp=1;}
        clearSpawn(t.x,0); state.tanks.add(t); state.spawned++; state.spawnTimer=spawnInterval();
    }
    private void timers() {
        if(state.eliminationTicks>0)state.eliminationTicks--;
        for(Tank t:new ArrayList<>(state.tanks))if(t.deathTimer>0 && (t.team==0?playerTick():(t.kind==1 && t.deathPoints>0) || enemyTick(t))) {
            if((--t.deathTimer&15)==0){
                t.deathTimer-=16;
                if(t.deathTimer>0)t.deathTimer|=t.deathTimer==16?6:3;
                else {
                    state.tanks.remove(t);
                    if(t.team==1)state.killed++;
                    else {Player p=state.players[t.playerIndex];
                        if(p.lives>0){p.lives--;p.respawnTicks=1;}
                        else {p.eliminated=true;p.respawnTicks=0;
                            boolean partner=false;for(Player other:state.players)if(other!=p && !other.eliminated)partner=true;
                            if(partner && state.baseAlive){state.eliminationPlayer=p.index;state.eliminationTicks=13*16;}
                        }
                    }
                }
            }
        }
        for(Effect e:state.effects) e.remainingTicks--; state.effects.removeIf(e->e.remainingTicks<=0);
        if(state.freezeTicks>0) state.freezeTicks--;
        if(state.fortifyTicks>0) {
            if(--state.fortifyTicks==0) fortress(1);
            else if(state.fortifyTicks<=192 && (state.tick&15)==0) fortress((state.tick&16)!=0?2:1);
        }
        for(Tank t:state.tanks) {
            if(t.deathTimer>0)continue;
            if(t.spawnTicks>0) {
                if(t.team==0?playerTick():enemyTick(t)) t.spawnTicks--;
                if(t.spawnTicks==0 && t.team==0) t.shieldTicks=duration(192);
            } else if(t.shieldTicks>0) t.shieldTicks--;
        }
    }
    private static boolean overlap(int x,int y,int w,int h,int a,int b,int c,int d) { return x<a+c && x+w>a && y<b+d && y+h>b; }
    private static int overlapArea(int x,int y,Tank t) { return Math.max(0,Math.min(x+16,t.x+16)-Math.max(x,t.x))*Math.max(0,Math.min(y+16,t.y+16)-Math.max(y,t.y)); }
    boolean canOccupy(Tank tank,int x,int y) {
        if(x<0 || y<0 || x+16>208 || y+16>208 || overlap(x,y,16,16,96,192,16,16)) return false;
        for(int row=y/8;row<=(y+15)/8;row++) for(int col=x/8;col<=(x+15)/8;col++) {
            int i=row*26+col,tile=state.tiles[i]; if(tile==2 || tile==3) return false;
            if(tile==1 && state.brickMasks[i]!=0) return false;
        }
        for(Tank t:state.tanks) if(t.id!=tank.id && t.deathTimer==0) { int area=overlapArea(x,y,t); if(area>0 && area>=overlapArea(tank.x,tank.y,t)) return false; }
        return true;
    }
    private void turn(Tank t,int dir) {
        if((t.direction&1)!=(dir&1)) {
            int x=Math.round(t.x/8f)*8,y=Math.round(t.y/8f)*8; if(canOccupy(t,x,y)) {t.x=x;t.y=y;}
        }
        t.direction=dir;
    }
    private boolean move(Tank t) {
        int x=t.x+DX[t.direction],y=t.y+DY[t.direction]; t.moving=canOccupy(t,x,y);
        if(t.moving) {t.x=x;t.y=y;} return t.moving;
    }
    private void movePlayer(Tank t,PlayerInput input) {
        t.directionHeld=input.up() || input.right() || input.down() || input.left();
        if(!playerTick()) return;
        if(t.stunTicks>0) {t.stunTicks--;t.slideTicks=0;return;}
        boolean ice=state.tiles[(t.y+8)/8*26+(t.x+8)/8]==5;
        if(t.slideTicks>0) t.slideTicks--;
        int d=input.right()?1:input.left()?3:input.down()?2:input.up()?0:-1;
        if(ice && t.slideTicks>16) d=t.direction;
        if(d>=0) {
            turn(t,d); t.tread^=1; if(move(t) && ice && t.slideTicks==0) t.slideTicks=28; else if(!ice || !t.moving) t.slideTicks=0;
        } else if(ice && t.slideTicks>0) {t.tread^=1;if(!move(t)) t.slideTicks=0;} else t.slideTicks=0;
    }
    int aiClock(){return (state.battleTicks/64)&255;}
    int pursuit(){int high=aiClock(),interval=spawnInterval();return high<=(interval>>3)?0:high<=(interval>>2)?1:2;}
    private void chooseDirection(Tank t) {
        int high=aiClock(), interval=spawnInterval();
        if(high<=(interval>>3)) {turn(t,random(4));return;}
        int x=96,y=192;
        if(high<=(interval>>2)) {
            Tank target=playerTank(t.enemySlot&1); if(target==null) for(Tank p:state.tanks) if(p.team==0) {target=p;break;}
            if(target!=null) {x=target.x;y=target.y;}
        }
        int index=(Integer.signum(y-t.y)+1)*3+Integer.signum(x-t.x)+1;
        turn(t,TARGET_DIRECTIONS[random(2)][index]);
    }
    private void moveEnemy(Tank t) {
        if(state.freezeTicks>0 || (t.kind!=1 && !enemyTick(t))) return;
        // DC52/DC6B: status 88 -> 84 -> A0, two eligible updates without movement.
        if(t.aiTicks>0){t.aiTicks--;return;}
        if(t.aiTurn){
            t.aiTurn=false;
            if(random(2)==0) requestDirection(t);
            else turn(t,(t.direction+(random(2)==0?3:1))%4);
            return;
        }
        if(t.aiTarget){t.aiTarget=false;chooseDirection(t);return;}
        boolean aligned=(t.x&7)==0 && (t.y&7)==0;
        if(aligned && random(16)==0){requestDirection(t);return;}
        if(move(t)){t.tread^=1;return;}
        if(random(4)!=0){t.aiTicks=2;t.tread^=1;}
        else {t.direction=(t.direction+2)%4;t.aiTurn=aligned;}
    }
    private void requestDirection(Tank t){
        // DE72 schedules a separate target-selection update after the wandering phase.
        if(pursuit()==0)turn(t,random(4));else t.aiTarget=true;
    }
    private Bullet gun(int slot) { for(Bullet b:state.bullets) if(b.gunSlot==slot) return b; return null; }
    void fire(Tank t) {
        if(!t.active()) return;
        int slot=t.slot(); Bullet primary=gun(slot);
        if(primary!=null) { if(t.team!=0 || t.stars<2 || gun(slot+8)!=null) return; primary.gunSlot=slot+8; }
        Bullet b=new Bullet(); b.id=++id; b.gunSlot=slot; b.team=t.team; b.playerIndex=t.playerIndex;
        b.x=t.x+8+DX[t.direction]*8; b.y=t.y+8+DY[t.direction]*8; b.direction=t.direction;
        b.speed=(t.team==0?t.stars>0:t.kind==2)?4:2; b.steelPower=t.team==0 && t.stars==3; state.bullets.add(b);
        GameEvent e=event("fire");e.team=team(t.team);e.playerIndex=t.playerIndex;e.enemyKind=t.team==1?KINDS[t.kind]:"";e.stars=t.stars;
    }
    private void enemyFire(Tank t) { if(t.active() && state.freezeTicks==0 && random(32)==0) fire(t); }
    private void points(int x,int y,int value) {
        Effect e=new Effect();e.x=x+8;e.y=y+8;e.remainingTicks=50;e.value=value;state.effects.add(e);
    }
    private void explosion(String owner,Tank t) { GameEvent e=event("explosion");e.owner=owner;if(t!=null){e.playerIndex=t.playerIndex;e.enemyKind=t.team==1?KINDS[t.kind]:"";} }
    void destroyEnemy(Tank t,int player) {
        if(!state.tanks.contains(t) || t.deathTimer>0)return;
        t.deathTimer=0x73;t.moving=false;t.directionHeld=false;explosion("enemy",t);
        if(player>=0){state.players[player].kills[t.kind]++;t.deathPoints=(t.kind+1)*100;addScore(player,t.deathPoints);}
    }
    private GameEvent hitEvent(Bullet b,String target) {
        GameEvent e=event("hit");e.target=target;e.team=team(b.team);e.playerIndex=b.playerIndex;e.gunSlot=b.gunSlot;e.steelPower=b.steelPower;return e;
    }
    private void hitTank(Tank t,Bullet b) {
        if(!t.active() || t.shieldTicks>0) return;
        if(t.team==0) {
            if(b.team==0) {
                if(!state.demo && t.stunTicks==0) t.stunTicks=200;GameEvent e=hitEvent(b,"tank");e.tankTeam="player";e.targetPlayerIndex=t.playerIndex;return;
            }
            Player p=state.players[t.playerIndex]; p.stars=0;
            t.deathTimer=0x73;t.deathPoints=0;t.moving=false;t.directionHeld=false;explosion("player",t);
        } else {
            if(t.carryingPowerUp) {t.carryingPowerUp=false;dropPowerUp();}
            if(--t.hp==0) destroyEnemy(t,b.playerIndex);
            else {GameEvent e=hitEvent(b,"tank");e.tankTeam="enemy";e.enemyKind=KINDS[t.kind];}
        }
    }
    private int indexAt(int x,int y) {return x<0 || y<0 || x>=208 || y>=208?-1:y/8*26+x/8;}
    private boolean probe(Bullet b,int x,int y,int index,Set<String> materials) {
        if(index<0) {b.impactTicks=9;materials.add("boundary");return false;}
        int cx=index%26*8,cy=index/26*8;
        if(state.baseAlive && cx>=96 && cx<112 && cy>=192 && cy<208) {
            state.baseAlive=false;state.baseExplosionTicks=39;b.impactTicks=9;explosion("base",null);return false;
        }
        int tile=state.tiles[index],mask=1<<(((y&4)!=0?2:0)+((x&4)!=0?1:0));
        if(tile!=2 && (tile!=1 || (state.brickMasks[index]&mask)==0)) return false;
        b.impactTicks=9;materials.add(tile==2?"steel":"brick");
        if(b.steelPower) {state.tiles[index]=0;state.brickMasks[index]=0;return false;}
        if(tile==2) return false;
        state.brickMasks[index]&=~mask;if(state.brickMasks[index]==0) state.tiles[index]=0;return true;
    }
    private void hitTerrain(Bullet b) {
        Set<String> materials=new LinkedHashSet<>();int sx=(b.direction&1)==0?1:0,sy=1-sx;
        int i=indexAt(b.x,b.y);if(probe(b,b.x,b.y,i,materials)) probe(b,b.x+sx*4,b.y+sy*4,i,materials);
        i=indexAt(b.x-sx,b.y-sy);if(probe(b,b.x-sx,b.y-sy,i,materials)) probe(b,b.x-sx*5,b.y-sy*5,i,materials);
        for(String m:materials) hitEvent(b,m);
    }
    private void advanceBullets() {
        for(Bullet b:state.bullets) if(b.impactTicks>0) b.impactTicks--;
        state.bullets.removeIf(b->b.impactTicks==0);
        for(Bullet b:state.bullets) if(b.impactTicks<0) {b.x+=DX[b.direction]*b.speed;b.y+=DY[b.direction]*b.speed;}
    }
    private boolean active(Bullet b,Set<Integer> gone) {return b.impactTicks<0 && !gone.contains(b.id);}
    private boolean contact(Tank t,Bullet b) {return t.active() && Math.abs(t.x+8-b.x)<10 && Math.abs(t.y+8-b.y)<10;}
    private void hit(Tank t,Bullet b,Set<Integer> gone) {if(t.shieldTicks>0) gone.add(b.id);else b.impactTicks=9;hitTank(t,b);}
    void resolveBullets() {
        List<Bullet> ordered=new ArrayList<>(state.bullets);ordered.sort(BULLET_ORDER);
        Set<Integer> gone=new HashSet<>();List<Bullet> players=new ArrayList<>(),enemies=new ArrayList<>();
        for(Bullet b:ordered) (b.gunSlot<2 || b.gunSlot>=8?players:enemies).add(b);
        for(Bullet b:ordered) if(active(b,gone) && !(b.speed==2 && !b.steelPower && ((b.gunSlot^state.tick)&1)==0)) hitTerrain(b);
        for(Bullet b:players) {
            if(!active(b,gone)) continue;
            for(Bullet other:ordered) if(active(other,gone) && (other.gunSlot&7)!=(b.gunSlot&7) && Math.abs(other.x-b.x)<6 && Math.abs(other.y-b.y)<6) {gone.add(b.id);gone.add(other.id);}
        }
        List<Tank> ts=orderedTanks();
        for(Tank t:ts) if(t.team==0) for(Bullet b:enemies) if(active(b,gone) && contact(t,b)) {hit(t,b,gone);if(!state.tanks.contains(t)) break;}
        for(Tank t:ts) if(t.team==1) for(Bullet b:players) if(active(b,gone) && contact(t,b)) {hit(t,b,gone);if(!state.tanks.contains(t)) break;}
        for(Tank t:ts) if(t.team==0 && state.tanks.contains(t)) for(Bullet b:players) if(active(b,gone) && (b.gunSlot&1)!=t.playerIndex && contact(t,b)) {
            boolean stunned=t.stunTicks>0;hit(t,b,gone);if(t.shieldTicks==0 && !stunned) break;
        }
        state.bullets.removeIf(b->gone.contains(b.id));
    }
    private boolean pickupRange(Tank t,int x,int y) {return t!=null && t.team==0 && t.active() && Math.abs(t.x-x)<12 && Math.abs(t.y-y)<12;}
    private boolean occupiedPowerUp(int x,int y) {
        for(Tank t:state.tanks)if(pickupRange(t,x,y))return true;
        return false;
    }
    private void clearPowerUp() {
        state.powerUp=null;
        // E3A7 / E8BE reuse the one bonus slot, including its 500-point display.
        state.effects.removeIf(e->e.value==500);
    }
    private void dropPowerUp() {
        int x=24,y=24;boolean free=false;
        for(int attempt=0;attempt<32;attempt++) {
            x=24+random(4)*48;y=24+random(4)*48;
            if(!occupiedPowerUp(x,y)){free=true;break;}
        }
        // A bounded retry must not turn into an immediate unintended pickup.
        // At most two active players can exclude two of the sixteen positions.
        if(!free){
            search:for(int yy=24;yy<=168;yy+=48)for(int xx=24;xx<=168;xx+=48)if(!occupiedPowerUp(xx,yy)){x=xx;y=yy;free=true;break search;}
            if(!free)throw new IllegalStateException("No free bonus position");
        }
        clearPowerUp();
        state.powerUp=new PowerUp(POWER_TABLE[random(8)],x,y);
        GameEvent e=event("powerup");e.action="appear";e.kind=POWERS[state.powerUp.kind()];
    }
    private void fortress(int tile) {for(int i:FORTRESS){state.tiles[i]=tile;state.brickMasks[i]=tile==1?15:0;}}
    void collectPowerUp() {
        PowerUp u=state.powerUp;if(u==null) return;
        Tank t=null;
        for(int index=1;index>=0;index--) {Tank p=playerTank(index);if(pickupRange(p,u.x(),u.y())){t=p;break;}}
        if(t==null) return;Player p=state.players[t.playerIndex];clearPowerUp();addScore(p.index,500);points(u.x(),u.y(),500);
        GameEvent e=event("powerup");e.action="pickup";e.kind=POWERS[u.kind()];e.playerIndex=p.index;
        switch(u.kind()) {
            case 0:t.shieldTicks=duration(640);break;
            case 1:state.freezeTicks=duration(640);break;
            case 2:if(state.baseAlive){state.fortifyTicks=duration(1280);fortress(2);}break;
            case 3:p.stars=Math.min(3,p.stars+1);t.stars=p.stars;break;
            case 4:for(Tank enemy:new ArrayList<>(state.tanks)) if(enemy.team==1 && enemy.active()) destroyEnemy(enemy,-1);break;
            case 5:p.lives++;extraLife(p.index,"powerup");break;
            default:throw new IllegalStateException();
        }
    }
    private GameEvent extraLife(int player,String reason) {GameEvent e=event("extra-life");e.playerIndex=player;e.reason=reason;return e;}
    GameEvent addScore(int index,int amount) {
        if(state.demo)return null;
        Player p=state.players[index];p.score=(p.score+amount)%10000000;
        if(state.pendingOutcome!=LOST && state.baseAlive && p.nextExtraLife>=0 && p.score>=p.nextExtraLife) {
            if(p.eliminated){p.eliminated=false;p.respawnTicks=1;}else p.lives++;
            p.nextExtraLife=-1;return extraLife(index,"score");
        }
        return null;
    }
    private void outcome() {
        boolean alive=false;for(Player p:state.players)if(!p.eliminated)alive=true;
        int result=!state.baseAlive || !alive?LOST:state.killed==state.enemyQueue.length?WON:-1;
        if(state.baseExplosionTicks>0)state.baseExplosionTicks--;
        if(state.pendingOutcome<0 && result>=0){
            state.pendingOutcome=result;
            if(result==WON){state.outroTicks=state.eliminationTicks>0?256:128;return;}
        }
        // A shot during the victory wait can still destroy HQ. It does not restart that wait.
        if(result==LOST)state.pendingOutcome=LOST;
        if(state.pendingOutcome<0)return;
        if(state.outroTicks==0){
            if(state.baseExplosionTicks>0)return;
            state.lossBannerTicks=256;state.eliminationTicks=0;state.outroTicks=256;
            return;
        }
        if(state.lossBannerTicks>0)state.lossBannerTicks--;
        if(--state.outroTicks==0){
            state.phase=state.pendingOutcome;
            event(state.phase==WON?"stage-clear":"game-over");
        }
    }
}
