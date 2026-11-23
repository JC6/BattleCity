.export __STARTUP__ : absolute = 1
.import _main, _board, popa, zerobss, copydata
.import audio_init, audio_tick
.import _used_sprites, _tanks, _frame, _shots
.import _shot_fast, _shot_blast, _entropy_byte, _audio_entropy, _rng, _rng_index, _clock_high
.import _last_drawn, _draw_x, _draw_y, _draw_tile, _draw_palette, _field_ptr, _pointer_row
.import _has_trees
.import _combat_frame
.export _random8, _render_tanks, _remember_shield, _field_low, _field_high
.export _advance_shots
.export _move_tank, _snapshot_occupancy
.export _next_x, _next_y, _probe_dx, _probe_dy
.export _hide_sprites, _draw_tank, _curtain_pair, _video_clock, _tread
.importzp sp
.export _wait_frame, _read_pads, _pads, _press, _terrain, _maps, _enemies, _enemy_groups
.export _dirty_count, _dirty_high, _dirty_low, _dirty_tile
.segment "HEADER"
.byte $4e,$45,$53,$1a,2,1,0,0,0,0,0,0,0,0,0,0
.segment "ZEROPAGE"
.exportzp _probe_shot, _empty_spawn_bytes, _respawn_slot, _tally_armor
.exportzp _title_scroll
_title_scroll: .res 1
_video_clock: .res 1
_curtain_pair: .res 1
_tread: .res 8
tank_x: .res 1
tank_y: .res 1
tank_attr: .res 1
tank_tile: .res 1
quad: .res 1
px: .res 1
py: .res 1
owner: .res 1
flip: .res 1
present: .res 1
row: .res 1
mask_row: .res 1
.segment "OCCUPANCY"
; One bit per 8x8 field cell. The CPU stack grows down from $01ff.
occupancy: .res 104
.segment "BSS"
_field_low: .res 8
_field_high: .res 8
_next_x: .res 1
_next_y: .res 1
_probe_dx: .res 1
_probe_dy: .res 1
_pads: .res 2
_press: .res 2
held: .res 2
previous: .res 2
pending: .res 2
_dirty_count: .res 1
_dirty_high: .res 32
_dirty_low: .res 32
_dirty_tile: .res 32
.segment "STARTUP"
reset:
    sei
    cld
    ldx #$ff
    txs
    inx
    stx $2000
    stx $2001
    stx $4010
    lda #$40
    sta $4017
    bit $2002
:   bit $2002
    bpl :-
:   bit $2002
    bpl :-
    lda #0
    sta sp
    lda #8
    sta sp+1
    jsr zerobss
    jsr copydata
    lda #0
    sta present
    sta a:_tally_armor
    sta a:_tally_armor+1
    sta _curtain_pair
    sta _video_clock
    sta _title_scroll
    ; Untouched original position slots retain the power-on RAM pattern.
    ldx #7
:   txa
    and #1
    beq :+
    lda #$ff
:   sta _field_low,x
    sta _field_high,x
    dex
    bpl :--
    jsr audio_init
    lda #$88
    sta $2000
    jmp _main
nmi:
    pha
    txa
    pha
    tya
    pha
    inc _video_clock
    lda present
    beq @input
    jsr flush_video
    lda #0
    sta present
@input:
    jsr sample_pads
    jsr audio_tick
    pla
    tay
    pla
    tax
    pla
irq:
    rti
_wait_frame:
    lda #1
    sta present
:   lda present
    bne :-
    rts
; Upload only complete frames. Audio and input continue on intervening vblanks.
flush_video:
    bit $2002
    lda #0
    sta $2003
    lda #2
    sta $4014
    ldx #0
:   cpx _dirty_count
    beq @curtain
    lda _dirty_high,x
    sta $2006
    lda _dirty_low,x
    sta $2006
    lda _dirty_tile,x
    sta $2007
    inx
    bne :-
@curtain:
    ldx _curtain_pair
    bne :+
    jmp @done
:   txa
    and #$1f
    tax
    dex
    lda row_hi,x
    sta $2006
    lda row_lo,x
    sta $2006
    bit _curtain_pair
    bpl :+
    jmp @close_top
:
    .repeat 32,i
      lda _dirty_high+i
      sta $2007
    .endrepeat
    jmp @bottom
@close_top:
    lda #14
    .repeat 32
      sta $2007
    .endrepeat
@bottom:
    lda bottom_hi,x
    sta $2006
    lda bottom_lo,x
    sta $2006
    bit _curtain_pair
    bpl :+
    jmp @close_bottom
:
    .repeat 32,i
      lda _dirty_low+i
      sta $2007
    .endrepeat
    jmp @finished
@close_bottom:
    lda #14
    .repeat 32
      sta $2007
    .endrepeat
@finished:
    lda #0
    sta _curtain_pair
@done:
    lda #$88
    ldx _title_scroll
    beq :+
    ora #2
:   sta $2000
    lda #0
    sta _dirty_count
    sta z:_empty_spawn_bytes
    sta $2005
    stx $2005
    rts
; Preserve button edges even when a busy gameplay update spans two vblanks.
_read_pads:
    ldx #1
:   lda held,x
    sta _pads,x
    lda pending,x
    sta _press,x
    lda #0
    sta pending,x
    dex
    bpl :-
    rts
sample_pads:
    lda #1
    sta $4016
    lda #0
    sta $4016
    ldx #8
:   lda $4016
    lsr a
    rol held
    lda $4017
    lsr a
    rol held+1
    dex
    bne :-
    ldx #1
:   lda previous,x
    eor #$ff
    and held,x
    ora pending,x
    sta pending,x
    lda held,x
    sta previous,x
    dex
    bpl :-
    rts

_hide_sprites:
    lda #255
    ldx #12
:   .repeat 16,i
      sta $0200+16*i,x
    .endrepeat
    dex
    dex
    dex
    dex
    bpl :-
    lda #0
    sta _used_sprites
    rts

