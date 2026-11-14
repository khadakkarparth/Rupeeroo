// Statement parser for Indian bank PDF statements. SBI and IndusInd have tuned readers;
// every other bank goes through a header-detecting generic reader checked against the running balance.
// Works on pdf.js text items (x, y, string). Runs entirely in the browser.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_PATTERNS = [
  { re: /^(\d{2})\/(\d{2})\/(\d{4})$/, f: m => [m[3], m[2], m[1]] },            // 01/04/2026 (SBI)
  { re: /^(\d{2})-(\d{2})-(\d{4})$/, f: m => [m[3], m[2], m[1]] },              // 01-04-2026
  { re: /^(\d{2}) ([A-Za-z]{3}) (\d{4})$/, f: m => [m[3], String(MONTHS[m[2].toLowerCase()]).padStart(2, '0'), m[1]] }, // 06 Nov 2026 (IndusInd)
  { re: /^(\d{2})-([A-Za-z]{3})-(\d{4})$/, f: m => [m[3], String(MONTHS[m[2].toLowerCase()]).padStart(2, '0'), m[1]] },
];
// looser formats used by the generic reader: 1/4/26, 01-04-26, 01.04.2026, 01-Apr-26, 01 Apr 26, 01Apr2026
const yy = y => (y.length === 2 ? '20' + y : y);
const pad = n => String(n).padStart(2, '0');
const LOOSE_DATES = [
  { re: /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/, f: m => [yy(m[3]), pad(m[2]), pad(m[1])] },
  { re: /^(\d{1,2})[ -]?([A-Za-z]{3})[a-z]*[ ,-]*(\d{2}|\d{4})$/, f: m => [yy(m[3]), pad(MONTHS[m[2].toLowerCase()]), pad(m[1])] },
  { re: /^(\d{4})-(\d{2})-(\d{2})$/, f: m => [m[1], m[2], m[3]] },
];
export function parseLooseDate(s) {
  s = s.trim().replace(/\s+/g, ' ');
  for (const p of LOOSE_DATES) {
    const m = s.match(p.re);
    if (!m) continue;
    const [y, mo, d] = p.f(m);
    if (mo === 'undefined' || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +y < 2000 || +y > 2099) return null;
    return `${y}-${mo}-${d}`;
  }
  return null;
}
const AMOUNT_RE = /^-?[\d,]+\.\d{2}(CR|DR|Cr|Dr)?$/;
const HEADER_WORDS = /^(date|particulars|description|narration|details|balance|withdrawal|deposit|debit|credit|chq no\/ref no|ref no\.?\/cheque no\.?|value date|txn date)$/i;

export function parseDate(s) {
  s = s.trim();
  for (const p of DATE_PATTERNS) {
    const m = s.match(p.re);
    if (m) { const [y, mo, d] = p.f(m); if (mo === 'undefined') return null; return `${y}-${mo}-${d}`; }
  }
  return null;
}
const isAmountish = s => s === '-' || AMOUNT_RE.test(s);
const toNum = s => (s === '-' ? 0 : parseFloat(s.replace(/,|CR|DR|Cr|Dr/g, '')) || 0);
const round2 = n => Math.round(n * 100) / 100;

/** Read a PDF into pages of positioned text items. */
export async function extractPages(pdfjs, data, password) {
  const doc = await pdfjs.getDocument({ data, password, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: it.str.trim() }));
    pages.push({ items });
  }
  return pages;
}

