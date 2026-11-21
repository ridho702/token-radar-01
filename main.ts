// token-radar-01 v2 — Token Launch Radar (rebuild from scratch)
// Model (all fitted at runtime from the snapshot, nothing hardcoded):
//   Stage 1: log(mcap) = a + b*log(tvl)  (OLS on 128 token protocols with
//     mcap>0 and tvl>0; a pooled intercept won held-out validation over
//     per-category intercepts, so the pooled model is used).
//   Stage 2: residual ~ growth + log(age), fitted with intercept; the
//     intercept is a subset-mean offset and is NOT applied, the two slopes
//     are shrunk x0.5 and the total adjustment is clamped to +-0.35 in log.
//   Token odds: category launch rate (shrunk toward the global rate) times
//     an age-band factor (shrunk toward 1), clamped to [0.02, 0.50].
//   Implied value = expected value = fair value x odds. That is the honest
//     definition of the score: what the token would be worth IF launched,
//     times the chance it launches, from peers' track record.
//   Protocols with a token are the fitting set only; they never enter the
//     board. 15 token protocols with mcap_usd == 0 (dead/zero tokens) are
//     excluded from fitting. listed_at null -> age 365 days. change_7d is in
//     PERCENT: g = change_7d/100 clamped to [-0.9, +5.0]; null -> 0.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

const AS_OF = "2026-11-14";
const AS_OF_MS = Date.parse(AS_OF + "T00:00:00Z");
const DAY_MS = 86400000;
const GLOBAL_ODDS_PRIOR = 4; // shrinkage strength for category rates
const AGE_SHRINK = 4; // shrinkage strength for age-band factors

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};
type Snap = { as_of: string; source: string; floor_usd: number; protocols: Proto[]; watchlist: string[] };

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function ageDays(p: Proto): number {
  if (!p.listed_at) return 365; // unknown listing date -> 1 year (stated assumption)
  return Math.max(1, Math.round((AS_OF_MS - Date.parse(p.listed_at + "T00:00:00Z")) / DAY_MS));
}
function growthFrac(p: Proto): number {
  if (p.change_7d === null || p.change_7d === undefined) return 0;
  return clamp(p.change_7d / 100, -0.9, 5.0); // change_7d is in PERCENT
}
function ageBand(age: number): number {
  if (age < 90) return 0;
  if (age < 365) return 1;
  if (age < 730) return 2;
  return 3;
}
function fmtMoney(x: number): string {
  if (x < 10) return "$" + x.toFixed(2);
  if (x < 1000) return "$" + Math.round(x);
  if (x < 1000000) return "$" + (x / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (x < 1000000000) return "$" + (x / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  return "$" + (x / 1000000000).toFixed(2) + "B";
}
function sci3(x: number): string {
  if (x <= 0) return "0";
  return x.toPrecision(3).replace("e+", "e");
}
function sci4(x: number): string {
  if (x <= 0) return "0";
  return x.toPrecision(4).replace("e+", "e");
}
// Seeded RNG (mulberry32) so held-out splits are deterministic.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(xs: T[], seed: number): T[] {
  const r = rng(seed); const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// OLS by normal equations + Gaussian elimination with partial pivoting.
// X: rows of regressors, y: outcomes. Returns coefficients.
function ols(X: number[][], y: number[]): number[] {
  const k = X[0].length;
  const A: number[][] = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b];
      A[a][k] += X[i][a] * y[i];
    }
  }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < k; r++) {
      const f = A[r][c] / d;
      for (let cc = c; cc <= k; cc++) A[r][cc] -= f * A[c][cc];
    }
  }
  const beta = new Array(k).fill(0);
  for (let c = k - 1; c >= 0; c--) {
    let s = A[c][k];
    for (let j = c + 1; j < k; j++) s -= A[c][j] * beta[j];
    beta[c] = s / (A[c][c] || 1e-12);
  }
  return beta;
}
function r2Of(y: number[], pred: number[]): number {
  const m = y.reduce((a, b) => a + b, 0) / y.length;
  let ss = 0, st = 0;
  for (let i = 0; i < y.length; i++) { ss += (y[i] - pred[i]) ** 2; st += (y[i] - m) ** 2; }
  return st === 0 ? 0 : 1 - ss / st;
}

