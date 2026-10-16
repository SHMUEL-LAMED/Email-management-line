// סימולציה עם Durable Object מדומה: משימת העוזר רצה ב-alarm של ה-DO, נעילה מפני בקשה כפולה מימות, וכוכבית לשמיעה חוזרת
import worker, { CallState } from "../worker.js";

const kv = new Map();
const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } };
const env = {
  KV, AI: { run: async () => ({ response: "" }) },
  YM_TOKEN: "ym", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", GEMINI_KEY: "gk",
  PIN: "1234", PATH_KEY: "pk", SETUP_KEY: "sk", ALLOWED_PHONES: "0500000000", BUSINESS_EMAIL: "me@example-biz.com",
};
kv.set("g:refresh", "rt");
kv.set("voice", "off");

// ---- Durable Object מדומה: אחסון בזיכרון + alarm אמיתי (setTimeout)
const objs = new Map();
function makeObject(id) {
  const m = new Map();
  let timer = null, alarmAt = null, obj;
  const storage = {
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => { m.delete(k); },
    deleteAll: async () => { m.clear(); },
    getAlarm: async () => alarmAt,
    deleteAlarm: async () => { alarmAt = null; if (timer) clearTimeout(timer); timer = null; },
    setAlarm: async (t) => {
      alarmAt = t; if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; alarmAt = null; alarmsRun.push(id); obj.alarm().catch((e) => console.log("!! alarm error", e)); }, Math.max(0, t - Date.now()));
      timer.unref();
    },
  };
  obj = new CallState({ storage }, env);
  // Durable Object אמיתי מטפל בבקשות בזו אחר זו (input gates): גם כאן בקשות לאותו אובייקט רצות בתור
  let chain = Promise.resolve();
  const fetch = (url, init) => { const r = chain.then(() => obj.fetch(new Request(url, init))); chain = r.catch(() => {}); return r; };
  return { fetch, _m: m };
}
const alarmsRun = [];
env.CALLS = { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) objs.set(id, makeObject(id)); return objs.get(id); } };

const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
let said = "", sent = 0, geminiCalls = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init.method || "GET";
  if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
  if (url.includes("generativelanguage")) {
    geminiCalls++;
    const body = JSON.parse(init.body);
    const parts = body.contents.flatMap((c) => c.parts);
    if (parts.some((p) => p.inline_data)) return json({ candidates: [{ content: { parts: [{ text: said }] } }] });
    if (!body.tools) return json({ candidates: [{ content: { parts: [{ text: "תרגום" }] } }] });
    const lastUser = [...body.contents].reverse().find((c) => c.role === "user");
    const fr = lastUser.parts.find((p) => p.functionResponse);
    const text = body.contents.filter((c) => c.role === "user").map((c) => c.parts.map((p) => p.text || "").join(" ")).pop().split("\n").pop();
    const fc = (name, args) => json({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });
    if (fr?.functionResponse.name === "search_contacts") return fc("send_email", { to: "yossi@ex.com", subject: "איחור", body: "אני מאחר בעשר דקות" });
    if (/תשלח ליוסי/.test(text)) return fc("search_contacts", { name: "יוסי" });
    // תשובה איטית: מדמה מודל שלוקח 3 שניות (יותר מהזמן שימות מחכה בין פולים)
    await new Promise((r) => setTimeout(r, 1500));
    return json({ candidates: [{ content: { parts: [{ text: "יש לך פגישה מחר בעשר." }] } }] });
  }
  if (url.includes("messages?q=")) return json({ messages: [] });
  if (url.endsWith("messages/send")) { sent++; return json({ id: "s" + sent }); }
  if (url.includes("people/me?personFields=names")) return json({ resourceName: "people/111" });
  if (url.includes("people/me/connections")) return json({ connections: [{ names: [{ displayName: "יוסי כהן" }], emailAddresses: [{ value: "yossi@ex.com" }] }] });
  if (url.includes("listDirectoryPeople") || url.includes("otherContacts")) return json({});
  if (url.includes("call2all") && url.includes("DownloadFile")) return new Response(new Uint8Array(said ? 5000 : 500).fill(1));
  if (url.includes("call2all")) return json({ responseStatus: "OK" });
  if (url.includes("chat.googleapis.com/v1/spaces?")) return json({ spaces: [] });
  throw new Error("unmocked " + method + " " + url);
};

