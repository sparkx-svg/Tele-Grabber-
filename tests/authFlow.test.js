// ===== Integration tests: auth flow =====
// Exercises the real Express routes end-to-end (real HTTP requests over an
// ephemeral local port) but with a fake TelegramClient/StringSession
// injected via createApp(), so these run with no network access, no real
// Telegram account, and no API credentials.
//
// Run with: npm test  (or: node --test tests/)

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');

// ---- Fakes -----------------------------------------------------------------

class FakeStringSession {
  constructor(value = '') {
    this.value = value;
  }
}

/**
 * Builds a fake TelegramClient class whose behavior is driven by `scenario`.
 * Mimics just enough of GramJS's real client.start() contract (calling the
 * phoneNumber/phoneCode/password/onError callbacks the same way GramJS does)
 * for the routes in app.js to exercise their real logic.
 */
function makeFakeTelegramClientClass(scenario) {
  return class FakeTelegramClient {
    constructor(session, apiId, apiHash, opts) {
      this.session = { save: () => 'FAKE_SESSION_STRING' };
      this._session = session;
      this.apiId = apiId;
      this.apiHash = apiHash;
      this.opts = opts;
    }

    async connect() {
      if (scenario.failConnect) throw new Error('ECONNREFUSED (simulated)');
    }

    async disconnect() {}

    async isUserAuthorized() {
      return this._session.value === 'VALID_SAVED_SESSION';
    }

    async start({ phoneNumber, phoneCode, password, onError }) {
      await phoneNumber();
      const code = await phoneCode();
      if (scenario.expectedCode && code !== scenario.expectedCode) {
        const err = new Error('PHONE_CODE_INVALID');
        await onError(err);
        throw err;
      }
      if (scenario.requires2FA) {
        const pass = await password();
        if (scenario.expectedPassword && pass !== scenario.expectedPassword) {
          const err = new Error('PASSWORD_INVALID');
          await onError(err);
          throw err;
        }
      }
      return true;
    }

    async getEntity() {
      return { id: 1 };
    }

    async getMessages() {
      return [];
    }
  };
}

function makeFakeStore() {
  const data = new Map();
  return {
    async get(id) {
      return data.get(id);
    },
    async set(id, value) {
      data.set(id, value);
    },
    async delete(id) {
      data.delete(id);
    },
  };
}

