// ===== Redis-backed session metadata store =====
// Persists session metadata (loggedIn / needs / error / sessionString) so it
// survives process restarts and is visible to every server instance behind
// a load balancer. `ioredis` is required lazily, so it's only a hard
// dependency when REDIS_URL is actually set — installs stay light for
// anyone running the in-memory default.
const KEY_PREFIX = 'telegrab:session:';
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — matches how long a saved login should stay resumable

function createRedisStore(redisUrl) {
    let Redis;
    try {
        Redis = require('ioredis');
    } catch {
        throw new Error(
            'REDIS_URL is set but the "ioredis" package is not installed. Run `npm install ioredis`.'
        );
    }

    const redis = new Redis(redisUrl);
    redis.on('error', (err) => console.error('❌ Redis error:', err.message));

    const key = (sessionId) => `${KEY_PREFIX}${sessionId}`;

    return {
        async get(sessionId) {
            const raw = await redis.get(key(sessionId));
            return raw ? JSON.parse(raw) : null;
        },
        async set(sessionId, data) {
            await redis.set(key(sessionId), JSON.stringify(data), 'EX', TTL_SECONDS);
        },
        async delete(sessionId) {
            await redis.del(key(sessionId));
        },
        async has(sessionId) {
            return (await redis.exists(key(sessionId))) === 1;
        },
    };
}

module.exports = { createRedisStore };
