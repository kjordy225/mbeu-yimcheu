// End-to-end check of the claim-approval flow, against the local Firebase emulators only.
// Needs Java, Google Chrome and, in a scratch folder: npm i playwright-core
//   npx firebase-tools emulators:exec --only firestore,auth --project demo-mbeu "node ui.test.cjs /path/to/index.html"
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path"), http = require("http");
const SRC = process.argv[2], OUT = path.join(__dirname, "shots");
fs.mkdirSync(OUT, { recursive: true });
const FS = "http://127.0.0.1:8080/v1/projects/demo-mbeu/databases/(default)/documents";
const H = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const val = v => typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(val) } } : { nullValue: null };
const put = (p, o) => fetch(`${FS}/${p}`, { method: "PATCH", headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)])) }) }).then(r => { if (!r.ok) throw new Error("seed " + p + " " + r.status) });
const get = p => fetch(`${FS}/${p}`, { headers: H }).then(r => r.status === 404 ? null : r.json()).then(d => d && d.fields ? Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, Object.values(v)[0]])) : d);
const list = c => fetch(`${FS}/${c}`, { headers: H }).then(r => r.json()).then(d => (d.documents || []).map(x => ({ id: x.name.split("/").pop(), f: Object.fromEntries(Object.entries(x.fields || {}).map(([k, v]) => [k, Object.values(v)[0]])) })));

let pass = 0, fail = 0; const errors = [];
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("  ok   " + name) } else { fail++; console.log("  FAIL " + name + (extra ? " — " + extra : "")) } };

