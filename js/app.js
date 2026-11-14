import { extractPages, parseStatement, detectBank, counterparty, SUPPORTED_BANKS } from './parser.js?v=20261113j';
import * as E from './engine.js?v=20261113j';
import { fetchRatesLive, fxStats } from './fx.js?v=20261113j';
import { makeDemo } from './demo.js?v=20261113j';
import { lookupMany, webSearchUrl } from './lookup.js?v=20261113j';
import * as V from './visa.js?v=20261113j';
import { localSuggest, claudeSuggest, claudeMaybeAvailable, getApiKey, setApiKey } from './assist.js?v=20261113j';

const VISA_LIVING_AUD = 29710; // Home Affairs 12-month living cost for a primary student (checked Nov 2026)
const WORK_LIMIT = 48;         // hours per fortnight while the course is in session (condition 8105)
const STORE = 'rupeeroo.v1';

// ---------------- state ----------------
const defaults = () => ({
  txns: [], statements: [], rules: {}, notes: {}, txnOverrides: {}, fixedOverrides: {}, demo: false,
  lookups: {},
  settings: { city: 'Nagpur', savingsGoal: 10000, incomeOverride: null, oneOff: 15000, bigTransfer: 50000, holderNames: [], primary: 'INR', alertPct: 0.25, notify: false, theme: 'auto' },
  fx: { history: {}, last: null, manual: null, notified: {} },
  sydney: { extraFunds: 0, arrival: '2027-02-01', courseStart: '2027-02-15', research: false, sessions: null, jobs: [{ id: 'j1', name: 'Casual job', rate: 33.05 }], shifts: [], hours: [], loan: { principal: 4000000, rate: 10, moratorium: 30, tenure: 180, payDuring: false } },
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
  try { const raw = localStorage.getItem(STORE); if (raw) return repair(deepMerge(defaults(), JSON.parse(raw))); } catch (e) { /* storage unavailable */ }
  return defaults();
}
/** Self-repair: one row per bank + date + amounts + running balance. A copy missing its account
 *  number (read by an older version) gives way to the one that has it. */
function repair(st) {
  if (!Array.isArray(st.txns)) return st;
  const acctByBank = {};
  st.txns.forEach(t => { if (t.acct) (acctByBank[t.bank] ??= new Set()).add(t.acct); });
  const best = new Map();
  for (const t of st.txns) {
    const k = [t.bank, t.date, t.debit, t.credit, t.balance].join('|');
    const cur = best.get(k);
    if (!cur || (!cur.acct && t.acct)) best.set(k, t);
  }
  if (best.size !== st.txns.length) {
    const before = st.txns.length;
    st.txns = st.txns.filter(t => best.get([t.bank, t.date, t.debit, t.credit, t.balance].join('|')) === t);
    st.repairedRows = (st.repairedRows || 0) + before - st.txns.length;
  }
  for (const t of st.txns) if (!t.acct && acctByBank[t.bank]?.size === 1) { t.acct = [...acctByBank[t.bank]][0]; t.id = [t.bank, t.acct, t.date, t.debit, t.credit, t.balance].join('|'); }
  for (const x of st.statements || []) if (!x.acct && acctByBank[x.bank]?.size === 1) x.acct = [...acctByBank[x.bank]][0];
  return st;
}
let savedAt = 0;
function save() { try { savedAt = Date.now(); S.savedAt = savedAt; localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }
// Another tab saved: take its copy instead of overwriting it later with ours.
window.addEventListener('storage', e => {
  if (e.key !== STORE || !e.newValue) return;
  try { const incoming = JSON.parse(e.newValue); if ((incoming.savedAt || 0) < savedAt) return; S = repair(deepMerge(defaults(), incoming)); derive(); render(); } catch (err) { /* ignore */ }
});
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
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // local date, not UTC
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
  const bills = recurring.filter(r => r.cat !== 'invest');
  const fixedTotal = bills.reduce((s, r) => s + r.amount, 0);
  const sip = E.sipPlan(tx, today());
  const incomeAuto = E.incomeEstimate(tx);
  const income = S.settings.incomeOverride ?? incomeAuto;
  const fc = E.forecast(tx, { oneOff: S.settings.oneOff });
  const totalIncome = tx.filter(t => E.CAT[t.cat]?.kind === 'income').reduce((s, t) => s + t.credit, 0);
  const totalSpend = Object.values(mon).reduce((s, m) => s + m.spend, 0);
  const saved = Math.max(0, totalIncome - totalSpend);
  const balances = latestBalances();
  const suspense = suspenseGroups(tx);
  D = { recurring, bills, mon, months, dataEnd, fixedTotal, sip, sipTotal: sip.monthly, income, incomeAuto, fc, saved, balances, suspense };
}

/** Payees still in Suspense, biggest first, with what we know about each. */
function suspenseGroups(tx) {
  const g = {};
  for (const t of tx) {
    if (t.cat !== 'suspense' && t.cat !== 'suspense_in') continue;
    const dir = t.debit > 0 ? 'D' : 'C';
    const k = t.payee + '|' + dir;
    const c = g[k] ??= { key: k, payee: t.payee, dir, name: E.payeeName(t), vpa: counterpartyVpa(t), n: 0, amt: 0, last: t.date, shop: E.isShopLike(t), person: E.isPersonLike(t), family: E.surnameHint(t, S.settings.holderNames), sample: t };
    c.n++; c.amt += t.debit || t.credit; if (t.date > c.last) c.last = t.date;
  }
  return Object.values(g).sort((a, b) => b.amt - a.amt);
}
function counterpartyVpa(t) { return (counterparty(t).vpa || '').slice(0, 30); }

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
  const sts = E.safeToSpend({ income: D.income, fixedTotal: D.fixedTotal + D.sipTotal, savingsGoal: S.settings.savingsGoal, spentVariable: spentVar, daysLeft: dim - day });
  const hp = E.health(sts.monthlyAllowance, spentVar, day, dim);
  const monthOver = day >= dim;
  return { mo, dim, day, spentVar, oneOffs, sts, hp, monthOver, isLatest };
}

// ---------------- rendering ----------------
function render() {
  setTimeout(checkAchievements, 600);
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.ui.tab));
  updateFxPill();
  $('#banner').innerHTML = S.demo ? `<div class="demo-banner"><span>You're looking at <b>demo data</b>.</span><button class="btn small" data-action="clear-data">Use my own</button></div>` : '';
  const v = $('#view');
  if (!S.txns.length && !['fx', 'sydney'].includes(S.ui.tab)) { v.innerHTML = viewEmpty(); return; }
  // rows can arrive mid-import (or from another tab) before derive() has run
  if (S.txns.length && (!D || !S.ui.month || !D.mon?.[S.ui.month])) derive();
  const view = ({ home: viewHome, spend: viewSpend, plan: viewPlan, fx: viewFx, sydney: viewSydney })[S.ui.tab] || viewHome;
  try { v.innerHTML = view(); }
  catch (err) {
    console.error(err);
    v.innerHTML = `<div class="card"><h2>Something went wrong on this screen</h2><div class="sub">Your data is safe. Try another tab, or reload the page.</div><div class="tiny muted" style="margin-top:8px">${esc(String(err && err.message || err))}</div></div>`;
    return;
  }
  afterRender();
}

