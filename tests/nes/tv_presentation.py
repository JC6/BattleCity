"""Associate each measured NES frame with a display receipt from its SurfaceView."""
import csv
import io
import re
from collections import defaultdict


def varint(raw, position):
    value = 0
    for shift in range(0, 70, 7):
        if position >= len(raw):
            raise ValueError('truncated protobuf varint')
        byte = raw[position]
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
    raise ValueError('invalid protobuf varint')


def fields(raw):
    position = 0
    while position < len(raw):
        tag, position = varint(raw, position)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError('invalid protobuf field number')
        if wire == 0:
            value, position = varint(raw, position)
        else:
            if wire == 2:
                size, position = varint(raw, position)
            elif wire in (1, 5):
                size = 8 if wire == 1 else 4
            else:
                raise ValueError('unexpected protobuf wire type')
            end = position + size
            if end > len(raw):
                raise ValueError('truncated protobuf field')
            value = raw[position:end]
            position = end
        yield number, value


def surface_receipts(raw, package):
    # TracePacket.graphics_frame_event (57), BufferEvent.PRESENT_FENCE (8).
    layers = defaultdict(dict)
    owner = re.compile(r'(?<![\w.])' + re.escape(package) + r'(?![\w.])')
    for number, packet in fields(memoryview(raw)):
        if number != 1:
            continue
        packet = dict(fields(packet))
        if 57 not in packet or 8 not in packet:
            continue
        event = dict(fields(packet[57]))
        buffer = dict(fields(event.get(1, b'')))
        name = bytes(buffer.get(3, b'')).decode(errors='replace')
        if (buffer.get(2) != 8 or 1 not in buffer or 'SurfaceView' not in name
                or 'Background for SurfaceView' in name or not owner.search(name)):
            continue
        observed = layers[name]
        frame = buffer[1]
        # For a duration event the fence signals at its end. Duplicate observations
        # cannot identify a unique presentation of this buffer frame.
        observed[frame] = packet[8] + buffer.get(4, 0) if frame not in observed else 0
    return layers


def csv_records(raw):
    reader = csv.reader(io.StringIO(raw.decode()))
    return [tuple(map(int, record)) for record in reader if len(record) == 4]


def observed_count(times):
    valid = [time for time in times if time > 0]
    return len(valid) if all(a < b for a, b in zip(valid, valid[1:])) else 0


def reconcile(rows, mapping, presented, trace, package):
    buffers = csv_records(mapping)
    native = {}
    for generation, nes, buffer_id, stamp in csv_records(presented):
        key = (generation, nes, buffer_id)
        native[key] = stamp if key not in native else 0
    try:
        layers = surface_receipts(trace, package)
    except (TypeError, ValueError):
        layers = {}

    receipts = []
    for row in rows:
        count, last = row['frames'], row['lastSubmittedFrame']
        sent = [item for item in buffers if last-count < item[1] <= last]
        ids = [item[2] for item in sent]
        valid = (count > 0 and len(sent) == count and len({item[0] for item in sent}) == 1
                 and all(gen > 0 and buf > 0 and elapsed >= 0 for gen, _, buf, elapsed in sent)
                 and [item[1] for item in sent] == list(range(last-count+1, last+1))
                 and ids == list(range(ids[0], ids[0]+count)))
        times = [native.get((gen, nes, buf), 0) for gen, nes, buf, _ in sent]
        source = 'unverified'
        partial = observed_count(times) if valid else 0
        selected = times if partial else [0] * len(sent)
        row.pop('displayLayer', None)
        if valid and partial == count:
            source = 'EGL_DISPLAY_PRESENT_TIME_ANDROID'
        elif valid:
            coverage = {name: observed_count([obs.get(i, 0) for i in ids])
                        for name, obs in layers.items()}
            complete = [name for name, observed in coverage.items() if observed == count]
            if len(complete) == 1:
                source = 'SurfaceFlinger PRESENT_FENCE'
                row['displayLayer'] = complete[0]
                selected = [layers[complete[0]].get(i, 0) for i in ids]
            elif len(coverage) == 1:
                name, observed = next(iter(coverage.items()))
                if observed > partial:
                    partial = observed
                    selected = [layers[name].get(i, 0) for i in ids]

        row['displayEvidence'] = source
        row['mappedFrames'] = len(sent)
        row['identifiedBuffers'] = sum(i > 0 for i in ids)
        row['verifiedPresentations'] = count if source != 'unverified' else 0
        row['individuallyObserved'] = count if source != 'unverified' else partial
        row['nativeTimestampCount'] = sum(stamp > 0 for stamp in times)
        row['systemReceiptLayers'] = {name: sum(obs.get(i, 0) > 0 for i in ids)
                                      for name, obs in layers.items()}
        row['swapMsPerFrame'] = sum(item[3] for item in sent)/1e6/len(sent) if sent else 0
        receipts.append([max(0, stamp) for stamp in selected])
    return receipts
