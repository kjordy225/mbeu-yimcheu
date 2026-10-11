// Security-rules tests. They run against the local Firestore emulator, never the live database.
// Needs Java and, in a scratch folder: npm i @firebase/rules-unit-testing firebase
//   npx firebase-tools emulators:exec --only firestore --project demo-mbeu "node rules.test.mjs /path/to/firestore.rules"
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import fs from "node:fs";

const rules = fs.readFileSync(process.argv[2], "utf8");
const env = await initializeTestEnvironment({ projectId: "demo-mbeu", firestore: { rules } });
const FV = firebase.firestore.FieldValue;
const now = () => new Date().toISOString();
let pass = 0, fail = 0;
async function check(name, p) { try { await p; pass++; console.log("  ok   " + name) } catch (e) { fail++; console.log("  FAIL " + name + " — " + String(e.message || e).slice(0, 140)) } }
const ok = (n, p) => check(n, assertSucceeds(p)), no = (n, p) => check(n, assertFails(p));

await env.withSecurityRulesDisabled(async c => {
  const d = c.firestore();
  await d.doc("codes/FAMCODE").set({ at: now() });
  for (const id of ["pP", "pA", "pB", "pZ"]) await d.doc("people/" + id).set({ given: id, surname: "X", deleted: false });
  await d.doc("unions/u1").set({ partnerIds: ["pP"], childIds: ["pA", "pB"], deleted: false });
  await d.doc("unions/uZ").set({ partnerIds: ["pZ"], childIds: [], deleted: false });
});
const user = (uid, email) => env.authenticatedContext(uid, email ? { email } : { firebase: { sign_in_provider: "anonymous" } }).firestore();
const master = user("uMaster", "jordankevinyonkeu@gmail.com");
const squat = user("uSquat", "admin@mbeuyimcheu.com");
const alice = user("uAlice", "alice@example.com");
const bob = user("uBob", "bob@example.com");
const anon = user("uAnon");
const stranger = user("uStranger", "x@example.com");

console.log("1. the old shared-admin email is no longer an admin");
await no("squatter cannot read people", squat.doc("people/pA").get());
await no("squatter cannot delete a person", squat.doc("people/pA").delete());
await no("squatter cannot list members", squat.collection("members").get());
await no("squatter cannot edit a person", squat.doc("people/pA").update({ given: "hacked" }));

console.log("2. master and viewers still work");
await ok("master reads codes", master.collection("codes").get());
await ok("master edits a person", master.doc("people/pZ").update({ bio: "x" }));
await no("viewer with a wrong code is refused", anon.doc("viewers/uAnon").set({ code: "WRONG", at: now() }));
await ok("viewer with the family code gets in", anon.doc("viewers/uAnon").set({ code: "FAMCODE", at: now() }));
await ok("viewer reads the tree", anon.collection("people").get());
await no("viewer cannot edit", anon.doc("people/pA").update({ given: "x" }));
await no("account without the code cannot read", stranger.collection("people").get());

console.log("3. new members start unconfirmed");
await no("cannot sign up already confirmed", alice.doc("members/uAlice").set({ code: "FAMCODE", name: "A", email: "a", personId: "", approved: true, createdAt: now() }));
await ok("sign up with the code", alice.doc("members/uAlice").set({ code: "FAMCODE", name: "A", email: "a", personId: "", approved: false, createdAt: now() }));
await ok("older page version (no approved field) can still sign up", bob.doc("members/uBob").set({ code: "FAMCODE", name: "B", email: "b", personId: "", createdAt: now() }));

console.log("4. claiming an existing person = pending, no edit rights");
{ const b = alice.batch(); b.update(alice.doc("members/uAlice"), { personId: "pA" }); b.set(alice.doc("claims/pA"), { uid: "uAlice", at: now() }); await ok("alice claims pA", b.commit()); }
await no("pending: cannot edit own claimed record", alice.doc("people/pA").update({ bio: "me" }));
await no("pending: cannot edit sibling", alice.doc("people/pB").update({ bio: "x", _via: "u1", _via2: "" }));
await no("pending: cannot edit parent", alice.doc("people/pP").update({ bio: "x", _via: "u1", _via2: "" }));
await no("pending: cannot confirm herself", alice.doc("members/uAlice").update({ approved: true }));
await no("pending: cannot add a photo", alice.doc("photos/pA").set({ data: "x" }));
await no("pending: cannot suggest", alice.collection("suggestions").add({ by: "uAlice", status: "pending", personId: "pZ" }));
await no("pending: cannot create a union as partner", alice.doc("unions/uNew").set({ partnerIds: ["pA"], childIds: [], deleted: false }));
await ok("pending: can still read the tree", alice.collection("people").get());
await no("someone else cannot claim the same person", (() => { const b = bob.batch(); b.update(bob.doc("members/uBob"), { personId: "pA" }); b.set(bob.doc("claims/pA"), { uid: "uBob", at: now() }); return b.commit() })());

console.log("5. after an admin confirms");
await ok("master confirms alice", master.doc("members/uAlice").update({ approved: true, approvedBy: "uMaster", approvedAt: now() }));
await ok("alice edits her record", alice.doc("people/pA").update({ bio: "me" }));
await ok("alice edits her sibling", alice.doc("people/pB").update({ bio: "x", _via: "u1", _via2: "" }));
await ok("alice edits her parent", alice.doc("people/pP").update({ bio: "x", _via: "u1", _via2: "" }));
await no("alice cannot edit an unrelated person", alice.doc("people/pZ").update({ bio: "x", _via: "u1", _via2: "" }));
await no("alice cannot delete anyone", alice.doc("people/pA").delete());
await ok("alice creates a union as partner", alice.doc("unions/uNew").set({ partnerIds: ["pA"], childIds: [], deleted: false }));

console.log("6. 'I am not in the tree yet' (join) = added but pending");
{ const b = bob.batch();
  b.set(bob.doc("people/pBob"), { given: "Bob", surname: "X", editorPids: [], createdBy: "uBob", needsVerification: true, deleted: false });
  b.set(bob.doc("claims/pBob"), { uid: "uBob", at: now() });
  b.update(bob.doc("members/uBob"), { personId: "pBob" });
  b.update(bob.doc("unions/u1"), { childIds: FV.arrayUnion("pBob"), editedBy: "B", updatedAt: now() });
  await ok("bob adds himself under a parent", b.commit()); }
await no("pending bob cannot edit the parent he attached to", bob.doc("people/pP").update({ bio: "x", _via: "u1", _via2: "" }));
await no("pending bob cannot edit a sibling", bob.doc("people/pA").update({ bio: "x", _via: "u1", _via2: "" }));
await no("pending bob cannot edit even his new record", bob.doc("people/pBob").update({ bio: "x" }));
await ok("master confirms bob", master.doc("members/uBob").update({ approved: true }));
await ok("bob edits his record", bob.doc("people/pBob").update({ bio: "x" }));

console.log("7. declining / unlinking");
{ const b = master.batch(); b.update(master.doc("members/uAlice"), { personId: "", approved: false }); b.delete(master.doc("claims/pA")); await ok("master unlinks alice", b.commit()); }
await no("alice can no longer edit pA", alice.doc("people/pA").update({ bio: "again" }));
{ const b = alice.batch(); b.update(alice.doc("members/uAlice"), { personId: "pB" }); b.set(alice.doc("claims/pB"), { uid: "uAlice", at: now() }); await ok("alice claims another person", b.commit()); }
await no("…and is pending again", alice.doc("people/pB").update({ bio: "x" }));

console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
