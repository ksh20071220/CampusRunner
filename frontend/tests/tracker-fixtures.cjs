const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const trackerModule = import('data:text/javascript;base64,' + readFileSync(join(__dirname, '../run-tracker.js')).toString('base64'));

async function fixture(t, options = {}) {
  const { RunTracker } = await trackerModule;
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  let success, failure, watches = 0;
  const cleared = [];
  const gps = {
    watchPosition: (ok, bad) => { success = ok; failure = bad; return ++watches; },
    clearWatch: id => cleared.push(id),
    position: (seconds, longitude = 127, latitude = 37.5, accuracy = 5) => success({ timestamp: seconds * 1000, coords: { latitude, longitude, accuracy } }),
    fail: code => failure({ code }),
  };
  const tracker = new RunTracker({ geolocation: gps, storage, checkpointIntervalMs: 0, ...options });
  t.after(() => tracker.dispose());
  return { tracker, gps, storage, entries, cleared, watches: () => watches, RunTracker };
}
module.exports = { fixture };
