// Exchange rates: ECB daily reference rates via Frankfurter (keyless, CORS-enabled),
// with open.er-api.com as a fallback for today's rate. Only currency codes are sent.

const iso = d => d.toISOString().slice(0, 10);

async function getJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/** Live mid-market rate: Coinbase's public rates endpoint (no key, not cached, updates continuously). */
async function liveRate() {
  const j = await getJSON('https://api.coinbase.com/v2/exchange-rates?currency=AUD', 6000);
  const v = parseFloat(j?.data?.rates?.INR);
  if (!(v > 0)) throw new Error('no INR rate');
  return v;
}

/** ECB daily reference rates for the last ~45 days, used for 7- and 30-day lows and highs. */
async function dailyHistory() {
  const end = new Date(), start = new Date(Date.now() - 45 * 864e5);
  for (const s of [{ base: 'https://api.frankfurter.dev/v1', q: 'base=AUD&symbols=INR' }, { base: 'https://api.frankfurter.app', q: 'from=AUD&to=INR' }]) {
    try {
      const ts = await getJSON(`${s.base}/${iso(start)}..${iso(end)}?${s.q}`);
      const history = {};
      for (const [d, v] of Object.entries(ts.rates || {})) if (v?.INR) history[d] = v.INR;
      if (Object.keys(history).length) return history;
    } catch (e) { /* try next */ }
  }
  return {};
}

/** Live rate first, then daily rates as a fallback. History is fetched at most every few hours. */
export async function fetchRatesLive(needHistory) {
  const histP = needHistory ? dailyHistory() : Promise.resolve(null);
  try {
    const rate = await liveRate();
    return { ok: true, live: true, rate, date: iso(new Date()), at: Date.now(), source: 'Live (Coinbase)', history: await histP };
  } catch (e) {
    const r = await fetchRates();
    const h = await histP;
    if (r.ok) return { ...r, live: false, at: Date.now(), history: { ...(h || {}), ...r.history } };
    return { ...r, history: h };
  }
}

export async function fetchRates() {
  const end = new Date();
  const start = new Date(Date.now() - 45 * 864e5);
  const sources = [
    { base: 'https://api.frankfurter.dev/v1', q: 'base=AUD&symbols=INR' },
    { base: 'https://api.frankfurter.app', q: 'from=AUD&to=INR' },
  ];
  let lastErr = '';
  for (const s of sources) {
    try {
      const ts = await getJSON(`${s.base}/${iso(start)}..${iso(end)}?${s.q}`);
      const history = {};
      for (const [d, v] of Object.entries(ts.rates || {})) if (v?.INR) history[d] = v.INR;
      const latest = await getJSON(`${s.base}/latest?${s.q}`);
      if (!latest?.rates?.INR) throw new Error('no INR rate');
      history[latest.date] = latest.rates.INR;
      return { ok: true, rate: latest.rates.INR, date: latest.date, history, source: 'ECB reference' };
    } catch (e) { lastErr = e.message || String(e); }
  }
  try {
    const j = await getJSON('https://open.er-api.com/v6/latest/AUD');
    if (j?.rates?.INR) {
      const date = iso(new Date((j.time_last_update_unix || Date.now() / 1000) * 1000));
      return { ok: true, rate: j.rates.INR, date, history: { [date]: j.rates.INR }, source: 'ExchangeRate-API' };
    }
  } catch (e) { lastErr = e.message || String(e); }
  return { ok: false, error: /fetch|network|abort|Failed|Load/i.test(lastErr) ? 'This page may be running somewhere that blocks network requests.' : lastErr };
}

/** Lows, highs and alerts for the last 7 and 30 days. `pct` is the "near" tolerance in percent. */
export function fxStats(history, current, pct = 0.25) {
  const series = Object.entries(history || {}).map(([date, rate]) => ({ date, rate: +rate })).filter(p => p.rate > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out = { series, alerts: [], week: null, month: null };
  if (!series.length || !current) return out;
  const lastDate = Date.parse(series[series.length - 1].date);
  const win = days => {
    const pts = series.filter(p => lastDate - Date.parse(p.date) <= (days - 1) * 864e5).map(p => p.rate).concat(current);
    return { low: Math.min(...pts), high: Math.max(...pts), n: pts.length };
  };
  out.week = win(7); out.month = win(30);
  // the chart shows the same 30-day window as the cards, ending with today's live rate,
  // so its low/high labels always match the numbers beside it
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const recent = series.filter(p => lastDate - Date.parse(p.date) <= 29 * 864e5 && p.date < today);
  out.chart = recent.concat({ date: today, rate: +current, live: true });
  const tol = pct / 100;
  const r = current.toFixed(2);
  const mk = (key, tone, icon, title, body) => out.alerts.push({ key, tone, icon, title, body: ' ' + body, plain: `A$1 = ₹${r}. ${body}` });
  if (out.month.n >= 8 && current <= out.month.low * (1 + tol)) mk('m-low', 'good', '🟢', '30-day low', `₹${r} is the cheapest the Australian dollar has been in a month. A good time to send money or lock a rate.`);
  else if (out.week.n >= 4 && current <= out.week.low * (1 + tol)) mk('w-low', 'good', '🟢', '7-day low', `₹${r} is the best rate this week.`);
  if (out.month.n >= 8 && current >= out.month.high * (1 - tol)) mk('m-high', 'warn', '🟠', '30-day high', `₹${r} is the most expensive in a month. Wait if your transfer isn't urgent.`);
  else if (out.week.n >= 4 && current >= out.week.high * (1 - tol)) mk('w-high', 'warn', '🟠', '7-day high', `₹${r} is the highest this week.`);
  return out;
}
