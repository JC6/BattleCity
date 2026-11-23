#include <string.h>
/* Battle City homebrew cartridge. Coordinates are pixels in the 208 x 208
 * arena. */
typedef unsigned char u8;
typedef unsigned int u16;
#define REG(a) (*(volatile u8 *)(a))
#define OAM ((u8 *)0x0200)
#define START 16
#define SELECT 32
#define FIRE 192
#define LIVE_SHOTS (SLOTS + 2)
#define SLOTS 8
#define GRENADE_BLAST_KIND 4  /* Explodes without a kill-score label. */
#define ACTIVE 1
#define SPAWNING 29  /* countdown to ACTIVE on eligible movement updates */
#define DYING 32
#define BLAST_START (DYING + 24)  /* six 3-update phases, then 6 updates */
enum { TITLE, FIELD, EDIT, RESULT, OVER, PAUSE, CHOOSE_STAGE, GAME_OVER_PAGE, RECORD_PAGE };
enum { EMPTY, BRICK, STEEL, WATER, TREES, ICE, BASE };
enum {
  MUSIC_PAUSE, STAGE_PULSE1, STAGE_TRIANGLE, STAGE_PULSE2, LIFE_PULSE1, LIFE_PULSE2,
  PICKUP_SOUND, PLAYER_BLAST, UNUSED_SOUND, APPEAR_SOUND, ENEMY_BLAST, BASE_BLAST,
  BRICK_HIT, WALL_HIT, TANK_HIT, SHOT_SOUND, ICE_SOUND, PLAYER_MOTOR, ENEMY_MOTOR,
  COUNT_PULSE, COUNT_NOISE, RECORD_PULSE1, RECORD_PULSE2, RECORD_TRIANGLE,
  OVER_PULSE1, OVER_PULSE2, OVER_TRIANGLE, COOP_BONUS_SOUND
};
extern volatile u8 audio_commands[], audio_clear, audio_paused;
#define PLAY_CUE(id) (audio_commands[(id)] = 1)
#define STOP_CUE(id) (audio_commands[(id)] = 2)
typedef struct {
  u8 x, y, dir, alive, hp, kind;
  u8 decision;
  u8 stars, slide, stun, carrier;
  u16 shield;
} Tank;
typedef struct {
  u8 x, y, dir, active;
} Shot;
extern const u8 maps[35][85], enemies[35][5], enemy_groups[35][4], large_letters[];
/* Layout emitted by build.py: four rows, four tiles per letter. */
enum {
  WORD_BATTLE, WORD_CITY = WORD_BATTLE + 6 * 16, WORD_GAME = WORD_CITY + 4 * 16,
  WORD_OVER = WORD_GAME + 4 * 16, WORD_HISCORE = WORD_OVER + 4 * 16,
  WORD_DIGITS = WORD_HISCORE + 7 * 16
};
extern u8 pads[2], dirty_count, dirty_high[], dirty_low[], dirty_tile[];
void wait_frame(void);
void read_pads(void);
void draw_demo_bricks(void);
Tank tanks[SLOTS];
/* Indexing a 13-byte structure otherwise emits a software multiply on 6502. */
static Tank *const tank_slots[SLOTS] = {
  tanks, tanks+1, tanks+2, tanks+3, tanks+4, tanks+5, tanks+6, tanks+7
};
extern u8 tread[SLOTS], video_clock, curtain_pair;
#pragma zpsym ("tread")
#pragma zpsym ("video_clock")
#pragma zpsym ("curtain_pair")
Shot shots[LIVE_SHOTS];
u8 board[169];
static u8 design[169], lives[2], kills[2][4];
extern u8 press[2];
static unsigned long scores[2], high_score;
static u8 score_digits[2][7];
#pragma bss-name (push,"ZEROPAGE")
u8 high_digits[8];
#pragma bss-name (pop)
u8
    missing_bricks[26 * 13]; /* two 8px cells per byte, four bits per cell */
u16 freeze;
static u16 fortify, battle_ticks;
static u16 end_delay;
enum { STAGE_LIVE, STAGE_WON, STAGE_LOST };
static u8 ending, ruined, tally_row, counted[2], totals[2], tally_frame;
static void game_over_page(void);
u8 rng, rng_index, combat_frame, clock_high;
#pragma bss-name (push,"ZEROPAGE")
static u8 sprite_phase;
#pragma bss-name (pop)
static u8 clock_origin, demo, paused_sprites, eliminated_timer, eliminated_side;
extern u8 title_scroll;
#pragma zpsym ("title_scroll")
u8 actor_slot;
static u8 impact_slot, random_phase, target_x, target_y;
u8 last_drawn, draw_x, draw_y, draw_tile, draw_palette, pointer_row;
u8 end_sprite_x, end_sprite_y;
extern u8 field_low[8], field_high[8];
extern u8 next_x, next_y, probe_dx, probe_dy;
static u8 collision_y, collision_x;
u8 shot_fast[LIVE_SHOTS], shot_blast[LIVE_SHOTS];
extern u8 sound_loops[3], probe_shot, empty_spawn_bytes, respawn_slot, tally_armor[2];
#pragma zpsym ("respawn_slot")
#pragma zpsym ("tally_armor")
#pragma zpsym ("sound_loops")
#pragma zpsym ("probe_shot")
#pragma zpsym ("empty_spawn_bytes")
u8 has_trees, shell_probe_x, shell_probe_y, shield_sprites;
static u8 group_left[4], group_index, player_flags[2];
extern u8 sound_source[2], sound_work[2], sound_channels;
#pragma zpsym ("sound_source")
#pragma zpsym ("sound_work")
#pragma zpsym ("sound_channels")
u8 seen_active, seen_tanks;
static u8 hud_row;
u8 seen_shots_lo, seen_shots_hi;
u16 field_ptr;
enum { MOVING, FIRING, DROPPING };
enum { ADVANCE, WAIT_ONE, WAIT_TWO, TURN, FOLLOW_P1, FOLLOW_P2, FOLLOW_BASE };
static const u8 slot_bits[]={1,2,4,8,16,32,64,128};
static u8 mode, selection, stage;
u8 players;
static u8 spawned, defeated, spawn_clock;
u8 frame, used_sprites;
static u8 cursor_x, cursor_y, brush, custom;
u8 bonus_x, bonus_y, bonus, bonus_points;
static u8 bonus_code, bonus_player;
static u8 hud_dirty, editor_painted, repeat_delay, motor;
static unsigned long next_life[2];
static const u8 masks[] = {10, 12, 5, 3, 15};
static const u8 palettes[] = {
  15,23,6,0, 15,0,16,32, 15,60,16,18, 15,41,9,11,
  15,24,39,56, 15,10,27,59, 15,12,16,32, 15,4,22,32
};

