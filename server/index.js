import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { PORT, IS_PROD, ROOT } from './config.js';
import { Store } from './store.js';
import { WhatsAppManager } from './wa.js';
import { BotEngine } from './bot.js';
import { Auth } from './auth.js';
import { Presence } from './presence.js';
import { createApiRouter } from './routes.js';

const store = new Store();
const wa = new WhatsAppManager(store);
const bot = new BotEngine({ manager: wa, store });
const auth = new Auth(store);

if (process.env.GEMINI_API_KEY && !store.data.settings.geminiApiKey) {
  store.data.settings.geminiApiKey = process.env.GEMINI_API_KEY.trim();
  store.save();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const presence = new Presence(io, store);

const accountRoom = (accountId) => `acct:${accountId}`;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use('/api', createApiRouter({ store, wa, auth, presence }));

const distDir = path.join(ROOT, 'dist');
const indexFile = path.join(distDir, 'index.html');
if (fs.existsSync(indexFile)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(indexFile);
  });
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status) || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: err.message || 'Terjadi kesalahan pada server.' });
});

io.use((socket, next) => {
  const user = auth.userFromCookieHeader(socket.request.headers.cookie);
  if (!user) {
    next(new Error('unauthorized'));
    return;
  }
  socket.data.user = {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
  };
  socket.data.accounts = store.data.accounts
    .filter((account) => auth.canAccessAccount(user, account.id))
    .map((account) => account.id);
  next();
});

io.on('connection', (socket) => {
  for (const accountId of socket.data.accounts || []) socket.join(accountRoom(accountId));
  presence.add(socket);
  socket.emit('hello', { at: Date.now() });
  socket.on('disconnect', () => presence.remove(socket));
});

const forward = (event) => (payload) => io.emit(event, payload);

// Peristiwa yang terikat satu akun hanya dikirim ke agen yang boleh memakai akun itu.
const forwardScoped = (event) => (payload) => {
  const accountId = String(payload?.accountId || '');
  if (!accountId) io.emit(event, payload);
  else io.to(accountRoom(accountId)).emit(event, payload);
};

wa.on('sync', forwardScoped('sync'));
wa.on('qr', forwardScoped('qr'));
wa.on('notify', forward('notify'));
wa.on('incoming', (payload) => {
  bot.handleIncoming(payload).catch((err) => console.warn('[bot]', err.message));
});

function accessUrls(host) {
  const suffix = IS_PROD ? '' : ' (mode dev)';
  if (!host) return [`http://localhost:${PORT}${suffix}`];
  if (host !== '0.0.0.0') return [`http://${host}:${PORT}${suffix}`];
  const urls = [`http://localhost:${PORT}${suffix}`];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${PORT}${suffix}`);
    }
  }
  return urls;
}

export function startServer() {
  return new Promise((resolve, reject) => {
    const host = process.env.HOST || '';
    const onListening = () => {
      server.removeListener('error', reject);
      for (const url of accessUrls(host)) console.log(`NexaDesk API berjalan di ${url}`);
      wa.restore().catch((err) => console.warn('[wa] restore gagal:', err.message));
      resolve(server);
    };
    server.once('error', reject);
    if (host) server.listen(PORT, host, onListening);
    else server.listen(PORT, onListening);
  });
}

let shuttingDown = false;
export function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  store.flush();
  for (const session of wa.sessions.values()) {
    try {
      session.closing = true;
      session.sock.end(undefined);
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

export { app, server, wa, store, bot, auth, presence };

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  startServer().catch((err) => {
    console.error('[api] gagal start:', err.message);
    process.exit(1);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
