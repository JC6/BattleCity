import { GameEngine } from '../../src/core/engine';
import { getLevel } from '../../src/data/levels';
import { describe, expect, it, vi } from 'vitest';
import { PALETTE, SPAWN_FRAMES, SHIELD_FRAMES, EXPLOSION_FRAMES, drawText, tankBitmap } from '../../src/game/pixel-assets';
import { TICK_MS } from '../../src/core/constants';
import { Tile } from '../../src/core/types';
import { tankFrame } from '../../src/game/atlas';
import { ImagePixels } from '../../src/game/textures';
import { crop, hashPixels, PixelCanvas, renderer } from './native-renderer';
import { emptyWorld } from './render-fixtures';
vi.mock('phaser', () => ({ default: { Scene: class {}, CANVAS: 1 } }));

describe('presentation parity', () => {
  it('retains four white birth shapes, two shields and five explosion sizes', () => {
    expect(SPAWN_FRAMES).toHaveLength(4); expect(SHIELD_FRAMES).toHaveLength(2);
    expect(SPAWN_FRAMES.every(rows => rows.every(row => /^[.W]{16}$/.test(row)))).toBe(true);
    expect(EXPLOSION_FRAMES.map(rows => [rows[0].length, rows.length])).toEqual([[16,16],[16,16],[16,16],[32,32],[32,32]]);
  });
  it('opens the original curtain in 8px steps, hiding actors until play and HUD until setup',()=>{
    const {scene,images,textures}=renderer();scene.state=emptyWorld();
    for(const [remaining,cover] of [[19,0],[18,112],[17,112],[16,104],[4,8],[3,0]]) {
      scene.presentation={kind:'intro',stage:1,elapsedMs:(96-remaining)*TICK_MS};scene.update(0,0);
      const covers=images.filter(i=>i.visible && i.frame.name==='gray' && i.depth>=800);
      expect(covers.map(i=>[i.y,i.frame.height*i.scaleY])).toEqual(cover?[[0,cover],[240-cover,cover]]:[]);
      expect(images.some(i=>i.visible && i.texture.key==='arena-hud')).toBe(remaining<=3);
      expect(textures.get('arena-map-0')!.refreshes).toBe(remaining>=19?0:1);
    }
  });
  it('keeps player stun blinking tied to the original bit rather than render count',()=>{
    const {scene,images}=renderer(),state=emptyWorld();const tank={...state.players[0],team:'player' as const,id:1,playerIndex:0 as const,enemySlot:null,
      kind:'basic' as const,x:64,y:80,direction:'up' as const,hp:1,stars:0,shieldTicks:0,spawnTicks:0,deathTimer:0,deathPoints:0,
      stunTicks:100,aiTicks:0,aiTurn:false,aiTarget:false,tread:1 as const,slideTicks:0,moving:false,carryingPowerUp:false};
    state.tanks=[tank];scene.state=state;scene.presentation={kind:'game'};
    for(const tick of [0,7,8,15,16]){state.tick=tick;scene.update(0,0);scene.update(0,0);
      expect(images.some(i=>i.visible && i.frame.name==='player:0:0:up:1')).toBe((tick&8)===0);expect(tank.tread).toBe(1);}
  });
  it('places the failure and cooperative elimination banners at their original coordinates', () => {
    const { scene, images } = renderer(), state = emptyWorld();
    scene.state = state; scene.presentation = { kind: 'game' };
    for (const [remaining, y] of [[256,233],[255,232],[129,106],[1,106]]) {
      state.lossBannerTicks = remaining; scene.update(0,0);
      const banner = images.find(image => image.visible && image.frame.name === 'loss')!;
      expect([banner.x,banner.y]).toEqual([104,y]);
    }
    state.lossBannerTicks = 0;
    for (const player of [0,1] as const) for (const [remaining, progress] of [[208,0],[145,63],[1,63]]) {
      state.eliminationPlayer = player; state.eliminationTicks = remaining; scene.update(0,0);
      const banner = images.find(image => image.visible && image.frame.name === 'loss')!;
      expect([banner.x,banner.y]).toEqual([player === 0 ? 24+progress : 184-progress,209]);
    }
    state.eliminationTicks = 0; scene.update(0,0);
    expect(images.some(image => image.visible && image.frame.name === 'loss')).toBe(false);
  });
  it('renders the HQ counter and tank death stages without a copied presentation world', () => {
    const { scene, images } = renderer(), state = emptyWorld();
    scene.state = state; scene.presentation = { kind: 'game' };
    for (const [ticks, phase] of [[39,0],[32,1],[28,2],[24,3],[20,4]]) {
      state.baseExplosionTicks = ticks; scene.update(0,0);
      const burst = images.find(image => image.visible && image.frame.name === `explosion:${phase}`)!;
      expect([burst.x+burst.frame.width/2,burst.y+burst.frame.height/2]).toEqual([120,217]);
    }
    state.baseExplosionTicks = 0;
    const tank = new GameEngine(getLevel(1), {mode:'single',stage:1}).state.tanks[0];
    tank.x = 64; tank.y = 80; tank.spawnTicks = 0; tank.deathPoints = 400; state.tanks = [tank];
    for (const [stage, frame] of [[7,'explosion:0'],[6,'explosion:1'],[5,'explosion:2'],[4,'explosion:3'],[3,'explosion:4'],[2,'explosion:2'],[1,'points:400']] as const) {
      tank.deathTimer = stage*16+3; scene.update(0,0);
      const burst = images.find(image => image.visible && image.frame.name === frame)!;
      expect([burst.x+burst.frame.width/2,burst.y+burst.frame.height/2]).toEqual([88,105]);
      expect(images.some(image => image.visible && image.frame.name.startsWith('player:'))).toBe(false);
    }
  });
  it('places stage labels on the same fixed columns for one and two digits', () => {
    const { scene, frame } = renderer();
    for (const stage of [1, 35]) {
      scene.presentation = { kind: 'stage-select', stage, mode: 'single' }; scene.update(0, 0);
      const expected = new PixelCanvas(256, 240), g = new ImagePixels({ width: 256, height: 240, data: expected.data } as ImageData);
      g.place(0, 0, 256, 240); g.fillStyle(PALETTE.gray); g.fillRect(0, 0, 256, 240);
      drawText(g, 'STAGE', 96, 112, PALETTE.black);
      drawText(g, String(stage), stage === 1 ? 152 : 144, 112, PALETTE.black);
      expect(hashPixels(frame().data)).toBe(hashPixels(expected.data));
    }
  });
  it('places all result fields independently of their numeric length', () => {
    const { scene, frame } = renderer(), state = emptyWorld('coop'); state.stage = 35;
    state.players[0].score = 12345; state.players[1].score = 9;
    state.players[0].kills = [2, 1, 0, 3]; state.players[1].kills = [1, 0, 2, 4];
    scene.presentation = { kind: 'score', state, highScore: 123456, elapsedMs: 100000 }; scene.update(0,0);
    const check = (text: string, x: number, y: number, color = PALETTE.white) => {
      const expected = new PixelCanvas(text.length * 8, 8);
      const g = new ImagePixels({ width: expected.width, height: 8, data: expected.data } as ImageData);
      g.place(0, 0, expected.width, 8); g.fillStyle(PALETTE.black); g.fillRect(0,0,expected.width,8); drawText(g,text,0,0,color);
      expect(hashPixels(crop(frame(), x,y,expected.width,8).data), `${text} at ${x},${y}`).toBe(hashPixels(expected.data));
    };
    check('123456',144,24,PALETTE.yellow); check('STAGE',96,40); check('35',144,40);
    check('Ⅰ-PLAYER',24,56,PALETTE.red); check('Ⅱ-PLAYER',168,56,PALETTE.green);
    check('12345',48,72,PALETTE.yellow); check('9',224,72,PALETTE.yellow);
    check('200',32,96); check('100',176,96); check('PTS',208,96);
    check('TOTAL',48,184); check('6',104,184); check('7',152,184);
    expect([...crop(frame(),96,181,64,2).data]).toEqual(Array(128).fill([252,252,252,255]).flat());
  });
  it('renders the authoritative BONUS on the original player columns, including cached-page changes',()=>{
    const {scene,frame}=renderer(),state=emptyWorld('coop');state.phase='won';
    const check=(text:string,x:number,y:number,color:number)=>{
      const expected=new PixelCanvas(text.length*8,8),g=new ImagePixels({width:expected.width,height:8,data:expected.data} as ImageData);
      g.place(0,0,expected.width,8);g.fillStyle(0);g.fillRect(0,0,expected.width,8);drawText(g,text,0,0,color);
      expect(hashPixels(crop(frame(),x,y,expected.width,8).data)).toBe(hashPixels(expected.data));
    };
    for(const player of [0,1] as const){scene.presentation={kind:'score',state,highScore:20000,elapsedMs:6000,bonusPlayer:player};scene.update(0,0);
      const x=player===0?24:176;check('BONUS!',x,200,PALETTE.red);check('1000',x,208,PALETTE.white);check('PTS',x+40,208,PALETTE.white);}
  });
  it('keeps tanks below foliage and impact, explosion and item ink above it', () => {
    const {scene,images}=renderer(),state=emptyWorld();
    for(let row=8;row<12;row++)for(let col=8;col<12;col++) state.tiles[row*26+col]=Tile.Forest;
    state.bullets=[{id:1,team:'player',playerIndex:0,gunSlot:0,x:72,y:72,direction:'up',speed:2,steelPower:false,impactTicks:9}];
    const tank = new GameEngine(getLevel(1), {mode:'single',stage:1}).state.tanks[0];
    Object.assign(tank,{x:64,y:64,spawnTicks:0,deathTimer:0x43});state.tanks=[tank];state.powerUp={kind:'star',x:64,y:64};
    state.tick=8;scene.state=state;scene.presentation={kind:'game'};scene.update(0,0);
    const foliage=images.find(i=>i.visible && i.texture.key==='arena-forest')!;
    for(const name of ['impact:0','explosion:3','item:star']) {
      const image=images.find(i=>i.visible && i.frame.name===name)!;
      expect(image, name).toBeDefined();expect(image.depth,name).toBeGreaterThan(foliage.depth);
    }
  });
  it('blinks an uncollected item eight frames on/off without removing the item', () => {
    const {scene,images}=renderer(),state=emptyWorld();const item={kind:'star' as const,x:64,y:64};state.powerUp=item;
    scene.state=state;scene.presentation={kind:'game'};
    for(let tick=0;tick<32;tick++) {
      state.tick=tick;scene.update(0,0);
      expect(images.some(i=>i.visible && i.frame.name==='item:star')).toBe((tick&8)!==0);
      expect(state.powerUp).toBe(item);
    }
  });
  it('centers native effects at visible sprite Y and uses continuous shield phases', () => {
    const { scene, images } = renderer(), state = emptyWorld();
    state.tanks = [{ ...state.players[0], id: 1, team: 'player', playerIndex: 0, enemySlot: null, kind: 'basic', x: 64, y: 80,
      direction: 'up', hp: 1, stars: 0, shieldTicks: 10, spawnTicks: 0, deathTimer: 0, deathPoints: 0, stunTicks: 0, aiTicks: 0, aiTurn: false, aiTarget: false, tread: 0 as const, slideTicks: 0, moving: false, carryingPowerUp: false }];
    const original = tankBitmap(state.tanks[0], 0), alternate = tankBitmap(state.tanks[0], 1);
    for (let y = 0; y < 16; y++) expect(alternate[y].slice(4,11)).toBe(original[y].slice(4,11));
    state.effects = [{x:72,y:72,value:500,remainingTicks:10}];
    scene.state = state; scene.presentation = {kind:'game'};
    for (const tick of [0,1,2,3]) {
      state.tick=tick; scene.update(0,0);
      expect(images.some(i=>i.visible && i.frame.name === `shield:${(tick>>1)&1}` && i.x===80 && i.y===97)).toBe(true);
      expect(images.some(i=>i.visible && i.frame.name === 'points:500' && i.x===80 && i.y===81)).toBe(true);
    }
    const tank = state.tanks[0]; Object.assign(tank,{team:'enemy',playerIndex:null,kind:'armor',hp:2});
    expect(tankFrame(tank,0,0)).toContain(':hp2:'); expect(tankFrame(tank,0,1)).toContain(':hp4:');
    tank.carryingPowerUp=true; expect(tankFrame(tank,0,8)).toContain(':flash:');
  });
});