static void ppu(u16 addr) {
  REG(0x2006) = addr >> 8;
  REG(0x2006) = addr;
}
static void text(u8 x, u8 y, const char *s) {
  ppu(0x2000u + (u16)y * 32 + x);
  while (*s)
    REG(0x2007) = *s++;
}
static void number(u8 x, u8 y, unsigned long value, u8 digits) {
  char buffer[8];
  buffer[digits] = 0;
  while (digits) {
    buffer[--digits] = '0' + value % 10;
    value /= 10;
  }
  while (buffer[digits]=='0' && buffer[digits+1]) buffer[digits++]=' ';
  text(x, y, buffer);
}
void hide_sprites(void);
static void begin_screen(void) {
  u16 i;
  audio_clear = 1;
  audio_paused = 0;
  motor = 0;
  wait_frame();
  REG(0x2001) = 0;
  hide_sprites();
  ppu(0x2000);
  for (i = 0; i < 1024; ++i)
    REG(0x2007) = 0;
}
static void end_screen(void) {
  wait_frame();
  REG(0x2001) = 0x1e;
}
static void enqueue(u16 addr, u8 tile) {
  u8 i = dirty_count;
  if (i < 32) {
    dirty_high[i] = addr >> 8;
    dirty_low[i] = addr;
    dirty_tile[i] = tile;
    dirty_count = i + 1;
  }
}
u8 random8(void);
static void sprite(u8 x, u8 y, u8 tile, u8 palette) {
  u8 i = used_sprites;
  if (i >= 252)
    return;
  OAM[i] = y + 15;
  OAM[i + 1] = tile;
  OAM[i + 2] = palette;
  OAM[i + 3] = x + 16;
  used_sprites += 4;
}
extern u8 __fastcall__ terrain(u8 x, u8 y);
void __fastcall__ draw_tank(u8 i);
static void title_cursor(void) {
  u8 q;
  hide_sprites();
  for (q = 0; q < 4; q++)
    sprite(48 + (q & 1) * 8, 116 + selection * 16 + (q >> 1) * 8, 4 + q, 0);
}
/* Four tile rows per word. Digits share a forty-tile-wide strip. */
static void brick_word(u8 x, u8 y, const u8 *tiles, u8 width, u8 stride) {
  u8 row, col;
  for (row = 0; row < 4; ++row) {
    ppu(0x2000u + (u16)(y + row) * 32 + x);
    for (col = 0; col < width; ++col) REG(0x2007) = tiles[col];
    tiles += stride;
  }
}
static void title_score(u8 end, unsigned long score) {
  if (score) number(end-7,3,score,7);
  else text(end-2,3,"00");
}
static void title(void) {
  u8 show_second=demo ? selection==1 : players==2;
  begin_screen();
  title_scroll=demo ? 3 : 1;
  sprite_phase=0; demo=0; mode=TITLE;
  counted[0]=0x9c; counted[1]=0x56;
  totals[0]=255; totals[1]=0;
  battle_ticks=0;
  ppu(0x3f01);
  REG(0x2007) = 6; REG(0x2007) = 22; REG(0x2007) = 48;
  brick_word(3, 6, large_letters + WORD_BATTLE, 24, 24);
  brick_word(8, 11, large_letters + WORD_CITY, 16, 16);
  title_score(10,scores[0]);
  title_score(20,high_score);
  text(2,3,"I-");
  text(11,3,"HI-");
  if (show_second) {
    title_score(29,scores[1]);
    text(21,3,"II-");
  }
  text(11, 17, "1 PLAYER");
  text(11, 19, "2 PLAYERS");
  text(11, 21, "CONSTRUCTION");
  text(11, 23, "\xa0\xa1\xa2\xa3\xa4\xa5\xa6\xa7\xa8");
  text(11, 25, "\xa9" "1985 BNEI");
  end_screen();
}
#pragma static-locals (push,on)
#pragma bss-name (push,"ZEROPAGE")
static u8 block(u8 x, u8 y) { return (y >> 4) * 13 + (x >> 4); }
static u8 quadrant(u8 x, u8 y) {
  return 1u << (((y & 8) >> 2) + ((x & 8) >> 3));
}
static void set_brick_parts(u8 x, u8 y, u8 remaining) {
  u8 *pair = &missing_bricks[(u16)(y >> 3) * 13 + (x >> 4)];
  u8 missing = 15 ^ remaining;
  if (x & 8)
    *pair = (*pair & 15) | (missing << 4);
  else
    *pair = (*pair & 240) | missing;
}
#pragma bss-name (pop)
#pragma static-locals (pop)
static u8 decode(u8 code) {
  if (code < 5)
    return 16 + masks[code];
  if (code < 10)
    return 32 + masks[code - 5];
  if (code <= 12)
    return ((code - 7) << 4) | 15;
  return 0;
}
static const u8 tile_palette[] = {0,0,1,2,3,1,0};
static u8 attribute(u8 x, u8 y) {
  u8 v = 0, q, k, bx, by;
  for (q = 0; q < 4; q++) {
    bx = x * 2 + (q & 1);
    by = y * 2 + (q >> 1);
    k = bx >= 14 ? 0 : 1;
    if (bx >= 1 && bx <= 13 && by >= 1 && by <= 13) {
      k = board[(by - 1) * 13 + bx - 1] >> 4;
      k = tile_palette[k];
    }
    v |= k << (q * 2);
  }
  return v;
}
static void fortress(u8 material) {
  u8 wall=material<<4;
  board[12 * 13 + 6] = BASE * 16 + 15;
  board[11 * 13 + 6] = wall + 12;
  board[11 * 13 + 5] = wall + 8;
  board[11 * 13 + 7] = wall + 4;
  board[12 * 13 + 5] = wall + 10;
  board[12 * 13 + 7] = wall + 5;
}
static void finish_map(void) {
  if (!custom && (stage % 35 == 9 || stage % 35 == 20)) {
    u8 x, y;
    for (x = 10; x <= 15; x += 5)
      for (y = stage % 35 == 9 ? 23 : 22; y <= (stage % 35 == 9 ? 25 : 23); y++)
        board[block(x * 8, y * 8)] &= ~quadrant(x * 8, y * 8);
  }
  if (!custom && stage % 35 == 20) {
    u8 x;
    for (x = 11; x <= 14; x++)
      board[block(x * 8, 176)] &= ~quadrant(x * 8, 176);
  }
  fortress(BRICK);
}
static u8 field_tile(u8 x, u8 y) {
  u8 tile = terrain(x * 8, y * 8);
  return tile == BASE ? 8 + (x & 1) + 2 * (y & 1) : tile;
}
/* HUD digits are drawn dark on the gray margin. */
static void hud_number(u8 row, u8 n) {
  u16 addr = 0x201du + (u16)row * 32;
  enqueue(addr, n < 10 ? (row == 25 ? 14 : 22) : 200 + n / 10);
  enqueue(addr + 1, 200 + n % 10);
}
static void field_screen(void) {
  u8 x, y;
  begin_screen();
  ppu(0x2000);
  for (y = 0; y < 30; y++)
    for (x = 0; x < 32; x++)
      REG(0x2007) =
          (x >= 2 && x < 28 && y >= 2 && y < 28) ? field_tile(x - 2, y - 2) : 7;
  ppu(0x23c0);
  for (y = 0; y < 8; y++)
    for (x = 0; x < 8; x++)
      REG(0x2007) = attribute(x, y);
  if (mode == EDIT) {
    text(29, 4, "ED");
  } else {
    for (y = 0; y < 10; y++) {
      ppu(0x207du + (u16)y * 32);
      REG(0x2007) = 12;
      REG(0x2007) = 12;
    }
    ppu(0x223d);
    REG(0x2007) = 201;
    REG(0x2007) = 210;
    if (players == 2) {
      ppu(0x229d);
      REG(0x2007) = 202;
      REG(0x2007) = 210;
    }
    ppu(0x22fd);
    REG(0x2007) = 13;
    hud_number(25, stage + 1);
    hud_dirty = 1;
  }
  end_screen();
}
/* Each transfer replaces two complete nametable rows during vblank. */
static void close_curtain(void) {
  u8 i;
  audio_clear = 1;
  audio_paused = motor = 0;
  hide_sprites();
  enqueue(0x3f01, palettes[1]); enqueue(0x3f02, palettes[2]);
  for (i = 0; i < 4; ++i) enqueue(0x3f03 + i * 4, 0);
  for (i = 0; i < 16; ++i) {
    curtain_pair = 128 + i + 1;
    wait_frame();
  }
}
static void stage_label(void) {
  u8 i, n = stage + 1;
  for (i = 0; i < 5; ++i) enqueue(0x21cc + i, 212 + i);
  enqueue(0x21d2, n >= 10 ? 240 + n / 10 : 14);
  enqueue(0x21d3, 240 + n % 10);
}
static void arena_row(u8 *dest, u8 y) {
  u8 x, row = (y - 2) >> 1, bottom = y & 1;
  memset(dest,7,28);
  memset(dest+28,14,4);
  if (y >= 2 && y < 28) {
    const u8 *cells = board + (u16)row * 13;
    for (x = 0; x < 13; ++x) {
      u8 cell = cells[x], tile = cell >> 4;
      u8 mask = bottom ? cell >> 2 : cell;
      u8 col = 2 + 2 * x;
      if (tile == BASE) {
        dest[col] = 8 + bottom * 2;
        dest[col+1] = 9 + bottom * 2;
      } else {
        dest[col] = tile;
        dest[col+1] = tile;
      }
      if (!(mask & 1)) dest[col] = 0;
      if (!(mask & 2)) dest[col+1] = 0;
    }
  }
  if (y >= 3 && y <= 12) dest[29] = dest[30] = 12;
  if (y == 17 || (players == 2 && y == 20)) {
    dest[29] = y == 17 ? 201 : 202;
    dest[30] = 210;
  }
  if (y == 23 || y == 24) {
    dest[29] = 24 + 2*(y-23); dest[30] = dest[29]+1;
  }
}
static void open_curtain(void) {
  u8 i = 16;
  while (i) {
    --i;
    wait_frame();
    arena_row(dirty_high, i);
    arena_row(dirty_low, 29-i);
    curtain_pair = i+1;
  }
}
static void clear_entry(u8 x, u8 y) {
  u8 index = block(x,y), q;
  u16 addr;
  /* The reference queues four tiles and an attribute even on clear ground.
     Account for that buffer space without uploading five unchanged tiles. */
  if (!board[index]) { empty_spawn_bytes+=20; return; }
  board[index] = 0;
  addr = 0x2042u + (u16)(y >> 3) * 32 + (x >> 3);
  for (q = 0; q < 4; ++q) {
    set_brick_parts(x + 8*(q&1), y + 8*(q>>1), 15);
    enqueue(addr + (q&1) + 32*(q>>1), 0);
  }
  enqueue(0x23c0u + (u16)((y+16)>>5)*8 + ((x+16)>>5), attribute((x+16)>>5,(y+16)>>5));
}
static void reset_tank(u8 i, u8 kind, u8 x, u8 y) {
  Tank *t = tank_slots[i];
  t->x = x;
  t->y = y;
  t->dir = i < 2 ? 0 : 2;
  t->kind = kind;
  t->alive = SPAWNING;
  seen_tanks |= slot_bits[i];
  if (i<2) respawn_slot=i+1;
  clear_entry(x,y);
  t->hp = kind == 3 ? 4 : 1;
  t->decision = ADVANCE;
  t->shield = 0;
  t->stars = t->stun = t->carrier = 0;
}
static void start_stage(void) {
  u8 i, j, stars, offset = 0;
  const u8 *map = maps[stage % 35];
  if (!demo) {
    PLAY_CUE(STAGE_PULSE1); PLAY_CUE(STAGE_TRIANGLE); PLAY_CUE(STAGE_PULSE2);
  }
  if (demo) {
    /* Sparse scenery observed in the idle demonstration. */
    static const u8 cells[]={13,19,25,117,129,130,131,141,142,143,144,145,153,154,155,156,157,158,159,165,166,167,168};
    static const u8 kinds[]={6,6,6,11,11,11,11,11,11,9,11,11,11,11,9,9,9,11,11,11,11,9,9};
    memset(board,0,sizeof(board));
    for (i=0;i<sizeof(cells);++i) board[cells[i]]=decode(kinds[i]);
  } else if (custom) {
    for (i = 0; i < 169; ++i) board[i] = design[i];
  } else {
    for (i = 0; i < 13; ++i) {
      for (j = 0; j < 13; ++j, ++offset) {
        u8 pair=map[offset>>1];
        board[offset]=decode((offset&1) ? pair>>4 : pair&15);
      }
      wait_frame();
    }
  }
  finish_map();
  has_trees=0;
  for (i=0;i<169;++i) if ((board[i]>>4)==TREES) { has_trees=1; break; }
  memcpy(group_left, enemy_groups[stage < 35 && !demo ? stage : 34], sizeof(group_left));
  group_index = 0;
  ending = ruined = eliminated_timer = 0;
  spawned = defeated = 0;
  memset(shot_blast,0,sizeof(shot_blast));
  spawn_clock = 0;
  /* Ice momentum survives a lost life and resets between stages. */
  tanks[0].slide = tanks[1].slide = 0;
  bonus_x = bonus = bonus_points = 0;
  freeze = fortify = battle_ticks = 0;
  {
    memset(missing_bricks, 0, sizeof(missing_bricks));
    for (i = 0; i < 4; i++)
      kills[0][i] = kills[1][i] = 0;
  }
  for (i = 0; i < SLOTS; i++)
    tank_slots[i]->alive = 0;
  for (i = 0; i < LIVE_SHOTS; i++)
    shots[i].active = 0;
  if (demo) {
    field_screen();
    wait_frame(); REG(0x2001)=0;
    draw_demo_bricks();
    end_screen();
  } else {
    for (i=0; i<64; ++i) {
      enqueue(0x23c0u+i,attribute(i&7,i>>3));
      wait_frame();
    }
    open_curtain();
  }
  wait_frame();
  for (i=0; i<4; ++i) enqueue(0x3f03+i*4,palettes[3+i*4]);
  for (i = 0; i < players; i++)
    if (lives[i]) {
      stars = tank_slots[i]->stars;
      reset_tank(i, 0, i ? 128 : 64, 192);
      tank_slots[i]->stars = stars;
    }
  wait_frame();
  hud_row = players==2 ? 21 : 18;
  hud_number(25,stage+1);
  hud_dirty = 1;
  wait_frame();
  if (demo) {
    wait_frame(); wait_frame();
    /* The original resets its counter while preparing the demo nametable. */
    clock_origin=video_clock-17;
    audio_paused=1; sound_work[1]=0;
    counted[1]=0x78;
    next_life[0]=next_life[1]=20000ul;
  }
  combat_frame = video_clock-clock_origin;
  /* The high counter is cleared at player spawn, two vblanks before the HUD is ready. */
  clock_high = (combat_frame & 63) < 2;
  PLAY_CUE(ENEMY_MOTOR);
  mode = FIELD;
}
static void award(u8 player, u8 hundreds);

