"""Exercise the same gate used by the delivery packager."""
import csv
import tempfile
import unittest
from pathlib import Path

from ending_parity import BASELINE, FIELDS, ROUTES, read_events, verify


class EndingParityTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.traces = {route: [] for route in ROUTES}
        for route, *event in read_events(BASELINE, ('route', *FIELDS)):
            self.traces[route].append(event)
        for route, events in self.traces.items():
            for platform in ('web', 'tv'):
                self.write_trace(platform, route, events)

    def write_trace(self, platform, route, events):
        folder = self.root / f'{platform}-{route}'
        folder.mkdir(exist_ok=True)
        with (folder / 'events.csv').open('w', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(FIELDS)
            writer.writerows(events)

    def test_recording(self):
        self.assertEqual(sum(verify(self.root, self.root).values()), 830)

    def test_first_difference(self):
        route = 'coop-stage18'
        changes = ('99999', '1.00000000', 'unexpected-event', 'different')
        for field, (label, replacement) in enumerate(zip(FIELDS, changes)):
            with self.subTest(field=label):
                events = [row[:] for row in self.traces[route]]
                events[2][field] = replacement
                self.write_trace('tv', route, events)
                with self.assertRaisesRegex(ValueError, f'{route} event 3, {label}'):
                    verify(self.root, self.root)

    def test_deleted_event(self):
        events = self.traces['neutral']
        self.write_trace('tv', 'neutral', events[:-1])
        with self.assertRaisesRegex(ValueError, f'neutral event {len(events)}:.*TV=None'):
            verify(self.root, self.root)

    def test_shared_regression(self):
        events = self.traces['record']
        for platform in ('web', 'tv'):
            self.write_trace(platform, 'record', events[1:])
        with self.assertRaisesRegex(ValueError, 'record event 1, .*baseline='):
            verify(self.root, self.root)


if __name__ == '__main__':
    unittest.main()
