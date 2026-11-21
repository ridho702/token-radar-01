# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ridho702/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ridho702/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar: 614 protocols that record no token, ranked by implied value. The value model is a log-log regression fitted at runtime from the 144 protocols whose token trades (stage 1: log market cap on log TVL; stage 2: residual on 7-day growth and log age, shrunk and clamped because the data says growth and age move the multiple only slightly), times token odds from each category's and age band's launch track record — an expected value, not a prediction of if or when a token launches. Every row carries a concrete 6-step farm plan with tiered amounts, gas costs and a cost-vs-value verdict, and the dashboard is sortable, filterable, and shows a detail view plus the fitted model and its held-out validation numbers.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Validation (fitted at runtime, median |log error|): held-out seed 1 and seed 2 plus a walk-forward split, all beating a v1-style median-ratio baseline — the exact numbers are printed by the run and shown on the dashboard's Model tab. The screenshots in this repo are real captures of the dashboard at 1440×900.

---

<sub>Entered on [make.fun](https://make.fun/?ref=pxdmc197&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