static void next_stage(void) {
  /* Three display frames during the map transition have NMI disabled. */
  sprite_phase ^= 1;
  custom = 0;
  stage = (stage + 1) % 70;
  wait_frame();
  close_curtain();
  stage_label();
  wait_frame();
  start_stage();
}
static void result(void) {
  u8 p, k, q, start = video_clock;
  tally_row=0;
  /* The reference suspends the game clock while drawing the score page. */
  clock_origin += 3;
  begin_screen();
  mode = ending == STAGE_WON ? RESULT : OVER;
  /* Three text colours on a black field. Each attribute quadrant is 16px. */
  ppu(0x3f03); REG(0x2007)=48;
  ppu(0x3f07); REG(0x2007)=22;
  ppu(0x3f0b); REG(0x2007)=39;
  ppu(0x23c0);
  for (q=0;q<3;++q) {
    static const u8 attrs[24]={0,0,80,80,160,160,0,0, 80,80,80,0,0,80,80,80, 10,10,10,0,0,10,10,10};
    for (k=0;k<8;++k) REG(0x2007)=attrs[8*q+k];
  }
  text(8,3,"HI-SCORE"); number(18,3,high_score,6);
  text(12,5,"STAGE"); number(18,5,stage+1,2);
  text(6,23,"TOTAL");
  ppu(0x22cc); for (q=0;q<8;++q) REG(0x2007)=20;
  for (p=0; p<players; ++p) {
    text(p ? 21 : 3,7,p ? "II-PLAYER" : "I-PLAYER");
    number(p ? 22 : 4,9,scores[p],7);
    totals[p]=counted[p]=0;
    for (k=0;k<4;++k) {
      text(p ? 26 : 8,12+k*3,"PTS");
      text(p ? 17 : 14,12+k*3,p ? ">" : "<");
      totals[p]+=kills[p][k];
    }
  }
  for (k=0;k<4;++k)
    for (q=0;q<4;++q)
      sprite(104+(q&1)*8,76+k*24+(q>>1)*8,64+k*16+q,2);
  end_screen();
  tally_row=0;
  tally_frame=start+(players==2 ? 42 : 40);
}
static void queue_digits(u16 end, u16 n) {
  do {
    enqueue(end--,'0'+n%10);
    n/=10;
  } while (n);
}
static void tally(void) {
  u8 p, n, active=0;
  u16 row;
  if ((signed char)(frame-tally_frame)<0) return;
  if (tally_row<4) {
    row=0x2180u+(u16)tally_row*96;
    for (p=0; p<players; ++p) {
      n=counted[p];
      if (n<kills[p][tally_row]) { ++n; counted[p]=n; active=1; }
      queue_digits(row+(p ? 19 : 13),n);
      queue_digits(row+(p ? 25 : 6),(u16)n*(tally_row+1)*100);
    }
    if (active) {
      PLAY_CUE(COUNT_PULSE); PLAY_CUE(COUNT_NOISE);
      tally_frame+=9;
    } else {
      if (tally_row<3) counted[0]=counted[1]=0;
      ++tally_row;
      tally_frame+=tally_row==4 ? 38 : 30;
    }
  } else if (tally_row==4) {
    /* The final row's two point totals remain in the decimal score buffers. */
    tally_armor[0]=counted[0]+1;
    tally_armor[1]=counted[1]+1;
    for (p=0;p<players;++p) queue_digits(0x22e0u+(p ? 19 : 13),totals[p]);
    ++tally_row; tally_frame+=15;
  } else if (tally_row==5) {
    if (ending==STAGE_WON && players==2 && totals[0]!=totals[1]) {
      p=totals[1]>totals[0];
      if (lives[p]) {
        PLAY_CUE(COOP_BONUS_SOUND);
        award(p,10);
        queue_digits(0x2340u+(p ? 25 : 6),1000);
        row=0x2320u+(p ? 22 : 3);
        for (n=0;n<5;++n) enqueue(row+n,"BONUS"[n]);
        row=0x2120u+(p ? 29 : 11);
        {
          unsigned long score=scores[p];
          for (n=0;n<7;++n) { enqueue(row--,'0'+score%10); score/=10; }
        }
      }
    }
    ++tally_row; tally_frame+=120;
  } else if (ending==STAGE_WON) next_stage();
  else game_over_page();
}
static void game_over_page(void) {
  begin_screen();
  mode = GAME_OVER_PAGE;
  brick_word(8, 9, large_letters + WORD_GAME, 16, 16);
  brick_word(8, 16, large_letters + WORD_OVER, 16, 16);
  end_screen();
  battle_ticks = 0;
  PLAY_CUE(OVER_PULSE1);
  PLAY_CUE(OVER_PULSE2);
  PLAY_CUE(OVER_TRIANGLE);
}
static void finish_game(void) {
  unsigned long best = scores[0] > scores[1] ? scores[0] : scores[1];
  u8 x = 26;
  if (best <= high_score) {
    title();
    return;
  }
  high_score = best;
  memcpy(high_digits,score_digits[scores[1]>scores[0]],7);
  begin_screen();
  mode = RECORD_PAGE;
  ppu(0x3f01);
  REG(0x2007) = 15; REG(0x2007) = 6; REG(0x2007) = 0;
  brick_word(2, 6, large_letters + WORD_HISCORE, 28, 28);
  do {
    brick_word(x, 13, large_letters + WORD_DIGITS + (u8)(best % 10) * 4, 4, 40);
    x -= 4;
    best /= 10;
  } while (best);
  end_screen();
  battle_ticks = 0;
  PLAY_CUE(RECORD_PULSE1);
  PLAY_CUE(RECORD_PULSE2);
  PLAY_CUE(RECORD_TRIANGLE);
}
void snapshot_occupancy(void);
u8 __fastcall__ move_tank(u8 i, u8 direction);
void __fastcall__ fire(u8 i);
static u8 spawn_interval(void) {
  return 190 - 4 * (stage < 35 ? stage + 1 : 35) - (players == 2 && (!demo || selection == 1) ? 20 : 0);
}
#pragma static-locals (push,on)
#pragma bss-name (push,"ZEROPAGE")
#include "combat-random.inc"

