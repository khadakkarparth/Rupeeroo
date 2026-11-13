// Category suggestions from the user's own note ("dinner with college friends").
// 1) localSuggest: keyword rules, instant, nothing leaves the device.
// 2) claudeSuggest: asks Claude, either through claude.ai (when the app runs there) or the
//    Anthropic API with the user's own key. Sends only the note, payee name, amount, date and
//    the list of categories; never account numbers or balances.

const NOTE_RULES = [
  [/\b(mom|mum|mummy|maa|aai|aaji|ajji|dad|papa|baba|bhau|dada|tai|brother|bro|sister|sis|didi|bhai|family|grand(ma|pa|mother|father)|uncle|aunt|kaka|kaki|mama|mami|cousin|ghar|home)\b/i, 'family', 'mentions family'],
  [/\b(friend|friends|dost|yaar|buddy|college|classmate|roomie|roommate|flatmate|party|treat|hangout|outing|trip with)\b/i, 'friends', 'mentions friends'],
  [/\b(lent|lend|loan to|borrowed|to get back|will return|owe me|owes me|advance to)\b/i, 'lent', 'money you expect back'],
  [/\b(split|my share|share of|contribution|chipped in)\b/i, 'friends', 'a shared bill'],
  [/\b(gift|present|birthday|wedding|shagun|anniversary|rakhi|diwali gift)\b/i, 'gifts', 'a gift'],
  [/\b(rent|pg|hostel|deposit|maintenance|brokerage|landlord|flat)\b/i, 'rent', 'housing'],
  [/\b(dinner|lunch|breakfast|brunch|coffee|chai|tea|snack|snacks|food|biryani|pizza|burger|momos|dosa|pani ?puri|restaurant|cafe|meal|drinks|beer|bar)\b/i, 'food', 'food or drinks'],
  [/\b(grocer|groceries|vegetable|veggies|sabzi|fruits?|milk|kirana|ration|supermarket|eggs?)\b/i, 'groceries', 'groceries'],
  [/\b(petrol|diesel|fuel|cab|uber|ola|rapido|auto|rickshaw|bus|train|metro|ticket to|parking|toll|fastag|opal)\b/i, 'transport', 'travel around town'],
  [/\b(flight|hotel|hostel stay|airbnb|trip|holiday|vacation|tour)\b/i, 'travel', 'a trip'],
  [/\b(movie|film|imax|cinema|concert|game|steam|playstation|bowling|show|match)\b/i, 'fun', 'entertainment'],
  [/\b(medicine|doctor|clinic|hospital|test|lab|pharmacy|gym|protein|physio)\b/i, 'health', 'health or fitness'],
  [/\b(haircut|salon|barber|spa|parlour|grooming)\b/i, 'personal', 'personal care'],
  [/\b(clothes|shoes|shirt|jeans|amazon|flipkart|myntra|phone|laptop|headphones|gadget|bought)\b/i, 'shopping', 'a purchase'],
  [/\b(course|exam|ielts|gmat|cat|fees|books?|stationery|tuition|coaching|application)\b/i, 'education', 'study costs'],
  [/\b(netflix|spotify|subscription|recharge|wifi|broadband|electricity|bill)\b/i, 'subscriptions', 'a bill or subscription'],
  [/\b(emi|loan repayment|instal+ment)\b/i, 'emi', 'a loan payment'],
  [/\b(sip|mutual fund|stocks?|shares|invest)/i, 'invest', 'an investment'],
  [/\b(salary|stipend|pay ?cheque|payslip)\b/i, 'salary', 'pay'],
  [/\b(refund|cashback|returned)\b/i, 'refund', 'money back'],
  [/\b(own account|my account|self transfer|transfer to self)\b/i, 'transfer', 'your own accounts'],
];

export function localSuggest(note, dir, allowed) {
  const out = [];
  if (!note || note.trim().length < 2) return out;
  for (const [re, cat, why] of NOTE_RULES) {
    if (!re.test(note) || out.some(o => o.cat === cat)) continue;
    let c = cat;
    // money coming in from family or friends is "money received", not spending
    if (dir === 'C' && ['family', 'friends', 'gifts', 'lent'].includes(cat)) c = cat === 'lent' ? 'refund' : 'income_other';
    if (allowed.includes(c) && !out.some(o => o.cat === c)) out.push({ cat: c, why });
    if (out.length >= 3) break;
  }
  return out;
}

const KEY_STORE = 'rupeeroo.anthropicKey';
export const getApiKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } };
export const setApiKey = k => { try { if (k) localStorage.setItem(KEY_STORE, k.trim()); else localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ } };

let sampleFn; // claude.ai capability, resolved lazily
async function claudeAi() {
  if (sampleFn !== undefined) return sampleFn;
  try { sampleFn = typeof window.claude?.use === 'function' ? await window.claude.use('sample') : null; } catch (e) { sampleFn = null; }
  return sampleFn;
}
export async function claudeAvailable() { return !!getApiKey() || !!(await claudeAi()); }
export function claudeMaybeAvailable() { return !!getApiKey() || typeof window.claude?.use === 'function'; }

function buildPrompt({ note, payee, amount, date, dir, cats, raw }) {
  const list = cats.map(c => `${c.id}: ${c.label}`).join('\n');
  return `You sort one bank transaction into a category for a student's personal budget app in India.
Transaction: ${dir === 'D' ? 'money paid out' : 'money received'}, ₹${amount} on ${date}, payee "${payee}".
Bank text: "${raw}"
The user's note about it: "${note || '(no note)'}"

Allowed categories (id: label):
${list}

Reply with JSON only, no other text, in this shape:
{"options":[{"cat":"<id from the list>","why":"<under 12 words>"}],"unsure":false}
Give 1 to 3 options, best first. Use only ids from the list. If the note and payee don't give enough to decide, set "unsure" to true and still give your best guesses.`;
}

function parse(text, cats) {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return options');
  const j = JSON.parse(m[0]);
  const ids = new Set(cats.map(c => c.id));
  const options = (j.options || []).filter(o => ids.has(o.cat)).slice(0, 3).map(o => ({ cat: o.cat, why: String(o.why || '').slice(0, 90) }));
  return { options, unsure: !!j.unsure || !options.length };
}

export async function claudeSuggest(ctx) {
  const prompt = buildPrompt(ctx);
  const s = await claudeAi();
  if (s) {
    const r = await s(prompt, { modelTier: 'quick' });
    return { ...parse(r.text, ctx.cats), source: 'Claude' };
  }
  const key = getApiKey();
  if (!key) throw new Error('Add your Anthropic API key in Settings to use Claude here.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `Claude API error ${res.status}`);
  return { ...parse(j.content?.map(c => c.text || '').join(''), ctx.cats), source: 'Claude' };
}
