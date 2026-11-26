# English Switch terminal sample

The 60 fps video and its independent AAC stream come from audap's Battle City
chapter in [Namco Museum Archives Vol. 2 Switch](https://www.youtube.com/watch?v=qb1BUVeAquI&t=624s).
The HLS excerpts start at 425.716665 and 605.966664 seconds respectively. Their
digests are recorded in the CSV files. Photography and web compression can alter
both signals. Empty audio tail fields mean no continuous 100 ms quiet interval
at that threshold in the 2.15-second sample.

With the exact excerpts and the native zero-kill ending WAV used in the clock
comparison, reproduce both rows with the following commands.

```sh
python3 tests/nes/switch_terminal_visual.py audap swap-audap.mp4 visual.csv
python3 tests/nes/switch_terminal_sample.py game.wav "$native_onset_seconds" clips audio.csv --audap
```
