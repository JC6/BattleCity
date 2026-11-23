; One tick per NES vblank. Lower cue IDs win a shared hardware channel.
; The game posts single-byte requests. Only the NMI updates playback state.
.export audio_init, audio_tick, _audio_commands, _audio_clear, _audio_paused
.exportzp _sound_loops
.export _sound_source, _sound_work, _sound_channels
CUES = 28

.segment "BSS"
_audio_commands: .res CUES
_audio_clear:    .res 1
_audio_paused:   .res 1

.segment "ZEROPAGE"
note_lo:   .res CUES
note_hi:   .res CUES
remaining: .res CUES
retrigger: .res CUES
stream:    .res 2
claimed:   .res 1
limit:     .res 1
slot:      .res 1
was_paused: .res 1
_sound_source: .res 2
_sound_work: .res 2
_sound_loops: .res 3
_sound_channels = claimed

.segment "CODE"
audio_init:
    lda #$0f
    sta $4015
    lda #1
    sta _audio_clear
    rts

audio_tick:
    lda _audio_clear
    beq @pause
    ldx #CUES-1
    lda #0
@clear:
    sta note_hi,x
    sta _audio_commands,x
    dex
    bpl @clear
    sta _audio_clear
    sta was_paused
@pause:
    ldx #CUES
    lda _audio_paused
    beq @resume
    ldx #1
    bne @begin
@resume:
    ldy was_paused
    beq @begin
    ldy #CUES-1
    lda #1
@restore:
    sta retrigger,y
    dey
    bpl @restore
    lda #0
    sta note_hi
@begin:
    stx limit
    lda _audio_paused
    sta was_paused
    lda #0
    sta claimed
    ldx #0
@mix:
    lda _audio_commands,x
    cmp #2
    beq @next
    lda note_hi,x
    beq @next
    ldy cue_channels,x
    lda masks,y
    bit claimed
    bne @next
    ora claimed
    sta claimed
    lda retrigger,x
    beq @next
    lda #0
    sta retrigger,x
    lda note_lo,x
    sta stream
    lda note_hi,x
    sta stream+1
    stx slot
    tya
    asl
    asl
    tax
    ldy #1
    lda (stream),y
    tay
    lda note_control,y
    sta $4000,x
    lda note_sweep,y
    sta $4001,x
    lda note_low,y
    sta $4002,x
    lda note_high,y
    sta $4003,x
    ldx slot
@next:
    inx
    cpx limit
    bne @mix
    ldx #0
@mute:
    lda masks,x
    bit claimed
    bne @muted
    ldy offsets,x
    lda silence,x
    sta $4000,y
@muted:
    inx
    cpx #4
    bne @mute

    lda #3
    sta _sound_work
    ; Decode after mixing. The first note is written on the following tick.
    ldx #0
@advance:
    lda _audio_commands,x
    beq @continue
    tay
    lda #0
    sta _audio_commands,x
    cpy #1
    beq @start
    sta note_hi,x
    jmp @advanced
@start:
    lda cue_lows,x
    sta note_lo,x
    lda cue_highs,x
    sta note_hi,x
    bne @read
@skip:
    jmp @advanced
@continue:
    lda note_hi,x
    beq @skip
    dec remaining,x
    bne @skip
    lda note_lo,x
    clc
    adc #2
    sta note_lo,x
    bcc @read
    inc note_hi,x
@read:
    lda source_lo,x
    sta _sound_source
    lda source_hi,x
    sta _sound_source+1
    lda note_lo,x
    sta stream
    lda note_hi,x
    sta stream+1
    ldy #0
    lda (stream),y
    bne @note
    iny
    lda (stream),y
    sta note_lo,x
    iny
    lda (stream),y
    sta note_hi,x
    bne @read
    lda #$0a
    sta _sound_work
    lda #$ec
    sta _sound_work+1
    bne @advanced
@note:
    ; Bytes 120..126 are zero-time updates to the three music loop counters.
    cmp #120
    bcc @duration
    cmp #127
    bcs @duration
    sec
    sbc #120
    beq @clear_loops
    tay
    cmp #4
    bcs @reset_loop
    lda _sound_loops-1,y
    clc
    adc #1
    sta _sound_loops-1,y
    jmp @after_loop
@reset_loop:
    lda #0
    sta _sound_loops-4,y
    beq @after_loop
@clear_loops:
    sta _sound_loops
    sta _sound_loops+1
    sta _sound_loops+2
@after_loop:
    inc note_lo,x
    bne @read
    inc note_hi,x
    jmp @read
@duration:
    pha
    and #$7f
    sta remaining,x
    pla
    bmi @advanced
    ldy #1
    lda (stream),y
    tay
    lda note_high,y
    and #7
    sta _sound_work
    lda note_low,y
    sta _sound_work+1
    lda #1
    sta retrigger,x
@advanced:
    inx
    cpx limit
    beq :+
    jmp @advance
:   rts

.segment "RODATA"
; The game RNG observes the logical base address of the last cue decoded.
; Logical sound-bank addresses sampled by the combat mixer. The playback
; cursors above refer to our expanded note streams instead.
source_lo: .byte $2c,$36,$5d,$88,$9f,$ae,$19,$b3,$d5,$48,$03,$f4,$5e,$56,$67,$12,$95,$8c,$82,$73,$7a,$c1,$df,$0a,$3c,$4f,$62,$3a
source_hi: .byte $ee,$ed,$ed,$ed,$ee,$ee,$ee,$ed,$ed,$ee,$ee,$ed,$ee,$ee,$ee,$ee,$ee,$ee,$ee,$ee,$ee,$ee,$ee,$ef,$ef,$ef,$ef,$ee
masks:   .byte 1,2,4,8
offsets: .byte 0,4,8,12
silence: .byte $10,$10,0,$10
.include "audio.inc"
