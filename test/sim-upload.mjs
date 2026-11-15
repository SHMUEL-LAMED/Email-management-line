// סימולציה: העלאת קובץ מדף Claude באתר הצאט (claude_upload) והורדה שלו בריצה (/bridge/file)
import worker, { CallState } from "../entry.js";
import { createHash } from "node:crypto";
const kv = new Map(), ttl = new Map();
const KV = {
  get: async (k, t) => { const v = kv.get(k); if (v == null) return null; if (t === "json") return JSON.parse(v); if (t === "arrayBuffer") return v; return typeof v === "string" ? v : null; },
  put: async (k, v, o) => { kv.set(k, typeof v === "string" ? v : v.slice(0)); ttl.set(k, o?.expirationTtl); },
  delete: async (k) => { kv.delete(k); },
};
const env = { KV, BRIDGE_KEY: "bk" };
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
const tok = "tok123";
kv.set("cs:tok:" + createHash("sha256").update(tok).digest("hex"), "1");
const base = "https://w/chatsite/claude_upload";
const up = (q, body, t = tok) => worker.fetch(new Request(base + "?" + q, { method: "POST", headers: { "x-chat-token": t }, body }), env, {});
const bytes = new Uint8Array(7 * 1024 * 1024 + 123); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
const CH = 3 * 1024 * 1024, parts = Math.ceil(bytes.length / CH), id = "fabc12345xyz";
const q = (i) => "id=" + id + "&part=" + i + "&parts=" + parts + "&size=" + bytes.length + "&name=" + encodeURIComponent("שיר ראשון.mp3") + "&type=audio%2Fmpeg";
ok((await up(q(0), bytes.slice(0, CH), "bad")).status === 401, "upload needs a site token");
for (let i = 0; i < parts; i++) { const r = await up(q(i), bytes.slice(i * CH, (i + 1) * CH)); ok(r.status === 200 && (await r.json()).ok, "part " + i); }
ok(ttl.get("cf:" + id + ":0") === 3 * 86400 && ttl.get("cf:" + id) === 3 * 86400, "kept for three days");
ok((await up("id=" + id + "&part=5&parts=3", new Uint8Array(4))).status === 400, "part out of range");
ok((await up("id=ab&part=0&parts=1", new Uint8Array(4))).status === 400, "short id");
ok((await up("id=" + id + "x&part=0&parts=99", new Uint8Array(4))).status === 400, "too many parts");
ok((await up("id=" + id + "y&part=0&parts=1", new Uint8Array(4 * 1024 * 1024 + 1))).status === 413, "part too big");
ok((await up("id=" + id + "z&part=0&parts=1", new Uint8Array(0))).status === 400, "empty part");
const get = (qs, key = "bk") => worker.fetch(new Request("https://w/bridge/file?" + qs, { headers: key ? { "x-bridge-key": key } : {} }), env, {});
ok((await get("id=" + id, "")).status === 403 && (await get("id=" + id, "wrong")).status === 403, "download needs the bridge key");
const meta = await (await get("id=" + id)).json();
ok(meta.name === "שיר ראשון.mp3" && meta.size === bytes.length && meta.parts === parts && meta.type === "audio/mpeg", "file details");
const out = new Uint8Array(bytes.length); let off = 0;
for (let i = 0; i < parts; i++) { const b = new Uint8Array(await (await get("id=" + id + "&part=" + i)).arrayBuffer()); out.set(b, off); off += b.length; }
ok(off === bytes.length && out.every((v, i) => v === bytes[i]), "downloaded file is identical");
ok((await get("id=" + id + "&part=" + parts)).status === 404 && (await get("id=nosuchfile123")).status === 404, "missing part or file");
console.log("upload and download: passed");

// ההודעה עם הקובץ: הריצה מקבלת הסבר איך להוריד, וההיסטוריה באתר נשארת נקייה
const data = new Map();
const storage = { get: async (k) => data.get(k), put: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))); }, delete: async (k) => data.delete(k) };
const dobj = new CallState({ storage }, {});
const call = async (op, body) => (await dobj.fetch(new Request("https://do/bridge/" + op, { method: "POST", body: JSON.stringify(body || {}) }))).json();
const msg = "תדחוס לי את זה\n\n[קובץ שהועלה: שיר ראשון.mp3 | 7.0 מגה | מזהה: " + id + " | חלקים: " + parts + "]";
const a = await call("siteadd", { text: msg, conv: "c9" });
const t = await call("take");
ok(t.messages[0].text.startsWith(msg) && t.messages[0].text.includes("/bridge/file?id="), "the run gets download instructions");
ok((await call("site")).items.find((x) => x.id === a.id).text === msg, "history keeps the plain message");
await call("siteadd", { text: "בלי קובץ", conv: "c9b" });
ok(!(await call("take")).messages[0].text.includes("/bridge/file"), "no hint without an uploaded file");
console.log("upload message: passed");
