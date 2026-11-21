// Token Launch Radar v3 — main.ts
// Reads the sealed DefiLlama snapshot, fits a two-stage log-log value model on the
// 128 token-bearing protocols with a positive market cap, scores every pre-token
// protocol by expected value (fitted fair value x token-launch odds), drops the
// protocols whose brand already has a token trading (integrity filter), and writes
// board.json, the dashboard data file, and dossier.json.
// Everything is computed at runtime from the snapshot: no protocol name is hardcoded.
// Deterministic: same input bytes -> same output bytes.
//
// Model (see README.md for the plain-English version):
//   Stage 1: log(mcap) = a (+ category intercept) + b * log(tvl), OLS.
//     Two versions are fitted and compared on held-out data: pooled (one intercept)
//     and category-intercept (pooled slope; each category with >= 4 live
//     protocols gets its own intercept = pooled intercept + shrunk mean
//     residual, shrunk toward pooled by n/(n+4)).
//   Stage 2: residuals ~ c0 + g* growth + a * log(ageDays), OLS on the 95 live
//     protocols that report both a 7-day change and a listing date. The growth and
//     age coefficients are shrunk x0.5 and the total adjustment is clamped to
//     +/-0.35 log points. The intercept c0 is a mean offset of that 95-protocol
//     subset and is NOT applied to predictions.
//   Odds: category token rate (shrunk toward the 19% global rate) x an age-band
//     factor (band rate / global, shrunk the same way), clamped to [0.02, 0.50].
//   Score (expected value): implied_value_usd = round(exp(logImplied) * odds).
//     This is an expected value = fair value x probability of a launch; it is not
//     a prediction that a token will launch, or when.

import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

// ---------- Types (erasable only: no enums, no parameter properties) ----------

type Proto = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

type Snap = {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
};

type BoardRow = {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  odds: number;
  category: string | null;
  tvl_usd: number;
  multiple: number;
  growth: number;
  age_days: number;
  has_token: boolean;
  watchlist: boolean;
  farm_steps: string[];
};

type Excluded = { slug: string; name: string; reason: string };

// ---------- Small helpers ----------

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Deterministic PRNG (mulberry32) so the held-out splits are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// OLS by Gaussian elimination on the normal equations, with a tiny ridge for
// numerical stability. X is an array of rows, y the targets.
function ols(X: number[][], y: number[]): number[] {
  const p = X[0].length;
  const xtx: number[][] = [];
  const xty: number[] = [];
  for (let i = 0; i < p; i++) {
    xtx.push(new Array<number>(p).fill(0));
    xty.push(0);
  }
  for (let k = 0; k < X.length; k++) {
    for (let i = 0; i < p; i++) {
      xty[i] += X[k][i] * y[k];
      for (let j = 0; j < p; j++) xtx[i][j] += X[k][i] * X[k][j];
    }
  }
  for (let i = 0; i < p; i++) xtx[i][i] += 1e-9;
  // Solve xtx * beta = xty with partial pivoting.
  const m: number[][] = xtx.map((row, i) => [...row, xty[i]]);
  for (let i = 0; i < p; i++) {
    let piv = i;
    for (let r = i + 1; r < p; r++) if (Math.abs(m[r][i]) > Math.abs(m[piv][i])) piv = r;
    const tmp = m[i];
    m[i] = m[piv];
    m[piv] = tmp;
    const d = m[i][i];
    for (let j = i; j <= p; j++) m[i][j] /= d;
    for (let r = 0; r < p; r++) {
      if (r === i) continue;
      const f = m[r][i];
      if (f === 0) continue;
      for (let j = i; j <= p; j++) m[r][j] -= f * m[i][j];
    }
  }
  return m.map((row) => row[p]);
}

function rSquared(ys: number[], preds: number[]): number {
  const ym = mean(ys);
  let ss = 0;
  let st = 0;
  for (let i = 0; i < ys.length; i++) {
    ss += (ys[i] - preds[i]) * (ys[i] - preds[i]);
    st += (ys[i] - ym) * (ys[i] - ym);
  }
  return st === 0 ? 0 : 1 - ss / st;
}

// Compact base-36 encoding of a non-negative integer (for data.js).
function b36(n: number): string {
  const v = Math.max(0, Math.round(n));
  return v.toString(36);
}

