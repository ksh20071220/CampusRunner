import { test } from "node:test";
import assert from "node:assert/strict";
import { UniversityVerification } from "../src/services/university-verification.js";
import { inspectProof, MAX_PROOF_BYTES } from "../src/services/verification-files.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lJ8AAAAASUVORK5CYII=", "base64");
const proof = () => new Blob([PNG], { type: "image/png" });
const A = { id: 1, token: "token-A", nickname: "A", university_id: 1, university_name: "테스트대학", university_verified: false, verification_status: "not_submitted" };
const problem = (code, status) => Object.assign(new Error(code), { code, status });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const request = (id = 1, status = "pending") => ({ id, member_id: 1, university_id: 1, university_name: "테스트대학", document_type: "student_card", status,
  submitted_at: 1700000000, expires_at: 1700604800, reviewed_at: null, reason: "", image_available: status === "pending" });

async function setup(t, initial = []) {
  let rows = initial.map(row => ({ ...row }));
  let profile = { ...A, verification_status: rows[0]?.status || "not_submitted", university_verified: rows[0]?.status === "approved" };
  const calls = [], synced = [], authErrors = [];
  const api = {
    token: A.token,
    me: async options => { calls.push(["me", options]); return { ...profile }; },
    universityVerifications: async (limit, offset, options) => { calls.push(["list", options, offset]); return rows.slice(offset, offset + limit).map(row => ({ ...row })); },
    submitUniversityProof: async (_file, type, options) => {
      calls.push(["submit", options]);
      const row = { ...request(Math.max(0, ...rows.map(row => row.id)) + 1), document_type: type };
      rows.unshift(row); profile = { ...profile, verification_status: "pending" };
      return { ...row };
    },
    cancelUniversityVerification: async (id, options) => {
      calls.push(["cancel", options]);
      const row = rows.find(item => item.id === id);
      Object.assign(row, { status: "cancelled", reason: "withdrawn_by_member", image_available: false });
      profile = { ...profile, verification_status: "cancelled" };
      return { ...row };
    },
  };
  const store = new UniversityVerification({ api, user: A, onProfile: (...args) => synced.push(args), onAuthError: error => authErrors.push(error) });
  t.after(() => store.disconnect()); store.connect(); await store.refresh();
  return { api, store, calls, synced, authErrors, getRows: () => rows,
    replace: (next, nextProfile) => { rows = next; if (nextProfile) profile = { ...profile, ...nextProfile }; } };
}

test("proof inspection accepts PNG/JPEG and rejects empty, HEIC, oversized and disguised files", async () => {
  assert.deepEqual(await inspectProof(proof()), { width: 1, height: 1 });
  const jpeg = new Blob([Uint8Array.from([255,216,255,192,0,11,8,1,224,2,128,1,1,17,0,255,217])], { type: "image/jpeg" });
  assert.deepEqual(await inspectProof(jpeg), { width: 640, height: 480 });
  await assert.rejects(inspectProof(new Blob([], { type: "image/png" })), { code: "proof_file_required" });
  await assert.rejects(inspectProof(new Blob([PNG], { type: "image/heic" })), { code: "jpeg_or_png_required" });
  await assert.rejects(inspectProof(new Blob([new Uint8Array(MAX_PROOF_BYTES + 1)], { type: "image/png" })), { code: "image_too_large" });
  await assert.rejects(inspectProof(new Blob([PNG], { type: "image/jpeg" })), { code: "invalid_image" });
});

test("image dimensions are bounded before preview decoding", async () => {
  const bytes = Buffer.from(PNG); bytes.writeUInt32BE(16000, 16);
  await assert.rejects(inspectProof(new Blob([bytes], { type: "image/png" })), { code: "proof_dimensions_exceeded" });
  bytes.writeUInt32BE(10000,16); bytes.writeUInt32BE(5000,20);
  await assert.rejects(inspectProof(new Blob([bytes], { type: "image/png" })), { code: "proof_dimensions_exceeded" });
});

test("upload requires explicit consent and never posts invalid files", async t => {
  const { store, calls } = await setup(t);
  await store.submit(proof(), "student_card", false);
  assert.equal(store.getState().error.code, "verification_consent_required");
  await store.submit(new Blob(["bad"], { type: "image/png" }), "student_card", true);
  assert.equal(store.getState().error.code, "invalid_image");
  assert.equal(calls.filter(([type]) => type === "submit").length, 0);
});

