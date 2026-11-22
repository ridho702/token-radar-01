// Token Launch Radar v3 — dashboard app. Decodes the compact ROWS string
// from data.js and renders the board. Farm plans use the exact same templates
// as main.ts, so the detail view always agrees with board.json. Implied values
// are stored rounded to the nearest $1,000 (base-36, $ thousands); the farm
// verdict is computed from that same rounded value on both sides.
(function () {
  var rows = ROWS.split("|").map(function (line, idx) {
    var f = line.split(",");
    return {
      slug: f[0], name: f[1], rank: idx + 1,
      imp: parseInt(f[2], 36) * 1000, odds: +f[3] / 100,
      cat: CATS[+f[4]], tvl: parseInt(f[5], 36) * 1000,
      growth: +f[6] / 100, age: +f[7], mult: +f[8] / 10000,
      chain: CHAINS[+f[9]], cheap: CHAINS[+f[10]],
    };
  });
  var watch = new Set(WATCH.split("|"));
  var excl = EXCLUDED.split("|").filter(Boolean).map(function (line) {
    var f = line.split(",");
    return { slug: f[0], name: f[1], sib: f[2], sibMcap: parseInt(f[3], 36) * 1000 };
  });
  var live = LIVE.split("|").filter(Boolean).map(function (line) {
    var f = line.split(",");
    return { slug: f[0], mcap: parseInt(f[1], 36) * 1000 };
  }).sort(function (a, b) { return b.mcap - a.mcap; });

  function fmtUsd(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(2) + "K";
    return "$" + Math.round(v);
  }
  function fmtMoney(v) { return v >= 1 ? "$" + Math.round(v) : "$" + v.toFixed(2); }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function title(slug) {
    return slug.split("-").map(function (p) {
      return /^v\d+$/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    }).join(" ");
  }

  // ---- Farm plans: same templates, gas table and rules as main.ts ----
  var GAS = { Ethereum: 6, Arbitrum: 0.3, Base: 0.15, Optimism: 0.2, Solana: 0.02, Avalanche: 0.3, BSC: 0.2, Polygon: 0.05 };
  function gasOf(c) { return GAS[c] !== undefined ? GAS[c] : 0.5; }
  function catAction(cat) {
    switch (cat) {
      case "Dexs": return ["Swap and provide liquidity", "swap"];
      case "Lending": return ["Supply assets and borrow", "supply"];
      case "Yield": case "Yield Aggregator": case "Farm": return ["Deposit into the vault and compound rewards", "deposit"];
      case "Liquid Staking": case "Liquid Restaking": case "Restaking": case "Staking Pool": return ["Stake and restake", "stake"];
      case "Bridge": case "Cross Chain Bridge": case "Canonical Bridge": return ["Bridge assets across chains", "bridge"];
      case "Derivatives": case "Options": case "Options Vault": case "Basis Trading": return ["Open positions and manage margin", "position"];
      case "CDP": case "CDP Manager": return ["Open a vault and mint stablecoins", "vault"];
      case "RWA": return ["Buy and hold tokenized assets", "RWA position"];
      case "Prediction Market": return ["Place positions in prediction markets", "position"];
      case "Launchpad": return ["Stake and join token sales", "participation"];
      case "Payments": case "Crypto Card Issuer": return ["Use the protocol for routine payments", "payment"];
      case "Insurance": case "Risk Curators": return ["Buy cover and provide underwriting", "cover"];
      case "NFT Marketplace": return ["Buy and sell NFTs", "NFT trade"];
      case "Stablecoin Issuer": case "Algo-Stables": case "Dual-Token Stablecoin": return ["Mint and hold the stablecoin", "mint"];
      default: return ["Use the protocol regularly", "activity"];
    }
  }
  function farmSteps(r) {
    var chain = r.chain, gas = gasOf(chain), cheap = r.cheap, cheapGas = gasOf(cheap);
    var alt = cheap !== chain ? " Cheaper alternative: " + cheap + " (~$" + String(cheapGas) + "/tx)." : "";
    var a = catAction(r.cat), verb = a[0], noun = a[1];
    var costSmall = 3 * gas + 3, costMed = 5 * gas + 3, costLarge = 7 * gas + 3;
    var ev = Math.max(1, r.imp), pct = (costMed / ev) * 100;
    var pctStr = pct < 0.1 ? "<0.1" : String(Math.round(pct * 10) / 10);
    var verdict = pct < 5 ? "worth it at every tier — cost is far below expected value"
      : pct < 20 ? "worth it at medium/large tiers, marginal at small tier"
      : "expensive relative to expected value — large tier only if convinced, small tier should skip";
    return [
      "Set up a fresh " + chain + "-ready wallet (new, farming-only), store the seed phrase offline, then bridge funds to " + chain + " — bridge cost ~$3 (planning estimate, not a live quote), 10-30 minutes." + alt,
      verb + " on " + r.name + " worth $100 (small) / $1,000 (medium) / $10,000 (large) in 1 transaction — gas ~$" + String(gas) + " on " + chain + ", 5 minutes. Save the transaction hash as proof of activity.",
      "Repeat the " + noun + " 1x per week for 4-8 weeks (4-8 transactions total, gas ~$" + String(gas) + " each, 5 minutes per week) so the activity history looks consistent, not one-off.",
      "Log every date, amount, and transaction hash in a spreadsheet; check the position in the " + chain + " explorer every 2 weeks (10 minutes) and make sure funds stay active, not withdrawn after the first transaction.",
      "Manage risk: never use money you need for daily life, never click airdrop links from DMs or ads, and plan your exit — a full withdrawal takes 1 transaction (~$" + String(gas) + ") plus any protocol waiting time.",
      "Estimated cost " + fmtMoney(costSmall) + " (small) / " + fmtMoney(costMed) + " (medium) / " + fmtMoney(costLarge) + " (large); expected value " + fmtUsd(ev) + "; medium-tier cost = " + pctStr + "% of expected value — " + verdict + "."
    ];
  }

  // ---- Header, KPIs, integrity strip ----
  document.getElementById("title").textContent =
    "Token Launch Radar — " + META.boardN + " pre-token protocols, ranked by implied value";
  document.title = "Token Launch Radar — " + META.boardN + " pre-token protocols";
  var kpis = [
    [META.boardN + "", "pre-token protocols ranked"],
    [fmtUsd(META.totalImplied), "total implied value"],
    ["#1 " + META.top1.name, "top protocol · " + fmtUsd(META.top1.implied)],
    [fmtUsd(META.medianImplied), "median implied value"],
    [META.watchlistCovered + "/" + META.watchlistN, "watchlist covered"],
    [META.excludedN + " excluded", "brand already has a token"],
  ];
  document.getElementById("kpis").innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><b>' + esc(k[0]) + '</b><span>' + esc(k[1]) + '</span></div>';
  }).join("");
  document.getElementById("exclN").textContent =
    META.excludedN + " protocols are excluded — brand already has a token.";
  document.getElementById("exclLine").textContent =
    META.excludedN + " excluded — brand already has a token (list below)";
  document.getElementById("excluded").innerHTML = excl.map(function (e) {
    return "<li><b>" + esc(e.name) + "</b> — sibling " + esc(e.sib) +
      " (" + fmtUsd(e.sibMcap) + ")</li>";
  }).join("");

  // ---- Board table: filter + sort ----
  var sortKey = "rank", sortDir = 1;
  var tbody = document.querySelector("#board tbody");
  var catSel = document.getElementById("cat");
  CATS.forEach(function (c) {
    var o = document.createElement("option"); o.value = c; o.textContent = c; catSel.appendChild(o);
  });
  function ageStr(d) { return d >= 365 ? (d / 365).toFixed(1) + "y" : d + "d"; }
  function filtered() {
    var q = document.getElementById("q").value.trim().toLowerCase();
    var cat = catSel.value, wl = document.getElementById("wl").checked;
    var minOdds = parseFloat(document.getElementById("odds").value);
    var list = rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      if (cat && r.cat !== cat) return false;
      if (wl && !watch.has(r.slug)) return false;
      if (r.odds < minOdds) return false;
      return true;
    });
    var k = sortKey;
    list.sort(function (a, b) {
      var x = a[k], y = b[k];
      if (typeof x === "string") return sortDir * (x < y ? -1 : x > y ? 1 : 0);
      return sortDir * (x - y);
    });
    return list;
  }
  function render() {
    var list = filtered();
    document.getElementById("count").textContent =
      list.length + " of " + rows.length + " shown — click a row for detail.";
    tbody.innerHTML = list.map(function (r) {
      return "<tr data-slug=\"" + esc(r.slug) + "\"><td>" + r.rank + "</td><td><b>" + esc(r.name) + "</b>" +
        (watch.has(r.slug) ? ' <span class="badge">WATCH</span>' : "") + "</td>" +
        "<td>" + esc(r.cat) + "</td><td class=\"num\">" + fmtUsd(r.tvl) + "</td>" +
        "<td class=\"num\">" + (r.growth >= 0 ? "+" : "") + (r.growth * 100).toFixed(1) + "%</td>" +
        "<td class=\"num\">" + ageStr(r.age) + "</td><td class=\"num\">" + Math.round(r.odds * 100) + "%</td>" +
        "<td class=\"num teal\"><b>" + fmtUsd(r.imp) + "</b></td></tr>";
    }).join("");
  }
  tbody.addEventListener("click", function (e) {
    var tr = e.target.closest("tr");
    if (tr) showDetail(tr.getAttribute("data-slug"));
  });
  document.querySelectorAll("#board th").forEach(function (th) {
    th.addEventListener("click", function () {
      var k = th.getAttribute("data-k");
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      render();
    });
  });
  ["q", "cat", "wl", "odds"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", render);
  });
  document.getElementById("reset").addEventListener("click", function () {
    document.getElementById("q").value = ""; catSel.value = "";
    document.getElementById("wl").checked = false; document.getElementById("odds").value = "0";
    sortKey = "rank"; sortDir = 1; render();
  });

  // ---- Detail view ----
  // Stage-1 multiple from the fitted model (META): exp(intercept + slope *
  // ln(TVL)) / TVL. Stage-2 growth/maturity factors split the clamped
  // second-stage adjustment proportionally, so growth x maturity =
  // exp(stage-2 adjustment). Fair value is anchored on the board's own
  // numbers (implied / odds), so the detail always agrees with the board.
  function stage1Mult(r) {
    var m = META.model;
    return Math.exp(m.intercept + m.slope * Math.log(r.tvl)) / r.tvl;
  }
  function stage2Factors(r) {
    var s2 = META.model.stage2;
    var raw = 0.5 * s2.growth * r.growth + 0.5 * s2.logAge * Math.log(Math.max(1, r.age));
    var adj = Math.max(-0.35, Math.min(0.35, raw));
    var s = raw === 0 ? 1 : adj / raw;
    return {
      g: Math.exp(0.5 * s2.growth * r.growth * s),
      m: Math.exp(0.5 * s2.logAge * Math.log(Math.max(1, r.age)) * s)
    };
  }
  function showDetail(slug) {
    var r = rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    var fair = Math.round(r.imp / r.odds);
    var mult = stage1Mult(r);
    var f = stage2Factors(r);
    var steps = farmSteps(r);
    var d = document.getElementById("detail");
    d.hidden = false;
    d.innerHTML = "<h2>#" + r.rank + " " + esc(r.name) + (watch.has(r.slug) ? ' <span class="badge">WATCHLIST</span>' : "") + "</h2>" +
      "<p class=\"muted\">" + esc(r.slug) + " · " + esc(r.cat) + " · main chain " + esc(r.chain) + "</p>" +
      "<div class=\"kpis2\">" +
      "<div>TVL<b>" + fmtUsd(r.tvl) + "</b></div>" +
      "<div>Multiple<b>" + mult.toFixed(2) + "×</b></div>" +
      "<div>Growth 7d<b>" + (r.growth >= 0 ? "+" : "") + (r.growth * 100).toFixed(1) + "%</b></div>" +
      "<div>Age<b>" + ageStr(r.age) + "</b></div>" +
      "<div>Token odds<b>" + Math.round(r.odds * 100) + "%</b></div>" +
      "<div>Fair value<b>" + fmtUsd(fair) + "</b></div>" +
      "<div>Expected value<b>" + fmtUsd(r.imp) + "</b></div></div>" +
      "<p>TVL " + fmtUsd(r.tvl) + " × multiple " + mult.toFixed(2) + " × growth " + f.g.toFixed(2) +
      " × maturity " + f.m.toFixed(2) + " = fair value " + fmtUsd(fair) + "; × odds " +
      Math.round(r.odds * 100) + "% = expected value " + fmtUsd(r.imp) + ". " +
      "Fair value is what the token would be worth if launched at peers' multiples; odds are the chance it launches at all.</p>" +
      "<h3>Farm plan</h3><ol>" + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>";
    d.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- Model tab ----
  var m = META.model;
  var params = "<p>Fitted on the 128 token-bearing protocols with a positive market cap " +
    "(15 more have a token but a $0 market cap and were excluded). Stage-1 " + m.kind + ": slope <b>" + m.slope +
    "</b>, intercept <b>" + m.intercept + "</b>. Stage 2 (n=" + m.stage2.n + "): growth <b>" + m.stage2.growth +
    "</b>, log-age <b>" + m.stage2.logAge + "</b> — both halved before use, so growth and age move the multiple only a little, " +
    "as the data says. Stage-2 intercept " + m.stage2.c0NotApplied + " is <i>not</i> applied. " +
    "Age-band odds factors (young → old): <b>" + m.ageFactors.join(", ") + "</b>. Global token rate: " +
    Math.round(META.globalOdds * 100) + "%.</p>";
  if (m.catIntercepts) {
    params += "<p>Category intercepts (shrunk toward pooled): " +
      Object.keys(m.catIntercepts).sort().map(function (k) { return esc(k) + " " + m.catIntercepts[k]; }).join(" · ") + ".</p>";
  }
  document.getElementById("modelParams").innerHTML = params;
  document.querySelector("#valTable tbody").innerHTML = META.validation.map(function (v) {
    return "<tr><td>" + esc(v.label) + "</td><td>" + esc(v.kind) + "</td><td><b>" + v.med.toFixed(3) +
      "</b></td><td>" + v.pctBetterVsSpec.toFixed(1) + "% better than baseline (" + v.specBase.toFixed(2) + ")</td><td>" + v.r2.toFixed(3) + "</td></tr>";
  }).join("");

  // ---- Reference table ----
  document.querySelector("#refTable tbody").innerHTML = live.map(function (p) {
    return "<tr><td>" + esc(title(p.slug)) + " <span class=\"muted\">(" + esc(p.slug) + ")</span></td><td class=\"num\">" +
      (p.mcap === 0 ? "$0" : fmtUsd(p.mcap)) + "</td></tr>";
  }).join("");

  render();
  if (rows.length) showDetail(rows[0].slug);
  if (typeof window !== "undefined") window.__farm = farmSteps;
})();
