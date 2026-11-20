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
  try {
    return await handlerFn(event, context);
  } catch (err) {
    console.error('[netlify:handler] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Internal Server Error' }),
    };
  }
};
