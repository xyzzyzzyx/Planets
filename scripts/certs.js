#!/usr/bin/env node
/** Regenerate the self-signed localhost TLS certificate used by the dev server. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateCertificates } from '../server/certs.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await loadOrCreateCertificates(path.join(root, 'certs'), { force: process.argv.includes('--force'), logger: console });
