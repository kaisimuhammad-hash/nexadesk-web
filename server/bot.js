import { generateReply } from './gemini.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Basis pengetahuan bersama digabung dengan basis pengetahuan milik slot akun ini.
export function knowledgeFor(settings, account) {
  const shared = String(settings?.knowledge || '').trim();
  const own = String(account?.knowledge || '').trim();
  if (!own) return shared;
  const labeled = `Khusus akun "${account.label}":\n${own}`;
  return shared ? `${shared}\n\n${labeled}` : labeled;
}

export class BotEngine {
  constructor({ manager, store }) {
    this.manager = manager;
    this.store = store;
    this.inflight = new Set();
    this.keyWarnedAt = new Map();
  }

  effectiveMode(chat, account) {
    if (chat.modeOverride === 'bot' || chat.modeOverride === 'manual') return chat.modeOverride;
    return account?.mode === 'manual' ? 'manual' : 'bot';
  }

  shouldReply(chat, account, message) {
    if (!chat || !account) return false;
    if (message.fromMe || message.deleted || message.revoked) return false;
    if (message.source !== 'contact') return false;
    if (chat.isGroup) return false;
    if (!message.hasUserText || !message.text.trim()) return false;
    if (account.status !== 'connected') return false;
    return this.effectiveMode(chat, account) === 'bot';
  }

  warnMissingKey(accountId) {
    const last = this.keyWarnedAt.get(accountId) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    this.keyWarnedAt.set(accountId, Date.now());
    this.manager.emit('notify', {
      type: 'warning',
      title: 'API key Gemini belum diisi',
      text: 'Bot dalam mode AI tetapi belum bisa membalas. Buka Pengaturan untuk menambahkan API key.',
    });
  }

  async handleIncoming({ accountId, chat, message }) {
    const account = this.store.account(accountId);
    if (!this.shouldReply(chat, account, message)) return;

    const settings = this.store.data.settings;
    if (!settings.geminiApiKey) {
      this.warnMissingKey(accountId);
      return;
    }

    if (this.inflight.has(chat.id)) return;
    this.inflight.add(chat.id);

    const startedAt = Date.now();
    try {
      await this.manager.markRead(accountId, chat);
      await this.manager.sendPresence(accountId, chat.waJid, 'composing');

      const history = this.store
        .messagesFor(chat.id, 24)
        .filter((m) => !m.deleted && !m.revoked && m.text && (m.fromMe || m.hasUserText))
        .slice(-14)
        .map((m) => ({ fromMe: m.fromMe, text: m.text }));

      const nowLabel = new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'Asia/Jakarta',
      }).format(new Date());

      const result = await generateReply({
        apiKey: settings.geminiApiKey,
        model: settings.geminiModel,
        systemPrompt: settings.systemPrompt,
        knowledge: knowledgeFor(settings, account),
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        history,
        context: [
          `Konteks: kamu membalas chat WhatsApp milik "${account.label}" dari kontak bernama "${chat.name}".`,
          'Jawab sebagai perwakilan bisnis, bukan sebagai mesin pencari. Jangan mengarang informasi yang tidak diketahui.',
          `Waktu saat ini: ${nowLabel} (WIB).`,
        ].join(' '),
      });

      const delay = Math.min(Math.max(Number(settings.replyDelayMs) || 0, 0), 5000);
      if (delay > 0) await sleep(delay);
      await this.manager.sendPresence(accountId, chat.waJid, 'paused');
      await this.manager.sendText(accountId, chat, result.text, 'ai');

      this.store.addActivity(
        'bot',
        result.fallback ? `AI membalas ${chat.name} (fallback ${result.model})` : `AI membalas ${chat.name}`,
        { accountId, chatId: chat.id, ms: Date.now() - startedAt },
      );
      this.manager.emit('sync', { reason: 'ai-reply', accountId, chatId: chat.id });
    } catch (err) {
      this.store.addActivity('error', `Bot gagal membalas ${chat.name}: ${err.message}`, {
        accountId,
        chatId: chat.id,
      });
      this.manager.emit('notify', {
        type: 'error',
        title: 'Bot AI gagal membalas',
        text: err.message,
      });
      this.manager.emit('sync', { reason: 'ai-error', accountId, chatId: chat.id });
    } finally {
      this.manager.sendPresence(accountId, chat.waJid, 'paused');
      this.inflight.delete(chat.id);
    }
  }
}