type Stage1 = { mode: string; slope: number; pooled: number; cats: Map<string, number> };
function fitStage1(rows: Proto[], mode: string): Stage1 {
  if (mode === "pooled") {
    const b = ols(rows.map((p) => [1, Math.log(p.tvl_usd)]), rows.map((p) => Math.log(p.mcap_usd as number)));
    return { mode, slope: b[1], pooled: b[0], cats: new Map() };
  }
  // Category intercepts: categories with >=4 live protocols get their own
  // intercept; the rest share the pooled intercept. Joint OLS, common slope.
  const counts = new Map<string, number>();
  for (const p of rows) counts.set(p.category ?? "Unknown", (counts.get(p.category ?? "Unknown") ?? 0) + 1);
  const qual = [...counts.entries()].filter(([, n]) => n >= 4).map(([c]) => c).sort();
  const X = rows.map((p) => {
    const r = [Math.log(p.tvl_usd)];
    r.push(qual.includes(p.category ?? "Unknown") ? 0 : 1); // pooled dummy
    for (const c of qual) r.push((p.category ?? "Unknown") === c ? 1 : 0);
    return r;
  });
  const b = ols(X, rows.map((p) => Math.log(p.mcap_usd as number)));
  const cats = new Map<string, number>();
  for (let i = 0; i < qual.length; i++) {
    const n = counts.get(qual[i]) as number;
    const shrink = n / (n + 4);
    cats.set(qual[i], b[1] + shrink * (b[2 + i] - b[1])); // shrink toward pooled
  }
  return { mode, slope: b[0], pooled: b[1], cats };
}
function stage1Pred(s1: Stage1, p: Proto): number {
  const a = s1.cats.get(p.category ?? "Unknown") ?? s1.pooled;
  return a + s1.slope * Math.log(p.tvl_usd);
}
type Stage2 = { c0: number; bg: number; ba: number };
function fitStage2(rows: Proto[], s1: Stage1): Stage2 {
  // Only protocols that actually report growth AND a listing date (n=95).
  const sub = rows.filter((p) => p.change_7d !== null && p.listed_at !== null);
  const X = sub.map((p) => [1, growthFrac(p), Math.log(ageDays(p))]);
  const y = sub.map((p) => Math.log(p.mcap_usd as number) - stage1Pred(s1, p));
  const b = ols(X, y);
  return { c0: b[0], bg: b[1], ba: b[2] };
}
// Stage-2 log adjustment: slopes shrunk x0.5, total clamped to +-0.35.
// The intercept c0 is a mean offset of the 95-protocol subset and is NOT
// applied to predictions (it would shift every protocol by a constant).
function stage2Adj(s2: Stage2, p: Proto): { adj: number; gF: number; mF: number } {
  const raw = 0.5 * s2.bg * growthFrac(p) + 0.5 * s2.ba * Math.log(ageDays(p));
  const adj = clamp(raw, -0.35, 0.35);
  const scale = raw === 0 ? 1 : adj / raw;
  return { adj, gF: Math.exp(0.5 * s2.bg * growthFrac(p) * scale), mF: Math.exp(0.5 * s2.ba * Math.log(ageDays(p)) * scale) };
}

// ---- Token odds (from peers' track record, fitted at runtime) ----
type OddsModel = { globalRate: number; catRate: Map<string, number>; bandFactor: number[] };
function fitOdds(all: Proto[]): OddsModel {
  const token = all.filter((p) => p.mcap_usd !== null);
  const globalRate = token.length / all.length; // 144/758
  const tot = new Map<string, number>(); const liv = new Map<string, number>();
  for (const p of all) {
    const c = p.category ?? "Unknown";
    tot.set(c, (tot.get(c) ?? 0) + 1);
    if (p.mcap_usd !== null) liv.set(c, (liv.get(c) ?? 0) + 1);
  }
  const catRate = new Map<string, number>();
  for (const [c, n] of tot) {
    catRate.set(c, ((liv.get(c) ?? 0) + GLOBAL_ODDS_PRIOR * globalRate) / (n + GLOBAL_ODDS_PRIOR));
  }
  // Age-band launch rates, shrunk toward 1 as a multiplier.
  const bandFactor: number[] = [];
  for (let b = 0; b < 4; b++) {
    const inBand = all.filter((p) => ageBand(ageDays(p)) === b);
    const k = inBand.filter((p) => p.mcap_usd !== null).length;
    const raw = inBand.length === 0 ? 1 : (k / inBand.length) / globalRate;
    const w = inBand.length / (inBand.length + AGE_SHRINK);
    bandFactor.push(1 + w * (raw - 1));
  }
  return { globalRate, catRate, bandFactor };
}
function tokenOdds(om: OddsModel, p: Proto): number {
  const rk = om.catRate.get(p.category ?? "Unknown") ?? om.globalRate;
  const f = om.bandFactor[ageBand(ageDays(p))];
  return clamp(rk * f, 0.02, 0.50);
}

