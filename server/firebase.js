import { onRequest } from 'firebase-functions/v2/https';
import { app, wa } from './index.js';

let restored = false;

export const api = onRequest(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 300,
    memory: '1GiB',
    minInstances: 1,
  },
  async (req, res) => {
    if (!restored) {
      restored = true;
      try {
        await wa.restore();
      } catch (err) {
        console.warn('[firebase:wa] Restore gagal:', err.message);
      }
    }
    return app(req, res);
  },
);
