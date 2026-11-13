// Descarga ffmpeg y yt-dlp para cada sistema en bin/<so>-<arquitectura>/, que el instalador incluye en la app.
// Uso: node scripts/fetch-bins.mjs [mac|win|linux|all]   (sin argumento: solo el sistema actual)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureVerifiedBinary, getBounded } from './verified-binaries.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const YTDLP = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26';

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
    'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
  ],
  'linux-arm64': [
    '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
    '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce',
  ],
};
// Pinned yt-dlp release 2026.10.26: publisher GitHub asset SHA-256 digests.
// An explicit update of this table is required to upgrade yt-dlp.
const YTDLP_SHA256 = {
  'yt-dlp_macos': '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa',
  'yt-dlp.exe': 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d',
  'yt-dlp_linux': '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795',
  'yt-dlp_linux_aarch64': 'e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483',
};

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

for (const target of list) {
  const [ff, yt] = TARGETS[target];
  const win = target.startsWith('win');
  const dir = path.join(ROOT, 'bin', target);
  fs.mkdirSync(dir, { recursive: true });
  const ffOut = path.join(dir, win ? 'ffmpeg.exe' : 'ffmpeg');
  const ytOut = path.join(dir, win ? 'yt-dlp.exe' : 'yt-dlp');

  const [archiveSha256, executableSha256] = FFMPEG_SHA256[target] || [];
  if (!archiveSha256 || !executableSha256) throw new Error('Sin hash FFmpeg conocido para ' + target);
  const ffmpegResult = await ensureVerifiedBinary({
    filename: ffOut,
    url: `${FFMPEG}/ffmpeg-${ff}.gz`,
    expectedSha256: executableSha256,
    archiveSha256,
    extract: archive => zlib.gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 }),
  });
  if (ffmpegResult === 'downloaded') console.log(`${target}: FFmpeg verificado (SHA-256)`);

  // The license is documentation only: keep it beside an already verified executable.
  const licenseOut = path.join(dir, 'ffmpeg-LICENSE.txt');
  if (!fs.existsSync(licenseOut)) {
    const licenseArchive = await getBounded(`${FFMPEG}/${ff}.LICENSE.gz`, { maxBytes: 1024 * 1024 });
    fs.writeFileSync(licenseOut, zlib.gunzipSync(licenseArchive, { maxOutputLength: 2 * 1024 * 1024 }));
  }

  const ytSha = YTDLP_SHA256[yt];
  if (!ytSha) throw new Error('Sin hash yt-dlp conocido para ' + target);
  const ytResult = await ensureVerifiedBinary({
    filename: ytOut,
    url: `${YTDLP}/${yt}`,
    expectedSha256: ytSha,
  });
  console.log(`${target}: yt-dlp ${ytResult === 'cached' ? 'en caché (SHA-256 válido)' : 'descargado (SHA-256 válido)'}`);
}
console.log('Binarios listos en bin/:', list.join(', '));
