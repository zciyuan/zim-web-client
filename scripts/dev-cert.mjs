#!/usr/bin/env node
// Regenerates certs/dev-key.pem + certs/dev-cert.pem for HTTPS dev serving.
//
// WebRTC calls and PWA install need a secure context, so the LAN address has to
// be served over TLS. A self-signed certificate is fine for that (the browser
// only needs to accept it once), but its SAN list must contain this machine's
// current LAN address — re-run this script whenever the address changes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const opensslCandidates = [
  process.env.OPENSSL,
  'C:/Program Files/Git/usr/bin/openssl.exe',
  'C:/Program Files/Git/mingw64/bin/openssl.exe',
  'C:/Program Files/OpenSSL-Win64/bin/openssl.exe',
  '/usr/bin/openssl',
  '/usr/local/bin/openssl',
  'openssl',
].filter(Boolean);

const openssl = opensslCandidates.find((candidate) => {
  if (candidate === 'openssl') {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return existsSync(candidate);
});

if (!openssl) {
  console.error('openssl not found. Install Git for Windows (ships openssl) or set OPENSSL=/path/to/openssl.');
  process.exit(1);
}

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
  .map((entry) => entry.address);

const sanLines = ['DNS.1 = localhost', 'IP.1 = 127.0.0.1', ...addresses.map((ip, index) => `IP.${index + 2} = ${ip}`)];

const config = `[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ZIM Dev

[v3_req]
subjectAltName = @alt_names
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
${sanLines.join('\n')}
`;

const dir = path.resolve('certs');
mkdirSync(dir, { recursive: true });
const configPath = path.join(dir, 'openssl.cnf');
writeFileSync(configPath, config, 'utf8');

execFileSync(openssl, [
  'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '730',
  '-keyout', path.join(dir, 'dev-key.pem'),
  '-out', path.join(dir, 'dev-cert.pem'),
  '-config', configPath,
], { stdio: 'inherit' });

console.log(`\ncertificate written for: localhost, 127.0.0.1${addresses.map((ip) => `, ${ip}`).join('')}`);
console.log('serve with:  ZIM_HTTPS=1 npx vite   (https://<address>:5280)');
