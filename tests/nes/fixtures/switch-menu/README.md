# English Switch menu references

The coordinates and colour thresholds use the 1280 × 720 grid defined in
`switch_menu_regions.py`. Each JSON record identifies the source video, time in
seconds, SHA-256 of the unregistered PNG, and measured outer-border registration.
The mask field holds one byte per ROI pixel in row-major order, compressed with zlib
and hex-encoded. The original fixed reference uses an empty registration object.

The system menu has two calibration and two reserved captures from each recording.
Screen Settings uses two calibration and two reserved captures from the common
English collection menu. Both labels describe the collection shell. Repeated
captures within one video share an author and a recording. Each of the six regions
also has one fixed anchor. Freeze the samples before changing the artwork.

Sources are [English collection gameplay](https://www.youtube.com/watch?v=S26lUv598_o)
and [the second Switch recording](https://www.youtube.com/watch?v=dv9axuULtdA).
