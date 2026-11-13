// Student visa (subclass 500) work rules and earnings. Pure functions, no DOM.
//
// Rules (condition 8105), as published by Study Australia, UNSW and other universities (checked Nov 2026):
//  - no work before the course starts
//  - at most 48 hours in any fortnight while the course is in session (teaching, study week and exams)
//  - a fortnight is 14 days starting on a Monday, so every Monday-to-Sunday-week pair is tested
//  - unlimited hours in official breaks between terms; masters by research and PhD students are unlimited
//  - compulsory, credit-bearing work-integrated learning doesn't count; optional placements do
export const RULES = {
  limit: 48,
  warnAt: 40,
  checked: 'November 2026',
  sources: [
    ['Study Australia: working in Australia', 'https://www.studyaustralia.gov.au/en/tools-and-resources/tips-and-advice-for-students/working-in-australia-your-rights-explained'],
    ['UNSW: visa work rights', 'https://student.unsw.edu.au/visa-work'],
    ['UNSW academic calendar', 'https://www.unsw.edu.au/student/managing-your-studies/key-dates/academic-calendar'],
    ['Home Affairs: check your visa conditions (VEVO)', 'https://immi.homeaffairs.gov.au/visas/already-have-a-visa/check-visa-details-and-conditions'],
  ],
};

// UNSW standard calendar. "In session" = teaching + flexibility week + study period + exams.
// 2027 is the last UNSW 3+ trimester year; 2028 moves to the flex-semester calendar.
export const UNSW_SESSIONS = [
  { name: 'Term 1 2027', from: '2027-02-15', to: '2027-05-13' },
  { name: 'Term 2 2027', from: '2027-05-31', to: '2027-08-26' },
  { name: 'Term 3 2027', from: '2027-09-13', to: '2027-12-09' },
  { name: 'Semester 1 2028', from: '2028-02-28', to: '2028-06-19' },
  { name: 'Semester 2 2028', from: '2028-08-14', to: '2028-12-02' },
];
// Optional terms only count as in session if the student enrols in them.
export const UNSW_OPTIONAL = [
  { name: 'Summer Term 2028 (only if enrolled)', from: '2028-01-04', to: '2028-02-15' },
  { name: 'Winter Term 2028 (only if enrolled)', from: '2028-06-20', to: '2028-08-01' },
];

const DAY = 864e5;
export const iso = ms => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => iso(Date.parse(d) + n * DAY);
export const mondayOf = d => { const t = Date.parse(d); const wd = (new Date(t).getUTCDay() + 6) % 7; return iso(t - wd * DAY); };

export function sessionOn(d, cal) { return cal.sessions.find(s => d >= s.from && d <= s.to) || null; }

/** What applies on a given day. */
export function dayRule(d, cal) {
  if (cal.research) return d < cal.courseStart ? 'before' : 'unlimited';
  if (d < cal.courseStart) return 'before';
  return sessionOn(d, cal) ? 'limited' : 'break';
}

const countable = s => !s.wil;

/** Sum hours in the 14-day window starting Monday `m`. */
export function windowHours(m, shifts) {
  const end = addDays(m, 13);
  return shifts.filter(s => countable(s) && s.date >= m && s.date <= end).reduce((a, s) => a + (+s.hours || 0), 0);
}

/** Does the limit apply to this window? Any in-session day in it makes it limited (the safe reading). */
export function windowRule(m, cal) {
  let lim = 0, brk = 0, before = 0;
  for (let i = 0; i < 14; i++) { const r = dayRule(addDays(m, i), cal); if (r === 'limited') lim++; else if (r === 'before') before++; else brk++; }
  return { limited: lim > 0, mixed: lim > 0 && lim < 14, allBreak: lim === 0 && before === 0, before };
}

/** Status for `today`: the two fortnights that contain it, how many hours are left, alerts. */
export function workStatus(shifts, cal, today) {
  const rule = dayRule(today, cal);
  const thisMon = mondayOf(today), lastMon = addDays(thisMon, -7);
  const wins = [lastMon, thisMon].map(m => ({ from: m, to: addDays(m, 13), hours: windowHours(m, shifts), ...windowRule(m, cal) }));
  const limited = wins.filter(w => w.limited);
  const used = limited.length ? Math.max(...limited.map(w => w.hours)) : 0;
  const left = limited.length ? Math.max(0, RULES.limit - used) : Infinity;
  // every Monday-start window that has any shift, newest first, for history and breaches
  const mondays = [...new Set(shifts.flatMap(s => [mondayOf(s.date), addDays(mondayOf(s.date), -7)]))].sort().reverse();
  const history = mondays.map(m => ({ from: m, to: addDays(m, 13), hours: windowHours(m, shifts), ...windowRule(m, cal) }))
    .filter(w => w.hours > 0);
  const breaches = history.filter(w => w.limited && w.hours > RULES.limit);
  const beforeStart = shifts.filter(s => countable(s) && s.date < cal.courseStart && !cal.research);
  const session = sessionOn(today, cal);
  const next = nextChange(today, cal);
  return { rule, session, wins, used, left, history, breaches, beforeStart, next };
}

