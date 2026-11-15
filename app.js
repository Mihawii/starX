import { NISAR_COLLECTIONS, nisarQuery, hlsQuery, normalizeNisar, normalizeHls, groupPasses, repeatResiduals, predictNext, evidencePairs, revisitStats } from './passes.js';
import { validateCase, formatNumber, formatDate, isNumber, safeUrl, inspectorCell, readUnit, geometryAt, unitVerdict, groundTracks, mgrs } from './data.js';

const $ = id => document.getElementById(id);
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const put = (parent, ...kids) => { kids.filter(Boolean).forEach(k => parent.append(k)); return parent; };
const db = v => isNumber(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)} dB` : 'n/a';
const announce = msg => { const a = $('announce'); if (a) a.textContent = msg; };
const utc = v => { if (!v) return 'n/a'; const d = new Date(v); if (Number.isNaN(d.valueOf())) return 'n/a';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }).toUpperCase()} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

const RASTERS = [
  ['Radar · NISAR', [['mtc', 'What changed', 'RGB: R 12 Sep · G,B 06 Oct · HH 10 m'], ['delta', 'Change in dB', 'ΔHH 06 Oct − 12 Sep · 30 m'], ['before', 'Radar · 12 Sep', 'HH γ⁰ · 10 m'], ['after', 'Radar · 06 Oct', 'HH γ⁰ · 10 m'],
    ['dualpol-before', 'Polarimetric · 12 Sep', 'R HH · G HV · B HH−HV'], ['dualpol-after', 'Polarimetric · 06 Oct', 'R HH · G HV · B HH−HV']]],
  ['Optical check · HLS', [['reference-after', 'Optical · 06 Oct', 'Sentinel-2 SWIR · 18 h before radar'], ['reference-before', 'Optical · 13 Sep', 'Sentinel-2 SWIR · mostly cloud']]],
];
const OVERLAYS = [['change', 'Flagged as possible water', 'Δ ≤ −3 dB and Oct 6 ≤ −15 dB'], ['quality', 'Data quality', 'GCOV mask 0 / 255'], ['footprints', 'Coverage outlines', 'swath · area · rejected box'], ['sites', 'Evidence sites', 'chosen after the census']];

const bust = url => { const v = state.data?.provenance?.runId; return v && url && !/^https?:/.test(url) ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}` : url; };
const state = { data: null, raw: null, view: null, inspector: null, active: 'mtc', on: new Set(['footprints', 'sites']), opacity: 1,
  map: null, overlays: {}, vectors: null, siteLayer: null, pin: null, swipe: false, swipeLayers: null, globe: null, unit: null, site: null, current: 'orbit' };

// ---------------------------------------------------------------- loading
async function load() {
  $('load-error').hidden = true; $('retry').disabled = true;
  setStatus('loading', 'Loading');
  try {
    const response = await fetch('./case/case.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`case.json returned HTTP ${response.status}`);
    const data = validateCase(await response.json());
    state.data = data; state.raw = data;
    await Promise.all([loadInspector(data), loadVerification(data), loadTileManifest()]);
    renderAll();
    announce('Case loaded.');
  } catch (error) {
    state.data = null;
    setStatus('error', 'Data unavailable');
    $('error-detail').textContent = error.message;
    $('load-error').hidden = false;
    $('export-case').disabled = true;
    $('inspect-body').replaceChildren(h('p', 'hint', 'No case data loaded. Nothing can be inspected.'));
  } finally { $('retry').disabled = false; }
}
async function loadTileManifest() {
  if (state.tileKeys) return;
  try { const r = await fetch('./tiles/relief/manifest.json'); if (r.ok && r.json) { const m = await r.json(); if (Array.isArray(m?.keys)) state.tileKeys = new Set(m.keys); } } catch { /* remote tiles with retry remain */ }
}
async function loadVerification(data) {
  state.verification = null;
  try { const r = await fetch(bust('./case/verification.json')); if (r.ok && r.json) { const v = await r.json(); if (v?.runId && v.runId === data.provenance?.runId && Array.isArray(v.checks)) state.verification = v; } } catch { state.verification = null; }
}
async function loadInspector(data) {
  state.inspector = null;
  const hdr = data.inspector; if (!hdr || !safeUrl(hdr.url)) return;
  try {
    const r = await fetch(bust(hdr.url)); if (!r.ok || !r.arrayBuffer) return;
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== hdr.bands.length * hdr.shape[0] * hdr.shape[1] * (hdr.dtype === 'float32-le' ? 4 : 2)) return;
    state.inspector = new DataView(buf);
  } catch { state.inspector = null; }
}
function setStatus(kind, text) { const s = $('case-status'); s.className = `status ${kind}`; s.replaceChildren(h('i'), h('span', '', text)); }

function renderAll() {
  const d = state.data;
  setStatus(d.status, d.status === 'observed' ? 'Observed · not evaluated' : d.status === 'evaluated' ? 'Evaluated' : 'Awaiting data');
  $('export-case').disabled = false;
  renderOrbitCopy(); renderLayerList(); renderOverlayList(); renderLegend(); renderSites(); renderInspector(null);
  renderGates(); renderFindings(); renderCounts(); renderSensitivity(); renderMethod(); renderVerification(); renderAccuracy(); renderHud();
  drawDecision(null); drawHistogram(); drawTimeline();
  if (state.current === 'orbit') safeGlobe();
  if (state.current === 'scene') initMap();
}

// ---------------------------------------------------------------- views
function setView(name) {
  state.current = name;
  for (const v of ['orbit', 'scene', 'evidence', 'method']) $(`view-${v}`).hidden = v !== name;
  for (const b of document.querySelectorAll('.views button')) b.setAttribute('aria-pressed', String(b.dataset.view === name));
  if (globalThis.history?.replaceState) history.replaceState(null, '', `#${name}`);
  if (!state.data) return;
  if (name === 'orbit') { safeGlobe(); state.globe?.resumeAnimation?.(); state.globe?.pointOfView({ lat: 20, lng: 87, altitude: 2.3 }, 900); } else state.globe?.pauseAnimation?.();
  if (name === 'scene') { initMap(); setTimeout(() => { state.map?.invalidateSize(); drawTimeline(); drawDecision(state.unit); if (state.step === undefined) setStep(0); }, 0); }
  if (name === 'evidence') setTimeout(drawHistogram, 0);
}

// ---------------------------------------------------------------- orbit view
function renderOrbitCopy() {
  const o = state.data.orbit, acq = state.data.acquisitions.filter(a => a.sensor === 'NISAR');
  if (!o) { $('orbit-title').textContent = 'Orbit metadata unavailable'; return; }
  const m = o.mission || {}, g = o.geometry?.perDate?.before?.center, grid = o.geometry?.grid?.values?.flat?.() || [];
  const inc = grid.map(v => v[0]).filter(isNumber);
  $('orbit-title').textContent = `Track ${o.track} · Frame ${o.frame}`;
  $('orbit-sub').textContent = `${String(o.direction).toLowerCase()} pass · ${String(o.lookDirection).toLowerCase()}-looking · ${m.repeatDays}-day exact repeat`;
  const facts = [
    ['Altitude', `${m.altitudeKm} km`, 'mission'], ['Inclination', `${m.inclinationDeg}°`, 'sun-synchronous'],
    ['Repeat', `${m.repeatDays} d · ${o.orbitsPerCycle}`, 'orbits per cycle'], ['Swath', `${m.swathKm} km`, 'mission'],
    ['Incidence', inc.length ? `${Math.min(...inc).toFixed(1)}–${Math.max(...inc).toFixed(1)}°` : 'n/a', 'across area · derived'],
    ['Slant range', g ? `${formatNumber(g.slantRangeKm, 0)} km` : 'n/a', 'area centre · derived'],
    ['Platform', g ? `${g.platformAltitudeKm.toFixed(1)} km` : 'n/a', g ? `${g.platformSpeedKmS.toFixed(2)} km/s · ephemeris` : ''],
    ['Zero Doppler', g ? g.zeroDopplerUtc.slice(11, 19) : 'n/a', g ? 'UTC · 12 Sep 2026' : ''],
  ];
  $('orbit-facts').replaceChildren(...facts.map(([k, v, s]) => { const d = h('div'); const dd = h('dd', '', v); if (s) dd.append(h('small', '', s)); return put(d, h('dt', '', k), dd); }));
  const b = acq.find(a => a.role === 'before'), a = acq.find(a => a.role === 'after');
  $('pair-dates').replaceChildren(h('span', '', `${utc(b?.acquiredAt)}`), h('br'), h('span', '', `${utc(a?.acquiredAt)}`));
  $('orbit-legend').replaceChildren(...[
    ['var(--orbit)', `Modeled ground tracks · ${o.orbitsPerCycle} per ${m.repeatDays} d`], ['#fff', 'Measured nadir · orbit state vectors'],
    ['#f0b8ff', `Track ${o.track} swath · CMR footprint`], ['var(--nogo)', 'Analysis area · line of sight']].map(([c, t]) => { const li = h('li'); const i = h('i'); i.setAttribute('style', `border-color:${c}`); return put(li, i, h('span', '', t)); }));
  $('orbit-note').textContent = `Model: circular orbit, ${m.altitudeKm} km, ${m.inclinationDeg}°, ${o.orbitsPerCycle} orbits in ${m.repeatDays} days, anchored to the GCOV ephemeris nadir. Source: ${m.source}`;
}