// Order matters: a statement mentions other banks in narrations (NEFT from HDFC, etc.), so we look at
// the first page's header text first, and use IFSC prefixes, which name the account's own branch.
const BANKS = [
  ['IndusInd', /INDUSIND|INDUS PIONEER|INDIE MOBILE/, /INDB0/],
  ['SBI', /STATE BANK OF INDIA/, /SBIN0/],
  ['HDFC', /HDFC BANK/, /HDFC0/],
  ['ICICI', /ICICI BANK/, /ICIC0/],
  ['Axis', /AXIS BANK/, /UTIB0/],
  ['Kotak', /KOTAK MAHINDRA BANK|KOTAK BANK/, /KKBK0/],
  ['IDBI', /IDBI BANK/, /IBKL0/],
  ['IDFC FIRST', /IDFC FIRST BANK|IDFC BANK/, /IDFB0/],
  ['PNB', /PUNJAB NATIONAL BANK/, /PUNB0/],
  ['BoB', /BANK OF BARODA/, /BARB0/],
  ['Canara', /CANARA BANK/, /CNRB0/],
  ['Union', /UNION BANK OF INDIA/, /UBIN0/],
];
export const SUPPORTED_BANKS = BANKS.map(b => b[0]);
export function detectBank(pages) {
  // the header area: everything on page 1 above the transaction table's column titles
  const p1 = [...(pages[0]?.items || [])].sort((a, b) => b.y - a.y);
  const balHdr = p1.find(i => /^(closing |running )?balance\b/i.test(i.s) && p1.some(j => Math.abs(j.y - i.y) < 4 && /date/i.test(j.s)));
  const firstRow = p1.find(i => i.x < 200 && (parseLooseDate(i.s) || parseLooseDate(i.s.split(' ')[0])) && p1.some(j => Math.abs(j.y - i.y) < 3 && AMT_TOKEN.test(j.s)));
  const cut = balHdr ? balHdr.y + 3 : firstRow ? firstRow.y + 3 : -Infinity;
  const headItems = p1.filter(i => i.y > cut).slice(0, 80);
  const head = headItems.map(i => i.s).join(' ').toUpperCase().replace(/([A-Z]{4})O(?=\d{6})/g, '$10');
  const all = pages.flatMap(p => p.items.map(i => i.s)).join(' ').toUpperCase();
  // 1. IFSC of the account's own branch, near the top of page 1
  for (const [name, , ifsc] of BANKS) if (ifsc.test(head)) return name;
  // 2. bank name near the top of page 1
  for (const [name, re] of BANKS) if (re.test(head)) return name;
  // 3. an unlisted bank: use its own name from the letterhead
  const own = headItems.find(i => /\b(bank|co-?op(erative)?)\b/i.test(i.s) && i.s.length <= 48 && !/statement|account|ifsc|branch|address/i.test(i.s));
  // 4. legacy rules for the two tuned readers
  if (!own && /INDB\d|INDUSIND|INDUS PIONEER|INDIE MOBILE/.test(all)) return 'IndusInd';
  if (!own && /STATE BANK OF INDIA|SBIN\d/.test(pages.slice(0, 2).flatMap(p => p.items.map(i => i.s)).join(' ').toUpperCase())) return 'SBI';
  if (own) return own.s.replace(/\s+(ltd|limited)\.?$/i, '').replace(/\w\S*/g, w => w.length > 3 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).trim();
  return 'Other bank';
}

function groupLines(items, tol = 1.6) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find(l => Math.abs(l.y - it.y) <= tol);
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
  return lines;
}

/** Core table parser: anchors rows on a date in the first column, reads the last three
 *  numeric cells as debit / credit / balance, and gathers wrapped description lines. */
export function parseStatement(pages, bankHint) {
  const bank = bankHint || detectBank(pages);
  if (bank !== 'SBI' && bank !== 'IndusInd') return parseGeneric(pages, bank || 'Other');
  const tuned = parseTuned(pages, bank);
  if (tuned.txns.length) return tuned;
  return parseGeneric(pages, bank); // layout changed: let the generic reader try
}

