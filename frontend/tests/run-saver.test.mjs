import { test } from "node:test";
import assert from "node:assert/strict";
import { RunSaver, accountKey } from "../src/services/run-saver.js";
import { AccountRuns } from "../src/services/account-runs.js";

const points = [{ timestamp: 1700000000, latitude: 37.5, longitude: 127 },
  { timestamp: 1700000060, latitude: 37.501, longitude: 127 }];
const A = { id: 1, token: "token-A" }, B = { id: 2, token: "token-B" };
const storage = () => ({ data: new Map(), getItem(k) { return this.data.get(k) ?? null; },
  setItem(k, v) { this.data.set(k, v); }, removeItem(k) { this.data.delete(k); } });
const error = (status, message) => Object.assign(new Error(message), { status });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

function setup(t, options = {}) {
  const calls = [];
  const api = { token: A.token, me: async ({ token }) => ({ id: token === A.token ? A.id : B.id }),
    submitRun: async (key, coords, { token }) => { calls.push({ key, coords, token }); return { id: calls.length }; } };
  const local = storage(), session = storage();
  const saver = new RunSaver({ api, scope: "https://api.test", storage: local, resultStorage: session, ...options });
  t.after(() => saver.disconnect());
  saver.setSession(A);
  return { api, calls, local, session, saver };
}

test("failed A upload is hidden from B and resumes only after A signs in", async t => {
  const { saver, api, calls } = setup(t);
  const submit = api.submitRun;
  api.submitRun = async () => { throw error(503, "database_busy"); };
  await saver.begin(points);
  const key = saver.getState().pending.key;
  saver.setSession(null);
  api.token = B.token; saver.setSession(B);
  assert.equal(saver.getState().pending, null);
  await saver.save(); assert.equal(calls.length, 0);
  api.submitRun = submit; api.token = A.token; saver.setSession(A);
  await saver.save();
  assert.equal(calls.length, 1); assert.equal(calls[0].token, A.token); assert.equal(calls[0].key, key);
});

test("mutable API token cannot change the owner used for verification or submission", async t => {
  const { saver, api, calls } = setup(t);
  api.token = B.token;
  await saver.begin(points);
  assert.equal(calls[0].token, A.token);
});

test("server identity mismatch blocks submission", async t => {
  const { saver, api, calls } = setup(t);
  api.me = async () => ({ id: B.id });
  await saver.begin(points);
  assert.equal(calls.length, 0);
  assert.equal(saver.getState().error.code, "record_owner_mismatch");
  assert.equal(saver.getState().retryable, false);
});

test("late verification after account switch cannot start an upload", async t => {
  const { saver, api, calls } = setup(t), gate = deferred();
  api.me = () => gate.promise;
  const pending = saver.begin(points); await tick();
  saver.setSession(B); gate.resolve({ id: A.id }); await pending;
  assert.equal(calls.length, 0); assert.equal(saver.getState().ownerId, B.id);
});

test("late A upload response cannot clear B draft or acknowledge B tracker", async t => {
  const acknowledged = [], gate = deferred();
  const { saver, api } = setup(t, { onSaved: (_, owner) => acknowledged.push(owner.id) });
  api.submitRun = () => gate.promise;
  const oldRequest = saver.begin(points); await tick();
  saver.setSession(B);
  api.submitRun = async () => { throw error(400, "invalid_run"); };
  await saver.begin(points.map(p => ({ ...p, timestamp: p.timestamp + 600 })));
  const key = saver.getState().pending.key;
  gate.resolve({ id: 88 }); await oldRequest;
  assert.equal(saver.getState().pending.key, key); assert.equal(saver.getState().result, null);
  assert.deepEqual(acknowledged, []);
});

test("discard invalidates an outstanding response", async t => {
  const gate = deferred(); const { saver, api } = setup(t);
  api.submitRun = () => gate.promise;
  const request = saver.begin(points); await tick();
  assert.equal(saver.discard(), true); gate.resolve({ id: 5 }); await request;
  assert.equal(saver.getState().result, null); assert.equal(saver.getState().pending, null);
});

