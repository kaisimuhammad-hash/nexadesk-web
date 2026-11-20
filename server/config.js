import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isServerless = !!(
  process.env.NETLIFY ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.VERCEL ||
  process.env.FUNCTIONS_EMULATOR
);

export const DATA_DIR = process.env.NEXADESK_DATA_DIR
  ? path.resolve(process.env.NEXADESK_DATA_DIR)
  : (isServerless ? path.join('/tmp', 'nexadesk_data') : path.join(ROOT, 'data'));

export const SESSION_DIR = path.join(DATA_DIR, 'sessions');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const PORT = Number(process.env.PORT || 8787);
export const IS_PROD = process.env.NODE_ENV === 'production';

try {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
} catch (err) {
  console.warn('[config] Gagal membuat folder data:', err.message);
}
