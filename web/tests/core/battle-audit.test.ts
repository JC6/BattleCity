import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/core/engine';
import { collectPowerUp, dropPowerUp } from '../../src/core/powerups';
import { updateEnemySpawning } from '../../src/core/spawning';
import { resolveBulletHits, destroyEnemy } from '../../src/core/combat';
import { addScore } from '../../src/core/scoring';
import { type CoreContext, EMPTY_INPUT, Tile, type Bullet, type GunSlot } from '../../src/core/types';

function fixture(coop=true) {
  const engine=new GameEngine({tiles:Array(676).fill(Tile.Empty),enemies:Array(20).fill('armor')},{stage:1,mode:coop?'coop':'single',seed:1});
  const state=engine.state;Object.assign(state,{phase:'playing',introTicks:0,spawnTimer:100000,freezeTicks:100000});
  state.tanks.forEach(t=>Object.assign(t,{spawnTicks:0,shieldTicks:0}));
  let id=100;const context:CoreContext={state,events:[],nextId:()=>++id};
  const shot=(slot:GunSlot,x:number,y:number)=>{
    const player=slot<2 || slot>=8;
    const b:Bullet={id:++id,gunSlot:slot,team:player?'player':'enemy',playerIndex:player?(slot&1) as 0|1:null,x,y,direction:'up',speed:4,steelPower:false};
    state.bullets.push(b);return b;
  };
  return {engine,state,context,shot};
}

