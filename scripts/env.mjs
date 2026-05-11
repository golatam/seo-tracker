/**
 * .env loader (zero dependencies).
 * Reads KEY=VALUE pairs from .env in the current working directory
 * (the consumer repo root, both locally and on CI).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv() {
  const envPath = resolve(process.cwd(), '.env');
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
    const msg = `Variable ${key} is not set.${description ? ` ${description}.` : ''} See .env.example for required variables.`;
    throw new Error(msg);
  }
  return value;
}
