import { RunTracker } from "../../run-tracker.js";
import { RunSaver, accountKey, browserStorage } from "./run-saver.js";

// One tracker per member; inactive members never keep a GPS watch running.
export class AccountRuns {
  constructor({ api, scope, storage = browserStorage(), resultStorage = browserStorage("sessionStorage"),
    trackerOptions = () => ({}), insecureContext = false }) {
    this.scope = scope;
    this.storage = storage;
    this.trackerOptions = trackerOptions;
    this.insecureContext = insecureContext;
    this.trackers = new Map();
    this.memberId = null;
    this.saver = new RunSaver({ api, scope, storage, resultStorage,
      onSaved: (_result, identity) => this.trackers.get(identity.id)?.tracker?.markSaved() });
  }

  activateSession(user) {
    const id = Number.isSafeInteger(user?.id) && user.id > 0 && user.token ? user.id : null;
    if (id !== this.memberId) this.trackers.get(this.memberId)?.tracker?.suspend();
    this.memberId = id;
    this.saver.setSession(id ? user : null);
    if (!id) return { tracker: null, trackerError: null };
    if (!this.trackers.has(id)) {
      let tracker = null;
      let trackerError = null;
      try {
        tracker = new RunTracker({ ...this.trackerOptions(id), storage: this.storage,
          storageKey: accountKey(this.scope, id, "active") });
      } catch (error) { trackerError = error; }
      if (this.insecureContext && !trackerError)
        trackerError = Object.assign(new Error("insecure_context"), { code: "insecure_context" });
      this.trackers.set(id, { tracker, trackerError });
    }
    return this.trackers.get(id);
  }
}