.import _seen_tanks, _seen_active
; Direct read paths keep a full co-op battle inside one NTSC display frame.
.importzp _high_digits
read_entropy:
    cmp #$90
    bcs @tank
    cmp #$3d
    bcc @other
    cmp #$45
    bcs @other
    sec
    sbc #$3d
    tax
    lda _high_digits,x
    rts
@tank:
    cmp #$b8
    bcs @shell
    tax
    and #7
    tay
    lda slot_bits,y
    cpx #$a0
    bcc @position
    cpx #$a8
    bcc @fallback
    and _seen_tanks
    beq @cold
    cpx #$b0
    bcc @fallback
    lda slot_bits,y
    and _seen_active
    beq @cold
    lda _tread,y
    lsr
    rts
@position:
    and _seen_tanks
    beq @cold
    lda tank_offsets,y
    tay
    cpx #$98
    bcs :+
    lda _tanks,y
    jmp @plus24
:   lda _tanks+1,y
@plus24:
    clc
    adc #24
    rts
@cold:
    txa
    and #1
    beq :+
    lda #255
:   rts
@fallback:
    txa
@other:
    jmp _entropy_byte
@shell:
    cmp #$f0
    bcs @audio
    cmp #$e0
    bcc @slot
    tax
    and #7
    tay
    cpx #$e8
    bcs :+
    lda _field_low,y
    rts
:   lda _field_high,y
    rts
@slot:
    tax
    cmp #$cc
    bcc @sample
    cmp #$d6
    bcc @other
@sample:
    ldy shell_slot-$b8,x
    cpy #8
    bcc :+
    lda slot_bits-8,y
    and _seen_shots_hi
    jmp @seen
:   lda slot_bits,y
    and _seen_shots_lo
@seen:
    beq @cold
    cpx #$d6
    bcc @coord
    lda _shot_fast,y
    rts
@coord:
    tya
    asl
    asl
    tay
    cpx #$c2
    bcs :+
    lda _shots,y
    jmp @plus18
:   lda _shots+1,y
@plus18:
    clc
    adc #18
    rts
@audio:
    jmp _audio_entropy
shell_slot: .repeat 4
    .byte 0,1,2,3,4,5,6,7,8,9
.endrepeat

; Mix 7 * accumulator with the slow match clock and the next state byte.
; The second ADC includes the carry from adding the clock.
_random8:
    inc _rng_index
    lda _rng_index
    jsr read_entropy
.export _rng_mix
_rng_mix:
    sta row
    lda _rng
    asl
    asl
    asl
    sec
    sbc _rng
    clc
    adc _clock_high
    adc row
    sta _rng
    ldx #0
    rts

_render_tanks:
    ldx #0
@draw:
    stx owner
    ldy tank_offsets,x
    lda _tanks+3,y
    beq @next
    stx _last_drawn
    txa
    jsr _draw_tank
@next:
    ldx owner
    inx
    cpx #8
    bcc @draw
    ldx _last_drawn
    ldy tank_offsets,x
    lda _tanks+3,y
    bne :+
    rts
:   cmp #1
    bne @effect
    lda _tanks+2,y
    eor #$ff
    clc
    adc #1
    and #3
    asl
    asl
    asl
    sta row
    lda _tread,x
    lsr
    ora row
    ora #2
    sta row
    cpx #2
    bcc @player
    lda tank_attr
    sta _draw_palette
    lda _tanks+5,y
    asl
    asl
    asl
    asl
    asl
    ora #$80
    bne @tile
@player:
    stx _draw_palette
    lda _tanks+7,y
    asl
    asl
    asl
    asl
    asl
@tile:
    ora row
    sta _draw_tile
    jmp remember_position
@effect:
    cmp #30
    bcs @blast
    cmp #16
    bcc :+
    sec
    sbc #14
:   sec
    sbc #8
    bcs :+
    eor #$ff
    adc #1
:   asl
    and #12
    ora #$a3
    bne @save
@blast:
    sec
    sbc #33
    cmp #6
    bcs @phase
    lda #$f3
    cpx #2
    bcc @save
    lda _tanks+5,y
    cmp #4
    bne :+
    lda #$f3
    bne @save
:   asl
    asl
    clc
    adc #$bb
    bne @save
@phase:
    tax
    lda blast_sprite,x
    cmp #$df
    beq @large
    cmp #$ef
    bne @save
@large:
    sta _draw_tile
    lda #3
    sta _draw_palette
    lda _tanks,y
    clc
    adc #32
    sta _draw_x
    lda _tanks+1,y
    clc
    adc #32
    jmp remember_y
@save:
    sta _draw_tile
    lda #3
    sta _draw_palette
    jmp remember_position
@done:
    rts

_remember_shield:
    tax
    ldy tank_offsets,x
    lda _combat_frame
    and #2
    asl
    ora #$2b
    sta _draw_tile
    lda #2
    sta _draw_palette
remember_position:
    lda _tanks,y
    clc
    adc #24
    sta _draw_x
    lda _tanks+1,y
    clc
    adc #24
remember_y:
    sta _draw_y
    tax
    and #$38
    asl
    asl
    sta _pointer_row
    lda _draw_x
    clc
    adc #3
    lsr
    lsr
    lsr
    ora _pointer_row
    sta _field_ptr
    lda field_row_hi,x
    ora #4
    sta _field_ptr+1
    rts

.export _draw_shots
_draw_shots:
    ldx #0
@slot:
    txa
    asl
    asl
    tay
    lda _shots+3,y
    beq @blast
    lda #2
    sta tank_attr
    lda #184
    sta tank_tile
    lda #0
    beq @emit
@blast:
    lda _shot_blast,x
    beq @next
    tay
    lda impact_tile-1,y
    sta tank_tile
    lda #3
    sta tank_attr
    lda #$fe
