import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { DEFAULT_MODEL, GEMINI_MODELS } from './gemini.js';
import { getFirestoreDb } from './firestore.js';

const DB_PATH = path.join(DATA_DIR, 'db.json');
const MAX_PER_CHAT = Number(process.env.NEXADESK_MAX_PER_CHAT) || 300;
const MAX_TOTAL = Number(process.env.NEXADESK_MAX_MESSAGES) || 25000;
const MAX_ACTIVITY = 80;

export const DEFAULT_PROMPT = `Kamu adalah "Nexa", asisten customer service yang ramah, cepat, dan solutif untuk bisnis kami.
Balas dalam Bahasa Indonesia yang santai namun profesional, maksimal 3 paragraf pendek, dan langsung ke inti.
Gunakan emoji secukupnya. Jika pertanyaan menyangkut data pribadi, pembayaran, atau komplain sensitif, minta maaf dan informasikan bahwa tim manusia akan segera membantu.
Jangan membuat janji harga, diskon, atau kebijakan yang tidak pasti.`;

export const DEFAULT_SETTINGS = {
  geminiApiKey: '',
  geminiModel: DEFAULT_MODEL,
  systemPrompt: DEFAULT_PROMPT,
  knowledge: '',
  temperature: 0.7,
  maxTokens: 512,
  replyDelayMs: 1200,
};

function initialAccounts() {
  return [1, 2, 3].map((n) => ({
    id: `wa-${n}`,
    label: `WhatsApp ${n}`,
    status: 'disconnected',
    phone: null,
    mode: 'bot',
    knowledge: '',
    connectedAt: null,
    createdAt: Date.now(),
  }));
}

