import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.NEXADESK_DATA_DIR
  ? path.resolve(process.env.NEXADESK_DATA_DIR)
  : path.join(ROOT, 'data');
export const SESSION_DIR = path.join(DATA_DIR, 'sessions');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const PORT = Number(process.env.PORT || 8787);
export const IS_PROD = process.env.NODE_ENV === 'production';

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