@emit:
    sta row
    txa
    asl
    asl
    tay
    lda _shots,y
    clc
    adc row
    clc
    adc #16
    sta px
    lda _shots+1,y
    clc
    adc row
    clc
    adc #15
    ldy _used_sprites
    cpy #252
    bcs @done
    sta $0200,y
    lda px
    sta $0203,y
    lda tank_attr
    sta $0202,y
    lda tank_tile
    sta $0201,y
    tya
    clc
    adc #4
    sta _used_sprites
@next:
    inx
    cpx #10
    bne @slot
@done:
    rts
.export _remember_end_shots
.import _end_sprite_x, _end_sprite_y
; During the end-of-stage hold, projectiles are the last sprites processed.
; A flying shell uses a single sprite and leaves the last tank centre intact.
_remember_end_shots:
    lda _draw_x
    sta _end_sprite_x
    lda _draw_y
    sec
    sbc #8
    sta _end_sprite_y
    ldx #9
@slot:
    txa
    asl
    asl
    tay
    lda _shots+3,y
    bne @shell
    lda _shot_blast,x
    beq @next
    cmp #4
    bcc @small
    cmp #7
    lda #$f7
    bcc @impact
    lda #$f3
    bne @impact
@small:
    lda #$fb
@impact:
    sta _draw_tile
    lda #3
    sta _draw_palette
    lda _shots,y
    clc
    adc #18
    sta _draw_x
    sta _end_sprite_x
    lda _shots+1,y
    clc
    adc #18
    sta _draw_y
    jmp @last_y
@shell:
    lda _shots+2,y
    eor #$ff
    clc
    adc #1
    and #3
    asl
    adc #$b1
    sta _draw_tile
    lda #2
    sta _draw_palette
    lda _shots,y
    clc
    adc #13
    sta _end_sprite_x
    lda _shots+1,y
    clc
    adc #18
@last_y:
    tay
    sec
    sbc #8
    sta _end_sprite_y
    tya
    and #$38
    asl
    asl
    sta _pointer_row
@next:
    dex
    bpl @slot
    rts
blast_sprite:
    .byte 0,0,0,0,0,0,$fb,$fb,$fb,$ef,$ef,$ef,$df,$df,$df,$fb,$fb,$fb,$f7,$f7,$f7,$f3,$f3,$f3
impact_tile: .byte 188,188,188,187,187,187,186,186,186
.import _actor_slot, _freeze, _advance_effect, _drive_player, _enemy
.export _move_actors
; The six enemy slots and two player slots share one descending update order.
_move_actors:
    lda #0
    sta _shield_sprites
    ldx #7
@slot:
    ldy tank_offsets,x
    lda _tanks+3,y
    beq @next
    stx _actor_slot
    cmp #1
    bne @effect
    lda _tanks+11,y
    ora _tanks+12,y
    beq @active
    lda _tanks+11,y
    sec
    sbc #1
    sta _tanks+11,y
    lda _tanks+12,y
    sbc #0
    sta _tanks+12,y
    cpx #2
    bcs :+
    ; The last shield sprite is still emitted on the update it expires.
    lda slot_bits,x
    ora _shield_sprites
    sta _shield_sprites
    bne @player
:   ora _tanks+11,y
    bne @next
@active:
    cpx #2
    bcc @player
    lda _freeze
    ora _freeze+1
    bne @next
    lda _tanks+5,y
    cmp #1
    beq @enemy
    txa
    eor _combat_frame
    and #1
    beq @next
@enemy:
    txa
    pha
    jsr _enemy
    jmp @rest
@effect:
    txa
    pha
    jsr _advance_effect
    jmp @rest
@player:
    txa
    pha
    jsr _drive_player
@rest:
    pla
    tax
@next:
    dex
    bpl @slot
    rts

.export _notice
_notice:
    clc
    adc #15
    sta py
    jsr popa
    clc
    adc #16
    sta px
    jsr popa
    sta quad
    jsr popa
    sta tank_tile
    ldx _used_sprites
@letter:
    cpx #252
    bcs @done
    lda py
    sta $0200,x
    lda tank_tile
    sta $0201,x
    inc tank_tile
    lda #3
    sta $0202,x
    lda px
    sta $0203,x
    clc
    adc #8
    sta px
    inx
    inx
    inx
    inx
    dec quad
    bne @letter
@done:
    stx _used_sprites
    rts
.import _players
.export _shoot_players, _shield_positions, _enemy_fire_rolls
_shoot_players:
    ldx _players
    cpx #2
    bne @one
    lda _tanks+16
    cmp #1
    bne @one
    lda _press+1
    and #$c0
    beq @one
    lda #1
    jsr _fire
@one:
    lda _tanks+3
    cmp #1
    bne @done
    lda _press
    and #$c0
    beq @done
    lda #0
    jmp _fire
@done:
    rts
.import _shield_sprites
_shield_positions:
    lda _players
    cmp #2
    bne @one
    lda _tanks+24
    ora _tanks+25
    bne @second
    lda _shield_sprites
    and #2
    beq @one
@second:
    lda _shield_sprites
    ora #2
    sta _shield_sprites
    lda #1
    jsr _remember_shield
@one:
    lda _tanks+11
    ora _tanks+12
    bne @first
    lda _shield_sprites
    and #1
    beq @done
@first:
    lda _shield_sprites
    ora #1
    sta _shield_sprites
    lda #0
    jmp _remember_shield
@done:
    rts
_enemy_fire_rolls:
    ldx #7
@slot:
    ldy tank_offsets,x
    lda _tanks+3,y
    cmp #1
    bne @next
    txa
    pha
    jsr _random8
    and #31
    bne @skip
    pla
    pha
    jsr _fire
@skip:
    pla
    tax
@next:
    dex
    cpx #1
    bne @slot
    rts
