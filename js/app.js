import { extractPages, parseStatement, detectBank } from './parser.js';
import * as E from './engine.js';
import { fetchRatesLive, fxStats } from './fx.js';
import { makeDemo } from './demo.js';

const VISA_LIVING_AUD = 29710; // Home Affairs 12-month living cost for a primary student (checked Nov 2026)
const WORK_LIMIT = 48;         // hours per fortnight while the course is in session (condition 8105)
const STORE = 'rupeeroo.v1';

// ---------------- state ----------------
const defaults = () => ({
  txns: [], statements: [], rules: {}, txnOverrides: {}, fixedOverrides: {}, demo: false,
  settings: { savingsGoal: 10000, incomeOverride: null, oneOff: 15000, bigTransfer: 50000, holderNames: [], primary: 'INR', alertPct: 0.25, notify: false, theme: 'auto' },
  fx: { history: {}, last: null, manual: null, notified: {} },
  sydney: { extraFunds: 0, hourly: 26, anchor: '2027-02-15', breaks: {}, hours: [], loan: { principal: 4000000, rate: 10, moratorium: 30, tenure: 180, payDuring: false } },
  ui: { tab: 'home', month: null, catFilter: null, q: '' },
});
let S = load();
let D = {}; // derived data
applySeed(false);

/** A private copy of the app can ship the owner's own statements in js/seed.js. Loaded once, never re-added after "Delete all data". */
function applySeed(force) {
  const seed = window.RUPEEROO_SEED;
  if (!seed) return false;
  if (!force && (S.seedApplied === seed.version || (S.txns.length && !S.demo))) return false;
  const keep = { fx: S.fx, sydney: S.sydney, settings: S.settings };
  S = deepMerge(defaults(), keep);
  S.txns = seed.txns.map(t => ({ ...t }));
  S.statements = seed.statements.map(x => ({ ...x }));
  (seed.settings?.holderNames || []).forEach(n => { if (!S.settings.holderNames.includes(n)) S.settings.holderNames.push(n); });
  S.demo = false; S.seedApplied = seed.version; S.ui.month = null;
  save();
  return true;
}

function load() {
  try { const raw = localStorage.getItem(STORE); if (raw) return deepMerge(defaults(), JSON.parse(raw)); } catch (e) { /* storage unavailable */ }
  return defaults();
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }
function deepMerge(base, over) {
  for (const k in over) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) base[k] = deepMerge(base[k], over[k]);
    else base[k] = over[k];
  }
  return base;
}

// ---------------- formatting ----------------
const rate = () => S.fx.manual?.rate || S.fx.last?.rate || null; // INR per 1 AUD
const inr = (n, d = 0) => (n < 0 ? '−' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
const aud = (n, d) => { const r = rate(); if (!r) return ''; const v = n / r; const dd = d ?? (Math.abs(v) < 100 ? 2 : 0); return (v < 0 ? '−' : '') + 'A$' + Math.abs(v).toLocaleString('en-AU', { maximumFractionDigits: dd, minimumFractionDigits: dd }); };
const audToInr = a => (rate() ? a * rate() : null);
function money(n, opts = {}) {
  const a = aud(n);
  const first = S.settings.primary === 'AUD' && a ? a : inr(n);
  const second = S.settings.primary === 'AUD' && a ? inr(n) : a;
  return `<span class="money${opts.stacked ? ' stacked' : ''}"><span class="num">${first}</span>${second ? `<span class="aud num">${second}</span>` : ''}</span>`;
}
const fmtPlain = n => (S.settings.primary === 'AUD' && rate() ? aud(n) : inr(n));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mLabel = (m, long) => { const [y, mo] = m.split('-'); return MONTHS[+mo - 1] + (long ? ' ' + y : " '" + y.slice(2)); };
const dLabel = d => `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}`;
const today = () => new Date().toISOString().slice(0, 10);
const daysIn = m => new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
const $ = s => document.querySelector(s);

// ---------------- derive ----------------
function derive() {
  const ctx = { rules: S.rules, txnOverrides: S.txnOverrides, bigTransfer: S.settings.bigTransfer };
  const tx = S.txns;
  E.markTransfers(tx, S.settings.holderNames);
  tx.forEach(t => { t.payee = E.payeeKey(t); t.cat = E.categorise(t, ctx); t.fixed = false; });
  E.promoteSalary(tx, ctx);
  const recurring = E.findRecurring(tx, { fixedOverrides: S.fixedOverrides });
  const fixedIds = new Set(recurring.flatMap(r => r.ids));
  tx.forEach(t => { t.fixed = fixedIds.has(t.id); });
  const mon = E.monthly(tx);
  const months = Object.keys(mon).sort();
  const dataEnd = tx.reduce((m, t) => (t.date > m ? t.date : m), '');
  if (!S.ui.month || !mon[S.ui.month]) S.ui.month = months[months.length - 1] || null;
  const fixedTotal = recurring.reduce((s, r) => s + r.amount, 0);
  const incomeAuto = E.incomeEstimate(tx);
  const income = S.settings.incomeOverride ?? incomeAuto;
  const fc = E.forecast(tx, { oneOff: S.settings.oneOff });
  const totalIncome = tx.filter(t => E.CAT[t.cat]?.kind === 'income').reduce((s, t) => s + t.credit, 0);
  const totalSpend = Object.values(mon).reduce((s, m) => s + m.spend, 0);
  const saved = Math.max(0, totalIncome - totalSpend);
  const balances = latestBalances();
  D = { recurring, mon, months, dataEnd, fixedTotal, income, incomeAuto, fc, saved, balances };
}

function latestBalances() {
  const by = {};
  S.txns.forEach(t => { const k = t.bank + (t.acct ? ' ••' + t.acct : ''); if (!by[k] || t.date > by[k].date || (t.date === by[k].date && t.seq > by[k].seq)) by[k] = t; });
  return Object.entries(by).map(([k, t]) => ({ name: k, balance: t.balance, date: t.date }));
}

/** Context for the selected month: how far through it we are and what has been spent. */
function monthCtx(m) {
  const mo = D.mon[m];
  const dim = daysIn(m);
  const isLatest = m === D.months[D.months.length - 1];
  let day = dim;
  if (m === today().slice(0, 7)) day = +today().slice(8);
  else if (isLatest && D.dataEnd.startsWith(m)) day = +D.dataEnd.slice(8);
  const spentVar = S.txns.filter(t => t.date.startsWith(m) && t.debit > 0 && E.CAT[t.cat]?.kind === 'spend' && !t.fixed && t.debit < S.settings.oneOff).reduce((s, t) => s + t.debit, 0);
  const oneOffs = S.txns.filter(t => t.date.startsWith(m) && t.debit >= S.settings.oneOff && E.CAT[t.cat]?.kind === 'spend' && !t.fixed);
  const sts = E.safeToSpend({ income: D.income, fixedTotal: D.fixedTotal, savingsGoal: S.settings.savingsGoal, spentVariable: spentVar, daysLeft: dim - day });
  const hp = E.health(sts.monthlyAllowance, spentVar, day, dim);
  const monthOver = day >= dim;
  return { mo, dim, day, spentVar, oneOffs, sts, hp, monthOver, isLatest };
}

// ---------------- rendering ----------------
function render() {
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.ui.tab));
  updateFxPill();
  $('#banner').innerHTML = S.demo ? `<div class="demo-banner"><span>👀 You're looking at <b>demo data</b>.</span><button class="btn small" data-action="clear-data">Use my own</button></div>` : '';
  const v = $('#view');
  if (!S.txns.length && !['fx', 'sydney'].includes(S.ui.tab)) { v.innerHTML = viewEmpty(); return; }
  v.innerHTML = ({ home: viewHome, spend: viewSpend, plan: viewPlan, fx: viewFx, sydney: viewSydney })[S.ui.tab]();
  afterRender();
}

