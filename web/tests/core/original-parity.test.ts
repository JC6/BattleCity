import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/core/engine';
import { chooseEnemyDirection, moveEnemy } from '../../src/core/ai';
import { awardCoopBonus } from '../../src/core/scoring';
import { EMPTY_INPUT, Tile } from '../../src/core/types';

function arena() {
  const engine=new GameEngine({tiles:Array(676).fill(Tile.Empty),enemies:Array(20).fill('basic')},{stage:1,mode:'coop',seed:1});
  const state=engine.state;Object.assign(state,{phase:'playing',introTicks:0,spawnTimer:100000,battleTicks:0});
  state.tanks.forEach(t=>Object.assign(t,{spawnTicks:0,shieldTicks:0}));return {engine,state};
}
// D43C/DE72, DC52–DD6A, C1D7–C859 and CCD4–CEE7.
// Literal boundaries come from the pinned original routines, not native snapshots.
describe('original rule parity',()=>{
  it.each([false,true])('keeps the original intro and battle clocks (custom map: %s)',customMap=>{
    const engine=new GameEngine({tiles:Array(676).fill(Tile.Empty),enemies:['basic']},{stage:1,mode:'single',seed:1,customMap});
    const ticks=customMap?83:96;
    for(let i=0;i<ticks-1;i++)engine.step([EMPTY_INPUT]);expect(engine.state.phase).toBe('intro');
    engine.step([EMPTY_INPUT]);expect(engine.state).toMatchObject({phase:'playing',battleTicks:0});
    engine.step([EMPTY_INPUT]);expect(engine.state).toMatchObject({battleTicks:1});
  });
  it('uses 64-tick pursuit stages and the original eight-bit wrap',()=>{
    for(const [ticks,direction] of [[1535,'right'],[1536,'left'],[3007,'left'],[3008,'down'],[16383,'down'],[16384,'right']] as const){
      const {state}=arena();Object.assign(state,{battleTicks:ticks,mode:'single'});
      const tank={...state.tanks[0],team:'enemy' as const,playerIndex:null,enemySlot:0,x:96,y:88};
      chooseEnemyDirection(state,tank);expect(tank.direction,`battle tick ${ticks}`).toBe(direction);
    }
  });
  it('waits two eligible updates after a blocked fast enemy and holds its tread',()=>{
    const {state}=arena(),tank={...state.tanks[0],id:10,team:'enemy' as const,playerIndex:null,enemySlot:0,kind:'fast' as const,x:40,y:192,direction:'down' as const};
    state.tanks.push(tank);moveEnemy(state,tank);expect(tank).toMatchObject({aiTicks:2,tread:1,y:192});
    moveEnemy(state,tank);expect(tank).toMatchObject({aiTicks:1,tread:1,y:192});
    moveEnemy(state,tank);expect(tank).toMatchObject({aiTicks:0,tread:1,y:192});
  });
  it('toggles wall treads on eligible player updates and holds on release',()=>{
    const {engine,state}=arena(),tank=state.tanks[0];tank.y=0;
    for(const tread of [1,1,0,1]){engine.step([{...EMPTY_INPUT,up:true},EMPTY_INPUT]);expect(tank).toMatchObject({y:0,tread});}
    engine.step([EMPTY_INPUT,EMPTY_INPUT]);expect(tank).toMatchObject({tread:1});
  });
  it('does not award a cooperative bonus at the battle outcome boundary',()=>{
    for(const outcome of ['won','lost'] as const){
      const {engine,state}=arena();state.players[0].kills=[12,0,0,0];state.players[1].kills=[8,0,0,0];
      state.pendingOutcome=outcome;state.outroTicks=1;if(outcome==='won')state.killed=20;else state.baseAlive=false;
      engine.step([EMPTY_INPUT,EMPTY_INPUT]);expect(state.phase).toBe(outcome);expect(state.players.map(p=>p.score)).toEqual([0,0]);
    }
  });
  it('never grants the score bonus on a loss, tie or to an eliminated leader',()=>{
    for(const outcome of ['won','lost'] as const)for(const eliminated of [false,true])for(const tie of [false,true]){
      const {state}=arena();state.phase=outcome;state.players[0].eliminated=eliminated;state.players[0].kills=[12,0,0,0];state.players[1].kills=[tie?12:8,0,0,0];
      const events:Parameters<typeof awardCoopBonus>[0]['events']=[];
      awardCoopBonus({state,events,nextId:()=>100});const eligible=outcome==='won' && !eliminated && !tie;
      expect(state.players[0].score).toBe(eligible?1000:0);expect(state.players[0].eliminated).toBe(eliminated);
      expect(events.filter(e=>e.type==='score-bonus')).toHaveLength(eligible?1:0);
    }
  });
});