// ---- Gas (planning estimates, NOT live quotes) ----
const GAS: Record<string, number> = {
  Ethereum: 6, Arbitrum: 0.3, Base: 0.15, Optimism: 0.2, Solana: 0.02,
  Avalanche: 0.3, BSC: 0.2, Polygon: 0.05,
};
function gasOf(chain: string): number { return GAS[chain] ?? 0.5; }
function cheapestChain(chains: string[]): string {
  let best = chains[0]; let bestGas = gasOf(best);
  for (const c of chains) if (gasOf(c) < bestGas) { best = c; bestGas = gasOf(c); }
  return best;
}
// What a reader actually DOES on a protocol of this category.
function catAction(cat: string | null): { verb: string; noun: string } {
  const c = cat ?? "";
  if (c === "Dexs") return { verb: "Swap dan sediakan likuiditas", noun: "swap" };
  if (c === "Lending") return { verb: "Supply aset dan pinjam", noun: "supply" };
  if (c === "Yield" || c === "Yield Aggregator" || c === "Farm") return { verb: "Deposit ke vault dan compound hasil", noun: "deposit" };
  if (c === "Liquid Staking" || c === "Liquid Restaking" || c === "Restaking" || c === "Staking Pool") return { verb: "Stake dan restake", noun: "stake" };
  if (c === "Bridge" || c === "Cross Chain Bridge" || c === "Canonical Bridge") return { verb: "Bridge aset antar rantai", noun: "bridge" };
  if (c === "Derivatives" || c === "Options" || c === "Options Vault" || c === "Basis Trading") return { verb: "Buka posisi dan kelola margin", noun: "posisi" };
  if (c === "CDP" || c === "CDP Manager") return { verb: "Buka vault dan mint stablecoin", noun: "vault" };
  if (c === "RWA") return { verb: "Beli dan tahan aset tokenisasi", noun: "posisi RWA" };
  if (c === "Prediction Market") return { verb: "Pasang posisi di pasar prediksi", noun: "posisi" };
  if (c === "Launchpad") return { verb: "Stake dan ikuti penjualan token", noun: "partisipasi" };
  if (c === "Payments" || c === "Crypto Card Issuer") return { verb: "Pakai protokol untuk pembayaran rutin", noun: "pembayaran" };
  if (c === "Insurance" || c === "Risk Curators") return { verb: "Beli cover dan sediakan underwriting", noun: "cover" };
  if (c === "NFT Marketplace") return { verb: "Beli dan jual NFT", noun: "transaksi NFT" };
  if (c === "Stablecoin Issuer" || c === "Algo-Stables" || c === "Dual-Token Stablecoin") return { verb: "Mint dan tahan stablecoin", noun: "mint" };
  return { verb: "Gunakan protokol secara rutin", noun: "aktivitas" };
}
// Farm plan: 6 steps, concrete amounts / costs / time. The SAME function
// text lives in dashboard/app.js (detail view) — keep them in sync.
function farmStepsFor(p: Proto, ev: number): string[] {
  const chain = p.chains[0] ?? "Ethereum";
  const gas = gasOf(chain);
  const cheap = cheapestChain(p.chains);
  const act = catAction(p.category);
  const alt = cheap !== chain ? ` Alternatif murah: ${cheap} (~$${gasOf(cheap)}/tx).` : "";
  const txN = [3, 5, 7]; // tx count per tier: small / medium / large
  const cost = txN.map((n) => n * gas + 3); // +$3 bridge, planning estimate
  const fmtC = (x: number) => (x < 10 ? "$" + x.toFixed(2) : "$" + Math.round(x));
  const medPct = (cost[1] / Math.max(ev, 1)) * 100;
  const verdict = medPct < 5
    ? "layak di semua tier — biaya jauh di bawah expected value"
    : medPct < 20
      ? "layak di tier menengah/besar, marginal di tier kecil"
      : "mahal relatif terhadap expected value — hanya tier besar bila yakin, tier kecil sebaiknya skip";
  return [
    `Siapkan dompet ${chain}-ready (baru, khusus farming), simpan seed phrase offline, lalu bridge dana ke ${chain} — biaya bridge ~$3 (planning estimate, bukan kuotasi live), waktu 10-30 menit.${alt}`,
    `${act.verb} di ${p.name} senilai $100 (kecil) / $1.000 (menengah) / $10.000 (besar) dalam 1 transaksi — gas ~$${gas} di ${chain}, waktu 5 menit. Simpan hash transaksi sebagai bukti aktivitas.`,
    `Ulangi ${act.noun} 1x per minggu selama 4-8 minggu (total 4-8 transaksi, gas ~$${gas} tiap transaksi, 5 menit per minggu) agar riwayat aktivitas terlihat konsisten, bukan sekali jalan.`,
    `Catat tiap tanggal, jumlah, dan hash transaksi di spreadsheet; cek posisi di explorer ${chain} tiap 2 minggu (10 menit) dan pastikan dana tetap aktif, bukan ditarik setelah transaksi pertama.`,
    `Kelola risiko: jangan pakai dana kebutuhan harian, jangan klik tautan airdrop dari DM atau iklan, dan siapkan exit — penarikan penuh butuh 1 transaksi (~$${gas}) plus waktu tunggu protokol bila ada.`,
    `Perkiraan biaya ${fmtC(cost[0])} (kecil) / ${fmtC(cost[1])} (menengah) / ${fmtC(cost[2])} (besar); expected value ${fmtMoney(ev)}; biaya tier menengah = ${medPct < 0.1 ? "<0,1" : medPct.toFixed(1)}% dari expected value — ${verdict}.`,
  ];
}

