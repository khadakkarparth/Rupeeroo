// Statement parser for SBI and IndusInd PDF statements.
// Works on pdf.js text items (x, y, string). Runs entirely in the browser.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_PATTERNS = [
  { re: /^(\d{2})\/(\d{2})\/(\d{4})$/, f: m => [m[3], m[2], m[1]] },            // 01/04/2026 (SBI)
  { re: /^(\d{2})-(\d{2})-(\d{4})$/, f: m => [m[3], m[2], m[1]] },              // 01-04-2026
  { re: /^(\d{2}) ([A-Za-z]{3}) (\d{4})$/, f: m => [m[3], String(MONTHS[m[2].toLowerCase()]).padStart(2, '0'), m[1]] }, // 06 Nov 2026 (IndusInd)
  { re: /^(\d{2})-([A-Za-z]{3})-(\d{4})$/, f: m => [m[3], String(MONTHS[m[2].toLowerCase()]).padStart(2, '0'), m[1]] },
];
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
      .map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() }));
    pages.push({ items });
  }
  return pages;
}

export function detectBank(pages) {
  const text = pages.slice(0, 2).flatMap(p => p.items.map(i => i.s)).join(' ').toUpperCase();
  const all = pages.flatMap(p => p.items.map(i => i.s)).join(' ').toUpperCase();
  if (/INDB\d|INDUSIND|INDUS PIONEER|INDIE MOBILE/.test(all)) return 'IndusInd';
  if (/STATE BANK OF INDIA|SBIN\d/.test(text)) return 'SBI';
  return null;
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
  if (summary) {
    res.summary = summary;
    res.summaryMatch = summary.drCount === res.drCount && summary.crCount === res.crCount &&
      Math.abs(summary.totalDebit - res.totalDebit) < 0.02 && Math.abs(summary.totalCredit - res.totalCredit) < 0.02;
  }
  return res;
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
  if (/ATM|CASH/i.test(d)) return { name: 'Cash withdrawal', vpa: '', via: 'ATM' };
  return { name: d.slice(0, 40), vpa: '', via: '' };
}

function findHolder(pages, bank) {
  const items = [...(pages[0]?.items || [])].sort((a, b) => b.y - a.y || a.x - b.x);
  const t = items.find(i => /^(MR|MS|MRS|MISS)\.?\s+[A-Z][A-Z .]{4,}$/i.test(i.s));
  if (t) return t.s.replace(/^(MR|MS|MRS|MISS)\.?\s+/i, '').trim();
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
    const lab = items.find(i => /^Account (Number|No\.?)$/i.test(i.s));
    if (!lab) continue;
    const same = items.filter(i => /^\d{9,18}$/.test(i.s) && Math.abs(i.y - lab.y) < 3 && i.x > lab.x);
    const below = items.filter(i => /^\d{9,18}$/.test(i.s) && i.y < lab.y && i.y > lab.y - 40);
    const num = same[0]?.s || below[0]?.s;
    if (num) return num.slice(-4);
  }
  const any = (pages[0]?.items || []).find(i => /^\d{11,18}$/.test(i.s));
  return any ? any.s.slice(-4) : '';
}
