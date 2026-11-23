/* The Famicom mixer visits the 256 bytes of its zero page in order. Our C
   globals have a different layout. Translate the address to the corresponding
   game value, including coordinates and the original dispatch pointer format.
   All inputs come from the current match and are included in a save state. */
static u8 input_bits(u8 p) {
  p = (p >> 4) | (p << 4);
  p = ((p & 0xcc) >> 2) | ((p & 0x33) << 2);
  return ((p & 0xaa) >> 1) | ((p & 0x55) << 1);
}
static u8 flag_byte(u8 i) {
  Tank *t=tank_slots[i];
  u8 n=t->alive;
  if (!n) return 0;
  if (n>=DYING) {
    n-=DYING;
    if (n<=6) return 0x10+n;
    --n;
    return ((n/3)<<4) | (n%3+1);
  }
  if (n>ACTIVE) return n>15 ? 0xf0+29-n : 0xe0+15-n;
  if (i<2) {
    return player_flags[i];
  } else {
    static const u8 states[]={0xa0,0x84,0x88,0x90,0xd0,0xc0,0xb0};
    return states[t->decision] | ((-t->dir)&3);
  }
}
static u8 type_byte(u8 i) {
  Tank *t=tank_slots[i];
  u8 type=i<2 ? t->stars<<5 : (0x80 + (t->kind<<5));
  if (t->kind==GRENADE_BLAST_KIND) return 0;
  if (t->alive>1 && t->alive<=SPAWNING) type=0;
  else if (i>=2 && t->kind==3 && !t->carrier && t->hp>0) type|=t->hp-1;
  return t->carrier ? type|4 : type;
}
static u8 bcd_digit(unsigned long value,u8 digit) {
  if (digit==7) return 255;
  if (!value) return 0;
  if (value<10) return digit==6 ? (u8)value : 0;
  if (value==20000ul) return digit==2 ? 2 : 0;
  for (;digit<6;++digit) value/=10;
  return value%10;
}
static u8 shell_flag(u8 i) {
  u8 n=shot_blast[i];
  if (shots[i].active) return 0x40|((-shots[i].dir)&3);
  if (!n) return 0;
  --n;
  return ((n/3+1)<<4) | (n%3+1);
}
/* The sound driver owns the last 16 mixer inputs. Read them directly on
   frames when movement, enemy fire and a bonus drop all request entropy. */
