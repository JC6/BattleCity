"""Check the two delivered runtimes' ordered ending traces against the accepted recording."""
import argparse
import csv
from itertools import zip_longest
from pathlib import Path

ROUTES = ('neutral', 'record', 'skip-over', 'coop-stage18', 'coop-stage42')
FIELDS = ('frame', 'emu_s', 'event', 'value')
BASELINE = Path(__file__).with_name('fixtures') / 'ending' / 'platform-events.csv'


def read_events(path, fields):
    with path.open(newline='') as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != list(fields):
            raise ValueError(f'{path}: expected columns {fields}, got {reader.fieldnames}')
        for row in reader:
            if None in row or None in row.values():
                raise ValueError(f'{path}:{reader.line_num}: incomplete or extra CSV field')
            yield tuple(row[field] for field in fields)


def compare(route, left_name, left, right_name, right):
    for index, (a, b) in enumerate(zip_longest(left, right), start=1):
        if a == b:
            continue
        if a is None or b is None:
            raise ValueError(f'{route} event {index}: {left_name}={a}, {right_name}={b}')
        field = next(i for i in range(len(FIELDS)) if a[i] != b[i])
        raise ValueError(f'{route} event {index}, {FIELDS[field]}: '
                         f'{left_name}={a[field]!r}, {right_name}={b[field]!r}')


def verify(web, tv):
    baseline = {route: [] for route in ROUTES}
    for route, *event in read_events(BASELINE, ('route', *FIELDS)):
        if route not in baseline:
            raise ValueError(f'unknown route in accepted ending trace: {route}')
        baseline[route].append(tuple(event))
    counts = {}
    for route in ROUTES:
        expected = baseline[route]
        if not expected:
            raise ValueError(f'{route}: missing accepted ending trace')
        browser = list(read_events(web / f'web-{route}/events.csv', FIELDS))
        device = read_events(tv / f'tv-{route}/events.csv', FIELDS)
        compare(route, 'Web', browser, 'TV', device)
        compare(route, 'baseline', expected, 'Web', browser)
        counts[route] = len(browser)
    return counts


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('web', type=Path)
    parser.add_argument('tv', type=Path)
    args = parser.parse_args()
    for case, count in verify(args.web, args.tv).items():
        print(f'{case}: {count} matched events')