function viewEmpty() {
  return `
  <div class="card" style="text-align:center">
    <div class="drop" id="drop" data-action="pick-pdf">
      <div class="big"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg></div>
      <div style="font-weight:650;font-size:16px;margin-top:6px">Add your bank statements</div>
      <div class="sub" style="margin-top:4px">PDF statements from <b>SBI, HDFC, ICICI, Axis, Kotak, IDBI, IndusInd, PNB, Bank of Baroda, Canara, Union</b> and most other banks. Pick several at once.</div>
      <button class="btn primary" style="margin-top:14px" data-action="pick-pdf">Choose PDF files</button>
    </div>
    <div class="privacy"><span>Statements are read <b>on this device</b> and saved only in this browser. Nothing is uploaded. The only network call is for exchange rates.</span></div>
    <button class="btn block" style="margin-top:12px" data-action="load-demo">Try it with demo data</button>
  </div>
  ${S.statements.length ? '' : `<div class="card"><h2>How it works</h2><ol class="sub" style="padding-left:18px;margin:0">
    <li>Download a PDF account statement from your bank's app or net banking (not a scanned photo).</li>
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
  return `<div class="coverage">${short.map(b => `${b} statement ends ${dLabel(last[b])}`).join(', ')}, so ${mLabel(m, true)} is missing some ${short.join(' and ')} spending. <a href="#" data-action="pick-pdf">Add a newer statement</a>.</div>`;
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
  const big = n => fmtPlain(n);
  // 1. came in (own-account transfers already left out)
  const cameIn = mo.income;
  // 2. left: latest running balance of every account on or before the month's end
  const left = balancesAt(m);
  const dates = [...new Set(left.accts.map(x => x.date))];
  const leftSub = !left.accts.length ? 'No balance yet'
    : dates.length === 1 ? `as of ${dLabel(dates[0])}${left.accts.length > 1 ? ` · ${left.accts.length} accounts` : ''}`
    : left.accts.map(x => `${x.bank}${x.acct ? ' ••' + x.acct : ''} ${dLabel(x.date)}`).join(' · ');
  // 3. SIPs on their own, 4. kept = came in − spent − SIPs (money that stayed in the account)
  const sipAmt = mo.invest;
  const sm0 = D.sip.months[m];
  const sipSub = sm0?.missed ? `${inr(sm0.missed)} bounced` : sipAmt > 0 ? 'into SIPs & investments' : 'none this month';
  const kept = mo.income - mo.spend - mo.invest;
  const keptSub = kept >= 0 ? 'not spent, still in the bank' : 'spent more than came in';
  // 4. can spend
  const can = c.sts.remaining;
  const canSub = c.monthOver ? (can < 0 ? `over budget in ${mLabel(m)}` : `left unspent in ${mLabel(m)}`)
    : can < 0 ? `over budget · ${c.dim - c.day} days left` : `${c.dim - c.day} days left${c.sts.perDay > 0 ? ` · ${fmtPlain(c.sts.perDay)} a day` : ''}`;
  const sm = D.sip.months[m];
  const notes = [];
  if (sm?.missed) notes.push(`<button class="note-row" data-tab="plan"><span class="dot dot-bad"></span><span><b>${inr(sm.missed)} of SIPs bounced</b></span><span class="chev">›</span></button>`);
  const sus = (D.suspense || []).filter(x => x.dir === 'D');
  if (sus.length) notes.push(`<button class="note-row" data-action="open-suspense"><span class="dot dot-warn"></span><span><b>${sus.length} payees to sort</b></span><span class="chev">›</span></button>`);
  const tile = (k, v, sub, neg, extra = '', id = '') => `<button class="stat ${extra}" data-action="home-detail" data-k="${id}" aria-label="${k}: see the transactions"><div class="k">${k}<span class="chev">›</span></div><div class="v num ${neg ? 'neg' : ''}">${v}</div><div class="s">${sub}</div></button>`;
  return `
  ${monthChips()}${coverageNote(m)}
  <section class="stats4">
    ${tile('Came in', big(cameIn), mLabel(m, true), false, '', 'in')}
    ${tile('Left in the bank', big(left.total), leftSub, left.total < 0, '', 'left')}
    ${tile('SIPs', big(sipAmt), sipSub, false, '', 'sip')}
    ${tile('Kept', big(kept), keptSub, kept < 0, '', 'kept')}
    ${tile('Can spend', big(can), canSub, can < 0, 'stat-key', 'can')}
  </section>
  <details class="explain home-explain"><summary>How these are worked out</summary>
    <table class="mini">
      <tr><td>Came in</td><td class="r">Salary, refunds, interest and money received. Moves between your own accounts are left out.</td></tr>
      <tr><td>Left</td><td class="r">Last balance on each account's statement, added up.</td></tr>
      <tr><td>SIPs</td><td class="r">Money that went into SIPs and other investments this month.</td></tr>
      <tr><td>Kept</td><td class="r">Came in ${inr(mo.income)} − spent ${inr(mo.spend)} − SIPs ${inr(mo.invest)}. What stayed in your account.</td></tr>
      <tr><td>Can spend</td><td class="r">Income ${inr(D.income)} − bills ${inr(D.fixedTotal)} − SIPs ${inr(D.sipTotal)} − extra savings ${inr(S.settings.savingsGoal)} − spent ${inr(c.spentVar)}</td></tr>
    </table>
  </details>
  ${notes.length ? `<section class="card flush">${notes.join('')}</section>` : ''}
  <div class="home-links"><button class="link" data-action="pick-pdf">Add statements</button><span class="muted">·</span><button class="link" data-action="open-achievements">Achievements</button></div>`;
}
/** Tap a Home number: the transactions behind it. */
function homeDetail(k) {
  const m = S.ui.month, c = monthCtx(m), mo = c.mo;
  const inMonth = S.txns.filter(t => t.date.startsWith(m));
  const byDate = (a, b) => b.date.localeCompare(a.date) || (b.seq ?? 0) - (a.seq ?? 0);
  const kind = t => E.CAT[t.cat]?.kind;
  const list = (rows, empty) => rows.length ? `<div class="stack-txn">${[...rows].sort(byDate).map(txnRow).join('')}</div>` : `<div class="sub" style="margin-top:8px">${empty}</div>`;
  const head = (title, total, sub) => `<h2>${title}</h2><div class="detail-total num">${fmtPlain(total)}</div><div class="sub">${sub}</div>`;
  let html = '';
  if (k === 'in') {
    const rows = inMonth.filter(t => kind(t) === 'income' && t.credit > 0);
    html = head('Came in', mo.income, `${rows.length} payments received in ${mLabel(m, true)} · moves between your own accounts left out`) + list(rows, 'Nothing came in this month.');
  } else if (k === 'left') {
    const left = balancesAt(m);
    html = head('Left in the bank', left.total, `Last balance on each account up to the end of ${mLabel(m, true)}`) +
      left.accts.map(a => {
        const rows = inMonth.filter(t => t.bank === a.bank && (t.acct || '') === (a.acct || ''));
        return `<details class="acct-block" ${left.accts.length === 1 ? 'open' : ''}><summary><span><b>${esc(a.bank)}${a.acct ? ' ••' + esc(a.acct) : ''}</b><span class="muted tiny"> · as of ${dLabel(a.date)}</span></span><span class="num">${fmtPlain(a.bal)}</span></summary>
          ${list(rows, `No ${esc(a.bank)} transactions in ${mLabel(m, true)}.`)}</details>`;
      }).join('');
  } else if (k === 'sip') {
    const inv = inMonth.filter(t => kind(t) === 'invest');
    const sm = D.sip.months[m];
    const ord = d => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');
    const stTxt = { paid: 'paid', partial: '<b class="bad">part bounced</b>', missed: '<b class="bad">bounced</b>', due: 'due', unknown: 'not in a statement yet' };
    const plan = sm?.rows?.length ? `<table class="mini" style="margin-top:10px">${sm.rows.map(r => `<tr><td>${esc(r.name)}${r.count > 1 ? ' ×' + r.count : ''} · ${ord(r.day)}</td><td class="r">${inr(r.amount * r.count)} · ${stTxt[r.status] || esc(r.status)}</td></tr>`).join('')}</table>` : '';
    html = head('SIPs', mo.invest, `Into SIPs & investments in ${mLabel(m, true)}${sm?.missed ? ` · ${inr(sm.missed)} bounced` : ''}`) + plan +
      `<h3>Transactions · ${inv.length}</h3>${list(inv, 'No SIPs or investments this month.')}`;
  } else if (k === 'kept') {
    const spend = inMonth.filter(t => kind(t) === 'spend');
    const inc = inMonth.filter(t => kind(t) === 'income' && t.credit > 0);
    const kept = mo.income - mo.spend - mo.invest;
    html = head('Kept', kept, kept >= 0 ? 'Money that came in and stayed in your account' : 'You spent more than came in this month') +
      `<table class="mini" style="margin-top:12px"><tr><td>Came in</td><td class="r">${inr(mo.income)}</td></tr><tr><td>Spent</td><td class="r">− ${inr(mo.spend)}</td></tr><tr><td>SIPs</td><td class="r">− ${inr(mo.invest)}</td></tr><tr><td><b>Kept</b></td><td class="r"><b>${inr(kept)}</b></td></tr></table>
       <details class="acct-block"><summary><span><b>Came in</b><span class="muted tiny"> · ${inc.length}</span></span><span class="num">${fmtPlain(mo.income)}</span></summary>${list(inc, 'Nothing came in this month.')}</details>
       <details class="acct-block"><summary><span><b>Spent</b><span class="muted tiny"> · ${spend.length}</span></span><span class="num">${fmtPlain(mo.spend)}</span></summary>${list(spend, 'No spending this month.')}</details>`;
  } else if (k === 'can') {
    const counted = inMonth.filter(t => t.debit > 0 && kind(t) === 'spend' && !t.fixed && t.debit < S.settings.oneOff);
    html = head('Can spend', c.sts.remaining, c.sts.remaining < 0 ? `Over budget by ${fmtPlain(-c.sts.remaining)}${c.monthOver ? ` in ${mLabel(m, true)}` : ''}` : c.monthOver ? `Left unspent in ${mLabel(m, true)}` : `${c.dim - c.day} days left · ${fmtPlain(Math.max(0, c.sts.perDay))} a day`) +
      `<table class="mini" style="margin-top:12px"><tr><td>Monthly income</td><td class="r">${inr(D.income)}</td></tr><tr><td>Fixed bills</td><td class="r">− ${inr(D.fixedTotal)}</td></tr><tr><td>SIPs</td><td class="r">− ${inr(D.sipTotal)}</td></tr><tr><td>Extra savings</td><td class="r">− ${inr(S.settings.savingsGoal)}</td></tr><tr><td><b>For everyday spending</b></td><td class="r"><b>${inr(c.sts.monthlyAllowance)}</b></td></tr><tr><td>Spent so far (below)</td><td class="r">− ${inr(c.spentVar)}</td></tr></table>
       <h3>Everyday spending counted · ${counted.length}</h3>${list(counted, 'Nothing spent yet this month.')}
       ${c.oneOffs.length ? `<div class="tiny muted" style="margin-top:8px">Big one-offs (over ${inr(S.settings.oneOff)}) and fixed bills aren't counted here.</div>` : ''}`;
  }
  openSheet(html + `<div class="btn-row" style="margin-top:14px"><button class="btn" data-action="close-sheet">Close</button></div>`, 'detail:' + k);
}

/** Each account's running balance at the end of month m (or the last row before it). */
function balancesAt(m) {
  const end = m + '-31';
  const by = new Map();
  S.txns.forEach((t, i) => { if (t.date <= end) { const k = t.bank + '|' + (t.acct || ''); (by.get(k) || by.set(k, []).get(k)).push({ t, i }); } });
  const accts = [];
  for (const rows of by.values()) {
    const lastDate = rows.reduce((d, r) => (r.t.date > d ? r.t.date : d), '');
    const same = rows.filter(r => r.t.date === lastDate);
    // several rows on the last day: the final one is the row no other row continues from
    const r2 = x => Math.round(x * 100) / 100;
    const fin = same.find(c => !same.some(o => o !== c && r2(c.t.balance - o.t.debit + o.t.credit) === r2(o.t.balance))) ||
      same.sort((a, b) => (a.t.seq ?? 0) - (b.t.seq ?? 0) || a.i - b.i)[same.length - 1];
    accts.push({ bank: fin.t.bank, acct: fin.t.acct, date: lastDate, bal: fin.t.balance });
  }
  accts.sort((a, b) => b.date.localeCompare(a.date));
  return { total: accts.reduce((s, x) => s + x.bal, 0), accts };
}

