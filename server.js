#!/usr/bin/env node
/*
 * X/Twitter video downloader — self-hosted web app.
 * Zero-dependency Node server.
 *
 * - POST /api/extract  {url}  -> tweet metadata + video/photo variants
 * - GET  /media?url=...       -> 302 to CDN (inline preview, plays straight from CDN)
 * - GET  /dl?v=..&fid=..&url=..&name=..  -> streamed download (attachment)
 * - GET  /api/status          -> health (yt-dlp + ffmpeg versions)
 * - GET  /                    -> UI
 *
 * Backends:
 *   1. yt-dlp (guest-token extraction; handles API changes)
 *   2. fxtwitter API fallback (no auth, instant, also photo media)
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.PORT || 18820);
const TMP_DIR = process.env.TMP_DIR || '/tmp/xdl';
const YTDLP = process.env.YTDLP || 'yt-dlp'; // ensure ffmpeg is on PATH for merges
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(TMP_DIR, { recursive: true });

/* ------------------------------ helpers ------------------------------ */

const ALLOWED_CDN_HOSTS = new Set(['video.twimg.com', 'pbs.twimg.com']);

function safeCdnUrl(u) {
  if (typeof u !== 'string') return null;
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_CDN_HOSTS.has(parsed.hostname)) return null;
  return parsed;
}

function sanitizeFilename(s, max = 80) {
  return String(s || 'video')
    .replace(/[^\p{L}\p{N} _\-.()']/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------- rate limiting (per IP) ------------------------- */

const hits = new Map(); // ip -> number[]
function rateLimit(ip, windowMs, max) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(ip, arr); return false; }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

// memory hygiene: drop stale entries occasionally
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) if (!arr.some((t) => now - t < 60000)) hits.delete(ip);
}, 60000).unref();

/* ------------------------------ concurrency ------------------------------ */

let activeExtracts = 0;
let activeDownloads = 0;
const MAX_EXTRACTS = 1;
const MAX_DOWNLOADS = 2;

/* ------------------------------ extraction ------------------------------ */

const TWEET_RE = /(?:twitter\.com|x\.com)\/[A-Za-z0-9_]+\/status\/(\d+)/;

function normalizeUrl(input) {
  const m = String(input || '').trim().match(TWEET_RE);
  if (!m) {
    const e = new Error('Not a valid X/Twitter tweet URL');
    e.status = 400;
    throw e;
  }
  return `https://x.com/i/status/${m[1]}`;
}

function runYtdlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`yt-dlp exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

// kind: 0=mix, 1=video only, 2=audio only
function classifyFormat(f) {
  const v = f.vcodec && f.vcodec !== 'none';
  const a = f.acodec && f.acodec !== 'none';
  if (f.vcodec === 'none') return 2;
  if (a || String(f.protocol).startsWith('http')) return 0; // progressive single-file = mix even when codecs unknown
  if (v) return 1;
  return 1;
}

function heightOf(f) {
  const m = /^(\d+)x(\d+)$/.exec(f.resolution || '');
  if (m) return Math.min(+m[1], +m[2]);
  return f.height || 0;
}

function pickLabel(f) {
  return heightOf(f) ? `${heightOf(f)}p` : (f.format_note || f.ext || 'auto');
}

function extractWithYtdlp(input) {
  return runYtdlp(
    ['-J', '--no-playlist', '--skip-download', '--no-warnings', input],
    45000,
  ).then((out) => JSON.parse(out)).then((d) => {
    const videos = [];
    for (const f of d.formats || []) {
      if (classifyFormat(f) !== 0) continue; // progressive single-file mp4 only for direct stream
      const u = safeCdnUrl(f.url);
      if (!u) continue;
      videos.push({
        fid: f.format_id,
        label: pickLabel(f),
        height: heightOf(f),
        ext: f.ext || 'mp4',
        tbr: f.tbr || f.vbr || 0,
        filesize: f.filesize || null, // filesize_approx is from X's advertised bitrate, ~3x too high
        url: f.url,
      });
    }
    const hls = [];
    for (const f of d.formats || []) {
      if (classifyFormat(f) === 1 && f.protocol && f.protocol.startsWith('m3u8')) {
        hls.push({ fid: f.format_id, label: `${pickLabel(f)} (HLS)`, height: heightOf(f) });
      }
    }
    // de-dup by height, prefer higher tbr
    const byH = new Map();
    for (const v of videos) {
      const k = `${v.height}`;
      const cur = byH.get(k);
      if (!cur || v.tbr > cur.tbr) byH.set(k, v);
    }
    return {
      id: String(d.id || ''),
      title: d.title || '',
      uploader: d.uploader || d.uploader_id || '',
      duration: d.duration || 0,
      thumbnail: d.thumbnail || null,
      videos: [...byH.values()].sort((a, b) => b.height - a.height),
      hls,
      photos: [],
      source: 'yt-dlp',
    };
  });
}

function extractWithFxtwitter(input) {
  const id = TWEET_RE.exec(input)[1];
  return fetchJson(`https://api.fxtwitter.com/status/${id}`, 15000).then((d) => {
    const t = d.tweet || {};
    const media = t.media || {};
    const videos = [];
    const photos = [];
    let hasHls = false;
    for (const item of media.all || []) {
      if (item.type === 'photo') {
        photos.push({ url: item.url, thumb: item.thumbnail_url, alt: item.alt || '' });
        continue;
      }
      // video or gif — both expose mp4 `formats`
      for (const f of item.formats || []) {
        if (f.container !== 'mp4' || !f.url) continue;
        const m = /(\d+)x(\d+)/.exec(f.url.split('?')[0]);
        const h = m ? Math.min(+m[1], +m[2]) : 0;
        if (videos.some((v) => v.height === h)) continue;
        videos.push({
          fid: `fx-${h || 'auto'}`,
          label: h ? `${h}p` : 'auto',
          height: h,
          ext: 'mp4',
          tbr: f.bitrate || 0,
          filesize: null,
          url: f.url,
        });
      }
      const hlsU = (item.formats || []).find((f) => f.container === 'm3u8');
      if (hlsU && !hasHls) {
        hasHls = true;
        d.hls = [{ fid: 'fx-hls', label: 'Auto (HLS)', height: 0 }];
      }
    }
    if (videos.length === 0 && media.videos && media.videos[0]) {
      // gif / unusual shapes
      const g = media.videos[0];
      for (const f of g.formats || []) {
        if (f.container === 'mp4' && f.url) {
          videos.push({ fid: `fx-${f.bitrate || 0}`, label: 'auto', height: 0, ext: 'mp4', tbr: f.bitrate || 0, filesize: null, url: f.url });
        }
      }
    }
    return {
      id,
      title: t.text || '',
      uploader: t.author ? t.author.name : '',
      duration: (media.all || []).find((i) => i.duration)?.duration || 0,
      thumbnail: (media.all || []).find((i) => i.thumbnail_url)?.thumbnail_url || (t.author ? t.author.banner_url : null),
      videos: videos.sort((a, b) => b.height - a.height),
      hls: d.hls || [],
      photos,
      source: 'fxtwitter',
    };
  });
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'xdl/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`fxtwitter HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json from fxtwitter')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('fxtwitter timeout')); });
  });
}

async function extract(input) {
  const norm = normalizeUrl(input);
  if (!rateLimit('extract', 60_000, 6)) throw Object.assign(new Error('Rate limit — try again in a minute'), { status: 429 });
  if (activeExtracts >= MAX_EXTRACTS) throw Object.assign(new Error('Busy — another video is being processed'), { status: 503 });
  activeExtracts++;
  try {
    let r = await extractWithYtdlp(norm).catch(async (e) => {
      console.error('[extract] yt-dlp failed:', e.message);
      // fallback to fxtwitter when yt-dlp fails (rate limiting, API change, photos)
      return extractWithFxtwitter(norm).catch((e2) => {
        const err = new Error(`Extraction failed: ${e.message || e}` + (e2 ? ` | fallback: ${e2.message || e2}` : ''));
        err.status = 502;
        throw err;
      });
    });
    // if yt-dlp found no media at all (e.g. photo-only tweet), fall back to fxtwitter
    if ((!r.videos || r.videos.length === 0) && (!r.photos || r.photos.length === 0)) {
      try { r = await extractWithFxtwitter(norm); } catch { /* keep yt-dlp result */ }
    }
    // merge in photos when the primary source didn't provide any (mixed tweets)
    if (!r.photos || r.photos.length === 0) {
      const fx = await extractWithFxtwitter(norm).catch(() => null);
      if (fx && fx.photos && fx.photos.length) r.photos = fx.photos;
    }
    if ((!r.videos || r.videos.length === 0) && (!r.photos || r.photos.length === 0)) {
      throw Object.assign(new Error('No downloadable media found in this tweet'), { status: 404 });
    }
    return r;
  } finally {
    activeExtracts--;
  }
}

/* ------------------------------ download ------------------------------ */