test("double submission posts once, updates profile and blocks another pending request", async t => {
  const { store, api, calls, synced } = await setup(t), gate = deferred();
  const submit = api.submitUniversityProof;
  api.submitUniversityProof = async (...args) => { await gate.promise; return submit(...args); };
  const first = store.submit(proof(), "student_card", true);
  await store.submit(proof(), "student_card", true);
  gate.resolve(); await first;
  assert.equal(calls.filter(([type]) => type === "submit").length, 1);
  assert.equal(store.getState().profile.verification_status, "pending");
  assert.equal(store.getState().busy, null);
  assert.equal(synced.at(-1)[1], A.token);
  await store.submit(proof(), "student_card", true);
  assert.equal(calls.filter(([type]) => type === "submit").length, 1);
});

test("cancel keeps history and allows a new document submission", async t => {
  const { store, calls } = await setup(t, [request()]);
  const cancelled = await store.cancel(1);
  assert.equal(cancelled.status, "cancelled"); assert.equal(store.getState().rows[0].image_available, false);
  await store.submit(proof(), "admission_letter", true);
  assert.equal(store.getState().rows.length, 2);
  assert.equal(store.getState().rows[0].document_type, "admission_letter");
  assert.equal(calls.find(([type]) => type === "cancel")[1].token, A.token);
});

test("rejection, expiry and revocation allow resubmission; approved members cannot upload", async t => {
  for (const status of ["rejected", "expired", "revoked"]) {
    const { store } = await setup(t, [{ ...request(1,status), reason: "다시 확인해 주세요 <script>example</script>" }]);
    assert.match(store.getState().rows[0].reason, /<script>/);
    assert.ok(await store.submit(proof(), "enrollment_certificate", true));
  }
  const { store, calls } = await setup(t,[request(1,"approved")]);
  await store.submit(proof(),"student_card",true);
  assert.equal(calls.filter(([type])=>type==="submit").length,0);
});

test("timeout after server commit reconciles pending state without submitting twice", async t => {
  const { store, api, calls } = await setup(t);
  const submit = api.submitUniversityProof;
  api.submitUniversityProof = async (...args) => { await submit(...args); throw problem("request_timeout",408); };
  const received = await store.submit(proof(),"student_card",true);
  assert.equal(received.status,"pending"); assert.equal(store.getState().uncertain,false);
  assert.equal(store.getState().error,null);
  assert.equal(calls.filter(([type])=>type==="submit").length,1);
});

test("unknown upload outcome blocks resubmission until a successful state refresh", async t => {
  const { store, api } = await setup(t);
  api.submitUniversityProof = async () => { throw new TypeError("offline"); };
  const list = api.universityVerifications;
  api.universityVerifications = async () => { throw new TypeError("offline"); };
  await store.submit(proof(),"student_card",true);
  assert.equal(store.getState().uncertain,true);
  assert.equal(await store.submit(proof(),"student_card",true),null);
  api.universityVerifications=list; await store.refresh();
  assert.equal(store.getState().uncertain,false); assert.equal(store.getState().fresh,true);
});

test("confirmed upload is retained when the follow-up refresh fails", async t => {
  const { store, api } = await setup(t);
  api.universityVerifications=async()=>{throw new TypeError("offline");};
  assert.ok(await store.submit(proof(),"student_card",true));
  assert.equal(store.getState().rows[0].status,"pending");
  assert.equal(store.getState().profile.verification_status,"pending");
  assert.equal(store.getState().fresh,false);
});

test("a newer refresh wins over a late older response", async t => {
  const { store, api, replace } = await setup(t), gate = deferred();
  const list=api.universityVerifications;
  api.universityVerifications=()=>gate.promise;
  const older=store.refresh(); await tick();
  replace([request(2,"rejected")],{verification_status:"rejected"});
  api.universityVerifications=list; await store.refresh();
  gate.resolve([request(1)]); await older;
  assert.equal(store.getState().rows[0].id,2);
});

test("logout/account switch invalidates metadata and mutation callbacks", async t => {
  const { store, api, synced, authErrors } = await setup(t), gate=deferred();
  synced.length=0;
  api.universityVerifications=()=>gate.promise;
  const loading=store.refresh(); await tick(); store.disconnect(); api.token="token-B";
  gate.resolve([request()]); await loading;
  assert.equal(synced.length,0); assert.equal(authErrors.length,0);
  assert.equal(store.getState().rows.length,0);
});