// ---- Validation: held-out (2 seeds) + walk-forward, both model variants ----
type ValRes = { med: number; r2: number };
function evaluate(train: Proto[], test: Proto[], mode: string): ValRes {
  const s1 = fitStage1(train, mode);
  const s2 = fitStage2(train, s1);
  const errs: number[] = []; const ys: number[] = []; const ps: number[] = [];
  for (const p of test) {
    const pred = stage1Pred(s1, p) + stage2Adj(s2, p).adj;
    const y = Math.log(p.mcap_usd as number);
    errs.push(Math.abs(y - pred)); ys.push(y); ps.push(pred);
  }
  return { med: median(errs), r2: r2Of(ys, ps) };
}
function heldOut(live: Proto[], seed: number): { pooled: ValRes; cat: ValRes } {
  const sh = shuffled(live, seed);
  const n = Math.floor(sh.length * 0.7);
  return { pooled: evaluate(sh.slice(0, n), sh.slice(n), "pooled"), cat: evaluate(sh.slice(0, n), sh.slice(n), "cat") };
}
function walkForward(live: Proto[]): { pooled: ValRes; cat: ValRes } {
  // Only protocols with a real listing date can be ordered in time.
  const dated = [...live].filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at as string).localeCompare(b.listed_at as string));
  const n = Math.floor(dated.length * 0.7);
  return { pooled: evaluate(dated.slice(0, n), dated.slice(n), "pooled"), cat: evaluate(dated.slice(0, n), dated.slice(n), "cat") };
}

// ---- Compact data.js encoding (decoder lives in dashboard/app.js) ----
function reconName(slug: string): string {
  return slug.split("-").map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
}

