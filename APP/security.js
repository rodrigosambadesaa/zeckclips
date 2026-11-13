'use strict';

// Shared network boundaries for the loopback-only Electron backend.
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_URL_LENGTH = 4096;
const MAX_REDIRECTS = 5;
const MAX_URL_PORTS = new Set(['', '80', '443']);

const blockedIPv4 = new net.BlockList();
for (const [base, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedIPv4.addSubnet(base, bits, 'ipv4');
const globalIPv6 = new net.BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new net.BlockList();
for (const [base, bits] of [
  ['2001::', 32], // Teredo and IPv6 tunnelling
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 tunnelling
]) blockedIPv6.addSubnet(base, bits, 'ipv6');

function isPublicAddress(address) {
  const ip = net.isIP(address);
  if (ip === 4) return !blockedIPv4.check(address, 'ipv4');
  if (ip === 6) return globalIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
  return false;
}

function validatePublicUrl(input) {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH) throw new Error('URL demasiado larga o no válida');
  let url;
  try { url = new URL(input); } catch { throw new Error('URL no válida'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Solo se permiten URLs HTTP o HTTPS');
  if (url.username || url.password) throw new Error('No se permiten credenciales en las URLs');
  if (!MAX_URL_PORTS.has(url.port)) throw new Error('Puerto externo no permitido');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
    /(?:^|\.)(?:local|internal|test|invalid|example|onion)$/.test(hostname)) {
    throw new Error('No se permiten servidores locales o internos');
  }
  if (net.isIP(hostname) && !isPublicAddress(hostname)) throw new Error('No se permiten direcciones IP privadas, locales o reservadas');
  return url;
}

// DNS validation happens at socket connection time, preventing a separate
// validation lookup followed by an unchecked (rebindable) DNS lookup.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses?.length || addresses.some(a => !isPublicAddress(a.address))) {
      return callback(new Error('El dominio apunta a una dirección no pública'));
    }
    const selected = addresses.find(a => !options.family || a.family === options.family);
    if (!selected) return callback(new Error('Sin direcciones públicas para la familia de red solicitada'));
    return callback(null, selected.address, selected.family);
  });
}

async function requestPublic(input, method = 'GET', hops = 0) {
  const url = validatePublicUrl(input);
  if (hops > MAX_REDIRECTS) throw new Error('Demasiadas redirecciones');
  const response = await new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method, lookup: safeLookup,
      headers: { 'User-Agent': 'ZeckClips/1.0', Accept: 'video/*, application/octet-stream, */*' },
      timeout: 20000,
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('Se agotó el tiempo de conexión')));
    req.on('error', reject);
    req.end();
  });
  const status = response.statusCode || 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    const next = response.headers.location;
    response.resume();
    if (!next) throw new Error('Redirección sin destino');
    return requestPublic(new URL(next, url).href, method, hops + 1);
  }
  response.setTimeout(30000, () => response.destroy(new Error('Se agotó el tiempo de descarga')));
  return response;
}

async function writeLimited(readable, destination, max = MAX_VIDEO_BYTES) {
  const expected = Number(readable.headers?.['content-length']);
  if (Number.isFinite(expected) && expected > max) {
    readable.destroy();
    const e = new Error('Vídeo demasiado grande (máximo 2 GiB)');
    e.statusCode = 413;
    throw e;
  }
  let total = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > max) {
        const e = new Error('Vídeo demasiado grande (máximo 2 GiB)');
        e.statusCode = 413;
        callback(e);
      } else callback(null, chunk);
    },
  });
  await pipeline(readable, limiter, fs.createWriteStream(destination));
}

const VIDEO_SITES = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'twitch.tv',
  'tiktok.com', 'kick.com', 'vimeo.com', 'dailymotion.com',
  'instagram.com', 'facebook.com', 'fb.watch', 'x.com',
  'twitter.com', 'reddit.com', 'streamable.com',
];
function isSupportedVideoSite(url) {
  const host = url.hostname.toLowerCase();
  return VIDEO_SITES.some(site => host === site || host.endsWith('.' + site));
}

function denyLocalRequest(req) {
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') return 'Conexión no local';
  const port = req.socket.localPort;
  const host = (req.headers.host || '').toLowerCase();
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return 'Host no permitido';
  if (req.headers.origin && req.headers.origin !== 'http://' + host) return 'Origen no permitido';
  return null;
}

function denyApiRequest(req) {
  if (req.headers['x-zeckclips-request'] !== '1') return 'Falta la cabecera de autenticidad de la aplicación';
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
    return 'Solicitud desde otro sitio web';
  }
  return null;
}

module.exports = {
  MAX_VIDEO_BYTES, isPublicAddress, validatePublicUrl, requestPublic,
  writeLimited, isSupportedVideoSite, denyLocalRequest, denyApiRequest,
};
