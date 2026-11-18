// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable and sortable table, a per-protocol detail drawer with
// the model's own arithmetic and the protocol's farm plan, the live-token view, and the model
// explainer with its category multiples and market-fit check. No network: every byte it shows
// is in data.js. Hash state (#q, #p, #category, #chain, #tab, #watchlist, #mintvl) deep-links
// every view, so the three screenshots are plain links to a board, a detail and a filter.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var watchlist = {};
  (DATA.watchlist || []).forEach(function (s) { watchlist[s] = true; });
  var state = { q: '', category: 'all', chain: 'all', mintvl: 0, watchlistOnly: false, tab: 'board', sort: 'implied_value_usd', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(m) { return 'x' + m.toFixed(3); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function bySlug(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }

  // ---- header, stats -------------------------------------------------------
  document.getElementById('asof').textContent = 'Snapshot ' + DATA.as_of + ' · ' + DATA.rows.length + ' pre-token protocols ranked';
  (function stats() {
    var box = document.getElementById('stats');
    var top = DATA.rows[0];
    var items = [
      [fmtUsd(top ? top.implied_value_usd : 0), 'highest implied value' + (top ? ' — ' + top.name : '')],
      [String(DATA.watchlist_size), 'protocols on the watchlist'],
      [String(DATA.board_size), 'rows on the board (' + DATA.early_size + ' found below the floor)'],
      [fmtMult(DATA.global_multiple), 'global market multiple, mcap per $1 of TVL'],
    ];
    items.forEach(function (it) {
      box.appendChild(el('div', { class: 'stat' }, el('b', { text: it[0] }), el('span', { text: it[1] })));
    });
  })();

  // ---- filter controls -----------------------------------------------------
  (function fillFilters() {
    var cats = {};
    var chains = {};
    DATA.rows.forEach(function (r) {
      if (r.category) cats[r.category] = true;
      (r.chains || []).forEach(function (c) { chains[c] = true; });
    });
    var catSel = document.getElementById('category');
    Object.keys(cats).sort().forEach(function (c) { catSel.appendChild(el('option', { value: c, text: c })); });
    var chainSel = document.getElementById('chain');
    Object.keys(chains).sort().forEach(function (c) { chainSel.appendChild(el('option', { value: c, text: c })); });
  })();

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchlistOnly && !watchlist[r.slug]) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < state.mintvl) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function sortKey(r, key) {
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'category') return (r.category || '').toLowerCase();
    if (key === 'chains') return (r.chains && r.chains[0]) || '';
    if (key === 'age_days') return r.age_days === null || r.age_days === undefined ? -1 : r.age_days;
    if (key === 'change_7d') return r.change_7d === null || r.change_7d === undefined ? -9999 : r.change_7d;
    return r[key];
  }

  function renderBoard() {
    var rows = filtered().slice();
    var key = state.sort;
    var dir = state.dir;
    rows.sort(function (a, b) {
      var ka = sortKey(a, key);
      var kb = sortKey(b, key);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      return a.rank - b.rank;
    });
    var tbody = document.getElementById('rows');
    tbody.textContent = '';
    rows.forEach(function (r) {
      var tr = el('tr', { onclick: function () { select(r.slug); } });
      tr.appendChild(el('td', { class: 'rank', text: String(r.rank) }));
      var nameTd = el('td');
      nameTd.appendChild(el('span', { class: 'name', text: r.name }));
      nameTd.appendChild(el('span', { class: 'sub', text: r.slug + (watchlist[r.slug] ? ' · watchlist' : '') }));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', { text: r.category || '—' }));
      var chainTd = el('td');
      (r.chains || []).slice(0, 2).forEach(function (c) { chainTd.appendChild(el('span', { class: 'chip', text: c })); });
      if ((r.chains || []).length > 2) chainTd.appendChild(el('span', { class: 'chip', text: '+' + ((r.chains || []).length - 2) }));
      tr.appendChild(chainTd);
      tr.appendChild(el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }));
      var ch = el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) });
      tr.appendChild(ch);
      tr.appendChild(el('td', { class: 'num', text: fmtAge(r.age_days) }));
      tr.appendChild(el('td', { class: 'num implied', text: fmtUsd(r.implied_value_usd) }));
      tbody.appendChild(tr);
    });
    document.getElementById('count').textContent = rows.length + ' of ' + DATA.rows.length + ' rows';
    document.getElementById('board-note').textContent =
      'Ranked by implied value, rank 1 first. Click a row for the model behind its number and its farm plan. ' +
      'Implied values are this radar\u2019s own claim from the snapshot\u2019s figures — not a promise that a token will be issued.';
    document.querySelectorAll('#table th[data-sort]').forEach(function (th) {
      var base = th.getAttribute('data-sort');
      var label = th.textContent.replace(/ [▲▼]$/, '');
      th.textContent = label + (base === state.sort ? (state.dir === -1 ? ' ▼' : ' ▲') : '');
    });
  }

  // ---- live view -----------------------------------------------------------
  function renderLive() {
    var tbody = document.getElementById('liverows');
    tbody.textContent = '';
    DATA.live.forEach(function (p) {
      var tr = el('tr');
      var nameTd = el('td');
      nameTd.appendChild(el('span', { class: 'name', text: p.name }));
      nameTd.appendChild(el('span', { class: 'sub', text: p.slug }));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', { text: p.category || '—' }));
      var chainTd = el('td');
      (p.chains || []).slice(0, 2).forEach(function (c) { chainTd.appendChild(el('span', { class: 'chip', text: c })); });
      tr.appendChild(chainTd);
      tr.appendChild(el('td', { class: 'num', text: fmtUsd(p.tvl_usd) }));
      tr.appendChild(el('td', { class: 'num', text: fmtUsd(p.mcap_usd) }));
      var ratio = p.mcap_usd !== null && p.tvl_usd > 0 ? p.mcap_usd / p.tvl_usd : null;
      tr.appendChild(el('td', { class: 'num', text: ratio === null ? 'n/a' : fmtMult(ratio) }));
      tr.appendChild(el('td', { class: 'num ' + (p.change_7d === null ? '' : p.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(p.change_7d) }));
      tbody.appendChild(tr);
    });
  }

  // ---- model view ----------------------------------------------------------
  function renderModel() {
    var box = document.getElementById('model-explainer');
    box.textContent = '';
    var m = DATA.model;
    var paras = [
      'Every live-token protocol in the snapshot has a market cap and a TVL. Divide one by the other and you get what the market pays for one dollar of TVL in that protocol\u2019s category. The median of those ratios, per category, is the category multiple — the base of every implied value on the board.',
      'Implied value = TVL × category multiple × growth × maturity. Growth clamps the seven-day TVL change to ' + m.growth_floor + '% … +' + m.growth_cap + '% and weights it by ' + m.growth_weight + '. Maturity runs from ' + m.maturity_floor + ' for a brand-new protocol to ' + (m.maturity_floor + m.maturity_range) + ' after ' + m.maturity_days + ' days with no token; a protocol whose listing date is unknown counts as ' + m.unknown_age_days + ' days old. Categories with fewer than ' + m.min_category_comps + ' live comparables use the global median multiple of ' + fmtMult(DATA.global_multiple) + '.',
      'No name is special-cased: the same arithmetic scores every row, and the table below lists every multiple with the number of live protocols behind it.',
    ];
    paras.forEach(function (t) { box.appendChild(el('p', { class: 'lede', text: t })); });
    var tbody = document.getElementById('comprows');
    tbody.textContent = '';
    DATA.comps.forEach(function (c) {
      var tr = el('tr');
      tr.appendChild(el('td', { text: c.category }));
      tr.appendChild(el('td', { class: 'num', text: String(c.comps) }));
      tr.appendChild(el('td', { class: 'num', text: fmtMult(c.multiple) }));
      tbody.appendChild(tr);
    });
    var reg = DATA.regression;
    document.getElementById('fit-text').textContent =
      'Over the ' + reg.n + ' live-token protocols with a market cap and a TVL, log market cap = ' +
      reg.intercept.toFixed(2) + ' + ' + reg.slope.toFixed(2) + ' × log TVL, R² = ' + reg.r2.toFixed(2) +
      '. TVL alone explains only part of a token\u2019s value — that is why the board uses category multiples instead of one flat rate.';
    drawFitChart();
  }

  function drawFitChart() {
    var cv = document.getElementById('fitchart');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    var W = cv.width;
    var H = cv.height;
    ctx.clearRect(0, 0, W, H);
    var pts = DATA.live
      .filter(function (p) { return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0; })
      .map(function (p) { return { x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd) }; });
    if (pts.length < 2) return;
    var xs = pts.map(function (p) { return p.x; });
    var ys = pts.map(function (p) { return p.y; });
    var x0 = Math.min.apply(null, xs) - 0.5;
    var x1 = Math.max.apply(null, xs) + 0.5;
    var y0 = Math.min.apply(null, ys) - 0.5;
    var y1 = Math.max.apply(null, ys) + 0.5;
    function px(x) { return 60 + ((x - x0) / (x1 - x0)) * (W - 80); }
    function py(y) { return H - 40 - ((y - y0) / (y1 - y0)) * (H - 70); }
    ctx.strokeStyle = '#1f2a37';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var gy = 40 + ((H - 110) / 4) * g;
      ctx.beginPath(); ctx.moveTo(60, gy); ctx.lineTo(W - 20, gy); ctx.stroke();
    }
    ctx.fillStyle = '#8b98a9';
    ctx.font = '12px sans-serif';
    ctx.fillText('TVL (log scale)', W - 140, H - 12);
    ctx.save(); ctx.translate(14, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('Market cap (log scale)', -70, 0); ctx.restore();
    var reg = DATA.regression;
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px(x0), py(reg.intercept + reg.slope * x0));
    ctx.lineTo(px(x1), py(reg.intercept + reg.slope * x1));
    ctx.stroke();
    ctx.fillStyle = '#e6edf3';
    pts.forEach(function (p) {
      ctx.beginPath(); ctx.arc(px(p.x), py(p.y), 3.5, 0, Math.PI * 2); ctx.fill();
    });
  }

  // ---- detail drawer -------------------------------------------------------
  function splitStep(s) {
    var costAt = s.lastIndexOf(' Cost: ');
    var timeAt = s.lastIndexOf('. Time: ');
    if (costAt < 0 || timeAt < 0) return { text: s, cost: '', time: '' };
    return {
      text: s.slice(0, costAt),
      cost: s.slice(costAt + 7, timeAt),
      time: s.slice(timeAt + 8).replace(/\.$/, ''),
    };
  }

  function select(slug) {
    var r = bySlug(slug);
    var drawer = document.getElementById('drawer');
    if (!r) { drawer.hidden = true; state.selected = null; writeHash(); return; }
    state.selected = slug;
    drawer.textContent = '';
    drawer.appendChild(el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { select(null); } }));
    drawer.appendChild(el('h2', { text: r.name }));
    drawer.appendChild(el('p', { class: 'lede', text: r.slug + ' · ' + (r.category || 'uncategorized') + ' · rank ' + r.rank + ' of ' + DATA.rows.length + (watchlist[r.slug] ? ' · on the watchlist' : '') }));
    var kv = el('div', { class: 'kv' });
    [
      [fmtUsd(r.implied_value_usd), 'implied value'],
      [fmtUsd(r.tvl_usd), 'TVL'],
      [fmtPct(r.change_7d), 'TVL change, 7 days'],
      [fmtAge(r.age_days), 'tracked for'],
      [(r.chains || []).slice(0, 4).join(', ') + ((r.chains || []).length > 4 ? ' +' + ((r.chains || []).length - 4) + ' more' : '') || '—', 'chains'],
      [fmtMult(r.base_multiple) + (r.category_comps > 0 ? ' (' + r.category_comps + ' comps)' : ' (global median)'), 'category multiple'],
    ].forEach(function (kvPair) {
      kv.appendChild(el('div', {}, el('b', { text: kvPair[0] }), el('span', { text: kvPair[1] })));
    });
    drawer.appendChild(kv);
    var growthPct = r.change_7d === null ? 0 : Math.min(120, Math.max(-60, r.change_7d));
    var math = el('p', { class: 'math' });
    math.appendChild(document.createTextNode('Implied value = TVL × multiple × growth × maturity = '));
    math.appendChild(el('code', { text: fmtUsd(r.tvl_usd) + ' × ' + r.base_multiple.toFixed(3) + ' × ' + r.growth_multiplier.toFixed(3) + ' × ' + r.maturity_multiplier.toFixed(3) + ' = ' + fmtUsd(r.implied_value_usd) }));
    drawer.appendChild(math);
    drawer.appendChild(el('p', { class: 'lede', text: 'Growth uses the seven-day TVL change clamped to −60% … +120% (' + fmtPct(growthPct) + ' here). Maturity runs 0.60 → 1.00 over three years with no token. ' + (r.category_comps > 0 ? 'The multiple is the median market-cap-per-TVL of the ' + r.category_comps + ' live-token protocols in this category.' : 'The multiple is the global median — this category has too few live-token protocols to set its own.') }));
    drawer.appendChild(el('h2', { text: 'Farm plan' }));
    var ol = el('ol', { class: 'steps' });
    r.farm_steps.forEach(function (s) {
      var part = splitStep(s);
      var li = el('li', { text: part.text });
      li.appendChild(el('span', { class: 'meta', text: 'Cost: ' + part.cost + ' · Time: ' + part.time }));
      ol.appendChild(li);
    });
    drawer.appendChild(ol);
    drawer.appendChild(el('p', { class: 'note', text: 'Costs are estimates for the chain this protocol runs on. Never pay to claim an airdrop: a real claim costs nothing but gas.' }));
    drawer.hidden = false;
    writeHash();
  }

  // ---- tabs, controls, hash -----------------------------------------------
  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    document.getElementById('view-board').hidden = tab !== 'board';
    document.getElementById('view-live').hidden = tab !== 'live';
    document.getElementById('view-model').hidden = tab !== 'model';
    if (tab === 'live') renderLive();
    if (tab === 'model') renderModel();
    writeHash();
  }
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });
  document.querySelectorAll('#table th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' || key === 'category' || key === 'chains' ? 1 : -1; }
      renderBoard();
    });
  });
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); writeHash(); });
  document.getElementById('category').addEventListener('change', function (e) { state.category = e.target.value; renderBoard(); writeHash(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); writeHash(); });
  document.getElementById('mintvl').addEventListener('change', function (e) { state.mintvl = Number(e.target.value); renderBoard(); writeHash(); });
  document.getElementById('watchlist').addEventListener('change', function (e) { state.watchlistOnly = e.target.checked; renderBoard(); writeHash(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') select(null); });

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.mintvl) params.set('mintvl', String(state.mintvl));
    if (state.watchlistOnly) params.set('watchlist', '1');
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var h = params.toString();
    history.replaceState(null, '', h ? '#' + h : window.location.pathname + window.location.search);
  }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) { state.q = params.get('q'); document.getElementById('q').value = state.q; }
    if (params.get('category')) { state.category = params.get('category'); document.getElementById('category').value = state.category; }
    if (params.get('chain')) { state.chain = params.get('chain'); document.getElementById('chain').value = state.chain; }
    if (params.get('mintvl')) { state.mintvl = Number(params.get('mintvl')); document.getElementById('mintvl').value = String(state.mintvl); }
    if (params.get('watchlist')) { state.watchlistOnly = true; document.getElementById('watchlist').checked = true; }
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
  }

  readHash();
  showTab(state.tab);
  renderBoard();
  if (state.selected) select(state.selected);
})();
