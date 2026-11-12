// Servidor local de ZeckClips: sirve la app y descarga / convierte vídeos con yt-dlp y ffmpeg.
// Lo arranca main.js dentro de la app de escritorio; también funciona solo: `node server.js` → http://localhost:5178
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { MAX_VIDEO_BYTES, validatePublicUrl, requestPublic, writeLimited, isSupportedVideoSite, denyLocalRequest, denyApiRequest } = require('./security');

const MAX_HEIGHT = 1080;
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.mkv'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const EXE = process.platform === 'win32' ? '.exe' : '';
const PROGRESS = new Map(); // id de descarga -> { pct, msg } para la barra de la app

// busca un programa: primero en los binarios incluidos con la app, luego en el sistema
function finder(binDir) {
  const extra = [binDir, path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
  const dirs = [...extra, ...(process.env.PATH || '').split(path.delimiter)];
  const cache = {};
  return name => {
    if (name in cache) return cache[name];
    for (const d of dirs) {
      const p = path.join(d, name + EXE);
      try { fs.accessSync(p, fs.constants.X_OK); return (cache[name] = p); } catch {}
    }
    return (cache[name] = null);
  };
}

function createServer({ root, binDir, nodeRuntime }) {
  const find = finder(binDir);

  // YouTube necesita un motor de JavaScript: deno/node del sistema o, en la app, el propio Electron como Node
  function ytdlp() {
    const exe = find('yt-dlp');
    if (!exe) return null;
    const args = [], env = { ...process.env, PYTHONUNBUFFERED: '1' };
    const rt = find('deno') ? ['deno', find('deno')] : find('node') ? ['node', find('node')] : nodeRuntime ? ['node', nodeRuntime] : null;
    if (rt) args.push('--js-runtimes', `${rt[0]}:${rt[1]}`);
    if (rt && rt[1] === nodeRuntime) env.ELECTRON_RUN_AS_NODE = '1';
    if (find('ffmpeg')) args.push('--ffmpeg-location', find('ffmpeg'));
    return { exe, args, env };
  }

  const json = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b); };
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zeckclips-'));
  const rm = d => fs.rm(d, { recursive: true, force: true }, () => {});
  const sendFile = (res, file, type, name) => {
    const h = { 'Content-Type': type, 'Content-Length': fs.statSync(file).size };
    if (name) h['X-Filename'] = encodeURIComponent(name);
    res.writeHead(200, h);
    return new Promise(r => fs.createReadStream(file).on('close', r).pipe(res));
  };
  const run = (exe, args, opts, onLine) => new Promise(resolve => {
    const p = spawn(exe, args, { ...opts, windowsHide: true });
    const last = []; let buf = '';
    const feed = d => { buf += d; const lines = buf.split(/\r?\n|\r/); buf = lines.pop();
      for (const l of lines) { last.push(l.trim()); if (last.length > 8) last.shift(); onLine && onLine(l); } };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', e => resolve({ code: -1, last: [String(e.message)] }));
    p.on('close', code => resolve({ code, last }));
  });

  async function download(req, res, input, job) {
    let url;
    try { url = validatePublicUrl(input); }
    catch (e) { return json(res, 400, { error: e.message }); }
    const tmp = tmpDir();
    try {
      const basename = path.basename(decodeURIComponent(url.pathname)) || 'video.mp4';
      const name = basename.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').slice(0, 120);
      const ext = path.extname(name).toLowerCase();
      let ctype = '';
      // Some hosts disallow HEAD; direct video URLs can go straight to GET.
      if (!VIDEO_EXT.includes(ext)) {
        try {
          const head = await requestPublic(url.href, 'HEAD');
          ctype = String(head.headers['content-type'] || '').toLowerCase();
          head.resume();
        } catch (e) {
          // A failed HEAD does not authorize arbitrary URLs for yt-dlp.
          if (!isSupportedVideoSite(url)) throw e;
        }
      }
      if (ctype.startsWith('video/') || VIDEO_EXT.includes(ext)) {
        const response = await requestPublic(url.href);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          throw new Error('HTTP ' + response.statusCode);
        }
        const type = String(response.headers['content-type'] || ctype).split(';')[0].toLowerCase();
        const out = path.join(tmp, 'video' + (VIDEO_EXT.includes(ext) ? ext : '.mp4'));
        await writeLimited(response, out);
        return await sendFile(res, out, type.startsWith('video/') ? type : 'video/mp4', name);
      }
      // Restrict subprocess extractors to known video platforms.
      if (!isSupportedVideoSite(url)) {
        throw new Error('Para enlaces que no sean archivos de vídeo directos, solo se admiten plataformas conocidas (YouTube, Twitch, TikTok, etc.)');
      }
      const y = ytdlp();
      if (!y) throw new Error('Falta yt-dlp para descargar de plataformas de vídeo');
      const fmt = find('ffmpeg')
        ? `bv*[height<=${MAX_HEIGHT}][ext=mp4]+ba[ext=m4a]/b[height<=${MAX_HEIGHT}][ext=mp4]/bv*[height<=${MAX_HEIGHT}]+ba/b`
        : `b[height<=${MAX_HEIGHT}][ext=mp4]/b`;
      PROGRESS.set(job, { pct: 3, msg: 'Analizando el enlace…' });
      let part = 0;
      const result = await run(y.exe, [...y.args, '--no-config', '--no-playlist', '--newline', '-f', fmt,
        '--merge-output-format', 'mp4', '--max-filesize', String(MAX_VIDEO_BYTES),
        '-o', path.join(tmp, '%(title).80s.%(ext)s'), url.href], { env: y.env }, line => {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          const pct = parseFloat(m[1]);
          if (pct < 1 && (PROGRESS.get(job)?.pct || 0) > 40) part = 1;
          PROGRESS.set(job, { pct, msg: `${part ? 'Descargando audio' : 'Descargando vídeo'} ${pct.toFixed(0)}%` });
        } else if (line.includes('[Merger]')) PROGRESS.set(job, { pct: 100, msg: 'Uniendo vídeo y audio…' });
      });
      const file = fs.readdirSync(tmp).find(f => VIDEO_EXT.includes(path.extname(f).toLowerCase()));
      if (result.code !== 0 || !file) throw new Error('No se pudo descargar: ' + ([...result.last].reverse().find(l => l.includes('ERROR')) || result.last.at(-1) || 'error desconocido'));
      const downloaded = path.join(tmp, file);
      if (fs.statSync(downloaded).size > MAX_VIDEO_BYTES) {
        const e = new Error('Vídeo demasiado grande (máximo 2 GiB)');
        e.statusCode = 413;
        throw e;
      }
      await sendFile(res, downloaded, file.endsWith('.webm') ? 'video/webm' : 'video/mp4', file);
    } catch (e) {
      if (!res.headersSent) json(res, e.statusCode || 502, { error: e.message });
    } finally { rm(tmp); PROGRESS.delete(job); }
  }

  // convierte la grabación del navegador en un MP4 estándar (H.264 + AAC, 30 fps, faststart)
  async function toMp4(req, res, src) {
    const ffmpeg = find('ffmpeg');
    if (!ffmpeg) return json(res, 501, { error: 'ffmpeg no está instalado' });
    const tmp = tmpDir();
    try {
      const inp = path.join(tmp, src === 'mp4' ? 'in.mp4' : 'in.webm'), out = path.join(tmp, 'out.mp4');
      await writeLimited(req, inp);
      const encode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
      // el MP4 de Chromium ya es H.264: basta con reordenarlo; si falla, se recodifica
      const attempts = [...(src === 'mp4' ? [['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k']] : []), encode];
      let r;
      for (const opts of attempts) {
        r = await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', inp, ...opts, '-movflags', '+faststart', out], {});
        if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return await sendFile(res, out, 'video/mp4');
      }
      throw new Error('ffmpeg: ' + (r.last.at(-1) || 'error'));
    } catch (e) {
      if (!res.headersSent) json(res, e.statusCode || 500, { error: e.message });
    } finally { rm(tmp); }
  }

  const baseDir = fs.realpathSync(root);
  const insideRoot = file => {
    const rel = path.relative(baseDir, file);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  return http.createServer(async (req, res) => {
    const denied = denyLocalRequest(req);
    if (denied) return json(res, 403, { error: denied });
    let u;
    try { u = new URL(req.url, 'http://localhost'); }
    catch { return json(res, 400, { error: 'URL no válida' }); }
    const q = k => u.searchParams.get(k) || '';
    if (u.pathname.startsWith('/api/')) {
      const apiDenied = denyApiRequest(req);
      if (apiDenied) return json(res, 403, { error: apiDenied });
      if (u.pathname === '/api/status' && req.method === 'GET') return json(res, 200, { ytdlp: !!ytdlp(), ffmpeg: !!find('ffmpeg') });
      if (u.pathname === '/api/progress' && req.method === 'GET') return json(res, 200, PROGRESS.get(q('id')) || {});
      if (u.pathname === '/api/download' && req.method === 'GET') return download(req, res, q('url').trim(), q('id'));
      if (u.pathname === '/api/mp4' && req.method === 'POST') {
        const length = Number(req.headers['content-length'] || 0);
        if (length > MAX_VIDEO_BYTES) return json(res, 413, { error: 'Vídeo demasiado grande (máximo 2 GiB)' });
        return toMp4(req, res, q('from'));
      }
      return json(res, 405, { error: 'Método o ruta no permitidos' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); return res.end();
    }
    let decoded;
    try { decoded = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname); }
    catch { return json(res, 400, { error: 'Ruta no válida' }); }
    const file = path.resolve(baseDir, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
    if (!insideRoot(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory() ||
      !insideRoot(fs.realpathSync(file))) {
      res.writeHead(404); return res.end('No encontrado');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// arranca en el primer puerto libre a partir de `port` (puerto fijo = la app recuerda tus ajustes y el modelo descargado)
function listen(server, port, tries = 20) {
  return new Promise((resolve, reject) => {
    server.once('error', e => (e.code === 'EADDRINUSE' && tries > 1 ? listen(server, port + 1, tries - 1).then(resolve, reject) : reject(e)));
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

const platformDir = () => `${{ darwin: 'mac', win32: 'win' }[process.platform] || 'linux'}-${process.arch}`;

module.exports = { createServer, listen, platformDir };

if (require.main === module) {
  const server = createServer({ root: path.join(__dirname, 'app'), binDir: path.join(__dirname, 'bin', platformDir()) });
  listen(server, +process.env.PORT || 5178).then(p => console.log(`ZeckClips en http://localhost:${p}`));
}
