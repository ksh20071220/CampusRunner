const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./tracker-fixtures.cjs');
const timestamp = Math.floor(Date.now() / 1000) - 120;

test('start, collect two positions, stop: seconds, distance and watch cleanup', async t => {
  const { tracker, gps, cleared } = await fixture(t);
  const ready = tracker.start();
  gps.position(timestamp);
  await ready;
  gps.position(timestamp + 60, 127.001);
  const stopped = tracker.stop();
  assert.equal(stopped.canSubmit, true);
  assert.equal(stopped.elapsedSeconds, 60);
  assert.ok(stopped.distanceMeters > 80 && stopped.distanceMeters < 100);
  assert.equal(stopped.points.length, 2);
  assert.deepEqual(Object.keys(stopped.points[0]).sort(), ['latitude', 'longitude', 'timestamp']);
  assert.deepEqual(cleared, [1]);
});

test('same-second callbacks retain the more accurate fix without duplicate timestamps', async t => {
  const { tracker, gps } = await fixture(t);
  const ready = tracker.start();
  gps.position(timestamp, 127, 37.5, 20); await ready;
  gps.position(timestamp, 127.001, 37.5, 5);
  gps.position(timestamp, 128, 37.5, 30);
  gps.position(timestamp + 1, 127.002);
  assert.deepEqual(tracker.getPoints().map(p => p.timestamp), [timestamp, timestamp + 1]);
  assert.equal(tracker.getPoints()[0].longitude, 127.001);
});

test('old timestamps and invalid coordinates do not enter the upload payload', async t => {
  const { tracker, gps } = await fixture(t);
  const ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp - 1, 127.001);
  gps.position(timestamp + 1, 127.001, 91);
  assert.equal(tracker.getPoints().length, 1);
  gps.position(timestamp + 2, 127.001);
  assert.equal(tracker.stop().canSubmit, true);
});

test('double start does not register a second watch', async t => {
  const { tracker, gps, watches } = await fixture(t);
  const ready = tracker.start();
  assert.equal(tracker.start(), ready);
  gps.position(timestamp); await ready;
  await assert.rejects(tracker.start(), { code: 'already_running' });
  assert.equal(watches(), 1);
});

test('stop before first fix rejects pending start and does not allow submission', async t => {
  const { tracker, cleared } = await fixture(t);
  const ready = tracker.start();
  const rejected = assert.rejects(ready, { code: 'stopped_before_first_fix' });
  assert.equal(tracker.stop().canSubmit, false);
  await rejected;
  assert.deepEqual(cleared, [1]);
});

test('first fix timeout rejects start and clears location watch', async t => {
  const { tracker, cleared } = await fixture(t, { firstFixTimeoutMs: 20 });
  await assert.rejects(tracker.start(), { code: 'first_fix_timeout' });
  assert.equal(tracker.getSnapshot().status, 'error');
  assert.deepEqual(cleared, [1]);
});

test('permission denial stops tracking and preserves already captured positions', async t => {
  const { tracker, gps, cleared } = await fixture(t);
  const ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp + 60, 127.001);
  gps.fail(1);
  assert.equal(tracker.getSnapshot().error.code, 'permission_denied');
  assert.equal(tracker.getPoints().length, 2);
  assert.deepEqual(cleared, [1]);
});

test('unsaved draft survives tracker reconstruction', async t => {
  const { tracker, gps, storage, RunTracker } = await fixture(t);
  const ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp + 60, 127.001);
  const stopped = tracker.stop();
  const recovered = new RunTracker({ geolocation: gps, storage });
  t.after(() => recovered.stop());
  assert.equal(recovered.getSnapshot().status, 'recovered');
  assert.deepEqual(recovered.getPoints(), stopped.points);
  assert.equal(recovered.getSnapshot().distanceMeters, stopped.distanceMeters);
});

test('malformed recovery draft is reported rather than silently accepted', async t => {
  const { storage, gps, RunTracker } = await fixture(t);
  storage.setItem('campusrunner.active-run.v1', '{invalid JSON');
  const recovered = new RunTracker({ geolocation: gps, storage });
  t.after(() => recovered.stop());
  assert.equal(recovered.getSnapshot().error.code, 'saved_run_invalid');
  assert.equal(recovered.getPoints().length, 0);
});