function viewEmpty() {
  return `
  <div class="card" style="text-align:center">
    <div class="drop" id="drop" data-action="pick-pdf">
      <div class="big">📄</div>
      <div style="font-weight:650;font-size:16px;margin-top:6px">Add your bank statements</div>
      <div class="sub" style="margin-top:4px">PDF statements from <b>SBI</b> or <b>IndusInd</b>. Pick several at once.</div>
      <button class="btn primary" style="margin-top:14px" data-action="pick-pdf">Choose PDF files</button>
    </div>
    <div class="privacy"><span>🔒</span><span>Statements are read <b>on this device</b> and saved only in this browser. Nothing is uploaded. The only network call is for exchange rates.</span></div>
    <button class="btn block" style="margin-top:12px" data-action="load-demo">Try it with demo data</button>
  </div>
  ${S.statements.length ? '' : `<div class="card"><h2>How it works</h2><ol class="sub" style="padding-left:18px;margin:0">
    <li>Download a PDF statement from YONO / net banking (SBI) or the INDIE app (IndusInd).</li>
    <li>Add it here. Every row is checked against the running balance.</li>
    <li>Fix any category once; RupeeRoo remembers it for that payee.</li></ol></div>`}`;
}

/** Warn when a bank's statement stops before the selected month ends, so totals look low. */
function coverageNote(m) {
  const last = {}, first = {};
  S.txns.forEach(t => { if (!last[t.bank] || t.date > last[t.bank]) last[t.bank] = t.date; if (!first[t.bank] || t.date < first[t.bank]) first[t.bank] = t.date; });
  const monthEnd = m + '-' + String(daysIn(m)).padStart(2, '0');
  const short = Object.keys(last).filter(b => last[b] < monthEnd && last[b] < D.dataEnd && first[b] <= monthEnd);
  if (!short.length) return '';
  return `<div class="coverage">📎 ${short.map(b => `${b} statement ends ${dLabel(last[b])}`).join(', ')}, so ${mLabel(m, true)} is missing some ${short.join(' and ')} spending. <a href="#" data-action="pick-pdf">Add a newer statement</a>.</div>`;
}

function monthChips() {
  return `<div class="chips-wrap"><button class="chip-nav" data-action="chips-scroll" data-dir="-1" aria-label="Earlier months">‹</button>
    <div class="chips" role="tablist">${D.months.map(m => `<button class="chip ${m === S.ui.month ? 'on' : ''}" data-action="month" data-m="${m}">${mLabel(m)}</button>`).join('')}</div>
    <button class="chip-nav" data-action="chips-scroll" data-dir="1" aria-label="Later months">›</button></div>`;
}
function syncChipNav(row) {
  const wrap = row.parentElement; if (!wrap) return;
  const max = row.scrollWidth - row.clientWidth;
  wrap.classList.toggle('can-left', row.scrollLeft > 4);
  wrap.classList.toggle('can-right', row.scrollLeft < max - 4);
}

function viewHome() {
  const m = S.ui.month, c = monthCtx(m), mo = c.mo;
  const lvl = E.levelFor(D.saved);
  const st = E.streaks(S.txns, Math.max(0, c.sts.monthlyAllowance / c.dim), m);
  const months = D.months; const prev = months[months.indexOf(m) - 1];
  const qs = E.quests(D.mon, m, prev, { fmt: fmtPlain, savingsGoal: S.settings.savingsGoal, noSpendMonth: st.noSpendMonth, monthOver: c.monthOver });
  const qxp = qs.filter(q => q.done).reduce((s, q) => s + q.xp, 0);
  const remaining = c.sts.remaining;
  const ring = ringSvg(lvl.pct);
  return `
  ${monthChips()}${coverageNote(m)}
  <div class="card">
    <h2>Safe to spend <small>${c.monthOver ? mLabel(m, true) + ' (closed)' : `${c.dim - c.day} days left in ${mLabel(m, true)}`}</small></h2>
    <div class="hero-num num ${remaining < 0 ? 'neg' : ''}">${S.settings.primary === 'AUD' && rate() ? aud(remaining) : inr(remaining)}</div>
    <div class="hero-aud num">${S.settings.primary === 'AUD' && rate() ? inr(remaining) : aud(remaining)}${!c.monthOver && c.sts.perDay ? ` · about ${fmtPlain(c.sts.perDay)} a day` : ''}</div>
    <div style="margin-top:14px" class="row"><span class="tiny muted">Budget health</span><span class="badge">${hpIcon(c.hp.status)} ${c.hp.label} · ${c.hp.hp} HP</span></div>
    <div class="hp" style="margin-top:6px" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.hp.hp}" aria-label="Budget health"><div class="status-${c.hp.status}" style="width:${Math.max(2, c.hp.hp)}%"></div></div>
    <div class="tiny muted" style="margin-top:8px">${fmtPlain(D.income)} income − ${fmtPlain(D.fixedTotal)} fixed − ${fmtPlain(S.settings.savingsGoal)} savings goal = ${fmtPlain(c.sts.monthlyAllowance)} for everyday spending. Spent ${fmtPlain(c.spentVar)} so far.</div>
    ${c.oneOffs.length ? `<div class="tiny muted" style="margin-top:6px">Not counted as everyday: ${c.oneOffs.map(t => esc(E.payeeName(t)) + ' ' + inr(t.debit)).join(', ')}.</div>` : ''}
  </div>

  <div class="card">
    <div class="level">
      <div class="ring">${ring}</div>
      <div style="flex:1">
        <div class="row"><b>Level ${lvl.level} · ${lvl.title}</b><span class="tiny muted">${qxp ? '+' + qxp + ' XP' : ''}</span></div>
        <div class="tiny muted">Saved so far ${fmtPlain(D.saved)}${lvl.to ? ` · next: ${lvl.nextTitle} at ${fmtPlain(lvl.to)}` : ' · max level'}</div>
        <div class="xpbar"><div style="width:${Math.round(lvl.pct * 100)}%"></div></div>
      </div>
    </div>
    <div class="grid3" style="margin-top:14px">
      <div class="stat"><div class="k">🔥 Streak</div><div class="v num">${st.current}d</div><div class="a">under daily budget</div></div>
      <div class="stat"><div class="k">🏆 Best</div><div class="v num">${st.best}d</div><div class="a">longest streak</div></div>
      <div class="stat"><div class="k">🧘 No-spend</div><div class="v num">${st.noSpendMonth}</div><div class="a">days in ${mLabel(m)}</div></div>
    </div>
    <div class="tiny muted" style="margin-top:8px">Streaks count up to your latest statement (${dLabel(st.asOf || D.dataEnd)}).</div>
  </div>

  <div class="card">
    <h2>Quests for ${mLabel(m, true)} <small>${qs.filter(q => q.done).length}/${qs.length} done</small></h2>
    ${qs.map(q => `<div class="quest"><div class="qi">${q.icon}</div><div><div class="qt">${esc(q.title)}</div><div class="qs">${esc(q.sub)}${q.now != null && q.kind === 'cap' ? ` · now ${fmtPlain(q.now)}` : ''}${q.kind === 'count' ? ` · ${q.now}/5` : ''}</div>
      <div class="qbar ${q.done ? 'done' : q.failed ? 'fail' : ''}"><div style="width:${Math.round(q.progress * 100)}%"></div></div></div>
      <div class="xp">${q.done ? '✅' : q.failed ? '❌' : ''} ${q.xp} XP</div></div>`).join('')}
  </div>

  <div class="card">
    <h2>${mLabel(m, true)} at a glance</h2>
    <div class="grid2">
      <div class="stat"><div class="k">Spent</div><div class="v">${money(mo.spend, { stacked: true })}</div></div>
      <div class="stat"><div class="k">Came in</div><div class="v">${money(mo.income, { stacked: true })}</div></div>
      <div class="stat"><div class="k">Invested</div><div class="v">${money(mo.invest, { stacked: true })}</div></div>
      <div class="stat"><div class="k">Left over</div><div class="v ${mo.income - mo.spend < 0 ? 'neg' : 'pos'}">${money(mo.income - mo.spend, { stacked: true })}</div></div>
    </div>
    <button class="btn block" style="margin-top:12px" data-action="pick-pdf">＋ Add more statements</button>
  </div>`;
}
const hpIcon = s => ({ good: '💚', warning: '🟡', serious: '🟠', critical: '🔴' }[s]);
function ringSvg(p) {
  const r = 24, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 56 56" class="chart" aria-hidden="true"><circle cx="28" cy="28" r="${r}" fill="none" stroke="var(--plane)" stroke-width="6"/><circle cx="28" cy="28" r="${r}" fill="none" stroke="var(--series-1)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c * p} ${c}" transform="rotate(-90 28 28)"/><text x="28" y="32" text-anchor="middle" style="font-size:13px;font-weight:700;fill:var(--text-primary)">${Math.round(p * 100)}%</text></svg>`;
}

