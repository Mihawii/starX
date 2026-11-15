export const isNumber = value => typeof value === 'number' && Number.isFinite(value);
export const formatNumber = (value, digits=1) => isNumber(value) ? value.toLocaleString('en-GB',{minimumFractionDigits:digits,maximumFractionDigits:digits}) : 'Not available';
export const formatRatio = value => isNumber(value) && value >= 0 && value <= 1 ? `${formatNumber(value*100)}%` : 'Not defined';
export const formatDate = (value, short=false) => {
  if (!value || Number.isNaN(new Date(value).valueOf())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',...(short?{}:{hour:'2-digit',minute:'2-digit',timeZoneName:'short'}),timeZone:'UTC'}).format(new Date(value));
};
export const validBounds = bounds => Array.isArray(bounds) && bounds.length===4 && bounds.every(isNumber) && bounds[0]>=-180 && bounds[2]<=180 && bounds[1]>=-90 && bounds[3]<=90 && bounds[0]<bounds[2] && bounds[1]<bounds[3];
export function safeUrl(value) {
  if(typeof value!=='string' || !value.trim()) return null;
  try {
    const url=new URL(value,'https://local.invalid/');
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(k=>/token|signature|credential|authorization/i.test(k))) return null;
    return value;
  } catch { return null; }
}
export function validateCase(value) {
  if(!value || typeof value!=='object' || value.schemaVersion!==1) throw new Error('Unsupported or missing case schema. Expected version 1.');
  if(!['awaiting-data','observed','evaluated'].includes(value.status)) throw new Error('Case status is missing or invalid.');
  if(!value.study || !validBounds(value.study.bounds)) throw new Error('Case study bounds are missing or invalid.');
  for(const key of ['acquisitions','layers','sites']) if(!Array.isArray(value[key])) throw new Error(`Case ${key} must be an array.`);
  if(!value.provenance || typeof value.provenance!=='object' || !value.coverage || typeof value.coverage!=='object') throw new Error('Case coverage or provenance is missing.');
  const object=item=>item && typeof item==='object' && !Array.isArray(item);
  const array=(item,key)=>{if(item[key]!=null&&!Array.isArray(item[key]))throw new Error(`Case ${key} must be an array.`);};
  const strings=(item,key)=>{array(item,key);if(item[key]?.some(entry=>typeof entry!=='string'))throw new Error(`Case ${key} must contain text.`);};
  for(const acquisition of value.acquisitions)if(!object(acquisition))throw new Error('Invalid acquisition record.');
  for(const layer of value.layers)if(!object(layer))throw new Error('Invalid layer record.');
  for(const site of value.sites){
    if(!object(site) || !isNumber(site.lon) || !isNumber(site.lat) || Math.abs(site.lon)>180 || Math.abs(site.lat)>90 || !site.id) throw new Error('Invalid evidence site coordinates or ID.');
    if(!['supported','candidate','contradicted','no-change','unresolved'].includes(site.status))throw new Error('Invalid evidence category.');
    array(site,'evidence');strings(site,'alternatives');
    if(site.observations!=null){if(!object(site.observations))throw new Error('Invalid observations.');array(site.observations,'series');if(site.observations.series?.some(point=>!object(point)))throw new Error('Invalid dated observation.');}
    for(const evidence of site.evidence||[]){if(!object(evidence))throw new Error('Invalid evidence record.');strings(evidence,'limitations');}
  }
  array(value.provenance,'sources');strings(value.provenance,'limitations');
  if(value.provenance.sources?.some(source=>!object(source)))throw new Error('Invalid provenance source.');
  if(value.provenance.parameters!=null&&!object(value.provenance.parameters))throw new Error('Invalid method parameters.');
  return value;
}
export const availableLayers = data => (data?.layers || []).filter(layer=>layer && layer.available===true && safeUrl(layer.url) && validBounds(layer.bounds));
export function canCompare(data) {
  const layers=availableLayers(data),before=layers.find(x=>x.id==='before'),after=layers.find(x=>x.id==='after');
  return !!(before && after && isNumber(before.min) && isNumber(before.max) && before.min<before.max && before.min===after.min && before.max===after.max && typeof before.units==='string' && before.units.length && before.units===after.units && Math.max(before.bounds[0],after.bounds[0])<Math.min(before.bounds[2],after.bounds[2]) && Math.max(before.bounds[1],after.bounds[1])<Math.min(before.bounds[3],after.bounds[3]));
}
export const selectLocation = (_state,lon,lat) => ({kind:'location',site:null,coordinates:{lon,lat}});
export function selectSite(data,id) {
  const site=data.sites.find(x=>x.id===id)||null;
  return {kind:site?'site':'empty',site,coordinates:site?{lon:site.lon,lat:site.lat}:null};
}

