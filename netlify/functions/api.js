import serverless from 'serverless-http';
import { app, wa } from '../../server/index.js';

let restored = false;

const handlerFn = serverless(app);

export const handler = async (event, context) => {
  if (!restored) {
    restored = true;
    try {
      await wa.restore();
    } catch (err) {
      console.warn('[netlify:wa] Restore gagal:', err.message);
    }
  }
  return handlerFn(event, context);
};