function streamCdn(res, cdnUrl, { name, inline }) {
  return new Promise((resolve, reject) => {
    const req = https.get(cdnUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36', Accept: '*/*' } }, (up) => {
      if (up.statusCode >= 400) {
        up.resume();
        return reject(Object.assign(new Error(`CDN HTTP ${up.statusCode}`), { status: 502 }));
      }
      if (up.statusCode >= 300 && up.headers.location) {
        up.resume();
        return streamCdn(res, new URL(up.headers.location, cdnUrl), { name, inline });
      }
      const headers = {
        'Content-Type': up.headers['content-type'] || 'video/mp4',
        'Cache-Control': 'no-store',
      };
      if (up.headers['content-length']) headers['Content-Length'] = up.headers['content-length'];
      headers['Content-Disposition'] = inline
        ? 'inline'
        : `attachment; filename="${encodeURIComponent(name)}"`;
      res.writeHead(200, headers);
      up.pipe(res);
      up.on('end', () => resolve());
      up.on('error', reject);
      res.on('close', () => up.destroy());
    });
    req.setTimeout(30000, () => req.destroy(new Error('CDN timeout (idle)')));
    req.on('error', reject);
  });
}

function downloadHls(res, url, fid, name, inline) {
  return new Promise((resolve, reject) => {
    if (activeDownloads >= MAX_DOWNLOADS) {
      return reject(Object.assign(new Error('Server busy — try again in a moment'), { status: 503 }));
    }
    activeDownloads++;
    const out = path.join(TMP_DIR, `hls-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
    const child = spawn(YTDLP, ['-f', fid, '--no-playlist', '-o', out, '--no-warnings', url], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', async (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`merge failed (${code}): ${err.slice(0, 200)}`);
        const stat = await fs.promises.stat(out);
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
          'Content-Disposition': inline ? 'inline' : `attachment; filename="${encodeURIComponent(name)}"`,
        });
        res.on('close', () => fs.promises.unlink(out).catch(() => {}));
        const rs = fs.createReadStream(out);
        rs.pipe(res);
        rs.on('end', () => { fs.promises.unlink(out).catch(() => {}); resolve(); });
        rs.on('error', reject);
      } catch (e) {
        fs.promises.unlink(out).catch(() => {});
        reject(e);
      } finally {
        activeDownloads--;
      }
    });
    child.on('error', () => { clearTimeout(timer); fs.promises.unlink(out).catch(() => {}); activeDownloads--; reject(new Error('yt-dlp not found')); });
  });
}

/* ------------------------------ http server ------------------------------ */

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'x'}`); } catch { return json(res, 400, { error: 'bad url' }); }
  const ip = req.socket.remoteAddress || '?';

  try {
    /* static UI */
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const f = path.join(PUBLIC_DIR, 'index.html');
      const body = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      return res.end(body);
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const [yt, ff] = await Promise.all([
        runYtdlp(['--version'], 10000).catch(() => 'missing'),
        new Promise((resolve) => {
          const c = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
          let v = '';
          c.stdout.on('data', (d) => { v += d; });
          c.on('close', () => resolve(v.split('\n')[0] || 'missing'));
          c.on('error', () => resolve('missing'));
        }),
      ]);
      return json(res, 200, { ok: true, ytdlp: yt.trim(), ffmpeg: ff, port: PORT, tmp: TMP_DIR });
    }

    /* extract API */
    if (req.method === 'POST' && url.pathname === '/api/extract') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const info = await extract(body.url);
      return json(res, 200, info);
    }

    /* inline preview redirect (progressive only) */
    if (req.method === 'GET' && url.pathname === '/media') {
      const cdn = safeCdnUrl(url.searchParams.get('url'));
      if (!cdn) return json(res, 400, { error: 'invalid media url' });
      res.writeHead(302, { Location: cdn.href });
      return res.end();
    }

    /* download */
    if (req.method === 'GET' && url.pathname === '/dl') {
      if (!rateLimit('dl', 60_000, 10)) return json(res, 429, { error: 'Rate limit — slow down' });
      const cdn = safeCdnUrl(url.searchParams.get('url'));
      const v = url.searchParams.get('v');
      const fid = url.searchParams.get('fid');
      const inline = url.searchParams.get('inline') === '1';
      const name = sanitizeFilename(url.searchParams.get('name') || 'video') + '.mp4';
      if (cdn) {
        const q = cdn.searchParams.get('tag');
        // strip twimg tag param for cleaner streams
        if (q) cdn.searchParams.delete('tag');
        activeDownloads++;
        try { await streamCdn(res, cdn, { name, inline }); }
        catch (e) { if (!res.headersSent) json(res, e.status || 502, { error: e.message }); }
        finally { activeDownloads--; }
        return;
      }
      if (v && fid) {
        await downloadHls(res, `https://x.com/i/status/${v}`, fid, name, inline);
        return;
      }
      return json(res, 400, { error: 'missing url or v/fid' });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    json(res, e.status || 500, { error: e.message || 'internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`xdl listening on http://127.0.0.1:${PORT}  (yt-dlp: ${process.env.YTDLP || 'yt-dlp'})`);
});