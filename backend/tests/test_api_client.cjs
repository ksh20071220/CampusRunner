const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const clientModule = import('data:text/javascript;base64,' + readFileSync(join(__dirname, '../examples/api-client.js')).toString('base64'));

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
