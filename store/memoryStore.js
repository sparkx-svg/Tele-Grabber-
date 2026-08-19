// ===== In-memory session metadata store =====
// Fine for local dev / a single-instance prototype. Lost on restart and not
// shared across instances — see redisStore.js for the production option.
function createMemoryStore() {
    const map = new Map();

    return {
        async get(sessionId) {
            return map.get(sessionId) || null;
        },
        async set(sessionId, data) {
            map.set(sessionId, data);
        },
        async delete(sessionId) {
            map.delete(sessionId);
        },
        async has(sessionId) {
            return map.has(sessionId);
        },
    };
}

module.exports = { createMemoryStore };