#pragma bss-name (pop)
#pragma static-locals (pop)
static void spawn_enemy(void) {
  static const u8 entries[] = {96,192,0};
  u8 i, x, limit = players == 2 && !demo ? 7 : 5;
  if (spawn_clock) {
    --spawn_clock;
    return;
  }
  if (spawned >= 20) return;
  for (i = limit; i >= 2 && tank_slots[i]->alive; --i) {}
  if (i < 2) return;
  x = entries[spawned % 3];
  reset_tank(i, (enemies[stage < 35 && !demo ? stage : 34][spawned>>2] >> (2*(spawned & 3))) & 3, x, 0);
  tank_slots[i]->carrier = (spawned == 3 || spawned == 10 || spawned == 17);
  if (tank_slots[i]->carrier) bonus_x = bonus = 0;
  spawned++;
  enqueue(0x207du + (u16)((20 - spawned) >> 1) * 32 + ((20 - spawned) & 1), 14);
  spawn_clock = spawn_interval();
}
static void award(u8 player, u8 hundreds) {
  static const u16 points[]={0,100,200,300,400,500,600,700,800,900,1000};
  u8 digit=4, carry=hundreds;
  /* Every award is a multiple of 100. Keep the seven score digits available
     to the random mixer without a 32-bit division in the battle loop. */
  if (demo) return;
  while (carry) {
    u8 n=score_digits[player][digit]+carry;
    carry=n>=10;
    score_digits[player][digit]=carry ? n-10 : n;
    if (!digit) break;
    --digit;
  }
  scores[player] += points[hundreds];
  if (next_life[player] && scores[player] >= next_life[player]) {
    PLAY_CUE(LIFE_PULSE1);
    PLAY_CUE(LIFE_PULSE2);
    next_life[player] = 0;
    ++lives[player];
    hud_dirty = 1;
  }
  if (scores[player] >= 10000000ul)
    scores[player] -= 10000000ul;
}
static void score_enemy(u8 target, u8 owner) {
  Tank *t = tank_slots[target];
  PLAY_CUE(ENEMY_BLAST);
  t->alive = BLAST_START;
  t->decision = 1;
  ++kills[owner][t->kind];
  award(owner, t->kind+1);
}
static u8 near_bonus(const Tank *t) {
  return t->alive==ACTIVE && (u8)(t->x-bonus_x+11)<23 && (u8)(t->y-bonus_y+11)<23;
}
static u8 bonus_picker(void) {
  if (near_bonus(&tanks[1])) return 1;
  if (near_bonus(&tanks[0])) return 0;
  return 255;
}
static void drop_bonus(void) {
  static const u8 kinds[] = {2, 3, 6, 1, 5, 4, 5, 1};
  static const u8 codes[] = {0,3,0,1,5,4,2};
  if (probe_shot<LIVE_SHOTS) {
    Shot *s=&shots[probe_shot];
    u8 x=s->x+17+(s->dir&1), y=s->y+18-(s->dir&1);
    field_ptr=0x400u+((u16)(y&248)<<2)+(x>>3);
  }
  random_phase = DROPPING;
  do {
    pointer_row = random8() & 3;
    bonus_x = 24 + pointer_row * 48;
    pointer_row = random8() & 3;
    bonus_y = 24 + pointer_row * 48;
    bonus_code = 255;
    bonus_player = bonus_picker();
    bonus_points = bonus_player < 2 ? 50 : 0;
  } while (bonus_points);
  bonus = kinds[random8() & 7];
  bonus_code = codes[bonus];
  PLAY_CUE(APPEAR_SOUND);
}
static void hit_tank(u8 i, u8 owner) {
  Tank *t = tank_slots[i];
  if (t->shield)
    return;
  if (i >= 2) {
    if (t->carrier) {
      actor_slot=i;
      drop_bonus();
      if (t->kind==3) t->carrier = 0;
    }
    if (--t->hp == 0)
      score_enemy(i, owner);
    else
      PLAY_CUE(TANK_HIT);
    return;
  }
  t->alive = BLAST_START;
  t->stars = 0;
  PLAY_CUE(PLAYER_BLAST);
}
void advance_shots(void);
u8 __fastcall__ shell_impact(u8 index);
void resolve_shots(void);
void __fastcall__ projectile(u8 index) {
  static Shot *s;
  static u8 hit,j;
  s=&shots[index];
  if (shot_fast[index] || ((index^combat_frame)&1)) {
    collision_y=(s->dir&1) ? 4 : 0; collision_x=4-collision_y;
    hit=shell_impact(index);
    if (hit) {
      s->active=0; shot_blast[index]=9;
      if (hit==BASE) {
        if (!ruined) {
          ruined=1; ending=STAGE_LOST; end_delay=295;
          for (j=0;j<4;++j)
            enqueue(0x234eu+(j&1)+(j>>1)*32,16+j);
          PLAY_CUE(BASE_BLAST); PLAY_CUE(PLAYER_BLAST);
        }
      }
      return;
    }
  }
}

