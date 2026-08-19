// ===== Session store abstraction =====
// server.js talks only to this interface (get/set/delete/has), never to a
// concrete backend directly. That's what makes it possible to swap the
// in-memory Map for Redis (or anything else) via one env var, with zero
// changes to the route handlers.
//
// NOTE: what's stored per session includes a live GramJS `TelegramClient`
// instance (see server.js), which cannot itself be serialized into Redis.
// The Redis-backed store below persists everything EXCEPT the live client
// object across restarts by keying off `sessionString` — the /auth/resume
// route already knows how to rebuild a client from that. In-flight logins
// (pending phone-code prompts) are inherently tied to the process that
// started them and are always kept in a local in-memory layer regardless of
// which store is configured, since a `TelegramClient` can't survive a
// restart or move to another process.

const { createMemoryStore } = require('./memoryStore');
const { createRedisStore } = require('./redisStore');

function createSessionStore() {
    if (process.env.REDIS_URL) {
        console.log('🗄️  Session store: Redis (REDIS_URL is set)');
        return createRedisStore(process.env.REDIS_URL);
    }
    console.log('🗄️  Session store: in-memory (set REDIS_URL to persist sessions across restarts/instances)');
    return createMemoryStore();
}

module.exports = { createSessionStore };