.export _fire
.import _seen_shots_lo, _seen_shots_hi, _audio_commands
; A tank owns its primary shot. A second shot is available at upgrade two.
_fire:
    tax
    stx owner
    asl
    asl
    tay
    lda _shots+3,y
    ora _shot_blast,x
    beq @launch
    cpx #2
    bcc :+
    rts
:   lda _shots+35,y
    ora _shot_blast+8,x
    beq :+
    rts
:   lda tank_offsets,x
    tax
    lda _tanks+7,x
    cmp #2
    bcs :+
    rts
:   ldx owner
    .repeat 4,n
        lda _shots+n,y
        sta _shots+32+n,y
    .endrepeat
    lda _shot_blast,x
    sta _shot_blast+8,x
    lda #0
    sta _shot_blast,x
    lda _shot_fast,x
    sta _shot_fast+8,x
    lda slot_bits,x
    ora _seen_shots_hi
    sta _seen_shots_hi
@launch:
    lda slot_bits,x
    ora _seen_shots_lo
    sta _seen_shots_lo
    lda tank_offsets,x
    tax
    lda _tanks+2,x
    sta _shots+2,y
    stx row
    tax
    lda muzzle_x,x
    ldx row
    clc
    adc _tanks,x
    sta _shots,y
    lda _tanks+2,x
    tax
    lda muzzle_y,x
    ldx row
    clc
    adc _tanks+1,x
    sta _shots+1,y
    lda #1
    sta _shots+3,y
    ldy owner
    cpy #2
    bcs @enemy
    sta _audio_commands+15
    lda _tanks+7,x
    tax
    lda star_speed,x
    jmp @speed
@enemy:
    lda _tanks+5,x
    cmp #2
    beq :+
    lda #0
    beq @speed
:   lda #1
@speed:
    sta _shot_fast,y
@done:
    rts
slot_bits: .byte 1,2,4,8,16,32,64,128
muzzle_x: .byte 6,14,6,254
muzzle_y: .byte 254,6,14,6
star_speed: .byte 0,1,1,3

_advance_shots:
    ldx #9
    ldy #36
@slot:
    lda _shots+3,y
    bne @fly
    lda _shot_blast,x
    beq @next
    dec _shot_blast,x
    jmp @next
@fly:
    lda _shot_fast,x
    beq :+
    lda #2
:   clc
    adc #2
    sta row
    lda _shots+2,y
    lsr a
    bcs @horizontal
    bne @down
    lda _shots+1,y
    sec
    sbc row
    jmp @y
@down:
    lda _shots+1,y
    clc
    adc row
@y: sta _shots+1,y
    jmp @next
@horizontal:
    bne @left
    lda _shots,y
    clc
    adc row
    jmp @x
@left:
    lda _shots,y
    sec
    sbc row
@x: sta _shots,y
@next:
    dey
    dey
    dey
    dey
    dex
    bpl @slot
    rts

; Snapshot active tank occupancy before applying this update's movement.
_snapshot_occupancy:
    lda #0
    ldx #12
:   .repeat 8,n
        sta occupancy+13*n,x
    .endrepeat
    dex
    bpl :-
    ldx #7
@tank:
    stx owner
    ldy tank_offsets,x
    lda _tanks+3,y
    cmp #1
    beq :+
    jmp @next
:   lda _tanks,y
    sta tank_x
    clc
    adc #8
    sta px
    lda _tanks+1,y
    sta tank_y
    ; The field pointer is captured before movement, and survives an explosion.
    clc
    adc #16
    tay
    and #$38
    asl
    asl
    sta _pointer_row
    sta row
    lda field_row_hi,y
    sta mask_row
    lda tank_x
    clc
    adc #16
    lsr
    lsr
    lsr
    ora row
    sta _field_low,x
    lda tank_x
    and #7
    beq :+
    lda #0
    beq :++
:   lda #$80
:   ora mask_row
    sta mask_row
    lda tank_y
    and #7
    bne :+
    lda #$40
:   and #$40
    ora mask_row
    sta _field_high,x
    ; Mark the centre once. An aligned tank also occupies the left or
    ; upper neighbour on that axis. All three writes use the same row base.
    lda tank_y
    clc
    adc #8
    lsr
    and #$7c
    sta row
    ldy px
    ora occ_column,y
    tax
    tya
    and #63
    tay
    lda occ_bit,y
    sta mask_row
    ora occupancy,x
    sta occupancy,x
    lda tank_y
    and #7
    bne :+
    lda mask_row
    ora occupancy-4,x
    sta occupancy-4,x
:   lda tank_x
    and #7
    bne @next
    ldy tank_x
    lda row
    ora occ_column,y
    tax
    tya
    and #63
    tay
    lda occ_bit,y
    ora occupancy,x
    sta occupancy,x
@next:
    ldx owner
    dex
    bmi :+
    jmp @tank
:   rts
; Return nonzero for the solid terrain or an occupied cell on the leading edge.
blocked_cell:
    lda py
    clc
    adc #16
    tay
    and #$38
    asl
    asl
    sta _pointer_row
    lda field_row_hi,y
    ora #4
    sta _field_ptr+1
    lda px
    clc
    adc #16
    lsr
    lsr
    lsr
    ora _pointer_row
    sta _field_ptr
    ; The border blocks movement, but the probe still sets the row and
    ; address used by the random mixer. Never index occupancy off the field.
    ldy py
    cpy #208
    bcs @border
    ldy px
    cpy #208
    bcc @inside
@border:
    lda #1
    rts
@inside:
    lda py
    lsr
    and #$7c
    ora occ_column,y
    tax
    lda px
    and #63
    tay
    lda occ_bit,y
    and occupancy,x
    bne @return
    ldy px
    lda tile_col,y
    ldx py
    clc
    adc tile_row,x
    tax
    lda _board,x
    beq @return
    sta row
    and #$f0
    cmp #$40
    bcc @mask
    cmp #$60
    beq @mask
    lda #0
    rts
