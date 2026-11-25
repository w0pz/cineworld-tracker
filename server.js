// Cineworld Ireland ticket-release tracker.
// Polls cineworld.ie's own data API, records the first moment each film becomes
// bookable (i.e. appears with showtimes), and serves a tracker web page.
// No dependencies: requires Node 18+ (built-in fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4321;
// Automatic check every 12 hours; use "Check now" on the page when tickets are due to go on sale.
const POLL_MINUTES = Number(process.env.POLL_MINUTES) || 720;
const THEATER_ID = process.env.THEATER_ID || 'X07A4'; // Cineworld Dublin (the only IE site)
const API = 'https://www.cineworld.ie/api/gatsby-source-boxofficeapi';
const SITE = 'https://www.cineworld.ie';
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const PAGE_FILE = path.join(__dirname, 'public', 'index.html');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// ---------- state ----------
// state = {
//   movies: { [id]: { id, title, poster, genres, runtime, release, url,
//                      firstSeen, baseline, lastSeen, active, days[] } },
//   events: [ { id, at, type: 'new'|'dates'|'gone'|'back', movieId, title, detail } ],
//   lastCheck, lastError, checks
// }
function loadState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { movies: {}, events: [], lastCheck: null, lastError: null, checks: 0 }; }
}
function saveState() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}
let state = loadState();

