// Node 20+, no dependencies. Needs ffmpeg on PATH (preinstalled on GitHub runners).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const SRC = process.env.PLAYLIST || 'https://iptv-org.github.io/iptv/categories/sports.m3u';
const MAX = +process.env.MAX || 200;   // channels to check per run
const CONC = 12;                       // parallel checks
const MAX_FAILS = 3;                   // consecutive failed runs before a channel is dropped
const UA = 'Mozilla/5.0 (compatible; Floodlight/1.0)';

const isLikelyHls = (url) => {
  try {
    const p = new URL(url).protocol;
    if (p !== 'http:' && p !== 'https:') return false;
    const path = new URL(url).pathname.toLowerCase();
    return /(?:^|\/)[^/?#]+\.(?:m3u8?|m3u)(?:[?#]|$)/i.test(path) || /(?:^|\/)(?:playlist|live|stream|index)(?:[/?#]|$)/i.test(path);
  } catch { return false; }
};

const get = (url, ms = 8000) =>
  fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ms), redirect: 'follow' });

function parse(m3u) {
  const out = []; let meta = null;
  for (const raw of m3u.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF')) {
      const a = (k) => (l.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
      meta = { name: l.slice(l.lastIndexOf(',') + 1).trim(), logo: a('tvg-logo'), tvgId: a('tvg-id') };
    } else if (l && !l.startsWith('#') && meta) {
      const url = l;
      if (isLikelyHls(url)) out.push({ ...meta, url });
      meta = null;
    }
  }
  return out;
}

// A stream is "live" only if the playlist loads AND it lists real segments.
async function check(url) {
  if (!isLikelyHls(url)) return { ok: false };
  const t = Date.now();
  try {
    let res = await get(url);
    if (!res.ok) return { ok: false };
    const cors = !!res.headers.get('access-control-allow-origin');
    let text = await res.text();
    if (!text.startsWith('#EXTM3U')) return { ok: false };
    if (text.includes('#EXT-X-STREAM-INF')) {           // master playlist: follow first variant
      const v = text.split('\n').find((l) => l.trim() && !l.startsWith('#'));
      if (!v) return { ok: false };
      res = await get(new URL(v.trim(), res.url));
      if (!res.ok) return { ok: false };
      text = await res.text();
    }
    return text.includes('#EXTINF') ? { ok: true, ms: Date.now() - t, cors } : { ok: false };
  } catch { return { ok: false }; }
}

// Grab one frame of whatever is on air right now.
async function thumb(id, url) {
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-user_agent', UA, '-i', url,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '6', `thumbs/${id}.jpg`], { timeout: 25000 });
    return Date.now();
  } catch { return null; }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// XMLTV guides (the workflow downloads them into ./guides). Keeps programmes from now to +8h.
const xt = (s) => {
  const m = s.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-]\d{4})?/);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? m[7].slice(0, 3) + ':' + m[7].slice(3) : 'Z'}`) : NaN;
};
const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
async function loadGuides(dir = process.env.GUIDE_DIR || 'guides') {
  const epg = new Map(), now = Date.now();
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.xml')); } catch {}
  for (const f of files) {
    const xml = await readFile(`${dir}/${f}`, 'utf8');
    for (const m of xml.matchAll(/<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g)) {
      const at = (k) => (m[1].match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
      const start = xt(at('start')), stop = xt(at('stop'));
      const title = (m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1];
      if (!title || isNaN(start) || !(stop > now) || start > now + 8 * 36e5) continue;
      const ch = at('channel');
      if (!epg.has(ch)) epg.set(ch, []);
      epg.get(ch).push([start, stop, dec(title.trim())]);
    }
  }
  for (const v of epg.values()) v.sort((a, b) => a[0] - b[0]);
  return epg;
}

await mkdir('data', { recursive: true });
await mkdir('thumbs', { recursive: true });

const prev = new Map();
try { for (const c of JSON.parse(await readFile('data/channels.json', 'utf8')).channels) prev.set(c.id, c); } catch {}

const seen = new Set();
const list = parse(await (await get(SRC, 30000)).text())
  .filter((c) => !seen.has(c.url) && seen.add(c.url)).slice(0, MAX);

const guide = await loadGuides();
console.log(`guide covers ${guide.size} channel ids`);
const channels = [];
await pool(list, CONC, async (c) => {
  const id = createHash('sha1').update(c.url).digest('hex').slice(0, 10);
  const old = prev.get(id), r = await check(c.url);
  let thumbAt = old?.thumbAt || null;
  if (r.ok) thumbAt = (await thumb(id, c.url)) || thumbAt;
  channels.push({
    id, name: c.name, logo: c.logo,
    country: ((c.tvgId.match(/\.([a-z]{2})/i) || [])[1] || '').toUpperCase(),
    url: c.url, live: r.ok, ms: r.ms || null, cors: r.cors ?? old?.cors ?? false,
    https: c.url.startsWith('https:'), fails: r.ok ? 0 : (old?.fails || 0) + 1,
    thumbAt, checkedAt: Date.now(),
    // schedule as [startMs, stopMs, title]; the browser works out "on now" itself
    epg: guide.get(c.tvgId) || guide.get(c.tvgId.split('@')[0]) || (old?.epg || []).filter((p) => p[1] > Date.now()),
  });
});

const kept = channels.filter((c) => c.fails < MAX_FAILS)
  .sort((a, b) => b.live - a.live || a.name.localeCompare(b.name));
const ids = new Set(kept.map((c) => c.id));
for (const f of await readdir('thumbs')) if (f.endsWith('.jpg') && !ids.has(f.slice(0, -4))) await rm('thumbs/' + f);
await writeFile('data/channels.json', JSON.stringify({ updatedAt: Date.now(), channels: kept }));
console.log(`${kept.filter((c) => c.live).length} live of ${kept.length} kept`);
