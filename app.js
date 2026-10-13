// Old Time Radio — no framework, no build step.
// Episodes stream from archive.org; catalog/ is a snapshot made by tools/build_catalog.py.

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const store = {
  get(k, d) { try { const v = localStorage.getItem('otr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('otr.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const SLEEP_OPTIONS = [
  ['15 min', 15], ['30 min', 30], ['45 min', 45], ['1 hour', 60],
  ['1½ hours', 90], ['2 hours', 120], ['End of episode', 'episode'], ['Off', 'off'],
];
const SKIP_BACK = 15;
const MAX_AUTO_SKIPS = 3;
const SLEEP_ENDED = 'Sleep timer ended.';

// ---------- state ----------
let catalog = null;                 // { stations: [{id, shows[]}], shows: [{id, name, n}] }
const showById = new Map();
const episodes = new Map();         // showId -> [[title, "item/file.mp3", seconds, year], ...]

let source = null;                  // {kind:'station', id} ('all' = every show) | {kind:'mix', ids:[]}
let live = store.get('live', false);   // live broadcast mode: stations follow a shared schedule
let liveAt = null;                  // where the current programme sits in the schedule: {day, idx, start}
let pendingOffset = 0;              // seconds to jump to once the episode's metadata is in
let current = null;                 // the episode now loaded
let picking = false;                // choosing / fetching the next episode
let loading = false;                // buffering the current one
let message = '';                   // line under the title that replaces the episode details
let messageIsAlert = false;
let messageTimer = 0;
let token = 0;                      // invalidates stale async picks
let errorSkips = 0;
let unlocked = false;

let mix = store.get('mix', []);
let played = store.get('played', {});   // showId -> [hash of paths already played]
let sleep = store.get('sleep', null);   // {kind:'time', endsAt} | {kind:'episode'} | null
if (sleep && sleep.kind === 'time' && sleep.endsAt <= Date.now()) sleep = null;

const dl = { busy: false, pct: 0, ctrl: null, blob: null, path: null, url: null };

const audio = new Audio();
audio.preload = 'auto';
audio.setAttribute('playsinline', '');

// ---------- helpers ----------
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const enc = encodeURIComponent;
const urlFor = (path) => { const i = path.indexOf('/'); return `https://archive.org/download/${enc(path.slice(0, i))}/${enc(path.slice(i + 1))}`; };
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Show a status line in place of the episode details. Alerts stay until the next action; notes fade.
function say(text, { alert = false, ms = 0 } = {}) {
  clearTimeout(messageTimer);
  message = text; messageIsAlert = alert;
  if (text && ms) messageTimer = setTimeout(() => { message = ''; render(); }, ms);
}

// A short silent clip, played inside the first tap so iOS lets us start the real episode later (after async work).
function silence() {
  const n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function unlock() {
  if (unlocked) return;
  unlocked = true;
  audio.src = silence();
  audio.play().catch(() => {});
}

// ---------- catalog ----------
async function loadShow(id) {
  if (!episodes.has(id)) {
    const res = await fetch(`catalog/${enc(id)}.json`);
    if (!res.ok) throw new Error('catalog');
    episodes.set(id, await res.json());
  }
  return episodes.get(id);
}
const stationShows = (id) => catalog.stations.find((s) => s.id === id)?.shows ?? [];
const idsOf = (src) => src.kind === 'mix' ? src.ids : src.id === 'all' ? catalog.shows.map((s) => s.id) : stationShows(src.id);
const keyOf = (src) => src.kind === 'mix' ? 'mix:' + [...src.ids].sort().join(',') : 'station:' + src.id;
const labelOf = (src) => src.kind === 'mix' ? `${src.ids.length} show${src.ids.length === 1 ? '' : 's'}, shuffled` : src.id === 'all' ? 'All shows' : cap(src.id);

async function pickEpisode() {
  const ids = idsOf(source);
  let showId = rand(ids);
  if (ids.length > 1 && current && showId === current.showId) showId = rand(ids.filter((i) => i !== current.showId));
  const list = await loadShow(showId);
  const seen = new Set(played[showId] || []);
  let pool = list.filter((e) => !seen.has(hash(e[1])));
  if (!pool.length) { played[showId] = []; pool = list; }
  const e = rand(pool);
  (played[showId] ||= []).push(hash(e[1]));
  store.set('played', played);
  return { showId, show: showById.get(showId).name, title: e[0], path: e[1], dur: e[2], year: e[3] };
}

// ---------- live schedule ----------
// No server: each station's programme for a UTC day is generated from a seed (station + date), so every device on the
// same station hears the same thing at the same moment. Joining means finding what is on now and seeking into it.
const DAY = 86400, LINEUP = 16;   // a day draws on a rotating lineup of up to 16 shows, which keeps the fetches small

function rng(seed) {              // mulberry32
  let a = parseInt(hash(seed), 36) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const schedules = new Map();      // "key@day" -> Promise<[{start, ep}]>
function daySchedule(src, day) {
  const k = `${keyOf(src)}@${day}`;
  if (!schedules.has(k)) schedules.set(k, buildDay(src, day, k).catch((e) => { schedules.delete(k); throw e; }));
  return schedules.get(k);
}

async function buildDay(src, day, seed) {
  const r = rng(seed);
  const pool = [...idsOf(src)].sort();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const lineup = pool.slice(0, LINEUP);
  const lists = (await Promise.all(lineup.map(async (id) => [id, (await loadShow(id)).filter((e) => e[2] > 0)]))).filter(([, l]) => l.length);
  if (!lists.length) throw new Error('empty');

  const out = [], used = new Set();
  let t = 0, last = -1;
  while (t < DAY) {
    const remaining = DAY - t;
    let pick = null;
    for (const allowRepeat of [false, true]) {
      for (let i = 0; i < 12 && !pick; i++) {
        let si = Math.floor(r() * lists.length);
        if (lists.length > 1 && si === last) si = (si + 1 + Math.floor(r() * (lists.length - 1))) % lists.length;
        const [id, list] = lists[si], e = list[Math.floor(r() * list.length)];
        if (e[2] <= remaining && (allowRepeat || !used.has(e[1]))) pick = { si, id, e };
      }
      if (pick) break;
    }
    if (!pick) break;               // nothing fits what's left of the day; the short tail rolls into tomorrow
    used.add(pick.e[1]); last = pick.si;
    out.push({ start: t, ep: { showId: pick.id, show: showById.get(pick.id).name, title: pick.e[0], path: pick.e[1], dur: pick.e[2], year: pick.e[3] } });
    t += pick.e[2];
  }
  return out;
}

async function locate(src, ms = Date.now()) {
  const day = Math.floor(ms / 1000 / DAY), sec = ms / 1000 - day * DAY;
  const sched = await daySchedule(src, day);
  let idx = -1;
  for (let k = 0; k < sched.length && sched[k].start <= sec; k++) idx = k;
  if (idx >= 0 && sec < sched[idx].start + sched[idx].ep.dur) return { day, idx, item: sched[idx], offset: sec - sched[idx].start };
  return { day: day + 1, idx: 0, item: (await daySchedule(src, day + 1))[0], offset: 0 };   // in the tail gap before midnight
}
async function after(src, day, idx) {
  const sched = await daySchedule(src, day);
  if (idx + 1 < sched.length) return { day, idx: idx + 1, item: sched[idx + 1] };
  return { day: day + 1, idx: 0, item: (await daySchedule(src, day + 1))[0] };
}

function playLive({ day, idx, item, offset }) {
  liveAt = { day, idx, start: day * DAY + item.start };
  load(item.ep, offset);
}
function liveFailed(mine) {
  if (mine !== token) return;
  picking = false;
  say("Couldn't reach the schedule. Check your connection.", { alert: true });
  render();
}
async function tuneLive() {         // join whatever is on right now
  const mine = ++token;
  cancelDownload();
  picking = true; say('');
  render();
  try { const loc = await locate(source); if (mine === token) playLive(loc); } catch { liveFailed(mine); }
}
async function advanceLive() {      // the programme ended: next one in the schedule
  const mine = ++token;
  picking = true;
  render();
  try {
    const nx = await after(source, liveAt.day, liveAt.idx);
    if (mine !== token) return;
    const offset = Math.max(0, Date.now() / 1000 - (nx.day * DAY + nx.item.start));
    if (offset >= nx.item.ep.dur - 5) return tuneLive();        // far behind (a long stall): jump to what's on now
    playLive({ ...nx, offset });
  } catch { liveFailed(mine); }
}
async function resumeLive() {       // pausing live radio is muting it: coming back means rejoining the broadcast
  const mine = ++token;
  try {
    const loc = await locate(source);
    if (mine !== token) return;
    if (current && loc.item.ep.path === current.path && !audio.src.startsWith('blob:')) {
      liveAt = { day: loc.day, idx: loc.idx, start: loc.day * DAY + loc.item.start };
      audio.currentTime = loc.offset;
      audio.play().catch(() => {});
    } else playLive(loc);
  } catch { liveFailed(mine); }
}
const nextProgramme = () => (live && liveAt && source ? advanceLive() : playRandom());

function setLive(on) {
  if (live === on) return;
  live = on; store.set('live', on);
  if (!on) liveAt = null;
  else if (source) { unlock(); tuneLive(); return; }
  render();
}

// ---------- playback ----------
function start(src) {
  unlock();
  source = src;
  errorSkips = 0;
  if (live) tuneLive(); else playRandom();
}

async function playRandom() {
  const mine = ++token;
  cancelDownload();
  picking = true; say('');
  render();
  try {
    const ep = await pickEpisode();
    if (mine !== token) return;
    load(ep);
  } catch {
    if (mine !== token) return;
    picking = false;
    say("Couldn't reach the catalog. Check your connection.", { alert: true });
    render();
  }
}

function load(ep, offset = 0) {
  current = ep;
  picking = false;
  loading = true;
  pendingOffset = offset > 1 ? offset : 0;
  audio.src = urlFor(ep.path);
  const p = audio.play();
  if (p) p.catch((err) => {
    if (err.name === 'AbortError') return;
    loading = false;
    say(err.name === 'NotAllowedError' ? 'Tap play to start.' : "Couldn't play this one.", { alert: true });
    render();
  });
  setMediaSession();
  render();
}

function togglePlay() {
  if (!current) return;
  if (messageIsAlert) say('');
  if (!audio.paused) audio.pause();
  else if (live && liveAt) resumeLive();
  else audio.play().catch(() => {});
}
function skip(delta) {
  if (!current || live) return;
  audio.currentTime = Math.max(0, Math.min((audio.duration || Infinity) - 1, audio.currentTime + delta));
}

audio.addEventListener('playing', () => { loading = false; errorSkips = 0; render(); updateSession(); });
audio.addEventListener('waiting', () => { if (current) { loading = true; render(); } });
audio.addEventListener('canplay', () => { loading = false; render(); });
audio.addEventListener('play', render);
audio.addEventListener('pause', () => { render(); updateSession(); });
audio.addEventListener('loadedmetadata', () => {
  if (pendingOffset && current) audio.currentTime = Math.min(pendingOffset, Math.max(0, (audio.duration || Infinity) - 5));
  pendingOffset = 0;
});
audio.addEventListener('durationchange', updateProgress);
audio.addEventListener('timeupdate', () => { updateProgress(); tick(); });
audio.addEventListener('ended', () => {
  if (!current) return;                      // the silent unlock clip
  if (sleep && sleep.kind === 'episode') return endSleep();
  nextProgramme();
});
audio.addEventListener('error', () => {
  if (!current || audio.src.startsWith('blob:')) return;
  if (++errorSkips > MAX_AUTO_SKIPS) { loading = false; say("Couldn't load episodes. Check your connection.", { alert: true }); return render(); }
  say('That one won’t play — trying another…');
  setTimeout(nextProgramme, 700);
  render();
});

// ---------- sleep timer ----------
function setSleep(opt) {
  if (opt === 'off') sleep = null;
  else if (opt === 'episode') sleep = { kind: 'episode' };
  else sleep = { kind: 'time', minutes: opt, endsAt: Date.now() + opt * 60000 };
  store.set('sleep', sleep);
  if (message === SLEEP_ENDED) say('');
  render();
}
function endSleep() {
  sleep = null; store.set('sleep', null);
  audio.pause();
  say(SLEEP_ENDED, { alert: true });
  render(); updateSession();
}
function tick() {
  if (sleep && sleep.kind === 'time' && Date.now() >= sleep.endsAt) return endSleep();
  renderSleep();
}
// Timers can be throttled once the screen locks; timeupdate keeps firing while audio plays, so check there too.
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  tick(); updateProgress();
  if (live && liveAt && !audio.paused) {            // a long stall can leave us behind the broadcast
    const want = Date.now() / 1000 - liveAt.start;
    if (Math.abs(want - audio.currentTime) > 20 && want < (audio.duration || 0) - 5) audio.currentTime = want;
  }
});

const sleepLabel = () => {
  if (!sleep) return 'Off';
  if (sleep.kind === 'episode') return 'End of episode';
  return fmt(Math.max(0, Math.ceil((sleep.endsAt - Date.now()) / 1000)));
};

// ---------- download ----------
const dlFileName = () => `${current.show} - ${current.title}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) + '.mp3';

function cancelDownload() {
  if (dl.ctrl) dl.ctrl.abort();
  dl.busy = false; dl.ctrl = null; dl.pct = 0;
  if (dl.url) URL.revokeObjectURL(dl.url);
  dl.blob = dl.path = dl.url = null;
}

async function download() {
  if (!current) return;
  if (dl.busy) { cancelDownload(); return render(); }
  if (dl.blob && dl.path === current.path) return saveFile();

  const ep = current, ctrl = new AbortController();
  dl.busy = true; dl.pct = 0; dl.ctrl = ctrl; render();
  try {
    const res = await fetch(urlFor(ep.path), { signal: ctrl.signal });
    if (!res.ok) throw new Error(res.status);
    const total = Number(res.headers.get('content-length')) || (ep.dur ? ep.dur * 16000 : 0);
    const reader = res.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      dl.pct = total ? Math.min(99, Math.round((got / total) * 100)) : 0;
      renderDownload();
    }
    if (ctrl.signal.aborted || current !== ep) return;
    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    dl.blob = blob; dl.path = ep.path; dl.url = URL.createObjectURL(blob); dl.busy = false; dl.ctrl = null;
    // Play the finished local copy from the very beginning.
    if (live) { live = false; liveAt = null; store.set('live', false); }   // starting over from 0:00 means leaving the broadcast
    audio.src = dl.url;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    say('Downloaded. Playing from the start.', { ms: 4000 });
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    dl.busy = false; dl.ctrl = null; dl.pct = 0;
    say('Download failed. Try again.', { alert: true, ms: 5000 });
    render();
  }
}

async function saveFile() {
  const file = new File([dl.blob], dlFileName(), { type: 'audio/mpeg' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (err) { if (err.name === 'AbortError') return; }
  const a = el('a'); a.href = dl.url; a.download = file.name;
  document.body.append(a); a.click(); a.remove();
}

// ---------- lock-screen / Control Center ----------
function setMediaSession() {
  if (!('mediaSession' in navigator) || !current) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: current.title,
    artist: current.show,
    album: 'Old Time Radio',
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}
function updateSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}
function bindSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* unsupported */ } };
  set('play', () => { if (live && liveAt) resumeLive(); else audio.play().catch(() => {}); });
  set('pause', () => audio.pause());
  set('previoustrack', () => { if (!live) audio.currentTime = 0; });   // restart from the beginning
  set('nexttrack', () => { if (source && !live) playRandom(); });
  set('seekbackward', () => skip(-SKIP_BACK));
  set('seekforward', () => skip(30));
  set('seekto', (d) => { if (!live && d.seekTime != null) audio.currentTime = d.seekTime; });
}

// ---------- viewport, sheets, full screen ----------
// Mobile browsers with a bottom toolbar report a layout height taller than what is visible, which hides the bottom
// of the page. The visual viewport is the visible area, so the layout is sized from that.
function syncViewport() {
  const vv = window.visualViewport, root = document.documentElement.style;
  root.setProperty('--vv-h', (vv ? vv.height : innerHeight) + 'px');
  root.setProperty('--vv-top', (vv ? vv.offsetTop : 0) + 'px');
}
syncViewport();
window.visualViewport?.addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('scroll', syncViewport);
addEventListener('resize', syncViewport);
addEventListener('orientationchange', syncViewport);

let sheetOpener = null;
function openSheet(o) { sheetOpener = document.activeElement; o.hidden = false; syncViewport(); o.querySelector('.panel button, .panel [tabindex]')?.focus({ preventScroll: true }); }
function closeSheet(o) { o.hidden = true; sheetOpener?.focus?.({ preventScroll: true }); }

// iPhone browsers don't offer the Fullscreen API for pages; there the route is Safari > Add to Home Screen.
const canFullscreen = !!(document.fullscreenEnabled && document.documentElement.requestFullscreen);
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}
function renderFullscreen() {
  ui.fs.hidden = !canFullscreen || isStandalone;
  ui.fs.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
}

// ---------- rendering ----------
const ui = {
  cap: $('#cap'), title: $('#title'), meta: $('#meta'), seek: $('#seek'), cur: $('#t-cur'), left: $('#t-left'),
  back: $('#back'), play: $('#play'), next: $('#next'), grid: $('#grid'),
  sleep: $('#sleep'), sleepVal: $('#sleep-val'), dl: $('#dl'), dlCap: $('#dl-cap'), dlVal: $('#dl-val'),
  shows: $('#shows'), showsVal: $('#shows-val'), fs: $('#fs'), tip: $('#tip'), modeDemand: $('#mode-demand'), modeLive: $('#mode-live'),
};
let seeking = false;

function render() {
  const has = !!current;
  const where = !source ? '' : live ? `Live · ${labelOf(source).replace(', shuffled', '')}` : labelOf(source);
  const clock = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (picking) {
    ui.cap.textContent = where; ui.title.textContent = 'Tuning in…'; ui.meta.textContent = '';
  } else if (!has) {
    ui.cap.textContent = 'Old Time Radio';
    ui.title.textContent = messageIsAlert && message !== SLEEP_ENDED ? 'Something went wrong' : 'Choose a station';
    ui.meta.textContent = message || (catalog ? `${catalog.shows.length} shows · ${catalog.shows.reduce((n, s) => n + s.n, 0).toLocaleString('en-US')} episodes` : '');
  } else {
    ui.cap.textContent = where; ui.title.textContent = current.title;
    ui.meta.textContent = message || (loading ? 'Loading…' : live && liveAt ? [current.show, `on air since ${clock(Math.min(liveAt.start, Date.now() / 1000))}`].filter(Boolean).join(' · ') : [current.show, current.year || '', current.dur ? `${Math.round(current.dur / 60)} min` : ''].filter(Boolean).join(' · '));
  }
  ui.cap.classList.toggle('live', live && !!source && (has || picking));
  ui.meta.classList.toggle('alert', !!message && messageIsAlert);
  for (const [b, on] of [[ui.modeDemand, !live], [ui.modeLive, live]]) b.setAttribute('aria-pressed', on);
  ui.tip.hidden = !(isIOS && !isStandalone && !has && !picking);

  const playing = has && !audio.paused;
  ui.play.classList.toggle('playing', playing && !loading && !picking);
  ui.play.classList.toggle('loading', loading || picking);
  ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  ui.play.disabled = !has;
  ui.back.disabled = ui.seek.disabled = !has || live;     // live radio can't be scrubbed
  ui.next.disabled = !source || live;

  ui.shows.classList.toggle('on', source?.kind === 'mix');
  ui.showsVal.textContent = mix.length ? `${mix.length} selected` : 'Choose';
  for (const b of ui.grid.querySelectorAll('.station')) {
    const on = source?.kind === 'station' && source.id === b.dataset.id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  }
  renderSleep();
  renderDownload();
  updateProgress();
}

function renderSleep() {
  ui.sleepVal.textContent = sleepLabel();
  ui.sleep.classList.toggle('on', !!sleep);
  const sub = $('#sleep-sub');
  sub.textContent = sleep ? (sleep.kind === 'episode' ? 'Stops when this episode ends' : `Stops in ${sleepLabel()}`) : 'Playback stops automatically';
  sub.classList.toggle('on', !!sleep);
  for (const b of document.querySelectorAll('#sleep-grid .pick')) {
    const v = b.dataset.v;
    b.classList.toggle('active', !!sleep && (sleep.kind === 'episode' ? v === 'episode' : v === String(sleep.minutes)));
  }
}

function renderDownload() {
  const has = !!current;
  ui.dl.disabled = !has;
  ui.dl.classList.toggle('on', dl.busy || (dl.blob && dl.path === current?.path));
  ui.dl.style.setProperty('--dlp', dl.busy ? `${dl.pct}%` : '0%');
  if (dl.busy) { ui.dlCap.textContent = 'Downloading'; ui.dlVal.textContent = dl.pct ? `${dl.pct}%` : '…'; }
  else if (dl.blob && dl.path === current?.path) { ui.dlCap.textContent = 'Downloaded'; ui.dlVal.textContent = 'Save file'; }
  else { ui.dlCap.textContent = 'Episode'; ui.dlVal.textContent = 'Download'; }
}

function updateProgress() {
  const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (current?.dur || 0);
  const t = audio.currentTime || 0;
  if (!seeking) {
    const pct = dur ? Math.min(100, (t / dur) * 100) : 0;
    ui.seek.value = Math.round(pct * 10);
    ui.seek.style.setProperty('--p', pct + '%');
    ui.cur.textContent = fmt(t);
    ui.left.textContent = dur ? '−' + fmt(Math.max(0, dur - t)) : '0:00';
  }
}

// ---------- build static UI ----------
function buildStations() {
  for (const st of catalog.stations) {
    const b = el('button', 'cell station', st.id);
    b.dataset.id = st.id;
    b.addEventListener('click', () => start({ kind: 'station', id: st.id }));
    ui.grid.append(b);
  }
  const all = el('button', 'cell station all', 'All shows');
  all.dataset.id = 'all';
  all.addEventListener('click', () => start({ kind: 'station', id: 'all' }));
  ui.grid.append(all);
}

function buildSleepSheet() {
  const grid = $('#sleep-grid');
  for (const [label, v] of SLEEP_OPTIONS) {
    const b = el('button', 'cell pick', label);
    b.dataset.v = v;
    b.addEventListener('click', () => { setSleep(v); closeSheet($('#sleep-sheet')); });
    grid.append(b);
  }
}

function buildShowsSheet() {
  const list = $('#show-list'), sel = new Set(mix.filter((id) => showById.has(id)));
  const key = (n) => n.toLowerCase().replace(/^(the|a|an)\s+/, '');
  const sorted = [...catalog.shows].sort((a, b) => key(a.name).localeCompare(key(b.name), 'en'));
  const rows = sorted.map((s) => {
    const row = el('label', 'row'), box = el('input'), tick = el('span', 'box');
    box.type = 'checkbox'; box.checked = sel.has(s.id); box.value = s.id;
    row.append(box, tick, el('span', 'name', s.name), el('span', 'n', String(s.n)));
    row.dataset.name = s.name.toLowerCase();
    box.addEventListener('change', () => { box.checked ? sel.add(s.id) : sel.delete(s.id); sync(); });
    list.append(row);
    return row;
  });
  const empty = el('p', 'empty', 'No shows match.'); empty.hidden = true; list.append(empty);
  const shuffle = $('#shuffle'), clear = $('#clear');
  function sync() {
    shuffle.disabled = sel.size === 0;
    shuffle.textContent = sel.size ? `Shuffle ${sel.size} show${sel.size === 1 ? '' : 's'}` : 'Shuffle';
    clear.disabled = sel.size === 0;
  }
  $('#q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    let any = false;
    for (const r of rows) { const show = !q || r.dataset.name.includes(q); r.hidden = !show; any ||= show; }
    empty.hidden = any;
  });
  clear.addEventListener('click', () => { sel.clear(); rows.forEach((r) => (r.firstChild.checked = false)); sync(); });
  shuffle.addEventListener('click', () => {
    mix = [...sel]; store.set('mix', mix);
    closeSheet($('#shows-sheet'));
    start({ kind: 'mix', ids: mix });
  });
  sync();
}

function wire() {
  ui.play.addEventListener('click', togglePlay);
  ui.back.addEventListener('click', () => skip(-SKIP_BACK));
  ui.next.addEventListener('click', () => { if (source && !live) playRandom(); });
  ui.modeDemand.addEventListener('click', () => setLive(false));
  ui.modeLive.addEventListener('click', () => setLive(true));
  ui.dl.addEventListener('click', download);
  ui.sleep.addEventListener('click', () => openSheet($('#sleep-sheet')));
  ui.shows.addEventListener('click', () => openSheet($('#shows-sheet')));

  for (const o of document.querySelectorAll('.overlay')) {
    o.addEventListener('click', (e) => { if ((e.target === o && !o.classList.contains('full')) || e.target.closest('[data-close]')) closeSheet(o); });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.overlay:not([hidden])').forEach(closeSheet); });

  ui.fs.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', renderFullscreen);

  // scrubbing: preview while dragging, commit on release
  const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current?.dur || 0);
  ui.seek.addEventListener('input', () => {
    seeking = true;
    const t = (ui.seek.value / 1000) * dur();
    ui.seek.style.setProperty('--p', ui.seek.value / 10 + '%');
    ui.cur.textContent = fmt(t);
    ui.left.textContent = '−' + fmt(dur() - t);
  });
  ui.seek.addEventListener('change', () => {
    audio.currentTime = (ui.seek.value / 1000) * dur();
    seeking = false;
  });
}

// ---------- boot ----------
async function boot() {
  wire(); bindSession();
  try {
    catalog = await (await fetch('catalog/index.json')).json();
  } catch {
    ui.title.textContent = 'Offline'; ui.meta.textContent = 'Connect to the internet and reopen.';
    return;
  }
  catalog.shows.forEach((s) => showById.set(s.id, s));
  mix = mix.filter((id) => showById.has(id));
  buildStations(); buildSleepSheet(); buildShowsSheet();
  renderFullscreen();
  render();
}
boot();