/** When does the current rule end? (end of term → break starts, or break → next term) */
export function nextChange(today, cal) {
  if (today < cal.courseStart) return { date: cal.courseStart, to: 'limited', label: 'Course starts' };
  const s = sessionOn(today, cal);
  if (s) return { date: addDays(s.to, 1), to: 'break', label: `${s.name} ends` };
  const upcoming = cal.sessions.filter(x => x.from > today).sort((a, b) => a.from.localeCompare(b.from))[0];
  return upcoming ? { date: upcoming.from, to: 'limited', label: `${upcoming.name} starts` } : null;
}

/** Hours you can still add on `date` without breaking either fortnight it sits in. */
export function maxOnDate(date, shifts, cal) {
  const m1 = mondayOf(date), m0 = addDays(m1, -7);
  const caps = [m0, m1].filter(m => windowRule(m, cal).limited).map(m => RULES.limit - windowHours(m, shifts));
  return caps.length ? Math.max(0, Math.min(...caps)) : Infinity;
}

// ---------- earnings ----------
export const shiftPay = (s, jobs) => (s.pay != null && s.pay !== '' ? +s.pay : (+s.hours || 0) * (+(jobs.find(j => j.id === s.jobId)?.rate) || 0));
export function fyOf(d) { const y = +d.slice(0, 4), m = +d.slice(5, 7); const start = m >= 7 ? y : y - 1; return { label: `FY ${start}-${String(start + 1).slice(2)}`, from: `${start}-07-01`, to: `${start + 1}-06-30`, start }; }

export function earnings(shifts, jobs, today) {
  const worked = shifts.filter(s => s.date <= today);
  const sum = (from, to) => worked.filter(s => s.date >= from && s.date <= to).reduce((a, s) => a + shiftPay(s, jobs), 0);
  const hrs = (from, to) => worked.filter(s => s.date >= from && s.date <= to).reduce((a, s) => a + (+s.hours || 0), 0);
  const wk = mondayOf(today), fy = fyOf(today), mo = today.slice(0, 7) + '-01';
  const planned = shifts.filter(s => s.date > today);
  return {
    week: sum(wk, today), weekHrs: hrs(wk, today),
    month: sum(mo, today), monthHrs: hrs(mo, today),
    fy: sum(fy.from, today), fyHrs: hrs(fy.from, today), fyLabel: fy.label, fyStart: fy.start,
    planned: planned.reduce((a, s) => a + shiftPay(s, jobs), 0), plannedHrs: planned.reduce((a, s) => a + (+s.hours || 0), 0),
  };
}

/** Resident income tax for an Australian financial year (ATO rates; 2026-27 has 15% and 2027-28 has 14% in the second bracket).
 *  Part-year residents get $13,464 plus $4,736 × months resident / 12 as their tax-free threshold.
 *  Medicare levy is left out: most student visa holders aren't entitled to Medicare and can claim an exemption. */
export function residentTax(income, fyStart, monthsResident = 12) {
  const second = fyStart >= 2027 ? 0.14 : fyStart === 2026 ? 0.15 : 0.16;
  const threshold = monthsResident >= 12 ? 18200 : Math.round(13464 + 4736 * monthsResident / 12);
  const b = [[threshold, 0], [45000, second], [135000, 0.30], [190000, 0.37], [Infinity, 0.45]];
  let tax = 0, prev = 0;
  for (const [cap, r] of b) { if (income > prev) tax += (Math.min(income, cap) - prev) * r; prev = cap; }
  return { tax: Math.round(tax), threshold, second };
}
/** Months from arrival month to June inclusive, for the year you arrive. */
export function monthsResidentInFY(arrival, fyStart) {
  if (!arrival) return 12;
  const fyFrom = `${fyStart}-07-01`;
  if (arrival <= fyFrom) return 12;
  const am = +arrival.slice(5, 7), ay = +arrival.slice(0, 4);
  const months = (fyStart + 1 - ay) * 12 + 6 - am + 1;
  return Math.max(1, Math.min(12, months));
}