/* The collision scan visits tanks in hardware slot order. A newly stunned or
   destroyed tank ends its scan, while armour and shields can take more hits. */
u8 contact_target;
u8 __fastcall__ strike_tank(u8 index) {
  u8 owner=index&7;
  Tank *t=tank_slots[contact_target];
  shots[index].active=0;
  if (t->shield) return 0;
  shot_blast[index]=9;
  if (contact_target<2 && owner<2) {
    if (demo || t->stun) return 0;
    t->stun=200;
    return 1;
  }
  impact_slot=index;
  hit_tank(contact_target,owner);
  return t->alive!=ACTIVE;
}
static void set_walls(u8 material) {
  /* The base surround occupies eight tiles and two attribute bytes. Restore
     its 4px brick parts without disturbing the outside half of either corner. */
  static const u16 wall_tiles[] = {
    0x2042+23*32+11, 0x2042+23*32+12, 0x2042+23*32+13, 0x2042+23*32+14,
    0x2042+24*32+11, 0x2042+24*32+14, 0x2042+25*32+11, 0x2042+25*32+14
  };
  u8 i;
  fortress(material);
  missing_bricks[23*13+5] &= 15;
  missing_bricks[23*13+6] = 0;
  missing_bricks[23*13+7] &= 240;
  missing_bricks[24*13+5] &= 15;
  missing_bricks[24*13+7] &= 240;
  missing_bricks[25*13+5] &= 15;
  missing_bricks[25*13+7] &= 240;
  for (i=0;i<8;++i) enqueue(wall_tiles[i],material);
  /* Only the eastern pair of quadrants can contain unrelated terrain. */
  enqueue(0x23f3,material==STEEL ? 0x15 : 0);
  enqueue(0x23f4,(material==STEEL ? 0x11 : 0)
                  | (tile_palette[board[11*13+8]>>4]<<2)
                  | (tile_palette[board[12*13+8]>>4]<<6));
}
#pragma static-locals (push,on)
#pragma bss-name (push,"ZEROPAGE")
void __fastcall__ drive_player(u8 i) {
  Tank *t = tank_slots[i];
  if ((combat_frame & 3)==2) return;
  if ((player_flags[i]&0xf0)==0xa0) {
    move_tank(i,t->dir);
  } else if (t->slide>128) {
    --t->slide;
    tread[i]^=8;
    move_tank(i,t->dir);
  } else {
    player_flags[i]-=4;
    if (!(player_flags[i]&12)) { player_flags[i]=(player_flags[i]&3)|0xa0; pointer_row=0xa0; }
  }
}
static void collect_bonus(u8 i) {
  u8 j;
  if (bonus == 1) {
    if (tank_slots[i]->stars < 3)
      ++tank_slots[i]->stars;
  }
  if (bonus == 2)
    tank_slots[i]->shield = 640 - (combat_frame & 63);
  if (bonus == 3)
    freeze = 640 - (combat_frame & 63);
  if (bonus == 4) {
    PLAY_CUE(LIFE_PULSE1);
    PLAY_CUE(LIFE_PULSE2);
    ++lives[i];
    hud_dirty = 1;
  }
  if (bonus == 5) {
    PLAY_CUE(ENEMY_BLAST);
    for (j = 2; j < SLOTS; j++)
      if (tank_slots[j]->alive == ACTIVE) {
        tank_slots[j]->alive = BLAST_START;
        tank_slots[j]->decision = 0;
        tank_slots[j]->kind = GRENADE_BLAST_KIND;
        tank_slots[j]->carrier = 0;
      }
    hud_dirty = 1;
  }
  if (bonus == 6) {
    fortify = 1280 - (combat_frame & 63);
    set_walls(STEEL);
  }
  bonus = 0;
  bonus_points=50;
  award(i,5);
  if (!demo) PLAY_CUE(PICKUP_SOUND);
}
/* Enemy decisions consume movement updates, separate from the firing roll. */
static void request_direction(u8 i) {
  Tank *t = tank_slots[i];
  u8 clock = clock_high, interval = spawn_interval();
  if (clock <= (interval >> 3)) {
    t->dir = -random8() & 3; t->decision=ADVANCE;
  }
  else if (clock > (interval >> 2)) {
    t->decision=FOLLOW_BASE; pointer_row=0xb0;
  } else {
    t->decision=(!tanks[0].alive || ((i&1) && tanks[1].alive)) ? FOLLOW_P2 : FOLLOW_P1;
    pointer_row=t->decision==FOLLOW_P2 ? 0xc0 : 0xd0;
  }
}
static void face_target(Tank *t, u8 action) {
  u8 x = 96, y = 192, horizontal;
  if (action != FOLLOW_BASE) {
    Tank *target = tank_slots[action - FOLLOW_P1];
    x = target->x;
    y = target->y;
  }
  target_x=x+24; target_y=y+24;
  collision_x=y>t->y ? 2 : y==t->y;
  collision_y=3*collision_x+(x>t->x ? 2 : x==t->x);
  horizontal=random8()&1;
  if (x != t->x && (horizontal || y == t->y))
    t->dir = x < t->x ? 3 : 1;
  else
    t->dir = y > t->y ? 2 : 0;
}
void __fastcall__ enemy(u8 i) {
  Tank *t = tank_slots[i];
  u8 aligned, action = t->decision;
  if (action) {
    /* The two dispatch-address bytes are also inputs to the random mixer. */
    static const u16 handler[] = {0xdc7c,0xdc52,0xdc52,0xdd48,0xdd7e,0xdd89,0xdd94};
    field_ptr = handler[action];
    if (action <= WAIT_TWO) {
      if (!--t->decision) pointer_row=0xa0;
      return;
    }
    if (action != TURN) {
      face_target(t, action); t->decision = ADVANCE;
    } else if (random8() & 1) {
      t->dir = (t->dir + ((random8() & 1) ? 3 : 1)) & 3;
      t->decision = ADVANCE;
    } else request_direction(i);
    return;
  }
  field_ptr=0xdc7c;
  aligned = ((t->x | t->y) & 7) == 0;
  if (aligned && !(random8() & 15)) {
    request_direction(i);
    return;
  }
  if (!move_tank(i, t->dir)) {
    if (random8() & 3) {
      tread[i]^=8; t->decision = WAIT_TWO; pointer_row=0x80;
    }
    else {
      t->dir ^= 2;
      if (aligned) { t->decision = TURN; pointer_row=0x90; }
    }
  }
}
#pragma bss-name (pop)
#pragma static-locals (pop)
void draw_shots(void);
void remember_end_shots(void);
void draw_bonus(void);
void render_tanks(void);
void shoot_players(void);
void enemy_fire_rolls(void);
void shield_positions(void);
/* Message glyphs occupy sprite tiles 189..201. Keep the underlying field intact. */
void __fastcall__ notice(u8 first,u8 n,u8 x,u8 y);
#pragma static-locals (push,on)
#pragma bss-name (push,"ZEROPAGE")
void move_actors(void);
/* The original decrements these timers when its low clock wraps 64.
   Restarting the clock starts a full interval for every remaining unit. */