// ---- Geodesy: WGS84 transverse Mercator (UTM, northern hemisphere), Krüger series to n^3.
const D2R = Math.PI / 180;
export function utmForward(lon, lat, zone) {
  if (!isNumber(lon) || !isNumber(lat) || !Number.isInteger(zone)) return null;
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const n = f / (2 - f), n2 = n * n, n3 = n2 * n, e = Math.sqrt(f * (2 - f));
  const A = a / (1 + n) * (1 + n2 / 4 + n2 * n2 / 64);
  const alpha = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16, 13 * n2 / 48 - 3 * n3 / 5, 61 * n3 / 240];
  const phi = lat * D2R, lam = (lon - (zone * 6 - 183)) * D2R;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) { E += alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); N += alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); }
  return { x: 500000 + k0 * A * E, y: k0 * A * N };
}

// ---- Pixel inspector over the recorded 90 m unit grid (no interpolation of values or codes).
export function inspectorCell(header, lon, lat) {
  if (!header || !Array.isArray(header.transform) || !Array.isArray(header.shape)) return null;
  const p = utmForward(lon, lat, header.utmZone); if (!p) return null;
  const [a, , c, , e, f] = header.transform, [rows, cols] = header.shape;
  const col = Math.floor((p.x - c) / a), row = Math.floor((p.y - f) / e);
  if (row < 0 || col < 0 || row >= rows || col >= cols) return null;
  return { row, col, x: p.x, y: p.y };
}
export function readUnit(header, view, cell) {
  if (!header || !view || !cell) return null;
  const [rows, cols] = header.shape, n = rows * cols, idx = cell.row * cols + cell.col, out = {};
  header.bands.forEach((band, b) => {
    const f32 = header.dtype === 'float32-le', raw = f32 ? view.getFloat32((b * n + idx) * 4, true) : view.getInt16((b * n + idx) * 2, true);
    if (['detector', 'opticalAfter', 'opticalBefore'].includes(band)) out[band] = raw === 255 || Number.isNaN(raw) ? null : raw;
    else out[band] = Number.isNaN(raw) || (!f32 && raw === header.nodata) ? null : raw * (header.scale ?? 1);
  });
  out.delta = isNumber(out.hhBefore) && isNumber(out.hhAfter) ? out.hhAfter - out.hhBefore : null;
  out.detectorKnown = out.detector !== null;
  return out;
}
export function geometryAt(grid, x, y) {
  if (!grid || !Array.isArray(grid.values) || !isNumber(x) || !isNumber(y)) return null;
  const nx = grid.x.length - 1, ny = grid.y.length - 1;
  const fx = Math.min(Math.max((x - grid.x[0]) / (grid.x[nx] - grid.x[0]) * nx, 0), nx);
  const fy = Math.min(Math.max((y - grid.y[0]) / (grid.y[ny] - grid.y[0]) * ny, 0), ny);
  const i = Math.min(Math.floor(fy), ny - 1), j = Math.min(Math.floor(fx), nx - 1), u = fx - j, v = fy - i;
  const at = k => (1 - u) * (1 - v) * grid.values[i][j][k] + u * (1 - v) * grid.values[i][j + 1][k] + (1 - u) * v * grid.values[i + 1][j][k] + u * v * grid.values[i + 1][j + 1][k];
  return { incidenceDeg: at(0), slantRangeKm: at(1) };
}

