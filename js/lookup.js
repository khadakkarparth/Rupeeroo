// Optional online lookup of unknown shop names on OpenStreetMap (Nominatim).
// Only names the user approves are sent, one per second as Nominatim asks. Results are suggestions.

const OSM_TO_CAT = [
  [/^(amenity):(restaurant|cafe|fast_food|food_court|ice_cream|bar|pub|biergarten)$/, 'food'],
  [/^shop:(bakery|confectionery|pastry|tea|coffee|beverages|chocolate)$/, 'food'],
  [/^shop:(supermarket|convenience|grocery|greengrocer|dairy|butcher|seafood|farm|general|variety_store|frozen_food|spices)$/, 'groceries'],
  [/^(amenity:(pharmacy|hospital|clinic|doctors|dentist)|shop:(chemist|medical_supply|optician)|healthcare:.*|leisure:(fitness_centre|sports_centre))$/, 'health'],
  [/^(amenity:(fuel|parking|taxi|bus_station|charging_station|car_rental)|shop:(car|car_repair|motorcycle|tyres|bicycle)|railway:.*|aeroway:.*)$/, 'transport'],
  [/^tourism:(hotel|hostel|guest_house|motel|apartment|camp_site)$/, 'travel'],
  [/^(amenity:(cinema|theatre|arts_centre|nightclub)|leisure:(bowling_alley|amusement_arcade|water_park|escape_game|park)|tourism:(attraction|museum|theme_park|zoo))$/, 'fun'],
  [/^shop:(hairdresser|beauty|cosmetics|massage|perfumery)$/, 'personal'],
  [/^(amenity:(school|college|university|library|training)|shop:(books|stationery))$/, 'education'],
  [/^shop:(clothes|shoes|electronics|mobile_phone|computer|department_store|mall|gift|sports|hardware|furniture|jewelry|bag|boutique|fashion|toys|houseware|appliance|doityourself|kitchen|watches|optician)$/, 'shopping'],
  [/^(shop:(laundry|dry_cleaning|copyshop|tailor)|office:.*)$/, 'other'],
];

export function osmToCategory(category, type) {
  const k = `${category}:${type}`;
  for (const [re, cat] of OSM_TO_CAT) if (re.test(k)) return cat;
  return null;
}

/** Clean a statement name for searching: drop "M/S", "MR", stray digits. */
export function searchName(name) {
  return (name || '').replace(/^(M\/S\.?|MR\.?|MRS\.?|MS\.?)\s*/i, '').replace(/[0-9_@]/g, ' ').replace(/\s+/g, ' ').trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Look up each item ({key, name}) near `city`. Calls onResult(key, result) as it goes. */
export async function lookupMany(items, city, onResult, shouldStop = () => false) {
  for (const it of items) {
    if (shouldStop()) break;
    const q = searchName(it.name);
    let result = { status: 'miss', at: Date.now(), q };
    if (q.length >= 3) {
      try {
        const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=0&countrycodes=in,au&q=' + encodeURIComponent(city ? `${q}, ${city}` : q);
        const r = await fetch(url, { credentials: 'omit' });
        if (r.status === 429) { await sleep(5000); }
        const list = r.ok ? await r.json() : [];
        const hit = list.map(x => ({ x, cat: osmToCategory(x.category, x.type) })).find(h => h.cat);
        if (hit) result = { status: 'hit', cat: hit.cat, place: hit.x.name || q, kind: hit.x.type.replace(/_/g, ' '), where: (hit.x.display_name || '').split(',').slice(1, 3).join(',').trim(), at: Date.now(), q };
      } catch (e) { result = { status: 'error', at: Date.now(), q }; }
    }
    onResult(it.key, result);
    await sleep(1100); // Nominatim allows one request per second
  }
}

/** A web search the user opens themselves; nothing is sent until they tap it. */
export function webSearchUrl(name, vpa, city) {
  const q = [searchName(name), vpa && /[a-z]{4,}/i.test(vpa) && !/^\d/.test(vpa) ? vpa.split('@')[0] : '', city].filter(Boolean).join(' ');
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}