@mask:
    lda py
    and #8
    sta mask_row
    tya
    and #8
    lsr a
    ora mask_row
    tay
    lda quadrant_mask,y
    and row
@return:
    rts
_move_tank:
    sta flip
    jsr popa
    sta owner
    tax
    ldy tank_offsets,x
    lda _tanks,y
    sta tank_x
    lda _tanks+1,y
    sta tank_y
    lda _tanks+2,y
    eor flip
    and #1
    beq @step
    lda tank_x
    clc
    adc #4
    and #$f8
    sta tank_x
    sta _tanks,y
    lda tank_y
    clc
    adc #4
    and #$f8
    sta tank_y
    sta _tanks+1,y
@step:
    ldx flip
    txa
    sta _tanks+2,y
    lda delta_x,x
    asl
    asl
    asl
    sta _probe_dx
    lda delta_y,x
    asl
    asl
    asl
    sta _probe_dy
    lda tank_x
    clc
    adc delta_x,x
    sta tank_x
    clc
    adc #24
    sta _next_x
    lda tank_y
    clc
    adc delta_y,x
    sta tank_y
    clc
    adc #24
    sta _next_y
    lda tank_y
    clc
    adc leading_y,x
    sta py
    lda tank_x
    clc
    adc leading_x,x
    sta px
    jsr blocked_cell
    bne @blocked
    ldx flip
    lda tank_x
    clc
    adc trailing_x,x
    sta px
    lda tank_y
    clc
    adc trailing_y,x
    sta py
    jsr blocked_cell
    bne @blocked
    ldx owner
    ldy tank_offsets,x
    lda tank_x
    sta _tanks,y
    lda tank_y
    sta _tanks+1,y
    lda #1
    bne @tread
@blocked:
    lda #0
    ldx owner
    cpx #2
    bcc @tread
    ldx #0
    rts
@tread:
    tay
    ldx owner
    lda _tread,x
    eor #8
    sta _tread,x
    tya
    ldx #0
    rts

.import _missing_bricks
.segment "ZEROPAGE"
_respawn_slot: .res 1
_tally_armor: .res 2
_probe_shot: .res 1
_empty_spawn_bytes: .res 1
wall_pair: .res 2
wall_power: .res 1
wall_first: .res 1
.segment "CODE"
; Test both sides of the leading edge. Each wall cell holds four 4px parts.
.export _shell_impact
.import _shell_probe_x, _shell_probe_y
_shell_impact:
    sta _probe_shot
    tax
    lda _shot_fast,x
    and #2
    sta wall_power
    txa
    asl
    asl
    tay
    lda _shots+2,y
    and #1
    sta flip
    lda _shots,y
    clc
    adc #2
    sta px
    lda _shots+1,y
    clc
    adc #2
    sta py
    jsr wall_cell
    jsr impact_cue
    sta wall_first
    lda flip
    beq :+
    dec py
    jmp @second
:   dec px
@second:
    jsr wall_cell
    jsr impact_cue
    pha
    ; A partial brick hit probes the adjacent 4px half of the same tile.
    cmp #1
    bne @remember_probe
    lda wall_power
    bne @remember_probe
    lda flip
    beq @vertical
    lda py
    sec
    sbc #4
    sta py
    jmp @remember_probe
@vertical:
    lda px
    sec
    sbc #4
    sta px
@remember_probe:
    lda px
    clc
    adc #16
    sta _shell_probe_x
    lda py
    clc
    adc #16
    sta _shell_probe_y
    pla
    cmp wall_first
    bcs :+
    lda wall_first
:   ldx #0
    rts
impact_cue:
    ; Each half of the projectile can strike a different material. Ordinary
    ; impacts sound on the primary player slots. A demolition hit always sounds.
    cmp #1
    bne @wall
    ldx wall_power
    bne @brick
    ldx _probe_shot
    cpx #2
    bcs @done
@brick:
    ldx #1
    stx _audio_commands+12
    rts
@wall:
    cmp #2
    bne @done
    ldx _probe_shot
    cpx #2
    bcs @done
    ldx #1
    stx _audio_commands+13
@done:
    rts
wall_cell:
    ldx px
    cpx #208
    bcs @solid
    ldy py
    cpy #208
    bcs @solid
    lda tile_col,x
    clc
    adc tile_row,y
    tax
    lda _board,x
    beq @clear
    cmp #$30
    bcc @quad
    cmp #$60
    bcc @clear
@quad:
    stx owner
    lda px
    and #8
    lsr
    sta quad
    tya
    and #8
    ora quad
    tay
    lda quadrant_mask,y
    sta quad
    and _board,x
    beq @clear
    lda _board,x
    and #$f0
    cmp #$60
    beq @base
    cmp #$20
    bne @brick
    lda wall_power
    beq @solid
    jmp @remove
@clear:
    lda #0
    rts
@base:
    lda #6
    rts
@solid:
    lda #2
    rts
@brick:
    lda py
    lsr
    lsr
    lsr
    tax
    lda brick_row_low,x
    sta wall_pair
    lda brick_row_high,x
    sta wall_pair+1
    ldx px
    lda tile_col,x
    tay
    lda (wall_pair),y
    sta mask_row
    txa
    and #8
    beq :+
    lda mask_row
    lsr
    lsr
    lsr
    lsr
    bpl @parts
:   lda mask_row
@parts:
    eor #15
    and #15
    sta row
    lda py
    and #4
    lsr
    sta tank_tile
    txa
    and #4
    lsr
    lsr
    ora tank_tile
    tax
    lda slot_bits,x
    and row
    beq @clear
    ; A powered shell clears the whole tile only after it touches a surviving fragment.
    lda wall_power
    bne @remove
    lda flip
    beq @vertical
    lda px
    and #4
    beq :+
    lda #5
    bne @layer
:   lda #10
    bne @layer
@vertical:
    lda py
    and #4
    beq :+
    lda #3
    bne @layer