// ---------- cineworld api ----------
// Cloudflare in front of cineworld.ie rejects Node's own TLS fingerprint (HTTP 403),
// but accepts curl, which ships with Windows 10+ / macOS / Linux. Use curl first and
// fall back to fetch if curl is missing.
const { execFile } = require('child_process');
function curlJson(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '-S', '-L', '--max-time', '30', '-A', UA, '-H', 'Accept: application/json',
      '-w', '\n%{http_code}', url], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const i = stdout.lastIndexOf('\n');
      const status = Number(stdout.slice(i + 1));
      if (status !== 200) return reject(new Error(`HTTP ${status} for ${url}`));
      try { resolve(JSON.parse(stdout.slice(0, i))); } catch (e) { reject(new Error(`Bad JSON from ${url}`)); }
    });
  });
}
async function getJson(url) {
  try { return await curlJson(url); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url} (install curl to get past Cloudflare)`);
    return res.json();
  }
}

function slugify(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The feed sometimes double-encodes UTF-8 ("TimothÃ©e", "Villeneuveâ€™s"). Undo it
// by mapping each char back to its Windows-1252 byte and re-decoding as UTF-8.
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a,
  0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
const utf8 = new TextDecoder('utf-8', { fatal: true });
function fixText(s) {
  if (typeof s !== 'string' || !/[ÃÂâ]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x100) bytes.push(c);
    else if (CP1252[c]) bytes.push(CP1252[c]);
    else return s;
  }
  try { return utf8.decode(Uint8Array.from(bytes)); } catch { return s; }
}

const DETAILS_VERSION = 2;
async function fetchMovieDetails(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const qs = chunk.map(id => `ids=${encodeURIComponent(id)}`).join('&');
    const list = await getJson(`${API}/movies?basic=false&castingLimit=4&${qs}`);
    for (const m of list) {
      const title = fixText((m.locale && m.locale.title) || m.title || `Movie ${m.id}`);
      out[m.id] = {
        title,
        poster: (m.locale && m.locale.poster && m.locale.poster.url) || m.poster || null,
        backdrops: (m.pictures && m.pictures.length ? m.pictures : (m.images || []).map(x => x.url)).slice(0, 4),
        genres: m.genres || '',
        runtime: m.runtime ? Math.round(m.runtime / 60) : null,
        certificate: m.certificate || null,
        advisory: fixText(m.advisory || null),
        synopsis: fixText((m.locale && m.locale.synopsis) || m.synopsis || ''),
        cast: (m.casting || []).map(fixText),
        director: (m.direction || []).map(fixText),
        studio: (m.studio && m.studio.name) || null,
        url: `${SITE}/movies/${m.id}-${slugify(title)}/`,
        dv: DETAILS_VERSION,
      };
    }
  }
  return out;
}

// Full showtime schedule: times, format tags, occupancy and direct booking links.
async function fetchSchedule() {
  const day = d => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
  const from = day(new Date());
  const to = day(new Date(Date.now() + 400 * 864e5));
  const theaters = encodeURIComponent(JSON.stringify({ id: THEATER_ID, timeZone: 'Europe/Dublin' }));
  const data = await getJson(`${API}/schedule?from=${from}T03%3A00%3A00&theaters=${theaters}&to=${to}T03%3A00%3A00`);
  const t = data[THEATER_ID] || {};
  const out = {};
  for (const [movieId, byDay] of Object.entries(t.schedule || {})) {
    const shows = [];
    for (const list of Object.values(byDay)) {
      for (const s of list) {
        if (s.isExpired) continue;
        const tk = (s.data && s.data.ticketing) || [];
        const link = (tk.find(x => x.provider === 'default') || tk[0] || {}).urls?.[0] || null;
        shows.push({ at: s.startsAt, tags: s.tags || [], occ: s.occupancy ? s.occupancy.rate : null,
          screen: s.screen ? s.screen.name : null, link });
      }
    }
    shows.sort((a, b) => a.at.localeCompare(b.at));
    out[movieId] = { tags: (t.moviesTags || {})[movieId] || [], shows };
  }
  return out;
}

let checking = null;
function check() {
  if (!checking) checking = doCheck().finally(() => { checking = null; });
  return checking;
}

async function doCheck() {
  const now = new Date().toISOString();
  const firstRun = Object.keys(state.movies).length === 0;
  try {
    const sm = await getJson(`${API}/scheduledMovies?theaterId=${encodeURIComponent(THEATER_ID)}`);
    const days = sm.scheduledDays || {};
    const releaseDates = sm.releaseDates || {};
    const ids = Object.keys(days).filter(id => (days[id] || []).length > 0);

    const needDetails = ids.filter(id => !state.movies[id] || state.movies[id].dv !== DETAILS_VERSION);
    const details = needDetails.length ? await fetchMovieDetails(needDetails) : {};
    let schedule = null;
    try { schedule = await fetchSchedule(); state.lastSchedule = now; }
    catch (err) { console.error(`[${now}] schedule fetch failed:`, err.message || err); }
    const newEvents = [];
    const ev = (type, m, detail) => newEvents.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at: now, type, movieId: m.id, title: m.title, detail: detail || null,
    });

    for (const id of ids) {
      const sortedDays = [...days[id]].sort();
      let m = state.movies[id];
      if (!m) {
        const d = details[id] || { title: `Movie ${id}`, url: `${SITE}/whats-on/` };
        m = state.movies[id] = {
          id, ...d, release: releaseDates[id] || null,
          firstSeen: now, baseline: firstRun, lastSeen: now, active: true, days: sortedDays,
        };
        if (!firstRun) ev('new', m, { firstShow: sortedDays[0], days: sortedDays.length });
        continue;
      }
      if (!m.active) {
        m.active = true;
        ev('back', m, { firstShow: sortedDays[0], days: sortedDays.length });
      } else {
        const known = new Set(m.days);
        const added = sortedDays.filter(d => !known.has(d));
        if (added.length) ev('dates', m, { added });
      }
      m.days = sortedDays;
      m.release = releaseDates[id] || m.release;
      m.lastSeen = now;
    }
    for (const id of ids) {
      const m = state.movies[id];
      if (details[id]) Object.assign(m, details[id]);
      if (schedule) {
        m.tags = schedule[id]?.tags || []; m.shows = schedule[id]?.shows || [];
        // Occupancy history, used by the page to spot films that are selling fast.
        const occ = m.shows.map(s => s.occ || 0);
        if (occ.length) {
          const sample = { t: now, max: Math.max(...occ), avg: Math.round(occ.reduce((a, b) => a + b, 0) / occ.length) };
          m.occHist = [...(m.occHist || []), sample].slice(-150);
        }
      }
    }
    for (const m of Object.values(state.movies)) {
      if (m.active && !days[m.id]?.length) {
        m.active = false;
        m.shows = [];
        ev('gone', m);
      }
    }

    state.events = [...newEvents.reverse(), ...state.events].slice(0, 2000);
    state.lastCheck = now;
    state.lastError = null;
    state.checks = (state.checks || 0) + 1;
    saveState();
    const n = newEvents.filter(e => e.type === 'new').length;
    console.log(`[${now}] checked: ${ids.length} bookable films, ${n} newly released, ${newEvents.length} events${schedule ? ', schedule refreshed' : ''}`);
  } catch (err) {
    state.lastError = { at: now, message: String(err.message || err) };
    state.lastCheck = now;
    saveState();
    console.error(`[${now}] check failed:`, err.message || err);
  }
  return state;
}

// ---------- http ----------
function publicState() {
  return { ...state, pollMinutes: POLL_MINUTES, theaterId: THEATER_ID, serverTime: new Date().toISOString(),
    // Set on GitHub Actions: the static page then links "Check now" to the workflow.
    repo: process.env.GITHUB_REPOSITORY || null, static: !!process.env.STATIC_SITE };
}

// One-shot mode for GitHub Actions: `node server.js --once [--out dir]` runs a single check,
// saves data/state.json and (with --out) builds the static site into that folder.
if (process.argv.includes('--once')) {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : null;
  check().then(() => {
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(PAGE_FILE, path.join(out, 'index.html'));
      fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(publicState()));
      console.log(`Static site written to ${out}`);
    }
    // Fail the run (red in GitHub Actions) if this check couldn't reach cineworld.ie.
    process.exit(state.lastError && state.lastError.at === state.lastCheck ? 1 : 0);
  });
  return;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(publicState()));
  }
  if (url.pathname === '/api/check' && req.method === 'POST') {
    await check();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(publicState()));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(PAGE_FILE).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Cineworld tracker running at http://localhost:${PORT} (checking every ${POLL_MINUTES} min)`);
  check();
  setInterval(check, POLL_MINUTES * 60 * 1000);
});
