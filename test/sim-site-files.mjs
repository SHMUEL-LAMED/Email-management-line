// סימולציה: קובץ ש-Claude שולח לאתר (/bridge/file_put, files בתשובה, /chatsite/file?cf=) והפרדה בין שיחות
import worker, { CallState } from "../entry.js";
const kv = new Map();
const KV = { get: async (k, t) => { const v = kv.get(k); if (v == null) return null; return t === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
const data = new Map();
const storage = { get: async (k) => data.get(k), put: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))); }, delete: async (k) => data.delete(k) };
const env = { KV, BRIDGE_KEY: "bk" };
const doObj = new CallState({ storage }, env);
env.CALLS = { idFromName: () => "x", get: () => ({ fetch: (u, init) => doObj.fetch(u instanceof Request ? u : new Request(u, init)) }) };
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
kv.set("cs:tok:" + (await sha("tok1")), "1");
const W = (path, init = {}) => worker.fetch(new Request("https://w" + path, init), env, { waitUntil() {} });
const bk = { "x-bridge-key": "bk" };
// העלאה מהריצה
const A = new Uint8Array([1, 2, 3, 4]), B = new Uint8Array([5, 6]);
ok((await W("/bridge/file_put?id=abcd1234ef&part=0&parts=2&name=x.mp3", { method: "POST", body: A })).status === 403, "file_put needs the bridge key");
ok((await W("/bridge/file_put?id=abc&part=0&parts=1", { method: "POST", headers: bk, body: A })).status === 400, "short id refused");
ok((await W("/bridge/file_put?id=abcd1234ef&part=2&parts=2", { method: "POST", headers: bk, body: A })).status === 400, "part out of range refused");
ok((await W("/bridge/file_put?id=abcd1234ef&part=0&parts=1", { headers: bk })).status === 405, "GET refused");
ok((await W("/bridge/file_put?id=abcd1234ef&part=0&parts=2&name=" + encodeURIComponent("שיר ערוך.mp3") + "&type=audio/mpeg&size=6", { method: "POST", headers: bk, body: A })).status === 200, "part 0 stored");
ok(!kv.has("co:abcd1234ef"), "no details before the last part");
ok((await (await W("/bridge/file_put?id=abcd1234ef&part=1&parts=2&name=" + encodeURIComponent("שיר ערוך.mp3") + "&type=audio/mpeg&size=6", { method: "POST", headers: bk, body: B })).json()).ok, "part 1 stored");
// הורדה מהאתר
ok((await W("/chatsite/file?cf=abcd1234ef")).status === 401 && (await W("/chatsite/file?cf=abcd1234ef", { headers: { "x-chat-token": "bad" } })).status === 401, "site download needs the site token");
const st = { headers: { "x-chat-token": "tok1" } };
const meta = await (await W("/chatsite/file?cf=abcd1234ef", st)).json();
ok(meta.name === "שיר ערוך.mp3" && meta.parts === 2 && meta.size === 6, "details returned");
const p0 = new Uint8Array(await (await W("/chatsite/file?cf=abcd1234ef&part=0", st)).arrayBuffer()), p1 = new Uint8Array(await (await W("/chatsite/file?cf=abcd1234ef&part=1", st)).arrayBuffer());
ok(p0.join() === "1,2,3,4" && p1.join() === "5,6", "bytes returned as stored");
ok((await W("/chatsite/file?cf=abcd1234ef&part=2", st)).status === 404 && (await W("/chatsite/file?cf=nosuchfile1", st)).status === 404, "missing part or file is 404");
ok((await W("/bridge/file?id=abcd1234ef", { headers: bk })).status === 404, "files from Claude are separate from uploads");
// תשובה עם קובץ
const call = async (op, body) => (await doObj.fetch(new Request("https://do/bridge/" + op, { method: "POST", body: JSON.stringify(body || {}) }))).json();
const m1 = await call("siteadd", { text: "תערוך לי את השיר", conv: "c1" });
const post = (b) => W("/bridge/answer", { method: "POST", headers: { ...bk, "content-type": "application/json" }, body: JSON.stringify(b) });
ok((await post({ re: m1.id, text: "הנה", files: ["zzzzzzzzzz"] })).status === 400, "unknown file refused");
ok((await call("site")).items.length === 1, "nothing answered on a refused file");
const r = await post({ re: m1.id, text: "הנה הקובץ", files: ["abcd1234ef"] });
ok(r.status === 200 && (await r.json()).id, "answer with a file accepted");
const items = (await call("site")).items, ans = items.find((x) => x.from === "claude");
ok(ans.text === "הנה הקובץ\n\n[קובץ מ-Claude: שיר ערוך.mp3 | 1 ק״ב | מזהה: abcd1234ef | חלקים: 2]" && ans.conv === "c1", "file line added to the answer in its conversation");
// הפרדה בין שיחות
for (let i = 0; i < 10; i++) { const m = await call("siteadd", { text: "שאלה " + i, conv: "c2" }); await call("answer", { re: m.id, text: "תשובה " + i }); }
await call("siteadd", { text: "המשך", conv: "c2" });
await call("siteadd", { text: "ומה עם השיר", conv: "c1" });
const t = (await call("take")).messages, c2 = t.find((x) => x.text.startsWith("המשך")), c1 = t.find((x) => x.text.startsWith("ומה עם השיר"));
ok(c2.conv === "c2" && c1.conv === "c1", "take reports the conversation of each message");
ok(c2.text.includes("תשובה 9") && c2.text.includes("שאלה 2") && !c2.text.includes("שאלה 1\n") && !c2.text.includes("השיר"), "context: last 8 of the same conversation only");
ok(c1.text.includes("הנה הקובץ") && !c1.text.includes("שאלה"), "other conversation gets only its own context");
console.log("site files and conversation split: passed");
