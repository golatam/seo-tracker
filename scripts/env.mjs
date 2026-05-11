/**
 * .env loader (zero dependencies).
 * Reads KEY=VALUE pairs from .env in project root.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

export function loadEnv() {
  const envPath = resolve(PROJECT_ROOT, '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — rely on env vars set externally
  }
}

export function requireEnv(key, description) {
  const value = process.env[key];
  if (!value) {
    const msg = `Variable ${key} is not set.${description ? ` ${description}.` : ''} Copy seo-tracking/.env.example -> .env and fill in the values.`;
    throw new Error(msg);
  }
  return value;
}