// "$37.21M" / "$812.40K" / "$640" style compact money.
function fmtCompactUsd(v: number): string {
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(2) + "K";
  return "$" + Math.round(v);
}

// Sibling market cap as printed in integrity reasons ("$1.72B").
function fmtMcap(v: number): string {
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(2) + "K";
  return "$" + Math.round(v);
}

// Plain money for farm-plan costs: whole dollars at/above $1 ("$21"),
// two decimals below $1 ("$0.50").
function fmtMoney(v: number): string {
  return v >= 1 ? "$" + Math.round(v) : "$" + v.toFixed(2);
}

// ---------- Snapshot-derived features ----------

const AS_OF = "2026-11-14"; // snapshot date; age is measured to this day.

function parseDay(s: string): number {
  const parts = s.split("-").map((x) => Number(x));
  return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000;
}

const AS_OF_DAY = parseDay(AS_OF);

// Age in days. listed_at null -> 365 days (stated assumption: unknown age is
// treated as one year old, the middle of the observed range).
function ageDays(p: Proto): number {
  if (!p.listed_at) return 365;
  return Math.max(1, AS_OF_DAY - parseDay(p.listed_at));
}

// 7-day TVL growth as a fraction. change_7d is in PER CENT in the snapshot
// (12.5 means +12.5%), so divide by 100, then clamp to [-0.9, +5.0].
// Null (4 pre-token protocols) -> 0.
function growthFrac(p: Proto): number {
  if (p.change_7d === null || p.change_7d === undefined) return 0;
  return clamp(p.change_7d / 100, -0.9, 5.0);
}

// Brand stem: strip a trailing version suffix (-vN) then take the first
// hyphen segment. stem("aave-v3") = "aave"; stem("morpho-blue") = "morpho".
function stem(slug: string): string {
  return slug.replace(/-v\d+$/, "").split("-")[0];
}

// ---------- Farm plans (English; same templates as dashboard/app.js) ----------
// Gas is a planning estimate, not a live quote. Tiers: Small $100 / Medium
// $1,000 / Large $10,000 of activity. Cost per tier = txCount [3,5,7] x gas
// + $3 bridge.

const GAS: Record<string, number> = {
  Ethereum: 6,
  Arbitrum: 0.3,
  Base: 0.15,
  Optimism: 0.2,
  Solana: 0.02,
  Avalanche: 0.3,
  BSC: 0.2,
  Polygon: 0.05,
};
const GAS_DEFAULT = 0.5;

function gasOf(chain: string): number {
  return GAS[chain] !== undefined ? GAS[chain] : GAS_DEFAULT;
}

function catAction(category: string | null): [string, string] {
  // [verb phrase, noun] per category, English.
  switch (category) {
    case "Dexs":
      return ["Swap and provide liquidity", "swap"];
    case "Lending":
      return ["Supply assets and borrow", "supply"];
    case "Yield":
    case "Yield Aggregator":
    case "Farm":
      return ["Deposit into the vault and compound rewards", "deposit"];
    case "Liquid Staking":
    case "Liquid Restaking":
    case "Restaking":
    case "Staking Pool":
      return ["Stake and restake", "stake"];
    case "Bridge":
    case "Cross Chain Bridge":
    case "Canonical Bridge":
      return ["Bridge assets across chains", "bridge"];
    case "Derivatives":
    case "Options":
    case "Options Vault":
    case "Basis Trading":
      return ["Open positions and manage margin", "position"];
    case "CDP":
    case "CDP Manager":
      return ["Open a vault and mint stablecoins", "vault"];
    case "RWA":
      return ["Buy and hold tokenized assets", "RWA position"];
    case "Prediction Market":
      return ["Place positions in prediction markets", "position"];
    case "Launchpad":
      return ["Stake and join token sales", "participation"];
    case "Payments":
    case "Crypto Card Issuer":
      return ["Use the protocol for routine payments", "payment"];
    case "Insurance":
    case "Risk Curators":
      return ["Buy cover and provide underwriting", "cover"];
    case "NFT Marketplace":
      return ["Buy and sell NFTs", "NFT trade"];
    case "Stablecoin Issuer":
    case "Algo-Stables":
    case "Dual-Token Stablecoin":
      return ["Mint and hold the stablecoin", "mint"];
    default:
      return ["Use the protocol regularly", "activity"];
  }
}

