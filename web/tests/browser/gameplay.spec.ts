import { expect, test } from '@playwright/test';
import { advanceToNextStage, begin, clearStage, completeLoss, presentation, readyWithClock, snapshot, startWithKeyboard } from './helpers';

test.setTimeout(60000);

test('a naturally spawned red armored carrier drops once and survives until the fourth player shot', async ({ page }) => {
  await readyWithClock(page);await begin(page);
  const observed=await page.evaluate(()=>{
    const api=window.__BATTLECITY__!,state=api.state()!;
    api.debug({tiles:Array(676).fill(0),brickMasks:Array(676).fill(0),enemyQueue:Array(20).fill('armor'),
      tanks:state.tanks.filter(t=>t.team==='player'),spawned:3,killed:0,spawnTimer:0,freezeTicks:100000,bullets:[],powerUp:null,effects:[]});
    api.step();const born=api.state()!.tanks.find(t=>t.team==='enemy')!;
    api.step(64);const ready=api.state()!;
    const player=ready.tanks.find(t=>t.team==='player')!;Object.assign(player,{x:born.x,y:48,direction:'up',spawnTicks:0,shieldTicks:0});
    Object.assign(ready.players[0],{score:0,kills:[0,0,0,0]});api.debug({tanks:ready.tanks,players:ready.players});
    const hits=[];
    for(let hit=1;hit<=4;hit++){
      api.step(1,[{up:false,right:false,down:false,left:false,firePressed:true}]);api.step(24);
      const current=api.state()!,tank=current.tanks.find(t=>t.id===born.id)!;
      hits.push({hp:tank.hp,dying:tank.deathTimer>0,carrier:tank.carryingPowerUp,
        item:current.powerUp,score:current.players[0].score,kills:current.players[0].kills[3]});
    }
    return {born,hits};
  });
  expect(observed.born).toMatchObject({kind:'armor',hp:4,carryingPowerUp:true,spawnTicks:28});
  expect(observed.hits.map(({hp,dying,carrier,score,kills})=>({hp,dying,carrier,score,kills}))).toEqual([
    {hp:3,dying:false,carrier:false,score:0,kills:0},{hp:2,dying:false,carrier:false,score:0,kills:0},
    {hp:1,dying:false,carrier:false,score:0,kills:0},{hp:0,dying:true,carrier:false,score:400,kills:1},
  ]);
  expect(observed.hits[0].item).not.toBeNull();
  for(const hit of observed.hits)expect(hit.item).toEqual(observed.hits[0].item);
});

test('stage 35 advances automatically to the next cycle with player progression', async ({ page }) => {
  await readyWithClock(page);
  await begin(page, 'single', 35);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const players = api.state()!.players;
    Object.assign(players[0], { score: 12300, stars: 2, lives: 1, nextExtraLife: Infinity });
    api.debug({ players });
  });
  await clearStage(page);
  await advanceToNextStage(page, 36);
  const state = (await snapshot(page))!;
  expect(state.players[0]).toMatchObject({ score: 12300, stars: 2, lives: 1, nextExtraLife: Infinity });
  expect(state.enemyQueue).toHaveLength(20);
  expect(state.enemyQueue.filter(kind => kind === 'power')).toHaveLength(4);
});

test('base destruction completes its presentations and a new run starts fresh', async ({ page }) => {
  await readyWithClock(page);
  await begin(page, 'single', 5);
  await completeLoss(page);
  expect(await snapshot(page)).toBeNull();
  await startWithKeyboard(page);
  expect(await snapshot(page)).toMatchObject({ stage: 1, phase: 'playing', baseAlive: true, killed: 0 });
});

test('an eliminated cooperative player remains eliminated across stages', async ({ page }) => {
  await readyWithClock(page);
  await begin(page, 'coop');
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    Object.assign(state.players[1], { lives: 0, eliminated: true, respawnTicks: 0 });
    api.debug({ players: state.players, spawned: 20, killed: 20,
      tanks: state.tanks.filter(tank => tank.team === 'player' && tank.playerIndex === 0), bullets: [] });
    api.step(200);
  });
  expect(await presentation(page)).toMatchObject({ kind: 'score' });
  await advanceToNextStage(page, 2);
  const state = (await snapshot(page))!;
  expect(state.players[1].eliminated).toBe(true);
  expect(state.tanks.some(tank => tank.playerIndex === 1)).toBe(false);
});