:   lda #12
@layer:
    and row
    beq @remove
    sta row
    eor #15
    ldx px
    pha
    txa
    and #8
    bne @upper
    lda mask_row
    and #$f0
    sta mask_row
    pla
    bpl @write
@upper:
    lda mask_row
    and #15
    sta mask_row
    pla
    asl
    asl
    asl
    asl
@write:
    ora mask_row
    sta (wall_pair),y
    lda row
    ora #224
    bne @tile
@remove:
    ldx owner
    lda quad
    eor #255
    and _board,x
    sta _board,x
    lda #0
@tile:
    ldx _dirty_count
    cpx #32
    bcs @hit
    sta _dirty_tile,x
    lda py
    lsr
    lsr
    lsr
    tay
    lda px
    lsr
    lsr
    lsr
    clc
    adc wall_row_low,y
    sta _dirty_low,x
    lda wall_row_high,y
    adc #0
    sta _dirty_high,x
    inc _dirty_count
@hit:
    lda #1
    rts
.segment "RODATA"
armor_palette: .byte 2,0,0,1,2,1,2,2
brick_row_low: .repeat 26,i
    .byte <(_missing_bricks+13*i)
.endrepeat
brick_row_high: .repeat 26,i
    .byte >(_missing_bricks+13*i)
.endrepeat
wall_row_low: .repeat 26,i
    .byte <($2042+32*i)
.endrepeat
wall_row_high: .repeat 26,i
    .byte >($2042+32*i)
.endrepeat
.segment "CODE"
.import _projectile, _strike_tank, _contact_target
.export _resolve_shots
_resolve_shots:
    lda #255
    sta _probe_shot
    lda _draw_x
    sta _shell_probe_x
    lda _draw_y
    sec
    sbc #8
    sta _shell_probe_y
    ldy #36
@scan:
    lda _shots+3,y
    beq @next
    tya
    pha
    lsr
    lsr
    jsr _projectile
    pla
    tay
@next:
    dey
    dey
    dey
    dey
    bpl @scan

    ; After all terrain impacts, each player shot cancels overlapping shots
    ; belonging to another tank. Both players' shots participate in co-op.
    ldx #3
@player_shot:
    ldy player_shots,x
    lda _shots+3,y
    beq @next_player_shot
    tya
    and #28
    sta owner
    lda _shots,y
    clc
    adc #5
    sta px
    lda _shots+1,y
    clc
    adc #5
    sta py
    ldy #36
@opposing:
    lda _shots+3,y
    beq @next_opposing
    tya
    and #28
    cmp owner
    beq @next_opposing
    lda px
    sec
    sbc _shots,y
    cmp #11
    bcs @next_opposing
    lda py
    sec
    sbc _shots+1,y
    cmp #11
    bcs @next_opposing
    lda #0
    sta _shots+3,y
    sty quad
    ldy player_shots,x
    sta _shots+3,y
    ldy quad
@next_opposing:
    dey
    dey
    dey
    dey
    bpl @opposing
    ; The final opposing slot examined by the collision pass is slot zero.
    lda #0
    sta _pointer_row
@next_player_shot:
    dex
    bpl @player_shot

    ; Enemy fire against players, player fire against enemies, then friendly
    ; fire. Each target takes overlapping shots in descending slot order.
    ldx #9
@target:
    lda target_order,x
    sta _contact_target
    tay
    lda tank_offsets,y
    tay
    lda _tanks+3,y
    cmp #1
    bne @next_target
    lda _tanks,y
    clc
    adc #15
    sta px
    lda _tanks+1,y
    clc
    adc #15
    sta py
    ldy #3
    cpx #8
    bcc @contact
    ldy #9
@contact:
    lda collision_shots,y
    sty quad
    tay
    lda _shots+3,y
    beq @next_contact
    cpx #2
    bcs @distance
    tya
    lsr
    lsr
    eor _contact_target
    lsr
    bcc @next_contact
@distance:
    lda px
    sec
    sbc _shots,y
    cmp #19
    bcs @next_contact
    lda py
    sec
    sbc _shots+1,y
    cmp #19
    bcs @next_contact
    ; Drop calculation and scoring use the same zero-page scratch bytes.
    txa
    pha
    lda quad
    pha
    lda px
    pha
    lda py
    pha
    tya
    lsr
    lsr
    jsr _strike_tank
    tay
    pla
    sta py
    pla
    sta px
    pla
    sta quad
    pla
    tax
    tya
    bne @next_target
@next_contact:
    ldy quad
    dey
    bmi @next_target
    cpy #3
    bne @contact
    cpx #8
    bcc @contact
@next_target:
    dex
    bmi @done
    jmp @target
@done:
    rts

; Four NES sprites per tank. The two tread frames occupy adjacent 16-tile banks.
_draw_tank:
    tax
    ldy tank_offsets,x
    lda _tanks+3,y
    bne :+
    rts
:   lda _tanks,y
    sta tank_x
    lda _tanks+1,y
    sta tank_y
    lda #0
    sta flip
    lda _tanks+3,y
    cmp #32
    bcc @living
    cmp #39
    bcs @blast
    cpx #2
    bcc @small
    lda _tanks+5,y
    cmp #4
    bne :+
    lda #152
    bne @effect
:   asl
    asl
    clc
    adc #234
    bne @effect
@blast:
    cmp #42
    bcc @small
    cmp #48
    bcs @small
    cmp #45
    lda #202
    bcc :+
    lda #218
:   sta tank_tile
    lda #3
    sta tank_attr
    lda tank_x
    sec
    sbc #8
    sta tank_x
    lda tank_y
    sec
    sbc #8
    sta tank_y
    jsr draw_quad
    lda tank_x
    clc
    adc #16
    sta tank_x
    jsr next_blast_quad
    lda tank_x
    sec
    sbc #16
    sta tank_x
    lda tank_y
    clc
    adc #16
    sta tank_y
    jsr next_blast_quad
    lda tank_x
    clc
    adc #16
    sta tank_x
    jmp next_blast_quad