(async () => {
  // the page under test = the real index.html, pointed at the emulators
  let html = fs.readFileSync(SRC, "utf8");
  const hook = 'db=firebase.firestore(); auth=firebase.auth()';
  if (!html.includes(hook)) throw new Error("hook not found");
  html = html.replace(hook, hook + '; db.useEmulator("127.0.0.1",8080); auth.useEmulator("http://127.0.0.1:9099",{disableWarnings:true})').replace('projectId: "mbeu-yimcheu"', 'projectId: "demo-mbeu"');
  const server = http.createServer((q, r) => { r.writeHead(q.url === "/" ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" }); r.end(q.url === "/" ? html : "") }).listen(5055);

  await put("codes/FAMCODE", { at: "x" });
  await put("site/main", { familyName: "TEST", founders: ["pF", "pM"], rootUnion: "u0" });
  const P = (given, sex) => ({ surname: "MBEU", given, sex, deleted: false, placeholder: false, needsVerification: false, birth: "", death: "", deceased: false, country: "" });
  await put("people/pF", P("Fondateur", "M")); await put("people/pM", P("Fondatrice", "F"));
  await put("people/pA", P("Alice", "F")); await put("people/pB", P("Bruno", "M"));
  await put("unions/u0", { partnerIds: ["pF", "pM"], childIds: ["pA", "pB"], type: "married", deleted: false });

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  async function open(label) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR" });
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(label + ": " + e.message));
    page.on("console", m => { if (m.type() === "error" && !/favicon|manifest|icon-|ERR_|404/.test(m.text())) errors.push(label + " console: " + m.text().slice(0, 200)) });
    await page.goto("http://127.0.0.1:5055/"); return page;
  }
  const shot = (page, n) => page.screenshot({ path: path.join(OUT, n + ".png") });
  const signup = async (page, name, email) => {
    await page.fill("#lg-name", name); await page.fill("#lg-email", email); await page.fill("#lg-pw", "secret123"); await page.click('#lgForm [type="submit"]') };
  const sheetText = page => page.locator("#sheet").innerText();

  console.log("A. Alice: family code, account, 'C'est moi'");
  const a = await open("alice");
  await a.fill("#gate-code", "FAMCODE"); await a.click('#gateForm button[type="submit"]');
  await a.waitForSelector("#homeFind", { timeout: 15000 });
  ok("the family code opens the tree", true);
  await a.locator("[data-login]:visible").first().click();
  await signup(a, "Alice MBEU", "alice@example.com");
  await a.waitForSelector("#jnq", { timeout: 15000 });
  ok("after sign-up the 'find yourself' step opens", true);
  await a.fill("#jnq", "Alice"); await a.click('#jnres [data-pickme="pA"]'); await a.click("#jnYes");
  await a.waitForFunction(() => !document.querySelector("#toast").hidden, null, { timeout: 15000 });
  const toastA = await a.locator("#toast").innerText();
  ok("toast says the request was sent", /Demande envoyée/.test(toastA), toastA);
  await a.waitForFunction(() => /attend la confirmation/.test(document.querySelector("#sheet").innerText), null, { timeout: 15000 });
  ok("her record shows 'waiting for confirmation'", true);
  ok("no Edit button while pending", await a.locator('#sheet [data-mode="edit"]').count() === 0);
  ok("no 'C'est moi' button any more", await a.locator("#sheet [data-claim]").count() === 0);
  await shot(a, "1-alice-pending");
  const mems1 = await list("members"); const mA = mems1.find(m => m.f.email === "alice@example.com");
  ok("database: linked but not approved", mA && mA.f.personId === "pA" && mA.f.approved === false, JSON.stringify(mA && mA.f));
  ok("database: member record keeps the name typed at sign-up", mA && mA.f.name === "Alice MBEU", mA && mA.f.name);
  await a.click("#sheet [data-close]");
  await a.waitForFunction(() => /attend la confirmation/.test(document.querySelector("#main").innerText), null, { timeout: 10000 });
  ok("home card explains the wait", true);
  await shot(a, "2-alice-home");

  console.log("B. Bob: 'I am not in the tree yet'");
  const b = await open("bob");
  await b.fill("#gate-code", "FAMCODE"); await b.click('#gateForm button[type="submit"]'); await b.waitForSelector("#homeFind", { timeout: 15000 });
  await b.locator("[data-login]:visible").first().click(); await signup(b, "Bob MBEU", "bob@example.com");
  await b.waitForSelector("#jnq", { timeout: 15000 }); await b.click("#jnNew");
  await b.fill("#wzq", "Fondateur"); await b.click("#wzres [data-pick]");
  ok("wizard has 3 steps for a new member", await b.locator("#sheet .steps i").count() === 3);
  await b.click("#wzNext");
  await b.fill("#pf-given", "Bob"); await b.fill("#pf-surname", "MBEU");
  ok("ndap: offered in the short form", await b.locator("#pf-ndap").count() === 1);
  const btn = await b.locator("#wzNext").innerText();
  ok("step 3 is the last one", /Terminer|Finish/i.test(btn), btn);
  await shot(b, "3-bob-wizard");
  await b.click("#wzNext");
  await b.waitForFunction(() => /attend la confirmation/.test(document.querySelector("#sheet").innerText), null, { timeout: 15000 });
  ok("Bob's new record shows 'waiting for confirmation'", true);
  const mB = (await list("members")).find(m => m.f.email === "bob@example.com");
  const pBob = mB && await get("people/" + mB.f.personId);
  ok("database: Bob's record is flagged 'to verify'", pBob && pBob.needsVerification === true && pBob.createdBy === mB.id, JSON.stringify(pBob));
  const us = await list("unions");
  ok("Bob is attached under the founder he picked", us.some(u => (u.f.partnerIds.values || []).some(v => v.stringValue === "pF") && (u.f.childIds.values || []).some(v => v.stringValue === mB.f.personId)));

  console.log("C. Master admin confirms Alice, declines Bob");
  const m = await open("master");
  await m.click("[data-login-signin]"); await m.click('#sheet [data-tab="create"]');
  await signup(m, "Kevin", "jordankevinyonkeu@gmail.com");
  await m.waitForSelector("#homeFind", { timeout: 15000 });
  await m.waitForFunction(() => /2 liens à confirmer/.test(document.querySelector("#main").innerText), null, { timeout: 15000 });
  ok("home shows '2 liens à confirmer'", true);
  await shot(m, "4-master-home");
  await m.click('#main [data-route="admin"]');
  await m.waitForSelector(`[data-approve="${mA.id}"]`, { timeout: 15000 });
  await m.locator(`[data-approve="${mA.id}"]`).scrollIntoViewIfNeeded();
  await shot(m, "5-master-admin");
  ok("pending members are listed first", await m.evaluate(() => { const rows = [...document.querySelectorAll("[data-approve]")].map(x => x.closest(".logrow")); const all = [...rows[0].parentElement.children]; return all.indexOf(rows[0]) === 0 && all.indexOf(rows[1]) === 1 }));
  await m.click(`[data-approve="${mA.id}"]`);
  await m.waitForFunction(id => !document.querySelector(`[data-approve="${id}"]`), mA.id, { timeout: 15000 });
  ok("Confirm removes Alice from the pending list", true);
  ok("database: Alice approved", (await get("members/" + mA.id)).approved === true);
  const rb = m.locator(`[data-release="${mB.id}"]`); const rbTxt = await rb.innerText();
  ok("Bob's button says 'Refuser'", /Refuser/.test(rbTxt), rbTxt);
  await rb.click();
  await m.waitForFunction(id => !document.querySelector(`[data-approve="${id}"]`), mB.id, { timeout: 15000 });
  const mB2 = await get("members/" + mB.id);
  ok("database: Bob unlinked and still unapproved", mB2.personId === "" && mB2.approved === false && (await get("claims/" + mB.f.personId)) === null, JSON.stringify(mB2));

  console.log("D. The members see the result live");
  await a.locator("[data-open], #homeAdd").first().waitFor();
  await a.click("#homeAdd");
  await a.waitForSelector('#sheet [data-mode="edit"]', { timeout: 15000 });
  ok("Alice now has the Edit button", true);
  ok("pending notice is gone for Alice", !/attend la confirmation/.test(await sheetText(a)));
  await a.click('#sheet [data-mode="edit"]');
  await a.waitForSelector("#sheet form, #sheet [id^='pf-']", { timeout: 10000 });
  await shot(a, "6-alice-approved");
  await a.fill("#pf-ndap", "Testndap"); await a.click("#shSave");
  await a.waitForFunction(() => /Ndap\s*:\s*Testndap/.test(document.querySelector("#sheet").innerText), null, { timeout: 15000 });
  ok("ndap: shown under the name after saving", true);
  ok("ndap: saved in the database", (await get("people/pA")).ndap === "Testndap");
  await shot(a, "7-alice-ndap");
  await a.click("#sheet [data-close]"); await a.fill("#homeFind", "Testndap");
  await a.waitForSelector('#homeRes [data-open="pA"]', { timeout: 10000 });
  ok("ndap: search finds the person by ndap", true);
  await b.waitForFunction(() => !/attend la confirmation/.test(document.querySelector("#sheet").innerText + document.querySelector("#main").innerText), null, { timeout: 15000 });
  ok("Bob is back to 'not linked' and can try again", true);

  console.log("E. No script errors");
  ok("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); server.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("CRASH " + (e.stack || e).toString().slice(0, 900)); console.log("errors so far: " + errors.join(" | ")); process.exit(2) });