function viewSpend() {
  const m = S.ui.month, mo = D.mon[m];
  const cats = Object.entries(mo.byCat).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]);
  const max = cats[0]?.[1] || 1;
  const filter = S.ui.catFilter, q = (S.ui.q || '').toLowerCase();
  let list = S.txns.filter(t => t.date.startsWith(m));
  if (filter) list = list.filter(t => t.cat === filter);
  if (q) list = list.filter(t => (t.desc + ' ' + E.payeeName(t) + ' ' + E.CAT[t.cat].label).toLowerCase().includes(q));
  list = list.sort((a, b) => (b.date + String(b.seq).padStart(5, '0')).localeCompare(a.date + String(a.seq).padStart(5, '0')));
  const series = D.months.map(k => ({ k, label: mLabel(k), v: Math.max(0, D.mon[k].spend) }));
  return `
  <div class="card">
    <h2>Spending by month <small>excludes own transfers & investments</small></h2>
    <div id="monthChart"></div>
    ${tableView(['Month', 'Spent', 'Income', 'Invested'], D.months.map(k => [mLabel(k, true), inr(D.mon[k].spend), inr(D.mon[k].income), inr(D.mon[k].invest)]))}
  </div>
  ${monthChips()}${coverageNote(m)}
  <div class="card">
    <h2>Where it went in ${mLabel(m, true)} <small>${money(mo.spend)}</small></h2>
    ${cats.map(([c, v]) => `<div class="cbar" data-action="cat" data-c="${c}" title="${esc(E.CAT[c].label)}: ${inr(v)} (${Math.round(v / mo.spend * 100)}%)">
      <div class="ic">${E.CAT[c].icon}</div><div><div class="top"><span>${E.CAT[c].label} <span class="muted tiny">${Math.round(v / mo.spend * 100)}%</span></span>${money(v)}</div>
      <div class="track"><div class="fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div></div></div>`).join('') || '<div class="sub">No spending this month.</div>'}
  </div>
  <div class="card">
    <h2>Transactions <small>${list.length}</small></h2>
    <input class="search" type="search" placeholder="Search payee or note" value="${esc(S.ui.q)}" data-input="q">
    ${filter ? `<div style="margin-top:8px"><button class="chip on" data-action="cat" data-c="">${E.CAT[filter].icon} ${E.CAT[filter].label} ✕</button></div>` : ''}
    <div style="margin-top:6px">${list.slice(0, 250).map(txnRow).join('')}</div>
    ${list.length > 250 ? `<div class="tiny muted">Showing the first 250. Search to narrow down.</div>` : ''}
  </div>`;
}
function txnRow(t) {
  const c = E.CAT[t.cat]; const amt = t.credit ? t.credit : -t.debit;
  const sign = amt > 0 ? 'pos' : '';
  return `<div class="txn" data-action="txn" data-id="${esc(t.id)}"><div class="ic">${c.icon}</div>
    <div style="min-width:0"><div class="t1">${esc(E.payeeName(t))}${t.fixed ? '<span class="tag">FIXED</span>' : ''}</div><div class="t2">${dLabel(t.date)} · ${c.label} · ${t.bank}</div></div>
    <div class="amt ${sign}"><span class="num">${amt > 0 ? '+' : '−'}${inr(Math.abs(amt), Math.abs(amt) % 1 ? 2 : 0).replace('−', '')}</span><span class="aud num">${aud(Math.abs(amt))}</span></div></div>`;
}
function tableView(head, rows) {
  return `<details class="table-view"><summary>Show as table</summary><table class="mini"><tr>${head.map((h, i) => `<th class="${i ? 'r' : ''}">${h}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'r' : ''}">${c}</td>`).join('')}</tr>`).join('')}</table></details>`;
}

function viewPlan() {
  const m = S.ui.month, c = monthCtx(m), fc = D.fc;
  const rec = [];
  for (const r of D.recurring) {
    const g = rec.find(x => x.name === r.name);
    if (g) { g.amount += r.amount; g.parts.push(r); g.months = Math.max(g.months, r.months); g.keys.push(r.key); }
    else rec.push({ ...r, parts: [r], keys: [r.key] });
  }
  const partsLabel = r => r.parts.map(p => (p.perMonth > 1 ? p.perMonth + '× ' : '') + inr(p.unit)).join(' + ');
  let band = '';
  if (fc) {
    const hi = Math.max(fc.high, c.sts.monthlyAllowance) * 1.15;
    const pct = v => (Math.max(0, v) / hi * 100).toFixed(1);
    band = `<div class="band" aria-label="Forecast range ${inr(fc.low)} to ${inr(fc.high)}, most likely ${inr(fc.mid)}">
      <div class="rail"></div>
      <div class="range" style="left:${pct(fc.low)}%;width:${(pct(fc.high) - pct(fc.low)).toFixed(1)}%"></div>
      <div class="mid" style="left:${pct(fc.mid)}%"></div>
      <div class="mk top" style="left:${pct(fc.mid)}%">${fmtPlain(fc.mid)}</div>
      <div class="mk bot" style="left:${pct(fc.low)}%">${fmtPlain(fc.low)}</div>
      <div class="mk bot" style="left:${pct(fc.high)}%">${fmtPlain(fc.high)}</div>
      ${c.sts.monthlyAllowance > 0 ? `<div class="you" style="left:${pct(c.sts.monthlyAllowance)}%" title="Your everyday budget"></div>` : ''}
    </div>`;
  }
  const risk = fc && c.sts.monthlyAllowance > 0 ? (fc.high <= c.sts.monthlyAllowance ? ['good', '✅', 'Even a heavy month fits your everyday budget.'] : fc.mid <= c.sts.monthlyAllowance ? ['warn', '⚠️', 'A typical month fits, but a heavy month would go over budget.'] : ['bad', '🚨', 'A typical month already goes over your everyday budget. Trim a category or lower the savings goal.']) : null;
  return `
  <div class="card">
    <h2>Next 30 days: everyday spending <small>80% range</small></h2>
    ${fc ? `${band}
      <div class="sub">Most likely about <b>${money(fc.mid)}</b>, and 8 times out of 10 between ${money(fc.low)} and ${money(fc.high)}. Built from your last ${fc.basisDays} days of spending (average ${money(fc.dailyAvg)} a day, ${fc.zeroDays} no-spend days), excluding fixed costs and one-offs above ${fmtPlain(S.settings.oneOff)}.</div>
      ${risk ? `<div class="alert a-${risk[0]}"><span>${risk[1]}</span><span>${risk[2]} <span class="muted">(black line = your budget of ${fmtPlain(c.sts.monthlyAllowance)})</span></span></div>` : ''}` : '<div class="sub">Add statements to see a forecast.</div>'}
  </div>

  <div class="card">
    <h2>Fixed costs <small>${money(D.fixedTotal)} / month</small></h2>
    <div class="sub">Found from payments that repeat with the same amount in 3+ months. Turn any off if it isn't really fixed.</div>
    ${rec.length ? `<table class="mini" style="margin-top:8px"><tr><th>Payee</th><th>Day</th><th class="r">Per month</th><th></th></tr>
      ${rec.map(r => `<tr><td>${E.CAT[r.cat].icon} ${esc(r.name)}<div class="tiny muted">${r.parts.length > 1 || r.perMonth > 1 ? partsLabel(r) + ', ' : ''}${r.months} months</div></td><td class="tiny">${r.parts.map(p => ord(p.day)).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</td><td class="r">${money(r.amount, { stacked: true })}</td>
      <td class="r"><button class="btn small" data-action="unfix" data-k="${esc(r.keys.join(','))}" aria-label="Not fixed">✕</button></td></tr>`).join('')}</table>` : '<div class="sub" style="margin-top:8px">No repeating payments found yet. Tap a transaction and mark it as fixed.</div>'}
  </div>

  <div class="card">
    <h2>Safe-to-spend settings</h2>
    <label class="field">Monthly income (₹) <span class="muted">· auto-estimate ${inr(D.incomeAuto)}</span></label>
    <input class="input num" type="number" inputmode="numeric" data-setting="incomeOverride" placeholder="${D.incomeAuto}" value="${S.settings.incomeOverride ?? ''}">
    <label class="field">Savings goal per month (₹)</label>
    <input class="input num" type="number" inputmode="numeric" data-setting="savingsGoal" value="${S.settings.savingsGoal}">
    <label class="field">Treat single payments above this as one-offs (₹)</label>
    <input class="input num" type="number" inputmode="numeric" data-setting="oneOff" value="${S.settings.oneOff}">
    <div class="tiny muted" style="margin-top:10px">Safe to spend = income − fixed costs − savings goal − everyday spending so far. SIPs count as fixed because they leave your account automatically.</div>
  </div>`;
}
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

