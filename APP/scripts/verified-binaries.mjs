// Reusable, bounded and atomic downloader for pinned third-party executables.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

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

// Node's fetch() transparently decompresses Content-Encoding: gzip responses.
// Release assets may legitimately be gzipped, so read the exact bytes through
// http/https instead: the pinned SHA-256 must match the published archive bytes.
export async function getBounded(input, { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid maximum download size');
  let url = new URL(input);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid download protocol');
    const response = await new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.get(url, { timeout: timeoutMs }, resolve);
      request.on('timeout', () => request.destroy(new Error('Se agotó el tiempo de descarga')));
      request.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const destination = response.headers.location;
      response.resume();
      if (!destination) throw new Error('Redirección sin destino');
      url = new URL(destination, url);
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`HTTP ${response.statusCode} al descargar ${url}`);
    }
    const declared = Number(response.headers['content-length'] || 0);
    if (declared > maxBytes) {
      response.destroy();
      throw new Error(`Descarga demasiado grande: ${url}`);
    }
    return await new Promise((resolve, reject) => {
      const parts = [];
      let size = 0;
      let limitError = null;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          limitError = new Error(`Descarga demasiado grande: ${url}`);
          response.destroy(limitError);
        } else parts.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(parts, size)));
      response.on('error', reject);
      response.on('aborted', () => reject(limitError || new Error('Descarga incompleta')));
    });
  }
  throw new Error('Demasiadas redirecciones');
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
