import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { MEDIA_DIR, SESSION_DIR } from './config.js';
import { identityLabel } from './store.js';
import { HttpError } from './errors.js';
import { useFirestoreAuthState } from './firestore-auth.js';

const logger = pino({ level: 'silent' });

const MEDIA_LABELS = {
  image: '📷 Gambar',
  video: '🎬 Video',
  audio: '🎧 Audio',
  document: '📄 Dokumen',
  sticker: '🩹 Stiker',
  location: '📍 Lokasi',
  contact: '👤 Kontak',
  poll: '📊 Polling',
};

const JID_SUFFIXES = ['@s.whatsapp.net', '@g.us', '@lid'];

const EDIT_WINDOW_MS = 15 * 60 * 1000;

function sessionPath(accountId) {
  return path.join(SESSION_DIR, accountId);
}

function hasCreds(accountId) {
  return fs.existsSync(path.join(sessionPath(accountId), 'creds.json'));
}

function unlinkSession(accountId) {
  try {
    fs.rmSync(sessionPath(accountId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function timestampMs(ts) {
  if (!ts) return Date.now();
  try {
    if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000;
    if (typeof ts.toNumber === 'function') return ts.toNumber() * 1000;
    return Number(ts) * 1000;
  } catch {
    return Date.now();
  }
}

function unwrapMessage(message) {
  if (!message) return null;
  return (
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message
  );
}

function extractContent(message) {
  const m = unwrapMessage(message);
  if (!m) return null;

  const text = (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  ).trim();

  let mediaType = null;
  if (m.imageMessage) mediaType = 'image';
  else if (m.videoMessage) mediaType = 'video';
  else if (m.audioMessage) mediaType = 'audio';
  else if (m.documentMessage) mediaType = 'document';
  else if (m.stickerMessage) mediaType = 'sticker';
  else if (m.locationMessage) mediaType = 'location';
  else if (m.contactMessage || m.contactsArrayMessage) mediaType = 'contact';
  else if (m.pollCreationMessage || m.pollCreationMessageV3) mediaType = 'poll';

  if (!text && !mediaType) return null;

  return {
    text: text || (mediaType ? MEDIA_LABELS[mediaType] : ''),
    mediaType,
    hasUserText: !!text,
  };
}

function displayPhone(jid) {
  return `+${String(jid || '').split('@')[0].split(':')[0]}`;
}

// Kutipan pesan (reply) ada di contextInfo; dipakai agar balasan terlihat membalas apa.
function extractQuoted(message) {
  const m = unwrapMessage(message);
  if (!m) return null;
  const info =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    null;
  if (!info?.quotedMessage) return null;
  const quoted = extractContent(info.quotedMessage);
  if (!quoted) return null;
  return { text: quoted.text, from: info.participant || null };
}

// Nama hasil turunan JID: bukan nama manusia, jadi aman ditimpa begitu identitas asli diketahui.
function isPlaceholderName(chat) {
  const name = String(chat?.name || '').trim();
  if (!name || name === 'Anda' || name === 'Kontak anonim' || name === 'Grup WhatsApp') return true;
  if (String(chat?.waJid || '').endsWith('@lid') && name === `+${String(chat.waJid).split('@')[0]}`) {
    return true;
  }
  return false;
}

function mediaExtension(mimetype, fallback) {
  const sub = String(mimetype || '').split('/')[1]?.split(';')[0]?.toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  if (['jpg', 'png', 'webp', 'gif'].includes(sub)) return sub;
  return fallback;
}

export class WhatsAppManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.sessions = new Map();
    this.reconnectTimers = new Map();
    this.reconnectCounts = new Map();
    this.messageIndex = new Map();
    for (const m of store.data.messages) {
      if (m.waId) this.messageIndex.set(`${m.accountId}:${m.waId}`, m.id);
    }
  }

  session(accountId) {
    return this.sessions.get(accountId) || null;
  }

  qrFor(accountId) {
    return this.session(accountId)?.qr || null;
  }

  async checkHasCreds(accountId) {
    if (this.store.firestore) {
      const authState = await useFirestoreAuthState(this.store.firestore, accountId);
      return await authState.hasCreds();
    }
    return hasCreds(accountId);
  }

  async clearSessionState(accountId) {
    if (this.store.firestore) {
      const authState = await useFirestoreAuthState(this.store.firestore, accountId);
      await authState.clearState();
    } else {
      unlinkSession(accountId);
    }
  }

  sessionInfo(accountId) {
    const acc = this.store.account(accountId);
    return { hasCreds: acc?.status === 'connected' || hasCreds(accountId) };
  }

  setStatus(accountId, status, extra = {}) {
    this.store.updateAccount(accountId, { status, ...extra });
    this.emit('sync', { reason: 'account', accountId });
  }

  async restore() {
    for (const acc of this.store.data.accounts) {
      const credsAvailable = await this.checkHasCreds(acc.id);
      if (credsAvailable) {
        this.connect(acc.id).catch((err) => {
          console.warn(`[wa:${acc.id}] restore gagal:`, err.message);
          this.setStatus(acc.id, 'disconnected');
        });
      } else {
        this.store.updateAccount(acc.id, { status: 'disconnected' });
      }
    }
    this.store.save();
  }

  async connect(accountId) {
    const account = this.store.account(accountId);
    if (!account) throw new HttpError(404, 'Akun tidak ditemukan.');

    const existing = this.sessions.get(accountId);
    if (existing?.sock && ['connected', 'connecting', 'qr'].includes(existing.status)) {
      return existing.sock;
    }

    const timer = this.reconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(accountId);
    }

    let state, saveCreds;
    if (this.store.firestore) {
      const fsAuth = await useFirestoreAuthState(this.store.firestore, accountId);
      state = fsAuth.state;
      saveCreds = fsAuth.saveCreds;
    } else {
      const fileAuth = await useMultiFileAuthState(sessionPath(accountId));
      state = fileAuth.state;
      saveCreds = fileAuth.saveCreds;
    }

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      /* pakai versi bawaan library */
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['NexaDesk', 'Chrome', '1.0.0'],
      syncFullHistory: true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    const session = {
      sock,
      status: 'connecting',
      qr: null,
      closing: false,
      reconnectAttempts: this.reconnectCounts.get(accountId) || 0,
    };
    this.sessions.set(accountId, session);
    this.setStatus(accountId, 'connecting');

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      this.handleConnectionUpdate(accountId, session, update).catch((err) =>
        console.warn(`[wa:${accountId}] connection.update:`, err.message),
      );
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const raw of messages) this.ingest(accountId, raw);
    });
    sock.ev.on('messaging-history.set', (payload) => {
      this.ingestHistory(accountId, payload).catch((err) =>
        console.warn(`[wa:${accountId}] riwayat gagal dimuat:`, err.message),
      );
    });
    sock.ev.on('contacts.update', (updates) => {
      if (this.rememberLidPairs(updates)) this.emit('sync', { reason: 'contacts', accountId });
    });
    sock.ev.on('messages.update', (updates) => this.handleAckUpdates(accountId, updates));

    return sock;
  }

  async handleConnectionUpdate(accountId, session, update) {
    if (this.sessions.get(accountId) !== session) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.status = 'qr';
      session.qr = await QRCode.toDataURL(qr, {
        margin: 1,
        width: 340,
        color: { dark: '#08131a', light: '#ffffff' },
      });
      this.setStatus(accountId, 'qr');
      this.emit('qr', { accountId, qr: session.qr });
    }

    if (connection === 'connecting') {
      session.status = 'connecting';
      this.setStatus(accountId, 'connecting');
    }

    if (connection === 'open') {
      session.status = 'connected';
      session.qr = null;
      session.reconnectAttempts = 0;
      this.reconnectCounts.delete(accountId);
      const rawId = session.sock.user?.id || '';
      const phone = rawId ? jidNormalizedUser(rawId).split('@')[0] : null;
      this.setStatus(accountId, 'connected', { phone, connectedAt: Date.now() });
      const label = this.store.account(accountId)?.label || accountId;
      this.store.addActivity('connect', `${label} terhubung${phone ? ` · ${displayPhone(phone)}` : ''}`);
      this.emit('sync', { reason: 'connected', accountId });
    }

    if (connection === 'close') {
      session.qr = null;
      session.status = 'closed';
      if (session.closing) return;

      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const reason = lastDisconnect?.error?.message || 'koneksi terputus';

      if (loggedOut) {
        this.sessions.delete(accountId);
        await this.clearSessionState(accountId);
        this.setStatus(accountId, 'disconnected', { phone: null, connectedAt: null });
        this.store.addActivity('error', `Sesi ${this.store.account(accountId)?.label || accountId} berakhir, perlu tautkan ulang.`);
        this.emit('sync', { reason: 'logout', accountId });
        return;
      }

      if (this.sessions.get(accountId) === session) this.sessions.delete(accountId);
      session.status = 'closed';

      if (code === DisconnectReason.restartRequired) {
        this.connect(accountId).catch(() => {});
        return;
      }

      session.reconnectAttempts += 1;
      this.reconnectCounts.set(accountId, session.reconnectAttempts);
      this.setStatus(accountId, 'connecting');
      const delay = Math.min(1500 * session.reconnectAttempts, 15000);
      console.warn(`[wa:${accountId}] terputus (${reason}), mencoba lagi dalam ${delay}ms`);
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(accountId);
        this.connect(accountId).catch(() => this.setStatus(accountId, 'disconnected'));
      }, delay);
      this.reconnectTimers.set(accountId, timer);
      this.emit('sync', { reason: 'reconnect', accountId });
    }
  }

  async logout(accountId) {
    const session = this.sessions.get(accountId);
    const timer = this.reconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(accountId);
    }
    if (session) {
      session.closing = true;
      this.sessions.delete(accountId);
      try {
        await session.sock.logout();
      } catch {
        try {
          session.sock.end(undefined);
        } catch {
          /* ignore */
        }
      }
    }
    await this.clearSessionState(accountId);
    this.setStatus(accountId, 'disconnected', { phone: null, connectedAt: null });
    this.store.addActivity('logout', `${this.store.account(accountId)?.label || accountId} diputuskan.`);
    this.emit('sync', { reason: 'logout', accountId });
  }

  ingest(accountId, raw, opts = {}) {
    const fromHistory = !!opts.history;
    try {
      if (!raw?.message || !raw.key?.remoteJid) return null;
      const waJid = raw.key.remoteJid;
      if (!JID_SUFFIXES.some((suffix) => waJid.endsWith(suffix))) return null;
      if (waJid === 'status@broadcast') return null;

      const protocol = raw.message.protocolMessage;
      if (protocol) {
        if (!fromHistory) this.handleProtocol(accountId, raw, protocol);
        return null;
      }
      if (raw.message.reactionMessage || raw.message.senderKeyDistributionMessage) return null;

      if (raw.key.id && this.messageIndex.has(`${accountId}:${raw.key.id}`)) return null;

      const content = extractContent(raw.message);
      if (!content) return null;

      const isGroup = waJid.endsWith('@g.us');
      const fromMe = !!raw.key.fromMe;
      const identity = identityLabel(this.store, waJid, isGroup);
      const senderName = raw.pushName || (fromMe ? 'Anda' : identity);

      let chat = this.store.findChatByJid(accountId, waJid);
      if (!chat) {
        chat = this.store.upsertChat({
          accountId,
          waJid,
          name: isGroup ? 'Grup WhatsApp' : raw.pushName || identity,
          isGroup,
        });
        if (isGroup && !fromHistory) this.resolveGroupName(accountId, chat, waJid);
      } else if (isGroup && !chat.nameResolved && !fromHistory) {
        this.resolveGroupName(accountId, chat, waJid);
      } else if (!isGroup && !chat.nameLocked && isPlaceholderName(chat) && chat.name !== identity) {
        chat.name = identity;
        this.store.save();
      }

      const quoted = extractQuoted(raw.message);

      const message = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        accountId,
        chatId: chat.id,
        waId: raw.key.id,
        waKey: {
          remoteJid: raw.key.remoteJid,
          fromMe: !!raw.key.fromMe,
          id: raw.key.id,
          participant: raw.key.participant || undefined,
        },
        fromMe,
        senderName,
        text: content.text,
        mediaType: content.mediaType,
        hasUserText: content.hasUserText,
        quotedText: quoted?.text || null,
        quotedFrom: quoted?.from
          ? this.quoteAuthorName(
              chat,
              quoted.from,
              identityLabel(this.store, quoted.from, quoted.from.endsWith('@g.us')),
            )
          : null,
        source: fromMe ? 'agent' : 'contact',
        createdAt: timestampMs(raw.messageTimestamp),
        ack: fromMe ? 2 : 0,
        deleted: false,
        revoked: false,
        aiGenerated: false,
      };

      this.store.addMessage(message, { countUnread: !fromHistory });
      this.messageIndex.set(`${accountId}:${message.waId}`, message.id);
      if (chat.lastPreview === undefined) chat.lastPreview = message.text;
      if (fromHistory) return message;
      this.emit('message', message);
      this.emit('sync', { reason: 'message', accountId, chatId: chat.id });
      if (!fromMe) this.emit('incoming', { accountId, chat, message });
      if (message.mediaType === 'image' || message.mediaType === 'sticker') {
        this.cacheMedia(accountId, raw, message).catch(() => {});
      }
      return message;
    } catch (err) {
      console.warn(`[wa:${accountId}] gagal memproses pesan:`, err.message);
      return null;
    }
  }

  rememberLidPairs(list = []) {
    let changed = false;
    for (const item of list) {
      if (!item) continue;
      const real =
        item.jid || (String(item.id || '').endsWith('@s.whatsapp.net') ? item.id : '');
      const lid = item.lid || item.phone?.lid || '';
      if (this.store.rememberLid(lid, real)) changed = true;
    }
    if (changed) this.store.save();
    return changed;
  }

  async ingestHistory(accountId, payload = {}) {
    const session = this.sessions.get(accountId);
    if (!session) return 0;
    const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
    this.rememberLidPairs(contacts);
    const incoming = (Array.isArray(payload.messages) ? payload.messages : []).filter(
      (raw) => raw?.message && raw.key?.remoteJid,
    );
    if (!incoming.length) return 0;

    const names = new Map();
    for (const item of payload.chats || []) {
      if (item?.id && item.name) names.set(item.id, item.name);
    }
    for (const item of contacts) {
      const label = item?.notify || item?.name || item?.verifiedName;
      if (item?.id && label && !names.has(item.id)) names.set(item.id, label);
    }

    const ordered = incoming.sort(
      (a, b) => timestampMs(a.messageTimestamp) - timestampMs(b.messageTimestamp),
    );

    let stored = 0;
    for (let i = 0; i < ordered.length; i += 1) {
      if (this.ingest(accountId, ordered[i], { history: true })) stored += 1;
      if (i % 400 === 399) await new Promise((resolve) => setImmediate(resolve));
    }

    for (const chat of this.store.data.chats) {
      if (chat.accountId !== accountId || chat.nameLocked) continue;
      const label = names.get(chat.waJid) || names.get(this.store.realJidFor(chat.waJid));
      if (label) {
        chat.name = label;
        chat.nameResolved = true;
      } else if (chat.isGroup) {
        if (!chat.nameResolved) this.resolveGroupName(accountId, chat, chat.waJid);
      } else if (isPlaceholderName(chat)) {
        chat.name = identityLabel(this.store, chat.waJid, false);
        chat.nameResolved = true;
      }
    }
    this.store.save();

    console.log(`[wa:${accountId}] riwayat: ${stored} pesan disimpan dari ${ordered.length} diterima`);
    this.emit('sync', { reason: 'history', accountId });
    return stored;
  }

  async cacheMedia(accountId, raw, message) {
    if (message.mediaUrl) return;
    const session = this.sessions.get(accountId);
    if (!session?.sock) return;
    try {
      const buffer = await downloadMediaMessage(raw, 'buffer', {}, {
        logger,
        reuploadRequest: session.sock.updateMediaMessage,
      });
      if (!buffer?.length || buffer.length > 12 * 1024 * 1024) return;
      const inner = unwrapMessage(raw.message) || raw.message;
      const mimetype = inner?.imageMessage?.mimetype || inner?.stickerMessage?.mimetype || '';
      const ext = mediaExtension(mimetype, message.mediaType === 'sticker' ? 'webp' : 'jpg');
      const name = `${message.waId || message.id}.${ext}`.replace(/[^A-Za-z0-9._-]/g, '_');
      fs.writeFileSync(path.join(MEDIA_DIR, name), buffer);
      message.mediaUrl = `/api/media/${name}`;
      this.store.save();
      this.emit('message:update', message);
      this.emit('sync', { reason: 'media', accountId, chatId: message.chatId });
    } catch (err) {
      console.warn(`[wa:${accountId}] gagal mengunduh media:`, err.message);
    }
  }

  applyEditedMessage(accountId, targetId, content) {
    if (!targetId || !content?.text) return false;
    const messageId = this.messageIndex.get(`${accountId}:${targetId}`);
    const message = messageId ? this.store.message(messageId) : null;
    if (!message || message.text === content.text) return false;
    message.text = content.text;
    message.editedAt = Date.now();
    this.store.refreshChatPreview(message.chatId);
    this.store.save();
    this.emit('message:update', message);
    this.emit('sync', { reason: 'edited', accountId, chatId: message.chatId });
    return true;
  }

  handleProtocol(accountId, raw, protocol) {
    if (protocol.type === 14) {
      // EDIT: sinkronkan perubahan teks dari perangkat WhatsApp lain.
      const content = protocol.editedMessage ? extractContent(protocol.editedMessage) : null;
      this.applyEditedMessage(accountId, protocol.key?.id, content);
      return;
    }
    if (protocol.type !== 0) return; // REVOKE
    const targetId = protocol.key?.id;
    if (!targetId) return;
    const messageId = this.messageIndex.get(`${accountId}:${targetId}`);
    const message = messageId ? this.store.message(messageId) : null;
    if (!message) return;
    message.deleted = true;
    message.revoked = true;
    message.text = '';
    this.store.refreshChatPreview(message.chatId);
    this.store.save();
    this.emit('message:update', message);
    this.emit('sync', { reason: 'revoked', accountId, chatId: message.chatId });
  }

  handleAckUpdates(accountId, updates = []) {
    let changed = false;
    for (const entry of updates) {
      const protocol = entry?.update?.message?.protocolMessage;
      if (protocol?.type === 14) {
        const content = protocol.editedMessage ? extractContent(protocol.editedMessage) : null;
        if (this.applyEditedMessage(accountId, protocol.key?.id, content)) changed = true;
        continue;
      }
      const status = entry?.update?.status;
      if (typeof status !== 'number' || !entry.key?.id) continue;
      const messageId = this.messageIndex.get(`${accountId}:${entry.key.id}`);
      if (!messageId) continue;
      const message = this.store.message(messageId);
      if (message && message.ack !== status) {
        message.ack = status;
        changed = true;
      }
    }
    if (changed) {
      this.store.save();
      this.emit('sync', { reason: 'ack', accountId });
    }
  }

  async resolveGroupName(accountId, chat, waJid) {
    const session = this.sessions.get(accountId);
    if (!session?.sock) return;
    chat.nameResolved = true;
    if (chat.nameLocked) return;
    try {
      const meta = await session.sock.groupMetadata(waJid);
      if (meta?.subject) {
        chat.name = meta.subject;
        this.store.save();
        this.emit('sync', { reason: 'group', accountId });
      }
    } catch {
      /* grup mungkin sudah tidak diikuti */
    }
  }

  quoteAuthorName(chat, senderKey, fallbackName) {
    if (!chat) return fallbackName || null;
    const override = this.store.senderNameFor(chat.id, senderKey);
    if (override) return override;
    if (!chat.isGroup) return chat.name || fallbackName || null;
    return fallbackName || null;
  }

  quotedPreview(target) {
    if (!target) return { text: null, from: null };
    const text = String(target.text || '').slice(0, 200);
    if (target.fromMe) return { text, from: 'Anda' };
    const chat = this.store.chat(target.chatId);
    const key = chat ? this.store.senderKeyFor(target, chat) : '';
    return { text, from: this.quoteAuthorName(chat, key, target.senderName) };
  }

  async buildQuoted(session, target) {
    if (!target?.waKey?.id) return null;
    let inner = null;
    try {
      const stored = await session.sock.getMessage?.(target.waKey.id);
      if (stored?.message) inner = stored.message;
    } catch {
      /* riwayat pesan tidak tersedia di store Baileys */
    }
    return {
      key: target.waKey,
      message: inner || { conversation: String(target.text || '').slice(0, 2000) },
      messageTimestamp: Math.floor((target.createdAt || Date.now()) / 1000),
    };
  }

  recordOutgoing(accountId, chat, text, options = {}) {
    const {
      waId,
      waKey,
      source,
      mediaType = null,
      mediaUrl = null,
      hasUserText = true,
      quotedText = null,
      quotedFrom = null,
    } = options;
    const now = Date.now();
    const message = {
      id: `m_${now}_${Math.random().toString(36).slice(2, 8)}`,
      accountId,
      chatId: chat.id,
      waId: waId || `local_${now}`,
      waKey: waKey || null,
      fromMe: true,
      senderName: 'Anda',
      text,
      mediaType,
      mediaUrl,
      hasUserText,
      quotedText,
      quotedFrom,
      source,
      createdAt: now,
      ack: 2,
      deleted: false,
      revoked: false,
      aiGenerated: source === 'ai',
    };
    chat.unread = 0;
    this.store.addMessage(message);
    if (message.waId) this.messageIndex.set(`${accountId}:${message.waId}`, message.id);
    this.emit('message', message);
    this.emit('sync', { reason: 'message', accountId, chatId: chat.id });
    return message;
  }

  outgoingKey(sent) {
    return sent?.key
      ? {
          remoteJid: sent.key.remoteJid,
          fromMe: !!sent.key.fromMe,
          id: sent.key.id,
          participant: sent.key.participant || undefined,
        }
      : null;
  }

  async sendText(accountId, chat, text, source = 'agent', { replyMessage = null } = {}) {
    const session = this.sessions.get(accountId);
    if (!session?.sock || session.status !== 'connected') {
      throw new HttpError(409, 'Nomor ini belum terhubung ke WhatsApp.');
    }
    const quoted = await this.buildQuoted(session, replyMessage);
    let sent;
    try {
      sent = await session.sock.sendMessage(chat.waJid, { text }, quoted ? { quoted } : undefined);
    } catch (err) {
      throw new HttpError(502, `Gagal mengirim pesan: ${err.message}`);
    }
    const preview = this.quotedPreview(replyMessage);
    return this.recordOutgoing(accountId, chat, text, {
      waId: sent?.key?.id,
      waKey: this.outgoingKey(sent),
      source,
      quotedText: preview.text,
      quotedFrom: preview.from,
    });
  }

  async sendImage(accountId, chat, { buffer, mimetype, caption = '', source = 'agent', replyMessage = null } = {}) {
    const session = this.sessions.get(accountId);
    if (!session?.sock || session.status !== 'connected') {
      throw new HttpError(409, 'Nomor ini belum terhubung ke WhatsApp.');
    }
    const quoted = await this.buildQuoted(session, replyMessage);
    let sent;
    try {
      sent = await session.sock.sendMessage(
        chat.waJid,
        { image: buffer, caption, mimetype },
        quoted ? { quoted } : undefined,
      );
    } catch (err) {
      throw new HttpError(502, `Gagal mengirim gambar: ${err.message}`);
    }
    const waId = sent?.key?.id || null;
    let mediaUrl = null;
    try {
      const name = `${waId || `local_${Date.now()}`}.${mediaExtension(mimetype, 'jpg')}`.replace(
        /[^A-Za-z0-9._-]/g,
        '_',
      );
      fs.writeFileSync(path.join(MEDIA_DIR, name), buffer);
      mediaUrl = `/api/media/${name}`;
    } catch {
      /* gambar sudah terkirim; pratinjau lokal gagal disimpan */
    }
    const trimmed = String(caption || '').trim();
    const preview = this.quotedPreview(replyMessage);
    return this.recordOutgoing(accountId, chat, trimmed || MEDIA_LABELS.image, {
      waId,
      waKey: this.outgoingKey(sent),
      source,
      mediaType: 'image',
      mediaUrl,
      hasUserText: !!trimmed,
      quotedText: preview.text,
      quotedFrom: preview.from,
    });
  }

  async sendPresence(accountId, waJid, type) {
    const session = this.sessions.get(accountId);
    if (!session?.sock || session.status !== 'connected') return;
    try {
      await session.sock.sendPresenceUpdate(type, waJid);
    } catch {
      /* ignore */
    }
  }

  async deleteChat(chat, { remote = false } = {}) {
    if (remote) {
      const session = this.sessions.get(chat.accountId);
      if (!session?.sock || session.status !== 'connected') {
        throw new HttpError(409, 'Nomor ini belum terhubung ke WhatsApp.');
      }
      const lastMessages = this.store
        .messagesFor(chat.id, 5)
        .filter((m) => m.waKey?.id)
        .map((m) => ({
          key: m.waKey,
          messageTimestamp: Math.floor(m.createdAt / 1000),
        }));
      try {
        await session.sock.chatModify({ delete: true, lastMessages }, chat.waJid);
      } catch (err) {
        throw new HttpError(502, `WhatsApp menolak menghapus chat: ${err.message}`);
      }
    }

    for (const m of this.store.data.messages) {
      if (m.chatId === chat.id && m.waId) {
        this.messageIndex.delete(`${m.accountId}:${m.waId}`);
      }
    }
    this.store.removeChat(chat.id);
    this.store.addActivity(
      'message',
      remote ? `Chat ${chat.name} dihapus dari WhatsApp.` : `Chat ${chat.name} dihapus dari dashboard.`,
      { accountId: chat.accountId },
    );
    this.emit('sync', { reason: 'chat-deleted', accountId: chat.accountId, chatId: chat.id });
  }

  async markRead(accountId, chat) {    const session = this.sessions.get(accountId);
    if (!session?.sock || session.status !== 'connected') return;
    const lastIncoming = [...this.store.data.messages]
      .reverse()
      .find((m) => m.chatId === chat.id && !m.fromMe && m.waKey);
    if (!lastIncoming) return;
    try {
      await session.sock.readMessages([lastIncoming.waKey]);
    } catch {
      /* ignore */
    }
  }

  async revoke(accountId, message) {
    const session = this.sessions.get(accountId);
    if (!session?.sock || session.status !== 'connected') {
      throw new HttpError(409, 'Nomor ini belum terhubung ke WhatsApp.');
    }
    if (!message.fromMe) {
      throw new HttpError(400, 'Hanya pesan keluar yang dapat dihapus untuk semua orang.');
    }
    if (!message.waKey?.id) {
      throw new HttpError(400, 'Pesan ini tidak memiliki ID WhatsApp yang valid.');
    }
    try {
      await session.sock.sendMessage(message.waKey.remoteJid, { delete: message.waKey });
    } catch (err) {
      throw new HttpError(502, `WhatsApp menolak menghapus pesan: ${err.message}`);
    }
    message.deleted = true;
    message.revoked = true;
    message.text = '';
    this.store.refreshChatPreview(message.chatId);
    this.store.save();
    this.emit('message:update', message);
    this.emit('sync', { reason: 'revoked', accountId, chatId: message.chatId });
  }

  async edit(accountId, message, text) {
    const session = this.sessions.get(accountId);
    if (!session?.sock || session.status !== 'connected') {
      throw new HttpError(409, 'Nomor ini belum terhubung ke WhatsApp.');
    }
    if (!message.fromMe) {
      throw new HttpError(400, 'Hanya pesan keluar yang dapat diedit.');
    }
    if (message.deleted || message.revoked) {
      throw new HttpError(400, 'Pesan yang sudah dihapus tidak bisa diedit.');
    }
    if (!message.waKey?.id) {
      throw new HttpError(400, 'Pesan ini tidak memiliki ID WhatsApp yang valid.');
    }
    if (Date.now() - message.createdAt > EDIT_WINDOW_MS) {
      throw new HttpError(400, 'WhatsApp hanya mengizinkan edit dalam 15 menit setelah pesan dikirim.');
    }
    try {
      await session.sock.sendMessage(message.waKey.remoteJid, { text, edit: message.waKey });
    } catch (err) {
      throw new HttpError(502, `WhatsApp menolak mengedit pesan: ${err.message}`);
    }
    message.text = text;
    message.editedAt = Date.now();
    this.store.refreshChatPreview(message.chatId);
    this.store.save();
    this.store.addActivity('message', 'Pesan terkirim diedit.', {
      accountId,
      chatId: message.chatId,
    });
    this.emit('message:update', message);
    this.emit('sync', { reason: 'edited', accountId, chatId: message.chatId });
    return message;
  }
}