function viewFx() {
  const r = rate();
  const st = fxStats(S.fx.history, r, S.settings.alertPct);
  const amtIn = S.ui.convInr ?? 10000;
  return `
  <div class="card">
    <h2>Australian dollar today <small>${S.fx.manual ? 'your rate' : S.fx.last ? (S.fx.last.live ? '<span class="live-dot"></span>Live · ' + new Date(S.fx.last.fetchedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : esc(S.fx.last.source) + ' · ' + dLabel(S.fx.last.date)) : ''}</small></h2>
    ${r ? `<div class="hero-num num">₹${r.toFixed(2)}</div><div class="hero-aud">for 1 AUD · ₹1 = A$${(1 / r).toFixed(4)}</div>` : `<div class="sub">No rate yet.</div>`}
    ${S.fx.error ? `<div class="alert a-warn"><span>📡</span><span><b>Couldn't reach the rate service.</b>${esc(S.fx.error)} Enter today's rate from your bank or Wise below and it will be used everywhere.</span></div>` : ''}
    ${st.alerts.map(a => `<div class="alert a-${a.tone}"><span>${a.icon}</span><span><b>${a.title}</b>${a.body}</span></div>`).join('')}
    ${S.fx.day?.date === today() && S.fx.last?.live && !S.fx.manual ? `<div class="tiny muted" style="margin-top:6px">Today so far: low ₹${S.fx.day.low.toFixed(2)} · high ₹${S.fx.day.high.toFixed(2)}</div>` : ''}
    <div class="grid2" style="margin-top:10px">
      <div class="stat"><div class="k">7-day low / high</div><div class="v num">${st.week ? `₹${st.week.low.toFixed(2)} – ${st.week.high.toFixed(2)}` : '–'}</div></div>
      <div class="stat"><div class="k">30-day low / high</div><div class="v num">${st.month ? `₹${st.month.low.toFixed(2)} – ${st.month.high.toFixed(2)}` : '–'}</div></div>
    </div>
    <div id="fxChart" style="margin-top:12px"></div>
    ${st.series.length ? tableView(['Date', '₹ per A$'], st.series.slice(-30).reverse().map(p => [dLabel(p.date), p.rate.toFixed(2)])) : ''}
    <div class="btn-row" style="margin-top:12px"><button class="btn small" data-action="fx-refresh">↻ Refresh</button>
      <button class="btn small" data-action="fx-notify">${S.settings.notify ? '🔔 Alerts on' : '🔕 Turn on alerts'}</button></div>
    <div class="tiny muted" style="margin-top:8px">The live rate is the mid-market rate from Coinbase, refreshed every minute while RupeeRoo is open. The 7- and 30-day lows and highs use European Central Bank daily rates (frankfurter.dev). Your bank or Wise adds a margin on top. Alerts only fire while this page is open.</div>
  </div>
  <div class="card">
    <h2>Converter</h2>
    <div class="inline-inputs">
      <div><label class="field">Rupees</label><input class="input num" type="number" inputmode="decimal" data-conv="inr" value="${amtIn}"></div>
      <div><label class="field">AUD</label><input class="input num" type="number" inputmode="decimal" data-conv="aud" value="${r ? (amtIn / r).toFixed(2) : ''}"></div>
    </div>
  </div>
  <div class="card">
    <h2>Set the rate yourself</h2>
    <div class="sub">Use this if the rate service is blocked, or to plan with your bank's actual rate.</div>
    <div class="inline-inputs" style="margin-top:8px"><input class="input num" type="number" step="0.01" inputmode="decimal" placeholder="e.g. 55.40" id="manualRate" value="${S.fx.manual?.rate ?? ''}">
      <div class="btn-row"><button class="btn primary" data-action="fx-manual">Use</button>${S.fx.manual ? '<button class="btn" data-action="fx-manual-clear">Clear</button>' : ''}</div></div>
    <label class="field">Alert me when the rate is within this % of its 7- or 30-day low or high</label>
    <input class="input num" type="number" step="0.05" min="0" data-setting="alertPct" value="${S.settings.alertPct}">
  </div>`;
}