// Cheapest chain of a protocol (first one wins ties), for the step-1 alternative.
function cheapestChain(chains: string[]): string {
  let best = chains[0];
  let bestGas = gasOf(best);
  for (const c of chains) {
    const g = gasOf(c);
    if (g < bestGas) {
      best = c;
      bestGas = g;
    }
  }
  return best;
}

function buildFarmSteps(
  name: string,
  category: string | null,
  chains: string[],
  impliedValueUsd: number,
): string[] {
  const chain = chains.length > 0 ? chains[0] : "Ethereum";
  const gas = gasOf(chain);
  const cheap = cheapestChain(chains.length > 0 ? chains : ["Ethereum"]);
  const cheapGas = gasOf(cheap);
  const alt =
    cheap !== chain ? " Cheaper alternative: " + cheap + " (~$" + String(cheapGas) + "/tx)." : "";
  const [verb, noun] = catAction(category);
  const costSmall = 3 * gas + 3;
  const costMed = 5 * gas + 3;
  const costLarge = 7 * gas + 3;
  const ev = Math.max(1, impliedValueUsd);
  const pct = (costMed / ev) * 100;
  const pctStr = pct < 0.1 ? "<0.1" : String(Math.round(pct * 10) / 10);
  const verdict =
    pct < 5
      ? "worth it at every tier — cost is far below expected value"
      : pct < 20
        ? "worth it at medium/large tiers, marginal at small tier"
        : "expensive relative to expected value — large tier only if convinced, small tier should skip";
  return [
    "Set up a fresh " +
      chain +
      "-ready wallet (new, farming-only), store the seed phrase offline, then bridge funds to " +
      chain +
      " — bridge cost ~$3 (planning estimate, not a live quote), 10-30 minutes." +
      alt,
    verb +
      " on " +
      name +
      " worth $100 (small) / $1,000 (medium) / $10,000 (large) in 1 transaction — gas ~$" +
      String(gas) +
      " on " +
      chain +
      ", 5 minutes. Save the transaction hash as proof of activity.",
    "Repeat the " +
      noun +
      " 1x per week for 4-8 weeks (4-8 transactions total, gas ~$" +
      String(gas) +
      " each, 5 minutes per week) so the activity history looks consistent, not one-off.",
    "Log every date, amount, and transaction hash in a spreadsheet; check the position in the " +
      chain +
      " explorer every 2 weeks (10 minutes) and make sure funds stay active, not withdrawn after the first transaction.",
    "Manage risk: never use money you need for daily life, never click airdrop links from DMs or ads, and plan your exit — a full withdrawal takes 1 transaction (~$" +
      String(gas) +
      ") plus any protocol waiting time.",
    "Estimated cost " +
      fmtMoney(costSmall) +
      " (small) / " +
      fmtMoney(costMed) +
      " (medium) / " +
      fmtMoney(costLarge) +
      " (large); expected value " +
      fmtCompactUsd(ev) +
      "; medium-tier cost = " +
      pctStr +
      "% of expected value — " +
      verdict +
      ".",
  ];
}

// ---------- Stage 1: log(mcap) ~ log(tvl) ----------

type Stage1Pooled = { kind: "pooled"; a: number; b: number };
type Stage1Cat = {
  kind: "cat";
  aPooled: number;
  b: number;
  intercepts: Record<string, number>; // category -> shrunk intercept (absolute)
};
type Stage1 = Stage1Pooled | Stage1Cat;

function fitStage1Pooled(train: Proto[]): Stage1Pooled {
  const beta = ols(
    train.map((p) => [1, Math.log(p.tvl_usd)]),
    train.map((p) => Math.log(p.mcap_usd as number)),
  );
  return { kind: "pooled", a: beta[0], b: beta[1] };
}