// ---------------- Achievements (quiet: pop up once, then live in their own sheet) ----------------
function achievementState() {
  const list = [];
  const lvl = E.levelFor(D.saved);
  for (let i = 1; i < lvl.level; i++) list.push({ id: 'level-' + (i + 1), title: `Saved ${inr(E.LEVELS[i][0])}`, sub: E.LEVELS[i][1] });
  const lastMonth = D.months[D.months.length - 1];
  for (const m of D.months) {
    const c = monthCtx(m); const prev = D.months[D.months.indexOf(m) - 1];
    const st = E.streaks(S.txns, Math.max(0, c.sts.monthlyAllowance / c.dim), m);
    const qs = E.quests(D.mon, m, prev, { fmt: fmtPlain, savingsGoal: S.settings.savingsGoal, noSpendMonth: st.noSpendMonth, monthOver: c.monthOver });
    qs.filter(q => q.done).forEach(q => list.push({ id: `q-${m}-${q.id}`, title: q.title, sub: mLabel(m, true) }));
    const sm = D.sip.months[m];
    if (sm && c.monthOver && sm.missed === 0 && sm.rows.every(r => r.status === 'paid')) list.push({ id: `sip-${m}`, title: 'Every SIP went through', sub: mLabel(m, true) });
    if (m === lastMonth) [7, 14, 30].forEach(n => { if (st.best >= n) list.push({ id: `streak-${n}`, title: `${n} days in a row under budget`, sub: 'Best streak' }); });
  }
  if (S.txns.length && !(D.suspense || []).length) list.push({ id: 'suspense-zero', title: 'Everything categorised', sub: 'Suspense is empty' });
  return list;
}
let achQueue = [], achShowing = false;
function checkAchievements() {
  if (!S.txns.length || S.demo) return;
  const all = achievementState();
  const firstRun = !S.achieved;
  S.achieved ??= {};
  const fresh = all.filter(a => !S.achieved[a.id]);
  fresh.forEach(a => (S.achieved[a.id] = today()));
  if (fresh.length) save();
  if (firstRun) return; // don't flood on first load; history is still listed in Achievements
  achQueue.push(...fresh.slice(-3));
  showNextAchievement();
}
function showNextAchievement() {
  if (achShowing || !achQueue.length) return;
  achShowing = true;
  const a = achQueue.shift(); const el = $('#achPop');
  el.innerHTML = `<div class="ach-k">Achievement</div><div class="ach-t">${esc(a.title)}</div><div class="ach-s">${esc(a.sub)}</div>`;
  el.hidden = false; requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; achShowing = false; showNextAchievement(); }, 350); }, 3800);
}
function achievementsSheet() {
  const lvl = E.levelFor(D.saved);
  const m = S.ui.month, c = monthCtx(m), prev = D.months[D.months.indexOf(m) - 1];
  const st = E.streaks(S.txns, Math.max(0, c.sts.monthlyAllowance / c.dim), m);
  const qs = E.quests(D.mon, m, prev, { fmt: fmtPlain, savingsGoal: S.settings.savingsGoal, noSpendMonth: st.noSpendMonth, monthOver: c.monthOver });
  const all = achievementState(); const got = S.achieved || {};
  openSheet(`
    <div class="row"><h2>Achievements</h2><button class="btn small" data-action="close-sheet">Done</button></div>
    <div class="eyebrow" style="margin-top:14px">Savings milestone</div>
    <div class="row"><b>${lvl.title}</b><span class="tiny muted">${inr(D.saved)} saved</span></div>
    <div class="pace-bar" style="margin-top:8px"><div class="pace-fill pace-good" style="width:${Math.round(lvl.pct * 100)}%"></div></div>
    <div class="tiny muted" style="margin-top:6px">${lvl.to ? `Next: ${lvl.nextTitle} at ${inr(lvl.to)}` : 'Top milestone reached'}</div>
    <div class="grid3 quiet" style="margin-top:16px">
      <div><div class="k">Current streak</div><div class="v num">${st.current} days</div></div>
      <div><div class="k">Best streak</div><div class="v num">${st.best} days</div></div>
      <div><div class="k">No-spend days</div><div class="v num">${st.noSpendMonth}</div></div>
    </div>
    <div class="eyebrow" style="margin-top:18px">Goals for ${mLabel(m, true)}</div>
    ${qs.map(q => `<div class="goal"><div class="row"><span>${esc(q.title)}</span><span class="tiny ${q.done ? 'ok' : q.failed ? 'bad' : 'muted'}">${q.done ? 'Done' : q.failed ? 'Missed' : q.kind === 'cap' ? `${fmtPlain(q.now)} so far` : q.kind === 'flag' ? 'So far so good' : q.kind === 'count' ? `${q.now} of 5` : Math.round(q.progress * 100) + '%'}</span></div><div class="pace-bar thin"><div class="pace-fill ${q.done ? 'pace-good' : q.failed ? 'pace-critical' : 'pace-neutral'}" style="width:${Math.round(q.progress * 100)}%"></div></div></div>`).join('')}
    <div class="eyebrow" style="margin-top:18px">Unlocked · ${all.length}</div>
    ${all.length ? all.slice().reverse().map(a => `<div class="ach-row"><span>${esc(a.title)}</span><span class="tiny muted">${esc(a.sub)}</span></div>`).join('') : '<div class="sub">Nothing yet. They appear here as you reach them.</div>'}
    <div class="tiny muted" style="margin-top:12px">New achievements show up briefly at the top of the screen, once.</div>`);
}
function sipCard(m, compact) {
  const sp = D.sip; if (!sp?.slots.length) return '';
  const sm = sp.months[m];
  const badMonths = Object.entries(sp.months).filter(([, v]) => v.missed > 0);
  const st = { paid: ['ok', 'Paid'], due: ['muted', 'Due'], missed: ['bad', 'Bounced'], partial: ['bad', 'Part paid'], unknown: ['muted', 'Not in statement yet'] };
  const rows = sm ? sm.rows.map(r => `<tr><td>${r.count > 1 ? r.count + ' × ' : ''}${inr(r.amount)}<div class="tiny muted">${esc(r.name)}</div></td><td class="tiny">${dLabel(r.dueDate)}</td><td class="r tiny ${st[r.status][0]}">${st[r.status][1]}</td></tr>`).join('') : '';
  const alert = sm?.missed ? `<div class="alert a-bad"><span><b>${inr(sm.missed)} bounced in ${mLabel(m, true)}</b>${sm.charges ? `The bank charged ${inr(sm.charges, 2)}. ` : ''}Keep the balance up before the ${[...new Set(sm.rows.filter(r => r.missedAmt).map(r => ord(r.day)))].join(' and ')}.</span></div>` : '';
  const history = badMonths.length ? `<div class="tiny muted" style="margin-top:8px">Missed so far: ${badMonths.map(([mm, v]) => `${mLabel(mm)} ${inr(v.missed)}${v.charges ? ` (+${inr(v.charges, 0)} charges)` : ''}`).join(', ')}.</div>` : `<div class="tiny muted" style="margin-top:8px">No bounced SIPs in your statements.</div>`;
  return `<div class="card">
    <h2>SIPs <small>${money(sp.monthly)} a month</small></h2>
    ${alert}
    ${rows ? `<table class="mini">${rows}</table>` : ''}
    ${history}
    ${compact ? '' : `<div class="tiny muted" style="margin-top:6px">Found from auto-debits that repeat on the same day each month. They count as savings; your extra savings goal sits on top.</div>`}
  </div>`;
}
function suspenseCard() {
  const s = D.suspense; if (!s?.length) return '';
  const total = s.filter(x => x.dir === 'D').reduce((a, x) => a + x.amt, 0);
  const sugg = s.filter(x => S.lookups[x.payee]?.status === 'hit' || x.family).length;
  return `<div class="card">
    <h2>Suspense <small>${s.length} payees</small></h2>
    <div class="sub">${inr(total)} of spending couldn't be matched to a category yet. Sort the biggest ones and the rest of your numbers get sharper.${sugg ? ` ${sugg} have a suggestion ready.` : ''}</div>
    <button class="btn block" style="margin-top:10px" data-action="open-suspense">Sort Suspense</button>
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
  if (q) list = list.filter(t => (t.desc + ' ' + E.payeeName(t) + ' ' + E.CAT[t.cat].label + ' ' + (S.notes[t.id] || '')).toLowerCase().includes(q));
  list = list.sort((a, b) => (b.date + String(b.seq).padStart(5, '0')).localeCompare(a.date + String(a.seq).padStart(5, '0')));
  const series = D.months.map(k => ({ k, label: mLabel(k), v: Math.max(0, D.mon[k].spend) }));
  return `
  <div class="card">
    <h2>Spending by month <small>excludes own transfers & investments</small></h2>
    <div id="monthChart"></div>
    ${tableView(['Month', 'Spent', 'Income', 'Invested'], D.months.map(k => [mLabel(k, true), inr(D.mon[k].spend), inr(D.mon[k].income), inr(D.mon[k].invest)]))}
  </div>
  ${monthChips()}${coverageNote(m)}
  ${suspenseCard()}
  <div class="card">
    <h2>Where it went in ${mLabel(m, true)} <small>${money(mo.spend)}</small></h2>
    ${cats.map(([c, v]) => `<div class="cbar" data-action="cat" data-c="${c}" title="${esc(E.CAT[c].label)}: ${inr(v)} (${Math.round(v / mo.spend * 100)}%)">
      <div class="ic">${E.CAT[c].icon}</div><div><div class="top"><span>${E.CAT[c].label} <span class="muted tiny">${Math.round(v / mo.spend * 100)}%</span></span>${money(v)}</div>
      <div class="track"><div class="fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div></div></div>`).join('') || '<div class="sub">No spending this month.</div>'}
  </div>
  <div class="card">
    <div class="row"><h2>Transactions <small>${list.length}</small></h2><button class="btn small" data-action="${selTx ? 'sel-done' : 'sel-start'}">${selTx ? 'Done' : 'Select'}</button></div>
    <input class="search" type="search" placeholder="Search payee or note" value="${esc(S.ui.q)}" data-input="q">
    ${filter ? `<div style="margin-top:8px"><button class="chip on" data-action="cat" data-c="">${E.CAT[filter].icon} ${E.CAT[filter].label} ✕</button></div>` : ''}
    ${selTx ? `<div class="btn-row" style="margin-top:8px;align-items:center"><button class="btn small" data-action="sel-all">${list.slice(0, 250).every(t => selTx.has(t.id)) && list.length ? 'Clear all' : `Select all ${Math.min(list.length, 250)} shown`}</button><span class="tiny muted">Tap rows to tick them, then pick a category.</span></div>` : ''}
    <div style="margin-top:6px">${list.slice(0, 250).map(txnRow).join('')}</div>
    ${list.length > 250 ? `<div class="tiny muted">Showing the first 250. Search to narrow down.</div>` : ''}
  </div>
  ${selTx?.size ? bulkBar(selTx.size, 'bulk-tx') : ''}`;
}
function txnRow(t) {
  const c = E.CAT[t.cat]; const amt = t.credit ? t.credit : -t.debit;
  const sign = amt > 0 ? 'pos' : '';
  const on = selTx?.has(t.id);
  return `<div class="txn${selTx ? ' selmode' : ''}${on ? ' picked' : ''}" data-action="${selTx ? 'sel-txn' : 'txn'}" data-id="${esc(t.id)}" ${selTx ? `role="checkbox" aria-checked="${on ? 'true' : 'false'}"` : ''}>${selTx ? `<div class="chk" aria-hidden="true">${on ? '✓' : ''}</div>` : ''}<div class="ic">${c.icon}</div>
    <div style="min-width:0"><div class="t1">${esc(E.payeeName(t))}${t.fixed ? '<span class="tag">FIXED</span>' : ''}</div><div class="t2">${dLabel(t.date)} · ${c.label} · ${t.bank}</div>${S.notes[t.id] ? `<div class="t2" style="color:var(--text-secondary)">📝 ${esc(S.notes[t.id])}</div>` : ''}</div>
    <div class="amt ${sign}"><span class="num">${amt > 0 ? '+' : '−'}${inr(Math.abs(amt), Math.abs(amt) % 1 ? 2 : 0).replace('−', '')}</span><span class="aud num">${aud(Math.abs(amt))}</span></div></div>`;
}
// ---------------- multi-select ----------------
let selTx = null;             // Set of transaction ids while "Select" is on in Spending
let selPayees = new Set();    // Suspense payee keys ticked in Sort Suspense
function bulkBar(n, action) {
  return `<div class="bulkbar"><span><b>${n}</b> selected</span><button class="btn primary small" data-action="${action}">Choose category</button></div>`;
}
/** One sheet for many items: note box + suggestions + the full category grid, like a single transaction. */
function bulkSheet(mode) {
  const items = mode === 'payees'
    ? (D.suspense || []).filter(x => selPayees.has(x.key))
    : S.txns.filter(t => selTx?.has(t.id));
  if (!items.length) { toast('Nothing selected'); return; }
  const isOut = x => (mode === 'payees' ? x.dir === 'D' : x.debit > 0);
  const nOut = items.filter(isOut).length, nIn = items.length - nOut;
  const total = mode === 'payees' ? items.reduce((s, x) => s + x.amt, 0) : items.reduce((s, t) => s + (t.debit || t.credit), 0);
  const spendCats = E.CATEGORIES.filter(c => !INCOME_CATS.includes(c.id));
  const inCats = E.CATEGORIES.filter(c => [...INCOME_CATS, 'transfer'].includes(c.id));
  S.ui.bulk = { mode, out: null, in: null };
  const grid = (cats, side) => `<div class="catgrid" data-side="${side}">${cats.map(c => `<button data-action="bulk-pick" data-side="${side}" data-c="${c.id}"><span>${c.icon}</span>${c.label}</button>`).join('')}</div>`;
  openSheet(`
    <h2>${items.length} ${mode === 'payees' ? 'payees' : 'transactions'}</h2>
    <div class="sub">${nOut ? `${nOut} paid out` : ''}${nOut && nIn ? ' · ' : ''}${nIn ? `${nIn} received` : ''} · ${inr(total)} in all</div>
    <h3>What were these?</h3>
    <textarea class="input" id="bulkNote" rows="2" placeholder="Optional, e.g. Goa trip with friends" data-input="bulkNote"></textarea>
    <div id="bulkSug" class="stack" style="margin-top:8px"></div>
    ${nOut ? `<h3>${nIn ? `Category for the ${nOut} paid out` : 'Category'}</h3>${grid(spendCats, 'out')}` : ''}
    ${nIn ? `<h3>${nOut ? `Category for the ${nIn} received` : 'Category'}</h3>${grid(inCats, 'in')}` : ''}
    ${mode === 'payees' ? '<div class="tiny muted">Every payment to or from these payees follows this, including future statements.</div>'
      : `<label class="switch"><span>Also apply to every past and future payment to these payees</span><input type="checkbox" id="bulkAll"></label>`}
    <div class="btn-row" style="margin-top:14px"><button class="btn primary" data-action="bulk-apply">Apply</button><button class="btn" data-action="${mode === 'payees' ? 'bulk-back' : 'close-sheet'}">Cancel</button></div>`);
}
function bulkSuggest(note) {
  const box = $('#bulkSug'); if (!box) return;
  const opts = note ? localSuggest(note, $('[data-side="out"]') ? 'D' : 'C', E.CATEGORIES.map(c => c.id)) : [];
  box.innerHTML = opts.length ? `<div class="tiny muted">From your note:</div><div class="btn-row">${opts.map(o => `<button class="chip" data-action="bulk-sug" data-c="${o.cat}">${E.CAT[o.cat].icon} ${E.CAT[o.cat].label}</button>`).join('')}</div>` : '';
}
function bulkApply() {
  const b = S.ui.bulk; if (!b) return;
  if (!b.out && !b.in) { toast('Pick a category first'); return; }
  const note = $('#bulkNote')?.value.trim();
  let n = 0;
  if (b.mode === 'payees') {
    for (const x of (D.suspense || []).filter(y => selPayees.has(y.key))) {
      const cat = x.dir === 'D' ? b.out : b.in; if (!cat) continue;
      setPayeeCat(x, cat); n++;
      if (note) S.txns.filter(t => t.payee === x.payee && !S.notes[t.id]).forEach(t => (S.notes[t.id] = note));
    }
    selPayees = new Set();
    derive(); save(); suspenseSheet(true); render(); toast(`Sorted ${n} payees`); return;
  }
  const all = $('#bulkAll')?.checked;
  for (const t of S.txns.filter(x => selTx?.has(x.id))) {
    const cat = t.debit > 0 ? b.out : b.in; if (!cat) continue;
    if (all) { S.rules[t.payee] = { cat, dir: t.debit > 0 ? 'D' : 'C' }; S.txns.filter(x => x.payee === t.payee).forEach(x => delete S.txnOverrides[x.id]); }
    else S.txnOverrides[t.id] = cat;
    if (note) S.notes[t.id] = note;
    n++;
  }
  selTx = null;
  derive(); save(); closeSheet(); render(); toast(`Updated ${n} transactions`);
}

function tableView(head, rows) {
  return `<details class="table-view"><summary>Show as table</summary><table class="mini"><tr>${head.map((h, i) => `<th class="${i ? 'r' : ''}">${h}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'r' : ''}">${c}</td>`).join('')}</tr>`).join('')}</table></details>`;
}

