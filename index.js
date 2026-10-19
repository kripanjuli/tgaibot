import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import TelegramBot from 'node-telegram-bot-api';
import pg from 'pg';

const { Pool } = pg;
const {
  NVIDIA_API_KEY, TELEGRAM_BOT_TOKEN, DATABASE_URL,
  ADMIN_TELEGRAM_IDS = '', FREE_MODELS = '',
  ALLOWED_TELEGRAM_USER_IDS = '', PORT = 10000
} = process.env;

if (!NVIDIA_API_KEY || !TELEGRAM_BOT_TOKEN || !DATABASE_URL) {
  console.error('Set NVIDIA_API_KEY, TELEGRAM_BOT_TOKEN, and DATABASE_URL.');
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 120_000,
  maxRetries: 2
});
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000
});
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const app = express();
app.get('/', (_req, res) => res.send('NVIDIA Telegram AI bot is running 🤖'));
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});
app.listen(Number(PORT), '0.0.0.0', () => console.log(`Health server listening on ${PORT}`));

const admins = new Set(ADMIN_TELEGRAM_IDS.split(',').map(s => s.trim()).filter(Boolean));
const allowed = new Set(ALLOWED_TELEGRAM_USER_IDS.split(',').map(s => s.trim()).filter(Boolean));
const freeModels = new Set(FREE_MODELS.split(',').map(s => s.trim()).filter(Boolean));
const cache = { models: [], at: 0 };
const PAGE_SIZE = 8;
const MAX_HISTORY = 16;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      telegram_user_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT 'z-ai/glm-5.3-flash',
      model_locked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_user_id_id_idx
      ON chat_messages (telegram_user_id, id DESC);
  `);
  console.log('PostgreSQL schema ready.');
}

const userId = msg => String(msg.from?.id ?? '');
const chatId = msg => String(msg.chat.id);
function permitted(msg) {
  if (!msg.from) return false;
  return !allowed.size || allowed.has(userId(msg));
}
function admin(msg) { return admins.has(userId(msg)); }

async function getSettings(msg) {
  const uid = userId(msg);
  await pool.query(
    `INSERT INTO user_settings (telegram_user_id, chat_id)
     VALUES ($1, $2) ON CONFLICT (telegram_user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id`,
    [uid, chatId(msg)]
  );
  const { rows } = await pool.query('SELECT * FROM user_settings WHERE telegram_user_id=$1', [uid]);
  return rows[0];
}
async function setSetting(msg, field, value) {
  const column = field === 'model' ? 'model_id' : 'model_locked';
  await pool.query(`UPDATE user_settings SET ${column}=$1, updated_at=NOW() WHERE telegram_user_id=$2`,
    [value, userId(msg)]);
}
async function getModels(force = false) {
  if (!force && cache.models.length && Date.now() - cache.at < 300_000) return cache.models;
  const response = await openai.models.list();
  cache.models = (response.data ?? []).map(m => m.id).filter(Boolean).sort();
  cache.at = Date.now();
  return cache.models;
}
function keyboard(models, page, settings) {
  const pages = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const start = page * PAGE_SIZE;
  const rows = models.slice(start, start + PAGE_SIZE).map((id, i) => [{
    text: `${id === settings.model_id ? '✅ ' : ''}${freeModels.has(id) ? '🆓 ' : '❔ '}${id.length > 42 ? id.slice(0, 39) + '…' : id}`,
    callback_data: `pick|${page}|${start + i}`   // index-based: always short
  }]);
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Previous', callback_data: `page|${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'Next ➡️', callback_data: `page|${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: settings.model_locked ? '🔒 Locked' : '🔐 Lock selected model', callback_data: 'togglelock' }]);
  return { inline_keyboard: rows };
}
async function showModels(msg, page = 0, editId = null) {
  const models = await getModels();
  if (!models.length) throw new Error('No models returned for this API key.');
  const settings = await getSettings(msg);
  const pages = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
  const text = `🤖 *NVIDIA models*\nSelected: \`${settings.model_id}\`\nSelection: ${settings.model_locked ? '🔒 locked' : '🔓 unlocked'}\n\n🆓 = configured as free by administrator. ❔ = pricing unverified.\nPage ${Math.min(page + 1, pages)}/${pages}`;
  const opts = { parse_mode: 'Markdown', reply_markup: keyboard(models, page, settings) };
  if (editId) return bot.editMessageText(text, { chat_id: msg.chat.id, message_id: editId, ...opts }).catch(() => {});
  return bot.sendMessage(msg.chat.id, text, opts);
}
async function sendLong(chat, content) {
  const chunks = content.match(/[\s\S]{1,3900}/g) || ['(Empty response)'];
  for (const part of chunks) await bot.sendMessage(chat, part);
}

bot.onText(/^\/start(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return bot.sendMessage(msg.chat.id, '⛔ Access denied.');
  const s = await getSettings(msg);
  await bot.sendMessage(msg.chat.id,
    `👋 *NVIDIA AI Bot*\n\nSelected model: \`${s.model_id}\`\nLock: ${s.model_locked ? '🔒 locked' : '🔓 unlocked'}\n\n/models — browse models\n/model — current model\n/lock — lock selection\n/unlock — unlock selection\n/reset — clear saved conversation\n/admin — admin controls\n/help — commands`,
    { parse_mode: 'Markdown' });
});
bot.onText(/^\/help(?:@\w+)?$/, msg => {
  if (permitted(msg)) bot.sendMessage(msg.chat.id, '/models, /model, /lock, /unlock, /reset, /admin, /stats');
});
bot.onText(/^\/models(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return bot.sendMessage(msg.chat.id, '⛔ Access denied.');
  try { await showModels(msg); } catch (e) { console.error(e); bot.sendMessage(msg.chat.id, `Model list error: ${e.message}`); }
});
bot.onText(/^\/model(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return;
  const s = await getSettings(msg);
  bot.sendMessage(msg.chat.id, `Model: ${s.model_id}\nLock: ${s.model_locked ? '🔒 locked' : '🔓 unlocked'}\nPricing: ${freeModels.has(s.model_id) ? '🆓 configured free' : '❔ not verified'}`);
});
bot.onText(/^\/lock(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return;
  await getSettings(msg); await setSetting(msg, 'lock', true);
  bot.sendMessage(msg.chat.id, '🔒 Your model selection is locked.');
});
bot.onText(/^\/unlock(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return;
  await getSettings(msg); await setSetting(msg, 'lock', false);
  bot.sendMessage(msg.chat.id, '🔓 Model selection unlocked.');
});
bot.onText(/^\/reset(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return;
  await pool.query('DELETE FROM chat_messages WHERE telegram_user_id=$1', [userId(msg)]);
  bot.sendMessage(msg.chat.id, '🧹 Your saved conversation history has been cleared.');
});
bot.onText(/^\/admin(?:@\w+)?$/, async msg => {
  if (!admin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS users FROM user_settings');
  bot.sendMessage(msg.chat.id, `👑 *Admin panel*\nRegistered users: ${rows[0].users}\n\n/stats — usage stats\n/broadcast <message> — send a message to registered users`, { parse_mode: 'Markdown' });
});
bot.onText(/^\/stats(?:@\w+)?$/, async msg => {
  if (!admin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const { rows } = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM user_settings) AS users,
    (SELECT COUNT(*)::int FROM chat_messages WHERE role='user') AS user_messages,
    (SELECT COUNT(DISTINCT model_id)::int FROM user_settings) AS models_in_use`);
  bot.sendMessage(msg.chat.id, `👑 Stats\nUsers: ${rows[0].users}\nUser messages saved: ${rows[0].user_messages}\nModels in use: ${rows[0].models_in_use}`);
});
bot.onText(/^\/broadcast(?:@\w+)?\s+([\s\S]+)/, async (msg, match) => {
  if (!admin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Admin only.');
  const { rows } = await pool.query('SELECT chat_id FROM user_settings');
  let sent = 0;
  for (const row of rows) {
    try { await bot.sendMessage(row.chat_id, match[1].slice(0, 3900)); sent++; }
    catch (e) { console.error('Broadcast failed for chat', row.chat_id, e.message); }
  }
  bot.sendMessage(msg.chat.id, `Broadcast attempted. Sent: ${sent}/${rows.length}`);
});

bot.on('callback_query', async q => {
  if (!q.message) return bot.answerCallbackQuery(q.id, { text: 'Message unavailable', show_alert: true }).catch(() => {});
  // The message author is the bot — use the clicker instead.
  const msg = { ...q.message, from: q.from };
  if (!permitted(msg)) return bot.answerCallbackQuery(q.id, { text: 'Access denied', show_alert: true });
  try {
    const s = await getSettings(msg);
    if (q.data.startsWith('page|')) {
      await showModels(msg, Number(q.data.split('|')[1]), msg.message_id);
    } else if (q.data.startsWith('pick|')) {
      if (s.model_locked) return bot.answerCallbackQuery(q.id, { text: 'Locked. Use /unlock first.', show_alert: true });
      const parts = q.data.split('|');
      const page = Number(parts[1]);
      const idx = Number(parts[2]);
      const models = await getModels();
      const id = models[idx];
      if (!id) throw new Error('Model no longer available.');
      await setSetting(msg, 'model', id);
      await bot.answerCallbackQuery(q.id, { text: 'Model selected' });
      await showModels(msg, page, msg.message_id);
    } else if (q.data === 'togglelock') {
      await setSetting(msg, 'lock', !s.model_locked);
      await bot.answerCallbackQuery(q.id, { text: s.model_locked ? 'Unlocked' : 'Locked' });
      await showModels(msg, 0, msg.message_id);
    }
  } catch (e) {
    console.error('Callback error:', e);
    await bot.answerCallbackQuery(q.id, { text: 'Action failed', show_alert: true }).catch(() => {});
  }
});

bot.on('message', async msg => {
  const text = msg.text?.trim();
  if (!text || text.startsWith('/') || !permitted(msg)) return;
  const uid = userId(msg);
  try {
    const settings = await getSettings(msg);
    await pool.query('INSERT INTO chat_messages (telegram_user_id, role, content) VALUES ($1,$2,$3)', [uid, 'user', text]);
    const { rows } = await pool.query(
      'SELECT role, content FROM chat_messages WHERE telegram_user_id=$1 ORDER BY id DESC LIMIT $2',
      [uid, MAX_HISTORY]
    );
    const messages = rows.reverse();
    const status = await bot.sendMessage(msg.chat.id, `⏳ Thinking with ${settings.model_id}…`);
    let output = '';
    try {
      const stream = await openai.chat.completions.create({
        model: settings.model_id, messages, temperature: 0.5, top_p: 1,
        max_tokens: 1024, stream: true
      });
      for await (const chunk of stream) output += chunk.choices?.[0]?.delta?.content || '';
      if (!output.trim()) output = '(The model returned an empty response.)';
      await pool.query('INSERT INTO chat_messages (telegram_user_id, role, content) VALUES ($1,$2,$3)', [uid, 'assistant', output]);
      await bot.deleteMessage(msg.chat.id, status.message_id).catch(() => {});
      await sendLong(msg.chat.id, output);
    } catch (e) {
      console.error('Inference error:', e?.status, e?.message || e);
      await bot.editMessageText(`❌ Model request failed: ${String(e?.message || e).slice(0, 700)}`, {
        chat_id: msg.chat.id, message_id: status.message_id
      }).catch(() => {});
    }
  } catch (e) {
    console.error('Message/database error:', e);
    bot.sendMessage(msg.chat.id, '❌ Service error. Please try again later.').catch(() => {});
  }
});
bot.on('polling_error', e => console.error('Telegram polling error:', e.message));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
async function shutdown() {
  try { await bot.stopPolling(); } catch {}
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

for (let attempt = 1; ; attempt++) {
  try { await initDb(); break; }
  catch (e) {
    console.error(`DB init failed (attempt ${attempt}):`, e.message);
    if (attempt >= 10) { console.error('Giving up on database init.'); process.exit(1); }
    await new Promise(r => setTimeout(r, 3000));
  }
}
console.log('Telegram bot polling started.');