// ---- Factual verdict for one unit; never infers dry/safe from absence of a candidate.
export function unitVerdict(v, dropDb) {
  if (!v) return { tone: 'none', text: 'Outside the analysis grid.' };
  if (!v.detectorKnown) return { tone: 'unknown', text: 'Unknown: radar invalid on at least one date.' };
  const darkened = isNumber(v.delta) && v.delta <= dropDb;
  if (v.detector === 1) return v.opticalAfter === 1 ? { tone: 'candidate', text: 'Candidate; exposed water visible on Oct 6.' }
    : v.opticalAfter === 0 ? { tone: 'contradicted', text: 'Candidate contradicted: visibly dry on Oct 6.' }
    : { tone: 'candidate', text: 'Candidate; no independent view on Oct 6.' };
  if (darkened && v.opticalAfter === 0) return { tone: 'contradicted', text: 'Darkened, yet visibly dry on Oct 6.' };
  if (darkened) return { tone: 'unknown', text: 'Darkened; no interpretable Oct 6 view.' };
  if (v.opticalAfter === 1) return { tone: 'water', text: 'Exposed water visible on Oct 6; no darkening candidate.' };
  return { tone: 'stable', text: 'No candidate at the proposed thresholds. Not evidence of dry or safe ground.' };
}

// ---- Circular sun-synchronous ground-track model anchored to a measured nadir point.
// Earth turns 360° per mean solar day relative to a sun-synchronous orbit plane.
export function groundTracks({ inclinationDeg, orbitsPerCycle, repeatDays, anchorLon, anchorLat, samples = 180 }) {
  const i = inclinationDeg * D2R, Tn = repeatDays * 86400 / orbitsPerCycle, we = 2 * Math.PI / 86400;
  const lonAt = (omega, u) => omega + Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u)) - we * (u / (2 * Math.PI)) * Tn;
  const uA = Math.asin(Math.sin(anchorLat * D2R) / Math.sin(i));
  const omega0 = anchorLon * D2R - lonAt(0, uA);
  const wrap = x => (((x + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const tracks = [];
  for (let k = 0; k < orbitsPerCycle; k++) {
    const omega = omega0 - k * we * Tn, points = [];
    for (let s = 0; s <= samples; s++) {
      const u = -Math.PI / 2 + 2 * Math.PI * s / samples;
      points.push([Math.asin(Math.sin(i) * Math.sin(u)) / D2R, wrap(lonAt(omega, u)) / D2R]);
    }
    tracks.push({ index: k, nodeLonDeg: wrap(omega) / D2R, points });
  }
  return { nodalPeriodS: Tn, nodeSpacingDeg: we * Tn / D2R, anchorArgumentDeg: uA / D2R, tracks };
}

// ---- MGRS (WGS84, northern hemisphere, UTM zones) from lon/lat: zone + band + 100 km square + easting/northing.
export function mgrs(lon, lat, digits = 5) {
  if (!isNumber(lon) || !isNumber(lat) || lat < 0 || lat > 84) return null;
  const zone = Math.floor((lon + 180) / 6) + 1, p = utmForward(lon, lat, zone); if (!p) return null;
  const band = 'CDEFGHJKLMNPQRSTUVWXX'[Math.floor((lat + 80) / 8)];
  const set = ((zone - 1) % 3), colLetters = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][set];
  const col = colLetters[Math.floor(p.x / 100000) - 1];
  const rowLetters = 'ABCDEFGHJKLMNPQRSTUV', rowOffset = zone % 2 === 0 ? 5 : 0;
  const row = rowLetters[(Math.floor(p.y / 100000) + rowOffset) % 20];
  const scale = 10 ** (5 - digits), e = Math.floor((p.x % 100000) / scale), n = Math.floor((p.y % 100000) / scale);
  return `${zone}${band} ${col}${row} ${String(e).padStart(digits, '0')} ${String(n).padStart(digits, '0')}`;
}