const ectx = { waitUntil() {} };
const vals = { ApiCallId: "do1", ApiPhone: "0500000000" };
let out = "", fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; console.log("!! FAIL:", msg); } else console.log("ok:", msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(extra = {}) {
  const u = new URL("https://w.dev/yemot/pk");
  for (const [k, v] of Object.entries({ ...vals, ...extra })) u.searchParams.set(k, v);
  const r = await worker.fetch(new Request(u), env, ectx);
  return r.text();
}
const lastVar = () => [...out.matchAll(/=(V\d+),/g)].pop()[1];
async function send(v, sayText) {
  const k = lastVar();
  if (sayText !== undefined) { said = sayText; vals[k] = "/rec/" + k + ".wav"; console.log(">> [אומר]", sayText); }
  else { vals[k] = v; console.log(">>", v); }
  out = await req();
  console.log("<<", out.replace(/=V\d+,.*$/, "").slice(0, 220));
  return out;
}

console.log("--- 1. כניסה, כוכבית לשמיעה חוזרת");
out = await req(); console.log("<<", out.slice(0, 120));
await send("1234");
const menu = out;
check(/,no,1,1,10,No,no,no,,/.test(menu), "כוכבית לא חסומה בפקודת read (block_asterisk=no)");
const star = await send("*");
check(star.replace(/=V\d+,/, "=V,") === menu.replace(/=V\d+,/, "=V,") && !/=V2,/.test(star), "כוכבית מחזירה את אותה הודעה, עם שם משתנה חדש");
await sleep(50);

console.log("--- 2. העוזר החכם: המשימה רצה ב-alarm של ה-DO (לא ב-waitUntil)");
await send("6");
await send(null, "מה יש לי מחר");
let answered = false;
for (let i = 0; i < 8 && !answered; i++) { await sleep(600); await send("none"); answered = out.includes("פגישה מחר בעשר"); }
check(answered, "התשובה מהעוזר הגיעה דרך ה-DO אחרי כמה פולים");
check(alarmsRun.length >= 1, "alarm של ה-DO הופעל למשימת העוזר");

console.log("--- 3. בקשה כפולה מימות: שליחת מייל מאושרת פעמיים במקביל, נשלחת פעם אחת");
await send(null, "תשלח ליוסי מייל שאני מאחר");
for (let i = 0; i < 8 && !out.includes("לאישור הקש 1"); i++) { await sleep(500); await send("none"); }
check(out.includes("לשלוח מייל אל"), "העוזר מציע לשלוח מייל");
await send("1");
check(out.includes("לאישור סופי"), "אישור כפול לפעולה בלתי הפיכה");
const k = lastVar(); vals[k] = "1";
const t0 = Date.now();
const [a, b] = await Promise.all([req(), req()]);
console.log("   two responses in", Date.now() - t0, "ms; identical:", a === b);
check(sent === 1, `המייל נשלח פעם אחת בלבד (sent=${sent})`);
check(a === b, "שתי הבקשות הכפולות קיבלו את אותה תשובה");
out = a;
const busy = await (await env.CALLS.get("do1").fetch("https://do/busy")).json();
check(busy === null, "הנעילה שוחררה אחרי הטיפול");

console.log("--- 4. ניתוק: המצב נמחק");
await req({ hangup: "yes" });
const st = await (await env.CALLS.get("do1").fetch("https://do/")).json();
check(st === null, "מצב השיחה נמחק בניתוק");

console.log("\nFAILS:", fails, "| gemini calls:", geminiCalls, "| alarms:", alarmsRun.length);
process.exit(fails ? 1 : 0);