describe('recorded battle-rule boundaries',()=>{
  it('preserves the original turn cadence including the skipped direction/fire frame',()=>{
    for(let phase=0;phase<4;phase++){
      const {engine,state}=fixture(),tank=state.tanks[0];Object.assign(tank,{x:64,y:80});state.tick=phase;
      engine.step([{...EMPTY_INPUT,right:true,firePressed:true}]);const eligible=((phase+1)&3)!==2;
      expect(tank.direction).toBe(eligible?'right':'up');expect(tank.x).toBe(eligible?65:64);
      expect(state.bullets[0].direction).toBe(tank.direction);
    }
  });
  it('keeps the strict six-pixel contact box, owner slots and continued gun scan',()=>{
    for(const offset of [5,6]){
      const {context,state,shot}=fixture();shot(0,80,80);shot(2,80+offset,80+offset);resolveBulletHits(context);
      expect(state.bullets).toHaveLength(offset===5?0:2);
    }
    for(const slots of [[0,8],[1,9],[2,3],[0,1]] as const){
      const {context,state,shot}=fixture();shot(slots[0],80,80);shot(slots[1],82,80);resolveBulletHits(context);
      expect(state.bullets).toHaveLength(slots[0]===0 && slots[1]===1?0:2);
    }
    const {context,state,shot}=fixture();shot(0,80,80);shot(2,82,80);shot(3,83,80);resolveBulletHits(context);
    expect(state.bullets).toHaveLength(0);
  });
  it('ignores noncollecting birth phases when selecting the first seeded drop',()=>{
    const {context,state}=fixture();Object.assign(state.tanks[0],{x:72,y:72,spawnTicks:20});
    dropPowerUp(context);expect(state.powerUp).toMatchObject({x:72,y:72});
    expect(context.events).toHaveLength(1);expect(context.events[0]).toMatchObject({type:'powerup',action:'appear'});
  });
  it('never forces a drop onto an active collector across deterministic seeds',()=>{
    for(let seed=1;seed<=512;seed++){
      const {context,state}=fixture();state.rng=seed;Object.assign(state.tanks[0],{x:72,y:72});Object.assign(state.tanks[1],{x:120,y:72});
      dropPowerUp(context);const item=state.powerUp!;
      expect([24,72,120,168]).toContain(item.x);expect([24,72,120,168]).toContain(item.y);
      collectPowerUp(context,(t,p)=>destroyEnemy(context,t,p));expect(state.powerUp).toBe(item);
      expect(context.events.filter(e=>e.type==='powerup' && e.action==='pickup')).toHaveLength(0);
    }
  });
  it('shows pickup points for the original 50-count slot and awards once',()=>{
    const {context,state}=fixture();state.powerUp={kind:'star',x:64,y:192};
    collectPowerUp(context,(t,p)=>destroyEnemy(context,t,p));collectPowerUp(context,(t,p)=>destroyEnemy(context,t,p));
    expect(state.players[0].score).toBe(500);expect(state.tanks[0].stars).toBe(1);
    expect(state.effects).toEqual([{x:72,y:200,remainingTicks:50,value:500}]);
    dropPowerUp(context);expect(state.effects).toEqual([]);expect(state.powerUp).not.toBeNull();
  });
  it('only bonus carrier births clear the item and its pickup display',()=>{
    for(const kind of ['basic','fast','power','armor'] as const)for(const number of [3,4,5,10,11,12,17,18,19]){
      const {context,state}=fixture();state.spawned=number-1;state.spawnTimer=0;
      state.enemyQueue[number-1]=kind;
      const item={kind:'star' as const,x:24,y:24};state.powerUp=item;state.effects=[{x:32,y:32,remainingTicks:50,value:500}];
      updateEnemySpawning(context);const bonus=[4,11,18].includes(number);
      expect(state.powerUp).toBe(bonus?null:item);expect(state.effects).toHaveLength(bonus?0:1);
      expect(state.tanks.find(t=>t.team==='enemy')).toMatchObject({kind,hp:kind==='armor'?4:1,carryingPowerUp:bonus,spawnTicks:28});
      expect(state.spawned).toBe(number);
    }
  });
  it('keeps four hits from real armored carrier birth through death for either player and bullet strength',()=>{
    // Original E3F4–E402 / E7D1–E7F2, including the producer path missed by manual tank fixtures.
    for(const coop of [false,true])for(const steel of [false,true])for(let shooter=0;shooter<(coop?2:1);shooter++){
      const {engine,state}=fixture(coop);state.spawned=3;state.spawnTimer=0;engine.step([EMPTY_INPUT,EMPTY_INPUT]);
      const tank=state.tanks.find(t=>t.team==='enemy')!;
      expect(tank).toMatchObject({hp:4,carryingPowerUp:true,spawnTicks:28});
      for(let i=0;i<64 && tank.spawnTicks>0;i++)engine.step([EMPTY_INPUT,EMPTY_INPUT]);
      expect(tank.spawnTicks).toBe(0);let drops=0,item=state.powerUp;
      for(let hit=1;hit<=4;hit++){
        state.bullets=[{id:100+hit,gunSlot:shooter as 0|1,team:'player',playerIndex:shooter as 0|1,
          x:tank.x+8,y:tank.y+8,direction:'up',speed:steel?4:2,steelPower:steel}];
        const events=engine.step([EMPTY_INPUT,EMPTY_INPUT]);drops+=events.filter(e=>e.type==='powerup' && e.action==='appear').length;
        expect(tank.hp).toBe(4-hit);expect(tank.carryingPowerUp).toBe(false);expect(tank.deathTimer>0).toBe(hit===4);
        if(hit===1){item=state.powerUp;expect(item).not.toBeNull();}else expect(state.powerUp).toBe(item);
        state.players.forEach((player,index)=>{
          expect(player.score).toBe(hit===4 && index===shooter?400:0);
          expect(player.kills[3]).toBe(hit===4 && index===shooter?1:0);
        });
        expect(tank.deathPoints).toBe(hit===4?400:0);expect(state.killed).toBe(0);
      }
      expect(drops).toBe(1);for(let i=0;i<96;i++)engine.step([EMPTY_INPUT,EMPTY_INPUT]);expect(state.killed).toBe(1);
    }
  });
  it('grenades kill a born carrier without a bonus or kill credit while protecting a spawning carrier',()=>{
    const {engine,state}=fixture(false);state.spawned=3;state.spawnTimer=0;engine.step([EMPTY_INPUT]);
    const active=state.tanks.find(t=>t.team==='enemy')!;
    for(let i=0;i<64 && active.spawnTicks>0;i++)engine.step([EMPTY_INPUT]);
    state.spawned=10;state.spawnTimer=0;engine.step([EMPTY_INPUT]);
    const birth=state.tanks.find(t=>t.team==='enemy' && t!==active)!;
    expect(active.carryingPowerUp).toBe(true);expect(birth).toMatchObject({hp:4,carryingPowerUp:true,spawnTicks:28});
    const player=state.tanks.find(t=>t.team==='player')!;state.powerUp={kind:'grenade',x:player.x,y:player.y};
    const events=engine.step([EMPTY_INPUT]);
    expect(active.deathTimer).toBeGreaterThan(0);expect(active.deathPoints).toBe(0);expect(birth.deathTimer).toBe(0);expect(birth.hp).toBe(4);
    expect(state.powerUp).toBeNull();expect(state.players[0]).toMatchObject({score:500,kills:[0,0,0,0]});
    expect(events.filter(e=>e.type==='powerup' && e.action==='appear')).toHaveLength(0);
  });
  it('wraps the seven decimal score digits without granting the first 20000-point life twice',()=>{
    for(const amount of [100,400,500,1000]){
      const {context,state}=fixture(false),player=state.players[0],lives=player.lives;player.score=19900;
      addScore(context,0,100);expect(player).toMatchObject({score:20000,lives:lives+1,nextExtraLife:Infinity});
      player.score=9999900;addScore(context,0,amount);expect(player.score).toBe(amount-100);
      addScore(context,0,20000-player.score);expect(player).toMatchObject({score:20000,lives:lives+1,nextExtraLife:Infinity});
      expect(context.events.filter(e=>e.type==='extra-life' && e.reason==='score')).toHaveLength(1);
    }
  });
  it('returns on the update that the spawn counter reaches zero',()=>{
    const {context,state}=fixture();state.spawnTimer=1;updateEnemySpawning(context);
    expect(state.spawned).toBe(0);expect(state.spawnTimer).toBe(0);updateEnemySpawning(context);expect(state.spawned).toBe(1);
  });
});
