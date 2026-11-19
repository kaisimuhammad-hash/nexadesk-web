import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { HttpError } from './errors.js';
import { MEDIA_DIR } from './config.js';
import { generateReply, GEMINI_MODELS } from './gemini.js';
import {
  publicUser,
  validateAccountIds,
  validateName,
  validateRole,
  verifyPassword,
} from './auth.js';

const TICKET_STATUSES = ['open', 'pending', 'resolved'];
const PRIORITIES = ['low', 'normal', 'high'];
const CHAT_MODES = ['inherit', 'bot', 'manual'];
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Batas ukuran dicek dari header supaya respons 413 bisa terkirim sebelum body mengalir.
function assertSizeAllowed(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `Gambar maksimal ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }
}

// Unggahan gambar dikirim sebagai body mentah, jadi dibaca manual dengan batas ukuran.
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // Sisa body dibuang, bukan diputus, supaya klien tetap menerima kode statusnya.
      req.resume();
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new HttpError(413, `Gambar maksimal ${Math.floor(maxBytes / 1024 / 1024)} MB.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => fail(new HttpError(400, 'Upload gambar terputus.')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function publicChat(chat, account) {
  const effectiveMode =
    chat.modeOverride === 'bot' || chat.modeOverride === 'manual'
      ? chat.modeOverride
      : account?.mode === 'manual'
        ? 'manual'
        : 'bot';
  return {
    id: chat.id,
    accountId: chat.accountId,
    waJid: chat.waJid,
    name: chat.name,
    isGroup: !!chat.isGroup,
    lastPreview: chat.lastPreview || '',
    lastMessageAt: chat.lastMessageAt,
    unread: chat.unread || 0,
    modeOverride: chat.modeOverride || 'inherit',
    nameLocked: !!chat.nameLocked,
    effectiveMode,
  };
}

export function createApiRouter({ store, wa, auth, presence }) {
  const router = express.Router();
  const sync = (payload = {}) => wa.emit('sync', { reason: 'api', ...payload });
  const adminOnly = auth.requireAdmin;
  const allowedAccountIds = (user) =>
    store.data.accounts.filter((a) => auth.canAccessAccount(user, a.id)).map((a) => a.id);
  const guardAccount = (user, accountId) => {
    if (!auth.canAccessAccount(user, accountId)) {
      throw new HttpError(403, 'Anda tidak punya akses ke akun WhatsApp ini.');
    }
  };
  const chatOf = (user, id) => {
    const chat = store.chat(String(id));
    if (!chat) throw new HttpError(404, 'Percakapan tidak ditemukan.');
    guardAccount(user, chat.accountId);
    return chat;
  };
  const messageOf = (user, id) => {
    const message = store.message(String(id));
    if (!message) throw new HttpError(404, 'Pesan tidak ditemukan.');
    guardAccount(user, message.accountId);
    return message;
  };
  const replyTargetFor = (chat, messageId) => {
    if (!messageId) return null;
    const target = store.message(String(messageId));
    if (!target || target.chatId !== chat.id) {
      throw new HttpError(400, 'Pesan yang dibalas tidak ada di chat ini.');
    }
    return target;
  };

  router.get('/health', (req, res) => res.json({ ok: true, at: Date.now() }));

  router.get('/auth/status', (req, res) => {
    const user = auth.userFromRequest(req);
    res.json({ needsSetup: auth.needsSetup(), user: user ? publicUser(user) : null });
  });

  router.post(
    '/auth/setup',
    ah(async (req, res) => {
      if (!auth.needsSetup()) throw new HttpError(400, 'Admin pertama sudah dibuat.');
      const { name, username, password } = req.body || {};
      const user = auth.createUser({ name, username, password, role: 'admin' });
      auth.setSessionCookie(req, res, user);
      store.addActivity('user', `Admin ${user.name} dibuat.`, { userId: user.id });
      res.status(201).json({ ok: true, user: publicUser(user) });
    }),
  );

  router.post(
    '/auth/login',
    ah(async (req, res) => {
      const { username, password } = req.body || {};
      const user = auth.login(username, password, req.ip);
      auth.setSessionCookie(req, res, user);
      store.addActivity('user', `${user.name} masuk ke dashboard.`, { userId: user.id });
      res.json({ ok: true, user: publicUser(user) });
    }),
  );

  router.post('/auth/logout', (req, res) => {
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.use(auth.requireAuth);

  router.get('/auth/me', (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  router.post(
    '/auth/password',
    ah(async (req, res) => {
      const { currentPassword, newPassword } = req.body || {};
      if (!verifyPassword(req.user, currentPassword)) {
        throw new HttpError(400, 'Password saat ini salah.');
      }
      auth.setPassword(req.user, newPassword);
      auth.setSessionCookie(req, res, req.user);
      store.addActivity('user', `${req.user.name} mengubah password.`, { userId: req.user.id });
      res.json({ ok: true });
    }),
  );

  router.get('/users', adminOnly, (req, res) => {
    const users = [...store.data.users]
      .map(publicUser)
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));
    res.json({
      users,
      online: presence.list(),
      meId: req.user.id,
      accounts: store.data.accounts.map((a) => ({ id: a.id, label: a.label, status: a.status })),
    });
  });

  router.post(
    '/users',
    adminOnly,
    ah(async (req, res) => {
      const { name, username, password, role, accounts } = req.body || {};
      const user = auth.createUser({
        name,
        username,
        password,
        role,
        accounts: validateAccountIds(
          accounts,
          store.data.accounts.map((a) => a.id),
        ),
      });
      store.addActivity('user', `Pengguna ${user.name} (${user.role === 'admin' ? 'Admin' : 'Agen'}) ditambahkan.`, {
        userId: user.id,
      });
      presence.broadcast();
      res.status(201).json({ ok: true, user: publicUser(user) });
    }),
  );

  router.patch(
    '/users/:id',
    adminOnly,
    ah(async (req, res) => {
      const target = auth.findById(req.params.id);
      if (!target) throw new HttpError(404, 'Pengguna tidak ditemukan.');
      const body = req.body || {};
      const patch = {};
      if (body.name !== undefined) patch.name = validateName(body.name);
      if (body.role !== undefined) patch.role = validateRole(body.role);
      if (body.active !== undefined) patch.active = !!body.active;
      if (body.accounts !== undefined) {
        patch.accounts = validateAccountIds(body.accounts, store.data.accounts.map((a) => a.id));
      }

      const nextRole = patch.role ?? target.role;
      const nextActive = patch.active ?? target.active !== false;
      if (target.id === req.user.id && (nextRole !== 'admin' || !nextActive)) {
        throw new HttpError(400, 'Anda tidak dapat menurunkan atau menonaktifkan akun sendiri.');
      }
      if (
        target.role === 'admin' &&
        target.active !== false &&
        (nextRole !== 'admin' || !nextActive) &&
        auth.activeAdminCount(target.id) === 0
      ) {
        throw new HttpError(400, 'Minimal satu admin aktif harus tersedia.');
      }

      const accountsChanged =
        patch.accounts !== undefined &&
        (target.accounts || []).join('|') !== patch.accounts.join('|');

      Object.assign(target, patch, { updatedAt: Date.now() });
      if (!nextActive) target.sessionVersion = (target.sessionVersion || 1) + 1;
      if (!nextActive || (accountsChanged && target.id !== req.user.id)) {
        // Socket diputus agar agen menyambung ulang dengan daftar akun yang baru.
        presence.disconnectUser(target.id);
      }
      store.save();
      const label = nextRole === 'admin' ? 'Admin' : 'Agen';
      store.addActivity(
        'user',
        nextActive
          ? `${target.name} diperbarui menjadi ${label}.`
          : `${target.name} dinonaktifkan.`,
        { userId: target.id },
      );
      presence.broadcast();
      res.json({ ok: true, user: publicUser(target) });
    }),
  );

  router.post(
    '/users/:id/password',
    adminOnly,
    ah(async (req, res) => {
      const target = auth.findById(req.params.id);
      if (!target) throw new HttpError(404, 'Pengguna tidak ditemukan.');
      auth.setPassword(target, req.body?.password);
      if (target.id === req.user.id) {
        auth.setSessionCookie(req, res, target);
      } else {
        presence.disconnectUser(target.id);
      }
      store.addActivity('user', `Password ${target.name} direset oleh admin.`, { userId: target.id });
      res.json({ ok: true });
    }),
  );

  router.get(
    '/state',
    ah(async (req, res) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStart = today.getTime();

      const daily = [];
      for (let i = 13; i >= 0; i -= 1) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        daily.push({ date: dateKey(d), count: 0 });
      }
      const dailyIndex = new Map(daily.map((d) => [d.date, d]));
      let messagesToday = 0;
      let aiToday = 0;

      const mine = new Set(allowedAccountIds(req.user));

      for (const m of store.data.messages) {
        if (!mine.has(m.accountId)) continue;
        if (m.createdAt >= todayStart && !m.deleted) {
          messagesToday += 1;
          if (m.aiGenerated) aiToday += 1;
        }
        const bucket = dailyIndex.get(dateKey(new Date(m.createdAt)));
        if (bucket) bucket.count += 1;
      }

      const accounts = store.data.accounts
        .filter((a) => mine.has(a.id))
        .map((a) => ({
          ...a,
          qr: wa.qrFor(a.id),
          ...wa.sessionInfo(a.id),
        }));

      const chats = store.data.chats
        .filter((c) => mine.has(c.accountId))
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
        .slice(0, 300)
        .map((c) => publicChat(c, store.account(c.accountId)));

      const tickets = store.data.tickets
        .filter((t) => mine.has(t.accountId))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      const activity = store.data.activity
        .filter((item) => !item.meta?.accountId || mine.has(item.meta.accountId))
        .slice(0, 30);

      res.json({
        accounts,
        chats,
        tickets,
        activity,
        settings: store.publicSettings(),
        me: publicUser(req.user),
        online: presence.list(),
        models: GEMINI_MODELS,
        stats: {
          accounts: accounts.length,
          connected: accounts.filter((a) => a.status === 'connected').length,
          chats: chats.length,
          unread: chats.reduce((sum, c) => sum + c.unread, 0),
          openTickets: tickets.filter((t) => t.status !== 'resolved').length,
          messagesToday,
          aiToday,
          daily,
        },
        serverTime: Date.now(),
      });
    }),
  );

  router.get(
    '/media/:file',
    ah(async (req, res) => {
      const name = path.basename(String(req.params.file || ''));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new HttpError(400, 'Nama media tidak valid.');
      const full = path.join(MEDIA_DIR, name);
      if (!fs.existsSync(full)) throw new HttpError(404, 'Media tidak ditemukan.');
      if (req.user.role !== 'admin') {
        const owner = store.data.messages.find(
          (m) => m.mediaUrl === `/api/media/${name}` || m.mediaUrl === name,
        );
        if (!owner) throw new HttpError(404, 'Media tidak ditemukan.');
        guardAccount(req.user, owner.accountId);
      }
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('Vary', 'Cookie');
      res.sendFile(full);
    }),
  );

  router.get(
    '/chats/:id/messages',
    ah(async (req, res) => {
      const chat = chatOf(req.user, req.params.id);
      const limit = Math.min(Math.max(Number(req.query.limit) || 300, 20), 500);
      const before = typeof req.query.before === 'string' ? req.query.before : null;
      const account = store.account(chat.accountId);
      const page = store.messagesPage(chat.id, { before, limit });
      const messages = page.messages.map((m) => ({
        id: m.id,
        chatId: m.chatId,
        accountId: m.accountId,
        fromMe: m.fromMe,
        senderKey: store.senderKeyFor(m, chat),
        senderName: store.senderNameFor(chat.id, store.senderKeyFor(m, chat)) || m.senderName,
        senderNameLocked: !!store.senderNameFor(chat.id, store.senderKeyFor(m, chat)),
        text: m.text,
        mediaType: m.mediaType,
        mediaUrl: m.mediaUrl || null,
        hasUserText: m.hasUserText !== false,
        quotedText: m.quotedText || null,
        quotedFrom: m.quotedFrom || null,
        source: m.source,
        createdAt: m.createdAt,
        ack: m.ack || 0,
        deleted: !!m.deleted,
        revoked: !!m.revoked,
        aiGenerated: !!m.aiGenerated,
        hasWaId: !!m.waKey?.id,
        editedAt: m.editedAt || null,
      }));
      res.json({
        chat: publicChat(chat, account),
        account: account ? { id: account.id, label: account.label, status: account.status, mode: account.mode } : null,
        messages,
        hasMore: page.hasMore,
      });
    }),
  );

  router.post(
    '/chats/:id/send',
    ah(async (req, res) => {
      const chat = chatOf(req.user, req.params.id);
      const text = String(req.body?.text ?? '').trim();
      if (!text) throw new HttpError(400, 'Pesan tidak boleh kosong.');
      if (text.length > 4096) throw new HttpError(400, 'Pesan maksimal 4096 karakter.');
      const message = await wa.sendText(chat.accountId, chat, text, 'agent', {
        replyMessage: replyTargetFor(chat, req.body?.replyTo),
      });
      res.json({ ok: true, message: { id: message.id, createdAt: message.createdAt } });
    }),
  );

  router.post(
    '/chats/:id/media',
    ah(async (req, res) => {
      const chat = chatOf(req.user, req.params.id);
      const mimetype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(mimetype)) {
        throw new HttpError(400, 'Format gambar tidak didukung (JPEG, PNG, WebP, GIF).');
      }
      assertSizeAllowed(req, MAX_IMAGE_BYTES);
      const buffer = await readRawBody(req, MAX_IMAGE_BYTES);
      if (!buffer.length) throw new HttpError(400, 'File gambar kosong.');
      const caption = String(req.query.caption || '').trim().slice(0, 1024);
      const message = await wa.sendImage(chat.accountId, chat, {
        buffer,
        mimetype,
        caption,
        replyMessage: replyTargetFor(chat, req.query.replyTo),
      });
      res.json({
        ok: true,
        message: { id: message.id, createdAt: message.createdAt, mediaUrl: message.mediaUrl },
      });
    }),
  );

  router.delete(
    '/chats/:id',
    adminOnly,
    ah(async (req, res) => {
      const chat = chatOf(req.user, req.params.id);
      await wa.deleteChat(chat, { remote: !!req.body?.remote });
      res.json({ ok: true });
    }),
  );

  router.post(
    '/chats/:id/mode',
    ah(async (req, res) => {
      const chat = chatOf(req.user, req.params.id);
      const mode = String(req.body?.mode || '');
      if (!CHAT_MODES.includes(mode)) throw new HttpError(400, 'Mode tidak valid.');
      chat.modeOverride = mode;
      store.save();
      sync({ chatId: chat.id });
      res.json({ ok: true, chat: publicChat(chat, store.account(chat.accountId)) });
    }),
  );

  router.post(
    '/chats/:id/read',
    ah(async (req, res) => {
      const chat = chatOf(req.user, req.params.id);
      chat.unread = 0;
      store.save();
      sync({ chatId: chat.id });
      await wa.markRead(chat.accountId, chat);
      res.json({ ok: true });
    }),
  );

  router.get(
    '/chats',
    ah(async (req, res) => {
      const query = String(req.query.q || '').trim().toLowerCase();
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const mine = new Set(allowedAccountIds(req.user));
      const all = store.data.chats
        .filter((c) => mine.has(c.accountId))
        .map((c) => publicChat(c, store.account(c.accountId)));
      const matched = query
        ? all.filter(
            (c) =>
              String(c.name || '').toLowerCase().includes(query) ||
              String(c.waJid || '').toLowerCase().includes(query) ||
              String(c.lastPreview || '').toLowerCase().includes(query),
          )
        : all;
      matched.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
      res.json({ total: all.length, chats: matched.slice(0, limit) });
    }),
  );

  router.get(
    '/chats/:id/senders',
    ah(async (req, res) => {
      const chat = chatOf(req.user, req.params.id);
      const senders = store
        .groupSenders(chat.id)
        .map((s) => ({ ...s, custom: store.senderNameFor(chat.id, s.key) }));
      res.json({ chat: publicChat(chat, store.account(chat.accountId)), senders });
    }),
  );

  router.patch(
    '/chats/:id',
    ah(async (req, res) => {
      const chat = chatOf(req.user, req.params.id);
      const body = req.body || {};
      const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
      const hasSenders = Array.isArray(body.senders);
      if (!hasName && !hasSenders) throw new HttpError(400, 'Tidak ada yang diubah.');

      let name = null;
      if (hasName) {
        name = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!name) throw new HttpError(400, 'Nama kontak tidak boleh kosong.');
      }

      const previous = chat.name;
      if (name) store.renameChat(chat.id, name);

      let renamed = 0;
      for (const item of hasSenders ? body.senders.slice(0, 200) : []) {
        const key = String(item?.key || '').trim();
        if (!key) continue;
        const label = String(item?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (store.setSenderName(chat.id, key, label)) renamed += 1;
      }
      if (renamed) store.save();

      if (name && name !== previous) {
        store.addActivity('settings', `Nama kontak "${previous}" diubah menjadi "${name}".`, {
          chatId: chat.id,
        });
      }
      if (renamed) {
        store.addActivity('settings', `${renamed} nama pengirim di "${chat.name}" diperbarui.`, {
          chatId: chat.id,
        });
      }
      sync({ chatId: chat.id });
      res.json({
        ok: true,
        renamed,
        chat: publicChat(chat, store.account(chat.accountId)),
      });
    }),
  );

  router.post(
    '/chats/bulk-delete',
    adminOnly,
    ah(async (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [];
      if (!ids.length) throw new HttpError(400, 'Belum ada chat yang dipilih.');
      if (ids.length > 100) throw new HttpError(400, 'Maksimal 100 chat sekali hapus.');
      const remote = !!req.body?.remote;
      const deleted = [];
      const failed = [];
      for (const id of new Set(ids)) {
        const chat = store.chat(id);
        if (!chat) {
          failed.push({ id, error: 'Percakapan tidak ditemukan.' });
          continue;
        }
        try {
          await wa.deleteChat(chat, { remote });
          deleted.push(chat.id);
        } catch (err) {
          failed.push({ id: chat.id, error: err.message });
        }
      }
      store.addActivity(
        'settings',
        `${deleted.length} chat dihapus${remote ? ' termasuk dari WhatsApp' : ''}${
          failed.length ? `, ${failed.length} gagal` : ''
        }.`,
      );
      sync({});
      res.json({ ok: true, deleted: deleted.length, failed });
    }),
  );

  router.delete(
    '/messages/:id',
    adminOnly,
    ah(async (req, res) => {
      const message = messageOf(req.user, req.params.id);
      message.deleted = true;
      message.text = '';
      store.refreshChatPreview(message.chatId);
      sync({ chatId: message.chatId });
      res.json({ ok: true });
    }),
  );

  router.patch(
    '/messages/:id',
    ah(async (req, res) => {
      const message = messageOf(req.user, req.params.id);
      const text = String(req.body?.text ?? '').trim();
      if (!text) throw new HttpError(400, 'Pesan tidak boleh kosong.');
      if (text.length > 4096) throw new HttpError(400, 'Pesan maksimal 4096 karakter.');
      const updated = await wa.edit(message.accountId, message, text);
      res.json({ ok: true, message: { id: updated.id, text: updated.text, editedAt: updated.editedAt } });
    }),
  );

  router.post(
    '/messages/:id/revoke',
    adminOnly,
    ah(async (req, res) => {
      const message = messageOf(req.user, req.params.id);
      await wa.revoke(message.accountId, message);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/accounts/:id/connect',
    adminOnly,
    ah(async (req, res) => {
      const account = store.account(req.params.id);
      if (!account) throw new HttpError(404, 'Akun tidak ditemukan.');
      await wa.connect(account.id);
      store.addActivity('connect', `Menghubungkan ${account.label}…`, { accountId: account.id });
      sync({ accountId: account.id });
      res.json({ ok: true });
    }),
  );

  router.post(
    '/accounts/:id/logout',
    adminOnly,
    ah(async (req, res) => {
      const account = store.account(req.params.id);
      if (!account) throw new HttpError(404, 'Akun tidak ditemukan.');
      await wa.logout(account.id);
      res.json({ ok: true });
    }),
  );

  router.patch(
    '/accounts/:id',
    adminOnly,
    ah(async (req, res) => {
      const account = store.account(req.params.id);
      if (!account) throw new HttpError(404, 'Akun tidak ditemukan.');
      const patch = {};
      if (req.body?.label !== undefined) {
        const label = String(req.body.label).trim().slice(0, 40);
        if (!label) throw new HttpError(400, 'Nama akun tidak boleh kosong.');
        patch.label = label;
      }
      if (req.body?.mode !== undefined) {
        if (!['bot', 'manual'].includes(req.body.mode)) throw new HttpError(400, 'Mode tidak valid.');
        patch.mode = req.body.mode;
      }
      if (req.body?.knowledge !== undefined) {
        patch.knowledge = String(req.body.knowledge).trim().slice(0, 12000);
      }
      store.updateAccount(account.id, patch);
      sync({ accountId: account.id });
      res.json({ ok: true, account: store.account(account.id) });
    }),
  );

  router.get('/tickets', (req, res) => {
    const mine = new Set(allowedAccountIds(req.user));
    const tickets = store.data.tickets
      .filter((t) => mine.has(t.accountId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ tickets });
  });

  router.post(
    '/tickets',
    ah(async (req, res) => {
      const body = req.body || {};
      const subject = String(body.subject || '').trim();
      if (!subject) throw new HttpError(400, 'Subjek tiket wajib diisi.');
      if (subject.length > 160) throw new HttpError(400, 'Subjek maksimal 160 karakter.');
      const priority = PRIORITIES.includes(body.priority) ? body.priority : 'normal';

      let chat = null;
      if (body.chatId) chat = chatOf(req.user, body.chatId);
      const accountId = chat?.accountId || String(body.accountId || '');
      if (!store.account(accountId)) throw new HttpError(400, 'Akun tidak valid.');
      if (!chat) throw new HttpError(400, 'Tiket harus terhubung ke sebuah percakapan.');
      guardAccount(req.user, accountId);

      const now = Date.now();
      const ticket = {
        id: `t_${now}_${Math.random().toString(36).slice(2, 7)}`,
        code: store.nextTicketCode(),
        accountId,
        chatId: chat.id,
        contactName: chat.name,
        subject,
        description: String(body.description || '').trim().slice(0, 4000),
        status: 'open',
        priority,
        assignee: String(body.assignee || '').trim().slice(0, 60),
        createdAt: now,
        updatedAt: now,
      };
      store.data.tickets.push(ticket);
      store.addActivity('ticket', `Tiket ${ticket.code} dibuat untuk ${chat.name}`, {
        accountId,
        chatId: chat.id,
        ticketId: ticket.id,
      });
      sync({ chatId: chat.id, ticketId: ticket.id });
      res.status(201).json({ ok: true, ticket });
    }),
  );

  router.patch(
    '/tickets/:id',
    ah(async (req, res) => {
      const ticket = store.data.tickets.find((t) => t.id === req.params.id);
      if (!ticket) throw new HttpError(404, 'Tiket tidak ditemukan.');
      guardAccount(req.user, ticket.accountId);
      const body = req.body || {};
      if (body.status !== undefined) {
        if (!TICKET_STATUSES.includes(body.status)) throw new HttpError(400, 'Status tidak valid.');
        ticket.status = body.status;
      }
      if (body.priority !== undefined) {
        if (!PRIORITIES.includes(body.priority)) throw new HttpError(400, 'Prioritas tidak valid.');
        ticket.priority = body.priority;
      }
      if (body.subject !== undefined) {
        const subject = String(body.subject).trim();
        if (!subject) throw new HttpError(400, 'Subjek tiket wajib diisi.');
        ticket.subject = subject.slice(0, 160);
      }
      if (body.description !== undefined) {
        ticket.description = String(body.description).trim().slice(0, 4000);
      }
      if (body.assignee !== undefined) {
        ticket.assignee = String(body.assignee).trim().slice(0, 60);
      }
      ticket.updatedAt = Date.now();
      store.save();
      sync({ ticketId: ticket.id });
      res.json({ ok: true, ticket });
    }),
  );

  router.delete(
    '/tickets/:id',
    ah(async (req, res) => {
      const index = store.data.tickets.findIndex((t) => t.id === req.params.id);
      if (index === -1) throw new HttpError(404, 'Tiket tidak ditemukan.');
      guardAccount(req.user, store.data.tickets[index].accountId);
      const [ticket] = store.data.tickets.splice(index, 1);
      store.addActivity('ticket', `Tiket ${ticket.code} dihapus.`, { ticketId: ticket.id });
      sync();
      res.json({ ok: true });
    }),
  );

  router.patch(
    '/settings',
    adminOnly,
    ah(async (req, res) => {
      const body = req.body || {};
      const s = store.data.settings;

      if (body.geminiApiKey !== undefined) {
        s.geminiApiKey = String(body.geminiApiKey).trim().slice(0, 300);
      }
      if (body.geminiModel !== undefined) {
        const model = String(body.geminiModel).trim().slice(0, 80);
        if (!model) throw new HttpError(400, 'Model tidak valid.');
        s.geminiModel = model;
      }
      if (body.systemPrompt !== undefined) {
        s.systemPrompt = String(body.systemPrompt).trim().slice(0, 4000);
      }
      if (body.knowledge !== undefined) {
        s.knowledge = String(body.knowledge).trim().slice(0, 12000);
      }
      if (body.temperature !== undefined) {
        const t = Number(body.temperature);
        if (Number.isNaN(t)) throw new HttpError(400, 'Temperature tidak valid.');
        s.temperature = Math.min(Math.max(t, 0), 2);
      }
      if (body.maxTokens !== undefined) {
        const t = Number(body.maxTokens);
        if (Number.isNaN(t)) throw new HttpError(400, 'Max token tidak valid.');
        s.maxTokens = Math.min(Math.max(Math.round(t), 64), 4096);
      }
      if (body.replyDelayMs !== undefined) {
        const d = Number(body.replyDelayMs);
        if (Number.isNaN(d)) throw new HttpError(400, 'Jeda balasan tidak valid.');
        s.replyDelayMs = Math.min(Math.max(Math.round(d), 0), 8000);
      }

      const hadKey = !!s.geminiApiKey;
      store.save();
      store.addActivity('settings', 'Pengaturan AI diperbarui.');
      if (hadKey) sync();
      res.json({ ok: true, settings: store.publicSettings() });
    }),
  );

  router.post(
    '/settings/test',
    adminOnly,
    ah(async (req, res) => {
      const s = store.data.settings;
      if (!s.geminiApiKey) throw new HttpError(400, 'Isi dan simpan API key terlebih dahulu.');
      const startedAt = Date.now();
      const result = await generateReply({
        apiKey: s.geminiApiKey,
        model: s.geminiModel,
        systemPrompt: 'Jawab dengan sangat singkat.',
        temperature: 0,
        maxTokens: 64,
        history: [{ fromMe: false, text: 'Balas hanya dengan satu kata: OK' }],
      });
      res.json({
        ok: true,
        reply: result.text,
        latencyMs: Date.now() - startedAt,
        model: result.model,
        fallback: result.fallback,
      });
    }),
  );

  router.use((req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
  });

  return router;
}
