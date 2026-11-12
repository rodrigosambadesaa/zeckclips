'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { Readable } = require('node:stream');
const {
  MAX_VIDEO_BYTES, isPublicAddress, validatePublicUrl, writeLimited,
  isSupportedVideoSite,
} = require('../security');
const { createServer, listen } = require('../server');

test('only public IP addresses pass validation', () => {
  for (const ip of ['127.0.0.1', '10.10.10.10', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '192.0.2.1', '::1',
    '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('private, special and credentialed URLs are rejected', () => {
  const rejected = [
    'file:///etc/passwd', 'http://127.0.0.1/', 'http://2130706433/',
    'http://[::1]/', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://localhost/', 'https://sub.localhost/', 'https://router.local/',
    'https://host.internal/', 'https://u:p@example.org/',
    'http://example.org:8080/', 'javascript:alert(1)',
  ];
  for (const url of rejected) assert.throws(() => validatePublicUrl(url), Error, url);
  assert.equal(validatePublicUrl('https://www.youtube.com/watch?v=123').hostname, 'www.youtube.com');
  assert.equal(validatePublicUrl('https://1.1.1.1/video.mp4').hostname, '1.1.1.1');
  assert.equal(MAX_VIDEO_BYTES, 2 * 1024 ** 3);
});

test('only exact or real subdomains of supported video hosts are accepted', () => {
  assert.equal(isSupportedVideoSite(validatePublicUrl('https://m.youtube.com/watch?v=x')), true);
  assert.equal(isSupportedVideoSite(validatePublicUrl('https://youtube.com.evil.com/')), false);
  assert.equal(isSupportedVideoSite(validatePublicUrl('https://notyoutube.com/')), false);
});

test('streaming upload limit rejects oversized bodies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeckclips-test-'));
  try {
    const dest = path.join(dir, 'small.webm');
    await writeLimited(Readable.from([Buffer.from('abc')]), dest, 4);
    assert.equal(fs.readFileSync(dest).toString(), 'abc');
    await assert.rejects(writeLimited(Readable.from([Buffer.alloc(5)]), path.join(dir, 'large.webm'), 4), /demasiado grande/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loopback API and static route reject untrusted browser requests', async t => {
  const server = createServer({
    root: path.join(__dirname, '..', 'app'),
    binDir: path.join(__dirname, 'absent-binaries'),
  });
  const port = await listen(server, 0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + port;
  const api = { 'X-ZeckClips-Request': '1' };

  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /ZeckClips/);
  assert.equal((await fetch(base + '/api/status')).status, 403);
  assert.equal((await fetch(base + '/api/status', { headers: api })).status, 200);
  assert.equal((await fetch(base + '/api/status', {
    headers: { ...api, Origin: 'https://attacker.example' },
  })).status, 403);
  assert.equal((await fetch(base + '/api/status', {
    headers: { ...api, 'Sec-Fetch-Site': 'cross-site' },
  })).status, 403);
  // fetch() normalizes Host; a raw Node HTTP request preserves a spoofed Host header.
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/status', {
      headers: { ...api, Host: 'attacker.example:' + port },
    }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(base + '/api/download?url=' +
    encodeURIComponent('http://169.254.169.254/latest/meta-data/'), { headers: api })).status, 400);
  assert.equal((await fetch(base + '/api/download?url=' +
    encodeURIComponent('http://127.0.0.1:80/'), { headers: api })).status, 400);
  assert.equal((await fetch(base + '/..%2f..%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/api/unknown', { headers: api })).status, 405);
});

test('untrusted uploaded filenames never flow into innerHTML', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.match(html, /label\.textContent = f\.name/);
  assert.doesNotMatch(html, /innerHTML\s*=[^\n]*f\.name/);
});