function parseTuned(pages, bank) {
  const txns = [];
  let colDesc = null, colRef = null;

  pages.forEach((page, pi) => {
    const lines = groupLines(page.items, 2.6);
    const anchors = [];
    const anchorItemSet = new Set();

    for (const line of lines) {
      const first = line.items[0];
      if (!first || first.x > 130) continue;
      const date = parseDate(first.s);
      if (!date) continue;
      const toks = line.items;
      // trailing amount cells
      let n = toks.length;
      const amt = [];
      for (let k = n - 1; k >= 0 && amt.length < 3; k--) { if (isAmountish(toks[k].s)) amt.unshift(k); else break; }
      if (amt.length < 3) continue;
      // skip date tokens (txn date + value date)
      let di = 1; while (di < toks.length && parseDate(toks[di].s) && di < amt[0]) di++;
      const refIdx = amt[0] - 1 >= di + 1 ? amt[0] - 1 : -1;
      const descToks = toks.slice(di, refIdx === -1 ? amt[0] : refIdx).filter(t => !isAmountish(t.s));
      if (descToks.length) colDesc = descToks[0].x;
      if (refIdx !== -1) colRef = toks[refIdx].x;
      const debit = toNum(toks[amt[0]].s), credit = toNum(toks[amt[1]].s), balance = toNum(toks[amt[2]].s);
      const a = {
        y: line.y, date, debit, credit, balance,
        ref: refIdx !== -1 && toks[refIdx].s !== '-' ? toks[refIdx].s : '',
        parts: [], page: pi,
      };
      descToks.forEach(t => { a.parts.push(t); anchorItemSet.add(t); });
      toks.forEach(t => anchorItemSet.add(t));
      anchors.push(a);
    }
    if (colDesc == null) return;
    const lo = colDesc - 4, hi = (colRef ?? colDesc + 160) - 4;

    // assign wrapped description lines
    const orphans = [];
    for (const it of page.items) {
      if (anchorItemSet.has(it) || it.x < lo || it.x >= hi) continue;
      if (HEADER_WORDS.test(it.s)) continue;
      let best = null;
      for (const a of anchors) if (a.y >= it.y - 9 && (!best || a.y < best.y)) best = a;
      if (best) { if (best.y - it.y <= 42) best.parts.push(it); }
      else if (!anchors.length || it.y > anchors[0].y) orphans.push(it);
    }
    // text at the top of a page that continues the last row of the previous page
    if (orphans.length && txns.length) {
      const last = txns[txns.length - 1];
      const firstAnchorY = anchors.length ? Math.max(...anchors.map(a => a.y)) : -Infinity;
      orphans.filter(o => o.y - firstAnchorY > 9).forEach(o => last.parts.push({ ...o, y: o.y - 10000 }));
    }
    anchors.sort((a, b) => b.y - a.y).forEach(a => txns.push(a));
  });

  // Build description strings
  const out = txns.map((t, i) => {
    const parts = [...t.parts].sort((a, b) => b.y - a.y || a.x - b.x);
    const pre = [], body = [];
    parts.forEach(p => (p.y > t.y + 3 && p.y < t.y + 9 ? pre : body).push(p));
    // body lines are hard-wrapped by width, so join without spaces between lines
    const bodyLines = groupLines(body).map(l => l.items.map(x => x.s).join(' '));
    // SBI wraps on word boundaries when a line ends short; IndusInd wraps at a fixed width
    let desc = bank === 'SBI'
      ? bodyLines.reduce((acc, l, k) => acc + (k && bodyLines[k - 1].length <= 23 ? ' ' : '') + l, '')
      : bodyLines.join('');
    desc = desc.replace(/\s?\d{10,}\s?AT\s?\d{5}.*$/i, '').trim(); // SBI branch tail
    return {
      bank, date: t.date, type: pre.map(p => p.s).join(' '), desc,
      debit: round2(t.debit), credit: round2(t.credit), balance: round2(t.balance), ref: t.ref, seq: i,
    };
  });

  // order chronologically (IndusInd prints newest first)
  if (out.length > 1 && out[0].date > out[out.length - 1].date) out.reverse();
  out.forEach((t, i) => (t.seq = i));

  return { bank, txns: out, checks: runChecks(out, pages), holder: findHolder(pages, bank), acct: findAccount(pages, bank) };
}

function runChecks(txns, pages) {
  let breaks = 0, fixed = 0;
  for (let i = 1; i < txns.length; i++) {
    const p = txns[i - 1], t = txns[i];
    const expect = round2(p.balance - t.debit + t.credit);
    if (Math.abs(expect - t.balance) > 0.011) {
      // try swapping debit/credit (column misread)
      const alt = round2(p.balance + t.debit - t.credit);
      if (Math.abs(alt - t.balance) <= 0.011) { [t.debit, t.credit] = [t.credit, t.debit]; fixed++; }
      else breaks++;
    }
  }
  const dr = txns.filter(t => t.debit > 0), cr = txns.filter(t => t.credit > 0);
  const res = {
    count: txns.length, drCount: dr.length, crCount: cr.length,
    totalDebit: round2(dr.reduce((s, t) => s + t.debit, 0)),
    totalCredit: round2(cr.reduce((s, t) => s + t.credit, 0)),
    balanceBreaks: breaks, swapped: fixed,
    from: txns[0]?.date, to: txns[txns.length - 1]?.date,
  };
  // SBI prints a statement summary we can reconcile against
  const summary = findSbiSummary(pages);
  const box = summary ? null : findBoxSummary(pages);
  if (box) {
    // "Opening Balance · Total Debit · Total Credit · Closing Balance" box (IDFC FIRST, Kotak, others)
    res.summary = box;
    const first = txns[0], last = txns[txns.length - 1];
    const openOk = box.opening == null || !first || Math.abs(round2(first.balance + first.debit - first.credit) - box.opening) < 0.02;
    const closeOk = box.closing == null || !last || Math.abs(last.balance - box.closing) < 0.02;
    res.summaryMatch = Math.abs(box.totalDebit - res.totalDebit) < 0.02 && Math.abs(box.totalCredit - res.totalCredit) < 0.02 && openOk && closeOk;
  }
  if (summary) {
    res.summary = summary;
    res.summaryMatch = summary.drCount === res.drCount && summary.crCount === res.crCount &&
      Math.abs(summary.totalDebit - res.totalDebit) < 0.02 && Math.abs(summary.totalCredit - res.totalCredit) < 0.02;
  }
  return res;
}

