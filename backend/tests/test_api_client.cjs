const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const clientModule = import('data:text/javascript;base64,' + readFileSync(join(__dirname, '../examples/api-client.js')).toString('base64'));

test('run upload and identity check use the captured owner token', async t => {
  const { api, requests } = await setup(t, 200, { id: 1 });
  api.token = 'new-account';
  await api.me({ token: 'original-account' });
  await api.submitRun('stable-key', [], { token: 'original-account' });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer original-account');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer original-account');
  assert.equal(api.token, 'new-account');
});

test('late logout does not clear a newly authenticated account token', async t => {
  const { api, requests } = await setup(t, 204, null);
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    await response;
    return { status: 204, ok: true };
  });
  const loggingOut = api.logout();
  api.token = 'new-account';
  finish(); await loggingOut;
  assert.equal(requests[0].options.headers.Authorization, 'Bearer previous-session');
  assert.equal(api.token, 'new-account');
});

test('stats series requests one bucketed period with the member token', async t => {
  const { api, requests } = await setup(t, 200, []);
  await api.myStatsSeries(1793545200, 1794150000, 'day');
  assert.equal(requests[0].url, 'https://api.example.test/api/me/stats/series?from=1793545200&to=1794150000&bucket=day');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer previous-session');
});

async function setup(t, status, payload) {
  const { CampusRunnerApi } = await clientModule;
  const api = new CampusRunnerApi('https://api.example.test/');
  api.token = 'previous-session';
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return { status, ok: status >= 200 && status < 300, json: async () => payload };
  });
  return { api, requests };
}

test('password change replaces the token with the returned session', async t => {
  const { api, requests } = await setup(t, 200, { id: 1, token: 'replacement-session' });
  const user = await api.changePassword('old-password!', 'new-password!');
  assert.equal(user.id, 1);
  assert.equal(api.token, 'replacement-session');
  assert.equal(requests[0].url, 'https://api.example.test/api/me/password');
  assert.equal(requests[0].options.method, 'PATCH');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer previous-session');
  assert.deepEqual(JSON.parse(requests[0].options.body), { current_password: 'old-password!', new_password: 'new-password!' });
  assert.equal(requests[0].options.credentials, 'omit');
});

test('failed password change preserves the current token and error status', async t => {
  const { api } = await setup(t, 401, { error: 'invalid_credentials' });
  await assert.rejects(api.changePassword('wrong-password!', 'new-password!'), { message: 'invalid_credentials', status: 401 });
  assert.equal(api.token, 'previous-session');
});

test('account deletion sends the explicit confirmation and clears the token', async t => {
  const { api, requests } = await setup(t, 204, null);
  await api.deleteAccount('old-password!');
  assert.equal(api.token, null);
  assert.equal(requests[0].url, 'https://api.example.test/api/me');
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].options.body), { password: 'old-password!', confirmation: 'DELETE' });
});

test('failed account deletion retains the session for retry', async t => {
  const { api } = await setup(t, 500, { error: 'database_error' });
  await assert.rejects(api.deleteAccount('old-password!'), { message: 'database_error', status: 500 });
  assert.equal(api.token, 'previous-session');
});

test('logoutAll clears the token only after success', async t => {
  const { api, requests } = await setup(t, 204, null);
  await api.logoutAll();
  assert.equal(api.token, null);
  assert.equal(requests[0].url, 'https://api.example.test/api/auth/logout-all');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
});

for (const action of ['logoutAll', 'deleteAccount', 'changePassword']) {
  test(`late ${action} rejects stale completion without modifying another session`, async t => {
    const { api } = await setup(t, 204, null);
    let finish;
    t.mock.method(globalThis, 'fetch', async () => {
      await new Promise(resolve => { finish = resolve; });
      return { status: action === 'changePassword' ? 200 : 204, ok: true,
        json: async () => ({ id: 1, token: 'replacement-A' }) };
    });
    const request = action === 'changePassword' ? api.changePassword('old-password!', 'new-password!')
      : action === 'deleteAccount' ? api.deleteAccount('old-password!') : api.logoutAll();
    const rejected = assert.rejects(request, { message: 'session_changed', status: 409 });
    api.token = 'other-account';
    finish(); await rejected;
    assert.equal(api.token, 'other-account');
  });
}

test('same token value after an intervening session still invalidates old account actions', async t => {
  const { api } = await setup(t, 204, null);
  let finish;
  api.request = () => new Promise(resolve => { finish = resolve; });
  const pending = api.logoutAll();
  const rejected = assert.rejects(pending, { message: 'session_changed' });
  api.token = null; api.token = 'previous-session'; finish(null); await rejected;
  assert.equal(api.token, 'previous-session');
});

test('timeout aborts fetch and rejects even when transport never settles', async t => {
  const { api } = await setup(t, 200, {}); api.timeoutMs = 5;
  let signal;
  t.mock.method(globalThis, 'fetch', (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  await assert.rejects(api.me(), { message: 'request_timeout', status: 408 });
  assert.equal(signal.aborted, true);
});

test('timeout covers a stalled response body as well as response headers', async t => {
  const { api } = await setup(t, 200, {}); api.timeoutMs = 5;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  await assert.rejects(api.me(), { message: 'request_timeout', status: 408 });
});

test('caller cancellation releases a hanging request and preserves the token', async t => {
  const { api } = await setup(t, 200, {});
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const controller = new AbortController();
  const request = api.me({ signal: controller.signal });
  const rejected = assert.rejects(request, { message: 'request_cancelled', status: 0 });
  controller.abort(); await rejected;
  assert.equal(api.token, 'previous-session');
});

test('already aborted requests never call fetch', async t => {
  const { api, requests } = await setup(t, 200, {});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.me({ signal: controller.signal }), { message: 'request_cancelled' });
  assert.equal(requests.length, 0);
});

test('proof upload has its own timeout and keeps the binary body', async t => {
  const { api } = await setup(t, 201, {}); api.uploadTimeoutMs = 5;
  const file = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  let options;
  t.mock.method(globalThis, 'fetch', (_url, opts) => { options = opts; return new Promise(() => {}); });
  await assert.rejects(api.submitUniversityProof(file, 'student_card', { consent: true }), { message: 'request_timeout' });
  assert.equal(options.body, file); assert.equal(options.signal.aborted, true);
  assert.equal(options.headers.Authorization, 'Bearer previous-session');
});

test('server retry-after is exposed on the API error', async t => {
  const { api } = await setup(t, 429, { error: 'run_daily_quota' });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 429,
    headers: { get: () => '3600' }, json: async () => ({ error: 'run_daily_quota' }) }));
  await assert.rejects(api.submitRun('key', []), { message: 'run_daily_quota', retryAfterSeconds: 3600 });
});
