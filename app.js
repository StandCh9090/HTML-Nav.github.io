const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ROUTE_URL = 'https://router.project-osrm.org/route/v1/driving/';
const DB_NAME = 'michi-map-cache';
const DB_VERSION = 1;
const MAX_TILES = 350;
const $ = (id) => document.getElementById(id);
const map = $('map');
const state = { lat: 35.6812, lon: 139.7671, zoom: 15, gps: null, route: null, watchId: null, dragging: false, lastPoint: null, tileUrls: [], currentPosition: null };
let dbPromise;

function openDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
function tileKey(z, x, y) { return `${z}/${x}/${y}`; }
async function readTile(key) {
  try { const db = await openDb(); return await new Promise((resolve) => { const r = db.transaction('tiles').objectStore('tiles').get(key); r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null); }); }
  catch { return null; }
}
async function writeTile(key, blob) {
  try {
    const db = await openDb();
    await new Promise((resolve) => { const tx = db.transaction('tiles', 'readwrite'); tx.objectStore('tiles').put({ key, blob, saved: Date.now() }); tx.oncomplete = resolve; tx.onerror = resolve; });
    const all = await new Promise((resolve) => { const r = db.transaction('tiles').objectStore('tiles').getAll(); r.onsuccess = () => resolve(r.result || []); r.onerror = () => resolve([]); });
    if (all.length > MAX_TILES) {
      all.sort((a, b) => a.saved - b.saved);
      await new Promise((resolve) => { const tx = db.transaction('tiles', 'readwrite'); all.slice(0, all.length - MAX_TILES).forEach((item) => tx.objectStore('tiles').delete(item.key)); tx.oncomplete = resolve; tx.onerror = resolve; });
    }
  } catch { /* Offline map caching is best effort. */ }
}
async function tileBlob(z, x, y) {
  const key = tileKey(z, x, y);
  try {
    const response = await fetch(TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y), { mode: 'cors' });
    if (!response.ok) throw new Error('Tile request failed');
    const blob = await response.blob();
    writeTile(key, blob);
    return blob;
  } catch {
    const cached = await readTile(key);
    return cached && cached.blob ? cached.blob : null;
  }
}
function project(lat, lon, zoom = state.zoom) {
  const scale = 256 * 2 ** zoom;
  const sin = Math.sin(lat * Math.PI / 180);
  return { x: (lon + 180) / 360 * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}
function unproject(x, y, zoom = state.zoom) {
  const scale = 256 * 2 ** zoom;
  const lon = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon };
}
function centerWorld() { return project(state.lat, state.lon); }
function positionOnScreen(lat, lon) {
  const p = project(lat, lon), c = centerWorld();
  return { x: p.x - c.x + map.clientWidth / 2, y: p.y - c.y + map.clientHeight / 2 };
}
function render() {
  if (!map.clientWidth || !map.clientHeight) return;
  state.tileUrls.forEach(URL.revokeObjectURL); state.tileUrls = [];
  map.replaceChildren();
  const c = centerWorld(), left = c.x - map.clientWidth / 2, top = c.y - map.clientHeight / 2;
  const minX = Math.floor(left / 256), maxX = Math.floor((left + map.clientWidth) / 256);
  const minY = Math.max(0, Math.floor(top / 256)), maxY = Math.min(2 ** state.zoom - 1, Math.floor((top + map.clientHeight) / 256));
  for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
    const count = 2 ** state.zoom, wrappedX = ((tx % count) + count) % count;
    const img = document.createElement('img');
    img.className = 'tile'; img.alt = ''; img.draggable = false;
    img.style.left = `${tx * 256 - left}px`; img.style.top = `${ty * 256 - top}px`;
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    map.append(img);
    tileBlob(state.zoom, wrappedX, ty).then((blob) => {
      if (!blob || !img.isConnected) return;
      const url = URL.createObjectURL(blob); state.tileUrls.push(url); img.src = url;
    });
  }
  drawRoute(); drawMarker();
}
function drawRoute() {
  const svg = $('routeLayer'); svg.setAttribute('viewBox', `0 0 ${map.clientWidth} ${map.clientHeight}`); svg.replaceChildren();
  if (!state.route || !state.route.geometry || !state.route.geometry.coordinates) return;
  const points = state.route.geometry.coordinates.map(([lon, lat]) => positionOnScreen(lat, lon));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  for (const [cls, width] of [['route-line-outline', 12], ['route-line', 7]]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); path.setAttribute('class', cls); path.setAttribute('stroke-width', width); svg.append(path);
  }
}
function drawMarker() {
  const old = map.querySelector('.user-marker'); if (old) old.remove();
  if (!state.currentPosition) return;
  const p = positionOnScreen(state.currentPosition.lat, state.currentPosition.lon);
  const marker = document.createElement('div'); marker.className = 'user-marker'; marker.style.left = `${p.x}px`; marker.style.top = `${p.y}px`; marker.setAttribute('aria-label', '現在地'); map.append(marker);
}
function setCenter(lat, lon, zoom = state.zoom) { state.lat = lat; state.lon = lon; state.zoom = Math.max(3, Math.min(19, zoom)); render(); }
function showToast(message, error = false) {
  document.querySelector('.toast')?.remove(); const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`; el.textContent = message; document.body.append(el); setTimeout(() => el.remove(), 4200);
}
function onlineState() {
  const online = navigator.onLine; $('connectionText').textContent = online ? 'オンライン' : 'オフライン'; $('connectionDot').className = `connection-dot ${online ? 'online' : 'offline'}`;
}
function haversine(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const n = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(n), Math.sqrt(1 - n));
}
function formatDistance(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(m / 10) * 10)} m`; }
function startGps() {
  if (!('geolocation' in navigator)) { showToast('このブラウザは位置情報に対応していません', true); return; }
  if (state.watchId !== null) return;
  state.watchId = navigator.geolocation.watchPosition((pos) => {
    const { latitude: lat, longitude: lon, speed } = pos.coords;
    state.currentPosition = { lat, lon, speed: speed || 0 };
    $('mapHint').classList.add('hidden');
    if (!state.route) { state.lat = lat; state.lon = lon; render(); }
    else { updateGuidance(); drawMarker(); }
  }, (err) => {
    const message = err.code === 1 ? '位置情報の利用を許可してください' : 'GPSを取得できません。屋外で再度お試しください';
    $('mapHint').textContent = message; $('mapHint').classList.remove('hidden'); showToast(message, true);
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
}
function updateGuidance() {
  const route = state.route, here = state.currentPosition;
  if (!route || !here) return;
  const coords = route.geometry.coordinates;
  let nearest = 0, nearestDistance = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversine(here, { lat: coords[i][1], lon: coords[i][0] });
    if (d < nearestDistance) { nearestDistance = d; nearest = i; }
  }
  const steps = route.legs?.[0]?.steps || [];
  let upcoming = steps.find((step) => {
    const loc = step.m maneuver?.location;
    return loc && coords.findIndex((p) => Math.abs(p[0] - loc[0]) < 0.00001 && Math.abs(p[1] - loc[1]) < 0.00001) >= nearest;
  });
  if (!upcoming && steps.length) upcoming = steps[steps.length - 1];
  const loc = upcoming?.maneuver?.location;
  const distance = loc ? haversine(here, { lon: loc[0], lat: loc[1] }) : nearestDistance;
  const instruction = upcoming?.name ? `${maneuverText(upcoming.maneuver?.type, upcoming.maneuver?.modifier)} ${upcoming.name}` : 'ルートに沿って進んでください';
  $('nextTurn').textContent = instruction.trim(); $('turnDistance').textContent = `あと ${formatDistance(distance)}`;
  $('turnIcon').textContent = maneuverIcon(upcoming?.maneuver?.modifier);
  $('guidance').classList.remove('hidden');
  if (nearestDistance > 100 && navigator.onLine) $('nextTurnLabel').textContent = 'ルートから離れています';
  else $('nextTurnLabel').textContent = navigator.onLine ? '次の案内' : 'オフライン案内中';
  if (haversine(here, { lat: coords[coords.length - 1][1], lon: coords[coords.length - 1][0] }) < 35) {
    $('nextTurn').textContent = '目的地に到着しました'; $('turnDistance').textContent = '';
  }
}
function maneuverText(type, modifier) {
  const mapText = { turn: '曲がる', 'new name': '進む', depart: '出発する', arrive: '到着する', merge: '合流する', fork: '分岐する', roundabout: 'ロータリーを進む', rotary: 'ロータリーを進む', continue: '進む', 'end of road': '道なりに進む', notification: '進む' };
  const direction = { left: '左に', 'slight left': 'やや左に', 'sharp left': '左に', right: '右に', 'slight right': 'やや右に', 'sharp right': '右に', straight: '直進' }[modifier] || '';
  return `${direction}${mapText[type] || '進む'}`;
}
function maneuverIcon(modifier) { return ({ left: '↰', 'slight left': '↖', 'sharp left': '↰', right: '↱', 'slight right': '↗', 'sharp right': '↱', straight: '↑', uturn: '���' })[modifier] || '↑'; }
function saveRoute() { try { localStorage.setItem('michi-route', JSON.stringify(state.route)); } catch { showToast('ルートを端末に保存できませんでした', true); } }
function showRouteSummary() {
  const route = state.route; if (!route) return;
  $('routeDistance').textContent = formatDistance(route.distance); $('routeDuration').textContent = `${Math.round(route.duration / 60)} 分`;
  $('routeSummary').classList.remove('hidden'); $('guidance').classList.remove('hidden');
}
async function findRoute() {
  const destLat = Number($('destLat').value), destLon = Number($('destLon').value);
  if (!Number.isFinite(destLat) || !Number.isFinite(destLon) || Math.abs(destLat) > 85 || Math.abs(destLon) > 180) { showToast('目的地の緯度・経度を正しく入力してください', true); return; }
  if (!state.currentPosition) { showToast('先に現在地を取得してください', true); startGps(); return; }
  if (!navigator.onLine) { showToast('新しいルートの検索にはネット接続が必要です。保存済みルートは利用できます', true); return; }
  const button = $('routeBtn'); button.disabled = true; button.textContent = 'ルートを検索中…';
  try {
    const from = state.currentPosition;
    const url = `${ROUTE_URL}${from.lon},${from.lat};${destLon},${destLat}?overview=full&geometries=geojson&steps=true`;
    const response = await fetch(url); if (!response.ok) throw new Error('ルートサービスに接続できません');
    const data = await response.json(); if (data.code !== 'Ok' || !data.routes?.length) throw new Error('ルートが見つかりませんでした');
    state.route = data.routes[0]; state.route.destination = { lat: destLat, lon: destLon };
    saveRoute(); showRouteSummary(); setCenter(from.lat, from.lon, 15); updateGuidance();
    showToast('ルートを保存しました。オフラインでもGPS案内を続けられます');
  } catch (error) { showToast(error.message || 'ルート検索に失敗しました', true); }
  finally { button.disabled = false; button.innerHTML = 'ルートを検索 <span aria-hidden="true">→</span>'; }
}
function stopNavigation() {
  state.route = null; try { localStorage.removeItem('michi-route'); } catch { /* ignored */ }
  $('guidance').classList.add('hidden'); $('routeSummary').classList.add('hidden'); $('nextTurnLabel').textContent = '次の案内'; render();
}
function setZoom(delta) { setCenter(state.lat, state.lon, state.zoom + delta); }

$('routeBtn').addEventListener('click', findRoute);
$('locateBtn').addEventListener('click', () => { startGps(); if (state.currentPosition) setCenter(state.currentPosition.lat, state.currentPosition.lon, 16); else showToast('GPSで現在地を取得中…'); });
$('zoomIn').addEventListener('click', () => setZoom(1)); $('zoomOut').addEventListener('click', () => setZoom(-1));
$('stopBtn').addEventListener('click', stopNavigation);
map.addEventListener('pointerdown', (event) => { state.dragging = true; state.lastPoint = { x: event.clientX, y: event.clientY }; map.setPointerCapture(event.pointerId); });
map.addEventListener('pointermove', (event) => {
  if (!state.dragging || !state.lastPoint) return;
  const dx = event.clientX - state.lastPoint.x, dy = event.clientY - state.lastPoint.y;
  const c = centerWorld(), next = unproject(c.x - dx, c.y - dy); state.lat = next.lat; state.lon = next.lon; state.lastPoint = { x: event.clientX, y: event.clientY }; render();
});
map.addEventListener('pointerup', () => { state.dragging = false; state.lastPoint = null; });
map.addEventListener('wheel', (event) => { event.preventDefault(); setZoom(event.deltaY < 0 ? 1 : -1); }, { passive: false });
window.addEventListener('online', onlineState); window.addEventListener('offline', onlineState); window.addEventListener('resize', render);

try {
  const saved = JSON.parse(localStorage.getItem('michi-route') || 'null');
  if (saved?.geometry?.coordinates?.length) { state.route = saved; $('destLat').value = saved.destination?.lat ?? ''; $('destLon').value = saved.destination?.lon ?? ''; showRouteSummary(); }
} catch { /* Ignore corrupt saved route. */ }
onlineState(); render(); startGps();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