function viewSydney() {
  const sy = S.sydney, r = rate();
  const balTotal = D.balances?.reduce((s, b) => s + b.balance, 0) || 0;
  const fundsInr = balTotal + (+sy.extraFunds || 0);
  const fundsAud = r ? fundsInr / r : 0;
  const pct = Math.min(1, fundsAud / VISA_LIVING_AUD);
  const needInr = r ? VISA_LIVING_AUD * r : null;
  // work hours
  const fStart = E.fortnightStart(S.ui.hoursDate || today(), sy.anchor);
  const fEnd = new Date(Date.parse(fStart) + 13 * 864e5).toISOString().slice(0, 10);
  const inF = sy.hours.filter(h => h.date >= fStart && h.date <= fEnd);
  const used = inF.reduce((s, h) => s + +h.hours, 0);
  const isBreak = !!sy.breaks[fStart];
  const hTone = isBreak ? 'good' : used > WORK_LIMIT ? 'critical' : used > 40 ? 'serious' : used > 32 ? 'warning' : 'good';
  const L = sy.loan; const lp = E.loanPlan({ principal: +L.principal, rate: +L.rate, moratoriumMonths: +L.moratorium, tenureMonths: +L.tenure, payInterestDuring: L.payDuring });
  return `
  <div class="card">
    <h2>Visa living-cost check <small>AUD ${VISA_LIVING_AUD.toLocaleString('en-AU')}</small></h2>
    <div class="sub">Home Affairs asks a student to show AUD ${VISA_LIVING_AUD.toLocaleString('en-AU')} for 12 months of living costs, on top of tuition and travel.</div>
    <div class="row" style="margin-top:12px"><span class="tiny muted">You can show</span><b class="num">${r ? 'A$' + Math.round(fundsAud).toLocaleString('en-AU') : '–'} <span class="muted tiny">of A$${VISA_LIVING_AUD.toLocaleString('en-AU')}</span></b></div>
    <div class="hp" style="margin-top:6px"><div class="${pct >= 1 ? 'status-good' : 'status-warning'}" style="width:${Math.max(2, pct * 100)}%"></div></div>
    <div class="tiny muted" style="margin-top:6px">${needInr ? `That's about ${inr(needInr)} at today's rate.` : 'Set an exchange rate to compare.'} Bank balances from your latest statements: ${D.balances?.map(b => `${esc(b.name)} ${inr(b.balance)}`).join(', ') || 'none'}.</div>
    <label class="field">Other funds you'll show: FDs, sponsor, loan sanction (₹)</label>
    <input class="input num" type="number" inputmode="numeric" data-sy="extraFunds" value="${sy.extraFunds || ''}" placeholder="0">
    <div class="tiny muted" style="margin-top:8px">Check the current figure on the Home Affairs student visa page before you lodge; it changes.</div>
  </div>

  <div class="card">
    <h2>Work hours <small>limit ${WORK_LIMIT} h per fortnight</small></h2>
    <div class="row"><span class="sub">Fortnight ${dLabel(fStart)} – ${dLabel(fEnd)}</span><span class="badge">${hpIcon(hTone === 'critical' ? 'critical' : hTone)} ${isBreak ? 'Course break: no limit' : `${used} / ${WORK_LIMIT} h`}</span></div>
    <div class="hp" style="margin-top:6px"><div class="status-${hTone}" style="width:${isBreak ? 100 : Math.max(2, Math.min(100, used / WORK_LIMIT * 100))}%"></div></div>
    <div class="tiny muted" style="margin-top:6px">${isBreak ? '' : used > WORK_LIMIT ? `⛔ ${used - WORK_LIMIT} h over the limit. This can breach visa condition 8105.` : `${WORK_LIMIT - used} h left this fortnight`} · earnings ${r ? money(used * sy.hourly * r) : 'A$' + (used * sy.hourly).toFixed(0)}</div>
    <div class="inline-inputs" style="margin-top:10px">
      <div><label class="field">Date</label><input class="input" type="date" id="hDate" value="${S.ui.hoursDate || today()}" data-input="hoursDate"></div>
      <div><label class="field">Hours</label><input class="input num" type="number" step="0.25" inputmode="decimal" id="hHours" placeholder="4"></div>
    </div>
    <div class="btn-row" style="margin-top:8px"><button class="btn primary" data-action="add-hours">Log hours</button>
      <label class="switch" style="padding:0 6px"><span class="tiny">Official course break</span><input type="checkbox" data-action="toggle-break" ${isBreak ? 'checked' : ''}></label></div>
    ${inF.length ? `<table class="mini" style="margin-top:10px">${inF.sort((a, b) => a.date.localeCompare(b.date)).map(h => `<tr><td>${dLabel(h.date)}</td><td class="r">${h.hours} h</td><td class="r"><button class="btn small" data-action="del-hours" data-id="${h.id}">✕</button></td></tr>`).join('')}</table>` : ''}
    <div class="inline-inputs" style="margin-top:4px">
      <div><label class="field">Hourly pay (A$)</label><input class="input num" type="number" step="0.5" data-sy="hourly" value="${sy.hourly}"></div>
      <div><label class="field">First Monday of a fortnight</label><input class="input" type="date" data-sy="anchor" value="${sy.anchor}"></div>
    </div>
    <div class="tiny muted" style="margin-top:8px">A fortnight is 14 days starting on a Monday. The limit applies once your course starts, across all jobs.</div>
  </div>

  <div class="card">
    <h2>Education loan & EMI <small>enter your sanction terms</small></h2>
    <div class="inline-inputs">
      <div><label class="field">Loan amount (₹)</label><input class="input num" type="number" data-loan="principal" value="${L.principal}"></div>
      <div><label class="field">Interest rate (% a year)</label><input class="input num" type="number" step="0.05" data-loan="rate" value="${L.rate}"></div>
      <div><label class="field">Moratorium (months)</label><input class="input num" type="number" data-loan="moratorium" value="${L.moratorium}"></div>
      <div><label class="field">Repay over (months)</label><input class="input num" type="number" data-loan="tenure" value="${L.tenure}"></div>
    </div>
    <label class="switch"><span>I'll pay the interest during the moratorium</span><input type="checkbox" data-loan="payDuring" ${L.payDuring ? 'checked' : ''}></label>
    <div class="grid2" style="margin-top:6px">
      <div class="stat"><div class="k">EMI after moratorium</div><div class="v">${money(lp.emi, { stacked: true })}</div></div>
      <div class="stat"><div class="k">${L.payDuring ? 'Interest each month while studying' : 'Interest added while studying'}</div><div class="v">${money(L.payDuring ? lp.monthlyInterestDuring : lp.moratInterest, { stacked: true })}</div></div>
      <div class="stat"><div class="k">Total interest</div><div class="v">${money(lp.totalInterest, { stacked: true })}</div></div>
      <div class="stat"><div class="k">Total repaid</div><div class="v">${money(lp.totalPaid, { stacked: true })}</div></div>
    </div>
    <div class="tiny muted" style="margin-top:8px">Uses simple interest during the moratorium (course + grace period) and a standard reducing-balance EMI after. The defaults are placeholders: use the rate and terms on your SBI sanction letter.</div>
  </div>`;
}

