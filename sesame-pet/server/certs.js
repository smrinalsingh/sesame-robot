// Self-signed HTTPS certificate for the LAN. Phones only allow the microphone
// on https pages, so the phone page is served over https with this cert
// (accept the browser warning once). Regenerated when the LAN address changes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export function ensureCert(dir) {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const sansFile = join(dir, 'sans.txt');
  const ips = [...lanAddresses(), '127.0.0.1'];
  const sans = [...ips.map((ip) => `IP:${ip}`), 'DNS:localhost'].join(',');
  if (!existsSync(key) || !existsSync(cert) || !existsSync(sansFile) || readFileSync(sansFile, 'utf8') !== sans) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-sha256',
      '-subj', '/CN=sesame-pet', '-addext', `subjectAltName=${sans}`,
      '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
    writeFileSync(sansFile, sans);
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
