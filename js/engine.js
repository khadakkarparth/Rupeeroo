// Money logic: categories, own-account transfers, recurring (fixed) costs,
// variable-spend forecast, safe-to-spend and the game layer. No network, no DOM.
import { counterparty } from './parser.js';

export const CATEGORIES = [
  // id, label, icon, kind: spend | income | transfer | invest | excluded
  ['rent', 'Rent & housing', '🏠', 'spend'],
  ['groceries', 'Groceries', '🛒', 'spend'],
  ['food', 'Food & dining', '🍜', 'spend'],
  ['local', 'Local shops & stalls', '🏪', 'spend'],
  ['transport', 'Transport & fuel', '🛵', 'spend'],
  ['travel', 'Travel & stays', '✈️', 'spend'],
  ['subscriptions', 'Subscriptions & bills', '🔁', 'spend'],
  ['emi', 'EMI & loans', '🏦', 'spend'],
  ['shopping', 'Shopping', '🛍️', 'spend'],
  ['education', 'Education & exams', '🎓', 'spend'],
  ['health', 'Health & fitness', '💪', 'spend'],
  ['personal', 'Personal care', '💆', 'spend'],
  ['fun', 'Entertainment', '🎮', 'spend'],
  ['people', 'Paid to people', '🤝', 'spend'],
  ['family', 'Family', '👪', 'spend'],
  ['friends', 'Friends', '🧑‍🤝‍🧑', 'spend'],
  ['gifts', 'Gifts', '🎁', 'spend'],
  ['insurance', 'Insurance', '🛡️', 'spend'],
  ['suspense', 'Suspense (to sort)', '❓', 'spend'],
  ['cash', 'Cash withdrawal', '💵', 'spend'],
  ['charges', 'Bank charges', '⚠️', 'spend'],
  ['other', 'Other spending', '📦', 'spend'],
  ['invest', 'Investments & SIPs', '📈', 'invest'],
  ['bigtransfer', 'Large transfers out', '🔀', 'excluded'],
  ['cardbill', 'Credit card bill', '💳', 'excluded'],
  ['lent', 'Lent (to get back)', '🔁', 'excluded'],
  ['salary', 'Salary', '💼', 'income'],
  ['interest', 'Interest & dividends', '🪙', 'income'],
  ['refund', 'Refunds', '↩️', 'income'],
  ['income_other', 'Money received', '📥', 'income'],
  ['suspense_in', 'Suspense (received)', '❔', 'income'],
  ['bigtransfer_in', 'Large transfers in', '🔀', 'excluded'],
  ['transfer', 'Between my accounts', '🔄', 'transfer'],
].map(([id, label, icon, kind]) => ({ id, label, icon, kind }));
export const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

