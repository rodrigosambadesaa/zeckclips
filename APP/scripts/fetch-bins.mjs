// Descarga ffmpeg y yt-dlp para cada sistema en bin/<so>-<arquitectura>/, que el instalador incluye en la app.
// Uso: node scripts/fetch-bins.mjs [mac|win|linux|all]   (sin argumento: solo el sistema actual)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const YTDLP = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

// SHA-256 of release b6.1.1, from the publisher's GitHub release asset digests.
// Entries: [compressed .gz, uncompressed executable].
const FFMPEG_SHA256 = {
  'mac-x64': [
    '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
    'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
  ],
  'mac-arm64': [
    '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
    'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
  ],
  'win-x64': [
    '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
    '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
  ],
  'linux-x64': [
    'bfe8a8fc511530457b528c48d77b504a3797a9bc4866aeca69c2dffa',
    'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
  ],
  'linux-arm64': [
    '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
    '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce',
  ],
};
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

// destino → [nombre de ffmpeg-static, ejecutable de yt-dlp]
const TARGETS = {
  'mac-x64': ['darwin-x64', 'yt-dlp_macos'],
  'mac-arm64': ['darwin-arm64', 'yt-dlp_macos'],
  'win-x64': ['win32-x64', 'yt-dlp.exe'],
  'linux-x64': ['linux-x64', 'yt-dlp_linux'],
  'linux-arm64': ['linux-arm64', 'yt-dlp_linux_aarch64'],
};

const current = `${{ darwin: 'mac', win32: 'win' }[process.platform] || 'linux'}-${process.arch}`;
const want = process.argv[2] || current;
const list = Object.keys(TARGETS).filter(t => want === 'all' || t === want || t.startsWith(want + '-'));
if (!list.length) { console.error(`Sistema desconocido: ${want}`); process.exit(1); }

async function get(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} al descargar ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

let sums;
async function ytdlpSum(name) {
  sums ??= Object.fromEntries((await get(`${YTDLP}/SHA2-256SUMS`)).toString().trim().split('\n').map(l => l.trim().split(/\s+/).reverse()));
  return sums[name];
}

for (const t of list) {
  const [ff, yt] = TARGETS[t], win = t.startsWith('win'), dir = path.join(ROOT, 'bin', t);
  fs.mkdirSync(dir, { recursive: true });
  const ffOut = path.join(dir, win ? 'ffmpeg.exe' : 'ffmpeg'), ytOut = path.join(dir, win ? 'yt-dlp.exe' : 'yt-dlp');

  const [compressedHash, extractedHash] = FFMPEG_SHA256[t];
  if (!compressedHash || !extractedHash) throw new Error('Sin hash FFmpeg conocido para ' + t);
  if (!fs.existsSync(ffOut) || sha256(fs.readFileSync(ffOut)) !== extractedHash) {
    process.stdout.write(`${t}: ffmpeg… `);
    const archive = await get(`${FFMPEG}/ffmpeg-${ff}.gz`);
    if (sha256(archive) !== compressedHash) throw new Error('Checksum FFmpeg .gz incorrecto para ' + t);
    const executable = zlib.gunzipSync(archive);
    if (sha256(executable) !== extractedHash) throw new Error('Checksum FFmpeg incorrecto para ' + t);
    fs.writeFileSync(ffOut, executable, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'ffmpeg-LICENSE.txt'), zlib.gunzipSync(await get(`${FFMPEG}/${ff}.LICENSE.gz`)));
    console.log('ok (SHA-256 verificado)');
  }
  const expected = await ytdlpSum(yt);
  if (!/^[a-f\d]{64}$/i.test(expected || '')) throw new Error('No hay checksum yt-dlp válido para ' + yt);
  if (!fs.existsSync(ytOut) || sha256(fs.readFileSync(ytOut)) !== expected) {
    process.stdout.write(`${t}: yt-dlp… `);
    const bin = await get(`${YTDLP}/${yt}`);
    if (sha256(bin) !== expected) throw new Error(`La suma SHA-256 de ${yt} no coincide`);
    fs.writeFileSync(ytOut, bin, { mode: 0o755 });
    console.log('ok (SHA-256 verificado)');
  }
}
console.log('Binarios listos en bin/:', list.join(', '));