function findBoxSummary(pages) {
  const num = s => { const m = s.replace(/[₹,\s]|INR|Rs\.?/gi, '').match(/^-?\d+(\.\d+)?$/); return m ? parseFloat(m[0]) : null; };
  for (const page of pages.slice(0, 2)) {
    const lines = groupLines(page.items, 2.6);
    for (let k = 0; k < lines.length - 1; k++) {
      const labs = lines[k].items;
      const td = labs.find(i => /^total\s*(debits?|withdrawals?)(\s*amount)?$/i.test(i.s));
      const tc = labs.find(i => /^total\s*(credits?|deposits?)(\s*amount)?$/i.test(i.s));
      if (!td || !tc) continue;
      const vals = lines.slice(k + 1, k + 3).flatMap(l => l.items).filter(i => num(i.s) != null && lines[k].y - i.y < 30);
      const near = lab => { if (!lab) return null; const c = lab.x + (lab.w || lab.s.length * 4.5) / 2; const v = vals.map(i => ({ i, d: Math.abs(i.x + (i.w || i.s.length * 4.5) / 2 - c) })).sort((a, b) => a.d - b.d)[0]; return v && v.d < 90 ? num(v.i.s) : null; };
      const op = labs.find(i => /^opening\s*balance$/i.test(i.s)), cl = labs.find(i => /^closing\s*balance$/i.test(i.s));
      const out = { totalDebit: near(td), totalCredit: near(tc), opening: near(op), closing: near(cl) };
      if (out.totalDebit != null && out.totalCredit != null) return out;
    }
  }
  return null;
}

function findSbiSummary(pages) {
  for (const page of pages) {
    const hdr = page.items.find(i => /^Total Debits/.test(i.s));
    if (!hdr) continue;
    const lines = groupLines(page.items.filter(i => i.y < hdr.y - 5 && i.y > hdr.y - 45), 3);
    const line = lines[0];
    if (!line) continue;
    const v = line.items.map(i => i.s);
    if (v.length < 6) continue;
    return { drCount: +v[1], crCount: +v[2], totalDebit: toNum(v[3]), totalCredit: toNum(v[4]), closing: toNum(v[5]) };
  }
  return null;
}