async function startTestServer(scenario = {}) {
  const app = createApp({
    apiId: 12345,
    apiHash: 'fake-hash',
    allowedOrigin: '*',
    TelegramClientClass: makeFakeTelegramClientClass(scenario),
    StringSessionClass: FakeStringSession,
    store: makeFakeStore(),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---- Tests -------------------------------------------------------------

describe('createApp() validation', () => {
  test('throws without apiId/apiHash', () => {
    assert.throws(() => createApp({ TelegramClientClass: class {}, StringSessionClass: class {}, store: makeFakeStore() }));
  });

  test('throws without a store', () => {
    assert.throws(() => createApp({ apiId: 1, apiHash: 'x', TelegramClientClass: class {}, StringSessionClass: class {} }));
  });
});

describe('POST /auth/start', () => {
  let ctx;
  before(async () => { ctx = await startTestServer({ expectedCode: '12345' }); });
  after(() => ctx.close());

  test('rejects a missing phone number', async () => {
    const res = await fetch(`${ctx.baseUrl}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /phone is required/);
  });

  test('kicks off the login flow and returns a sessionId', async () => {
    const res = await fetch(`${ctx.baseUrl}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+15551234567' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sessionId);
    assert.equal(body.needs, 'code');
  });
});

describe('POST /auth/submit — field validation', () => {
  // This is the exact bug class flagged in code review: a frontend/backend
  // `field` name mismatch (e.g. sending "pin" instead of "password") should
  // fail loudly and immediately, not hang waiting on a pending resolver that
  // will never be called.
  let ctx;
  before(async () => { ctx = await startTestServer({ expectedCode: '12345' }); });
  after(() => ctx.close());

  test('rejects a field outside the code/password union', async () => {
    const res = await fetch(`${ctx.baseUrl}/auth/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'irrelevant', field: 'pin', value: '1234' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /field must be one of/);
  });

  test('rejects an unknown sessionId even with a valid field', async () => {
    const res = await fetch(`${ctx.baseUrl}/auth/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'does-not-exist', field: 'code', value: '12345' }),
    });
    assert.equal(res.status, 404);
  });
});

describe('full login flow — no 2FA', () => {
  let ctx;
  before(async () => { ctx = await startTestServer({ expectedCode: '12345' }); });
  after(() => ctx.close());

  test('start -> submit correct code -> logged in with a session string', async () => {
    const startRes = await fetch(`${ctx.baseUrl}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+15551234567' }),
    });
    const { sessionId } = await startRes.json();

    const submitRes = await fetch(`${ctx.baseUrl}/auth/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, field: 'code', value: '12345' }),
    });
    assert.equal(submitRes.status, 200);
    const body = await submitRes.json();
    assert.equal(body.status, 'logged_in');
    assert.equal(body.sessionString, 'FAKE_SESSION_STRING');

    const statusRes = await fetch(`${ctx.baseUrl}/auth/status?sessionId=${sessionId}`);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.loggedIn, true);
  });

  test('wrong code surfaces the backend error instead of hanging', async () => {
    const startRes = await fetch(`${ctx.baseUrl}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+15559999999' }),
    });
    const { sessionId } = await startRes.json();

    const submitRes = await fetch(`${ctx.baseUrl}/auth/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, field: 'code', value: 'wrong-code' }),
    });
    assert.equal(submitRes.status, 400);
    const body = await submitRes.json();
    assert.match(body.error, /PHONE_CODE_INVALID/);
  });
});

describe('full login flow — with 2FA', () => {
  let ctx;
  before(async () => { ctx = await startTestServer({ expectedCode: '12345', requires2FA: true, expectedPassword: 'hunter2' }); });
  after(() => ctx.close());

  test('start -> submit code (needs password) -> submit password -> logged in', async () => {
    const startRes = await fetch(`${ctx.baseUrl}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+15551234567' }),
    });
    const { sessionId } = await startRes.json();

    const codeRes = await fetch(`${ctx.baseUrl}/auth/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, field: 'code', value: '12345' }),
    });
    const codeBody = await codeRes.json();
    assert.equal(codeBody.status, 'pending');
    assert.equal(codeBody.needs, 'password');

    const passRes = await fetch(`${ctx.baseUrl}/auth/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, field: 'password', value: 'hunter2' }),
    });
    const passBody = await passRes.json();
    assert.equal(passBody.status, 'logged_in');
  });
});

describe('POST /auth/resume', () => {
  let ctx;
  before(async () => { ctx = await startTestServer({}); });
  after(() => ctx.close());

  test('rejects a missing sessionString', async () => {
    const res = await fetch(`${ctx.baseUrl}/auth/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test('resumes with a valid saved session string', async () => {
    const res = await fetch(`${ctx.baseUrl}/auth/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionString: 'VALID_SAVED_SESSION' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'logged_in');
  });

  test('rejects an invalid/expired saved session string', async () => {
    const res = await fetch(`${ctx.baseUrl}/auth/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionString: 'GARBAGE' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('GET /download', () => {
  let ctx;
  before(async () => { ctx = await startTestServer({}); });
  after(() => ctx.close());

  test('requires an active login', async () => {
    const res = await fetch(`${ctx.baseUrl}/download?sessionId=nope&link=${encodeURIComponent('https://t.me/foo/1')}`);
    assert.equal(res.status, 401);
  });
});

describe('POST /auth/logout', () => {
  let ctx;
  before(async () => { ctx = await startTestServer({}); });
  after(() => ctx.close());

  test('always returns ok, even for an unknown session', async () => {
    const res = await fetch(`${ctx.baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'unknown' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });
});