static void restart_battle_clock(void) {
  tanks[0].shield=(tanks[0].shield+63)&0xffc0;
  tanks[1].shield=(tanks[1].shield+63)&0xffc0;
  fortify=(fortify+63)&0xffc0;
  freeze=(freeze+63)&0xffc0;
  clock_origin=frame;
  combat_frame=0;
}
void __fastcall__ advance_effect(u8 i) {
  Tank *t=tank_slots[i];
  if (t->alive >= DYING) {
    u8 advance = i < 2 ? (combat_frame & 3) != 2 :
        ((combat_frame ^ i) & 1) || (t->kind == 1 && t->decision);
    if (advance && --t->alive == DYING) {
      t->alive = 0;
      if (i >= 2) ++defeated;
      else {
        --lives[i];
        hud_dirty = 1;
        if (lives[i]) reset_tank(i,0,i ? 128 : 64,192);
        if (!lives[i] && players==2 && lives[i^1] && !ending) {
          restart_battle_clock();
          eliminated_timer=208; eliminated_side=i;
        }
        if (!ending && !lives[0] && (players == 1 || !lives[1])) {
          ending=STAGE_LOST; end_delay=256;
        }
      }
    }
    return;
  }
  if (t->alive > ACTIVE) {
    if ((i < 2 ? (combat_frame & 3) != 2 : ((combat_frame ^ i) & 1)) &&
        --t->alive == ACTIVE) {
      tread[i]=0; seen_active |= slot_bits[i];
      if (i<2) {
        /* The helmet pass follows the spawn pass, including on a 64-tick boundary. */
        t->shield=191-((combat_frame-1)&63);
        player_flags[i]=0xa0;
      }
      else {
        while (group_index<3 && !group_left[group_index]) ++group_index;
        if (group_left[group_index]) --group_left[group_index];
      }
    }
    return;
  }
}