function fitStage1Cat(train: Proto[], pooled: Stage1Pooled): Stage1Cat {
  // Category-intercept version (partial pooling): each category with >= 4
  // live protocols gets its own intercept = pooled intercept + its mean
  // residual, shrunk toward the pooled intercept by n/(n+4). Categories with
  // fewer than 4 keep the pooled intercept exactly. The slope stays the pooled
  // slope, so the pooled and category versions are directly comparable and the
  // category signal lives entirely in the intercepts (spread about -0.7 to
  // +0.7 log points after shrinkage — roughly a 4x multiple spread).
  // NOTE: shrinking joint-OLS dummy intercepts toward the pooled intercept
  // while keeping the joint slope was tried first and rejected: it mixes a
  // slope fitted with one intercept level with another intercept level, and
  // its walk-forward median error (2.03) was worse than the baseline (1.75).
  const sums = new Map<string, { s: number; n: number }>();
  for (const p of train) {
    if (p.category === null) continue;
    const r = Math.log(p.mcap_usd as number) - (pooled.a + pooled.b * Math.log(p.tvl_usd));
    const cur = sums.get(p.category) || { s: 0, n: 0 };
    cur.s += r;
    cur.n += 1;
    sums.set(p.category, cur);
  }
  const intercepts: Record<string, number> = {};
  for (const [c, v] of sums) {
    if (v.n >= 4) intercepts[c] = pooled.a + (v.s / v.n) * (v.n / (v.n + 4));
  }
  return { kind: "cat", aPooled: pooled.a, b: pooled.b, intercepts };
}

function stage1Base(p: Proto, m: Stage1): number {
  if (m.kind === "pooled") return m.a + m.b * Math.log(p.tvl_usd);
  const inter =
    p.category !== null && m.intercepts[p.category] !== undefined
      ? m.intercepts[p.category]
      : m.aPooled;
  return inter + m.b * Math.log(p.tvl_usd);
}

// ---------- Stage 2: residual ~ growth + log(age) ----------

type Stage2 = { c0: number; bg: number; ba: number; n: number };

// Fit on the live protocols that report BOTH a 7-day change and a listing date.
function fitStage2(train: Proto[], m: Stage1): Stage2 {
  const sub = train.filter((p) => p.change_7d !== null && p.listed_at !== null);
  const beta = ols(
    sub.map((p) => [1, growthFrac(p), Math.log(ageDays(p))]),
    sub.map((p) => Math.log(p.mcap_usd as number) - stage1Base(p, m)),
  );
  return { c0: beta[0], bg: beta[1], ba: beta[2], n: sub.length };
}

// Stage-2 adjustment for a protocol. Coefficients are shrunk x0.5 (growth and
// age move the multiple only a little, according to the data) and the total is
// clamped to +/-0.35 log points. The intercept c0 is NOT applied: it is the
// mean offset of the 95-protocol stage-2 subset and would shift every protocol
// by a constant.
function stage2Adj(p: Proto, s2: Stage2): number {
  return clamp(0.5 * s2.bg * growthFrac(p) + 0.5 * s2.ba * Math.log(ageDays(p)), -0.35, 0.35);
}

function logImplied(p: Proto, m: Stage1, s2: Stage2): number {
  return stage1Base(p, m) + stage2Adj(p, s2);
}

// ---------- Validation ----------

type SplitResult = { med: number; r2: number };

// v1-style baseline: median mcap/tvl ratio per category (categories with >= 3
// live protocols in train, else the pooled median ratio). No growth or age
// adjustment — the fitted model must beat this on unseen data.
function baselinePred(p: Proto, train: Proto[]): number {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const q of train) {
    const r = (q.mcap_usd as number) / q.tvl_usd;
    all.push(r);
    if (q.category !== null) {
      const arr = byCat.get(q.category) || [];
      arr.push(r);
      byCat.set(q.category, arr);
    }
  }
  const pooledMed = median(all);
  let ratio = pooledMed;
  if (p.category !== null) {
    const arr = byCat.get(p.category);
    if (arr && arr.length >= 3) ratio = median(arr);
  }
  return Math.log(p.tvl_usd * ratio);
}

function evalSplit(
  train: Proto[],
  test: Proto[],
  kind: "pooled" | "cat",
): { model: SplitResult; base: SplitResult } {
  const pooled = fitStage1Pooled(train);
  const m: Stage1 = kind === "pooled" ? pooled : fitStage1Cat(train, pooled);
  const s2 = fitStage2(train, m);
  const errs: number[] = [];
  const preds: number[] = [];
  const ys: number[] = [];
  const bErrs: number[] = [];
  const bPreds: number[] = [];
  for (const p of test) {
    const y = Math.log(p.mcap_usd as number);
    ys.push(y);
    preds.push(logImplied(p, m, s2));
    errs.push(Math.abs(y - preds[preds.length - 1]));
    bPreds.push(baselinePred(p, train));
    bErrs.push(Math.abs(y - bPreds[bPreds.length - 1]));
  }
  return {
    model: { med: median(errs), r2: rSquared(ys, preds) },
    base: { med: median(bErrs), r2: rSquared(ys, bPreds) },
  };
}