u8 __fastcall__ audio_entropy(u8 addr) {
  static const u8 channel_masks[]={1,2,4,8};
  if (addr>=0xf9 && addr<=0xfc)
    return (sound_channels & channel_masks[addr-0xf9])!=0;
  if (addr>=0xfd) return addr==0xff ? 255 : sound_work[addr-0xfd];
  if (addr>=0xf6) return sound_loops[addr-0xf6];
  if (addr>=0xf4) return demo ? 1 : 28;
  if (addr>=0xf2) return sound_source[addr-0xf2];
  return addr==0xf0 ? (demo ? 0x24 : 0xfc) : 3;
}
static u8 projectiles_last(void) {
  return demo ? (random_phase!=FIRING || !shield_sprites) : (ending && end_delay<=256);
}
u8 __fastcall__ entropy_byte(u8 addr) {
  u8 i,cold=(addr&1)?255:0;
  if (addr>=0x90 && addr<0xb8) {
    i=addr&7;
    if (addr>=0xa0 && addr<0xa8) return flag_byte(i);
    if (addr<0xb0) return type_byte(i);
    return cold;
  }
  if (addr>=0xb8 && addr<0xe0) {
    u8 base=addr-0xb8;
    i=base>=30 ? base-30 : base>=20 ? base-20 : base>=10 ? base-10 : base;
    if (base>=20 && base<30) return shell_flag(i);
    return cold;
  }
  if (addr>=0x15 && addr<=0x24) {
    i=(addr-0x15)&7;
    return i==7 ? 255 : score_digits[addr>=0x1d][i];
  }
  if (addr>=0x25 && addr<0x35) {
    u8 count=tally_armor[addr>=0x2d], digit=(addr-0x25)&7;
    if (!count) return cold;
    count=(count-1)*4;
    if (digit==3) return count/10;
    if (digit==4) return count%10;
    return digit==7 ? 255 : 0;
  }
  if (addr>=0x35 && addr<0x3d) return bcd_digit(lives[0] ? lives[0]-1 : 0,addr-0x35);

  if (addr>=0x73 && addr<=0x7a) return kills[(addr-0x73)>>2][(addr-0x73)&3];
  switch(addr) {
  case 0: return pointer_row;
  case 1: return 0x3f;  /* palette port high byte */
  case 2: case 3: return 0;
  case 4:
    /* The NES drew two 8x16 sprites. Either half can set the foliage
       priority bit in the shared attribute for the second sprite. */
    if (has_trees && (demo || draw_palette < 3 || tank_slots[last_drawn]->alive==ACTIVE) &&
        draw_y >= 16 && draw_y < 224 && ((draw_x>=21 && draw_x<229 && terrain(draw_x-21,draw_y-16)==TREES) ||
         (draw_x>=13 && draw_x<221 && terrain(draw_x-13,draw_y-16)==TREES)))
      return draw_palette | 0x20;
    return draw_palette;
  case 5: return 0x1c;  /* nametable minus field buffer */
  case 6: case 7: return input_bits(pads[addr-6]);
  case 8: case 9: return input_bits(press[addr-8]);
  case 10: return clock_high;
  case 11: return combat_frame;
  case 12: return (dirty_count<<2)+empty_spawn_bytes;
  case 13: {
    u8 units=0;
    if (random_phase==FIRING) {
      units=(shield_sprites&1)+(shield_sprites>>1);
    }
    return 4+(((frame^demo^sprite_phase)&1) ? -8 : 8)*units;
  }
  case 14: return ((frame^demo^sprite_phase)&1) ? 252 : 4;
  case 15: return rng;
  case 16: return rng_index;
  case 17: return field_ptr;
  case 18: return field_ptr>>8;
  case 19: return 0x1d + (hud_row<<5);
  case 20: return (0x41du + (u16)hud_row*32)>>8;
  case 0x45: return (fortify+63)>>6;
  case 0x46: return demo ? 2 : stage>=35;
  case 0x47: if (random_phase==DROPPING) return shell_probe_x;
             if (random_phase==FIRING && respawn_slot && !shield_sprites)
               return respawn_slot==1 ? 11 : 19;
             return projectiles_last() ? end_sprite_x : draw_x;
  case 0x48: if (random_phase==DROPPING) return shell_probe_y;
             if (random_phase==FIRING && respawn_slot && !shield_sprites) return 27;
             return projectiles_last() ? end_sprite_y : draw_y-8;
  case 0x49: return bonus_player;
  case 0x4a: case 0x4b: return 0;
  case 0x4c: return 1;
  case 0x4d: return 255;
  case 0x4f: case 0x50: return 0;
  case 0x51: return lives[0];
  case 0x52: return players==2 ? lives[1] : 0;
  case 0x53: return draw_tile;
  case 0x54: return random_phase==DROPPING ? collision_y>>2 : draw_x;
  case 0x55: return random_phase==DROPPING ? collision_x>>2 : draw_y;
  case 0x56: return next_x;
  case 0x57: return next_y;
  case 0x58: return probe_dx;
  case 0x59: return probe_dy;
  case 0x5a: return random_phase==FIRING ? 255 : actor_slot;
  case 0x5b: return random_phase==DROPPING ? impact_slot : 255;
  /* Title lettering and the last score row share the same two scratch bytes. */
  case 0x5d: case 0x5e: return counted[addr-0x5d];
  case 0x5f: return 4;
  case 0x60: return 0;
  case 0x63: return demo ? 255 : 0;
  case 0x62: return bonus_points;
  case 0x64: return collision_y;
  case 0x65: return collision_x;
  case 0x66: case 0x67: return !next_life[addr-0x66];
  case 0x68: return 0x80;
  case 0x6a: return spawned%3;
  case 0x6b: return 0;
  case 0x6d: return demo;
  case 0x6c: return players==2 && !demo ? 7 : 5;
  case 0x6e: return 32;
  case 0x6f: case 0x70: return tank_slots[addr-0x6f]->stun;
  case 0x71: return target_x;
  case 0x72: return target_y;
  case 0x7c: return 0;
  case 0x7d: case 0x7e: return totals[addr-0x7d];
  case 0x7f: return 20-spawned;
  case 0x80: return 20-defeated;
  case 0x82: return spawn_clock;
  case 0x83: return demo ? selection : players-1;
  case 0x84: return spawn_interval();
  case 0x85: return stage+1;
  case 0x86: return bonus_x ? bonus_x+24 : 0;
  case 0x87: return bonus_y ? bonus_y+24 : cold;
  case 0x88: return bonus_code;
  case 0x89: case 0x8a: return (tank_slots[addr-0x89]->shield+63)>>6;
  case 0x8b: case 0x8c: case 0x8d: case 0x8e: return group_left[addr-0x8b];
  case 0x8f: return group_index;
  default: return cold;
  }
}