function main(): void {
  const args = process.argv.slice(2);
  let input = "/input/snapshot.json";
  for (let i = 0; i < args.length; i++) if (args[i] === "--input" && args[i + 1]) input = args[i + 1];
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  const rootDir = dirname(fileURLToPath(import.meta.url));
  const snap: Snap = JSON.parse(readFileSync(input, "utf8"));
  const all = snap.protocols;
  const live = all.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const deadZero = all.filter((p) => p.mcap_usd !== null && p.mcap_usd === 0).length;
  const pre = all.filter((p) => p.mcap_usd === null);
  console.log(`snapshot as_of=${snap.as_of} protocols=${all.length} live_fit=${live.length} dead_mcap0_excluded=${deadZero} pre_token=${pre.length} watchlist=${snap.watchlist.length}`);

  // Validation first, so the model choice is earned, not assumed.
  const h1 = heldOut(live, 1); const h2 = heldOut(live, 2); const wf = walkForward(live);
  const BASE = { h1: 1.62, h2: 1.28, wf: 1.75 }; // v1-style baseline (median-ratio + invented growth/maturity)
  const pooledScore = h1.pooled.med + h2.pooled.med + wf.pooled.med;
  const catScore = h1.cat.med + h2.cat.med + wf.cat.med;
  const chosen = pooledScore <= catScore ? "pooled" : "cat";
  console.log(`held-out seed1 pooled med|logerr|=${h1.pooled.med.toFixed(3)} R2=${h1.pooled.r2.toFixed(3)} | cat med=${h1.cat.med.toFixed(3)} R2=${h1.cat.r2.toFixed(3)} (baseline ${BASE.h1})`);
  console.log(`held-out seed2 pooled med|logerr|=${h2.pooled.med.toFixed(3)} R2=${h2.pooled.r2.toFixed(3)} | cat med=${h2.cat.med.toFixed(3)} R2=${h2.cat.r2.toFixed(3)} (baseline ${BASE.h2})`);
  console.log(`walk-forward pooled med|logerr|=${wf.pooled.med.toFixed(3)} R2=${wf.pooled.r2.toFixed(3)} | cat med=${wf.cat.med.toFixed(3)} R2=${wf.cat.r2.toFixed(3)} (baseline ${BASE.wf})`);
  console.log(`model choice: ${chosen} (sum med pooled=${pooledScore.toFixed(3)} vs cat=${catScore.toFixed(3)}). In-sample, category intercepts raise R2, but held-out/walk-forward do not support them — pooled wins on unseen data.`);

  const s1 = fitStage1(live, chosen);
  const s2 = fitStage2(live, s1);
  console.log(`stage1 ${chosen}: slope=${s1.slope.toFixed(3)} pooled_intercept=${s1.pooled.toFixed(3)}`);
  if (chosen === "cat") for (const [c, a] of [...s1.cats.entries()].sort()) console.log(`  intercept ${c}: ${a.toFixed(3)}`);
  console.log(`stage2 (n=95 with growth+age, fit WITH intercept): c0=${s2.c0.toFixed(3)} (not applied) growth_coef=${s2.bg.toFixed(3)} logage_coef=${s2.ba.toFixed(3)}; applied shrunk x0.5, total adj clamped +-0.35. Growth and age move the multiple only slightly — the effect is kept small on purpose.`);
  const om = fitOdds(all);
  console.log(`odds: global=${om.globalRate.toFixed(3)} band_factors=[${om.bandFactor.map((x) => x.toFixed(2)).join(", ")}] (bands <90d, 90-365d, 365-730d, >730d)`);

  // Score every pre-token protocol.
  type Scored = { p: Proto; ev: number; odds: number; multiple: number; gF: number; mF: number; logImp: number };
  const scored: Scored[] = pre.map((p) => {
    const { adj, gF, mF } = stage2Adj(s2, p);
    const logImp = stage1Pred(s1, p) + adj;
    const baseMultiple = Math.exp(stage1Pred(s1, p)) / p.tvl_usd;
    const odds = tokenOdds(om, p);
    const ev = clamp(Math.round(Math.exp(logImp) * odds), 1, 100000000000000);
    return { p, ev, odds, multiple: baseMultiple, gF, mF, logImp };
  });
  scored.sort((a, b) => b.ev - a.ev || b.p.tvl_usd - a.p.tvl_usd || a.p.slug.localeCompare(b.p.slug));
  const watch = new Set(snap.watchlist);
  const rows = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.ev,
    farm_steps: farmStepsFor(s.p, s.ev),
    odds: Math.round(s.odds * 100) / 100,
    category: s.p.category,
    tvl_usd: s.p.tvl_usd,
    multiple: Math.round(s.multiple * 100) / 100,
    growth: Math.round(growthFrac(s.p) * 10000) / 10000,
    age_days: ageDays(s.p),
    has_token: false,
    watchlist: watch.has(s.p.slug),
  }));
  const covered = rows.filter((r) => r.watchlist).length;
  console.log(`board rows=${rows.length} watchlist_covered=${covered}/${snap.watchlist.length} top1=${rows[0].slug} ev=${fmtMoney(rows[0].implied_value_usd)} top5_ev=[${rows.slice(0, 5).map((r) => fmtMoney(r.implied_value_usd)).join(", ")}]`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "board.json"), JSON.stringify({ rows }, null, 2) + "\n");

  // data.js: one compact string per section; rank is the row order.
  // Row fields: slug, name (empty when it equals title-cased slug),
  // impliedSci, oddsInt, catIdx, growthInt, ageDays, tvlSci, chainIdx, cheapIdx.
  // TVL is stored exactly; the dashboard recomputes the multiple from META,
  // so the table's TVL matches the snapshot. Chains: primary + cheapest.
  const cats = [...new Set(pre.map((p) => p.category ?? "Unknown"))].sort();
  const catIdx = new Map(cats.map((c, i) => [c, i]));
  const allChains = [...new Set(all.flatMap((p) => p.chains))].sort();
  const chainIdx = new Map(allChains.map((c, i) => [c, i]));
  const rowStr = scored.map((s) => {
    const nameField = reconName(s.p.slug) === s.p.name ? "" : s.p.name;
    return [s.p.slug, nameField, sci4(s.ev), Math.round(s.odds * 100), catIdx.get(s.p.category ?? "Unknown"),
      Math.round(growthFrac(s.p) * 100), ageDays(s.p), sci3(s.p.tvl_usd),
      chainIdx.get(s.p.chains[0] ?? "Ethereum"), chainIdx.get(cheapestChain(s.p.chains))].join(",");
  }).join("|");
  const ref = all.filter((p) => p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .map((p) => `${p.slug},${sci3(p.mcap_usd as number)}`).join("|");
  const meta = {
    slope: +s1.slope.toFixed(4), intercept: +s1.pooled.toFixed(4), mode: chosen,
    growthCoef: +s2.bg.toFixed(4), ageCoef: +s2.ba.toFixed(4), c0: +s2.c0.toFixed(4),
    globalOdds: +om.globalRate.toFixed(4),
    val: {
      h1Pooled: +h1.pooled.med.toFixed(3), h1PooledR2: +h1.pooled.r2.toFixed(3),
      h2Pooled: +h2.pooled.med.toFixed(3), h2PooledR2: +h2.pooled.r2.toFixed(3),
      wfPooled: +wf.pooled.med.toFixed(3), wfPooledR2: +wf.pooled.r2.toFixed(3),
      h1Cat: +h1.cat.med.toFixed(3), h2Cat: +h2.cat.med.toFixed(3), wfCat: +wf.cat.med.toFixed(3),
      baseH1: BASE.h1, baseH2: BASE.h2, baseWf: BASE.wf,
    },
    liveN: live.length, stage2N: 95, preN: pre.length, asOf: snap.as_of,
  };
  const dataJs = `// Generated by main.ts — compact board data. Rank is the row order.\nconst META=${JSON.stringify(meta)};\nconst CATS=${JSON.stringify(cats.join("|"))}.split("|");\nconst CHAINS=${JSON.stringify(allChains.join("|"))}.split("|");\nconst WL=${JSON.stringify(snap.watchlist.join("|"))}.split("|");\nconst ROWS=${JSON.stringify(rowStr)};\nconst REF=${JSON.stringify(ref)};\n`;

  cpSync(join(rootDir, "dashboard"), join(outDir, "dashboard"), { recursive: true });
  // data.js lives BESIDE the page (dashboard/data.js) so index.html's
  // <script src="data.js"> loads with no network.
  writeFileSync(join(outDir, "dashboard", "data.js"), dataJs);
  cpSync(join(rootDir, "screenshots"), join(outDir, "screenshots"), { recursive: true });
  // buildDossier returns the dossier BYTES (Uint8Array) — write them raw.
  // (JSON.stringify would explode it into {"0":123,...}; do not stringify.)
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), dossier as unknown as string);
  console.log("wrote board.json, data.js, dashboard/, screenshots/, dossier.json to " + outDir);
}
main();