// ---------- Token odds ----------

type OddsTables = {
  global: number;
  catRate: Map<string, number>;
  ageFactor: number[]; // per band [0,90), [90,365), [365,730), [730,inf)
};

function ageBand(p: Proto): number {
  const a = ageDays(p);
  if (a < 90) return 0;
  if (a < 365) return 1;
  if (a < 730) return 2;
  return 3;
}

function buildOdds(protocols: Proto[]): OddsTables {
  const live = protocols.filter((p) => p.mcap_usd !== null);
  const global = live.length / protocols.length;
  const catTot = new Map<string, number>();
  const catLive = new Map<string, number>();
  for (const p of protocols) {
    const c = p.category === null ? "__none__" : p.category;
    catTot.set(c, (catTot.get(c) || 0) + 1);
    if (p.mcap_usd !== null) catLive.set(c, (catLive.get(c) || 0) + 1);
  }
  const catRate = new Map<string, number>();
  for (const [c, n] of catTot) {
    const k = catLive.get(c) || 0;
    catRate.set(c, (k + 4 * global) / (n + 4));
  }
  // Age bands: same +4 shrinkage on the band rate, then factor = rate / global.
  // listed_at null -> age 365 -> band [365,730).
  const bandTot = [0, 0, 0, 0];
  const bandLive = [0, 0, 0, 0];
  for (const p of protocols) {
    const b = ageBand(p);
    bandTot[b]++;
    if (p.mcap_usd !== null) bandLive[b]++;
  }
  const ageFactor = bandTot.map((n, i) => ((bandLive[i] + 4 * global) / (n + 4)) / global);
  return { global, catRate, ageFactor };
}

function tokenOdds(p: Proto, odds: OddsTables): number {
  const c = p.category === null ? "__none__" : p.category;
  const rate = odds.catRate.get(c) || odds.global;
  return clamp(rate * odds.ageFactor[ageBand(p)], 0.02, 0.5);
}

// ---------- Main ----------