// Keyword rules, checked against "<narration> <upi handle>" in upper case. First match wins.
const RULES = [
  [/CRED\b|CREDCLUB|CC ?PAYMENT|CREDIT ?CARD|CARD ?BILL|BILLDESK.*CARD|SBICARD|HDFCCARD|ICICICARD|AXISCARD/, 'cardbill'],
  [/\bLIC\b|LICOFINDIA|HDFC ?LIFE|ICICI ?PRU|SBI ?LIFE|MAX ?LIFE|TATA ?AIA|STAR ?HEALTH|NIVA ?BUPA|CARE ?HEALTH|ACKO|DIGIT ?INSURANCE|POLICYBAZAAR|BAJAJ ?ALLIANZ|INSURANCE/, 'insurance'],
  [/NACH FAIL|RET CH|INSUF BAL|CHRG|CHARGES|SMS CHG|ANNUAL FEE|DEBIT CARD FEE|AMC\b/, 'charges'],
  [/NSE ?CLEARING|ICCL|INDIAN CLEARING|BSE ?STAR|CAMS|KFIN|KARVY|BSE ?LTD|ZERODHA|GROWW|INDMONEY|KUVERA|MUTUAL|MF\b|\bSIP\b|UPSTOX|COIN BY|PPF|NPS/, 'invest'],
  [/\bEMI\b|LOAN|BAJAJ FIN|HDFCLTD|LIC OF|ACH D|NACH/, 'emi'],
  [/RENT|NOBROKER|NESTAWAY|HOUSING|MAINTENANCE|SOCIETY|DOMAIN\.COM|REALESTATE/, 'rent'],
  [/BLINKIT|GROFERS|ZEPTO|BIGBASKET|BBNOW|BB ?DAILY|INSTAMART|DMART|AVENUE ?SUPERMARTS|RELIANCE ?FRESH|RELIANCE ?RETAIL|SMART BAZAAR|MORE RETAIL|JIOMART|RATNADEEP|SPENCER|NATURE'?S ?BASKET|STAR ?BAZAAR|VISHAL ?MEGA|LICIOUS|FRESHTOHOME|COUNTRY ?DELIGHT|MILKBASKET|SUPERMARKET|KIRANA|PROVISION|WOOLWORTHS|COLES|ALDI|IGA\b|HARRIS ?FARM/, 'groceries'],
  [/SWIGGY|ZOMATO|DOMINO|MCDONALD|KFC|STARBUCKS|PIZZA|BURGER|SUBWAY|CHAAYOS|CHAI ?POINT|THIRD ?WAVE|BLUE ?TOKAI|BARBEQUE ?NATION|WOW ?MOMO|HIGHWAY ?DELITE|HIGHWAYDEL|EATSURE|BOX8|CAFE|COFFEE|RESTAURANT|RESTRO|DHABA|CHULLA|BAKERY|BAKERS|CAKE|SWEETS|MITHAI|BIRYANI|HALDIRAM|DAIRY|CHAI|TEA\b|HOTEL|FOOD|KITCHEN|JUICE|PAN ?SHOP|UBER ?EATS|DOORDASH|MENULOG/, 'food'],
  [/UBER|OLA\b|OLACABS|RAPIDO|NAMMA ?YATRI|BLUSMART|INDRIVE|YULU|FASTAG|FASTTRA|SBIPMOPAD|PETROL|FUEL|HPCL|BPCL|IOCL|INDIAN ?OIL|NAYARA|JIO-?BP|RBML|SHELL|METRO|LANDTME|IRCTC|IRUT|REDBUS|ABHIBUS|PORTER|SMARTSHIFT|OPAL|TRANSPORTNSW|MYKI|PARKING/, 'transport'],
  [/AIRBNB|ZOSTEL|ZOWORLD|ZO ?WORLD|OYO|TREEBO|FABHOTEL|MAKEMYTRIP|MMT|GOIBIBO|CLEARTRIP|INDIGO|AIR ?INDIA|VISTARA|AKASA|IXIGO|AGODA|BOOKING\.COM|QANTAS|JETSTAR/, 'travel'],
  [/APPLE ?SE|APPLEME|APPLESERVI|ITUNES|NETFLIX|SPOTIFY|YOUTUBE|GOOGLE ?PLAY|PRIME ?VIDEO|HOTSTAR|JIOHOTSTAR|JIO\b|AIRTEL|VI ?POSTPAID|VODAFONE|BSNL|ACT ?FIBER|TATA ?PLAY|DISH ?TV|ELECTRICITY|MSEDCL|MAHAVITARAN|BESCOM|MAHANAGAR ?GAS|INDANE|HP ?GAS|BHARAT ?GAS|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|ICLOUD|MICROSOFT|ADOBE|NOTION|CANVA/, 'subscriptions'],
  [/AMAZON|AMZN|FLIPKART|MYNTRA|AJIO|NYKAA|MEESHO|TATA ?CLIQ|DECATHLON|CROMA|RELIANCE DIGITAL|SKINCART|LENSKART|IKEA|LIFESTYLE|WESTSIDE|PANTALOONS|TRENDS|MAX ?FASHION|ZARA|H&M|UNIQLO|KMART|TARGET|JB ?HI-?FI/, 'shopping'],
  [/GMAT|E-GMAT|VUE\b|\*VUE|PEARSON|\bIDP\b|IELT|PTE\b|KC ?OVERSEAS|K C OVER|LEVERAGE ?EDU|ICAI|UNSW|COURSERA|UDEMY|UNACADEMY|BYJU|UNIVERSITY|COLLEGE|SCHOOL|EXAM|GRAD MGMT/, 'education'],
  [/PHARM|MEDIC|APOLLO|MEDPLUS|HOSPITAL|CLINIC|1MG|NETMEDS|PRACTO|DIAGNOS|REDCLIFF|THYROCARE|LAL ?PATH|METROPOLIS|LAB\b|PATHOLOGY|GYM|FITNESS|WELLNESS|CULT\.?FIT/, 'health'],
  [/SPA\b|VIVASPA|MANAHSPA|SALON|PARLOUR|BARBER|LAKME|NATURALS|URBAN ?COMPANY|URBANCLAP/, 'personal'],
  [/BOOKMYSHOW|PVR|INOX|CINEPOLIS|AMB ?CINE|DISTRICT|ESCAPE|LASERSHOOT|VALVE|STEAM|PLAYSTATION|XBOX|NINTENDO|GAMING|SNOOKER|BOWLING/, 'fun'],
  [/ATM|CASH TXN|CASH WDL|CASH WITHDRAWAL/, 'cash'],
  [/PROTEAN|NSDL|UTIITSL|INCOME ?TAX|GST ?PAYMENT|PASSPORT|VFS ?GLOBAL|IMMI|HOME ?AFFAIRS/, 'other'],
  [/INT\.?PD|INTEREST|INT CREDIT|SBINT|DIVIDEND|FNL ?DIV|\bDIV\b|DIV\d|INTDIV/, 'interest'],
  [/REFUND|REVERSAL|REV-|CASHBACK|BHIMCASHBA|UPI\/RRC/, 'refund'],
  [/SALARY|SAL CR|PAYROLL/, 'salary'],
];
// QR / POS collect handles used by small shops and stalls
const MERCHANT_VPA = /PAYTMQR|PAYTM\.S|^Q\d|BHARATPE|PINELABS|EAZYPAY|MSWIPE|GETEPAY|VYAPAR|OKBIZ|RAZORPAY|\.RZP|RZP|MAB\.|YTM\.S|MERCHANT|SUPERYES|PTYS|@PTY/;

export const norm = s => (s || '').toUpperCase().replace(/[^A-Z]/g, '');

/** Stable key for a payee, used for user rules and recurring detection. */
export function payeeKey(t) {
  const c = counterparty(t);
  const vpa = (c.vpa || '').toLowerCase().replace(/\d+/g, '').replace(/[^a-z.@-]/g, '').slice(0, 14);
  const name = norm(c.name).slice(0, 12);
  return (name || 'X') + (vpa ? '|' + vpa : '');
}
export function payeeName(t) {
  const c = counterparty(t);
  let n = c.name.replace(/^NACH0*\d+\s*/i, '').replace(/^(US|IN)\/(WL \*)?/i, '').trim();
  if (/NSE ?CLEARING/i.test(n)) n = 'NSE Clearing (SIP)';
  if (/^APPLE/i.test(n)) n = 'Apple Services';
  return n.length > 28 ? n.slice(0, 28) + '…' : n || 'Unknown';
}

export function holderTokens(name) {
  const w = (name || '').toUpperCase().replace(/^(MR|MS|MRS|MISS|DR)\.?\s+/, '').split(/\s+/).filter(Boolean);
  if (w.length < 2) return [];
  return [w[0] + w[1].slice(0, 2), w[0] + w[w.length - 1], w.join('')];
}

export function categorise(t, ctx) {
  const key = payeeKey(t);
  if (ctx.txnOverrides?.[t.id]) return ctx.txnOverrides[t.id];
  if (ctx.rules?.[key] && ctx.rules[key].dir === (t.debit > 0 ? 'D' : 'C')) return ctx.rules[key].cat;
  if (t.isTransfer) return 'transfer';
  const c = counterparty(t);
  const hay = (t.desc + ' ' + (c.vpa || '') + ' ' + (t.type || '')).toUpperCase();
  const amt = t.debit || t.credit;
  if (t.credit > 0) {
    if (/RAK ?PROJ/.test(hay) && ctx.employerHint !== false) return 'salary';
    for (const [re, cat] of RULES) if (re.test(hay) && ['interest', 'refund', 'salary'].includes(cat)) return cat;
    // money back from a shop or app is a refund, not income
    for (const [re, cat] of RULES) if (re.test(hay) && CAT[cat]?.kind === 'spend' && cat !== 'cash' && cat !== 'charges' && cat !== 'emi') return 'refund';
    if (/^(NEFT|RTGS|N\/|R\/|IMPS|TAUBR|TRANSFER)/i.test(t.desc) && amt >= (ctx.bigTransfer ?? 50000)) return 'bigtransfer_in';
    if (/INITIAL FUNDING|OPENING/i.test(t.desc)) return 'transfer';
    return 'suspense_in';
  }
  for (const [re, cat] of RULES) if (re.test(hay) && !['interest', 'refund', 'salary'].includes(cat)) return cat;
  if (/^(NEFT|RTGS|R\/|IMPS|N\/)/i.test(t.desc) && amt >= (ctx.bigTransfer ?? 50000)) return 'bigtransfer';
  if (c.via === 'Card') return 'shopping';
  // anything we can't name goes to Suspense until the user (or a lookup) sorts it
  return 'suspense';
}

/** Does this payee look like a business (worth looking up online) rather than a person? */
const BIZ_WORDS = /ENTERPRISE|\bENT\b|STORE|MART|TRADER|AGENC|SERVICE|SOLUTION|\bLTD|LIMITED|PVT|\bM\/S|CAFE|RESTAURANT|HOTEL|MEDICAL|CHEMIST|BHANDAR|KIRANA|SWEETS|BAKER|DAIRY|CENTRE|CENTER|CORNER|COLLECTION|HOUSE|INDUSTR|CINE|PLAZA|POINT|WORLD|INDIA/;
export function isShopLike(t) {
  const c = counterparty(t);
  return MERCHANT_VPA.test((c.vpa || '').toUpperCase()) || BIZ_WORDS.test(((c.name || '') + ' ' + t.desc).toUpperCase()) || /^(POS|VISA|ECOM)/i.test(t.desc);
}
/** A personal UPI handle (phone number or name@bank) usually means a person. */
export function isPersonLike(t) {
  const c = counterparty(t);
  return c.via === 'UPI' && !isShopLike(t) && (/^\d{10}/.test(c.vpa) || /@ok(sbi|axis|icici|hdfcbank)$|@ybl$|@ibl$|@axl$|@upi$/i.test(c.vpa) || /^gpay-/i.test(c.vpa) || !c.vpa.includes('.'));
}
/** Same surname as the account holder → probably family. Only a suggestion. */
export function surnameHint(t, holderNames) {
  const c = counterparty(t);
  const hay = ((c.name || '') + ' ' + (c.vpa || '')).toUpperCase().replace(/[^A-Z]/g, '');
  return holderNames.some(n => { const w = n.toUpperCase().split(/\s+/).filter(Boolean); const last = w[w.length - 1] || ''; return last.length >= 5 && hay.includes(last.slice(0, 4)); });
}

/** Flag money moved between the user's own accounts so it is not counted as spending or income. */
/** Credits from the same sender in 2+ months, above ₹5,000 each, look like pay: call them salary. */
export function promoteSalary(txns, ctx) {
  const groups = {};
  txns.filter(t => t.credit >= 5000 && ['income_other', 'bigtransfer_in'].includes(t.cat) && !ctx.txnOverrides?.[t.id] && !ctx.rules?.[t.payee])
    .forEach(t => (groups[t.payee] ??= []).push(t));
  for (const list of Object.values(groups)) {
    const months = new Set(list.map(t => t.date.slice(0, 7)));
    if (months.size >= 2 && !/^(UPI|IMPS)/i.test(list[0].desc)) list.forEach(t => (t.cat = 'salary'));
  }
}

export function markTransfers(txns, holderNames) {
  const toks = holderNames.flatMap(holderTokens);
  for (const t of txns) {
    t.isTransfer = false;
    const n = norm(counterparty(t).name);
    if (toks.length && toks.some(k => k.length >= 6 && n.startsWith(k.slice(0, Math.min(k.length, 10))))) t.isTransfer = true;
  }
  // pair a debit in one bank with an equal credit in another within 3 days
  const credits = txns.filter(t => t.credit > 0);
  for (const d of txns.filter(t => t.debit > 0)) {
    const dd = Date.parse(d.date);
    const m = credits.find(c => !c._paired && c.bank !== d.bank && Math.abs(c.credit - d.debit) < 0.01 && Math.abs(Date.parse(c.date) - dd) <= 3 * 864e5);
    if (m) { d.isTransfer = m.isTransfer = true; m._paired = true; }
  }
  credits.forEach(c => delete c._paired);
}

export const monthOf = d => d.slice(0, 7);
export function monthsBetween(a, b) {
  const out = []; let [y, m] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number);
  while (y < by || (y === by && m <= bm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

/** Recurring payments: same payee and amount (±5%) seen in 3+ distinct months, still active. */
export function findRecurring(txns, ctx) {
  // everyday categories can repeat by coincidence (₹40 chai), so only bill-like categories qualify unless the user says so
  const NOT_FIXED = ['transfer', 'bigtransfer', 'cardbill', 'lent', 'friends', 'gifts', 'charges', 'food', 'groceries', 'local', 'transport', 'fun', 'shopping', 'cash', 'personal', 'travel', 'people'];
  const spend = txns.filter(t => (ctx.fixedOverrides?.[t.payee] === true) || (t.debit >= (t.cat === 'suspense' ? 500 : 99) && !NOT_FIXED.includes(t.cat)));
  const lastByBank = {};
  txns.forEach(t => { if (!lastByBank[t.bank] || t.date > lastByBank[t.bank]) lastByBank[t.bank] = t.date; });
  const groups = {};
  for (const t of spend) (groups[t.payee] ??= []).push(t);
  const out = [];
  for (const [key, list] of Object.entries(groups)) {
    const clusters = [];
    for (const t of list.sort((a, b) => a.debit - b.debit)) {
      const c = clusters.find(c => Math.abs(t.debit - c.amt) / c.amt <= 0.05);
      if (c) c.items.push(t); else clusters.push({ amt: t.debit, items: [t] });
    }
    for (const c of clusters) {
      const byMonth = {};
      c.items.forEach(t => (byMonth[monthOf(t.date)] ??= []).push(t));
      const months = Object.keys(byMonth).sort();
      const forced = ctx.fixedOverrides?.[key];
      if (forced === false) continue;
      if (months.length < 3 && forced !== true) continue;
      const last = c.items.reduce((m, t) => (t.date > m ? t.date : m), '');
      const end = lastByBank[c.items[0].bank];
      const active = (Date.parse(end) - Date.parse(last)) / 864e5 <= 45;
      if (!active && forced !== true) continue;
      const perMonth = median(months.map(m => byMonth[m].length));
      const amt = median(c.items.map(t => t.debit));
      const days = c.items.map(t => +t.date.slice(8));
      out.push({
        key, name: payeeName(c.items[0]), cat: c.items[0].cat, amount: round(amt * perMonth), unit: round(amt), perMonth,
        months: months.length, last, day: Math.round(median(days)), ids: c.items.map(t => t.id), active,
      });
    }
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const round = n => Math.round(n);
const quantile = (s, q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];

/** Variable spending forecast from the user's own daily spending (bootstrap of the last 90 days). */
export function forecast(txns, opts) {
  const { oneOff = 15000, sims = 3000, horizonDays = 30, seed = 7 } = opts || {};
  const varTx = txns.filter(t => t.debit > 0 && CAT[t.cat]?.kind === 'spend' && !t.fixed && t.debit < oneOff);
  if (!varTx.length) return null;
  const end = txns.reduce((m, t) => (t.date > m ? t.date : m), '');
  const endMs = Date.parse(end);
  const startMs = Math.max(endMs - 89 * 864e5, Date.parse(txns.reduce((m, t) => (t.date < m ? t.date : m), end)));
  const days = {};
  for (let d = startMs; d <= endMs; d += 864e5) days[new Date(d).toISOString().slice(0, 10)] = 0;
  varTx.forEach(t => { if (t.date in days) days[t.date] += t.debit; });
  const daily = Object.values(days);
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const totals = [];
  for (let i = 0; i < sims; i++) { let sum = 0; for (let d = 0; d < horizonDays; d++) sum += daily[(rnd() * daily.length) | 0]; totals.push(sum); }
  totals.sort((a, b) => a - b);
  // per-category medians of monthly totals (complete months only)
  const months = {};
  varTx.forEach(t => { const m = monthOf(t.date); (months[m] ??= {}); months[m][t.cat] = (months[m][t.cat] || 0) + t.debit; });
  return {
    low: round(quantile(totals, 0.1)), mid: round(quantile(totals, 0.5)), high: round(quantile(totals, 0.9)),
    dailyAvg: round(daily.reduce((a, b) => a + b, 0) / daily.length), basisDays: daily.length,
    zeroDays: daily.filter(v => v === 0).length, end,
  };
}

/** Monthly roll-up of spending, income and investing. */
export function monthly(txns) {
  const out = {};
  for (const t of txns) {
    const m = monthOf(t.date); const k = CAT[t.cat]?.kind;
    const o = (out[m] ??= { month: m, spend: 0, income: 0, invest: 0, fixed: 0, byCat: {}, days: new Set() });
    if (k === 'spend' && t.debit) { o.spend += t.debit; o.byCat[t.cat] = (o.byCat[t.cat] || 0) + t.debit; if (t.fixed) o.fixed += t.fixed ? t.debit : 0; }
    if (k === 'spend' && t.credit) { o.spend -= t.credit; o.byCat[t.cat] = (o.byCat[t.cat] || 0) - t.credit; }
    if (k === 'income' && t.credit) o.income += t.credit;
    if (k === 'invest') o.invest += t.debit - t.credit;
    o.days.add(t.date);
  }
  return out;
}

export function incomeEstimate(txns) {
  const mon = monthly(txns);
  const vals = Object.values(mon).map(m => m.income).filter(v => v > 0);
  return round(median(vals));
}

export function safeToSpend({ income, fixedTotal, savingsGoal, spentVariable, daysLeft }) {
  const monthlyAllowance = income - fixedTotal - savingsGoal;
  const remaining = monthlyAllowance - spentVariable;
  return { monthlyAllowance: round(monthlyAllowance), remaining: round(remaining), perDay: daysLeft > 0 ? round(Math.max(0, remaining) / daysLeft) : 0 };
}

// ---------- Game layer ----------
export const LEVELS = [
  [0, 'Rupee Rookie'], [10000, 'Penny Planner'], [25000, 'Budget Builder'], [50000, 'Savings Scout'],
  [100000, 'Lakh Legend'], [250000, 'Compounding Cadet'], [500000, 'Wealth Warden'],
  [1000000, 'Ten-Lakh Titan'], [1650000, 'Sydney Ready'],
];
export function levelFor(saved) {
  let i = 0; while (i + 1 < LEVELS.length && saved >= LEVELS[i + 1][0]) i++;
  const cur = LEVELS[i], next = LEVELS[i + 1];
  return { level: i + 1, title: cur[1], from: cur[0], to: next ? next[0] : null, nextTitle: next?.[1], pct: next ? Math.min(1, (saved - cur[0]) / (next[0] - cur[0])) : 1 };
}

/** Days in a month where variable spending stayed under the daily allowance; current and best streak. */
export function streaks(txns, dailyAllowance, month) {
  const byDay = {};
  txns.filter(t => t.debit > 0 && CAT[t.cat]?.kind === 'spend' && !t.fixed).forEach(t => { byDay[t.date] = (byDay[t.date] || 0) + t.debit; });
  const dates = txns.map(t => t.date).sort();
  if (!dates.length) return { current: 0, best: 0, noSpend: 0 };
  const start = Date.parse(dates[0]), end = Date.parse(dates[dates.length - 1]);
  let cur = 0, best = 0, noSpend = 0, noSpendMonth = 0;
  for (let d = start; d <= end; d += 864e5) {
    const k = new Date(d).toISOString().slice(0, 10); const v = byDay[k] || 0;
    if (v <= dailyAllowance) { cur++; best = Math.max(best, cur); } else cur = 0;
    if (!v) { noSpend++; if (k.startsWith(month)) noSpendMonth++; }
  }
  return { current: cur, best, noSpend, noSpendMonth, asOf: dates[dates.length - 1] };
}

/** Monthly quests built from the user's own previous month, so targets stay realistic. */
export function quests(mon, month, prevMonth, ctx) {
  const cur = mon[month], prev = mon[prevMonth];
  if (!cur) return [];
  const q = [];
  const topCats = prev ? Object.entries(prev.byCat).filter(([c]) => !['charges', 'people', 'other', 'suspense', 'family', 'friends', 'gifts', 'insurance', 'emi'].includes(c)).sort((a, b) => b[1] - a[1]).slice(0, 2) : [];
  for (const [c, v] of topCats) {
    const target = Math.round(v * 0.9 / 100) * 100;
    const now = cur.byCat[c] || 0;
    q.push({ id: 'cut-' + c, icon: CAT[c].icon, title: `Keep ${CAT[c].label} under ${ctx.fmt(target)}`, sub: `10% below last month (${ctx.fmt(v)})`, progress: Math.min(1, now / target), done: ctx.monthOver && now <= target, failed: now > target, xp: 150, kind: 'cap', now });
  }
  q.push({ id: 'nospend', icon: '🧘', title: 'Have 5 no-spend days', sub: 'Days with zero variable spending', progress: Math.min(1, (ctx.noSpendMonth || 0) / 5), done: (ctx.noSpendMonth || 0) >= 5, xp: 100, kind: 'count', now: ctx.noSpendMonth || 0 });
  const saved = cur.income - cur.spend;
  if (ctx.savingsGoal > 0) q.push({ id: 'save', icon: '🐷', title: `Save ${ctx.fmt(ctx.savingsGoal)} this month`, sub: 'Income minus spending', progress: Math.max(0, Math.min(1, saved / ctx.savingsGoal)), done: saved >= ctx.savingsGoal, xp: 250, kind: 'goal', now: saved });
  q.push({ id: 'charges', icon: '🛡️', title: 'Zero bank penalty charges', sub: 'Keep enough balance for auto-debits', progress: (cur.byCat.charges || 0) ? 0 : 1, done: !(cur.byCat.charges || 0) && ctx.monthOver, failed: (cur.byCat.charges || 0) > 0, xp: 100, kind: 'flag' });
  return q;
}

/** Budget health 0..100: how much of this month's variable allowance is left, adjusted for the date. */
export function health(allowance, spent, dayOfMonth, daysInMonth) {
  if (allowance <= 0) return { hp: 0, label: 'No room in budget', status: 'critical' };
  const expected = allowance * (dayOfMonth / daysInMonth);
  const left = Math.max(0, 1 - spent / allowance);
  const pace = expected > 0 ? spent / expected : 0;
  const hp = Math.round(left * 100);
  const status = hp <= 10 || pace > 1.4 ? 'critical' : pace > 1.15 ? 'serious' : pace > 1 ? 'warning' : 'good';
  const label = { good: 'On track', warning: 'Slightly ahead of pace', serious: 'Spending fast', critical: hp <= 10 ? 'Almost out' : 'Way over pace' }[status];
  return { hp, status, label, pace };
}

// ---------- Sydney mode ----------
export function emi(principal, annualRate, months) {
  const r = annualRate / 1200;
  if (!principal || !months) return 0;
  if (!r) return principal / months;
  return principal * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1);
}
/** Education loan with a moratorium: simple interest accrues during study + grace, then EMI. */
export function loanPlan({ principal, rate, moratoriumMonths, tenureMonths, payInterestDuring }) {
  const moratInterest = principal * rate / 1200 * moratoriumMonths;
  const base = payInterestDuring ? principal : principal + moratInterest;
  const e = emi(base, rate, tenureMonths);
  return {
    moratInterest: round(moratInterest), monthlyInterestDuring: round(principal * rate / 1200),
    emi: round(e), totalPaid: round(e * tenureMonths + (payInterestDuring ? moratInterest : 0)),
    totalInterest: round(e * tenureMonths + (payInterestDuring ? moratInterest : 0) - principal), base: round(base),
  };
}
export function fortnightStart(dateStr, anchorMonday) {
  const d = Date.parse(dateStr), a = Date.parse(anchorMonday);
  const n = Math.floor((d - a) / (14 * 864e5));
  return new Date(a + n * 14 * 864e5).toISOString().slice(0, 10);
}

// ---------- SIPs ----------
/** Work out the SIP schedule (amount and day of month for each instalment), then mark every month's
 *  instalments as paid, missed or due. A missed instalment is one the statement covers but never shows. */
export function sipPlan(txns, today) {
  const inv = txns.filter(t => t.debit > 0 && t.cat === 'invest');
  const cover = {};
  txns.forEach(t => { const b = (cover[t.bank] ??= { from: t.date, to: t.date }); if (t.date < b.from) b.from = t.date; if (t.date > b.to) b.to = t.date; });
  // group by payee + amount, then split by day of month where days are 3+ apart
  const groups = {};
  inv.forEach(t => (groups[t.payee + '|' + Math.round(t.debit)] ??= []).push(t));
  const slots = [];
  for (const list of Object.values(groups)) {
    const days = [...new Set(list.map(t => +t.date.slice(8)))].sort((a, b) => a - b);
    const buckets = []; days.forEach(d => { const b = buckets[buckets.length - 1]; if (b && d - b[b.length - 1] < 3) b.push(d); else buckets.push([d]); });
    for (const b of buckets) {
      const items = list.filter(t => b.includes(+t.date.slice(8)));
      const byMonth = {}; items.forEach(t => (byMonth[t.date.slice(0, 7)] ??= []).push(t));
      const months = Object.keys(byMonth);
      if (months.length < 3) continue;
      const bank = items[0].bank, cv = cover[bank];
      const allMonths = monthsBetween(cv.from.slice(0, 7), cv.to.slice(0, 7));
      const day = b[0];
      // months where the statement fully covers the slot's day (+5 days for weekends/holidays)
      const covered = allMonths.filter(m => cv.from <= `${m}-${String(day).padStart(2, '0')}` && cv.to >= `${m}-${String(Math.min(28, day + 5)).padStart(2, '0')}`);
      const count = median(covered.map(m => (byMonth[m] || []).length).filter(n => n > 0));
      slots.push({ payee: items[0].payee, name: payeeName(items[0]), amount: Math.round(items[0].debit), day, count, bank, byMonth, covered, cover: cv });
    }
  }
  slots.sort((a, b) => a.day - b.day || b.amount - a.amount);
  const monthly = slots.reduce((s, x) => s + x.amount * x.count, 0);
  // per-month status
  const allM = [...new Set(slots.flatMap(s => monthsBetween(s.cover.from.slice(0, 7), (today > s.cover.to ? today : s.cover.to).slice(0, 7))))].sort();
  const months = {};
  for (const m of allM) {
    const rows = [];
    for (const s of slots) {
      const paid = (s.byMonth[m] || []).length;
      const dueDate = `${m}-${String(s.day).padStart(2, '0')}`;
      const isCovered = s.covered.includes(m);
      const statementEnds = s.cover.to;
      let status;
      if (paid >= s.count) status = 'paid';
      else if (isCovered) status = paid ? 'partial' : 'missed';
      else if (dueDate > statementEnds) status = dueDate >= today ? 'due' : 'unknown';
      else status = 'unknown';
      rows.push({ ...s, m, paid, status, dueDate, missedAmt: status === 'missed' || status === 'partial' ? (s.count - paid) * s.amount : 0 });
    }
    const charges = txns.filter(t => t.date.startsWith(m) && t.debit > 0 && /NACH FAIL|ECS RTN|MANDATE ?RET|RETURN ?CHG|INSUF/i.test(t.desc)).reduce((a, t) => a + t.debit, 0);
    months[m] = { rows, missed: rows.reduce((a, r) => a + r.missedAmt, 0), paid: rows.reduce((a, r) => a + Math.min(r.paid, r.count) * r.amount, 0), charges: Math.round(charges * 100) / 100 };
  }
  return { slots, monthly, months };
}
