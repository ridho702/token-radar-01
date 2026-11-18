# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/purwo-rustino/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/purwo-rustino/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: a program that reads a sealed snapshot of the protocol universe, ranks every pre-token protocol by an implied value computed from the market itself, and writes a dashboard a reader can use to decide what to farm next.

## The model

No flat multiple, no hardcoded names. For every live-token protocol the snapshot records, the model takes market cap divided by TVL, groups the ratios by category, and takes the median: that is what the market pays for one dollar of TVL in that category. A category with fewer than four live comparables falls back to the global median. Then:

```
implied value = TVL × category multiple × growth × maturity
```

Growth clamps the seven-day TVL change to −60% … +120% and weights it by 0.5. Maturity runs from 0.60 for a brand-new protocol to 1.00 after 1,095 days with no token (unknown listing date counts as 365 days). The dashboard prints every multiple with its comp count, and shows a log-log regression of market cap on TVL as a check on how tightly TVL tracks value.

The board ranks all 198 rankable pre-token protocols in the snapshot (the 40-protocol watchlist plus every other pre-token protocol below the floor that is not a wrapped, staked or bridged product of a token that already trades). Each row carries a six-step farm plan derived from the protocol's own category, chains, TVL and age, with what each step costs and how long it takes. Live-token protocols are shown separately at the market's own values, never mixed into the ranking.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

`main.ts` (Node 22, standard library only) reads `/input/snapshot.json`, writes `board.json` and `data.js` to the output directory, copies `dashboard/` and `screenshots/` there, and writes `dossier.json` with the vendored make.fun library. Run it twice and the bytes are identical. Open `out/dashboard/index.html` in a browser: the board is sortable and filterable, every row opens a detail view with the model's arithmetic and its farm plan, and the model tab shows the multiples and the market-fit check.

---

<sub>Entered on [make.fun](https://make.fun/?ref=11377kcy&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