function drawStars() {
  const c = $('stars'); if (!c?.getContext) return;
  const w = c.clientWidth, hh = c.clientHeight, dpr = globalThis.devicePixelRatio || 1;
  c.width = w * dpr; c.height = hh * dpr; const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 520; i++) { ctx.globalAlpha = 0.15 + 0.6 * rnd() ** 2; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(rnd() * w, rnd() * hh, 0.3 + rnd() * 0.9, 0, 6.283); ctx.fill(); }
}

function safeGlobe() { try { initGlobe(); } catch (error) { state.globe = null; $('orbit-note').textContent = `3D globe unavailable (${error.message}). All other views work.`; } }
const SAT_SVG = `<svg width="110" height="70" viewBox="0 0 110 70" fill="none" stroke="#fff" stroke-width="1" aria-hidden="true">
  <g opacity=".95"><rect x="44" y="30" width="14" height="10" fill="#c9a24a" stroke="#f3dc9a"/>
  <rect x="8" y="31" width="32" height="8" fill="#1d2a4a"/><line x1="16" y1="31" x2="16" y2="39"/><line x1="24" y1="31" x2="24" y2="39"/><line x1="32" y1="31" x2="32" y2="39"/><line x1="40" y1="35" x2="44" y2="35"/>
  <rect x="62" y="31" width="32" height="8" fill="#1d2a4a"/><line x1="70" y1="31" x2="70" y2="39"/><line x1="78" y1="31" x2="78" y2="39"/><line x1="86" y1="31" x2="86" y2="39"/><line x1="58" y1="35" x2="62" y2="35"/>
  <line x1="51" y1="30" x2="51" y2="12" stroke="#e8e8e8"/>
  <ellipse cx="51" cy="9" rx="24" ry="6" fill="rgba(201,162,74,.18)" stroke="#f3dc9a"/>
  <path d="M27 9 L51 9 M75 9 L51 9 M33 5 L51 9 M69 5 L51 9 M33 13 L51 9 M69 13 L51 9" stroke="#f3dc9a" stroke-width=".6" opacity=".8"/></g></svg>`;
// Drape a recorded scene layer on the globe at its true bounds, using the globe's own three.js classes
// (taken from the globe material and texture) so only one three.js instance exists.
function drapeScene(layerId, tries = 0) {
  const g = state.globe, l = layerById(layerId); if (!g || !l) return;
  const base = g.globeMaterial?.(), tex0 = base?.map;
  if (!tex0?.image) { if (tries < 40) setTimeout(() => drapeScene(layerId, tries + 1), 250); return; }
  const img = new Image(); img.decoding = 'async';
  img.onload = () => {
    const Texture = tex0.constructor, Material = base.constructor, tex = new Texture(img);
    tex.colorSpace = tex0.colorSpace; tex.anisotropy = 4; tex.needsUpdate = true;
    const mat = new Material({ color: 0x000000, emissive: 0xffffff, emissiveMap: tex, map: tex, transparent: false, alphaTest: 0.5, depthWrite: true, side: 2 });
    const [w, s, e, n] = l.bounds;
    g.tilesData([{ lat: (s + n) / 2, lng: (w + e) / 2, width: e - w, height: n - s, mat }]).tileLat('lat').tileLng('lng').tileWidth('width').tileHeight('height')
      .tileAltitude(0.0006).tileUseGlobeProjection(true).tileMaterial('mat').tileCurvatureResolution(0.02).tilesTransitionDuration(0);
    state.draped = layerId;
  };
  img.src = bust(l.url);
}
function initGlobe() {
  if (state.globe || !globalThis.Globe || !state.data?.orbit) { if (!globalThis.Globe && state.data) $('orbit-note').textContent += ' · 3D globe unavailable in this browser.'; return; }
  const o = state.data.orbit, before = o.geometry?.perDate?.before, c = before?.center;
  const [w, s, e, n] = state.data.study.bounds, aoi = { lat: (s + n) / 2, lng: (w + e) / 2 };
  const paths = [];
  if (c) {
    const model = groundTracks({ inclinationDeg: o.mission.inclinationDeg, orbitsPerCycle: o.orbitsPerCycle, repeatDays: o.mission.repeatDays, anchorLon: c.platformLon, anchorLat: c.platformLat, samples: 240 });
    for (const t of model.tracks) paths.push({ points: t.points.map(([la, lo]) => [la, lo, 0.003]), color: 'rgba(210,77,255,0.22)', stroke: null, model: true });
    paths.push({ points: before.nadir.map(([lo, la]) => [la, lo, 0.006]), color: '#ffffff', stroke: 2.2 });
    // straight line of sight from the platform to the area centre (spherical Earth, display only)
    const R = 6371, toXYZ = (la, lo, r) => { const a = la * Math.PI / 180, b = lo * Math.PI / 180; return [r * Math.cos(a) * Math.cos(b), r * Math.cos(a) * Math.sin(b), r * Math.sin(a)]; };
    const P = toXYZ(c.platformLat, c.platformLon, R + c.platformAltitudeKm), T = toXYZ(aoi.lat, aoi.lng, R), los = [];
    for (let i = 0; i <= 32; i++) { const q = P.map((p, k) => p + (T[k] - p) * i / 32), r = Math.hypot(...q); los.push([Math.asin(q[2] / r) * 180 / Math.PI, Math.atan2(q[1], q[0]) * 180 / Math.PI, (r - R) / R]); }
    paths.push({ points: los, color: '#fc3d21', stroke: 1.6 });
  }
  // d3/three-globe spherical polygons treat the ring winding as interior side; CMR rings are counter-clockwise → reverse.
  const swath = (state.data.footprints?.features || []).filter(f => f.properties.role === 'radar').slice(0, 1)
    .map(f => ({ geometry: { type: 'Polygon', coordinates: [f.geometry.coordinates[0].slice().reverse()] }, cap: 'rgba(210,77,255,0.08)', stroke: '#f0b8ff', alt: 0.0012 }));
  const tags = [{ lat: aoi.lat, lng: aoi.lng, alt: 0.002, text: 'Analysis area · West Champaran', cls: 'target' }];
  if (c) tags.push({ lat: c.platformLat, lng: c.platformLon, alt: c.platformAltitudeKm / 6371, sat: true, text: 'NISAR', sub: `${c.platformAltitudeKm.toFixed(1)} km · ${c.platformSpeedKmS.toFixed(2)} km/s · ${c.zeroDopplerUtc.slice(11, 19)} UTC` });
  const el = $('globe');
  const globe = new globalThis.Globe(el, { animateIn: false })
    .globeImageUrl('./vendor/earth/bluemarble-shaded-relief-bathymetry-4096x2048.jpg')
    .backgroundColor('rgba(0,0,0,0)').showAtmosphere(true).atmosphereColor('#7fb0ff').atmosphereAltitude(0.15)
    .pathsData(paths).pathPoints('points').pathPointLat(p => p[0]).pathPointLng(p => p[1]).pathPointAlt(p => p[2])
    .pathColor(d => d.model && state.finderActive ? 'rgba(210,77,255,0.05)' : d.color).pathStroke('stroke').pathResolution(2).pathTransitionDuration(0)
    .polygonsData(swath).polygonGeoJsonGeometry('geometry').polygonCapColor(d => d.cap || 'rgba(210,77,255,0.42)').polygonSideColor(() => 'rgba(0,0,0,0)')
    .polygonStrokeColor(d => d.stroke || '#f0b8ff').polygonAltitude(d => d.alt || 0.0045).polygonsTransitionDuration(0)
    .onGlobeClick(({ lat, lng }) => runFinder(lat, lng)).onPolygonClick((_p, _e, at) => at && runFinder(at.lat, at.lng))
    .htmlElementsData(tags).htmlLat('lat').htmlLng('lng').htmlAltitude('alt')
    .htmlElement(d => {
      if (d.sat) { const t = h('div', 'sat'); t.innerHTML = SAT_SVG; const lab = h('div', 'sat-label', d.text); lab.append(h('small', '', d.sub)); t.append(lab); return t; }
      const t = h('div', `globe-tag ${d.cls}`); put(t, h('i'), h('span', '', d.text)); return t; })
    .width(el.clientWidth).height(el.clientHeight);
  globe.pointOfView({ lat: 20, lng: 87, altitude: 2.3 }, 0);
  const controls = globe.controls(); controls.autoRotate = true; controls.autoRotateSpeed = 0.3;
  controls.addEventListener('start', () => { controls.autoRotate = false; });
  // Full-width canvas so the Earth is never clipped; clicks map 1:1 to the rendered globe.
  const fit = () => { const W = el.clientWidth, H = el.clientHeight; if (W && H) globe.width(W).height(H); };
  fit();
  if (globalThis.ResizeObserver) new ResizeObserver(fit).observe(el);
  globalThis.addEventListener?.('resize', () => { fit(); drawStars(); drawTimeline(); });
  state.globe = globe; state.aoiCenter = aoi; state.baseSwath = swath; state.baseTags = tags;
  controls.minDistance = 102.5; // overlays stop rendering when the camera is within ~100 km of the surface
  drapeScene('mtc');
}