static void play(void) {
  static u8 i;
  if (!demo && !ending && (press[0] & START)) {
    mode = PAUSE;
    PLAY_CUE(MUSIC_PAUSE);
    audio_paused = 1;
    paused_sprites=used_sprites;
    return;
  }
  if ((u8)(frame-clock_origin) % 64 < (combat_frame & 63)) ++clock_high;
  combat_frame = frame-clock_origin;
  if (demo) {
    if (press[0] & (START|SELECT)) {
      title();
      title_scroll=0; title_cursor(); battle_ticks=640-((frame-clock_origin)&63);
      return;
    }
    for (i=2;i--;) {
      u8 slot=i+2, direction;
      Tank *p=tank_slots[i], *target;
      if (tank_slots[slot]->alive!=ACTIVE) slot+=2;
      if (tank_slots[slot]->alive!=ACTIVE) --slot;
      target=tank_slots[slot];
      if (target->alive==ACTIVE || bonus) {
        u8 x=bonus ? bonus_x : target->x, y=bonus ? bonus_y : target->y;
        collision_x=y>p->y ? 2 : y==p->y;
        collision_y=3*collision_x+(x>p->x ? 2 : x==p->x);
        if (x!=p->x && (((clock_high>>1)^i)&1 || y==p->y)) direction=x>p->x ? 1 : 2;
        else direction=y>p->y ? 4 : 8;
        target_x=x+24; target_y=y+24;
        pads[i]=direction|FIRE;
        press[i]=p->y<176 ? pads[i] : direction;
      } else pads[i]=press[i]=0;
    }
  }
  if (ending && end_delay) --end_delay;
  if (ruined && end_delay<256) { pads[0]=pads[1]=press[0]=press[1]=0; }
  ++battle_ticks;
  if (freeze)
    --freeze;
  if (fortify && --fortify <= 192 && !(combat_frame & 15))
    set_walls((fortify && (combat_frame & 16)) ? STEEL : BRICK);
  respawn_slot=0;
  snapshot_occupancy();
  if ((combat_frame&3)!=2) {
    for (i=players;i--;) {
      if (tank_slots[i]->alive==ACTIVE) {
        u8 p=pads[i];
        Tank *t=tank_slots[i];
        /* Ice is sampled at the tank centre before the direction is read.
           The high bit marks ice, the low bits count movement updates. */
        t->slide &= 0x7f;
        if (terrain(t->x+8,t->y+8)==ICE) t->slide |= 0x80;
        if ((p&15) && !t->stun && (t->slide&0x90)!=0x90) {
          if (t->slide==0x80) { t->slide=0x9c; PLAY_CUE(ICE_SOUND); }
          pointer_row=(p&8)?0:(p&1)?3:(p&4)?2:1;
          player_flags[i]=0xa0 | pointer_row;
          if ((pointer_row ^ tank_slots[i]->dir)&1) {
            t->x=(t->x+4)&248; t->y=(t->y+4)&248;
          }
          tank_slots[i]->dir=(-pointer_row)&3;
        }
        else {
          /* The input pass counts down friendly fire before enemies choose their direction. */
          if (t->stun) --t->stun;
          player_flags[i]=(player_flags[i]&15)|0x88; pointer_row=0x80;
        }
      }
    }
  }
  random_phase = MOVING;
  move_actors();
  field_ptr=shots[0].active ? 0xe051 : shot_blast[0] ? 0xe076 : 0xdbf0;
  advance_shots();
  shoot_players();
  random_phase=FIRING;
  shield_positions();
  if (!freeze) enemy_fire_rolls();
  spawn_enemy();
  resolve_shots();
  if (bonus && (bonus_player=bonus_picker())<2) {
    /* A pickup returns from the combat pass before the motor sound handler. */
    collect_bonus(bonus_player);
  } else {
    i=((pads[0]&15) && tanks[0].alive) || (players==2 && (pads[1]&15) && tanks[1].alive);
    if (motor!=i) {
      if (i) PLAY_CUE(PLAYER_MOTOR); else STOP_CUE(PLAYER_MOTOR);
      motor=i;
    }
  }
  if (mode != FIELD)
    return;
  if (!ending && defeated == 20) {
    ending=STAGE_WON; end_delay=128;
  }
  if (hud_dirty) {
    hud_number(18, lives[0] ? lives[0] - 1 : 0);
    if (players == 2)
      hud_number(21, lives[1] ? lives[1] - 1 : 0);
    hud_dirty = 0;
  }
  hide_sprites();
  render_tanks();
  draw_shots();
  if (demo || (ending && end_delay<=256)) remember_end_shots();
  if (eliminated_timer && !ending) {
    u8 distance=208-eliminated_timer;
    if (distance>48) distance=48;
    i=eliminated_side ? 168-distance : 8+distance;
    notice(194,4,i,192); notice(198,4,i,200);
    --eliminated_timer;
  }
  if (ending==STAGE_LOST && end_delay<=256) {
    u8 y=end_delay>129 ? end_delay-40 : 89;
    notice(194,4,88,y); notice(198,4,88,y+8);
  }
  if (!(combat_frame&31)) {
    enqueue(0x3f09,(combat_frame&32) ? 60 : 18);
    enqueue(0x3f0a,(combat_frame&32) ? 18 : 60);
  }
  if (bonus_x && bonus_points && !--bonus_points) bonus_x=0;
  if (bonus_x && (bonus_points || (bonus && (combat_frame&8)))) draw_bonus();
  if ((ending==STAGE_WON && end_delay==128) || (ending==STAGE_LOST && end_delay==256)) {
    STOP_CUE(PLAYER_MOTOR); STOP_CUE(ENEMY_MOTOR); motor=0;
    clock_high=ending==STAGE_WON ? 0 : 254;
    restart_battle_clock();
  }
  if (demo && ending) { title(); return; }
  if (ending && !end_delay) result();
}
#pragma bss-name (pop)
#pragma static-locals (pop)
static void edit(void) {
  u8 p = press[0], i, q, k;
  u16 addr;
  if (p & START) {
    custom = 1;
    selection = 0;
    title();
    title_scroll=0; title_cursor();
    return;
  }
  if (!(pads[0] & 15))
    repeat_delay = 0;
  if (pads[0] & 15) {
    editor_painted = 0;
    if (!repeat_delay) {
      p |= pads[0] & 15;
      repeat_delay = 8;
    } else
      --repeat_delay;
  }
  if (p & 8 && cursor_y)
    --cursor_y;
  if (p & 4 && cursor_y < 12)
    ++cursor_y;
  if (p & 2 && cursor_x)
    --cursor_x;
  if (p & 1 && cursor_x < 12)
    ++cursor_x;
  if (p & FIRE) {
    if (editor_painted)
      brush = (brush + ((p & 128) ? 1 : 13)) % 14;
    editor_painted = 1;
  }
  i = cursor_y * 13 + cursor_x;
  if ((p & FIRE) || ((p & 15) && (pads[0] & FIRE))) {
    k = decode(brush);
    design[i] = board[i] = k;
    addr = 0x2042u + (u16)cursor_y * 64 + cursor_x * 2;
    for (q = 0; q < 4; q++)
      enqueue(addr + (q & 1) + (q >> 1) * 32, (k & (1 << q)) ? k >> 4 : 0);
    enqueue(0x23c0u + ((cursor_y + 1) >> 1) * 8 + ((cursor_x + 1) >> 1),
            attribute((cursor_x + 1) >> 1, (cursor_y + 1) >> 1));
  }
  hide_sprites();
  sprite(cursor_x * 16, cursor_y * 16, 185, frame & 1);
}
void main(void) {
  u8 i;
  /* Power-on accumulator and the measured vblank offset between the two title screens. */
  bonus_player=target_x=rng=255;
  clock_origin = 20;
  high_score = 20000ul; memset(high_digits,0,8); high_digits[2]=2; high_digits[7]=255;
  begin_screen();
  ppu(0x3f00);
  for (i = 0; i < 32; i++)
    REG(0x2007) = palettes[i];
  ppu(0x2800);
  { u16 pos; for (pos=0;pos<1024;++pos) REG(0x2007)=0; }
  for (i=0;i<12;++i) wait_frame();
  title();
  for (;;) {
    wait_frame();
    read_pads();
    frame = video_clock;
    switch (mode) {
    case TITLE:
      if (title_scroll) {
        if (++title_scroll==240 || (press[0]&(START|SELECT|4|8))) {
          title_scroll=0; title_cursor();
          battle_ticks=640-((frame-clock_origin)&63);
        }
        break;
      }
      if (!custom && battle_ticks && !--battle_ticks) {
        demo=1; players=2; stage=29; lives[0]=lives[1]=3;
        tanks[0].stars=tanks[1].stars=0;
        start_stage(); break;
      }
      if (press[0] & (SELECT | 4 | 8)) {
        battle_ticks=640-((frame-clock_origin)&63);
        selection = (selection + ((press[0] & 8) ? 2 : 1)) % 3;
        title_cursor();
      }
      if (press[0] & START) {
        stage = 0;
        if (selection == 2) {
          for (i = 0; i < 169; i++)
            board[i] = custom ? design[i] : 0;
          if (!custom)
            fortress(BRICK);
          for (i = 0; i < 169; i++)
            design[i] = board[i];
          mode = EDIT;
          brush = editor_painted = repeat_delay = 0;
          cursor_x = cursor_y = 0;
          field_screen();
        } else {
          players = selection + 1;
          lives[0] = lives[1] = 3;
          scores[0] = scores[1] = 0;
          memset(score_digits,0,sizeof(score_digits));
          next_life[0] = next_life[1] = 20000ul;
          tanks[0].stars = tanks[1].stars = 0;
          close_curtain();
          mode = CHOOSE_STAGE;
          stage_label();
        }
      }
      break;
    case CHOOSE_STAGE:
      if ((press[0] & FIRE) || ((pads[0] & FIRE) && !((frame-clock_origin) & 7))) {
        clock_origin = frame;
        if (pads[0] & 128) {
          if (stage < 34) ++stage;
        } else if (stage) --stage;
        stage_label();
      }
      if (press[0] & START)
        start_stage();
      break;
    case FIELD:
      play();
      break;
    case EDIT:
      edit();
      break;
    case PAUSE:
      while (used_sprites>paused_sprites) { used_sprites-=4; OAM[used_sprites]=255; }
      if ((frame-clock_origin)&16) notice(189,5,80,104);
      if (press[0] & START) {
        mode = FIELD;
        audio_paused = 0;

      }
      break;
    case RESULT:
    case OVER:
      tally();
      break;
    case GAME_OVER_PAGE:
      if (++battle_ticks >= 117 || (press[0]&START)) finish_game();
      break;
    case RECORD_PAGE: {
      static const u8 colors[] = {15,18,0,48};
      enqueue(0x3f01, colors[battle_ticks & 3]);
      if (++battle_ticks >= 461) title();
      break;
    }
    }
  }
}
