Synthetic e2e fixtures, generated in code (CC0). `accelerometer.csv`: 20 s, 50 Hz, 3 axes; rest, walk, run, then a fall spike at 17 s.
`ner.txt`: two invented-for-test sentences about historical figures (CC0).

`annotations/<dataset>.json`: the saved annotations the e2e dev server (`INKLING_E2E=1`) starts
from, copied to a temp folder per server start (vite.config.ts), so tests never read or write
`seed-data/.annotations`. `2d-xray.json` holds the five boxes `image2d_test.py` expects on
`IM-0001-0001.jpeg` (`BOX1` keeps its id for the resize check).

`pipelines/`: synthetic pipeline runs for `pipeline_runs_test.py` (todo12 M1), shaped like the
gateway routes in `apps/web/src/studio/core/pipelines/contract.ts`: `runs.json` (the project's
list), `run_review.json` (ten mixed files, one quarantined, one rejected, a candidate waiting
for review) and `run_live.json` (a run mid-step). File names are invented; no real data.