function defaults() {
  return {
    version: 1,
    accounts: initialAccounts(),
    chats: [],
    messages: [],
    tickets: [],
    users: [],
    activity: [],
    meta: { ticketSeq: 1040, authSecret: null },
    lidMap: {},
    senderNames: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}

function normalizeLid(value) {
  const raw = String(value || '').split('@')[0].trim();
  return raw ? `${raw}@lid` : '';
}

export function identityLabel(store, waJid, isGroup = false) {
  if (isGroup) return 'Grup WhatsApp';
  const phone = store.phoneOf(waJid);
  if (phone) return `+${phone}`;
  if (String(waJid || '').endsWith('@lid')) return 'Kontak anonim';
  const raw = String(waJid || '').split('@')[0].split(':')[0];
  return raw ? `+${raw}` : 'Kontak anonim';
}

export class Store {
  constructor() {
    this.firestore = getFirestoreDb();
    this.data = this.load();
    this.timer = null;
    this.counts = new Map();
    this.recount();

    if (this.firestore) {
      this.initFirestoreSync().catch((err) =>
        console.warn('[store:firestore] Gagal sinkronisasi awal:', err.message),
      );
    }

    if (this.data.messages.length > MAX_TOTAL) {
      this.trimTotal();
      this.save();
    }
    if (!GEMINI_MODELS.includes(this.data.settings.geminiModel)) {
      this.data.settings.geminiModel = DEFAULT_SETTINGS.geminiModel;
      this.save();
    }
    if (typeof this.data.settings.knowledge !== 'string') {
      this.data.settings.knowledge = '';
      this.save();
    }
    if (this.normalizeOwnership()) this.save();
  }

  async initFirestoreSync() {
    try {
      const doc = await this.firestore.collection('nexadesk_data').doc('main').get();
      if (doc.exists) {
        const remoteData = doc.data();
        const base = defaults();
        this.data = {
          ...base,
          ...remoteData,
          settings: { ...base.settings, ...(remoteData.settings || {}) },
          meta: { ...base.meta, ...(remoteData.meta || {}) },
          accounts: Array.isArray(remoteData.accounts) ? remoteData.accounts : base.accounts,
        };
        this.recount();
        this.normalizeOwnership();
        console.log('[store:firestore] Data berhasil dimuat dari Firestore');
      } else {
        await this.firestore.collection('nexadesk_data').doc('main').set(this.data);
        console.log('[store:firestore] Data awal dibuat di Firestore');
      }
    } catch (err) {
      console.warn('[store:firestore] Gagal membaca dari Firestore:', err.message);
    }
  }

  // Basis pengetahuan per slot + daftar akun yang boleh diakses tiap pengguna.
  normalizeOwnership() {
    const ids = this.data.accounts.map((account) => account.id);
    let changed = false;
    for (const account of this.data.accounts) {
      if (typeof account.knowledge !== 'string') {
        account.knowledge = '';
        changed = true;
      }
    }
    for (const user of this.data.users) {
      if (!Array.isArray(user.accounts)) {
        user.accounts = [...ids];
        changed = true;
        continue;
      }
      const clean = [...new Set(user.accounts.filter((id) => ids.includes(id)))];
      if (clean.length !== user.accounts.length || clean.some((id, i) => id !== user.accounts[i])) {
        user.accounts = clean;
        changed = true;
      }
    }
    return changed;
  }

  load() {
    const base = defaults();
    if (!fs.existsSync(DB_PATH)) return base;
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      const merged = {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings || {}) },
        meta: { ...base.meta, ...(parsed.meta || {}) },
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : base.accounts,
      };
      for (const seed of base.accounts) {
        if (!merged.accounts.some((a) => a.id === seed.id)) merged.accounts.push(seed);
      }
      merged.accounts = merged.accounts.slice(0, 3);
      for (const list of ['chats', 'messages', 'tickets', 'activity', 'users']) {
        if (!Array.isArray(merged[list])) merged[list] = [];
      }
      if (!merged.lidMap || typeof merged.lidMap !== 'object') merged.lidMap = {};
      if (!merged.senderNames || typeof merged.senderNames !== 'object') merged.senderNames = {};
      return merged;
    } catch (err) {
      console.warn('[store] db.json tidak dapat dibaca, memakai data baru:', err.message);
      return base;
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = `${DB_PATH}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, DB_PATH);
    } catch (err) {
      console.error('[store] gagal menyimpan db:', err.message);
    }

    if (this.firestore) {
      this.firestore
        .collection('nexadesk_data')
        .doc('main')
        .set(this.data)
        .catch((err) =>
          console.error('[store:firestore] Gagal menyimpan ke Firestore:', err.message),
        );
    }
  }

  account(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  updateAccount(id, patch) {
    const acc = this.account(id);
    if (!acc) return null;
    Object.assign(acc, patch);
    this.save();
    return acc;
  }

  chat(id) {
    return this.data.chats.find((c) => c.id === id) || null;
  }

  updateChat(id, patch) {
    const chat = this.chat(id);
    if (!chat) return null;
    Object.assign(chat, patch);
    this.save();
    return chat;
  }

  findChatByJid(accountId, waJid) {
    return this.data.chats.find((c) => c.accountId === accountId && c.waJid === waJid) || null;
  }

  upsertChat({ accountId, waJid, name, isGroup }) {
    let chat = this.findChatByJid(accountId, waJid);
    if (!chat) {
      chat = {
        id: `${accountId}__${waJid}`,
        accountId,
        waJid,
        name: name || identityLabel(this, waJid, isGroup),
        isGroup: !!isGroup,
        lastPreview: '',
        lastMessageAt: Date.now(),
        unread: 0,
        modeOverride: 'inherit',
        createdAt: Date.now(),
      };
      this.data.chats.push(chat);
    } else if (name && !chat.isGroup && !chat.nameLocked && chat.name !== name) {
      chat.name = name;
    }
    return chat;
  }

  renameChat(id, name) {
    const chat = this.chat(id);
    if (!chat) return null;
    chat.name = name;
    chat.nameLocked = true;
    this.save();
    return chat;
  }

  senderKeyFor(message, chat) {
    return message?.waKey?.participant || message?.waKey?.remoteJid || chat?.waJid || '';
  }

  senderNameFor(chatId, senderKey) {
    return this.data.senderNames[`${chatId}::${senderKey}`] || '';
  }

  setSenderName(chatId, senderKey, name) {
    const key = `${chatId}::${senderKey}`;
    if (!name) {
      if (!(key in this.data.senderNames)) return false;
      delete this.data.senderNames[key];
      return true;
    }
    if (this.data.senderNames[key] === name) return false;
    this.data.senderNames[key] = name;
    return true;
  }

  groupSenders(chatId, limit = 60) {
    const chat = this.chat(chatId);
    if (!chat) return [];
    const out = new Map();
    for (const message of this.data.messages) {
      if (message.chatId !== chatId || message.fromMe) continue;
      const key = this.senderKeyFor(message, chat);
      if (!key) continue;
      if (!out.has(key)) {
        out.set(key, { key, shown: message.senderName || '', count: 0 });
      }
      out.get(key).count += 1;
    }
    return [...out.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  }

  realJidFor(waJid) {
    const jid = String(waJid || '');
    if (!jid.endsWith('@lid')) return jid;
    const real = this.data.lidMap[jid];
    return real && !String(real).endsWith('@lid') ? real : '';
  }

  phoneOf(waJid) {
    const real = this.realJidFor(waJid);
    if (!real) return '';
    const digits = String(real).split('@')[0].split(':')[0];
    return /^\d{5,}$/.test(digits) ? digits : '';
  }

  rememberLid(lid, realJid) {
    const key = normalizeLid(lid);
    const real = String(realJid || '');
    if (!key || !real || !real.includes('@s.whatsapp.net')) return false;
    if (this.data.lidMap[key] === real) return false;
    this.data.lidMap[key] = real;
    return true;
  }

  messagesFor(chatId, limit = 120) {
    const list = this.data.messages.filter((m) => m.chatId === chatId);
    return list.slice(-limit);
  }

  messagesPage(chatId, { before = null, limit = 120 } = {}) {
    const list = this.data.messages.filter((m) => m.chatId === chatId);
    let end = list.length;
    if (before) {
      const index = list.findIndex((m) => m.id === before);
      if (index >= 0) end = index;
    }
    const start = Math.max(0, end - limit);
    return { messages: list.slice(start, end), hasMore: start > 0 };
  }

  message(id) {
    return this.data.messages.find((m) => m.id === id) || null;
  }

  recount() {
    this.counts.clear();
    for (const msg of this.data.messages) {
      this.counts.set(msg.chatId, (this.counts.get(msg.chatId) || 0) + 1);
    }
  }

  trimChat(chatId) {
    const positions = [];
    for (let i = 0; i < this.data.messages.length; i += 1) {
      if (this.data.messages[i].chatId === chatId) positions.push(i);
    }
    const excess = positions.length - MAX_PER_CHAT;
    if (excess <= 0) {
      this.counts.set(chatId, positions.length);
      return;
    }
    const drop = new Set(positions.slice(0, excess));
    this.data.messages = this.data.messages.filter((_, i) => !drop.has(i));
    this.counts.set(chatId, MAX_PER_CHAT);
  }

  trimTotal() {
    const excess = this.data.messages.length - MAX_TOTAL;
    if (excess > 0) this.data.messages.splice(0, excess);
    this.recount();
  }

  addMessage(msg, { countUnread = true } = {}) {
    this.data.messages.push(msg);
    const inChat = (this.counts.get(msg.chatId) || 0) + 1;
    this.counts.set(msg.chatId, inChat);
    if (inChat > MAX_PER_CHAT) this.trimChat(msg.chatId);
    if (this.data.messages.length > MAX_TOTAL) this.trimTotal();
    const chat = this.chat(msg.chatId);
    if (chat) {
      chat.lastPreview = msg.deleted ? 'Pesan dihapus' : msg.text.slice(0, 120);
      chat.lastMessageAt = msg.createdAt;
      if (!msg.fromMe && !msg.deleted && countUnread) chat.unread = (chat.unread || 0) + 1;
    }
    this.save();
    return msg;
  }

  refreshChatPreview(chatId) {
    const chat = this.chat(chatId);
    if (!chat) return;
    const last = [...this.data.messages].reverse().find((m) => m.chatId === chatId);
    chat.lastPreview = last ? (last.deleted ? 'Pesan dihapus' : last.text.slice(0, 120)) : '';
    chat.lastMessageAt = last ? last.createdAt : chat.lastMessageAt;
    this.save();
  }

  removeChat(chatId) {
    this.data.messages = this.data.messages.filter((m) => m.chatId !== chatId);
    this.data.chats = this.data.chats.filter((c) => c.id !== chatId);
    this.counts.delete(chatId);
    for (const key of Object.keys(this.data.senderNames)) {
      if (key.startsWith(`${chatId}::`)) delete this.data.senderNames[key];
    }
    for (const ticket of this.data.tickets) {
      if (ticket.chatId === chatId) ticket.chatId = null;
    }
    this.save();
  }

  addActivity(kind, text, meta = {}) {
    this.data.activity.unshift({
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind,
      text,
      meta,
      at: Date.now(),
    });
    this.data.activity = this.data.activity.slice(0, MAX_ACTIVITY);
    this.save();
  }

  nextTicketCode() {
    const highest = this.data.tickets.reduce((max, ticket) => {
      const match = /^TKT-(\d+)$/.exec(ticket.code || '');
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    this.data.meta.ticketSeq = Math.max(this.data.meta.ticketSeq || 1040, highest) + 1;
    this.save();
    return `TKT-${this.data.meta.ticketSeq}`;
  }

  publicSettings() {
    const s = this.data.settings;
    const key = s.geminiApiKey || '';
    return {
      geminiModel: s.geminiModel,
      systemPrompt: s.systemPrompt,
      knowledge: s.knowledge || '',
      temperature: s.temperature,
      maxTokens: s.maxTokens,
      replyDelayMs: s.replyDelayMs,
      hasKey: !!key,
      keyPreview: key ? `${key.slice(0, 4)}••••${key.slice(-4)}` : '',
      defaultPrompt: DEFAULT_PROMPT,
      defaultModel: DEFAULT_SETTINGS.geminiModel,
    };
  }
}