// ---------------- charts ----------------
function afterRender() {
  document.querySelectorAll('.chips').forEach(row => {
    const on = row.querySelector('.chip.on'); if (on) row.scrollLeft = on.offsetLeft - row.clientWidth / 2 + on.clientWidth / 2;
    syncChipNav(row);
    row.addEventListener('scroll', () => syncChipNav(row), { passive: true });
    // let a mouse wheel scroll the row sideways on desktop
    row.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && row.scrollWidth > row.clientWidth) { e.preventDefault(); row.scrollLeft += e.deltaY; } }, { passive: false });
  });
  const mc = $('#monthChart');
  if (mc) mc.innerHTML = barChart(D.months.map(k => ({ key: k, label: mLabel(k), v: Math.max(0, D.mon[k].spend), tip: `<b>${mLabel(k, true)}</b><br>Spent ${inr(D.mon[k].spend)} ${aud(D.mon[k].spend) ? '(' + aud(D.mon[k].spend) + ')' : ''}<br>Income ${inr(D.mon[k].income)}` })), S.ui.month);
  const fc = $('#fxChart');
  if (fc) { const st = fxStats(S.fx.history, rate(), S.settings.alertPct); fc.innerHTML = st.series.length > 1 ? lineChart(st.series.slice(-30)) : '<div class="tiny muted">The chart fills in as rates are collected.</div>'; }
  const drop = $('#drop');
  if (drop) {
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); importFiles([...e.dataTransfer.files]); });
  }
}
const kfmt = v => v >= 1e5 ? (v / 1e5).toFixed(v >= 1e6 ? 0 : 1) + 'L' : v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v);
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v || 1))); return Math.ceil(v / p / 2) * 2 * p || 1; }
function barChart(data, selected) {
  const W = 340, H = 170, pl = 34, pb = 22, pt = 18;
  const max = niceMax(Math.max(...data.map(d => d.v), 1));
  const bw = (W - pl) / data.length;
  const y = v => H - pb - (v / max) * (H - pb - pt);
  let g = '';
  for (let i = 0; i <= 2; i++) { const v = max * i / 2; g += `<line class="grid" x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${i ? '₹' + kfmt(v) : '0'}</text>`; }
  const bars = data.map((d, i) => {
    const x = pl + i * bw + bw * 0.2, w = bw * 0.6, top = y(d.v), h = Math.max(0, H - pb - top);
    const r = Math.min(4, w / 2, h);
    const path = h > 0 ? `M${x},${H - pb} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - pb} Z` : '';
    return `<g data-tip="${esc(d.tip)}" data-action="month" data-m="${d.key}" style="cursor:pointer">
      <path class="bar ${d.key === selected ? '' : 'dim'}" d="${path}"/>
      ${d.key === selected ? `<text class="lbl" x="${x + w / 2}" y="${top - 5}" text-anchor="middle">₹${kfmt(d.v)}</text>` : ''}
      <rect class="hit" x="${pl + i * bw}" y="${pt - 10}" width="${bw}" height="${H - pt + 10}"/>
      <text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${d.label.split(' ')[0]}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly spending bar chart">${g}<line class="base" x1="${pl}" x2="${W}" y1="${H - pb}" y2="${H - pb}"/>${bars}</svg>`;
}
function lineChart(series) {
  const W = 340, H = 150, pl = 40, pb = 22, pt = 16, pr = 8;
  const vals = series.map(p => p.rate);
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.25 || 0.3; lo -= pad; hi += pad;
  const x = i => pl + (i / (series.length - 1)) * (W - pl - pr);
  const y = v => H - pb - ((v - lo) / (hi - lo)) * (H - pb - pt);
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`);
  const iMin = vals.indexOf(Math.min(...vals)), iMax = vals.indexOf(Math.max(...vals));
  let g = '';
  for (let i = 0; i <= 2; i++) { const v = lo + (hi - lo) * (i / 2); g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`; }
  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1].map(i => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}">${dLabel(series[i].date)}</text>`).join('');
  const mark = (i, label, dy) => `<circle class="dot" cx="${x(i)}" cy="${y(vals[i])}" r="4.5"/><text class="lbl" x="${Math.min(W - pr - 30, Math.max(pl + 20, x(i)))}" y="${y(vals[i]) + dy}" text-anchor="middle">${label} ${vals[i].toFixed(2)}</text>`;
  const hits = series.map((p, i) => `<rect class="hit" x="${x(i) - (W - pl) / series.length / 2}" y="${pt}" width="${(W - pl) / series.length}" height="${H - pt - pb}" data-tip="<b>${dLabel(p.date)}</b><br>A$1 = ₹${p.rate.toFixed(2)}" data-xh="${x(i)}"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="AUD to INR rate, last ${series.length} days">${g}
    <path class="area" d="M${pts[0]} L${pts.join(' L')} L${x(series.length - 1)},${H - pb} L${pl},${H - pb} Z"/>
    <polyline class="line" points="${pts.join(' ')}"/>${mark(iMin, 'Low', 16)}${mark(iMax, 'High', -9)}${ticks}
    <line class="xhair" id="xh" x1="0" x2="0" y1="${pt}" y2="${H - pb}" style="display:none"/>${hits}</svg>`;
}

// tooltips (hover on desktop, tap on phone)
const tip = $('#tip');
function showTip(el, ev) {
  const html = el.getAttribute('data-tip'); if (!html) return;
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 12, yv = ev.clientY - r.height - 12;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 12;
  if (yv < 8) yv = ev.clientY + 16;
  tip.style.left = x + 'px'; tip.style.top = yv + 'px';
  const xh = el.closest('svg')?.querySelector('#xh');
  if (xh && el.dataset.xh) { xh.style.display = ''; xh.setAttribute('x1', el.dataset.xh); xh.setAttribute('x2', el.dataset.xh); }
}
document.addEventListener('pointermove', e => { const el = e.target.closest?.('[data-tip]'); if (el) showTip(el, e); else { tip.hidden = true; const xh = document.querySelector('#xh'); if (xh) xh.style.display = 'none'; } });
document.addEventListener('pointerdown', e => { const el = e.target.closest?.('[data-tip]'); if (el) showTip(el, e); });

// ---------------- sheets ----------------
function openSheet(html) { const s = $('#sheet'); s.querySelector('.sheet-body').innerHTML = html; s.hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }

function txnSheet(id) {
  const t = S.txns.find(x => x.id === id); if (!t) return;
  const same = S.txns.filter(x => x.payee === t.payee && (x.debit > 0) === (t.debit > 0)).length;
  const cats = E.CATEGORIES.filter(c => (t.debit > 0 ? !['salary', 'interest', 'refund', 'income_other', 'bigtransfer_in'].includes(c.id) : ['salary', 'interest', 'refund', 'income_other', 'bigtransfer_in', 'transfer'].includes(c.id)));
  const isFixedPayee = S.fixedOverrides[t.payee] ?? t.fixed;
  openSheet(`
    <h2>${esc(E.payeeName(t))}</h2>
    <div class="sub">${dLabel(t.date)} ${t.date.slice(0, 4)} · ${t.bank}${t.acct ? ' ••' + t.acct : ''} · balance after ${inr(t.balance, 2)}</div>
    <div class="hero-num num" style="margin-top:10px;font-size:28px">${t.credit ? '+' + inr(t.credit, 2) : '−' + inr(t.debit, 2)}</div><div class="hero-aud">${aud(t.credit || t.debit)}</div>
    <h3>Category</h3>
    <div class="catgrid">${cats.map(c => `<button class="${c.id === t.cat ? 'on' : ''}" data-action="pick-cat" data-c="${c.id}"><span>${c.icon}</span>${c.label}</button>`).join('')}</div>
    <label class="switch"><span>Apply to all ${same} ${t.debit ? 'payments to' : 'credits from'} this payee, now and in future</span><input type="checkbox" id="applyAll" checked></label>
    ${t.debit ? `<label class="switch"><span>Fixed monthly cost</span><input type="checkbox" id="fixedToggle" ${isFixedPayee ? 'checked' : ''}></label>` : ''}
    <h3>Statement text</h3><div class="raw">${esc([t.type, t.desc, t.ref].filter(Boolean).join(' · '))}</div>
    <div class="btn-row" style="margin-top:14px"><button class="btn primary" data-action="save-txn" data-id="${esc(t.id)}">Save</button><button class="btn" data-action="close-sheet">Cancel</button></div>`);
  S.ui.pickCat = t.cat;
}

function settingsSheet() {
  const sts = S.statements;
  openSheet(`
    <h2>Settings & data</h2>
    <h3>Statements imported</h3>
    ${sts.length ? sts.map(s => `<div class="card" style="margin:8px 0;padding:12px"><div class="row"><b>${s.bank}${s.acct ? ' ••' + s.acct : ''}</b><span class="tiny muted">${dLabel(s.from)} – ${dLabel(s.to)} ${s.to.slice(0, 4)}</span></div>
      <ul class="checks tiny" style="padding-left:18px;margin:6px 0 0">${checkList(s.checks).join('')}</ul></div>`).join('') : '<div class="sub">None yet.</div>'}
    <button class="btn block" data-action="pick-pdf">＋ Add statements</button>
    <h3>Your name on statements</h3>
    <div class="sub">Used to spot transfers between your own accounts.</div>
    <input class="input" id="holderNames" value="${esc(S.settings.holderNames.join(', '))}" placeholder="e.g. RAHUL VIJAY SHARMA">
    <h3>Display</h3>
    <label class="switch"><span>Show AUD first (Sydney mode)</span><input type="checkbox" data-action="toggle-primary" ${S.settings.primary === 'AUD' ? 'checked' : ''}></label>
    <label class="switch"><span>Theme</span><select class="input" style="width:auto" data-action="theme">${['auto', 'light', 'dark'].map(t => `<option ${S.settings.theme === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="field">Count one transfer to someone else above this as "large transfer" and leave it out of spending (₹)</label>
    <input class="input num" type="number" id="bigTransfer" value="${S.settings.bigTransfer}">
    <h3>Backup</h3>
    <div class="sub">Everything lives in this browser only. Export a backup before clearing your browser or switching phones.</div>
    <div class="btn-row" style="margin-top:8px"><button class="btn" data-action="export">⬇️ Export backup</button><button class="btn" data-action="import-json">⬆️ Restore backup</button></div>
    <div class="btn-row" style="margin-top:8px"><button class="btn danger" data-action="clear-data">🗑️ Delete all data</button><button class="btn" data-action="load-demo">Load demo data</button>${window.RUPEEROO_SEED ? '<button class="btn" data-action="reload-seed">Reload my statements</button>' : ''}</div>
    <div class="btn-row" style="margin-top:16px"><button class="btn primary" data-action="save-settings">Done</button></div>
    <div class="tiny muted" style="margin-top:14px">RupeeRoo reads PDFs with Mozilla pdf.js on your device. The page is only allowed to contact the exchange-rate services (Coinbase, frankfurter.dev, open.er-api.com).</div>`);
}
function checkList(c) {
  const out = [`<li>${c.count} transactions (${c.drCount} debits, ${c.crCount} credits)</li>`];
  out.push(c.balanceBreaks ? `<li class="bad">${c.balanceBreaks} rows don't match the running balance</li>` : `<li class="ok">✓ Every row matches the running balance</li>`);
  if (c.summary) out.push(c.summaryMatch ? `<li class="ok">✓ Matches the bank's own summary: debits ${inr(c.summary.totalDebit, 2)}, credits ${inr(c.summary.totalCredit, 2)}</li>` : `<li class="bad">Bank summary differs: ${c.summary.drCount}/${c.summary.crCount} rows, ${inr(c.summary.totalDebit, 2)} / ${inr(c.summary.totalCredit, 2)}</li>`);
  if (c.dupes) out.push(`<li>${c.dupes} rows were already imported and skipped</li>`);
  return out;
}

// ---------------- import ----------------
let pdfjs;
async function getPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../vendor/pdf.min.js');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js', import.meta.url).href;
  return pdfjs;
}
function askPassword(name, wrong) {
  return new Promise(res => {
    openSheet(`<h2>🔐 ${esc(name)} is password protected</h2><div class="sub">${wrong ? '<b class="bad">That password didn’t work.</b> ' : ''}SBI usually uses the last 5 digits of your mobile number + your date of birth (DDMMYY). The password stays on this device.</div>
      <input class="input" type="password" id="pdfPw" autocomplete="off" style="margin-top:10px"><div class="btn-row" style="margin-top:10px"><button class="btn primary" id="pwOk">Open</button><button class="btn" id="pwCancel">Skip file</button></div>`);
    $('#pwOk').onclick = () => { const v = $('#pdfPw').value; closeSheet(); res(v); };
    $('#pwCancel').onclick = () => { closeSheet(); res(null); };
    setTimeout(() => $('#pdfPw')?.focus(), 50);
  });
}
async function importFiles(files) {
  files = files.filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (!files.length) return;
  if (S.demo) { const keep = { settings: S.settings, fx: S.fx, sydney: S.sydney }; S = deepMerge(defaults(), keep); S.demo = false; }
  const lib = await getPdfjs();
  const results = [];
  for (const f of files) {
    toast(`Reading ${f.name}…`, 60000);
    const buf = new Uint8Array(await f.arrayBuffer());
    let pages, pw, wrong = false;
    for (;;) {
      try { pages = await extractPages(lib, buf.slice(), pw); break; }
      catch (e) {
        if (e?.name === 'PasswordException') { pw = await askPassword(f.name, wrong); wrong = true; if (pw == null) break; continue; }
        results.push(`❌ ${f.name}: couldn't read this PDF (${e.message || e}).`); break;
      }
    }
    if (!pages) continue;
    const bank = detectBank(pages);
    if (!bank) { results.push(`❌ ${f.name}: not an SBI or IndusInd statement, or it's a scanned image.`); continue; }
    const r = parseStatement(pages, bank);
    if (!r.txns.length) { results.push(`❌ ${f.name}: found no transactions. The layout may have changed.`); continue; }
    const existing = new Set(S.txns.map(t => t.id));
    let dupes = 0;
    for (const t of r.txns) {
      const id = [bank, r.acct, t.date, t.debit, t.credit, t.balance].join('|');
      if (existing.has(id)) { dupes++; continue; }
      existing.add(id);
      S.txns.push({ id, bank, acct: r.acct, date: t.date, type: t.type, desc: t.desc, ref: t.ref, debit: t.debit, credit: t.credit, balance: t.balance, seq: t.seq });
    }
    if (r.holder && !S.settings.holderNames.some(n => n.toUpperCase() === r.holder.toUpperCase())) S.settings.holderNames.push(r.holder);
    r.checks.dupes = dupes;
    S.statements.push({ bank, acct: r.acct, from: r.checks.from, to: r.checks.to, checks: r.checks, importedAt: today() });
    results.push(`✅ ${bank}${r.acct ? ' ••' + r.acct : ''}: ${r.txns.length - dupes} new rows${r.checks.balanceBreaks ? `, ⚠️ ${r.checks.balanceBreaks} balance mismatches` : ', all balances check out'}${r.checks.summaryMatch ? ', matches bank totals' : ''}.`);
  }
  $('#toast').hidden = true;
  S.ui.month = null;
  derive(); save(); render();
  openSheet(`<h2>Import finished</h2><div class="stack" style="margin-top:8px">${results.map(r => `<div class="sub">${esc(r)}</div>`).join('')}</div>
    <div class="sub" style="margin-top:10px">Tip: tap any transaction to fix its category. RupeeRoo will remember it for that payee.</div>
    <div class="btn-row" style="margin-top:12px"><button class="btn primary" data-action="close-sheet">See my dashboard</button></div>`);
}

// ---------------- FX ----------------
let fxBusy = false;
async function refreshFx(manualClick) {
  if (fxBusy) return; fxBusy = true;
  const needHistory = manualClick || Date.now() - (S.fx.historyAt || 0) > 3 * 3600e3;
  const res = await fetchRatesLive(needHistory);
  fxBusy = false;
  if (res.history && Object.keys(res.history).length) { Object.assign(S.fx.history, res.history); S.fx.historyAt = Date.now(); }
  if (res.ok) {
    S.fx.last = { rate: res.rate, date: res.date, source: res.source, fetchedAt: Date.now(), live: res.live };
    S.fx.error = null;
    // today's range from the live readings seen while the app is open
    const t = today(), d = S.fx.day?.date === t ? S.fx.day : { date: t, low: res.rate, high: res.rate, open: res.rate };
    d.low = Math.min(d.low, res.rate); d.high = Math.max(d.high, res.rate); S.fx.day = d;
  } else {
    S.fx.error = ' ' + res.error;
  }
  const keys = Object.keys(S.fx.history).sort(); keys.slice(0, Math.max(0, keys.length - 120)).forEach(k => delete S.fx.history[k]);
  save(); checkFxAlerts();
  // re-render only what depends on the rate, so typing in a form is never interrupted
  const busy = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!busy && $('#sheet').hidden) render(); else updateFxPill();
  if (manualClick) toast(res.ok ? `Rate updated: A$1 = ₹${res.rate.toFixed(2)}` : 'Rate service unreachable. You can enter the rate yourself.');
}
function updateFxPill() { const r = rate(); $('#fxPill').innerHTML = r ? `${S.fx.last?.live && !S.fx.manual ? '<span class="live-dot" aria-label="live"></span>' : ''}A$1 = ₹${r.toFixed(2)}` : 'A$ rate: set'; }
function checkFxAlerts() {
  const st = fxStats(S.fx.history, rate(), S.settings.alertPct);
  if (!S.settings.notify || !st.alerts.length) return;
  for (const a of st.alerts.filter(a => a.key)) {
    const k = a.key + today();
    if (S.fx.notified[k]) continue;
    S.fx.notified[k] = 1; save();
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('RupeeRoo · ' + a.title, { body: a.plain, tag: a.key }); } catch (e) { /* not allowed here */ }
    toast('🔔 ' + a.title, 5000);
  }
}

