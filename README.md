# RupeeRoo 🦘

A private budget tracker for Indian bank statements, built for a student moving from India to Australia.
Drop in PDF statements from **SBI** or **IndusInd** and RupeeRoo sorts every transaction, finds fixed costs,
forecasts everyday spending as a range, and shows a "safe to spend" figure in both rupees and Australian dollars.

**Your statements never leave your phone.** PDFs are read in the browser with Mozilla pdf.js, data is kept in
the browser's local storage, and the page's Content Security Policy only allows network calls to the
exchange-rate APIs. There is no server and no account.

## Features

| Area | What it does |
|---|---|
| Import | Reads SBI and IndusInd PDF statements (password-protected ones too). Every row is checked against the running balance; SBI imports are also reconciled with the bank's own debit/credit totals. Re-importing the same statement skips duplicates. |
| Categories | Rules for Indian payees (UPI handles, Swiggy, Blinkit, NACH SIPs, FASTag, etc.). Fix one transaction and the rule is remembered for that payee. Transfers between your own accounts are matched across banks and left out of spending. |
| Suspense & lookup | Anything the built-in merchant list can't name goes to Suspense. A review screen sorts payees biggest first: pick a category once per payee, accept suggestions (same surname → Family, or an OpenStreetMap match), or tap Search web. The OpenStreetMap lookup only sends shop names you tick, one per second, and never applies a result without your OK. |
| SIPs | Finds each SIP instalment (amount and day of month) from repeating auto-debits, shows this month's paid / due / bounced status, and flags bounced SIPs with the bank's penalty charges. SIPs count as savings; an extra savings goal sits on top. |
| Dashboard | Spending by month and by category, with a table view for every chart. |
| Plan | Fixed costs found from payments that repeat with the same amount in 3+ months. A 30-day forecast of everyday spending built by resampling your last 90 days (10th–90th percentile range). Safe to spend = income − fixed − savings goal − spent so far. |
| ₹ / A$ | Every amount in both currencies. Live mid-market rate from Coinbase's public API, refreshed every minute while the app is open, with today's low and high. 7- and 30-day lows and highs from ECB daily rates (frankfurter.dev; fallback open.er-api.com). Alerts when the rate is near a low or high. Manual rate entry when offline. |
| Game layer | Budget health bar, under-budget streaks, no-spend days, monthly quests set from last month's numbers, and levels for savings milestones up to "Sydney Ready". |
| Sydney mode | Visa living-cost check against AUD 29,710, a 48-hours-per-fortnight work tracker, and an education loan EMI view with moratorium interest. |

## Run it

It is a static site with no build step.

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

### Publish on GitHub Pages
1. Create a repository and push this folder.
2. Settings → Pages → Deploy from branch → `main` / root.
3. Open `https://<username>.github.io/<repo>/` on your phone and "Add to Home Screen".

## How the parser works

Each PDF page is read as positioned text. A row starts wherever a date sits in the first column; the last three
numbers on that line are debit, credit and balance; wrapped narration lines are attached to the nearest row above.
The same code handles SBI (dd/mm/yyyy, oldest first) and IndusInd (dd Mon yyyy, newest first). After parsing,
`previous balance − debit + credit = balance` is checked for every row.

Tested on a real SBI statement (384 rows, 30 pages: counts and totals match the bank's summary exactly) and
a real IndusInd statement (67 rows, 6 pages: zero balance mismatches).

## Files

```
index.html            app shell and Content Security Policy
css/app.css           mobile-first styles, light and dark
js/parser.js          PDF → transactions (SBI, IndusInd) and checks
js/engine.js          categories, transfers, recurring costs, forecast, game, loan maths
js/lookup.js          optional OpenStreetMap lookup for shop names
js/fx.js              live rate (Coinbase), daily history (ECB), lows/highs and alerts
js/app.js             UI, storage, import flow
js/demo.js            synthetic data for demos (no real person or account)
vendor/               pdf.js 4.10 (Apache-2.0)
```

## Limits

- Only SBI and IndusInd layouts for now. A scanned (image) statement has no text to read.
- Browser storage can be cleared by the phone. Use Settings → Export backup.
- Rate alerts only fire while the page is open; push notifications would need a small server.
- Visa and work-hour figures were correct in Nov 2026. Check Home Affairs before relying on them.