// ---------------- generic reader ----------------
// 1. find the table's column titles and work out which column is which
// 2. start a row at every line that begins with a date, gather wrapped narration lines under it
// 3. read amounts by column, then check every row against the running balance and fix the direction
const ROLE_RULES = [
  ['serial', /^(s\.?\s?no\.?|sl\.?\s?no\.?|sr\.?\s?no\.?|#)$/i],
  ['vdate', /^value\s*(date|dt\.?)$/i],
  ['date', /^(txn\.?|tran\.?|trans\.?|transaction|post(ed|ing)?|book(ing)?)?\s*(date|dt\.?)$/i],
  ['ref', /(chq|cheque|ref|instrument|tran(saction)?\s*id|utr)/i],
  ['debit', /(withdrawal|debit|\bdr\b|paid out|with\.\s*amt)/i],
  ['credit', /(deposit|credit|\bcr\b|paid in|dep\.\s*amt)/i],
  ['balance', /balance|\bbal\b/i],
  ['type', /^(type|dr\s*\/\s*cr|cr\s*\/\s*dr|txn type)$/i],
  ['amount', /^(transaction\s*)?amount|^amt\b/i],
  ['desc', /(narration|particulars|description|details|remarks|transaction\s*remarks)/i],
  ['other', /(branch|init|ccy|currency|code|^mode\**$)/i],
];
const AMT_TOKEN = /^(?:INR|Rs\.?|₹)?\s*\(?(-?[\d,]*\d\.\d{1,2})\)?\s*(?:\(?\s*(CR|DR|Cr|Dr|cr|dr)\.?\s*\)?)?$/;
const MARK_TOKEN = /^\(?(CR|DR|Cr|Dr|CREDIT|DEBIT|Credit|Debit)\.?\)?$/;
const STOP_LINE = /(statement summary|^opening balance|^closing balance|grand total|^total\b|end of statement|computer generated|abbreviation|legend|important information|this is a system|^page\s*\d+\s*(of|\/)\s*\d+$|carried (over|forward)|\*\*\*)/i;
const OPEN_ROW = /(opening balance|balance b\/f|brought forward|balance forward|b\/f balance|^b\/f$|^opening$)/i;

function phrases(line) {
  // join neighbouring header words ("Withdrawal" "Amt.") into one title
  const out = [];
  for (const it of line.items) {
    const last = out[out.length - 1];
    const lastEnd = last ? last.x + (last.w || last.s.length * 4.5) : -1e9;
    if (last && it.x - lastEnd < 5) { last.s += ' ' + it.s; last.w = it.x + (it.w || it.s.length * 4.5) - last.x; }
    else out.push({ ...it });
  }
  return out;
}
function roleOf(s) {
  const t = s.replace(/[()₹]|\(INR\)|INR|Rs\.?/gi, ' ').replace(/\s+/g, ' ').trim();
  for (const [role, re] of ROLE_RULES) if (re.test(t)) return role;
  return null;
}
function findHeader(lines) {
  for (let k = 0; k < lines.length; k++) {
    // titles can wrap onto a second line ("Withdrawal" / "Amt.", "Transaction" / "Date")
    let items = [...lines[k].items];
    const nx = lines[k + 1];
    const nxJoin = nx && lines[k].y - nx.y < 14 && nx.items.every(i => !parseLooseDate(i.s) && !AMT_TOKEN.test(i.s));
    if (nxJoin) items = items.concat(nx.items);
    const text = items.map(i => i.s).join(' ');
    if (!/date|dt\b/i.test(text) || !/balance|bal\b/i.test(text) || items.some(i => parseLooseDate(i.s))) continue;
    if (!items.filter(i => roleOf(i.s)).length || items.filter(i => roleOf(i.s)).length < 3) continue;
    const prev = lines[k - 1];
    if (prev && prev.y - lines[k].y < 14 && prev.items.some(i => roleOf(i.s))) items = items.concat(prev.items);
    // merge stacked titles by x overlap, then label
    const cols = [];
    for (const ph of phrases({ items: items.sort((a, b) => a.x - b.x) })) {
      const c = cols.find(c => ph.x < c.x + c.w + 2 && ph.x + (ph.w || 20) > c.x - 2 && Math.abs(c.y - ph.y) > 2);
      if (c) { c.s += ' ' + ph.s; c.x = Math.min(c.x, ph.x); c.w = Math.max(c.x + c.w, ph.x + (ph.w || 20)) - c.x; }
      else cols.push({ ...ph, w: ph.w || ph.s.length * 4.5 });
    }
    let seenDate = false;
    cols.forEach(c => {
      c.role = roleOf(c.s);
      if (c.role === 'date') { if (seenDate) c.role = 'vdate'; seenDate = true; }
      // "Withdrawal (Dr)/ Deposit (Cr)" in one column = single amount column
      if (/withdrawal|debit/i.test(c.s) && /deposit|credit/i.test(c.s)) c.role = 'amount';
      if (/balance/i.test(c.s)) c.role = 'balance';
    });
    if (!cols.some(c => c.role === 'balance') || !cols.some(c => c.role === 'date' || c.role === 'vdate')) continue;
    if (!cols.some(c => c.role === 'date')) cols.find(c => c.role === 'vdate').role = 'date';
    cols.sort((a, b) => a.x - b.x);
    return { y: nxJoin ? nx.y : lines[k].y, cols, k };
  }
  return null;
}
function colFor(cols, it) {
  // nearest column by horizontal distance between the token's span and the title's span
  const a = it.x, b = it.x + (it.w || it.s.length * 4.5);
  let best = null, bd = Infinity;
  for (const c of cols) {
    const d = Math.max(0, c.x - b, a - (c.x + c.w));
    const centre = Math.abs((a + b) / 2 - (c.x + c.w / 2)) / 1000;
    if (d + centre < bd) { bd = d + centre; best = c; }
  }
  return best;
}
function parseAmt(s) {
  const m = s.replace(/\s+/g, ' ').match(AMT_TOKEN);
  if (!m) return null;
  return { v: Math.abs(parseFloat(m[1].replace(/,/g, ''))), neg: m[1].startsWith('-') || /^\(.*\)$/.test(s), mark: m[2] ? m[2].toUpperCase() : '' };
}

export function parseGeneric(pages, bank) {
  let cols = null;
  const rows = [];
  let opening = null;
  pages.forEach(page => {
    const lines = groupLines(page.items, 2.6);
    const hdr = findHeader(lines);
    if (hdr) cols = hdr.cols;
    const startK = hdr ? lines.findIndex(l => l.y < hdr.y - 1) : 0;
    if (startK < 0) return;
    const dateCol = cols?.find(c => c.role === 'date');
    const descCol = cols?.find(c => c.role === 'desc');
    const firstAmtX = cols ? Math.min(...cols.filter(c => ['debit', 'credit', 'amount', 'balance'].includes(c.role)).map(c => c.x)) : Infinity;
    let cur = null, stopped = false;
    for (const line of lines.slice(startK)) {
      const text = line.items.map(i => i.s).join(' ');
      // a row starts with a date in the date column (after an optional serial number)
      let dIdx = -1;
      for (let j = 0; j < Math.min(3, line.items.length); j++) {
        const it = line.items[j];
        if (dateCol && colFor(cols, it)?.role !== 'date' && colFor(cols, it)?.role !== 'vdate') continue;
        if (!dateCol && it.x > 200) break;
        if (parseLooseDate(it.s) || parseLooseDate(it.s.split(' ')[0])) { dIdx = j; break; }
        if (j + 2 < line.items.length && parseLooseDate(line.items.slice(j, j + 3).map(t => t.s).join(' '))) { dIdx = j; break; }
      }
      if (dIdx >= 0) {
        stopped = false;
        cur = { lines: [line], dIdx };
        rows.push(cur);
        continue;
      }
      if (STOP_LINE.test(text.trim())) {
        const ob = text.match(/opening balance[^\d-]*(-?[\d,]+\.\d{2})/i);
        if (ob && opening == null) opening = parseFloat(ob[1].replace(/,/g, ''));
        stopped = true; continue;
      }
      if (cur && !stopped && cur.lines[cur.lines.length - 1].y - line.y < 40) cur.lines.push(line);
    }
    // read each finished row on this page with this page's columns
    rows.filter(r => !r.cols).forEach(r => { r.cols = cols; r.firstAmtX = firstAmtX; r.descCol = descCol; });
  });

  const out = [];
  for (const r of rows) {
    const items = r.lines.flatMap(l => l.items);
    const head = r.lines[0].items;
    // date: first date token (txn date), joining "01 Apr 2026" style split tokens
    let date = null, used = new Set();
    for (let j = r.dIdx; j < Math.min(head.length, r.dIdx + 3) && !date; j++) {
      for (let n = 3; n >= 1 && !date; n--) {
        const grp = head.slice(j, j + n);
        if (grp.length < n) continue;
        const d = parseLooseDate(grp.map(t => t.s).join(' ')) || (n === 1 ? parseLooseDate(grp[0].s.split(' ')[0]) : null);
        if (d) { date = d; grp.forEach(t => used.add(t)); }
      }
    }
    if (!date) continue;
    const C = r.cols;
    const amts = [], marks = [], desc = [], ref = [];
    for (const it of items) {
      if (used.has(it)) continue;
      const col = C ? colFor(C, it) : null;
      const role = col?.role;
      if (role === 'vdate' || role === 'serial' || (role === 'date' && parseLooseDate(it.s.split(' ')[0]))) continue;
      const a = parseAmt(it.s);
      const inAmtArea = C ? ['debit', 'credit', 'amount', 'balance'].includes(role) : it.x > 250;
      if (a && inAmtArea) { amts.push({ ...a, it, role: role || '' }); continue; }
      if (MARK_TOKEN.test(it.s) && (role === 'type' || !role || ['amount', 'balance', 'debit', 'credit'].includes(role))) { marks.push({ m: it.s.replace(/[().]/g, '').toUpperCase().slice(0, 2), it }); continue; }
      if (/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i.test(it.s) || /^(AM|PM)$/i.test(it.s) || /^(INR|Rs\.?)$/i.test(it.s)) continue;
      if (role === 'ref') { ref.push(it); continue; }
      if (role === 'type' || role === 'other') continue;
      desc.push(it);
    }
    if (!amts.length) continue;
    // a separate Dr/Cr marker belongs to the amount just left of it
    for (const mk of marks) {
      const host = amts.filter(a => a.it.x < mk.it.x + 2 && Math.abs(a.it.y - mk.it.y) < 12).sort((a, b) => b.it.x - a.it.x)[0];
      if (host && !host.mark) host.mark = mk.m; else if (!host) r.typeMark = mk.m;
    }
    const balTok = amts.filter(a => a.role === 'balance').sort((a, b) => b.it.x - a.it.x)[0] || [...amts].sort((a, b) => b.it.x - a.it.x)[0];
    const rest = amts.filter(a => a !== balTok && a.v > 0);
    let balance = balTok.v * (balTok.mark === 'DR' || balTok.neg ? -1 : 1);
    let debit = 0, credit = 0, known = false, amount = 0;
    const dr = rest.find(a => a.role === 'debit'), cr = rest.find(a => a.role === 'credit');
    if (dr || cr) { debit = dr?.v || 0; credit = cr?.v || 0; known = true; }
    else if (rest.length) {
      const a = rest[rest.length - 1]; amount = a.v;
      const m = a.mark || r.typeMark || '';
      if (m === 'DR' || a.neg) { debit = amount; known = true; }
      else if (m === 'CR') { credit = amount; known = true; }
    }
    const lineText = items.map(i => i.s).join(' ');
    if (!debit && !credit && !amount) {
      if (OPEN_ROW.test(lineText)) { if (opening == null) opening = balance; continue; }
      continue;
    }
    // wrapped narration: a line that runs to the column's edge was cut mid-word, so join it without a space
    const dl = groupLines(desc).map(l => ({ s: l.items.map(x => x.s).join(' '), end: Math.max(...l.items.map(x => x.x + (x.w || 0))) }));
    const edge = Math.max(...dl.map(l => l.end));
    const descStr = dl.reduce((acc, l, k) => acc + (k && !/[\/\-@]$/.test(dl[k - 1].s) && !/^[\/\-@]/.test(l.s) && !(dl[k - 1].end > edge - 8 && dl.length > 1 && /[A-Za-z0-9@.]$/.test(dl[k - 1].s) && /^[A-Za-z0-9@.]/.test(l.s)) ? ' ' : '') + l.s, '').replace(/\s+/g, ' ').trim();
    out.push({ bank, date, type: '', desc: descStr, ref: ref.map(x => x.s).join(' '), debit, credit, amount: amount || debit || credit, balance, known });
  }

  // chronological order (several banks print newest first)
  if (out.length > 1 && out[0].date > out[out.length - 1].date) out.reverse();
  // running-balance check decides the direction whenever it can
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    const prev = i ? out[i - 1].balance : opening;
    if (prev == null) {
      if (!t.known) { t.debit = t.amount; t.credit = 0; }
      continue;
    }
    const diff = round2(t.balance - prev);
    if (Math.abs(Math.abs(diff) - t.amount) < 0.011 && t.amount) {
      if (diff > 0) { t.credit = t.amount; t.debit = 0; } else { t.debit = t.amount; t.credit = 0; }
    } else if (!t.known) { t.debit = t.amount; t.credit = 0; }
  }
  const txns = out.map((t, i) => ({ bank, date: t.date, type: t.type, desc: t.desc, ref: t.ref, debit: round2(t.debit), credit: round2(t.credit), balance: round2(t.balance), seq: i }));
  return { bank, txns, checks: runChecks(txns, pages), holder: findHolder(pages, bank), acct: findAccount(pages, bank), generic: true, opening };
}

/** Pull a clean counterparty name and UPI handle out of a narration. */
export function counterparty(t) {
  const d = t.desc;
  let m;
  // SBI: UPI/DR/<ref>/<NAME>/<BANK>/<VPA>/<note>
  if ((m = d.match(/^UPI\/(?:DR|CR)\/\d+\/([^/]*)\/([A-Z]{4})\/([^/]*)/i))) return { name: m[1].trim(), vpa: m[3].trim(), via: 'UPI' };
  // IndusInd: UPI/<ref>/DR/<NAME>/<BANK>/<VPA>
  if ((m = d.match(/^UPI\/\d+\/(?:DR|CR)\/([^/]*)\/([A-Z]{4})\/([^/]*)/i))) return { name: m[1].trim(), vpa: m[3].trim(), via: 'UPI' };
  if ((m = d.match(/^(?:IMPS|NEFT|RTGS)\/[^/]*\/[^/]*\/[A-Z]{4}\/(.*)$/i))) return { name: m[1].trim(), vpa: '', via: 'IMPS' };
  if ((m = d.match(/^N\/[A-Z0-9]+\/[^/]*\/(.*)$/i))) return { name: m[1].trim(), vpa: '', via: 'NEFT' };
  if ((m = d.match(/^NEFT\*?[^*]*\*[^*]*\*([^*]*)/i))) return { name: m[1].trim(), vpa: '', via: 'NEFT' };
  if ((m = d.match(/POS TXN AT (?:IN\/)?(.*)$/i))) return { name: m[1].trim(), vpa: '', via: 'Card' };
  // other banks' UPI narrations: pick the handle and the most name-like piece
  if (/\bUPI\b/i.test(d)) {
    const segs = d.split(/[\/\-]+/).map(x => x.trim()).filter(Boolean);
    const vpa = segs.find(x => /@/.test(x)) || '';
    const SKIP = /^(UPI|DR|CR|P2[AMV]|P2P|IN|OUT|REV|PAYMENT|PAY|SENT|RECEIVED|COLLECT|NA|UPI ?INTENT|PAYMENT FROM PH|PAID VIA|[A-Z]{4}0[A-Z0-9]{6}|.*BANK.*|YBL|OKAXIS|OKHDFCBANK|OKSBI|OKICICI|PAYTM)$/i;
    const cands = segs.filter(x => !/@/.test(x) && !/\d{5,}/.test(x) && /[A-Za-z]{3}/.test(x) && !SKIP.test(x));
    const name = cands.sort((a, b) => b.replace(/[^A-Za-z]/g, '').length - a.replace(/[^A-Za-z]/g, '').length)[0] || vpa.split('@')[0] || d.slice(0, 40);
    return { name: name.trim(), vpa, via: 'UPI' };
  }
  if ((m = d.match(/^(?:NEFT|IMPS|RTGS)[\s\-\/:_]+(?:IN[:\-\/]|OUT[:\-\/]|CR[:\-\/]|DR[:\-\/])?.*?([A-Z][A-Z .]{3,})\s*$/i))) return { name: m[1].trim(), vpa: '', via: 'NEFT' };
  if (/ATM|CASH/i.test(d)) return { name: 'Cash withdrawal', vpa: '', via: 'ATM' };
  return { name: d.slice(0, 40), vpa: '', via: '' };
}

function findHolder(pages, bank) {
  const items = [...(pages[0]?.items || [])].sort((a, b) => b.y - a.y || a.x - b.x);
  const t = items.find(i => /^(MR|MS|MRS|MISS)\.?\s+[A-Z][A-Z .]{4,}$/i.test(i.s));
  if (t) return t.s.replace(/^(MR|MS|MRS|MISS)\.?\s+/i, '').trim();
  // "Name : PARTH KHADAKKAR" / "Customer Name" label with the value beside it
  for (const it of items) {
    const m = it.s.match(/^(?:customer\s*|account\s*holder\s*|a\/c\s*)?name\s*[:\-]?\s*(.*)$/i);
    if (!m) continue;
    // the value sits beside the label, or right under it (IndusInd); never another form label
    const LABEL = /\b(status|holding|holder|branch|address|type|nominee|number|no\.?|date|id|code|ifsc|micr|mode|scheme|currency|period|email|phone|mobile|customer|account|statement|balance)\b/i;
    const clean = x => (x || '').replace(/^[:\-\s]+/, '').replace(/^(MR|MS|MRS|MISS)\.?\s+/i, '').trim();
    const ok = x => /^[A-Za-z][A-Za-z .]{3,}$/.test(x) && !LABEL.test(x) && x.split(/\s+/).length <= 5;
    let v = clean(m[1]);
    if (!v) {
      const beside = items.filter(j => Math.abs(j.y - it.y) < 3 && j.x > it.x && j.x - it.x < 260 && !/^:$/.test(j.s)).sort((a, b) => a.x - b.x)[0];
      const under = items.filter(j => j.y < it.y && it.y - j.y < 32 && Math.abs(j.x - it.x) < 30).sort((a, b) => b.y - a.y)[0];
      v = [beside, under].map(j => clean(j?.s)).find(ok) || '';
    }
    if (ok(v)) return v.toUpperCase();
  }
  if (bank === 'IndusInd') {
    const k = items.findIndex(i => /^Account Statement$/i.test(i.s));
    for (let j = k + 1; j < Math.min(items.length, k + 8); j++) if (items[j].x < 150 && /^[A-Z][A-Z .]{5,}$/.test(items[j].s)) return items[j].s.trim();
  }
  return '';
}
/** Only the last four digits are ever kept. */
function findAccount(pages, bank) {
  // the label can sit on page 1 or, in newer SBI layouts, after a summary page
  for (const page of pages.slice(0, 3)) {
    const items = page.items;
    // inline: "A/C NO: 1529104000018285" or "Account No : XXXXXXXX1234"
    const inl = items.find(i => /(account|a\/c)\s*(number|no\.?)?\s*[:.\-]\s*[X*\d]{8,}|(account|a\/c)\s*(number|no\.?)\s*[X*\d]{8,}/i.test(i.s));
    if (inl) return inl.s.match(/[X*\d]{8,}/i)[0].replace(/\D/g, '').slice(-4);
    const lab = items.find(i => /^(account|a\/c|ac)\s*(number|no\.?)\s*:?$/i.test(i.s));
    if (!lab) continue;
    const isNum = i => /^:?\s*[X*\d]{8,18}$/i.test(i.s) && /\d{3}/.test(i.s);
    const same = items.filter(i => isNum(i) && Math.abs(i.y - lab.y) < 3 && i.x > lab.x).sort((a, b) => a.x - b.x);
    const below = items.filter(i => isNum(i) && i.y < lab.y && i.y > lab.y - 40);
    const num = same[0]?.s || below[0]?.s;
    if (num) return num.replace(/\D/g, '').slice(-4);
  }
  const any = (pages[0]?.items || []).find(i => /^\d{11,18}$/.test(i.s));
  return any ? any.s.slice(-4) : '';
}