@small:
    and #4
    clc
    adc #152
    bne @effect
@living:
    cmp #1
    beq @tank
    sec
    sbc #2
    tay
    lda spawn_tiles,y
@effect:
    sta tank_tile
    lda #3
    sta tank_attr
    jmp draw_quad
@tank:
    cpx #2
    bcs @enemy
    lda _tanks+9,y
    beq :+
    lda _combat_frame
    and #8
    beq :+
    rts
:   stx tank_attr
    lda _tanks+7,y
    bpl @body
@enemy:
    lda _tanks+10,y
    beq @armor
    lda _combat_frame
    and #8
    beq @silver
    lda #3
    bne @paint
@armor:
    lda _tanks+4,y
    cmp #2
    bcc @silver
    ; Alternate the two damage colours every display frame.
    lda _combat_frame
    and #1
    asl
    asl
    clc
    adc _tanks+4,y
    tax
    lda armor_palette-1,x
    ldx owner
    jmp @paint
@silver:
    lda #2
@paint:
    sta tank_attr
    lda _tanks+5,y
    ora #4
@body:
    asl
    asl
    asl
    asl
    ora _tread,x
    sta tank_tile
    lda _tanks+2,y
    cmp #2
    bcc :+
    lda #$c0
    sta flip
:   lda _tanks+2,y
    and #1
    asl
    asl
    ora tank_tile
    sta tank_tile
    cpx #2
    bcs draw_quad
    lda _shield_sprites
    and slot_bits,x
    beq draw_quad
    jsr draw_quad
    lda #0
    sta flip
    lda _combat_frame
    and #2
    asl
    clc
    adc #176
    sta tank_tile
    lda #2
    sta tank_attr
    jmp draw_quad
.export _draw_bonus
.import _bonus, _bonus_x, _bonus_y, _bonus_points
_draw_bonus:
    lda _bonus_x
    sta tank_x
    lda _bonus_y
    sta tank_y
    lda #0
    sta flip
    lda #2
    sta tank_attr
    lda _bonus_points
    beq :+
    lda #250
    bne @tile
:   lda _bonus
    asl
    asl
    clc
    adc #124
@tile:
    sta tank_tile
    jmp draw_quad
next_blast_quad:
    lda tank_tile
    clc
    adc #4
    sta tank_tile
draw_quad:
    ldx _used_sprites
    cpx #240
    bcc :+
    jmp @individual
:   lda _has_trees
    beq @solid
    ; Only quads touching foliage need four independent priority checks.
    ; At the field boundary preserve the per-sprite clipping path.
    lda tank_x
    cmp #196
    bcs @partial
    clc
    adc #4
    tay
    lda tile_col,y
    sta px
    lda tile_col+8,y
    sta py
    lda tank_y
    cmp #196
    bcs @partial
    clc
    adc #4
    tay
    lda tile_row,y
    clc
    adc px
    tax
    lda _board,x
    and #$f0
    cmp #$40
    beq @partial
    lda tile_row,y
    clc
    adc py
    tax
    lda _board,x
    and #$f0
    cmp #$40
    beq @partial
    lda tile_row+8,y
    clc
    adc px
    tax
    lda _board,x
    and #$f0
    cmp #$40
    beq @partial
    lda tile_row+8,y
    clc
    adc py
    tax
    lda _board,x
    and #$f0
    cmp #$40
    beq @partial
    ldx _used_sprites
    jmp @solid
@partial:
    jmp @individual
@solid:
    lda tank_attr
    ora flip
    .repeat 4,i
      sta $0202+i*4,x
    .endrepeat
    lda tank_x
    clc
    adc #16
    sta $0203,x
    sta $020b,x
    clc
    adc #8
    sta $0207,x
    sta $020f,x
    lda tank_y
    clc
    adc #15
    sta $0200,x
    sta $0204,x
    clc
    adc #8
    sta $0208,x
    sta $020c,x
    lda tank_tile
    bit flip
    bmi @reverse
    .repeat 4,i
      sta $0201+i*4,x
      .if i < 3
        clc
        adc #1
      .endif
    .endrepeat
    jmp @committed
@reverse:
    .repeat 4,i
      sta $020d-i*4,x
      .if i < 3
        clc
        adc #1
      .endif
    .endrepeat
@committed:
    txa
    clc
    adc #16
    sta _used_sprites
    rts
@individual:
    lda #0
    sta quad
@part:
    ldx _used_sprites
    cpx #252
    bcc :+
    rts
:
    ldy quad
    lda quadrant_x,y
    clc
    adc tank_x
    sta px
    adc #16
    sta $0203,x
    lda quadrant_y,y
    clc
    adc tank_y
    sta py
    adc #15
    sta $0200,x
    tya
    bit flip
    bpl :+
    eor #3
:   clc
    adc tank_tile
    sta $0201,x
    lda _has_trees
    beq @front
    ; Resolve foliage priority at each sprite's centre.
    lda py
    clc
    adc #4
    tay
    lda tile_row,y
    sta row
    tya
    and #8
    sta mask_row
    lda px
    clc
    adc #4
    tay
    lda tile_col,y
    clc
    adc row
    tax
    lda _board,x
    tax
    and #$f0
    cmp #$40
    bne @front
    tya
    and #8
    lsr
    ora mask_row
    tay
    txa
    and quadrant_mask,y
    beq @front
    lda #32
    bne @attr
@front:
    lda #0
@attr:
    ora tank_attr
    ora flip
    ldx _used_sprites
    sta $0202,x
    txa
    clc
    adc #4
    sta _used_sprites
    inc quad
    lda quad
    cmp #4
    beq @return
    jmp @part
@return:
    rts