// ---------------------------------------------------------------- pass finder (live NASA CMR)
const FINDER_COLORS = { ascending: ['rgba(210,77,255,0.07)', '#f0b8ff', '#d24dff'], descending: ['rgba(79,179,255,0.07)', '#a9d6ff', '#4fb3ff'] };
async function cmrJson(url) { const r = await fetch(url, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`CMR HTTP ${r.status}`); return (await r.json())?.feed?.entry || []; }
const fmtUtc = t => utc(new Date(t).toISOString());
const until = t => { const d = (t - Date.now()) / 864e5; return d >= 0 ? `T−${Math.floor(d)}d ${String(Math.floor((d % 1) * 24)).padStart(2, '0')}h` : `${Math.floor(-d)}d ago`; };
async function runFinder(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) return;
  lng = ((lng + 540) % 360) - 180; const token = (state.finderToken = Symbol('finder'));
  const body = $('finder-body'); body.replaceChildren(h('p', 'f-point', `${lat.toFixed(4)}N  ${lng.toFixed(4)}E`), h('p', 'f-spin', 'Querying NASA CMR for NISAR GCOV…'));
  state.globe?.controls && (state.globe.controls().autoRotate = false);
  showFinderOnGlobe(lat, lng, []);
  try {
    const lists = await Promise.all(NISAR_COLLECTIONS.map(c => cmrJson(nisarQuery(lng, lat, c.id)).then(es => es.map(e => normalizeNisar(e, c.maturity)).filter(Boolean))));
    const passes = lists.flat(); if (token !== state.finderToken) return;
    let optical = [];
    if (passes.length) {
      body.lastChild.textContent = 'Matching HLS optical observations (±24 h)…';
      const t0 = new Date(Math.min(...passes.map(p => p.time)) - 864e5).toISOString().slice(0, 19) + 'Z', t1 = new Date(Math.max(...passes.map(p => p.time)) + 864e5).toISOString().slice(0, 19) + 'Z';
      const hls = await Promise.all(['HLSS30', 'HLSL30'].map(n => cmrJson(hlsQuery(lng, lat, n, t0, t1)).catch(() => null)));
      optical = hls.filter(Boolean).flat().map(normalizeHls).filter(Boolean); state.finderOpticalOk = hls.every(Boolean);
    }
    if (token !== state.finderToken) return;
    state.finderResult = { lat, lng, queriedAt: new Date().toISOString(), passes, optical, groups: groupPasses(passes) };
    renderFinder(); showFinderOnGlobe(lat, lng, state.finderResult.groups);
  } catch (error) {
    if (token !== state.finderToken) return;
    body.replaceChildren(h('p', 'f-point', `${lat.toFixed(4)}N  ${lng.toFixed(4)}E`), h('p', 'f-sum', `Catalogue unreachable (${error.message}). No results are shown rather than stale ones.`));
  }
}
function renderFinder() {
  const r = state.finderResult, body = $('finder-body'); if (!r) return; body.replaceChildren();
  body.append(h('p', 'f-point', `${r.lat.toFixed(4)}N  ${r.lng.toFixed(4)}E  ·  ${mgrs(r.lng, r.lat) || ''}`));
  const inside = b => b && r.lng >= b[0] && r.lng <= b[2] && r.lat >= b[1] && r.lat <= b[3];
  const links = h('div', 'f-actions');
  if (inside(state.data.study.bounds)) { const b = h('button', 'pill small solid'); b.type = 'button'; put(b, document.createTextNode('Open radar analysis '), h('span', 'arrow', '→')); b.addEventListener('click', () => setView('scene')); links.append(b); }
  if (inside(state.data.accuracy?.bounds)) { const b = h('button', 'pill small solid'); b.type = 'button'; put(b, document.createTextNode('Open accuracy test '), h('span', 'arrow', '→')); b.addEventListener('click', () => setView('evidence')); links.append(b); }
  if (links.children.length) body.append(links);
  else body.append(h('p', 'f-sum', 'No processed imagery here yet — live pass metadata only. Processed: Gandak scene, Kosi accuracy test.'));
  if (!r.passes.length) { body.append(h('p', 'f-sum', 'No NISAR GCOV acquisitions cover this point in the provisional or validated collections yet.')); return; }
  const prov = r.passes.filter(p => p.maturity === 'provisional').length, latest = Math.max(...r.passes.map(p => p.time)), rv = revisitStats(r.passes);
  const sum = h('p', 'f-sum'); put(sum, document.createTextNode(`${r.passes.length} acquisitions · ${r.groups.length} track/frame · provisional ${prov} · validated ${r.passes.length - prov}`), h('br'),
    document.createTextNode(`latest ${fmtUtc(latest)} UTC · median gap ${isNumber(rv.medianDays) ? rv.medianDays.toFixed(1) + ' d' : 'n/a'}`));
  body.append(sum);
  let readyPairs = 0;
  for (const g of r.groups) {
    const rr = repeatResiduals(g.passes), next = predictNext(g.passes, Date.now(), 2), ev = evidencePairs(g, r.optical), matched = ev.tagged.filter(x => x.optical).length;
    readyPairs += ev.pairs.length; const dir = g.passes[0].direction, col = FINDER_COLORS[dir][2];
    const box = h('section', 'f-track'), head = h('h3'), dot = h('i'); dot.setAttribute('style', `background:${col}`);
    put(head, put(h('span'), dot, document.createTextNode(`${g.key} · ${dir}`)), h('span', '', `${g.passes.length} passes`));
    const dl = h('dl', 'f-row'), row = (k, v, cls) => put(dl, h('dt', '', k), h('dd', cls || '', v));
    row('last', `${fmtUtc(g.passes[g.passes.length - 1].time)} UTC`);
    next.forEach((t, i) => row(i ? '' : 'next (12 d)', `${fmtUtc(t)} UTC · ${until(t)}`, 'f-next'));
    row('repeat check', rr.count ? `max |Δt| ${rr.maxAbsS.toFixed(1)} s over ${rr.count} intervals` : 'single pass · not testable');
    row('optical ±24 h', state.finderOpticalOk === false ? 'HLS query failed' : `${matched} of ${g.passes.length} passes`);
    const best = ev.pairs[ev.pairs.length - 1];
    row('ready pairs', ev.pairs.length ? `${ev.pairs.length} · latest ${utc(new Date(best.before.pass.time).toISOString()).slice(0, 6)} → ${utc(new Date(best.after.pass.time).toISOString()).slice(0, 6)} (${Math.round(best.before.optical.cloud)}% / ${Math.round(best.after.optical.cloud)}% cloud)` : 'none yet', ev.pairs.length ? 'f-ready' : '');
    body.append(put(box, head, dl));
  }
  body.append(h('p', 'f-note', `Ready pair = consecutive same-track passes, each with HLS within ±24 h at ≤40% tile cloud (tile cloud ≠ local cloud). Predictions assume the 12-day exact repeat continues; operations can change. Source: NASA CMR, queried ${r.queriedAt.slice(0, 16).replace('T', ' ')} UTC.`));
  const act = h('div', 'f-actions'), dl = h('button', 'pill small', 'Download results'); dl.type = 'button';
  dl.addEventListener('click', () => { const g = r.groups.map(x => ({ key: x.key, passes: x.passes.map(p => ({ id: p.id, title: p.title, start: new Date(p.time).toISOString(), maturity: p.maturity, link: `https://cmr.earthdata.nasa.gov/search/concepts/${p.id}.html` })),
      next: predictNext(x.passes, Date.now(), 3).map(t => new Date(t).toISOString()), repeat: repeatResiduals(x.passes), readyPairs: evidencePairs(x, r.optical).pairs.map(q => ({ before: q.before.pass.id, after: q.after.pass.id, opticalBefore: q.before.optical.id, opticalAfter: q.after.optical.id })) }));
    const url = URL.createObjectURL(new Blob([JSON.stringify({ point: { lat: r.lat, lon: r.lng }, queriedAt: r.queriedAt, source: 'NASA CMR', groups: g }, null, 2)], { type: 'application/json' }));
    const a = h('a'); a.href = url; a.download = `nisar-passes-${r.lat.toFixed(3)}_${r.lng.toFixed(3)}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  body.append(put(act, dl));
  announce(`${r.passes.length} NISAR acquisitions found; ${readyPairs} verification-ready pairs.`);
}
function showFinderOnGlobe(lat, lng, groups) {
  const g = state.globe; if (!g) return;
  const found = groups.map(x => { const last = x.passes[x.passes.length - 1], c = FINDER_COLORS[last.direction];
    return last.footprint ? { geometry: { type: 'Polygon', coordinates: [last.footprint.slice().reverse()] }, cap: c[0], stroke: c[1], alt: 0.0012 } : null; }).filter(Boolean);
  state.finderActive = true; g.pathColor(g.pathColor()); g.pathsData([...g.pathsData()]);
  g.polygonsData([...(state.baseSwath || []), ...found]);
  const nearAoi = state.aoiCenter && Math.hypot(lat - state.aoiCenter.lat, lng - state.aoiCenter.lng) < 0.6;
  g.htmlElementsData([...(state.baseTags || []), ...(nearAoi ? [] : [{ lat, lng, alt: 0.003, text: `QUERY ${lat.toFixed(2)}N ${lng.toFixed(2)}E`, cls: 'query' }])]);
  g.pointOfView({ lat, lng, altitude: 1.9 }, 1200);
}

// ---------------------------------------------------------------- scene: layers
const layerById = id => state.data?.layers.find(l => l.id === id && l.available === true && safeUrl(l.url) && Array.isArray(l.bounds));
const llBounds = b => [[b[1], b[0]], [b[3], b[2]]];
function renderLayerList() {
  const list = $('layer-list'); list.replaceChildren();
  for (const [group, items] of RASTERS) {
    list.append(h('div', 'layer-group', group));
    for (const [id, name, src] of items) {
      const ok = !!layerById(id), b = h('button', 'layer');
      b.type = 'button'; b.disabled = !ok; b.setAttribute('aria-pressed', String(ok && state.active === id));
      put(b, h('span', 'dot'), put(h('span'), h('b', '', name), h('small', '', ok ? src : 'not available in this run')));
      b.addEventListener('click', () => { state.active = id; if (state.swipe) toggleSwipe(false); renderLayerList(); renderLegend(); renderMapLayers(); renderHud(); if (state.step !== 'free') setStep('free'); });
      list.append(b);
    }
  }
  $('compare').disabled = !(layerById('before') && layerById('after'));
}
function renderOverlayList() {
  const list = $('overlay-list'); list.replaceChildren();
  for (const [id, name, src] of OVERLAYS) {
    const ok = id === 'footprints' ? !!state.data.footprints : id === 'sites' ? state.data.sites.length > 0 : !!layerById(id);
    const b = h('button', 'layer check'); b.type = 'button'; b.disabled = !ok; b.setAttribute('aria-pressed', String(ok && state.on.has(id)));
    put(b, h('span', 'dot'), put(h('span'), h('b', '', name), h('small', '', ok ? src : 'not available')));
    b.addEventListener('click', () => { state.on.has(id) ? state.on.delete(id) : state.on.add(id); renderOverlayList(); renderMapLayers(); });
    list.append(b);
  }
}
function ramp(canvas, stops) {
  if (!canvas.getContext) return; canvas.width = 256; canvas.height = 10; const ctx = canvas.getContext('2d'), g = ctx.createLinearGradient(0, 0, 256, 0);
  stops.forEach(([t, c]) => g.addColorStop(t, c)); ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 10);
}
function renderLegend() {
  const box = $('legend'); box.replaceChildren(); const l = layerById(state.swipe ? 'after' : state.active); if (!l) return;
  box.append(h('div', 'label inline', state.swipe ? 'HH · shared scale' : l.label));
  if (isNumber(l.min) && isNumber(l.max)) {
    const c = h('canvas'); box.append(c);
    ramp(c, Array.isArray(l.ramp) ? l.ramp : [[0, '#000'], [1, '#fff']]);
    box.append(put(h('div', 'ends'), h('span', '', `${l.min} ${l.units}`), h('span', '', `${l.max} ${l.units}`)));
  }
  for (const [ch, name, range] of l.channels || []) box.append(put(h('div', 'ch'), h('b', '', ch), h('span', '', name), h('span', '', `${range[0]}…${range[1]} dB`)));
  box.append(h('p', '', l.description || ''));
}

// ---------------------------------------------------------------- guided walkthrough
function setStep(i) {
  const d = state.data; if (!d || !state.map) return;
  state.step = i;
  for (const b of document.querySelectorAll('[data-step]')) b.setAttribute('aria-pressed', String(b.dataset.step === String(i)));
  const story = $('story'); if (i === 'free') { story.hidden = true; return; }
  const site = d.sites.find(x => x.status === 'contradicted') || d.sites[0];
  const after = d.acquisitions.find(a => a.role === 'after'), ref = d.acquisitions.find(a => a.role === 'reference-after');
  const hrs = after && ref ? Math.abs(Date.parse(after.acquiredAt) - Date.parse(ref.acquiredAt)) / 36e5 : null;
  const f = d.findings || [];
  const steps = [
    { layer: 'mtc', on: ['footprints', 'sites'], off: ['change', 'quality'], fit: true,
      text: 'Red: the radar return dropped between 12 Sep and 06 Oct. Cyan: it rose. Grey: stable. Darker is not automatically water.' },
    { layer: 'reference-after', on: ['sites'], off: ['change', 'quality'], site,
      text: `Independent optical image${isNumber(hrs) ? `, ${Math.round(hrs)} h before the radar pass` : ''}: the most-darkened spot (red diamond) shows no exposed water — sand beside a thin channel.` },
    { layer: 'delta', on: ['change', 'sites'], off: ['quality'], site,
      text: `${f[0]?.value ?? 'n/a'} darkened units are visibly dry, and the detector flags ${f[1]?.value ?? 'n/a'} dry units. Darkening alone is not flood evidence.` }][i];
  if (state.swipe) toggleSwipe(false);
  if (layerById(steps.layer)) state.active = steps.layer;
  steps.on.forEach(x => state.on.add(x)); steps.off.forEach(x => state.on.delete(x));
  renderLayerList(); renderOverlayList(); renderLegend(); renderMapLayers(); renderHud();
  if (steps.fit) { state.map.fitBounds(llBounds(d.study.bounds), { padding: [40, 40] }); state.site = null; renderInspector(null); renderSites(); }
  else if (steps.site) { state.map.setView([steps.site.lat, steps.site.lon], 14); inspectAt(steps.site.lon, steps.site.lat, steps.site); }
  story.textContent = steps.text; story.hidden = false;
}

// ---------------------------------------------------------------- scene: map
function initMap() {
  if (state.map || !globalThis.L || !state.data) return;
  const L = globalThis.L, map = L.map('map', { zoomSnap: 0.25, minZoom: 6, maxZoom: 16, attributionControl: true });
  state.map = map;
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  map.createPane('swipe').style.zIndex = '405';
  const vec = map.createPane('vectors'); vec.style.zIndex = '440';
  const gibs = (layer, set, ext) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${set}/{z}/{y}/{x}.${ext}`;
  const remote = gibs('ASTER_GDEM_Greyscale_Shaded_Relief', 'GoogleMapsCompatible_Level12', 'jpeg');
  const Relief = L.TileLayer.extend({
    getTileUrl(c) { const k = `${c.z}/${c.y}/${c.x}`; return state.tileKeys?.has(k) ? `./tiles/relief/${k}.jpg` : L.Util.template(remote, c); },
    createTile(coords, done) {
      const tile = document.createElement('img'), url = this.getTileUrl(coords); let tries = 0;
      tile.alt = ''; tile.setAttribute('role', 'presentation');
      tile.onload = () => done(null, tile);
      tile.onerror = () => { if (++tries <= 3) setTimeout(() => { tile.src = `${url}${url.includes('?') ? '&' : '?'}retry=${tries}`; }, 350 * tries); else done(new Error('tile unavailable'), tile); };
      tile.src = url; return tile;
    } });
  const relief = new Relief(remote, { maxNativeZoom: 12, maxZoom: 16, attribution: 'Relief: NASA GIBS · ASTER GDEM (cached locally)' });
  let loaded = 0; relief.on('tileload', () => { loaded++; $('basemap-status').hidden = true; }); relief.on('tileerror', () => { if (!loaded) $('basemap-status').hidden = false; });
  relief.addTo(map);
  map.createPane('grat').style.zIndex = '415'; map.getPane('grat').style.pointerEvents = 'none';
  map.on('moveend zoomend', drawGraticule);
  map.fitBounds(llBounds(state.data.study.bounds), { padding: [40, 40] });
  drawGraticule();
  map.on('click', e => inspectAt(e.latlng.lng, e.latlng.lat, null));
  map.on('mousemove', e => cursor(e.latlng.lng, e.latlng.lat));
  map.on('move zoom resize zoomend moveend', clipSwipe);
  map.on('zoomend', () => map.getContainer().classList.toggle('px', map.getZoom() >= 14));
  renderMapLayers();
}
function overlay(id, pane) {
  const key = pane ? `${id}@${pane}` : id, l = layerById(id); if (!l) return null;
  if (!state.overlays[key]) {
    const o = globalThis.L.imageOverlay(bust(l.url), llBounds(l.bounds), { interactive: false, pane: pane || 'overlayPane' });
    o.on('error', () => announce(`${l.label} failed to load.`)); state.overlays[key] = o;
  }
  return state.overlays[key];
}
function renderMapLayers() {
  const map = state.map, L = globalThis.L; if (!map) return;
  Object.values(state.overlays).forEach(o => map.removeLayer(o));
  if (state.swipe) { overlay('before').setOpacity(state.opacity).addTo(map); overlay('after', 'swipe').setOpacity(state.opacity).addTo(map); clipSwipe(); }
  else { const o = overlay(state.active); if (o) o.setOpacity(state.opacity).addTo(map); }
  if (state.on.has('quality')) overlay('quality')?.addTo(map);
  if (state.on.has('change')) overlay('change')?.addTo(map);
  state.vectors?.remove(); state.siteLayer?.remove();
  if (state.on.has('footprints') && state.data.footprints) {
    const style = f => ({ radar: { color: '#d24dff', weight: 1.5, dashArray: '6 4', fill: false }, optical: { color: '#959599', weight: 1, dashArray: '2 4', fill: false },
      rejected: { color: '#fc3d21', weight: 1.5, dashArray: '5 4', fill: false }, aoi: { color: '#ffffff', weight: 1.2, fill: false } }[f.properties.role]);
    const feats = state.data.footprints.features.filter((f, i, all) => f.properties.role !== 'radar' || all.findIndex(g => g.properties.role === 'radar') === i);
    const [bw, bs, be, bn] = state.data.study.bounds, dx = (be - bw) * 0.08, dy = (bn - bs) * 0.08;
    const brackets = [[[bn - dy, bw], [bn, bw], [bn, bw + dx]], [[bn, be - dx], [bn, be], [bn - dy, be]], [[bs + dy, be], [bs, be], [bs, be - dx]], [[bs, bw + dx], [bs, bw], [bs + dy, bw]]];
    state.vectors = L.layerGroup([L.geoJSON({ type: 'FeatureCollection', features: feats.filter(f => f.properties.role !== 'aoi') }, { pane: 'vectors', style, interactive: false,
      onEachFeature: (f, lyr) => { if (f.properties.role === 'rejected') lyr.bindTooltip(f.properties.label, { permanent: true, direction: 'top', className: 'tag', offset: [0, -4] }); } }),
      ...brackets.map(b => L.polyline(b, { pane: 'vectors', color: '#fff', weight: 1.5, interactive: false }))]).addTo(map);
  }
  if (state.on.has('sites')) {
    state.siteLayer = L.layerGroup(state.data.sites.map(site => L.marker([site.lat, site.lon], { pane: 'vectors', keyboard: true, title: site.name,
      icon: L.divIcon({ className: `site-marker ${site.status}`, iconSize: [14, 14] }) }).on('click', ev => { L.DomEvent.stopPropagation(ev); selectSite(site.id); }))).addTo(map);
  }
}
function toggleSwipe(on) {
  state.swipe = on; $('compare').setAttribute('aria-pressed', String(on)); $('swipe').hidden = !on;
  if (!on && state.map) state.map.getPane('swipe').style.clip = '';
  renderLegend(); renderMapLayers();
}
function clipSwipe() {
  const map = state.map; if (!map || !state.swipe) return;
  const pane = map.getPane('swipe'), size = map.getSize(), nw = map.containerPointToLayerPoint([0, 0]), se = map.containerPointToLayerPoint(size);
  const x = nw.x + size.x * Number($('swipe-range').value) / 100;
  pane.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
}
function cursor(lon, lat) {
  const cell = inspectorCell(state.data?.inspector, lon, lat), u = cell && state.inspector ? readUnit(state.data.inspector, state.inspector, cell) : null;
  const r = $('cursor'); r.replaceChildren(h('b', '', `${lat.toFixed(5)}N  ${lon.toFixed(5)}E`), document.createTextNode(`   MGRS ${mgrs(lon, lat) || 'n/a'}`), h('br'),
    document.createTextNode(u ? `HH ${db(u.hhBefore)} → ${db(u.hhAfter)}   Δ ${db(u.delta)}` : 'outside analysis grid'));
}

function drawGraticule() {
  const map = state.map, L = globalThis.L; if (!map) return;
  state.grat?.remove(); const b = map.getBounds(), span = Math.min(b.getEast() - b.getWest(), b.getNorth() - b.getSouth());
  const step = [5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01, 0.005].find(v => span / v >= 3) || 0.005, digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const lines = [], labels = [], label = (ll, text, anchor) => L.marker(ll, { icon: L.divIcon({ className: 'grat-label', html: text, iconSize: null, iconAnchor: anchor }), interactive: false, keyboard: false, pane: 'grat' });
  for (let x = Math.ceil(b.getWest() / step) * step; x <= b.getEast(); x += step) { lines.push([[b.getSouth(), x], [b.getNorth(), x]]); labels.push(label([b.getNorth(), x], `${x.toFixed(digits)}°E`, [-3, -4])); }
  for (let y = Math.ceil(b.getSouth() / step) * step; y <= b.getNorth(); y += step) { lines.push([[y, b.getWest()], [y, b.getEast()]]); labels.push(label([y, b.getWest()], `${y.toFixed(digits)}°N`, [-4, 12])); }
  state.grat = L.layerGroup([...lines.map(l => L.polyline(l, { color: '#ffffff', opacity: 0.09, weight: 1, interactive: false, pane: 'grat' })), ...labels]).addTo(map);
}
function renderHud() {
  const hud = $('hud'), o = state.data?.orbit; if (!hud || !o) return;
  const l = layerById(state.swipe ? 'after' : state.active), nisar = state.data.acquisitions.find(a => a.sensor === 'NISAR');
  hud.replaceChildren(h('b', '', `NISAR L2 GCOV · T${String(o.track).padStart(3, '0')} F${String(o.frame).padStart(3, '0')} · ${String(o.direction).slice(0, 3).toUpperCase()} · ${String(o.lookDirection).toUpperCase()}-LOOKING`), h('br'),
    document.createTextNode(`L-BAND · HH/HV · 10 m · ${nisar?.processingVersion || ''}`), h('br'), document.createTextNode(l ? `LAYER  ${l.label}` : ''));
}
function renderVerification() {
  const ul = $('verify'), v = state.verification; if (!ul) return; ul.replaceChildren();
  if (!v) { ul.append(h('li', '', 'No verification record for this run.')); $('verify-note').textContent = ''; return; }
  $('verify-note').textContent = `${v.checks.filter(c => c.pass).length}/${v.checks.length} pass`;
  for (const c of v.checks) { const li = h('li'), title = h('b'); put(title, h('span', `badge ${c.pass ? 'go' : 'no-go'}`, c.pass ? 'PASS' : 'FAIL'), h('span', '', `  ${c.label}`));
    ul.append(put(li, title, h('code', '', `${c.value} ${c.unit}`.trim()), h('small', '', `${c.detail} · tolerance ${c.tolerance}`))); }
}
function renderAccuracy() {
  const box = $('accuracy'), a = state.data?.accuracy; if (!box) return; box.replaceChildren();
  if (!a) { box.append(h('p', 'hint', 'No accuracy run recorded.')); return; }
  const m = a.supervised, pct = v => isNumber(v) ? (v * 100).toFixed(1) : 'n/a', ci = k => m.ci95?.[k] ? `${pct(m.ci95[k][0])}–${pct(m.ci95[k][1])}%` : 'n/a';
  $('acc-note').textContent = `${a.units.test.toLocaleString('en-US')} held-out units · ${a.units.testBlocks} blocks`;
  const row = h('div', 'bigrow');
  for (const [k, lab] of [['f1', 'F1'], ['balancedAccuracy', 'Balanced acc.'], ['mcc', 'MCC']]) {
    const d = h('div', '', k === 'mcc' ? (isNumber(m.mcc) ? m.mcc.toFixed(3) : 'n/a') : `${pct(m[k])}%`);
    put(d, h('small', '', lab), h('em', '', k === 'mcc' ? (m.ci95?.mcc ? `95% CI ${m.ci95.mcc[0].toFixed(3)}–${m.ci95.mcc[1].toFixed(3)}` : '') : `95% CI ${ci(k)}`)); row.append(d); }
  box.append(row);
  const t = h('table', 'counts'), c = m.counts, n = v => Number(v).toLocaleString('en-US');
  for (const [k, v] of [['Water → water (TP)', n(c.tp)], ['Land → water (FP)', n(c.fp)], ['Water missed (FN)', n(c.fn)], ['Land → land (TN)', n(c.tn)],
    ['Precision · recall', `${pct(m.precision)}% · ${pct(m.recall)}%`], ['Overall accuracy', `${pct(m.accuracy)}%  (${ci('accuracy')})`],
    ['Units · radar-valid / labelled / total', `${n(a.units.radarValid)} / ${n(a.units.referenceKnown)} / ${n(a.units.total)}`],
    ['Threshold · dev blocks only', `HH ≤ ${m.threshold.toFixed(2)} dB`], ['Label-free Otsu', `HH ≤ ${a.otsu.threshold.toFixed(2)} dB · F1 ${pct(a.otsu.f1)}% · MCC ${isNumber(a.otsu.mcc) ? a.otsu.mcc.toFixed(3) : 'n/a'}`]]) { const tr = h('tr'); t.append(put(tr, h('td', '', k), h('td', '', v))); }
  box.append(t);
  if (a.figure && safeUrl(a.figure)) { const img = h('img', 'acc-figure'); img.src = bust(a.figure); img.alt = 'Held-out test units: blue correct water, red false water, amber missed water, grey correct land'; box.append(img); }
  box.append(put(h('ul', 'key'), ...[['#4fb3ff', 'water hit'], ['#fc3d21', 'false water'], ['#f5a524', 'missed water'], ['#5a5a60', 'land correct'], ['#284a75', 'water · dev/buffer']].map(([col, tx]) => { const li = h('li'), i = h('i'); i.setAttribute('style', `background:${col}`); return put(li, i, document.createTextNode(tx)); })));
  box.append(h('p', 'small', a.scope || ''));
}

// ---------------------------------------------------------------- inspector
function inspectAt(lon, lat, site) {
  const hdr = state.data?.inspector, cell = inspectorCell(hdr, lon, lat);
  state.unit = cell && state.inspector ? readUnit(hdr, state.inspector, cell) : null; state.site = site;
  if (state.map) { state.pin?.remove(); state.pin = globalThis.L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 1.5, fill: false, pane: 'vectors', interactive: false }).addTo(state.map); }
  renderInspector({ lon, lat, cell }); drawDecision(state.unit); renderSites();
}
function renderInspector(at) {
  const body = $('inspect-body'); body.replaceChildren();
  if (!at) { body.append(h('p', 'hint', state.data?.inspector ? 'Click anywhere in the analysis area.' : 'No inspector grid in this run.')); return; }
  const { lon, lat, cell } = at, hdr = state.data.inspector, u = state.unit;
  const co = h('p', 'coords'); put(co, h('b', '', `${lat.toFixed(5)}° N  ${lon.toFixed(5)}° E`));
  if (cell) { co.append(h('br'), document.createTextNode(`UTM ${hdr.utmZone}${hdr.hemisphere} · E ${Math.round(cell.x).toLocaleString('en-US')} · N ${Math.round(cell.y).toLocaleString('en-US')}`),
    h('br'), document.createTextNode(`unit row ${cell.row} · col ${cell.col} · ${hdr.unitMeters} m`)); }
  body.append(co);
  if (!cell) { body.append(h('p', 'verdict', 'Outside the analysis grid. No measurement or reference here.')); return; }
  if (!u) { body.append(h('p', 'verdict unknown', 'Inspector values unavailable.')); return; }
  const geo = geometryAt(hdr.geometryGrid, cell.x, cell.y), t = h('table', 'readings');
  const rows = [['HH · 12 Sep', db(u.hhBefore)], ['HH · 06 Oct', db(u.hhAfter)], ['ΔHH', db(u.delta), isNumber(u.delta) ? (u.delta < 0 ? 'neg' : 'pos') : ''],
    ['HV · 12 Sep', db(u.hvBefore)], ['HV · 06 Oct', db(u.hvAfter)],
    ['Incidence θ', geo ? `${geo.incidenceDeg.toFixed(2)}°` : 'n/a'], ['Slant range', geo ? `${formatNumber(geo.slantRangeKm, 1)} km` : 'n/a']];
  for (const [k, v, cls] of rows) { const tr = h('tr'); const td = h('td', cls || '', v); put(t, put(tr, h('th', '', k), td)); }
  body.append(t);
  const p = state.data.provenance.parameters || {}, opt = { 0: 'no exposed water', 1: 'exposed water', null: 'not interpretable' };
  const det = !u.detectorKnown ? 'unknown' : u.detector === 1 ? 'candidate' : 'no candidate';
  const dl = h('dl', 'codes');
  for (const [k, v] of [['Detector', `${det}`], [`Δ ≤ ${p.dropDb} dB`, isNumber(u.delta) ? (u.delta <= p.dropDb ? 'yes' : 'no') : 'n/a'],
    [`Oct 6 ≤ ${p.darkDb} dB`, isNumber(u.hhAfter) ? (u.hhAfter <= p.darkDb ? 'yes' : 'no') : 'n/a'], ['HLS · 06 Oct', opt[u.opticalAfter]], ['HLS · 13 Sep', opt[u.opticalBefore]]]) put(dl, h('dt', '', k), h('dd', '', v));
  body.append(dl);
  const v = unitVerdict(u, p.dropDb); body.append(h('p', `verdict ${v.tone}`, v.text));
  if (state.site) {
    const s = state.site; body.append(h('h2', 'label', s.name));
    for (const ev of s.evidence || []) { const d = h('div', 'small'); put(d, h('b', '', `${ev.source}`), h('br'), document.createTextNode(`${utc(ev.acquiredAt)} UTC · ${isNumber(ev.timeOffsetHours) ? `${ev.timeOffsetHours} h from radar` : ''}`), h('br'), document.createTextNode(ev.interpretation || '')); d.setAttribute('style', 'margin-bottom:8px'); body.append(d); }
    if (s.alternatives?.length) { body.append(h('p', 'small', 'Alternative explanations')); const ul = h('ul', 'plain'); s.alternatives.forEach(a => ul.append(h('li', '', a))); body.append(ul); }
  }
}
function renderSites() {
  const box = $('sites'); box.replaceChildren();
  if (!state.data?.sites.length) { box.append(h('p', 'hint', 'No curated sites in this run.')); return; }
  for (const s of state.data.sites) {
    const b = h('button', `site ${s.status}`); b.type = 'button'; b.setAttribute('aria-pressed', String(state.site?.id === s.id));
    put(b, h('i'), put(h('span'), h('b', '', s.name), h('small', '', `${s.status} · Δ ${db(s.observations?.deltaDb)}`)));
    b.addEventListener('click', () => selectSite(s.id)); box.append(b);
  }
}
function selectSite(id) {
  const s = state.data.sites.find(x => x.id === id); if (!s) return;
  if (state.current !== 'scene') setView('scene');
  state.map?.setView([s.lat, s.lon], Math.max(state.map.getZoom(), 14));
  inspectAt(s.lon, s.lat, s);
}

