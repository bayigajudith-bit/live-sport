import './style.css';
import Hls from 'hls.js';

type Prog = [number, number, string]; // start ms, stop ms, title
interface Quality { h: number[]; kbps: number; codec: string }
interface Channel {
  id: string; name: string; logo: string; country: string; url: string;
  live: boolean | null; ms: number | null; https: boolean; cors: boolean;
  thumbAt: number | null; epg?: Prog[]; q?: Quality | null;
}

const BASE = import.meta.env.BASE_URL;
const PLAYLIST = 'https://iptv-org.github.io/iptv/categories/sports.m3u';
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago = (t: number | null) => { if (!t) return ''; const m = Math.round((Date.now() - t) / 6e4); return m < 2 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem('fl.' + k) ?? d; } catch { return d; } },
  set: (k: string, v: string | number) => { try { localStorage.setItem('fl.' + k, String(v)); } catch { /* private mode */ } },
};

let data: Channel[] = [], checked = true, first = true, hls: Hls | null = null, cur: Channel | null = null;

const tier = (h: number) => (h >= 2160 ? '4K' : h >= 1080 ? 'FHD' : h >= 720 ? 'HD' : 'SD');
const qLabel = (c: Channel) => (c.q?.h.length ? `${tier(c.q.h[0])} ${c.q.h[0]}p` : 'Quality unknown');
const nowOf = (c: Channel) => {
  const t = Date.now(), e = c.epg || [], i = e.findIndex((p) => p[0] <= t && t < p[1]);
  return i < 0 ? null : { cur: e[i], next: e[i + 1] };
};
const pct = (p: Prog) => Math.max(0, Math.min(100, Math.round(((Date.now() - p[0]) / (p[1] - p[0])) * 100)));
const facts = (c: Channel) => [
  c.country || 'International',
  c.q?.kbps ? `up to ${(c.q.kbps / 1000).toFixed(1)} Mbps` : '',
  c.q?.codec || '',
  c.q && c.q.h.length > 1 ? `${c.q.h.length} levels` : '',
  c.ms ? `${c.ms} ms` : '',
].filter(Boolean);