function viewPlan() {
  const m = S.ui.month, c = monthCtx(m), fc = D.fc;
  const rec = [];
  for (const r of D.bills) {
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
  const risk = fc && c.sts.monthlyAllowance > 0 ? (fc.high <= c.sts.monthlyAllowance ? ['good', '', 'Even a heavy month fits your everyday budget.'] : fc.mid <= c.sts.monthlyAllowance ? ['warn', '', 'A typical month fits, but a heavy month would go over budget.'] : ['bad', '', 'A typical month already goes over your everyday budget. Trim a category or lower the savings goal.']) : null;
  return `
  <div class="card">
    <h2>Next 30 days: everyday spending <small>80% range</small></h2>
    ${fc ? `${band}
      <div class="sub">Most likely about <b>${money(fc.mid)}</b>, and 8 times out of 10 between ${money(fc.low)} and ${money(fc.high)}. Built from your last ${fc.basisDays} days of spending (average ${money(fc.dailyAvg)} a day, ${fc.zeroDays} no-spend days), excluding fixed costs and one-offs above ${fmtPlain(S.settings.oneOff)}.</div>
      ${risk ? `<div class="alert a-${risk[0]}"><span>${risk[2]} <span class="muted">(black line = your budget of ${fmtPlain(c.sts.monthlyAllowance)})</span></span></div>` : ''}` : '<div class="sub">Add statements to see a forecast.</div>'}
  </div>

  <div class="card">
    <h2>Fixed bills <small>${money(D.fixedTotal)} / month</small></h2>
    <div class="sub">Found from payments that repeat with the same amount in 3+ months. Turn any off if it isn't really fixed.</div>
    ${rec.length ? `<table class="mini" style="margin-top:8px"><tr><th>Payee</th><th>Day</th><th class="r">Per month</th><th></th></tr>
      ${rec.map(r => `<tr><td>${E.CAT[r.cat].icon} ${esc(r.name)}<div class="tiny muted">${r.parts.length > 1 || r.perMonth > 1 ? partsLabel(r) + ', ' : ''}${r.months} months</div></td><td class="tiny">${r.parts.map(p => ord(p.day)).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</td><td class="r">${money(r.amount, { stacked: true })}</td>
      <td class="r"><button class="btn small" data-action="unfix" data-k="${esc(r.keys.join(','))}" aria-label="Not fixed">✕</button></td></tr>`).join('')}</table>` : '<div class="sub" style="margin-top:8px">No repeating payments found yet. Tap a transaction and mark it as fixed.</div>'}
  </div>

  ${sipCard(m, false)}
  <div class="card">
    <h2>Safe-to-spend settings</h2>
    <label class="field">Monthly income (₹) <span class="muted">· auto-estimate ${inr(D.incomeAuto)}</span></label>
    <input class="input num" type="number" inputmode="numeric" data-setting="incomeOverride" placeholder="${D.incomeAuto}" value="${S.settings.incomeOverride ?? ''}">
    <label class="field">Extra savings each month, on top of SIPs (₹)</label>
    <input class="input num" type="number" inputmode="numeric" data-setting="savingsGoal" value="${S.settings.savingsGoal}">
    <label class="field">Treat single payments above this as one-offs (₹)</label>
    <input class="input num" type="number" inputmode="numeric" data-setting="oneOff" value="${S.settings.oneOff}">
    <div class="tiny muted" style="margin-top:10px">Safe to spend = income − fixed bills − SIPs − extra savings − everyday spending so far.</div>
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
    ${S.fx.error ? `<div class="alert a-warn"><span><b>Couldn't reach the rate service.</b>${esc(S.fx.error)} Enter today's rate from your bank or Wise below and it will be used everywhere.</span></div>` : ''}
    ${st.alerts.map(a => `<div class="alert a-${a.tone}"><span><b>${a.title}</b>${a.body}</span></div>`).join('')}
    ${S.fx.day?.date === today() && S.fx.last?.live && !S.fx.manual ? `<div class="tiny muted" style="margin-top:6px">Today so far: low ₹${S.fx.day.low.toFixed(2)} · high ₹${S.fx.day.high.toFixed(2)}</div>` : ''}
    <div class="grid2" style="margin-top:10px">
      <div class="stat"><div class="k">7-day low / high</div><div class="v num">${st.week ? `₹${st.week.low.toFixed(2)} – ${st.week.high.toFixed(2)}` : '–'}</div></div>
      <div class="stat"><div class="k">30-day low / high</div><div class="v num">${st.month ? `₹${st.month.low.toFixed(2)} – ${st.month.high.toFixed(2)}` : '–'}</div></div>
    </div>
    <div id="fxChart" style="margin-top:12px"></div>
    ${st.series.length ? tableView(['Date', '₹ per A$'], st.series.slice(-30).reverse().map(p => [dLabel(p.date), p.rate.toFixed(2)])) : ''}
    <div class="btn-row" style="margin-top:12px"><button class="btn small" data-action="fx-refresh">Refresh</button>
      <button class="btn small" data-action="fx-notify">${S.settings.notify ? 'Alerts on' : 'Turn on alerts'}</button></div>
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

  ${workCards()}

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


// ---------------- Student visa work tracker ----------------
function visaCal() {
  const sy = S.sydney;
  if (!sy.sessions) sy.sessions = V.UNSW_SESSIONS.map(x => ({ ...x }));
  // move hours logged with the old simple tracker into shifts
  if (sy.hours?.length) { sy.hours.forEach(h => sy.shifts.push({ id: h.id, date: h.date, hours: +h.hours, jobId: sy.jobs[0]?.id })); sy.hours = []; save(); }
  return { courseStart: sy.courseStart, research: !!sy.research, sessions: sy.sessions };
}
const audFmt = a => 'A$' + (+a).toLocaleString('en-AU', { maximumFractionDigits: 2, minimumFractionDigits: a % 1 ? 2 : 0 });
const audMoney = a => `<span class="money"><span class="num">${audFmt(a)}</span>${rate() ? `<span class="aud num">${inr(a * rate())}</span>` : ''}</span>`;
function workCards() {
  const sy = S.sydney, cal = visaCal(), t = today();
  const st = V.workStatus(sy.shifts, cal, t);
  const ern = V.earnings(sy.shifts, sy.jobs, t);
  const fyMonths = V.monthsResidentInFY(sy.arrival, ern.fyStart);
  const tax = V.residentTax(ern.fy, ern.fyStart, fyMonths);
  const L = V.RULES.limit;
  // headline state
  let head, tone, sub;
  if (st.rule === 'before') { head = 'Course not started: no work allowed yet'; tone = 'serious'; sub = `Your student visa doesn't let you work before your course starts on ${dLabel(cal.courseStart)} ${cal.courseStart.slice(0, 4)}.`; }
  else if (st.rule === 'unlimited') { head = 'Research degree: no hour limit'; tone = 'good'; sub = 'Masters by research and PhD students can work unlimited hours once the course starts.'; }
  else if (st.rule === 'break') { head = 'Course break: unlimited hours'; tone = 'good'; sub = `You're between terms, so the 48-hour limit doesn't apply.${st.next ? ` It applies again from ${dLabel(st.next.date)} (${esc(st.next.label)}).` : ''}`; }
  else { const pctUsed = st.used / L; tone = st.used > L ? 'critical' : st.used >= L ? 'critical' : st.used >= V.RULES.warnAt ? 'serious' : pctUsed >= 0.66 ? 'warning' : 'good'; head = `${esc(st.session?.name || 'Term')}: ${L} h per fortnight`; sub = st.next ? `Limit applies until ${dLabel(addDaysUI(st.next.date, -1))}; unlimited from ${dLabel(st.next.date)}.` : ''; }
  const meter = st.rule === 'limited' ? `
    <div class="row" style="margin-top:10px"><span class="tiny muted">Busiest fortnight that includes today</span><b class="num">${fmtH(st.used)} / ${L} h</b></div>
    <div class="hp" style="margin-top:6px" role="meter" aria-valuemin="0" aria-valuemax="${L}" aria-valuenow="${st.used}"><div class="status-${tone}" style="width:${Math.max(2, Math.min(100, st.used / L * 100))}%"></div></div>
    <div class="tiny muted" style="margin-top:6px">${st.used > L ? `${fmtH(st.used - L)} h over the limit.` : st.used >= L ? 'You\'ve hit the limit. No more hours until this fortnight rolls over.' : `You can work <b>${fmtH(st.left)} more hours</b> this week without breaking either fortnight.`}</div>
    <table class="mini" style="margin-top:8px">${st.wins.map(w => `<tr><td>${dLabel(w.from)} – ${dLabel(w.to)}${w.mixed ? ' <span class="tag">TERM STARTS/ENDS</span>' : ''}</td><td class="r">${fmtH(w.hours)} h</td><td class="r tiny">${w.limited ? (w.hours > L ? '❌ over' : w.hours >= V.RULES.warnAt ? '⚠️ close' : '✅') : 'no limit'}</td></tr>`).join('')}</table>` : '';
  const alerts = [];
  st.breaches.forEach(w => alerts.push(['a-bad', '', `Over the limit: ${fmtH(w.hours)} h from ${dLabel(w.from)} to ${dLabel(w.to)}`, 'More than 48 hours in a fortnight during term can breach visa condition 8105. Talk to UNSW Student Support before it happens again.']));
  if (st.beforeStart.length) alerts.push(['a-bad', '', `${st.beforeStart.length} shift(s) logged before your course starts`, 'Work before the course start date isn\'t allowed on a student visa. Check the date or remove them.']);
  const futureCheck = sy.shifts.filter(x => x.date > t).map(x => x.date);
  const plannedBreach = st.history.filter(w => w.limited && w.hours > L && w.to >= t);
  if (plannedBreach.length && !st.breaches.some(b => b.to < t)) { /* already shown */ }
  if (st.history.some(w => w.mixed && w.limited && w.hours > L / 2)) alerts.push(['a-info', 'ℹ️', 'A fortnight crosses the start or end of term', 'The app applies the 48-hour limit to the whole fortnight to be safe. If you plan to work long hours right at the end of term, check with UNSW first.']);
  const shiftsSorted = [...sy.shifts].sort((a, b) => b.date.localeCompare(a.date));
  const job = id => sy.jobs.find(j => j.id === id);
  const formDate = S.ui.shiftDate || t;
  const maxHere = V.maxOnDate(formDate, sy.shifts, cal);
  const ruleHere = V.dayRule(formDate, cal);
  return `
  <div class="card">
    <h2>Work rights <small>student visa 500</small></h2>
    <div class="alert a-${tone === 'good' ? 'good' : tone === 'warning' ? 'warn' : 'bad'}" style="margin-top:0"><span><b>${head}</b>${sub}</span></div>
    ${meter}
    ${alerts.map(a => `<div class="alert ${a[0]}"><span><b>${esc(a[2])}</b>${esc(a[3])}</span></div>`).join('')}
    <details class="table-view"><summary>The rules this uses (checked ${V.RULES.checked})</summary>
      <ul class="tiny" style="padding-left:18px;color:var(--text-secondary)">
        <li>No work before your course starts.</li>
        <li>While your course is in session (teaching, study week and exams): at most 48 hours in any fortnight. A fortnight is 14 days starting on a Monday, so every pair of weeks is checked.</li>
        <li>Unlimited hours in official breaks between terms. If you enrol in a summer or winter term, add it as a term below.</li>
        <li>All paid work counts, across every job. Compulsory placements that are a registered part of your course don't count; optional ones do.</li>
        <li>Masters by research and PhD students have no limit once the course starts.</li>
      </ul>
      <div class="tiny">${V.RULES.sources.map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${n}</a>`).join(' · ')}</div>
      <div class="tiny muted" style="margin-top:4px">Your own visa grant (check VEVO) is what counts. Rules can change, so check Home Affairs each term.</div>
    </details>
  </div>

  <div class="card">
    <h2>Log a shift <small>${formDate > t ? 'planned' : 'worked'}</small></h2>
    <div class="inline-inputs">
      <div><label class="field">Date</label><input class="input" type="date" id="shDate" value="${formDate}" data-input="shiftDate"></div>
      <div><label class="field">Hours</label><input class="input num" type="number" step="0.25" inputmode="decimal" id="shHours" placeholder="4"></div>
    </div>
    <div class="inline-inputs">
      <div><label class="field">Job</label><select class="input" id="shJob">${sy.jobs.map(j => `<option value="${j.id}">${esc(j.name)} (${audFmt(j.rate)}/h)</option>`).join('')}</select></div>
      <div><label class="field">Pay for this shift (A$, optional)</label><input class="input num" type="number" step="0.01" inputmode="decimal" id="shPay" placeholder="from hourly rate"></div>
    </div>
    <label class="switch"><span class="tiny">Compulsory placement for my course (doesn't count to the limit)</span><input type="checkbox" id="shWil"></label>
    <div class="tiny muted">${ruleHere === 'before' ? 'This date is before your course starts.' : ruleHere === 'limited' ? `On this date you can add up to <b>${fmtH(maxHere)} h</b> and stay within the limit.` : 'No limit applies on this date.'}</div>
    <button class="btn primary block" style="margin-top:10px" data-action="add-shift">Add shift</button>
    ${shiftsSorted.length ? `<table class="mini" style="margin-top:12px"><tr><th>Date</th><th>Job</th><th class="r">Hours</th><th class="r">Pay</th><th></th></tr>
      ${shiftsSorted.slice(0, S.ui.shiftLimit || 12).map(x => `<tr><td>${dLabel(x.date)}${x.date > t ? ' <span class="tag">PLANNED</span>' : ''}${x.wil ? ' <span class="tag">PLACEMENT</span>' : ''}<div class="tiny muted">${V.dayRule(x.date, cal) === 'limited' ? 'term' : V.dayRule(x.date, cal) === 'before' ? 'before course' : 'break'}</div></td><td class="tiny">${esc(job(x.jobId)?.name || '–')}</td><td class="r">${fmtH(+x.hours)}</td><td class="r">${audFmt(V.shiftPay(x, sy.jobs).toFixed(2))}</td><td class="r"><button class="btn small" data-action="del-shift" data-id="${x.id}" aria-label="Delete shift">✕</button></td></tr>`).join('')}</table>
      ${shiftsSorted.length > (S.ui.shiftLimit || 12) ? `<button class="btn small" style="margin-top:8px" data-action="more-shifts">Show more</button>` : ''}` : ''}
  </div>

  <div class="card">
    <h2>Work income <small>${esc(ern.fyLabel)}</small></h2>
    <div class="grid2">
      <div class="stat"><div class="k">This week · ${fmtH(ern.weekHrs)} h</div><div class="v">${audMoney(ern.week)}</div></div>
      <div class="stat"><div class="k">This month · ${fmtH(ern.monthHrs)} h</div><div class="v">${audMoney(ern.month)}</div></div>
      <div class="stat"><div class="k">Financial year · ${fmtH(ern.fyHrs)} h</div><div class="v">${audMoney(ern.fy)}</div></div>
      <div class="stat"><div class="k">Planned shifts · ${fmtH(ern.plannedHrs)} h</div><div class="v">${audMoney(ern.planned)}</div></div>
    </div>
    <div class="tiny muted" style="margin-top:8px">Estimated income tax for ${esc(ern.fyLabel)}: <b>${audFmt(tax.tax)}</b>. This assumes you're an Australian resident for tax purposes (usual for a course of 6 months or more), with a tax-free threshold of ${audFmt(tax.threshold)}${fyMonths < 12 ? ` because you arrive part-way through the year (${fyMonths} months)` : ''}. Offsets and the Medicare levy exemption aren't included. Your employer also pays super on top of your wage.</div>
    <h3>Jobs</h3>
    ${sy.jobs.map(j => `<div class="inline-inputs" style="margin-top:6px"><input class="input" value="${esc(j.name)}" data-job="${j.id}" data-field="name" aria-label="Job name"><div class="btn-row" style="flex-wrap:nowrap"><input class="input num" type="number" step="0.01" value="${j.rate}" data-job="${j.id}" data-field="rate" aria-label="Hourly rate A$">${sy.jobs.length > 1 ? `<button class="btn small" data-action="del-job" data-id="${j.id}">✕</button>` : ''}</div></div>`).join('')}
    <button class="btn small" style="margin-top:8px" data-action="add-job">＋ Add job</button>
    <div class="tiny muted" style="margin-top:6px">From 1 July 2026 the adult minimum wage is A$26.44 an hour, or A$33.05 for casuals (25% loading). Many award rates are higher, and weekends and public holidays usually pay more.</div>
  </div>

  <div class="card">
    <h2>Term dates <small>UNSW</small></h2>
    <div class="inline-inputs">
      <div><label class="field">Arrival in Australia</label><input class="input" type="date" data-sy="arrival" value="${sy.arrival || ''}"></div>
      <div><label class="field">Course starts</label><input class="input" type="date" data-sy="courseStart" value="${sy.courseStart}"></div>
    </div>
    <label class="switch"><span>Masters by research or PhD (no hour limit)</span><input type="checkbox" data-sy-check="research" ${sy.research ? 'checked' : ''}></label>
    <div class="sub">In session (48-hour limit). Anything outside these dates is a break with no limit.</div>
    <div style="margin-top:6px">${sy.sessions.map((x, i) => `<div style="border-top:1px solid var(--border);padding:8px 0">
      <div class="row"><input class="input" style="padding:6px 8px;font-size:14px;font-weight:600" value="${esc(x.name)}" data-sess="${i}" data-field="name" aria-label="Term name"><button class="btn small" data-action="del-sess" data-i="${i}" aria-label="Remove term">✕</button></div>
      <div class="inline-inputs" style="margin-top:6px"><label class="tiny muted">From<input class="input" type="date" style="padding:6px;font-size:13px" value="${x.from}" data-sess="${i}" data-field="from"></label><label class="tiny muted">To (last exam)<input class="input" type="date" style="padding:6px;font-size:13px" value="${x.to}" data-sess="${i}" data-field="to"></label></div></div>`).join('')}</div>
    <div class="btn-row" style="margin-top:8px"><button class="btn small" data-action="add-sess">＋ Add term</button><button class="btn small" data-action="add-optional">＋ Summer/winter 2028</button><button class="btn small" data-action="reset-sess">Reset to UNSW dates</button></div>
    <div class="tiny muted" style="margin-top:6px">Loaded from the UNSW academic calendar: 2027 terms (teaching start to last exam day) and the new 2028 semesters. Check myUNSW for your own program's dates; some postgraduate programs differ.</div>
  </div>`;
}
const fmtH = h => (+h).toLocaleString('en-AU', { maximumFractionDigits: 2 });
const addDaysUI = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
/** Warn when a new shift would push a fortnight over the limit, or hits it exactly. */
function checkWorkAlerts(added) {
  const cal = visaCal(); const sy = S.sydney;
  const rule = V.dayRule(added.date, cal);
  if (rule === 'before') return notifyUser('Shift is before your course starts', 'Student visa holders can\'t work before the course starts.');
  if (rule !== 'limited' && !V.windowRule(V.mondayOf(added.date), cal).limited && !V.windowRule(addDaysUI(V.mondayOf(added.date), -7), cal).limited) return;
  const m1 = V.mondayOf(added.date), m0 = addDaysUI(m1, -7);
  const worst = Math.max(...[m0, m1].filter(m => V.windowRule(m, cal).limited).map(m => V.windowHours(m, sy.shifts)), 0);
  if (worst > V.RULES.limit) notifyUser(`Over the 48-hour limit (${fmtH(worst)} h)`, 'This fortnight is over the student visa limit. Move or drop a shift.');
  else if (worst === V.RULES.limit) notifyUser('You\'ve reached 48 hours this fortnight', 'No more hours until the fortnight rolls over.');
  else if (worst >= V.RULES.warnAt) notifyUser(`${fmtH(worst)} of 48 hours used`, `${fmtH(V.RULES.limit - worst)} hours left this fortnight.`);
}
function notifyUser(title, body) {
  toast(title, 6000);
  try { if (S.settings.notify && 'Notification' in window && Notification.permission === 'granted') new Notification('RupeeRoo · ' + title, { body }); } catch (e) { /* not allowed here */ }
}

// ---------------- charts ----------------
function afterRender() {
  document.querySelectorAll('.chips').forEach(row => {
    const on = row.querySelector('.chip.on');
    const centre = () => { if (!on || !row.isConnected) return; const a = row.getBoundingClientRect(), b = on.getBoundingClientRect(); row.scrollTo({ left: row.scrollLeft + (b.left - a.left) - (a.width - b.width) / 2, behavior: 'instant' }); syncChipNav(row); };
    centre(); requestAnimationFrame(centre); document.fonts?.ready.then(centre);
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
// A transaction opened from a Home number goes back to that list when it closes.
let sheetKind = null, returnTo = null;
function openSheet(html, kind = null) { const s = $('#sheet'); s.querySelector('.sheet-body').innerHTML = html; s.hidden = false; sheetKind = kind; }
function closeSheet() {
  $('#sheet').hidden = true; sheetKind = null;
  if (returnTo) { const k = returnTo; returnTo = null; setTimeout(() => { if ($('#sheet').hidden && S.ui.tab === 'home') homeDetail(k); }, 0); }
}
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }

const INCOME_CATS = ['salary', 'interest', 'refund', 'income_other', 'suspense_in', 'bigtransfer_in'];
function txnSheet(id) {
  const t = S.txns.find(x => x.id === id); if (!t) return;
  const same = S.txns.filter(x => x.payee === t.payee && (x.debit > 0) === (t.debit > 0)).length;
  const cats = E.CATEGORIES.filter(c => (t.debit > 0 ? !INCOME_CATS.includes(c.id) : [...INCOME_CATS, 'transfer'].includes(c.id)));
  const isFixedPayee = S.fixedOverrides[t.payee] ?? t.fixed;
  openSheet(`
    <h2>${esc(E.payeeName(t))}</h2>
    <div class="sub">${dLabel(t.date)} ${t.date.slice(0, 4)} · ${t.bank}${t.acct ? ' ••' + t.acct : ''} · balance after ${inr(t.balance, 2)}</div>
    <div class="hero-num num" style="margin-top:10px;font-size:28px">${t.credit ? '+' + inr(t.credit, 2) : '−' + inr(t.debit, 2)}</div><div class="hero-aud">${aud(t.credit || t.debit)}</div>
    <h3>What was this?</h3>
    <textarea class="input" id="txnNote" rows="2" placeholder="e.g. dinner with college friends, paid mom back, Yash's birthday gift" data-input="txnNote" data-id="${esc(t.id)}">${esc(S.notes[t.id] || '')}</textarea>
    <div id="sugBox" class="stack" style="margin-top:8px">${suggestionsHTML(t, cats, S.notes[t.id] || '')}</div>
    <div class="btn-row" style="margin-top:8px">${claudeMaybeAvailable() ? `<button class="btn small" data-action="ask-claude" data-id="${esc(t.id)}">✨ Ask Claude</button>` : `<button class="btn small" data-action="open-settings-claude">✨ Set up Claude suggestions</button>`}<button class="btn small" data-action="to-suspense">❓ Not sure: keep in Suspense</button></div>
    <div id="claudeBox" class="tiny" style="margin-top:6px"></div>
    <h3>Category</h3>
    <div class="catgrid">${cats.map(c => `<button class="${c.id === t.cat ? 'on' : ''}" data-action="pick-cat" data-c="${c.id}"><span>${c.icon}</span>${c.label}</button>`).join('')}</div>
    <label class="switch"><span>Apply to all ${same} ${t.debit ? 'payments to' : 'credits from'} this payee, now and in future</span><input type="checkbox" id="applyAll" checked></label>
    ${t.debit ? `<label class="switch"><span>Fixed monthly cost</span><input type="checkbox" id="fixedToggle" ${isFixedPayee ? 'checked' : ''}></label>` : ''}
    <h3>Statement text</h3><div class="raw">${esc([t.type, t.desc, t.ref].filter(Boolean).join(' · '))}</div>
    <div class="btn-row" style="margin-top:14px"><button class="btn primary" data-action="save-txn" data-id="${esc(t.id)}">Save</button><button class="btn" data-action="close-sheet">Cancel</button></div>`);
  S.ui.pickCat = t.cat;
}

function suggestionsHTML(t, cats, note) {
  const opts = localSuggest(note, t.debit > 0 ? 'D' : 'C', cats.map(c => c.id));
  if (!opts.length) return note ? '<div class="tiny muted">No quick match from your note. Try Ask Claude, or pick below.</div>' : '';
  return `<div class="tiny muted">From your note:</div><div class="btn-row">${opts.map(o => `<button class="chip" data-action="pick-sug" data-c="${o.cat}" title="${esc(o.why)}">${E.CAT[o.cat].icon} ${E.CAT[o.cat].label}</button>`).join('')}</div>`;
}
function selectCat(c) {
  S.ui.pickCat = c;
  document.querySelectorAll('.catgrid button').forEach(b => b.classList.toggle('on', b.dataset.c === c));
  document.querySelector(`.catgrid button[data-c="${c}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
async function askClaude(id) {
  const t = S.txns.find(x => x.id === id); if (!t) return;
  const box = $('#claudeBox'); const note = $('#txnNote')?.value.trim() || '';
  const cats = E.CATEGORIES.filter(c => (t.debit > 0 ? !INCOME_CATS.includes(c.id) : [...INCOME_CATS, 'transfer'].includes(c.id)));
  box.innerHTML = '<span class="muted">Asking Claude…</span>';
  try {
    const r = await claudeSuggest({ note, payee: E.payeeName(t), amount: t.debit || t.credit, date: t.date, dir: t.debit > 0 ? 'D' : 'C', cats: cats.map(c => ({ id: c.id, label: c.label })), raw: t.desc.slice(0, 120) });
    if (!document.body.contains(box)) return;
    box.innerHTML = `<div class="muted">${r.unsure ? 'Claude isn\'t sure. Best guesses:' : 'Claude suggests:'}</div>
      <div class="stack" style="margin-top:4px">${r.options.map(o => `<button class="btn small" style="text-align:left;width:100%" data-action="pick-sug" data-c="${o.cat}"><b>${E.CAT[o.cat].icon} ${E.CAT[o.cat].label}</b> <span class="muted">· ${esc(o.why)}</span></button>`).join('')}</div>
      ${r.unsure ? '<div class="muted" style="margin-top:4px">If none fits, keep it in Suspense and add a note when you remember.</div>' : ''}`;
  } catch (e) {
    box.innerHTML = `<span class="bad">${esc(e.code === 'not_granted' ? 'Claude access was not allowed here.' : e.message || 'Claude is unavailable right now.')}</span>`;
  }
}

// ---------------- Suspense review ----------------
let lookupRunning = false, lookupStop = false;
function suspenseSheet(keepScroll) {
  const body = $('#sheet .sheet-body'); const top = keepScroll && !$('#sheet').hidden ? body.scrollTop : 0;
  const all = D.suspense || [];
  const limit = S.ui.suspenseLimit || 40;
  const list = all.slice(0, limit);
  const shops = all.filter(x => x.shop && !S.lookups[x.payee]);
  const ready = all.filter(x => suggestionFor(x));
  const spendCats = E.CATEGORIES.filter(c => !INCOME_CATS.includes(c.id) && c.id !== 'suspense');
  const inCats = E.CATEGORIES.filter(c => [...INCOME_CATS, 'transfer'].includes(c.id) && c.id !== 'suspense_in');
  openSheet(`
    <div class="row"><h2>Sort Suspense</h2><button class="btn small" data-action="close-sheet">Done</button></div>
    <div class="sub">Pick a category once and every payment to or from that payee follows it, including future statements.</div>
    <div class="card" style="margin:12px 0;padding:12px">
      <b style="font-size:14px">Look up shops online</b>
      <div class="tiny muted" style="margin:4px 0 8px">Sends only the shop names you tick below to OpenStreetMap, one per second. It finds chains and well-mapped places; most small stalls won't be listed. Results are suggestions, nothing changes until you accept.</div>
      <div class="inline-inputs"><input class="input" id="lookupCity" value="${esc(S.settings.city)}" placeholder="City"><button class="btn primary" data-action="${lookupRunning ? 'lookup-stop' : 'lookup-run'}">${lookupRunning ? 'Stop' : `Look up ${list.filter(x => x.shop && S.ui.lookupPick?.[x.key] !== false && !S.lookups[x.payee]).length} ticked`}</button></div>
      <div id="lookupProgress" class="tiny muted" style="margin-top:6px">${S.ui.lookupMsg || ''}</div>
    </div>
    ${ready.length ? `<button class="btn block" data-action="accept-all">Accept all ${ready.length} suggestions</button>` : ''}
    ${list.length ? `<div class="btn-row" style="margin-top:8px;align-items:center"><button class="btn small" data-action="sus-all">${list.every(x => selPayees.has(x.key)) ? 'Clear ticks' : `Tick all ${list.length} shown`}</button><span class="tiny muted">Tick several payees to sort them in one go.</span></div>` : ''}
    <div style="margin-top:8px">${list.map(x => {
      const sug = suggestionFor(x); const lk = S.lookups[x.payee];
      const cats = x.dir === 'D' ? spendCats : inCats;
      const tag = x.family ? 'same surname' : x.shop ? 'shop' : x.person ? 'person' : '';
      return `<div class="txn" style="grid-template-columns:auto 1fr auto;cursor:default">
        <label class="tickbox" title="Select ${esc(x.name)}"><input type="checkbox" data-sussel="${esc(x.key)}" ${selPayees.has(x.key) ? 'checked' : ''} aria-label="Select ${esc(x.name)}"></label>
        <div style="min-width:0"><div class="t1" data-action="txn" data-id="${esc(x.sample.id)}" style="cursor:pointer;text-decoration:underline dotted">${esc(x.name)} <span class="tag">${x.dir === 'D' ? 'PAID' : 'RECEIVED'}</span></div>
          <div class="t2">${x.n}× · ${tag}${x.vpa ? ' · ' + esc(x.vpa) : ''} · last ${dLabel(x.last)}</div>
          ${sug ? `<div class="tiny" style="margin-top:4px">Suggestion: ${esc(sug.why)} → <b>${E.CAT[sug.cat].icon} ${E.CAT[sug.cat].label}</b> <button class="btn small" data-action="accept-sug" data-k="${esc(x.key)}">Use</button></div>` : lk?.status === 'miss' ? '<div class="tiny muted" style="margin-top:4px">Not found on OpenStreetMap</div>' : ''}
          <div class="btn-row" style="margin-top:6px;align-items:center">
            <select class="input" style="width:auto;padding:6px 8px;font-size:13px" data-suspense="${esc(x.key)}"><option value="">Choose category…</option>${cats.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('')}</select>
            <a class="btn small" href="${webSearchUrl(x.name, x.vpa, S.settings.city)}" target="_blank" rel="noopener noreferrer">Search web</a>
            ${x.shop && !lk ? `<label class="tiny"><input type="checkbox" data-lookpick="${esc(x.key)}" ${S.ui.lookupPick?.[x.key] === false ? '' : 'checked'}> look up</label>` : ''}
          </div></div>
        <div class="amt ${x.dir === 'C' ? 'pos' : ''}"><span class="num">${inr(x.amt)}</span><span class="aud num">${aud(x.amt)}</span></div></div>`;
    }).join('')}</div>
    ${all.length > limit ? `<button class="btn block" style="margin-top:10px" data-action="suspense-more">Show ${Math.min(40, all.length - limit)} more (${all.length - limit} left)</button>` : ''}
    ${!all.length ? '<div class="sub" style="margin-top:12px">Suspense is empty. Everything has a category.</div>' : ''}
    <div id="susBar" class="sus-sticky">${susBarHTML()}</div>`);
  if (top) $('#sheet .sheet-body').scrollTop = top;
}
function susBarHTML() {
  const n = [...selPayees].filter(k => (D.suspense || []).some(x => x.key === k)).length;
  return n ? `<div class="bulkbar in-sheet"><span><b>${n}</b> payee${n > 1 ? 's' : ''} ticked</span><button class="btn primary small" data-action="bulk-payees">Choose category</button></div>` : '';
}
function suggestionFor(x) {
  const lk = S.lookups[x.payee];
  if (lk?.status === 'hit' && x.dir === 'D') return { cat: lk.cat, why: `${lk.place} is a ${lk.kind}${lk.where ? ' in ' + lk.where : ''}` };
  if (x.family) return { cat: x.dir === 'D' ? 'family' : 'income_other', why: 'Same surname as you' };
  return null;
}
function setPayeeCat(x, cat) {
  S.rules[x.payee] = { cat, dir: x.dir };
  S.txns.filter(t => t.payee === x.payee).forEach(t => delete S.txnOverrides[t.id]);
}
async function runLookup() {
  const city = $('#lookupCity')?.value.trim() || S.settings.city; S.settings.city = city;
  // only payees currently shown on screen, so nothing is sent that the user hasn't seen ticked
  const items = (D.suspense || []).slice(0, S.ui.suspenseLimit || 40).filter(x => x.shop && S.ui.lookupPick?.[x.key] !== false && !S.lookups[x.payee]).map(x => ({ key: x.payee, name: x.name }));
  if (!items.length) { toast('Nothing ticked to look up'); return; }
  lookupRunning = true; lookupStop = false; let done = 0, hits = 0;
  S.ui.lookupMsg = `Looking up 0 of ${items.length}…`; suspenseSheet(true);
  await lookupMany(items, city, (key, res) => {
    S.lookups[key] = res; done++; if (res.status === 'hit') hits++;
    S.ui.lookupMsg = `Looked up ${done} of ${items.length} · ${hits} found`;
    const pg = $('#lookupProgress'); if (pg) pg.textContent = S.ui.lookupMsg;
    if (done % 5 === 0) save();
  }, () => lookupStop);
  lookupRunning = false;
  S.ui.lookupMsg = `Done: ${hits} of ${done} found on OpenStreetMap.${done < items.length ? ' Stopped early.' : ''}`;
  derive(); save(); if (!$('#sheet').hidden) suspenseSheet(true); render();
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
    <h3>Claude suggestions</h3>
    <div class="sub">When you write what a payment was, Claude can suggest a category. It sees only your note, the payee name, amount and date, never account numbers or balances.</div>
    ${typeof window.claude?.use === 'function' ? '<div class="tiny ok" style="margin-top:6px">✓ Running inside Claude, so this works without a key.</div>' : ''}
    <label class="field">Anthropic API key (for the GitHub version)</label>
    <div class="inline-inputs"><input class="input" id="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${getApiKey() ? '••••••••' + getApiKey().slice(-4) : ''}"><div class="btn-row"><button class="btn primary" data-action="save-key">Save</button>${getApiKey() ? '<button class="btn" data-action="save-key-clear">Remove</button>' : ''}</div></div>
    <div class="tiny muted" style="margin-top:6px">Create one at console.anthropic.com → API keys, and set a small monthly spend limit there. Each suggestion costs a fraction of a cent. The key stays in this browser only and is never included in backups.</div>
    <h3>Backup</h3>
    <div class="sub">Everything lives in this browser only. Export a backup before clearing your browser or switching phones.</div>
    <div class="btn-row" style="margin-top:8px"><button class="btn" data-action="export">Export backup</button><button class="btn" data-action="import-json">⬆️ Restore backup</button></div>
    <div class="btn-row" style="margin-top:8px"><button class="btn danger" data-action="clear-data">Delete all data</button><button class="btn" data-action="load-demo">Load demo data</button>${window.RUPEEROO_SEED ? '<button class="btn" data-action="reload-seed">Reload my statements</button>' : ''}</div>
    <div class="btn-row" style="margin-top:16px"><button class="btn primary" data-action="save-settings">Done</button></div>
    <div class="tiny muted" style="margin-top:14px">RupeeRoo reads PDFs with Mozilla pdf.js on your device. The page is only allowed to contact the exchange-rate services (Coinbase, frankfurter.dev, open.er-api.com) and, when you ask it to look up shops, OpenStreetMap.</div>`);
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
  pdfjs = await import('../vendor/pdf.min.js?v=20261113j');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js?v=20261113j', import.meta.url).href;
  return pdfjs;
}
function askPassword(name, wrong) {
  return new Promise(res => {
    openSheet(`<h2>${esc(name)} is password protected</h2><div class="sub">${wrong ? '<b class="bad">That password didn’t work.</b> ' : ''}Banks usually build it from your details: SBI uses the last 5 digits of your mobile + date of birth (DDMMYY); many others use your customer ID, or the first letters of your name + date of birth. The email the statement came with says which. The password stays on this device.</div>
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
        results.push(`${f.name}: couldn't read this PDF (${e.message || e}).`); break;
      }
    }
    if (!pages) continue;
    if (!pages.some(p => p.items.length > 5)) { results.push(`${f.name}: this looks like a scanned image, so there's no text to read. Download the statement from net banking instead.`); continue; }
    const bank = detectBank(pages);
    const r = parseStatement(pages, bank);
    if (!r.txns.length) { results.push(`${f.name}: couldn't find a transaction table with dates and a balance column. If it's a bank statement, send me the layout and I'll add it.`); continue; }
    const existing = new Set(S.txns.map(t => t.id));
    // second safety net: same bank, date, amounts and running balance = same row, even if the account number wasn't read
    const seenRow = new Set(S.txns.map(t => [t.bank, t.date, t.debit, t.credit, t.balance].join('|')));
    let dupes = 0;
    for (const t of r.txns) {
      const id = [bank, r.acct, t.date, t.debit, t.credit, t.balance].join('|');
      if (existing.has(id) || seenRow.has([bank, t.date, t.debit, t.credit, t.balance].join('|'))) { dupes++; continue; }
      existing.add(id);
      S.txns.push({ id, bank, acct: r.acct, date: t.date, type: t.type, desc: t.desc, ref: t.ref, debit: t.debit, credit: t.credit, balance: t.balance, seq: t.seq });
    }
    if (r.holder && !S.settings.holderNames.some(n => n.toUpperCase() === r.holder.toUpperCase())) S.settings.holderNames.push(r.holder);
    r.checks.dupes = dupes;
    S.statements.push({ bank, acct: r.acct, from: r.checks.from, to: r.checks.to, checks: r.checks, importedAt: today() });
    results.push(`${bank}${r.acct ? ' ••' + r.acct : ''}: ${r.txns.length - dupes} new rows${r.checks.balanceBreaks ? `, ${r.checks.balanceBreaks} rows don't match the running balance, so check those` : ', all balances check out'}${r.checks.summaryMatch ? ', matches bank totals' : ''}.`);
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
function updateFxPill() { const r = rate(); $('#fxPill').innerHTML = r ? `${S.fx.last?.live && !S.fx.manual ? '<span class="live-dot" aria-label="live"></span>' : ''}A$1 = ₹${r.toFixed(2)}` : 'Set A$ rate'; }
function checkFxAlerts() {
  const st = fxStats(S.fx.history, rate(), S.settings.alertPct);
  if (!S.settings.notify || !st.alerts.length) return;
  for (const a of st.alerts.filter(a => a.key)) {
    const k = a.key + today();
    if (S.fx.notified[k]) continue;
    S.fx.notified[k] = 1; save();
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('RupeeRoo · ' + a.title, { body: a.plain, tag: a.key }); } catch (e) { /* not allowed here */ }
    toast(a.title, 5000);
  }
}

// ---------------- events ----------------
document.addEventListener('click', async e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { returnTo = null; if (!$('#sheet').hidden) closeSheet(); S.ui.tab = tab.dataset.tab; selTx = null; save(); render(); scrollTo(0, 0); return; }
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'pick-pdf': e.preventDefault(); e.stopPropagation(); returnTo = null; closeSheet(); $('#pdfInput').click(); break;
    case 'load-demo': { const keep = { fx: S.fx, sydney: S.sydney }; S = deepMerge(defaults(), keep); const d = makeDemo(); S.txns = d.txns; S.statements = d.statements; S.settings.holderNames = [d.holder]; S.demo = true; derive(); save(); closeSheet(); render(); toast('Demo data loaded'); break; }
    case 'clear-data': openSheet(`<h2>Delete everything?</h2><div class="sub">This removes your transactions, categories and settings from this browser. Export a backup first if you might need it.</div><div class="btn-row" style="margin-top:12px"><button class="btn danger" data-action="confirm-clear">Delete</button><button class="btn" data-action="close-sheet">Keep</button></div>`); break;
    case 'reload-seed': applySeed(true); derive(); closeSheet(); render(); toast('Your statements are loaded'); break;
    case 'confirm-clear': { const keep = { fx: { history: S.fx.history, last: S.fx.last }, seedApplied: S.seedApplied }; S = deepMerge(defaults(), keep); derive(); save(); closeSheet(); render(); toast('All data deleted'); break; }
    case 'close-sheet': closeSheet(); break;
    case 'open-settings': settingsSheet(); break;
    case 'chips-scroll': { const row = el.parentElement.querySelector('.chips'); row.scrollBy({ left: +el.dataset.dir * row.clientWidth * 0.7, behavior: 'smooth' }); break; }
    case 'open-achievements': achievementsSheet(); break;
    case 'open-suspense': S.ui.suspenseLimit = 40; suspenseSheet(); break;
    case 'suspense-more': S.ui.suspenseLimit = (S.ui.suspenseLimit || 40) + 40; suspenseSheet(true); break;
    case 'lookup-run': runLookup(); break;
    case 'lookup-stop': lookupStop = true; break;
    case 'accept-sug': { const x = D.suspense.find(y => y.key === el.dataset.k); const sg = x && suggestionFor(x); if (sg) { setPayeeCat(x, sg.cat); derive(); save(); suspenseSheet(true); render(); toast(`${x.name} → ${E.CAT[sg.cat].label}`); } break; }
    case 'accept-all': { let n = 0; for (const x of D.suspense) { const sg = suggestionFor(x); if (sg) { setPayeeCat(x, sg.cat); n++; } } derive(); save(); suspenseSheet(true); render(); toast(`Sorted ${n} payees`); break; }
    case 'month': S.ui.month = el.dataset.m; save(); render(); break;
    case 'cat': S.ui.catFilter = el.dataset.c || null; save(); render(); document.querySelector('.search')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
    case 'txn': if (sheetKind?.startsWith('detail:') && !$('#sheet').hidden) returnTo = sheetKind.slice(7); txnSheet(el.dataset.id); break;
    case 'home-detail': homeDetail(el.dataset.k); break;
    case 'sel-start': selTx = new Set(); render(); break;
    case 'sel-done': selTx = null; render(); break;
    case 'sel-txn': { const id = el.dataset.id; selTx.has(id) ? selTx.delete(id) : selTx.add(id); const y = window.scrollY; render(); window.scrollTo(0, y); break; }
    case 'sel-all': { const shown = [...document.querySelectorAll('[data-action="sel-txn"]')].map(r => r.dataset.id); const allOn = shown.every(id => selTx.has(id)); shown.forEach(id => (allOn ? selTx.delete(id) : selTx.add(id))); const y = window.scrollY; render(); window.scrollTo(0, y); break; }
    case 'bulk-tx': bulkSheet('tx'); break;
    case 'bulk-payees': bulkSheet('payees'); break;
    case 'bulk-back': suspenseSheet(); break;
    case 'bulk-pick': { const side = el.dataset.side; S.ui.bulk[side] = el.dataset.c; el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); break; }
    case 'bulk-sug': { const c = el.dataset.c, side = INCOME_CATS.includes(c) || c === 'transfer' ? 'in' : 'out'; const btn = document.querySelector(`.catgrid[data-side="${side}"] button[data-c="${c}"]`); if (btn) btn.click(); else toast('That category doesn\'t fit these'); break; }
    case 'bulk-apply': bulkApply(); break;
    case 'sus-all': { const shown = (D.suspense || []).slice(0, S.ui.suspenseLimit || 40).map(x => x.key); const allOn = shown.every(k => selPayees.has(k)); shown.forEach(k => (allOn ? selPayees.delete(k) : selPayees.add(k))); suspenseSheet(true); break; }
    case 'pick-cat': S.ui.pickCat = el.dataset.c; el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); break;
    case 'save-txn': {
      const t = S.txns.find(x => x.id === el.dataset.id);
      const all = $('#applyAll')?.checked;
      const note = $('#txnNote')?.value.trim(); if (note) S.notes[t.id] = note; else delete S.notes[t.id];
      if (S.ui.pickCat && S.ui.pickCat !== t.cat) {
        if (all) { S.rules[t.payee] = { cat: S.ui.pickCat, dir: t.debit > 0 ? 'D' : 'C' }; S.txns.filter(x => x.payee === t.payee).forEach(x => delete S.txnOverrides[x.id]); }
        else S.txnOverrides[t.id] = S.ui.pickCat;
      }
      const ft = $('#fixedToggle');
      if (ft && ft.checked !== t.fixed) S.fixedOverrides[t.payee] = ft.checked;
      derive(); save(); closeSheet(); render(); toast('Saved'); break;
    }
    case 'pick-sug': selectCat(el.dataset.c); break;
    case 'to-suspense': { const t = S.txns.find(x => x.id === document.querySelector('[data-action="save-txn"]')?.dataset.id); selectCat(t && t.credit > 0 ? 'suspense_in' : 'suspense'); toast('Will stay in Suspense'); break; }
    case 'ask-claude': askClaude(el.dataset.id); break;
    case 'open-settings-claude': settingsSheet(); setTimeout(() => $('#apiKey')?.scrollIntoView({ block: 'center' }), 50); break;
    case 'save-key-clear': setApiKey(''); settingsSheet(); toast('Key removed'); break;
    case 'save-key': { if (/^••••/.test($('#apiKey').value)) { toast('Key already saved'); break; } const k = $('#apiKey').value.trim(); if (k && !/^sk-ant-/.test(k)) { toast('That doesn\'t look like an Anthropic key (starts with sk-ant-)'); break; } setApiKey(k); settingsSheet(); toast(k ? 'Claude suggestions on' : 'Key removed'); break; }
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
    case 'add-shift': {
      const d = $('#shDate').value, h = parseFloat($('#shHours').value), pay = $('#shPay').value;
      if (!d || !(h > 0) || h > 24) { toast('Enter the date and the hours (up to 24)'); break; }
      const sh = { id: Date.now().toString(36), date: d, hours: h, jobId: $('#shJob').value, pay: pay === '' ? null : +pay, wil: $('#shWil').checked };
      S.sydney.shifts.push(sh); S.ui.shiftDate = d; save(); render(); checkWorkAlerts(sh); break;
    }
    case 'del-shift': S.sydney.shifts = S.sydney.shifts.filter(h => h.id !== el.dataset.id); save(); render(); break;
    case 'more-shifts': S.ui.shiftLimit = (S.ui.shiftLimit || 12) + 20; render(); break;
    case 'add-job': S.sydney.jobs.push({ id: 'j' + Date.now().toString(36), name: 'New job', rate: 33.05 }); save(); render(); break;
    case 'del-job': S.sydney.jobs = S.sydney.jobs.filter(j => j.id !== el.dataset.id); save(); render(); break;
    case 'add-sess': visaCal(); S.sydney.sessions.push({ name: 'New term', from: today(), to: today() }); save(); render(); break;
    case 'add-optional': visaCal(); V.UNSW_OPTIONAL.forEach(o => { if (!S.sydney.sessions.some(x => x.name === o.name)) S.sydney.sessions.push({ ...o }); }); S.sydney.sessions.sort((a, b) => a.from.localeCompare(b.from)); save(); render(); break;
    case 'del-sess': S.sydney.sessions.splice(+el.dataset.i, 1); save(); render(); break;
    case 'reset-sess': S.sydney.sessions = V.UNSW_SESSIONS.map(x => ({ ...x })); save(); render(); toast('UNSW term dates restored'); break;
  }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.sussel) { el.checked ? selPayees.add(el.dataset.sussel) : selPayees.delete(el.dataset.sussel); $('#susBar').innerHTML = susBarHTML(); return; }
  if (el.dataset.suspense && el.value) { const x = D.suspense.find(y => y.key === el.dataset.suspense); if (x) { setPayeeCat(x, el.value); derive(); save(); suspenseSheet(true); render(); toast(`${x.name} → ${E.CAT[el.value].label}`); } return; }
  if (el.dataset.lookpick) { (S.ui.lookupPick ??= {})[el.dataset.lookpick] = el.checked; save(); const b = document.querySelector('[data-action="lookup-run"]'); if (b) b.textContent = `Look up ${D.suspense.slice(0, S.ui.suspenseLimit || 40).filter(x => x.shop && S.ui.lookupPick?.[x.key] !== false && !S.lookups[x.payee]).length} ticked`; return; }
  if (el.id === 'lookupCity') { S.settings.city = el.value.trim(); save(); return; }
  if (el.dataset.setting) { const v = el.value === '' ? null : +el.value; S.settings[el.dataset.setting] = el.dataset.setting === 'incomeOverride' ? v : (v ?? 0); derive(); save(); render(); }
  else if (el.dataset.sy) { S.sydney[el.dataset.sy] = el.type === 'number' ? +el.value : el.value; save(); render(); }
  else if (el.dataset.loan) { S.sydney.loan[el.dataset.loan] = el.type === 'checkbox' ? el.checked : +el.value; save(); render(); }
  else if (el.dataset.input === 'shiftDate') { S.ui.shiftDate = el.value; save(); render(); }
  else if (el.dataset.syCheck) { S.sydney[el.dataset.syCheck] = el.checked; save(); render(); }
  else if (el.dataset.job) { const j = S.sydney.jobs.find(x => x.id === el.dataset.job); if (j) { j[el.dataset.field] = el.dataset.field === 'rate' ? +el.value : el.value; save(); render(); } }
  else if (el.dataset.sess != null) { const x = S.sydney.sessions[+el.dataset.sess]; if (x) { x[el.dataset.field] = el.value; S.sydney.sessions.sort((a, b) => a.from.localeCompare(b.from)); save(); render(); } }
  else if (el.dataset.action === 'theme') { S.settings.theme = el.value; applyTheme(); save(); }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.input === 'bulkNote') { bulkSuggest(el.value.trim()); return; }
  if (el.dataset.input === 'txnNote') { const t = S.txns.find(x => x.id === el.dataset.id); if (t) { const cats = E.CATEGORIES.filter(c => (t.debit > 0 ? !INCOME_CATS.includes(c.id) : [...INCOME_CATS, 'transfer'].includes(c.id))); $('#sugBox').innerHTML = suggestionsHTML(t, cats, el.value); } return; }
  if (el.dataset.input === 'q') { S.ui.q = el.value; const pos = el.selectionStart; render(); const s = document.querySelector('.search'); s.focus(); s.setSelectionRange(pos, pos); }
  if (el.dataset.conv) {
    const r = rate(); if (!r) return;
    if (el.dataset.conv === 'inr') { S.ui.convInr = +el.value; document.querySelector('[data-conv="aud"]').value = (+el.value / r).toFixed(2); }
    else { S.ui.convInr = +el.value * r; document.querySelector('[data-conv="inr"]').value = Math.round(+el.value * r); }
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet();
  // non-button links (the rate pill) open with Enter/Space like a button
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="link"][data-tab]')) { e.preventDefault(); e.target.click(); }
});
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