// ---------------------------------------------------------------- charts
function prep(canvas) {
  if (!canvas?.getContext) return null; const w = canvas.clientWidth || canvas.width, hh = Math.round(w * canvas.height / canvas.width) || canvas.height, dpr = globalThis.devicePixelRatio || 1;
  canvas.style && (canvas.style.height = `${hh}px`); canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, hh); return { ctx, w, h: hh };
}
const MONO = '10px "DM Mono", ui-monospace, monospace';
function drawDecision(u) {
  const c = $('decision'), dens = state.data?.charts?.density; if (!dens) return;
  const keepH = c.height; c.height = 250; c.width = 320; const P = prep(c); if (!P) { c.height = keepH; return; }
  const { ctx, w, h: H } = P, m = { l: 40, r: 8, t: 8, b: 30 }, lo = dens.edges[0], hi = dens.edges[dens.edges.length - 1];
  const X = v => m.l + (v - lo) / (hi - lo) * (w - m.l - m.r), Y = v => H - m.b - (v - lo) / (hi - lo) * (H - m.t - m.b);
  const max = Math.max(...dens.counts.flat()), lmax = Math.log1p(max);
  dens.counts.forEach((row, i) => row.forEach((n, j) => { if (!n) return; const t = Math.log1p(n) / lmax;
    ctx.fillStyle = `rgba(${Math.round(60 + 195 * t)},${Math.round(90 + 165 * t)},${Math.round(140 + 115 * t)},${0.25 + 0.75 * t})`;
    ctx.fillRect(X(dens.edges[j]), Y(dens.edges[i + 1]), X(dens.edges[j + 1]) - X(dens.edges[j]) + 0.5, Y(dens.edges[i]) - Y(dens.edges[i + 1]) + 0.5); }));
  const p = state.data.provenance.parameters || {};
  if (isNumber(p.dropDb) && isNumber(p.darkDb)) {
    const k = p.darkDb - p.dropDb; ctx.beginPath(); ctx.moveTo(X(lo - p.dropDb > lo ? lo - p.dropDb : lo), Y(lo)); ctx.lineTo(X(Math.max(lo, lo - p.dropDb)), Y(lo));
    ctx.lineTo(X(k), Y(p.darkDb)); ctx.lineTo(X(hi), Y(p.darkDb)); ctx.lineTo(X(hi), Y(lo)); ctx.closePath();
    ctx.fillStyle = 'rgba(245,165,36,0.14)'; ctx.fill(); ctx.setLineDash([4, 3]); ctx.strokeStyle = '#f5a524'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.setLineDash([2, 3]); ctx.strokeStyle = '#6b6b70'; ctx.beginPath(); ctx.moveTo(X(lo), Y(lo)); ctx.lineTo(X(hi), Y(hi)); ctx.stroke(); ctx.setLineDash([]);
  for (const [b, a, ref] of state.data.charts.dropUnits || []) { ctx.beginPath(); ctx.arc(X(b), Y(a), 3, 0, 6.283); ctx.strokeStyle = ref === 0 ? '#fc3d21' : ref === 1 ? '#4fb3ff' : '#959599'; ctx.lineWidth = 1.3; ctx.stroke(); }
  if (u && isNumber(u.hhBefore) && isNumber(u.hhAfter)) { const x = X(u.hhBefore), y = Y(u.hhAfter); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke(); }
  ctx.fillStyle = '#959599'; ctx.font = MONO; ctx.strokeStyle = '#26262b'; ctx.lineWidth = 1;
  for (let v = lo; v <= hi; v += 5) { ctx.fillText(String(v), X(v) - 8, H - m.b + 13); ctx.fillText(String(v), 6, Y(v) + 3); }
  ctx.fillText('HH 12 SEP (dB)', w / 2 - 34, H - 4);
  ctx.strokeRect(m.l, m.t, w - m.l - m.r, H - m.t - m.b);
  $('decision-n').textContent = `${dens.n.toLocaleString('en-US')} units · y: HH 06 Oct`;
  $('decision-key').replaceChildren(...[['rgba(245,165,36,.5)', 'detector region'], ['#fc3d21', 'darkened ≥3 dB, dry Oct 6'], ['#fff', 'inspected unit']].map(([c, t]) => { const li = h('li'); const i = h('i'); i.setAttribute('style', `background:${c}`); return put(li, i, document.createTextNode(t)); }));
}
function drawHistogram() {
  const c = $('hist'), hist = state.data?.charts?.deltaHistogram; if (!hist) return;
  c.width = 360; c.height = 200; const P = prep(c); if (!P) return;
  const { ctx, w, h: H } = P, m = { l: 34, r: 8, t: 10, b: 26 }, lo = hist.edges[0], hi = hist.edges[hist.edges.length - 1];
  const X = v => m.l + (v - lo) / (hi - lo) * (w - m.l - m.r), lmax = Math.log10(1 + Math.max(...hist.counts));
  hist.counts.forEach((n, i) => { if (!n) return; const y = (H - m.b) - Math.log10(1 + n) / lmax * (H - m.t - m.b);
    ctx.fillStyle = hist.edges[i + 1] <= (state.data.provenance.parameters?.dropDb ?? -Infinity) ? '#fc3d21' : '#8a8a90'; ctx.fillRect(X(hist.edges[i]) + 0.5, y, X(hist.edges[i + 1]) - X(hist.edges[i]) - 1, H - m.b - y); });
  const vline = (v, color, label, dy) => { ctx.strokeStyle = color; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(v), m.t); ctx.lineTo(X(v), H - m.b); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = color; ctx.fillText(label, X(v) + 4, m.t + dy); };
  ctx.font = MONO; vline(state.data.provenance.parameters?.dropDb ?? -3, '#f5a524', `drop ${state.data.provenance.parameters?.dropDb} dB`, 10); vline(hist.median, '#ffffff', `median ${hist.median > 0 ? '+' : ''}${hist.median.toFixed(2)}`, 24);
  ctx.fillStyle = '#959599'; for (let v = lo; v <= hi; v += 4) ctx.fillText(String(v), X(v) - 6, H - m.b + 13); ctx.fillText('log count', 0, m.t + 4);
  ctx.strokeStyle = '#26262b'; ctx.strokeRect(m.l, m.t, w - m.l - m.r, H - m.t - m.b);
  $('hist-n').textContent = `${hist.n.toLocaleString('en-US')} units · ΔHH dB`;
}
function drawTimeline() {
  const svg = $('timeline'); if (!svg || !document.createElementNS || !svg.getBoundingClientRect) return; const box = svg.getBoundingClientRect(); if (!box.width) return;
  const NS = 'http://www.w3.org/2000/svg', W = box.width, H = 80, ev = state.data.acquisitions.filter(a => a.acquiredAt);
  if (!ev.length) return; svg.replaceChildren(); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const times = ev.map(a => Date.parse(a.acquiredAt)), t0 = Math.min(...times) - 3 * 864e5, t1 = Math.max(...times) + 3 * 864e5, X = t => 24 + (t - t0) / (t1 - t0) * (W - 48);
  const mk = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); if (text) n.textContent = text; svg.append(n); return n; };
  mk('line', { x1: 24, x2: W - 24, y1: 40, y2: 40, stroke: '#3a3a3f' });
  for (let t = Math.ceil(t0 / 864e5) * 864e5; t < t1; t += 864e5) { const d = new Date(t); const major = d.getUTCDay() === 1;
    mk('line', { x1: X(t), x2: X(t), y1: major ? 34 : 37, y2: 40, stroke: major ? '#6b6b70' : '#3a3a3f' });
    if (major) mk('text', { x: X(t) + 3, y: 76 }, `${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }).toUpperCase()} ${d.getUTCDate()}`); }
  for (const a of ev) { const x = X(Date.parse(a.acquiredAt)), sar = a.sensor === 'NISAR', g = mk('g', { class: 'ev' });
    const shape = document.createElementNS(NS, sar ? 'rect' : 'circle');
    if (sar) { shape.setAttribute('x', x - 4); shape.setAttribute('y', 36); shape.setAttribute('width', 8); shape.setAttribute('height', 8); shape.setAttribute('transform', `rotate(45 ${x} 40)`); shape.setAttribute('fill', '#fff'); }
    else { shape.setAttribute('cx', x); shape.setAttribute('cy', 40); shape.setAttribute('r', 3.5); shape.setAttribute('fill', '#000'); shape.setAttribute('stroke', '#d1d1d1'); }
    const early = a.role === 'before' || a.role === 'reference-before';
    g.append(shape); const t = document.createElementNS(NS, 'text'); t.setAttribute('x', early ? x + 8 : x - 8); t.setAttribute('y', sar ? 22 : 62);
    t.setAttribute('text-anchor', early ? 'start' : 'end'); t.textContent = `${sar ? 'NISAR' : 'HLS'} ${utc(a.acquiredAt).slice(0, 6)} ${utc(a.acquiredAt).slice(12)}Z`; g.append(t); }
}

