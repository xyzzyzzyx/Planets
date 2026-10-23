/**
 * Development TLS certificates. Loads `certs/cert.pem` + `certs/key.pem`,
 * regenerating a self-signed localhost certificate (with SANs, as modern
 * browsers require) when they are missing, expired or lack a SAN.
 */
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const silentLogger = { info() { }, warn() { }, log() { }, error() { } };

/** Why an existing certificate must be replaced, or null if it is usable. */
export function certificateProblem(certPem, now = new Date()) {
  let cert;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return 'unreadable';
  }
  if (new Date(cert.validTo) <= now) return `expired ${cert.validTo}`;
  if (new Date(cert.validFrom) > now) return `not valid until ${cert.validFrom}`;
  if (!cert.subjectAltName || !cert.checkHost('localhost')) return 'missing subjectAltName for localhost';
  return null;
}

export async function generateCertificate({ days = 825 } = {}) {
  const { generate } = await import('selfsigned');
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + days * 86_400_000);
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  });
  return { cert: pems.cert, key: pems.private };
}

export async function loadOrCreateCertificates(certDir, { logger = silentLogger, force = false } = {}) {
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');

  if (!force && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cert = fs.readFileSync(certPath, 'utf8');
    const problem = certificateProblem(cert);
    if (!problem) return { cert, key: fs.readFileSync(keyPath, 'utf8'), generated: false };
    logger.warn(`[certs] Existing certificate is unusable (${problem}); generating a new one.`);
  }

  const pems = await generateCertificate();
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.key, { mode: 0o600 });
  logger.log(`[certs] Wrote self-signed localhost certificate to ${certDir}`);
  return { ...pems, generated: true };
}
