"""Compile the repository's NES cue bytecode to vblank-timed note streams."""
import ast
import re


def _expand(track, periods):
    channel, control, sweep, length = track[:4]
    offset = 5 if channel == 4 else 4
    regs = [control, sweep, 0, length]
    duration = 0
    counters = [0, 0, 0]
    positions = {}
    notes = []
    while offset < len(track):
        # A recurring decoder state identifies the beginning of an engine loop.
        state = (offset, duration, tuple(counters), tuple(regs))
        if state in positions:
            return notes, positions[state]
        positions[state] = len(notes)
        op = track[offset]
        offset += 1
        if op < 0x60:
            timer = periods[op >> 3] >> (op & 7)
            regs[2] = timer & 255
            regs[3] = (regs[3] & 0xf8) | (timer >> 8)
            assert 0 < duration < 256
            notes.append([duration, *regs, 1])
        elif op == 0x60:
            notes.append([duration, *regs, 0])
        elif op < 0xe8:
            duration = op - 0x60
        elif op == 0xe8:
            return notes, None
        elif op == 0xef:
            counters = [0, 0, 0]
            notes.append([120])
        elif 0xf0 <= op <= 0xf2:
            counter = op - 0xf0
            repeat, target = track[offset:offset + 2]
            offset += 2
            counters[counter] += 1
            if counters[counter] == repeat:
                counters[counter] = 0
                notes.append([124 + counter])
            else:
                notes.append([121 + counter])
                offset = target
        elif op == 0xf9:
            offset = track[offset]
        elif op in (0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee):
            value = track[offset]
            offset += 1
            if op == 0xec:
                regs[1] = value
            elif op == 0xed:
                regs[3] = value
            else:
                mask = {0xe9: 0x3f, 0xea: 0xc0, 0xeb: 0xf0, 0xee: 0}[op]
                regs[0] = (regs[0] & mask) | value
        else:
            raise ValueError(f'unknown audio opcode {op:#x}')
    raise ValueError('unterminated audio track')


def compile_audio(catalogue):
    source = re.sub(r'//[^\n]*', '', catalogue.read_text())
    periods = ast.literal_eval(re.search(r'NOTE_PERIODS = (\[[^\]]+\])', source)[1])
    tracks = ast.literal_eval(source.split('AUDIO_TRACKS:', 1)[1].split('= ', 1)[1]
                              .split(';', 1)[0].replace('null', 'None'))
    assert len(tracks) == 28 and all(not t or 1 <= t[0] <= 4 for t in tracks)
    names = [f'cue_{i}' if track else '0' for i, track in enumerate(tracks)]
    lines = ['cue_lows: .lobytes ' + ','.join(names),
             'cue_highs: .hibytes ' + ','.join(names),
             'cue_channels: .byte ' + ','.join(str(t[0]-1 if t else 0) for t in tracks)]
    registers = {}
    for name, track in zip(names, tracks):
        if not track:
            continue
        notes, loop = _expand(track, periods)
        lines.append(name + ':')
        offsets = []
        position = 0
        for note in notes:
            offsets.append(position)
            position += 1 if len(note) == 1 else 2
            if len(note) == 1:
                lines.append(f"    .byte {note[0]}")
                continue
            duration, control, sweep, low, high, retrigger = note
            assert 0 < duration < 120
            index = registers.setdefault((control, sweep, low, high), len(registers))
            lines.append(f"    .byte {duration | (0 if retrigger else 128)},{index}")
        lines.extend(['    .byte 0', '    .addr ' + ('0' if loop is None else f'{name}+{offsets[loop]}')])
    assert len(registers) <= 256
    for column, name in enumerate(('note_control','note_sweep','note_low','note_high')):
        lines.append(name + ': .byte ' + ','.join(str(reg[column]) for reg in registers))
    return '\n'.join(lines) + '\n'
