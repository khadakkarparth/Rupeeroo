// Synthetic statements for demos and screen recordings. No real person or account.
export function makeDemo(endDate = new Date()) {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const pick = a => a[(rnd() * a.length) | 0];
  const ref = () => String(100000000000 + ((rnd() * 899999999999) | 0));
  const holder = 'DEMO KUMAR SHARMA';
  const rows = { SBI: [], IndusInd: [] };
  const add = (bank, date, debit, credit, desc, type = debit ? 'WDL TFR' : 'DEP TFR') => rows[bank].push({ date, debit: +debit.toFixed(2), credit: +credit.toFixed(2), desc, type });
  const upiS = (dir, name, bankc, vpa) => `UPI/${dir}/${ref()}/${name}/${bankc}/${vpa}/UPI`;
  const upiI = (dir, name, bankc, vpa) => `UPI/${ref()}/${dir}/${name}/${bankc}/${vpa}`;

  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate() - 3));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 864e5)) {
    const ds = d.toISOString().slice(0, 10), dom = d.getUTCDate(), dow = d.getUTCDay();
    if (dom === 1) add('SBI', ds, 0, 58000, 'N/SBIN' + ref() + '/ACME ANALYTICS PVT LTD', 'DEP TFR');
    if (dom === 3) add('SBI', ds, 14000, 0, upiS('DR', 'MRSSHARMA', 'HDFC', 'flatowner@okhdfcbank'));
    if (dom === 5) { add('SBI', ds, 12000, 0, `IMPS/P2A/${ref()}/INDB/DEMO KUMAR SHARMA`); add('IndusInd', ds, 0, 12000, `IMPS/P2A/${ref()}/SBIN/DEMO KUMAR SHARMA`, ''); }
    if (dom === 6) add('IndusInd', ds, 2500, 0, upiI('DR', 'FITZONE GYM', 'ICIC', 'fitzone.gym@icici'), '');
    if (dom === 10) add('SBI', ds, 5000, 0, 'NACH00000000012345 NSEClearingLTD');
    if (dom === 12) add('SBI', ds, 199, 0, upiS('DR', 'NETFLIX', 'HDFC', 'netflixupi.payu'));
    if (dom === 20) add('SBI', ds, 349, 0, upiS('DR', 'JIO', 'UTIB', 'jiomobility@axis'));
    if (dom === 28) add('SBI', ds, 195, 0, upiS('DR', 'APPLEME', 'HDFC', 'appleservices.bdsi'));
    if (dow === 6 || rnd() < 0.08) add('IndusInd', ds, 300 + rnd() * 900, 0, upiI('DR', pick(['BLINKIT', 'ZEPTO', 'BBNOW']), 'HDFC', pick(['blinkit.rz@hdfcbank', 'zepto.payu@hdfcbank', 'bbnow.ebz@hdfcbank'])), '');
    if (rnd() < 0.18) add('SBI', ds, 180 + rnd() * 520, 0, upiS('DR', pick(['SWIGGY', 'ZOMATO']), 'YESB', pick(['swiggyupi@axb', 'payzomato@hdfcbank'])));
    if (rnd() < 0.55) add('SBI', ds, 20 + Math.round(rnd() * 22) * 10, 0, upiS('DR', pick(['RAMU CHAI', 'SHREE GANESH', 'MAULI PAN', 'FRESH JUICE', 'ANNA DOSA']), 'YESB', 'paytmqr' + ((rnd() * 900) | 0)));
    if (rnd() < 0.14) add('SBI', ds, 90 + rnd() * 260, 0, upiS('DR', pick(['UBER', 'RAPIDO', 'OLA']), 'UTIB', pick(['uber.payu@axis', 'rapido@ybl', 'olacabs@ybl'])));
    if (rnd() < 0.05) add('IndusInd', ds, 400 + rnd() * 2600, 0, upiI('DR', pick(['AMAZON', 'MYNTRA', 'DECATHLON']), 'YESB', pick(['amazonupi@apl', 'myntradesign@ybl', 'decathlonsports@hdfcbank'])), '');
    if (rnd() < 0.04) add('SBI', ds, 250 + rnd() * 550, 0, upiS('DR', pick(['PVR', 'BOOKMYSHOW']), 'ICIC', 'bookmyshow@icici'));
    if (rnd() < 0.07) add('SBI', ds, 100 + Math.round(rnd() * 15) * 50, 0, upiS('DR', pick(['ROHANP', 'SNEHAK', 'AMITJ']), 'SBIN', '98' + ((rnd() * 1e8) | 0)));
    if (rnd() < 0.03) add('SBI', ds, 0, 200 + Math.round(rnd() * 10) * 100, upiS('CR', pick(['ROHANP', 'SNEHAK']), 'SBIN', '98' + ((rnd() * 1e8) | 0)));
    if (dom === 15 && d.getUTCMonth() === (end.getUTCMonth() + 10) % 12) add('IndusInd', ds, 18500, 0, 'VISA POS TXN AT IN/IDP EDUCATION IELTS', '');
    if (dom === 25 && rnd() < 0.5) add('SBI', ds, 0, 0, '', '');
  }
  const txns = [], statements = [];
  for (const [bank, list] of Object.entries(rows)) {
    const acct = bank === 'SBI' ? '0001' : '0002';
    let bal = bank === 'SBI' ? 42000 : 8000;
    list.filter(r => r.debit || r.credit).sort((a, b) => a.date.localeCompare(b.date)).forEach((r, i) => {
      bal = +(bal - r.debit + r.credit).toFixed(2);
      txns.push({ id: [bank, acct, r.date, r.debit, r.credit, bal, i].join('|'), bank, acct, date: r.date, type: r.type, desc: r.desc, ref: '', debit: r.debit, credit: r.credit, balance: bal, seq: i });
    });
    const mine = txns.filter(t => t.bank === bank);
    statements.push({ bank, acct, from: mine[0].date, to: mine[mine.length - 1].date, importedAt: new Date().toISOString().slice(0, 10),
      checks: { count: mine.length, drCount: mine.filter(t => t.debit).length, crCount: mine.filter(t => t.credit).length, balanceBreaks: 0 } });
  }
  return { txns, statements, holder };
}
