// TeleGrab Pro — MTProto backend entry point
// Logs in as a real Telegram USER ACCOUNT (not a bot) via GramJS, so downloads
// are limited by Telegram's account-side caps: 2GB normally, 4GB with Premium.
//
// Run locally:   npm install && npm start
// Deploy:        Render / Railway / Fly.io / any host that keeps a long-lived
//                Node process alive (NOT a one-shot serverless function —
//                MTProto needs a persistent TCP connection).
//
// This file just wires real dependencies (GramJS, env vars, the session
// store) into createApp() (see app.js) and starts listening. Keeping it thin
// is what lets app.js be integration-tested with fake Telegram classes
// instead of a real account — see tests/authFlow.test.js.

require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { createSessionStore } = require('./store/sessionStore');
const { createApp } = require('./app');

// ---- Process-level safety net ---------------------------------------------
// This is a long-lived process (that's the whole point — MTProto needs a
// persistent connection), so one unhandled rejection anywhere (a stray
// fire-and-forget promise, a bug in a .catch handler) shouldn't be able to
// take the whole backend down and drop every logged-in user's session.
// Route handlers already have their own try/catch for real error reporting
// to the caller; this is strictly a last-resort net.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled promise rejection (backend stays up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception (backend stays up):', err);
});

const API_ID = parseInt(process.env.API_ID, 10);
const API_HASH = process.env.API_HASH;
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!API_ID || !API_HASH) {
  console.error('❌ Missing API_ID / API_HASH. Copy .env.example to .env and fill them in.');
  console.error('   Get them from https://my.telegram.org/apps');
  process.exit(1);
}

if (ALLOWED_ORIGIN === '*') {
  console.warn('⚠️  ALLOWED_ORIGIN is "*" — anyone on the internet can call this backend.');
  console.warn('⚠️  Set ALLOWED_ORIGIN to your actual frontend URL before sharing this publicly.');
}

const app = createApp({
  apiId: API_ID,
  apiHash: API_HASH,
  allowedOrigin: ALLOWED_ORIGIN,
  TelegramClientClass: TelegramClient,
  StringSessionClass: StringSession,
  store: createSessionStore(),
});

app.listen(PORT, () => console.log(`🚀 TeleGrab MTProto backend listening on :${PORT}`));