// ---------------- events ----------------
document.addEventListener('click', async e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { S.ui.tab = tab.dataset.tab; save(); render(); scrollTo(0, 0); return; }
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'pick-pdf': e.preventDefault(); e.stopPropagation(); closeSheet(); $('#pdfInput').click(); break;
    case 'load-demo': { const keep = { fx: S.fx, sydney: S.sydney }; S = deepMerge(defaults(), keep); const d = makeDemo(); S.txns = d.txns; S.statements = d.statements; S.settings.holderNames = [d.holder]; S.demo = true; derive(); save(); closeSheet(); render(); toast('Demo data loaded'); break; }
    case 'clear-data': openSheet(`<h2>Delete everything?</h2><div class="sub">This removes your transactions, categories and settings from this browser. Export a backup first if you might need it.</div><div class="btn-row" style="margin-top:12px"><button class="btn danger" data-action="confirm-clear">Delete</button><button class="btn" data-action="close-sheet">Keep</button></div>`); break;
    case 'reload-seed': applySeed(true); derive(); closeSheet(); render(); toast('Your statements are loaded'); break;
    case 'confirm-clear': { const keep = { fx: { history: S.fx.history, last: S.fx.last }, seedApplied: S.seedApplied }; S = deepMerge(defaults(), keep); derive(); save(); closeSheet(); render(); toast('All data deleted'); break; }
    case 'close-sheet': closeSheet(); break;
    case 'open-settings': settingsSheet(); break;
    case 'chips-scroll': { const row = el.parentElement.querySelector('.chips'); row.scrollBy({ left: +el.dataset.dir * row.clientWidth * 0.7, behavior: 'smooth' }); break; }
    case 'month': S.ui.month = el.dataset.m; save(); render(); break;
    case 'cat': S.ui.catFilter = el.dataset.c || null; save(); render(); document.querySelector('.search')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
    case 'txn': txnSheet(el.dataset.id); break;
    case 'pick-cat': S.ui.pickCat = el.dataset.c; el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); break;
    case 'save-txn': {
      const t = S.txns.find(x => x.id === el.dataset.id);
      const all = $('#applyAll')?.checked;
      if (S.ui.pickCat && S.ui.pickCat !== t.cat) {
        if (all) { S.rules[t.payee] = { cat: S.ui.pickCat, dir: t.debit > 0 ? 'D' : 'C' }; S.txns.filter(x => x.payee === t.payee).forEach(x => delete S.txnOverrides[x.id]); }
        else S.txnOverrides[t.id] = S.ui.pickCat;
      }
      const ft = $('#fixedToggle');
      if (ft && ft.checked !== t.fixed) S.fixedOverrides[t.payee] = ft.checked;
      derive(); save(); closeSheet(); render(); toast('Saved'); break;
    }
    case 'unfix': el.dataset.k.split(',').forEach(k => (S.fixedOverrides[k] = false)); derive(); save(); render(); toast('Removed from fixed costs'); break;
    case 'save-settings': {
      const hn = $('#holderNames')?.value; if (hn != null) S.settings.holderNames = hn.split(',').map(s => s.trim()).filter(Boolean);
      const bt = +$('#bigTransfer')?.value; if (bt > 0) S.settings.bigTransfer = bt;
      derive(); save(); closeSheet(); render(); break;
    }
    case 'toggle-primary': S.settings.primary = el.checked ? 'AUD' : 'INR'; save(); render(); break;
    case 'export': exportData(); break;
    case 'import-json': $('#jsonInput').click(); break;
    case 'fx-refresh': refreshFx(true); break;
    case 'fx-notify': {
      if (S.settings.notify) { S.settings.notify = false; save(); render(); break; }
      S.settings.notify = true;
      save(); render();
      try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch (err) { /* blocked */ } toast('Alerts on. They appear while RupeeRoo is open.'); checkFxAlerts(); break;
    }
    case 'fx-manual': { const v = parseFloat($('#manualRate').value); if (v > 20 && v < 200) { S.fx.manual = { rate: v, date: today() }; S.fx.history[today()] = v; save(); derive(); render(); toast('Using your rate'); } else toast('Enter a rate like 55.40 (rupees for 1 AUD)'); break; }
    case 'fx-manual-clear': S.fx.manual = null; save(); render(); break;
    case 'add-hours': { const d = $('#hDate').value, h = parseFloat($('#hHours').value); if (d && h > 0 && h <= 24) { S.sydney.hours.push({ id: Date.now().toString(36), date: d, hours: h }); S.ui.hoursDate = d; save(); render(); } else toast('Enter the date and hours worked'); break; }
    case 'del-hours': S.sydney.hours = S.sydney.hours.filter(h => h.id !== el.dataset.id); save(); render(); break;
    case 'toggle-break': { const fs = E.fortnightStart(S.ui.hoursDate || today(), S.sydney.anchor); if (el.checked) S.sydney.breaks[fs] = true; else delete S.sydney.breaks[fs]; save(); render(); break; }
  }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.setting) { const v = el.value === '' ? null : +el.value; S.settings[el.dataset.setting] = el.dataset.setting === 'incomeOverride' ? v : (v ?? 0); derive(); save(); render(); }
  else if (el.dataset.sy) { S.sydney[el.dataset.sy] = el.type === 'number' ? +el.value : el.value; save(); render(); }
  else if (el.dataset.loan) { S.sydney.loan[el.dataset.loan] = el.type === 'checkbox' ? el.checked : +el.value; save(); render(); }
  else if (el.dataset.input === 'hoursDate') { S.ui.hoursDate = el.value; save(); render(); }
  else if (el.dataset.action === 'theme') { S.settings.theme = el.value; applyTheme(); save(); }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.input === 'q') { S.ui.q = el.value; const pos = el.selectionStart; render(); const s = document.querySelector('.search'); s.focus(); s.setSelectionRange(pos, pos); }
  if (el.dataset.conv) {
    const r = rate(); if (!r) return;
    if (el.dataset.conv === 'inr') { S.ui.convInr = +el.value; document.querySelector('[data-conv="aud"]').value = (+el.value / r).toFixed(2); }
    else { S.ui.convInr = +el.value * r; document.querySelector('[data-conv="inr"]').value = Math.round(+el.value * r); }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
$('#pdfInput').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });
$('#jsonInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const data = JSON.parse(await f.text()); if (!data.txns) throw new Error('not a RupeeRoo backup'); S = deepMerge(defaults(), data); derive(); save(); closeSheet(); render(); toast('Backup restored'); }
  catch (err) { toast('Could not restore: ' + err.message); }
});
function exportData() {
  const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
  try {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `rupeeroo-backup-${today()}.json`; document.body.appendChild(a); a.click(); a.remove();
    toast('Backup file saved');
  } catch (e) {
    navigator.clipboard?.writeText(JSON.stringify(S)).then(() => toast('Downloads are blocked here, so the backup was copied to your clipboard'), () => toast('Export is blocked in this viewer'));
  }
}
function applyTheme() {
  const t = S.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}
window.addEventListener('beforeunload', save);

// ---------------- boot ----------------
applyTheme();
derive();
render();
refreshFx(false);
setInterval(() => { if (!document.hidden) refreshFx(false); }, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (S.fx.last?.fetchedAt || 0) > 60 * 1000) refreshFx(false); });
