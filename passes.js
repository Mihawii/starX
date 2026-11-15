// Evidence-Ready Pass Finder: live NASA CMR metadata → NISAR passes, 12-day repeat prediction,
// measured repeat residuals, and near-simultaneous optical (HLS) matches for independent verification.
export const NISAR_COLLECTIONS = [
  { id: 'C2854338529-ASF', maturity: 'provisional' },
  { id: 'C3622241360-ASF', maturity: 'validated' },
];
export const REPEAT_MS = 12 * 86400e3;
const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';

// ASF NISAR naming: NISAR_L2_PR_GCOV_{cycle}_{track}_{A|D}_{frame}_{mode}_{pol}_{coverage}_{start}_{end}_{CRID}_{orbit fid.}_{pointing fid.}_{joint}_{counter}
export function parseNisarTitle(title) {
  const t = String(title || '').split('_');
  if (t.length < 18 || t[0] !== 'NISAR' || !/^\d{3}$/.test(t[4]) || !/^\d{3}$/.test(t[5]) || !/^[AD]$/.test(t[6])) return null;
  const iso = s => /^\d{8}T\d{6}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` : null;
  return { level: t[1], pipeline: t[2], product: t[3], cycle: +t[4], track: +t[5], direction: t[6] === 'A' ? 'ascending' : 'descending', frame: +t[7],
    mode: t[8], polarization: t[9], start: iso(t[11]), end: iso(t[12]), crid: t[13], fidelity: `${t[14]}/${t[15]}`, joint: t[16] === 'J' };
}

export function cmrPolygon(polygons) {
  const ring = Array.isArray(polygons) && polygons[0]?.[0] ? String(polygons[0][0]).trim().split(/\s+/).map(Number) : [];
  const out = []; for (let i = 0; i + 1 < ring.length; i += 2) out.push([ring[i + 1], ring[i]]);
  return out.length >= 4 && out.every(p => p.every(Number.isFinite)) ? out : null;
}

export function normalizeNisar(entry, maturity) {
  const meta = parseNisarTitle(entry?.title); if (!meta) return null;
  const time = Date.parse(entry.time_start || meta.start); if (!Number.isFinite(time)) return null;
  return { id: entry.id, title: entry.title, maturity, time, ...meta, sizeMb: Number(entry.granule_size) || null, footprint: cmrPolygon(entry.polygons),
    key: `T${String(meta.track).padStart(3, '0')} ${meta.direction[0].toUpperCase()} F${String(meta.frame).padStart(3, '0')}` };
}

export function groupPasses(passes) {
  const groups = new Map();
  for (const p of passes) { if (!groups.has(p.key)) groups.set(p.key, []); groups.get(p.key).push(p); }
  return [...groups.entries()].map(([key, list]) => ({ key, passes: list.sort((a, b) => a.time - b.time) })).sort((a, b) => b.passes.length - a.passes.length || a.key.localeCompare(b.key));
}

// Measured residuals of consecutive same-track acquisitions against whole 12-day cycles (seconds).
export function repeatResiduals(passes, period = REPEAT_MS) {
  const res = [];
  for (let i = 1; i < passes.length; i++) {
    const dt = passes[i].time - passes[i - 1].time, n = Math.round(dt / period);
    if (n >= 1) res.push({ cycles: n, residualS: (dt - n * period) / 1000 });
  }
  return { count: res.length, maxAbsS: res.length ? Math.max(...res.map(r => Math.abs(r.residualS))) : null, residuals: res };
}

export function predictNext(passes, now, count = 3, period = REPEAT_MS) {
  if (!passes.length || !Number.isFinite(now)) return [];
  const last = passes[passes.length - 1].time, k0 = Math.max(1, Math.floor((now - last) / period) + 1), out = [];
  for (let k = k0; out.length < count; k++) out.push(last + k * period);
  return out;
}

export function matchOptical(time, optical, maxHours = 24) {
  let best = null;
  for (const o of optical) { const dh = (o.time - time) / 36e5; if (Math.abs(dh) <= maxHours && (!best || Math.abs(dh) < Math.abs(best.offsetHours))) best = { ...o, offsetHours: dh }; }
  return best;
}

// A pair (consecutive passes of one track/frame) is verification-ready when both dates have an optical
// observation within ±maxHours whose tile cloud cover is ≤ maxCloud. Tile cloud is not local cloud.
export function evidencePairs(group, optical, { maxHours = 24, maxCloud = 40 } = {}) {
  const tagged = group.passes.map(p => ({ pass: p, optical: matchOptical(p.time, optical, maxHours) }));
  const ok = x => x.optical && Number.isFinite(x.optical.cloud) && x.optical.cloud <= maxCloud;
  const pairs = [];
  for (let i = 1; i < tagged.length; i++) if (ok(tagged[i - 1]) && ok(tagged[i])) pairs.push({ before: tagged[i - 1], after: tagged[i] });
  return { tagged, pairs };
}

export function revisitStats(passes) {
  const times = [...new Set(passes.map(p => p.time))].sort((a, b) => a - b), gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 864e5);
  gaps.sort((a, b) => a - b);
  return { gaps: gaps.length, medianDays: gaps.length ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2) : null };
}

export function nisarQuery(lon, lat, collection, pageSize = 500) {
  return `${CMR}?collection_concept_id=${collection}&point=${lon.toFixed(5)},${lat.toFixed(5)}&sort_key=start_date&page_size=${pageSize}`;
}
export function hlsQuery(lon, lat, shortName, startIso, endIso, pageSize = 2000) {
  return `${CMR}?short_name=${shortName}&version=2.0&point=${lon.toFixed(5)},${lat.toFixed(5)}&temporal=${startIso},${endIso}&page_size=${pageSize}`;
}
export const normalizeHls = e => { const time = Date.parse(e?.time_start), cloud = Number(e?.cloud_cover);
  return Number.isFinite(time) ? { id: e.id, title: e.title, time, cloud: Number.isFinite(cloud) ? cloud : null, sensor: String(e.title || '').includes('.S30.') ? 'HLS S30' : 'HLS L30' } : null; };
