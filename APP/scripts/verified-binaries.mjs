// Reusable, bounded and atomic downloader for pinned third-party executables.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function isVerifiedFile(filename, expectedSha256) {
  try {
    return sha256(fs.readFileSync(filename)) === expectedSha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function getBounded(url, { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid maximum download size');
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} al descargar ${url}`);
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Descarga demasiado grande: ${url}`);
  }
  if (!response.body) throw new Error('La descarga no devolvió contenido');
  const parts = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`Descarga demasiado grande: ${url}`);
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts, size);
}

export async function ensureVerifiedBinary({ filename, url, expectedSha256, archiveSha256, extract, get = getBounded }) {
  if (!/^[a-f\d]{64}$/i.test(expectedSha256 || '')) throw new Error('SHA-256 de ejecutable no válido');
  if (isVerifiedFile(filename, expectedSha256)) return 'cached';
  const archive = await get(url);
  if (archiveSha256 && sha256(archive) !== archiveSha256) {
    throw new Error(`Checksum del archivo comprimido incorrecto: ${url}`);
  }
  const binary = extract ? extract(archive) : archive;
  if (sha256(binary) !== expectedSha256) {
    throw new Error(`Checksum de ejecutable incorrecto: ${url}`);
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, binary, { mode: 0o755 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return 'downloaded';
}