; Terrain is the most frequent lookup in movement and projectile simulation.
; cc65 passes y in A and x on the software stack.
_terrain:
    tax
    lda tile_row,x
    sta row
    txa
    and #8
    sta mask_row
    jsr popa
    tax
    lda tile_col,x
    clc
    adc row
    tay
    txa
    and #8
    lsr
    ora mask_row
    tax
    lda _board,y
    and quadrant_mask,x
    beq @empty
    lda _board,y
    lsr
    lsr
    lsr
    lsr
@empty:
    ldx #0
    rts
.segment "RODATA"
.export _large_letters
_large_letters: .incbin "logo.bin"
; First and second corners of the leading 16px edge for U,R,D,L.
leading_x: .byte 0,15,15,0
leading_y: .byte 0,15,15,0
trailing_x: .byte 15,15,0,0
trailing_y: .byte 0,0,15,15
; Both values are the high two bits of the pixel coordinate.
occ_column:
field_row_hi: .repeat 256,i
    .byte >((i/8)*32)
.endrepeat
occ_bit: .repeat 64,i
    .byte 1<<((i/8) .mod 8)
.endrepeat
delta_x: .byte 0,1,0,255
delta_y: .byte 255,0,1,0
collision_shots:
player_shots: .byte 0,4,32,36
    .byte 8,12,16,20,24,28
target_order: .byte 0,1,2,3,4,5,6,7,0,1
tank_offsets: .byte 0,13,26,39,52,65,78,91
quadrant_x: .byte 0,8,0,8
quadrant_y: .byte 0,0,8,8
spawn_tiles:
.repeat 28,i
    .if ((27-i) .mod 14) < 7
      .byte 160+((7-((27-i) .mod 14))/2)*4
    .else
      .byte 160+((((27-i) .mod 14)-7)/2)*4
    .endif
.endrepeat
row_hi: .repeat 16,i
    .byte >($2000+i*32)
.endrepeat
row_lo: .repeat 16,i
    .byte <($2000+i*32)
.endrepeat
bottom_hi: .repeat 16,i
    .byte >($2000+(29-i)*32)
.endrepeat
bottom_lo: .repeat 16,i
    .byte <($2000+(29-i)*32)
.endrepeat
tile_row:
.repeat 208,i
    .byte (i/16)*13
.endrepeat
tile_col:
.repeat 208,i
    .byte i/16
.endrepeat
quadrant_mask: .byte 1,0,0,0,2,0,0,0,4,0,0,0,8
_maps: .incbin "levels.bin",0,2975
_enemies: .incbin "levels.bin",2975,175
_enemy_groups: .incbin "levels.bin",3150,140
.segment "CHARS"
.incbin "art.chr"
.segment "VECTORS"
.addr nmi,reset,irq

; The two words in the idle arena are terrain. Every nibble describes the
; remaining 4x4 pieces in one 8x8 tile, shared by drawing and collisions.
.segment "DEMO"
.import _missing_bricks
.export _draw_demo_bricks
; Reuse the sprite scratch bytes while rendering is disabled.
demo_cell_index = owner
demo_damage_index = flip
demo_pairs_left = quad
_draw_demo_bricks:
    lda #0
    sta row
    ldx #0                 ; packed letter data offset
@row:
    ldy row
    lda demo_ppu_hi,y
    sta $2006
    lda demo_ppu_lo,y
    sta $2006
    lda demo_field_offsets,y
    sta demo_cell_index
    lda demo_damage_offsets,y
    sta demo_damage_index
    lda demo_quadrant,y
    sta mask_row
    lda #13
    sta demo_pairs_left
@pair:
    lda demo_parts,x
    eor #$ff
    ldy demo_damage_index
    sta _missing_bricks,y
    lda demo_parts,x
    and #15
    jsr @tile
    beq :+
    lda mask_row
    ora #16
    ldy demo_cell_index
    ora _board,y
    sta _board,y
:   lda demo_parts,x
    lsr
    lsr
    lsr
    lsr
    jsr @tile
    beq :+
    lda mask_row
    asl
    ora #16
    ldy demo_cell_index
    ora _board,y
    sta _board,y
:   inx
    inc demo_cell_index
    inc demo_damage_index
    dec demo_pairs_left
    bne @pair
    inc row
    lda row
    cmp #8
    bne @row
    rts
@tile:
    beq :+
    ora #$e0
:   sta $2007
    rts
; Nametable, 16px cell, 8px damage and quadrant offsets for field rows
; 7–10 (BATTLE) and 13–16 (CITY), from top to bottom.
demo_ppu_hi: .byte $21,$21,$21,$21,$21,$22,$22,$22
demo_ppu_lo: .byte $22,$42,$62,$82,$e2,$02,$22,$42
demo_field_offsets: .byte $27,$34,$34,$41,$4e,$5b,$5b,$68
demo_damage_offsets: .byte $5b,$68,$75,$82,$a9,$b6,$c3,$d0
demo_quadrant: .byte $04,$01,$04,$01,$04,$01,$04,$01
demo_parts:
    .byte $a0,$37,$0d,$be,$04,$f3,$03,$f3,$03,$0f,$00,$3f,$03
    .byte $a0,$cd,$a7,$05,$0f,$f0,$00,$f0,$00,$0f,$00,$cf,$04
    .byte $a0,$05,$af,$37,$0f,$f0,$00,$f0,$00,$0f,$00,$0f,$00
    .byte $20,$33,$21,$01,$03,$30,$00,$30,$00,$33,$03,$33,$03
    .byte $00,$00,$00,$c0,$0c,$c8,$4c,$c8,$4c,$48,$48,$00,$00
    .byte $00,$00,$00,$1e,$12,$a0,$05,$a0,$05,$5a,$5a,$00,$00
    .byte $00,$00,$00,$0f,$00,$a0,$05,$a0,$05,$b0,$07,$00,$00
    .byte $00,$00,$00,$d2,$1e,$e8,$4d,$a0,$05,$a0,$05,$00,$00