test("reload retains owner and idempotency key; result is private to owner and server", async t => {
  const { saver, api, local, session } = setup(t);
  api.submitRun = async () => { throw error(400, "invalid_run"); };
  await saver.begin(points); const key = saver.getState().pending.key;
  const reloaded = new RunSaver({ api, scope: saver.scope, storage: local, resultStorage: session });
  t.after(() => reloaded.disconnect());
  reloaded.setSession(B); assert.equal(reloaded.getState().pending, null);
  reloaded.setSession(A); assert.equal(reloaded.getState().pending.key, key);
  api.submitRun = async () => ({ id: 7 }); await reloaded.save();
  reloaded.setSession(B); assert.equal(reloaded.getState().result, null);
  reloaded.setSession(A); assert.equal(reloaded.getState().result.id, 7);
  const otherServer = new RunSaver({ api, scope: "mock", storage: local, resultStorage: session });
  otherServer.setSession(A); assert.equal(otherServer.getState().result, null);
  assert.equal(otherServer.getState().pending, null);
});

test("unowned legacy GPS is quarantined and never imported", async t => {
  const local = storage(); local.setItem("campusrunner.pending-run.v1", JSON.stringify({ key: "old", points }));
  const { saver, calls } = setup(t, { storage: local });
  assert.equal(saver.getState().legacyUnowned, true);
  await saver.save(); assert.equal(calls.length, 0);
  assert.ok(local.getItem("campusrunner.pending-run.v1"));
});

test("quota failure is explicit and volatile draft stays with its owner", async t => {
  const local = storage(); local.setItem = () => { throw new Error("quota"); };
  const { saver, api } = setup(t, { storage: local });
  api.submitRun = async () => { throw error(503, "database_busy"); };
  await saver.begin(points);
  assert.equal(saver.getState().pendingPersisted, false);
  assert.equal(saver.getState().storageWarning.code, "pending_not_persisted");
  saver.setSession(B); assert.equal(saver.getState().pending, null);
  saver.setSession(A); assert.deepEqual(saver.getState().pending.points, points);
  api.submitRun = async () => ({ id: 9 }); await saver.save();
  assert.equal(saver.getState().result.id, 9);
});

test("failed local deletion is reported and retains the pending record", async t => {
  const { saver, local, api } = setup(t);
  api.submitRun = async () => { throw error(400, "invalid_run"); };
  await saver.begin(points); local.removeItem = () => { throw new Error("denied"); };
  assert.equal(saver.discard(), false); assert.ok(saver.getState().pending);
  assert.equal(saver.getState().error.code, "local_delete_failed");
});

test("concurrent save calls submit once with a stable key", async t => {
  const { saver, calls } = setup(t);
  const request = saver.begin(points);
  assert.equal(saver.save(), request); await request;
  assert.equal(calls.length, 1);
});

test("corrupt owned storage cannot be sent", async t => {
  const local = storage(); local.setItem(accountKey("https://api.test", A.id, "pending"), JSON.stringify({ ownerId: B.id, points }));
  const { saver, calls } = setup(t, { storage: local }); await saver.save();
  assert.equal(calls.length, 0); assert.equal(saver.getState().storageWarning.code, "invalid_pending_record");
});

test("logout stops GPS and each member recovers only their own tracker", async () => {
  const local = storage(); let nextId = 0; const watches = new Map();
  const gps = { watchPosition(success) { const id = ++nextId; watches.set(id, success); return id; },
    clearWatch(id) { watches.delete(id); } };
  const core = new AccountRuns({ api: {}, scope: "api", storage: local, resultStorage: storage(),
    trackerOptions: () => ({ geolocation: gps, checkpointIntervalMs: 0 }) });
  const a = core.activateSession(A).tracker;
  const started = a.start();
  for (const callback of watches.values()) callback({ timestamp: points[0].timestamp * 1000,
    coords: { latitude: 37.5, longitude: 127, accuracy: 5 } });
  await started;
  core.activateSession(null); assert.equal(watches.size, 0);
  const b = core.activateSession(B).tracker; assert.equal(b.getPoints().length, 0);
  assert.equal(core.activateSession(A).tracker, a); assert.equal(a.getSnapshot().status, "recovered");
  assert.equal(a.getPoints().length, 1);
  const mock = new AccountRuns({ api: {}, scope: "mock", storage: local, resultStorage: storage(), trackerOptions: () => ({ geolocation: gps }) });
  assert.equal(mock.activateSession(A).tracker.getPoints().length, 0);
  a.dispose(); b.dispose(); mock.activateSession(null);
});