test('point limit stops capture while preserving a submit-ready payload', async t => {
  const { tracker, gps } = await fixture(t, { maxPoints: 2 });
  const ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp + 1, 127.00001);
  gps.position(timestamp + 2, 127.00002);
  assert.equal(tracker.getSnapshot().error.code, 'point_limit');
  const stopped = tracker.stop();
  assert.equal(stopped.points.length, 2);
  assert.equal(stopped.canSubmit, true);
});

test('local storage failure is visible without losing captured coordinates', async t => {
  const storage = { getItem: () => null, setItem: () => { throw Error('quota'); }, removeItem: () => {} };
  const { tracker, gps } = await fixture(t, { storage });
  const ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp + 60, 127.001);
  assert.equal(tracker.getSnapshot().error.code, 'local_storage_failed');
  assert.equal(tracker.stop().points.length, 2);
});

test('returned coordinates cannot mutate the tracker internal data', async t => {
  const { tracker, gps } = await fixture(t);
  const ready = tracker.start(); gps.position(timestamp); await ready;
  const points = tracker.getPoints();
  points[0].latitude = 90;
  assert.equal(tracker.getPoints()[0].latitude, 37.5);
});

test('saved run stays cleared after component cleanup calls dispose', async t => {
  const { tracker, gps, entries, storage, RunTracker } = await fixture(t);
  const ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp + 60, 127.001);
  tracker.stop();
  tracker.markSaved();
  assert.equal(entries.size, 0);
  tracker.dispose();
  assert.equal(entries.size, 0, 'dispose must not recreate the draft of an already saved run');
  tracker.stop();
  tracker.dispose();
  assert.equal(entries.size, 0);
  assert.equal(tracker.getPoints().length, 2, 'the result screen can still read saved points');
  const next = new RunTracker({ geolocation: gps, storage });
  t.after(() => next.dispose());
  assert.equal(next.getSnapshot().status, 'idle');
  assert.equal(next.getPoints().length, 0);
});

test('unsaved run remains recoverable after repeated dispose', async t => {
  const { tracker, gps, storage, RunTracker } = await fixture(t);
  const ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp + 60, 127.001);
  const points = tracker.getPoints();
  tracker.dispose();
  tracker.dispose();
  const recovered = new RunTracker({ geolocation: gps, storage });
  t.after(() => recovered.dispose());
  assert.equal(recovered.getSnapshot().status, 'recovered');
  assert.deepEqual(recovered.getPoints(), points);
});

test('new run after saving creates a new recovery draft without old points', async t => {
  const { tracker, gps, storage, RunTracker } = await fixture(t);
  let ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp + 60, 127.001);
  tracker.stop(); tracker.markSaved(); tracker.dispose();
  ready = tracker.start(); gps.position(timestamp + 120, 127.002); await ready;
  gps.position(timestamp + 180, 127.003);
  const stopped = tracker.stop();
  const recovered = new RunTracker({ geolocation: gps, storage });
  t.after(() => recovered.dispose());
  assert.deepEqual(recovered.getPoints(), stopped.points);
  assert.deepEqual(recovered.getPoints().map(p => p.timestamp), [timestamp + 120, timestamp + 180]);
});

test('failed local deletion stays visible and does not rewrite an acknowledged run', async t => {
  const entries = new Map();
  let writes = 0;
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { ++writes; entries.set(key, value); },
    removeItem: () => { throw Error('storage denied'); } };
  const { tracker, gps } = await fixture(t, { storage });
  const ready = tracker.start(); gps.position(timestamp); await ready;
  gps.position(timestamp + 60, 127.001); tracker.stop();
  const before = writes;
  tracker.markSaved();
  assert.equal(tracker.getSnapshot().error.code, 'local_storage_failed');
  tracker.dispose();
  assert.equal(writes, before);
  assert.equal(tracker.getSnapshot().error.code, 'local_storage_failed');
});
