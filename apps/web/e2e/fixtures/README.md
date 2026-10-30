Synthetic e2e fixtures, generated in code (CC0). `accelerometer.csv`: 20 s, 50 Hz, 3 axes; rest, walk, run, then a fall spike at 17 s.
`ner.txt`: two invented-for-test sentences about historical figures (CC0).

`annotations/<dataset>.json`: the saved annotations the e2e dev server (`INKLING_E2E=1`) starts
from, copied to a temp folder per server start (vite.config.ts), so tests never read or write
`seed-data/.annotations`. `2d-xray.json` holds the five boxes `image2d_test.py` expects on
`IM-0001-0001.jpeg` (`BOX1` keeps its id for the resize check).