function main(): void {
  const args = process.argv.slice(2);
  let inputPath = "/input/snapshot.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && i + 1 < args.length) inputPath = args[i + 1];
  }
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  const root = dirname(fileURLToPath(import.meta.url));

  const snap: Snap = JSON.parse(readFileSync(inputPath, "utf-8"));
  const protocols = snap.protocols;
  const watchSet = new Set(snap.watchlist);

  // Fitting set: token-bearing protocols with a positive market cap and TVL.
  // 15 token-bearing protocols have mcap_usd == 0 (dead/zero tokens) and are
  // excluded from fitting; the other 144 - 15 = 128 are fitted.
  const fit = protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );

  // ----- Validation: held-out 2x (seeds 1 and 2, 70/30) + walk-forward -----
  // Spec reference baselines (v1-style, from the brief): held-out 1.62 / 1.28,
  // walk-forward 1.75 (median |log error|). The model must beat those, and the
  // same-split baseline computed below is printed for a like-for-like check.
  const SPEC_BASE = { seed1: 1.62, seed2: 1.28, wf: 1.75 };
  type ValRow = {
    label: string;
    kind: string;
    med: number;
    r2: number;
    baseMed: number;
    baseR2: number;
    specBase: number;
  };
  const valRows: ValRow[] = [];
  const heldMeans: Record<string, number> = { pooled: 0, cat: 0 };
  for (const seed of [1, 2]) {
    const idx = shuffled(fit.map((_, i) => i), seed);
    const test = idx.slice(0, 38).map((i) => fit[i]);
    const train = idx.slice(38).map((i) => fit[i]);
    for (const kind of ["pooled", "cat"] as const) {
      const r = evalSplit(train, test, kind);
      heldMeans[kind] += r.model.med / 2;
      valRows.push({
        label: "held-out " + seed,
        kind,
        med: r.model.med,
        r2: r.model.r2,
        baseMed: r.base.med,
        baseR2: r.base.r2,
        specBase: seed === 1 ? SPEC_BASE.seed1 : SPEC_BASE.seed2,
      });
    }
  }
  // Walk-forward: only the 95 live protocols with a known listing date can be
  // ordered in time; train on the earliest 70%, test on the latest 30%.
  const listed = [...fit]
    .filter((p) => p.listed_at !== null)
    .sort((a, b) =>
      (a.listed_at as string) < (b.listed_at as string)
        ? -1
        : (a.listed_at as string) > (b.listed_at as string)
          ? 1
          : a.slug < b.slug
            ? -1
            : 1,
    );
  const wfCut = Math.floor(listed.length * 0.7);
  const wfTrain = listed.slice(0, wfCut);
  const wfTest = listed.slice(wfCut);
  for (const kind of ["pooled", "cat"] as const) {
    const r = evalSplit(wfTrain, wfTest, kind);
    valRows.push({
      label: "walk-forward",
      kind,
      med: r.model.med,
      r2: r.model.r2,
      baseMed: r.base.med,
      baseR2: r.base.r2,
      specBase: SPEC_BASE.wf,
    });
  }

  // Choose the stage-1 version: category intercepts only when they beat
  // pooled by >=10% on held-out (mean of the two seeds' median |log error|)
  // AND do not lose walk-forward (median |log error| on the latest 30%).
  // Otherwise pooled: a thin held-out win that fails walk-forward does not
  // justify the extra parameters (v4: held-out cat 1.080 vs pooled 1.114,
  // only ~3% better, but walk-forward cat 1.258 vs pooled 1.214 — worse —
  // so pooled wins).
  const heldImprovement = (heldMeans.pooled - heldMeans.cat) / heldMeans.pooled;
  const wfPooled = valRows.find((v) => v.label === "walk-forward" && v.kind === "pooled")!.med;
  const wfCat = valRows.find((v) => v.label === "walk-forward" && v.kind === "cat")!.med;
  const chosenKind: "pooled" | "cat" =
    heldImprovement >= 0.10 && wfCat <= wfPooled ? "cat" : "pooled";

  // ----- Final fit on all 128 -----
  const pooledFinal = fitStage1Pooled(fit);
  const stage1: Stage1 =
    chosenKind === "pooled" ? pooledFinal : fitStage1Cat(fit, pooledFinal);
  const stage2 = fitStage2(fit, stage1);
  const odds = buildOdds(protocols);

  // ----- Integrity filter (runtime, from the snapshot — nothing hardcoded) -----
  // A pre-token protocol is excluded when another protocol with the same brand
  // stem already has a token trading (mcap > 0). The sibling with the largest
  // market cap names the reason.
  const siblingByStem = new Map<string, Proto>();
  for (const p of protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      const s = stem(p.slug);
      const cur = siblingByStem.get(s);
      if (!cur || (p.mcap_usd as number) > (cur.mcap_usd as number)) {
        siblingByStem.set(s, p);
      }
    }
  }
  const excluded: Excluded[] = [];
  const excludedSlugs = new Set<string>();
  for (const p of protocols) {
    if (p.mcap_usd !== null) continue;
    const sib = siblingByStem.get(stem(p.slug));
    if (sib && sib.slug !== p.slug) {
      excluded.push({
        slug: p.slug,
        name: p.name,
        reason:
          "Brand already has a token trading — sibling " +
          sib.slug +
          " (mcap " +
          fmtMcap(sib.mcap_usd as number) +
          ")",
      });
      excludedSlugs.add(p.slug);
    }
  }
  excluded.sort((a, b) => (a.slug < b.slug ? -1 : 1));

  // ----- Board: every pre-token protocol that passes the filter, by EV -----
  const pre = protocols.filter((p) => p.mcap_usd === null && !excludedSlugs.has(p.slug));
  const scored = pre.map((p) => {
    const li = logImplied(p, stage1, stage2);
    const od = tokenOdds(p, odds);
    const implied = clamp(Math.round(Math.exp(li) * od), 1, 100000000000000);
    const multiple = Math.exp(li) / p.tvl_usd;
    return { p, li, od, implied, multiple };
  });
  scored.sort((a, b) =>
    b.implied !== a.implied ? b.implied - a.implied : a.p.slug < b.p.slug ? -1 : 1,
  );
  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.implied,
    odds: Math.round(s.od * 10000) / 10000,
    category: s.p.category,
    tvl_usd: s.p.tvl_usd,
    multiple: Math.round(s.multiple * 10000) / 10000,
    growth: Math.round(growthFrac(s.p) * 10000) / 10000,
    age_days: ageDays(s.p),
    has_token: false,
    watchlist: watchSet.has(s.p.slug),
    // Farm steps are built from the implied value rounded to the nearest
    // $1,000 — the same rounded value the dashboard decodes from data.js, so
    // the detail view's verdict always matches board.json exactly.
    farm_steps: buildFarmSteps(s.p.name, s.p.category, s.p.chains, Math.round(s.implied / 1000) * 1000),
  }));

  // ----- Output -----
  mkdirSync(join(outDir, "dashboard"), { recursive: true });
  mkdirSync(join(outDir, "screenshots"), { recursive: true });
  writeFileSync(join(outDir, "board.json"), JSON.stringify({ rows, excluded }, null, 2) + "\n");

  // Dashboard data file: one compact string of rows (fields comma-separated,
  // rows pipe-separated). Rank is the row's position (rows are rank-ordered).
  // implied/tvl are stored in $ thousands, base-36; odds in hundredths;
  // growth in hundredths; multiple in ten-thousandths.
  const catsUsed = [...new Set(rows.map((r) => r.category ?? "Uncategorized"))].sort();
  const catIdx = new Map(catsUsed.map((c, i) => [c, i]));
  const chainSet = new Set<string>();
  const rowChains: { primary: string; cheap: string }[] = [];
  for (const r of rows) {
    const proto = protocols.find((p) => p.slug === r.slug) as Proto;
    const primary = proto.chains.length > 0 ? proto.chains[0] : "Ethereum";
    const cheap = cheapestChain(proto.chains.length > 0 ? proto.chains : ["Ethereum"]);
    chainSet.add(primary);
    chainSet.add(cheap);
    rowChains.push({ primary, cheap });
  }
  const chainsUsed = [...chainSet].sort();
  const chainIdx = new Map(chainsUsed.map((c, i) => [c, i]));
  const rowsStr = rows
    .map((r, i) => {
      const proto = protocols.find((p) => p.slug === r.slug) as Proto;
      return [
        r.slug,
        r.name,
        // rank is the row's position (rows are stored rank-ordered), so it is
        // not stored: the dashboard assigns rank = index + 1.
        b36(Math.max(1, Math.round(r.implied_value_usd / 1000))),
        String(Math.round(r.odds * 100)),
        String(catIdx.get(r.category ?? "Uncategorized")),
        b36(Math.round(r.tvl_usd / 1000)),
        String(Math.round(r.growth * 100)),
        String(r.age_days),
        String(Math.round(r.multiple * 10000)),
        String(chainIdx.get(rowChains[i].primary)),
        String(chainIdx.get(rowChains[i].cheap)),
      ].join(",");
    })
    .join("|");
  const liveRows = protocols
    .filter((p) => p.mcap_usd !== null)
    .map((p) => p.slug + "," + b36(Math.max(0, Math.round((p.mcap_usd as number) / 1000))))
    .join("|");
  const exclStr = excluded
    .map((e) => {
      const sib = siblingByStem.get(stem(e.slug)) as Proto;
      return [e.slug, e.name, sib.slug, b36(Math.max(0, Math.round((sib.mcap_usd as number) / 1000)))].join(",");
    })
    .join("|");
  const sortedImplied = rows.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const totalImplied = rows.reduce((a, r) => a + r.implied_value_usd, 0);
  const valOut = valRows.map((v) => ({
    label: v.label,
    kind: v.kind,
    med: Math.round(v.med * 1000) / 1000,
    r2: Math.round(v.r2 * 1000) / 1000,
    pctBetterVsSpec: Math.round(((v.specBase - v.med) / v.specBase) * 1000) / 10,
    specBase: v.specBase,
  }));
  const meta = {
    boardN: rows.length,
    excludedN: excluded.length,
    watchlistN: snap.watchlist.length,
    watchlistCovered: rows.filter((r) => r.watchlist).length,
    globalOdds: Math.round(odds.global * 10000) / 10000,
    totalImplied,
    medianImplied: median(sortedImplied),
    top1: { slug: rows[0].slug, name: rows[0].name, implied: rows[0].implied_value_usd },
    model: {
      kind: chosenKind,
      slope: Math.round((stage1.kind === "pooled" ? stage1.b : stage1.b) * 1000) / 1000,
      intercept:
        stage1.kind === "pooled"
          ? Math.round(stage1.a * 1000) / 1000
          : Math.round(stage1.aPooled * 1000) / 1000,
      catIntercepts:
        stage1.kind === "cat"
          ? Object.fromEntries(
              Object.entries(stage1.intercepts).map(([k, v]) => [k, Math.round(v * 1000) / 1000]),
            )
          : null,
      stage2: {
        growth: Math.round(stage2.bg * 1000) / 1000,
        logAge: Math.round(stage2.ba * 1000) / 1000,
        c0NotApplied: Math.round(stage2.c0 * 1000) / 1000,
        n: stage2.n,
      },
      ageFactors: odds.ageFactor.map((f) => Math.round(f * 1000) / 1000),
    },
    validation: valOut,
  };
  const watchStr = snap.watchlist.join("|");
  const dataJs =
    "const ROWS=" +
    JSON.stringify(rowsStr) +
    ";\nconst CATS=" +
    JSON.stringify(catsUsed) +
    ";\nconst CHAINS=" +
    JSON.stringify(chainsUsed) +
    ";\nconst WATCH=" +
    JSON.stringify(watchStr) +
    ";\nconst EXCLUDED=" +
    JSON.stringify(exclStr) +
    ";\nconst LIVE=" +
    JSON.stringify(liveRows) +
    ";\nconst META=" +
    JSON.stringify(meta) +
    ";\n";

  // Copy the dashboard and screenshots, then write the generated data file.
  cpSync(join(root, "dashboard"), join(outDir, "dashboard"), { recursive: true });
  cpSync(join(root, "screenshots"), join(outDir, "screenshots"), { recursive: true });
  writeFileSync(join(outDir, "dashboard", "data.js"), dataJs);
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), Buffer.from(dossier as Uint8Array));

  // ----- Stdout report -----
  const heldPooled = valRows.filter((v) => v.label.startsWith("held-out") && v.kind === "pooled");
  const heldCat = valRows.filter((v) => v.label.startsWith("held-out") && v.kind === "cat");
  console.log("token-radar v3");
  console.log("fit n=" + fit.length + " (live mcap>0), stage2 n=" + stage2.n);
  console.log(
    "stage1 " + chosenKind + ": slope=" + (stage1.b).toFixed(3) +
      " intercept=" + (stage1.kind === "pooled" ? stage1.a : stage1.aPooled).toFixed(3) +
      " | stage2 growth=" + stage2.bg.toFixed(3) + " logAge=" + stage2.ba.toFixed(3) +
      " c0=" + stage2.c0.toFixed(3) + " (not applied)",
  );
  for (const v of valRows) {
    console.log(
      "validation " + v.label + " [" + v.kind + "] med=" + v.med.toFixed(3) +
        " R2=" + v.r2.toFixed(3) + " baselineMed=" + v.baseMed.toFixed(3) +
        " specBase=" + v.specBase.toFixed(2) +
        " pctBetterVsSpec=" + (((v.specBase - v.med) / v.specBase) * 100).toFixed(1) + "%",
    );
  }
  console.log(
    "held-out mean med: pooled=" + mean(heldPooled.map((v) => v.med)).toFixed(3) +
      " cat=" + mean(heldCat.map((v) => v.med)).toFixed(3) +
      " heldOutImprovement=" + ((heldImprovement) * 100).toFixed(1) + "%" +
      " walkForward med: pooled=" + wfPooled.toFixed(3) + " cat=" + wfCat.toFixed(3) +
      " rule: cat needs held-out improvement >=10% AND wf cat <= wf pooled -> chose " + chosenKind,
  );
  console.log(
    "integrity: excluded=" + excluded.length +
      " watchlistFlagged=" + excluded.filter((e) => watchSet.has(e.slug)).length,
  );
  for (const e of excluded.slice(0, 3)) console.log("  excluded: " + e.slug + " — " + e.reason);
  console.log(
    "board rows=" + rows.length + " watchlist=" + rows.filter((r) => r.watchlist).length +
      "/" + snap.watchlist.length + " totalImplied=$" + totalImplied.toLocaleString("en-US"),
  );
  for (const r of rows.slice(0, 5)) {
    console.log(
      "  #" + r.rank + " " + r.slug + " " + fmtCompactUsd(r.implied_value_usd) +
        " odds=" + r.odds + " tvl=" + fmtCompactUsd(r.tvl_usd),
    );
  }
  console.log("wrote " + outDir + "/board.json, dashboard/data.js, dossier.json");
}

main();
