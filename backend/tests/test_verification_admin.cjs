/* Deterministic UI race tests: deliberately complete fetches after cancellation.
 * No browser, third-party package, credentials or running server are required. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../examples/verification-admin.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function row(id, status = 'pending') {
  return { id, status, nickname: `runner-${id}`, university_name: 'Campus', document_type: 'student_card',
    submitted_at: 1000, reason: '', image_available: status === 'pending' };
}
function setup() {
  const ids = new Map(), requests = [], revoked = [], events = {};
  let urlId = 0;
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.disabled = false; }
    append(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return this.children.flatMap(li => li.children); }
    removeAttribute(name) { delete this[name]; }
    replaceWith(next) { ids.set(next.id, next); }
  }
  for (const id of ['base','token','reviewer','status','reason','refresh','previous','next',
    'approve','reject','revoke','queue','photo','heading','details','message','page-info']) ids.set(id, new Element());
  const $ = id => ids.get(id);
  $('base').value = 'http://example.test'; $('token').value = 'admin'; $('status').value = 'pending';
  $('reviewer').value = 'Operator';
  class TestURL extends URL {
    static createObjectURL() { return `blob:test-${++urlId}`; }
    static revokeObjectURL(value) { revoked.push(value); }
  }
  vm.runInNewContext(source, {
    document: { getElementById: $, createElement: () => new Element() },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    URL: TestURL, URLSearchParams, AbortController, Date,
    fetch: (url, options) => {
      const d = deferred(); requests.push({ url, options, ...d }); return d.promise;
    },
  });
  function respond(index, data, status = 200) {
    requests[index].resolve({ ok: status < 400, status, json: async () => data, blob: async () => data });
  }
  async function load(rows) {
    const work = $('refresh').onclick(); respond(requests.length - 1, rows); await work;
  }
  return { $, requests, respond, load, revoked, events };
}

test('changing token, API address or status invalidates in-flight sensitive lists', async () => {
  for (const [id, event, value] of [['token','oninput','new-token'], ['base','oninput','http://other.test'], ['status','onchange','approved']]) {
    const { $, requests, respond } = setup();
    const work = $('refresh').onclick();
    $(id).value = value; $(id)[event]();
    assert.equal(requests[0].options.signal.aborted, true);
    respond(0, [row(1)]); await work;
    assert.equal($('queue').children.length, 0);
    assert.equal($('details').textContent, '');
    assert.equal($('approve').disabled, true);
    assert.equal($('message').textContent, '');
  }
});

test('a late list response cannot replace a newer refresh', async () => {
  const { $, respond } = setup();
  const old = $('refresh').onclick(), latest = $('refresh').onclick();
  respond(1, [row(2)]); await latest;
  respond(0, [row(1)]); await old;
  assert.match($('queue').children[0].children[0].textContent, /runner-2/);
});

test('late photo responses and previous image load events cannot enable another approval', async () => {
  const { $, load, respond, revoked } = setup();
  await load([row(1), row(2)]);
  const first = $('queue').children[0].children[0].onclick();
  respond(1, {}); await first;
  const previousPhoto = $('photo'), oldLoad = previousPhoto.onload;
  previousPhoto.onload(); assert.equal($('approve').disabled, false);
  const second = $('queue').children[1].children[0].onclick();
  oldLoad(); assert.equal($('approve').disabled, true);
  assert.deepEqual(revoked, ['blob:test-1']);
  respond(2, {}); await second;
  oldLoad(); assert.equal($('approve').disabled, true);
  $('photo').onload(); assert.equal($('approve').disabled, false);
  $('photo').onerror(); assert.equal($('approve').disabled, true);
  assert.equal($('photo').hidden, true);
  assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2']);
});

test('photo fetches completing out of selection order or after logout are discarded', async () => {
  const { $, load, respond } = setup();
  await load([row(1), row(2)]);
  const first = $('queue').children[0].children[0].onclick();
  const second = $('queue').children[1].children[0].onclick();
  respond(1, {}); await first;
  assert.equal($('photo').src, undefined);
  $('token').value = ''; $('token').oninput();
  respond(2, {}); await second;
  assert.equal($('photo').src, undefined);
  assert.equal($('approve').disabled, true);
});

test('pagination exposes later approvals and review locks selection and double submission', async () => {
  const { $, requests, load, respond } = setup();
  $('status').value = 'approved';
  await load(Array.from({ length: 51 }, (_, i) => row(i + 1, 'approved')));
  assert.equal($('queue').children.length, 50);
  assert.equal($('next').disabled, false);
  const next = $('next').onclick();
  assert.match(requests[1].url, /limit=51&offset=50/);
  respond(1, [row(51, 'approved'), row(52, 'approved')]); await next;
  assert.equal($('previous').disabled, false); assert.equal($('next').disabled, true);
  await $('queue').children[0].children[0].onclick();
  $('reason').value = 'Correction';
  const work = $('revoke').onclick();
  await $('revoke').onclick();
  await $('queue').children[1].children[0].onclick();
  assert.equal(requests.length, 3);
  assert.match(requests[2].url, /\/51\/revoke$/);
  assert.equal(requests[2].options.headers.Authorization, 'Bearer admin');
  assert.equal($('token').disabled, true);
  assert.equal($('refresh').disabled, true);
  respond(2, {}); await tick();
  respond(3, [row(52, 'approved')]); await work;
  assert.equal($('token').disabled, false);
  assert.equal($('revoke').disabled, true);
  assert.match($('message').textContent, /#51 처리 완료/);
});

test('an emptied later page returns to the first page and pagehide clears photos', async () => {
  const { $, requests, load, respond, events, revoked } = setup();
  await load(Array.from({ length: 51 }, (_, i) => row(i + 1)));
  const next = $('next').onclick(); respond(1, []); await tick();
  assert.match(requests[2].url, /offset=0/); respond(2, [row(1)]); await next;
  const selection = $('queue').children[0].children[0].onclick(); respond(3, {}); await selection;
  $('photo').onload(); events.pagehide();
  assert.deepEqual(revoked, ['blob:test-1']);
  assert.equal($('queue').children.length, 0);
  assert.equal($('photo').src, undefined);
  assert.equal($('approve').disabled, true);
});

test('approval requires a loaded image and a conflict refreshes the final server state', async () => {
  const { $, requests, load, respond } = setup();
  await load([row(1)]);
  const selected = $('queue').children[0].children[0].onclick();
  $('reason').value = 'Checked';
  await $('approve').onclick();
  assert.equal(requests.length, 2); // only list and image requests, no decision
  respond(1, {}); await selected;
  await $('approve').onclick(); assert.equal(requests.length, 2);
  $('photo').onload();
  const review = $('approve').onclick();
  respond(2, { error: 'verification_not_pending' }, 409); await tick();
  respond(3, []); await review;
  assert.match($('message').textContent, /409: verification_not_pending/);
  assert.equal($('approve').disabled, true);
  assert.equal($('photo').src, undefined);
});

test('settings changed during post-review refresh discard both its list and completion message', async () => {
  const { $, requests, load, respond } = setup();
  await load([row(1, 'approved')]);
  await $('queue').children[0].children[0].onclick();
  $('reason').value = 'Correction';
  const review = $('revoke').onclick();
  respond(1, {}); await tick();
  assert.equal(requests.length, 3);
  $('token').value = ''; $('token').oninput();
  respond(2, [row(2, 'approved')]); await review;
  assert.equal($('queue').children.length, 0);
  assert.equal($('message').textContent, '');
});
