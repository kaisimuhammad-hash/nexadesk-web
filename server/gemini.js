const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.1-pro-preview',
  'gemini-pro-latest',
];

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

const RETRYABLE_STATUS = new Set([404, 408, 429, 500, 502, 503, 504]);

function buildTurns(history) {
  const turns = [];
  for (const m of history) {
    const text = (m.text || '').trim();
    if (!text) continue;
    const role = m.fromMe ? 'model' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.parts[0].text += `\n${text}`;
    } else {
      turns.push({ role, parts: [{ text }] });
    }
  }
  if (!turns.length || turns[0].role !== 'user') {
    turns.unshift({ role: 'user', parts: [{ text: 'Halo' }] });
  }
  return turns;
}

function describeError(message, status) {
  const text = String(message || '');
  if (/free tier is not available/i.test(text)) {
    return [
      'Project Google untuk API key ini tidak mendapat kuota gratis Gemini.',
      'Buat API key baru di Google AI Studio (project baru tanpa billing), atau aktifkan billing pada project tersebut.',
      'Panduan: https://ai.google.dev/gemini-api/docs/troubleshooting#project-unavailable',
    ].join(' ');
  }
  if (/api key not valid/i.test(text)) {
    return 'API key Gemini tidak valid. Salin ulang API key dari Google AI Studio.';
  }
  if (/exceeded your current quota/i.test(text)) {
    return 'Kuota model ini habis. Pilih model Flash Lite atau tunggu kuota harian pulih.';
  }
  return text || `Gemini mengembalikan status ${status}`;
}

async function callModel({ apiKey, model, body }) {
  let res;
  try {
    res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const message =
      err.name === 'TimeoutError' ? 'Gemini tidak merespons (timeout 20 detik).' : `Gagal menghubungi Gemini: ${err.message}`;
    return { ok: false, retryable: true, error: message };
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = describeError(data?.error?.message, res.status);
    return { ok: false, retryable: RETRYABLE_STATUS.has(res.status), error: message, status: res.status };
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    const blocked = data?.promptFeedback?.blockReason;
    return {
      ok: false,
      retryable: false,
      error: blocked ? `Permintaan diblokir Gemini (${blocked}).` : 'Gemini tidak mengembalikan teks.',
    };
  }
  return { ok: true, text };
}

export async function generateReply({
  apiKey,
  model = DEFAULT_MODEL,
  systemPrompt,
  knowledge = '',
  temperature = 0.7,
  maxTokens = 512,
  history = [],
  context = '',
}) {
  if (!apiKey) throw new Error('API key Gemini belum diisi.');

  const knowledgeBlock = knowledge
    ? [
        'Gunakan basis pengetahuan bisnis berikut sebagai rujukan utama saat menjawab.',
        'Jika jawabannya tidak ada di basis pengetahuan ini, jangan mengarang; tawarkan bantuan tim manusia.',
        '',
        '### Basis pengetahuan',
        knowledge,
      ].join('\n')
    : '';

  const system = [systemPrompt, knowledgeBlock, context].filter(Boolean).join('\n\n');
  const body = {
    contents: buildTurns(history),
    generationConfig: {
      temperature: Math.min(Math.max(Number(temperature) || 0, 0), 2),
      maxOutputTokens: Math.min(Math.max(Number(maxTokens) || 512, 64), 4096),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const candidates = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
  let lastError = 'Gemini tidak merespons.';

  for (const candidate of candidates) {
    const result = await callModel({ apiKey, model: candidate, body });
    if (result.ok) return { text: result.text, model: candidate, fallback: candidate !== model };
    lastError = result.error;
    if (!result.retryable) break;
  }

  throw new Error(lastError);
}