async function load(): Promise<{ updatedAt: number | null; channels: Channel[] }> {
  try {
    const r = await fetch(BASE + 'data/channels.json');
    if (!r.ok) throw 0;
    const j = await r.json();
    if (!j.channels.length) throw 0;
    return j;
  } catch { // no health data yet: read the public playlist, status unknown
    checked = false;
    const out: Channel[] = []; let m: Partial<Channel> | null = null;
    for (const l of (await (await fetch(PLAYLIST)).text()).split(/\r?\n/)) {
      if (l.startsWith('#EXTINF')) {
        const a = (k: string) => (l.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
        m = { name: l.slice(l.lastIndexOf(',') + 1).trim(), logo: a('tvg-logo'), country: ((a('tvg-id').match(/\.([a-z]{2})/i) || [])[1] || '').toUpperCase() };
      } else if (l.trim() && !l.startsWith('#') && m) {
        out.push({ ...(m as Channel), id: 'u' + out.length, url: l.trim(), live: null, ms: null, https: l.startsWith('https:'), cors: true, thumbAt: null }); m = null;
      }
    }
    return { updatedAt: null, channels: out };
  }
}

function card(c: Channel, i: number) {
  const n = nowOf(c);
  const label = c.live === null ? 'Unchecked' : c.live ? 'Live' : 'Offline';
  const dot = c.live ? 'bg-royal animate-pulse' : c.live === false ? 'bg-wine-700' : 'bg-bark-700/40';
  return `<button data-id="${c.id}" style="--i:${Math.min(i, 20)}" class="card group overflow-hidden rounded-2xl border border-bark-100 bg-white text-left shadow-sm transition hover:-translate-y-1 hover:border-royal hover:shadow-xl hover:shadow-wine-700/15">
  <div class="relative aspect-video overflow-hidden bg-gradient-to-br from-wine-600 to-bark-700 ${c.live === false ? 'opacity-60 grayscale' : ''}">
    ${c.thumbAt ? `<img loading="lazy" src="${BASE}thumbs/${c.id}.jpg" alt="" class="size-full object-cover transition duration-[6000ms] group-hover:scale-110">` : ''}
    <span class="absolute left-2 top-2 flex items-center gap-2 rounded-full bg-white/95 px-3 py-1 text-xs shadow"><i class="size-2 rounded-full ${dot}"></i>${label}${c.live && c.ms ? `, ${c.ms} ms` : ''}</span>
    <span class="absolute right-2 top-2 rounded-md bg-bark-900/85 px-2 py-0.5 text-xs font-medium text-white">${qLabel(c)}</span>
    ${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.remove()" class="absolute bottom-2 right-2 size-10 rounded-lg border border-bark-100 bg-white object-contain p-1">` : ''}
  </div>
  <div class="p-3.5">
    <div class="truncate font-display text-xl font-semibold">${esc(c.name)}</div>
    ${n ? `<div class="mt-2 text-sm"><span class="block truncate">${esc(n.cur[2])}</span><div class="mt-1.5 h-1 overflow-hidden rounded bg-bark-100"><i data-pg="${c.id}" class="block h-full rounded bg-royal" style="width:${pct(n.cur)}%"></i></div></div>` : ''}
    <div class="mt-2 flex flex-wrap gap-x-3 text-xs text-bark-700">${facts(c).map((x) => `<span>${x}</span>`).join('')}${c.thumbAt ? `<span>frame ${ago(c.thumbAt)}</span>` : ''}</div>
  </div></button>`;
}

function render() {
  const q = $<HTMLInputElement>('#q').value.toLowerCase(), co = $<HTMLSelectElement>('#country').value;
  const lo = $('#liveOnly').getAttribute('aria-pressed') === 'true' && checked;
  const rows = data.filter((c) => (!q || c.name.toLowerCase().includes(q) || (nowOf(c)?.cur[2] || '').toLowerCase().includes(q)) && (!co || c.country === co) && (!lo || c.live));
  const g = $('#grid');
  g.classList.toggle('enter', first); first = false;
  g.innerHTML = rows.length ? rows.map(card).join('') : '<p class="col-span-full py-16 text-center text-bark-700">No channels match. Clear the search or switch off “Live only”.</p>';
}

function guide() {
  const box = $('#guideBox'), rows = data.filter((c) => c.epg?.length).slice(0, 40);
  if (!rows.length) { box.innerHTML = '<p class="p-8 text-center text-bark-700">No guide data yet. Add the EPG_SITES repository variable and run the workflow.</p>'; return; }
  const PPM = 4, ws = Math.floor((Date.now() - 30 * 6e4) / 18e5) * 18e5, W = 360 * PPM, nowX = ((Date.now() - ws) / 6e4) * PPM;
  const ticks = Array.from({ length: 12 }, (_, i) => `<span class="absolute top-2 border-l border-bark-100 pl-1 text-xs text-bark-700" style="left:${i * 120}px">${hm(ws + i * 18e5)}</span>`).join('');
  const row = (c: Channel) => `<div class="flex border-t border-bark-100">
    <div class="sticky left-0 z-10 flex w-28 shrink-0 items-center bg-white px-3 text-sm font-medium"><span class="line-clamp-2">${esc(c.name)}</span></div>
    <div class="relative h-16" style="width:${W}px">${(c.epg || []).map((p) => {
      const l = Math.max(0, ((p[0] - ws) / 6e4) * PPM), r = Math.min(W, ((p[1] - ws) / 6e4) * PPM);
      if (r - l < 6) return '';
      const on = p[0] <= Date.now() && Date.now() < p[1];
      return `<button data-id="${c.id}" title="${esc(p[2])} ${hm(p[0])} to ${hm(p[1])}" class="absolute inset-y-1 overflow-hidden rounded-lg px-2 py-1 text-left text-xs ${on ? 'bg-wine-700 text-white' : 'bg-bark-100 hover:bg-royal hover:text-white'}" style="left:${l + 2}px;width:${r - l - 4}px"><b class="block truncate font-medium">${esc(p[2])}</b>${hm(p[0])}</button>`;
    }).join('')}</div></div>`;
  box.innerHTML = `<div class="relative" style="width:${W + 112}px"><div class="relative ml-28 h-9" style="width:${W}px">${ticks}</div>${rows.map(row).join('')}<div class="pointer-events-none absolute bottom-0 top-0 w-0.5 bg-royal" style="left:${112 + nowX}px"></div></div>`;
}

// ---- floating player ----
function err(msg: string) { const e = $('#perr'); e.textContent = msg; e.hidden = !msg; }
function stopHls() { hls?.destroy(); hls = null; $('#qual').hidden = true; }
function labelAuto() { if (!hls) return; const h = hls.levels[hls.currentLevel]?.height; ($('#qual') as HTMLSelectElement).options[0].textContent = h ? `Auto (${h}p)` : 'Auto'; }
function setupQuality() {
  if (!hls) return;
  const q = $<HTMLSelectElement>('#qual');
  const all = hls.levels.map((l, i) => ({ i, h: l.height || 0 })).filter((x) => x.h).sort((a, b) => b.h - a.h);
  const L = [...new Map(all.map((x) => [x.h, x])).values()];
  q.hidden = L.length < 2; if (q.hidden) return;
  q.innerHTML = '<option value="-1">Auto</option>' + L.map((x) => `<option value="${x.i}">${x.h}p</option>`).join('');
  const want = +store.get('q', '0'); let pick = -1;
  if (store.get('saver', '0') === '1') pick = L[L.length - 1].i;
  else if (want) { const m = L.find((x) => x.h <= want); if (m) pick = m.i; }
  q.value = String(pick); hls.currentLevel = pick; labelAuto();
}
function open(c: Channel) {
  cur = c; const v = $<HTMLVideoElement>('#vid');
  $('#player').hidden = false; $('#pname').textContent = c.name; err(''); stopHls();
  const n = nowOf(c);
  $('#pinfo').innerHTML = (n ? `<div><b class="text-white">On now:</b> ${esc(n.cur[2])} (${hm(n.cur[0])} to ${hm(n.cur[1])})</div>${n.next ? `<div><b class="text-white">Next:</b> ${esc(n.next[2])}, ${hm(n.next[0])}</div>` : ''}` : '')
    + `<div class="flex flex-wrap gap-1.5 pt-1">${[qLabel(c), ...(c.q && c.q.h.length > 1 ? [c.q.h.map((h) => h + 'p').join(' / ')] : []), ...facts(c)].map((x) => `<span class="rounded-md bg-white/10 px-2 py-0.5 text-xs">${esc(x)}</span>`).join('')}</div>`;
  if (!c.https && location.protocol === 'https:') return err('This stream uses http, so browsers block it on this secure page.');
  if (Hls.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.MANIFEST_PARSED, setupQuality);
    hls.on(Hls.Events.LEVEL_SWITCHED, labelAuto);
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) err('This stream isn’t responding right now. Try another channel.'); });
    hls.loadSource(c.url); hls.attachMedia(v);
  } else v.src = c.url;
  v.play().catch(() => {});
}
function setFull(on: boolean) { // covers the whole page, and asks the browser for real full screen too
  const p = $('#player'); p.toggleAttribute('data-full', on); document.body.classList.toggle('overflow-hidden', on);
  if (on) p.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen();
}
function closePlayer() { setFull(false); stopHls(); const v = $<HTMLVideoElement>('#vid'); v.pause(); v.removeAttribute('src'); v.load(); $('#player').hidden = true; cur = null; }

document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('#grid [data-id], #guideBox [data-id]');
  const c = b && data.find((x) => x.id === b.dataset.id); if (c) open(c);
});
$('#close').onclick = closePlayer;
$('#expand').onclick = () => setFull(!$('#player').hasAttribute('data-full'));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && $('#player').hasAttribute('data-full')) setFull(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#player').hasAttribute('data-full')) setFull(false); });
$('#qual').onchange = (e) => { const i = +(e.target as HTMLSelectElement).value; if (hls) { hls.currentLevel = i; store.set('q', i < 0 ? 0 : hls.levels[i].height); } };
$('#q').oninput = render; $('#country').onchange = render;
$('#liveOnly').onclick = (e) => { const b = e.currentTarget as HTMLElement; b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); render(); };
$('#saver').setAttribute('aria-pressed', String(store.get('saver', '0') === '1'));
$('#saver').onclick = (e) => { const b = e.currentTarget as HTMLElement, on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); store.set('saver', on ? 1 : 0); };

setInterval(() => { // keep progress bars and the guide's "now" line current
  document.querySelectorAll<HTMLElement>('[data-pg]').forEach((el) => { const c = data.find((x) => x.id === el.dataset.pg), n = c && nowOf(c); if (n) el.style.width = pct(n.cur) + '%'; });
  const box = $('#guideBox'), sl = box.scrollLeft; guide(); box.scrollLeft = sl;
}, 60000);

load().then((j) => {
  data = j.channels;
  $('#country').innerHTML += [...new Set(data.map((c) => c.country).filter(Boolean))].sort().map((c) => `<option>${c}</option>`).join('');
  const n = data.filter((c) => c.live).length;
  $('#sub').textContent = checked ? `${n} channels live out of ${data.length} checked. Updated ${ago(j.updatedAt)}. Frames show what each channel was airing at the last check.` : `${data.length} channels loaded. Run the workflow to see which are live.`;
  if (!checked) $('#liveOnly').hidden = true;
  render(); guide();
}).catch(() => { $('#sub').textContent = 'Could not load channels. Check your connection and refresh.'; });
