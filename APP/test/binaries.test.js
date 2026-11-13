'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const binaries = import('../scripts/verified-binaries.mjs');

test('a valid cached executable never requires a network request', async () => {
  const { sha256, ensureVerifiedBinary, isVerifiedFile } = await binaries;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeckclips-cache-'));
  try {
    const file = path.join(root, 'yt-dlp');
    const data = Buffer.from('cached verified executable');
    fs.writeFileSync(file, data);
    let downloads = 0;
    const result = await ensureVerifiedBinary({
      filename: file, url: 'https://example.invalid/yt-dlp', expectedSha256: sha256(data),
      get: async () => { downloads++; throw new Error('Offline'); },
    });
    assert.equal(result, 'cached');
    assert.equal(downloads, 0);
    assert.equal(isVerifiedFile(file, sha256(data)), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a binary is installed only after both archive and executable hashes pass', async () => {
  const { sha256, ensureVerifiedBinary } = await binaries;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeckclips-install-'));
  const finalPath = path.join(root, 'tools', 'ffmpeg');
  const archive = Buffer.from('fake-archive');
  const binary = Buffer.from('fake-binary');
  const config = {
    filename: finalPath, url: 'https://example.invalid/ffmpeg.gz',
    expectedSha256: sha256(binary), archiveSha256: sha256(archive),
    get: async () => archive, extract: () => binary,
  };
  try {
    await assert.rejects(ensureVerifiedBinary({ ...config, archiveSha256: sha256('wrong') }), /Checksum del archivo comprimido/);
    assert.equal(fs.existsSync(finalPath), false);
    await assert.rejects(ensureVerifiedBinary({ ...config, expectedSha256: sha256('wrong') }), /Checksum de ejecutable/);
    assert.equal(fs.existsSync(finalPath), false);
    assert.equal(await ensureVerifiedBinary(config), 'downloaded');
    assert.deepEqual(fs.readFileSync(finalPath), binary);
    assert.deepEqual(fs.readdirSync(path.dirname(finalPath)), ['ffmpeg']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt cached executable is replaced by a verified download', async () => {
  const { sha256, ensureVerifiedBinary } = await binaries;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeckclips-corrupt-'));
  try {
    const file = path.join(root, 'yt-dlp');
    fs.writeFileSync(file, 'corrupt');
    const valid = Buffer.from('new verified executable');
    assert.equal(await ensureVerifiedBinary({
      filename: file, url: 'https://example.invalid/', expectedSha256: sha256(valid),
      get: async () => valid,
    }), 'downloaded');
    assert.deepEqual(fs.readFileSync(file), valid);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bounded HTTP download rejects oversized headers and chunked responses', async t => {
  const { getBounded } = await binaries;
  const server = http.createServer((req, res) => {
    if (req.url === '/length') {
      res.writeHead(200, { 'Content-Length': '1000000' });
      res.end();
    } else if (req.url === '/chunked') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.alloc(80));
      res.end(Buffer.alloc(80));
    } else if (req.url === '/gzip') {
      const archive = zlib.gzipSync(Buffer.from('hello'));
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Encoding': 'gzip',
        'Content-Length': archive.length,
      });
      res.end(archive);
    } else {
      res.end('small');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await getBounded(origin + '/small', { maxBytes: 10 }), Buffer.from('small'));
  // Content-Encoding: gzip must not be implicitly decompressed before hashing.
  assert.deepEqual(await getBounded(origin + '/gzip'), zlib.gzipSync(Buffer.from('hello')));
  await assert.rejects(getBounded(origin + '/length', { maxBytes: 10 }), /demasiado grande/);
  await assert.rejects(getBounded(origin + '/chunked', { maxBytes: 100 }), /demasiado grande/);
});

test('binary downloader uses a pinned upstream release, not a mutable latest URL', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fetch-bins.mjs'), 'utf8');
  assert.match(source, /yt-dlp\/releases\/download\/2026\.10\.26/);
  assert.doesNotMatch(source, /yt-dlp\/releases\/latest/);
  assert.match(source, /ensureVerifiedBinary\(/);
});

test('every pinned asset hash is a complete SHA-256 digest', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fetch-bins.mjs'), 'utf8');
  const ffBlock = source.split('const FFMPEG_SHA256 = {')[1]?.split('};')[0];
  const ytBlock = source.split('const YTDLP_SHA256 = {')[1]?.split('};')[0];
  assert.ok(ffBlock && ytBlock);
  const ffEntries = [...ffBlock.matchAll(/'([a-z0-9-]+)':\s*\[\s*'([a-f\d]+)',\s*'([a-f\d]+)'/g)];
  const ytEntries = [...ytBlock.matchAll(/'([^']+)':\s*'([a-f\d]+)'/g)];
  assert.equal(ffEntries.length, 5);
  assert.equal(ytEntries.length, 4);
  for (const [, target, compressed, binary] of ffEntries) {
    assert.match(compressed, /^[a-f\d]{64}$/, `${target} compressed checksum`);
    assert.match(binary, /^[a-f\d]{64}$/, `${target} executable checksum`);
  }
  for (const [, target, digest] of ytEntries) {
    assert.match(digest, /^[a-f\d]{64}$/, `${target} yt-dlp checksum`);
  }
  assert.ok(ffBlock.includes('bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa'));
});
