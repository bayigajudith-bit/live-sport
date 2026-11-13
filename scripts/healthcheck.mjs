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

const ORIGIN = process.env.SITE_ORIGIN || `https://${(process.env.GITHUB_REPOSITORY_OWNER || 'example').toLowerCase()}.github.io`;
const corsOk = (h) => { const v = h.get('access-control-allow-origin'); return v === '*' || v === ORIGIN; };
const get = (url, ms = 8000) =>
  fetch(url, { headers: { 'User-Agent': UA, Origin: ORIGIN }, signal: AbortSignal.timeout(ms), redirect: 'follow' });

function parse(m3u) {
  const out = []; let meta = null;
  for (const raw of m3u.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF')) {
      const a = (k) => (l.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
      meta = { name: l.slice(l.lastIndexOf(',') + 1).trim(), logo: a('tvg-logo'), tvgId: a('tvg-id') };
    } else if (l && !l.startsWith('#') && meta) { out.push({ ...meta, url: l }); meta = null; }
  }
  return out;
}

// Quality levels advertised by a master playlist: heights, top bitrate (kbit/s), video codec.
function quality(m3u) {
  const lv = [...m3u.matchAll(/#EXT-X-STREAM-INF:([^\n]*)/g)].map((m) => ({
    h: +((m[1].match(/RESOLUTION=\d+x(\d+)/) || [])[1] || 0),
    bw: +((m[1].match(/BANDWIDTH=(\d+)/) || [])[1] || 0),
    c: (m[1].match(/CODECS="([^"]*)"/) || [])[1] || '',
  }));
  const c = lv.map((l) => l.c).join(',');
  return {
    h: [...new Set(lv.map((l) => l.h).filter(Boolean))].sort((a, b) => b - a),
    kbps: Math.round(Math.max(0, ...lv.map((l) => l.bw)) / 1000),
    codec: /hvc1|hev1/.test(c) ? 'H.265' : /av01/.test(c) ? 'AV1' : /avc1/.test(c) ? 'H.264' : '',
  };
}

// A channel counts as live only if the playlist loads, its first video segment really downloads,
// and (below) ffmpeg can decode a frame. CORS is tested with an Origin header like a browser sends.
async function check(url) {
  const t = Date.now();
  try {
    let res = await get(url);
    if (!res.ok) return { ok: false };
    let cors = corsOk(res.headers), base = res.url, text = await res.text(), q = null;
    if (!text.startsWith('#EXTM3U')) return { ok: false };
    const first = (m3u) => m3u.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (text.includes('#EXT-X-STREAM-INF')) {           // master playlist: follow first variant
      q = quality(text);
      res = await get(new URL(first(text), base));
      if (!res.ok) return { ok: false };
      cors = cors && corsOk(res.headers); base = res.url; text = await res.text();
    }
    const seg = first(text);
    if (!seg || !text.includes('#EXTINF')) return { ok: false };
    const sr = await fetch(new URL(seg, base), {
      headers: { 'User-Agent': UA, Origin: ORIGIN, Range: 'bytes=0-262143' },
      signal: AbortSignal.timeout(12000), redirect: 'follow',
    });
    if (!(sr.ok || sr.status === 206)) return { ok: false };
    if ((await sr.arrayBuffer()).byteLength < 1000) return { ok: false };
    return { ok: true, ms: Date.now() - t, cors: cors && corsOk(sr.headers), q };
  } catch { return { ok: false }; }
}

// Grab one frame of whatever is on air right now.
async function thumb(id, url) {
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-user_agent', UA, '-i', url,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '6', `public/thumbs/${id}.jpg`], { timeout: 25000 });
    return Date.now();
  } catch { return null; }
}

const HAVE_FFMPEG = await run('ffmpeg', ['-version']).then(() => true, () => false);

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

await mkdir('public/data', { recursive: true });
await mkdir('public/thumbs', { recursive: true });

const prev = new Map();
try { for (const c of JSON.parse(await readFile('public/data/channels.json', 'utf8')).channels) prev.set(c.id, c); } catch {}

const seen = new Set();
const list = parse(await (await get(SRC, 30000)).text())
  .filter((c) => !seen.has(c.url) && seen.add(c.url)).slice(0, MAX);

const guide = await loadGuides();
console.log(`guide covers ${guide.size} channel ids`);
const channels = [];
await pool(list, CONC, async (c) => {
  const id = createHash('sha1').update(c.url).digest('hex').slice(0, 10);
  const old = prev.get(id), r = await check(c.url);
  let live = r.ok, thumbAt = old?.thumbAt || null;
  if (r.ok) {
    const tt = (await thumb(id, c.url)) ?? (await thumb(id, c.url));
    if (tt) thumbAt = tt; else if (HAVE_FFMPEG) live = false; // no decodable frame means not really live
  }
  if (!live) thumbAt = null;
  channels.push({
    id, name: c.name, logo: c.logo,
    country: ((c.tvgId.match(/\.([a-z]{2})/i) || [])[1] || '').toUpperCase(),
    url: c.url, live, playable: live && c.url.startsWith('https:') && !!r.cors, ms: r.ms || null, cors: !!r.cors,
    https: c.url.startsWith('https:'), fails: live ? 0 : (old?.fails || 0) + 1,
    thumbAt, checkedAt: Date.now(), q: r.q ?? old?.q ?? null,
    // schedule as [startMs, stopMs, title]; the browser works out "on now" itself
    epg: guide.get(c.tvgId) || guide.get(c.tvgId.split('@')[0]) || (old?.epg || []).filter((p) => p[1] > Date.now()),
  });
});

const kept = channels.filter((c) => c.live)
  .sort((a, b) => b.live - a.live || a.name.localeCompare(b.name));
const ids = new Set(kept.map((c) => c.id));
for (const f of await readdir('public/thumbs')) if (f.endsWith('.jpg') && !ids.has(f.slice(0, -4))) await rm('public/thumbs/' + f);
await writeFile('public/data/channels.json', JSON.stringify({ updatedAt: Date.now(), checked: channels.length, channels: kept }));
console.log(`${kept.length} live of ${channels.length} checked, ${kept.filter((c) => c.playable).length} playable in a browser, ffmpeg ${HAVE_FFMPEG ? 'on' : 'off'}`);