// ---------------------------------------------------------------- evidence + method
function renderGates() {
  const t = $('gates'); t.replaceChildren();
  const gates = state.data.gates || []; if (!gates.length) { const tr = h('tr'); tr.append(h('td', '', 'No gate record in this run.')); t.append(tr); return; }
  for (const g of gates) { const tr = h('tr'), a = h('td'), b = h('td');
    put(a, h('b', '', g.label), h('code', '', g.value), h('small', '', g.consequence)); put(b, h('span', `badge ${g.result}`, g.result === 'go' ? 'GO' : g.result === 'no-go' ? 'NO-GO' : 'HOLD'));
    t.append(put(tr, a, b)); }
}
function renderFindings() {
  const box = $('findings'); box.replaceChildren();
  const f = state.data.findings || []; if (!f.length) box.append(h('p', 'hint', 'No findings recorded. Coverage and metrics are not available.'));
  for (const x of f) box.append(put(h('div', 'finding'), h('div', 'num', x.value), h('div', 'what', x.label), h('div', 'note', x.note || '')));
  const ul = $('not-shown'); ul.replaceChildren(); (state.data.notShown || state.data.provenance.limitations.slice(0, 3)).forEach(x => ul.append(h('li', '', x)));
}
function renderCounts() {
  const m = state.data.metrics, t = $('counts'); t.replaceChildren();
  if (!m) { const tr = h('tr'); tr.append(h('td', '', 'No evaluation recorded.')); t.append(tr); $('counts-scope').textContent = ''; return; }
  const c = m.counts || {}, n = v => isNumber(v) ? v.toLocaleString('en-US') : 'n/a', r = (num, den) => den ? `${(num / den * 100).toFixed(1)}% · ${n(num)}/${n(den)}` : `undefined · ${n(num)}/${n(den)}`;
  const rows = [['True positive', n(c.tp)], ['False positive', n(c.fp)], ['Missed (FN)', n(c.fn)], ['True negative', n(c.tn)],
    ['Precision', r(c.tp, c.tp + c.fp)], ['Recall', r(c.tp, c.tp + c.fn)], ['False-positive rate', r(c.fp, c.fp + c.tn)], ['Not interpretable', n(m.unknownReferenceCount)]];
  for (const [k, v] of rows) { const tr = h('tr'); t.append(put(tr, h('td', '', k), h('td', '', v))); }
  $('counts-scope').textContent = `${m.scope} ${m.uncertaintyNote || ''}`;
}
function renderSensitivity() {
  const t = $('sensitivity'); t.replaceChildren(); const p = state.data.provenance.parameters, s = p?.sensitivity; if (!s?.length) return;
  const drops = [...new Set(s.map(x => x.dropDb))], darks = [...new Set(s.map(x => x.darkDb))], max = Math.max(...s.map(x => x.candidateKm2), 1e-9);
  const head = h('tr'); head.append(h('th', '', 'drop \\ dark')); darks.forEach(d => head.append(h('th', '', `${d}`))); t.append(head);
  for (const d of drops) { const tr = h('tr'); tr.append(h('th', '', `${d}`));
    for (const k of darks) { const v = s.find(x => x.dropDb === d && x.darkDb === k)?.candidateKm2, td = h('td', d === p.dropDb && k === p.darkDb ? 'proposed' : '', isNumber(v) ? v.toFixed(3) : 'n/a');
      if (isNumber(v)) td.setAttribute('style', `background:rgba(245,165,36,${(0.08 + 0.5 * v / max).toFixed(3)})`); tr.append(td); }
    t.append(tr); }
}
function renderMethod() {
  const d = state.data, steps = d.provenance.steps || [d.provenance.method];
  $('method-steps').replaceChildren(...steps.map(s => h('li', '', s)));
  $('limitations').replaceChildren(...d.provenance.limitations.map(s => h('li', '', s)));
  $('acquisitions').replaceChildren(...d.acquisitions.map(a => { const box = h('div'); const href = safeUrl(a.href);
    const title = href ? (() => { const x = h('a', '', `${a.sensor} · ${a.role}`); x.href = href; x.target = '_blank'; x.rel = 'noopener noreferrer'; return x; })() : h('b', '', `${a.sensor} · ${a.role}`);
    return put(box, title, h('code', '', `${a.id} · ${utc(a.acquiredAt)} UTC${a.processingVersion ? ` · ${a.processingVersion}` : ''}${a.maturity ? ` · ${a.maturity}` : ''}`)); }));
  $('sources').replaceChildren(...d.provenance.sources.map(s => { const li = h('li'), href = safeUrl(s.url); const a = href ? h('a', '', s.title) : h('span', '', s.title); if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; } return put(li, a, h('small', '', String(s.accessedAt || '').slice(0, 10))); }));
  $('run').replaceChildren(...[['Run', d.provenance.runId], ['Generated', d.provenance.generatedAt ? `${utc(d.provenance.generatedAt)} UTC` : null], ['Status', d.status], ['Schema', `v${d.schemaVersion}`]].map(([k, v]) => put(h('div'), h('dt', '', k), h('dd', '', v || 'n/a'))));
}

