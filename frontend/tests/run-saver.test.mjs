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


test("failed active deletion preserves GPS and pending key, and reports failure to the caller", async t => {
  const { discardRun } = await import('../src/services/run-actions.js');
  const { RunTracker } = await import('../run-tracker.js');
  const { saver, api, local } = setup(t);
  api.submitRun = async () => { throw error(400, 'invalid_run'); };
  await saver.begin(points); const key = saver.getState().pending.key;
  const activeKey = accountKey(saver.scope, A.id, 'active');
  local.setItem(activeKey, JSON.stringify({version:1,points}));
  const tracker = new RunTracker({ storage:local, storageKey:activeKey, geolocation:{watchPosition(){},clearWatch(){}} });
  t.after(() => tracker.dispose());
  const remove = local.removeItem.bind(local);
  local.removeItem = k => { if(k===activeKey) throw new Error('denied'); remove(k); };
  assert.equal(discardRun({tracker,saver}),false);
  assert.deepEqual(tracker.getPoints(),points); assert.equal(saver.getState().pending.key,key);
  assert.equal(saver.getState().error.code,'local_delete_failed');
  local.removeItem=remove;
  assert.equal(discardRun({tracker,saver}),true);
  assert.equal(local.getItem(activeKey),null); assert.equal(saver.getState().pending,null);
  assert.deepEqual(tracker.getPoints(),[]);
});

test("pending deletion failure after active deletion retains uploadable coordinates", async t => {
  const { discardRun } = await import('../src/services/run-actions.js');
  const { saver, api, local } = setup(t);
  api.submitRun = async () => { throw error(400,'invalid_run'); }; await saver.begin(points);
  const pendingKey = accountKey(saver.scope,A.id,'pending');
  local.removeItem = k => { if(k===pendingKey) throw new Error('denied'); };
  assert.equal(discardRun({tracker:{discardDraft:()=>true},saver}),false);
  assert.deepEqual(saver.getState().pending.points,points);
});

test("saved active cleanup failure is visible even if pending cleanup succeeds", async t => {
  const { saver }=setup(t,{onSaved:()=>false}); await saver.begin(points);
  assert.equal(saver.getState().phase,'saved');
  assert.equal(saver.getState().storageWarning.code,'pending_cleanup_failed');
});

test("quota retry-after delays retries and manual retry cannot bypass the delay", async t => {
  const { saver, api }=setup(t); let calls=0;
  api.submitRun=async()=>{++calls; throw Object.assign(error(429,'run_daily_quota'),{retryAfterSeconds:3600});};
  await saver.begin(points); const key=saver.getState().pending.key;
  assert.ok(saver.getState().nextRetryAt>Date.now()+3590_000);
  await saver.retryNow(); assert.equal(calls,1); assert.equal(saver.getState().pending.key,key);
});

test("request timeout retries the same submission key after a stalled transport", async t => {
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../../backend/examples/api-client.js',import.meta.url));
  const {CampusRunnerApi}=await import('data:text/javascript;base64,'+source.toString('base64'));
  const api=new CampusRunnerApi('https://synthetic.test',{timeoutMs:5}); api.token=A.token;
  let fail=true; const submitted=[];
  t.mock.method(globalThis,'fetch',async(url,opts)=>{
    if(url.endsWith('/api/me')) return {ok:true,status:200,json:async()=>({id:A.id})};
    submitted.push(JSON.parse(opts.body));
    if(fail) return new Promise(()=>{});
    return {ok:true,status:201,json:async()=>({id:1})};
  });
  const {saver}=setup(t,{api}); await saver.begin(points);
  assert.equal(saver.getState().phase,'retrying');
  assert.equal(saver.getState().error.code,'request_timeout');
  fail=false; await saver.retryNow();
  assert.equal(saver.getState().phase,'saved'); assert.equal(submitted[0].key,submitted[1].key);
});

test("complete history compatibility query does not silently stop at 10000",async()=>{
  const {fetchAllRuns}=await import('../src/services/records.js');
  const count=10003;
  const runs=await fetchAllRuns({myRuns:async(limit,offset)=>Array.from({length:Math.max(0,Math.min(limit,count-offset))},(_,i)=>({id:offset+i+1}))});
  assert.equal(runs.length,count);
});

test("record overview uses server aggregates independently of loaded list pages",async()=>{
  const {fetchRecordOverview}=await import('../src/services/records.js');
  const calls=[];
  const data=await fetchRecordOverview({myStats:async(from,to)=>{calls.push({from,to});return {distance_m:10003000,accepted_runs:10003,flagged_runs:1,duration_seconds:3000900,pace_seconds_per_km:300};},myRuns:()=>{throw new Error('must not fetch the entire history');}},'week',1700000000);
  assert.equal(data.total.count,10003); assert.equal(data.total.pace,300);
  assert.equal(data.series.length,8); assert.equal(calls.length,9);
});