test("owner mismatch is rejected before private metadata is applied", async t => {
  const { store, api }=await setup(t);
  api.universityVerifications=async()=>[{...request(),member_id:2}];
  await store.refresh();
  assert.equal(store.getState().error.code,"record_owner_mismatch");
  assert.deepEqual(store.getState().rows,[]);
});

test("history supports pages beyond the first 20 entries", async t => {
  const rows=Array.from({length:23},(_,i)=>request(23-i,"rejected"));
  const {store}=await setup(t,rows);
  assert.equal(store.getState().rows.length,20); assert.equal(store.getState().hasMore,true);
  await store.refresh(true);
  assert.equal(store.getState().rows.length,23); assert.equal(store.getState().hasMore,false);
});

test("mock mode never stores proof image content or its filename", async t => {
  const saved=Object.getOwnPropertyDescriptor(globalThis,"localStorage"); const data=new Map();
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}});
  t.after(()=>{if(saved)Object.defineProperty(globalThis,"localStorage",saved);else delete globalThis.localStorage;});
  const {MockApi}=await import("../src/mock/mock-api.js"); const api=new MockApi();
  await api.register("인증테스트","test-password!",1);
  const file=new Blob([PNG,"PRIVATE_PHOTO_MARKER"],{type:"image/png"}); Object.defineProperty(file,"name",{value:"private-student-card.png"});
  const row=await api.submitUniversityProof(file,"student_card",{consent:true});
  assert.equal(row.status,"pending"); assert.equal(row.image_available,false);
  const serialized=[...data.values()].join("");
  assert.ok(!serialized.includes("PRIVATE_PHOTO_MARKER")); assert.ok(!serialized.includes("private-student-card.png"));
  await api.cancelUniversityVerification(row.id);
  assert.equal((await api.me()).verification_status,"cancelled");
});


test("account switch during file inspection cannot start a delayed upload", async t => {
  const {store,api,calls,synced}=await setup(t), gate=deferred(); synced.length=0;
  const file=proof(); const contents=await file.arrayBuffer(); file.arrayBuffer=()=>gate.promise;
  const upload=store.submit(file,"student_card",true); api.token="token-B";
  gate.resolve(contents); await upload;
  assert.equal(calls.filter(([type])=>type==="submit").length,0);
  assert.equal(synced.length,0);
});

test("late mutation response after disconnect cannot replace the next account profile",async t=>{
  const {store,api,synced}=await setup(t), gate=deferred(); synced.length=0;
  api.submitUniversityProof=()=>gate.promise;
  const upload=store.submit(proof(),"student_card",true); await tick();
  store.disconnect(); api.token="token-B"; gate.resolve(request()); await upload;
  assert.equal(synced.length,0); assert.deepEqual(store.getState().rows,[]);
});

test("cancel timeout after server commit reconciles the cancelled request",async t=>{
  const {store,api}=await setup(t,[request()]); const cancel=api.cancelUniversityVerification;
  api.cancelUniversityVerification=async(...args)=>{await cancel(...args);throw problem("request_timeout",408);};
  assert.equal((await store.cancel(1)).status,"cancelled");
  assert.equal(store.getState().uncertain,false); assert.equal(store.getState().error,null);
});

test("review racing with cancellation refreshes approval and blocks resubmission",async t=>{
  const {store,api,replace,calls}=await setup(t,[request()]);
  api.cancelUniversityVerification=async()=>{replace([request(1,"approved")],{verification_status:"approved",university_verified:true});throw problem("verification_not_pending",409);};
  await store.cancel(1); assert.equal(store.getState().profile.university_verified,true);
  await store.submit(proof(),"student_card",true);
  assert.equal(calls.filter(([type])=>type==="submit").length,0);
});


test("lost upload response followed by immediate review is recognized as a received application",async t=>{
  const {store,api,replace}=await setup(t); const submit=api.submitUniversityProof;
  api.submitUniversityProof=async(...args)=>{const row=await submit(...args);replace([{...row,status:"approved"}],{verification_status:"approved",university_verified:true});throw problem("request_timeout",408);};
  const result=await store.submit(proof(),"student_card",true);
  assert.equal(result.status,"approved"); assert.equal(store.getState().profile.university_verified,true);
  assert.equal(store.getState().error,null);
});