// ---------------------------------------------------------------- wiring
function exportCase() {
  if (!state.raw || !globalThis.Blob || !globalThis.URL?.createObjectURL) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.raw, null, 2)], { type: 'application/json' }));
  const a = h('a'); a.href = url; a.download = `${state.raw.provenance.runId || 'case'}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('retry').addEventListener('click', load);
for (const b of document.querySelectorAll('[data-step]')) b.addEventListener('click', () => setStep(b.dataset.step === 'free' ? 'free' : Number(b.dataset.step)));
for (const b of document.querySelectorAll('[data-preset]')) b.addEventListener('click', () => {
  const d = state.data; if (!d) return;
  if (b.dataset.preset === 'gandak') { const [w, s, e, n] = d.study.bounds; runFinder((s + n) / 2, (w + e) / 2); }
  else { const kb = d.accuracy?.bounds; runFinder(kb ? (kb[1] + kb[3]) / 2 : 26.51, kb ? (kb[0] + kb[2]) / 2 : 86.89); }
});
$('finder-form').addEventListener('submit', ev => { ev.preventDefault(); const m = String($('finder-input').value).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/); if (m) runFinder(Number(m[1]), Number(m[2])); });
$('finder-geo').addEventListener('click', () => globalThis.navigator?.geolocation?.getCurrentPosition(pos => runFinder(pos.coords.latitude, pos.coords.longitude), () => announce('Location unavailable.')));
$('export-case').addEventListener('click', exportCase);
$('compare').addEventListener('click', () => toggleSwipe(!state.swipe));
$('swipe-range').addEventListener('input', clipSwipe);
$('opacity').addEventListener('input', e => { state.opacity = Number(e.target.value) / 100; Object.values(state.overlays).forEach(o => o.setOpacity?.(state.opacity)); });
$('open-scene').addEventListener('click', () => {
  if (state.globe && state.aoiCenter) { state.globe.controls().autoRotate = false; state.globe.pointOfView({ ...state.aoiCenter, altitude: 0.03 }, 2200); setTimeout(() => setView('scene'), 3400); }
  else setView('scene');
});
for (const b of document.querySelectorAll('.views button')) b.addEventListener('click', () => setView(b.dataset.view));
const initial = (globalThis.location?.hash || '').slice(1);
if (['scene', 'evidence', 'method'].includes(initial)) setView(initial);
if (document.readyState === 'loading') document.addEventListener?.('DOMContentLoaded', drawStars); else drawStars();
load();
