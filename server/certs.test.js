import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { certificateProblem, generateCertificate, loadOrCreateCertificates } from './certs.js';

const EXPIRED = fs.readFileSync(new URL('./__fixtures__/expired-no-san-cert.pem', import.meta.url), 'utf8');

describe('certificateProblem', () => {
  it('flags the expired, SAN-less certificate that used to ship in the repo', () => {
    expect(certificateProblem(EXPIRED)).toMatch(/^expired/);
    expect(certificateProblem(EXPIRED, new Date('2021-03-01'))).toMatch(/subjectAltName/);
  });

  it('flags unreadable input', () => {
    expect(certificateProblem('not a cert')).toBe('unreadable');
  });
});

describe('certificate generation', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planets-certs-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('generates a valid localhost certificate with SANs', async () => {
    const { cert, key } = await generateCertificate({ days: 30 });
    expect(key).toContain('PRIVATE KEY');
    const x509 = new X509Certificate(cert);
    expect(x509.checkHost('localhost')).toBe('localhost');
    expect(x509.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(certificateProblem(cert)).toBeNull();
  }, 30_000);

  it('creates certificates when missing and reuses them afterwards', async () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const first = await loadOrCreateCertificates(dir, { logger });
    expect(first.generated).toBe(true);
    expect(fs.existsSync(path.join(dir, 'cert.pem'))).toBe(true);
    const second = await loadOrCreateCertificates(dir, { logger });
    expect(second.generated).toBe(false);
    expect(second.cert).toBe(first.cert);
  }, 30_000);

  it('replaces an expired certificate', async () => {
    fs.writeFileSync(path.join(dir, 'cert.pem'), EXPIRED);
    fs.writeFileSync(path.join(dir, 'key.pem'), 'old');
    const logger = { log: vi.fn(), warn: vi.fn() };
    const result = await loadOrCreateCertificates(dir, { logger });
    expect(result.generated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(certificateProblem(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'))).toBeNull();
  }, 30_000);
});
