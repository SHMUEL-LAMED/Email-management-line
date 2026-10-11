// סימולציה: שיחה עם קלאוד דרך הקו (הודעה כשלא מחובר, שיחה חיה, אישור)
import worker from "../worker.js";

const kv = new Map([["namehints", JSON.stringify({ t: Date.now(), s: "" })]]);
const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } };
let said = "";
const env = {
  KV, AI: { run: async (m) => (m.includes("whisper") ? { text: said } : { response: "" }) },
  YM_TOKEN: "ym", PIN: "1234", PATH_KEY: "pk", SETUP_KEY: "sk", BRIDGE_KEY: "bk",
  ALLOWED_PHONES: "0500000000", BUSINESS_EMAIL: "x@example-biz.com",
};
kv.set("g:refresh", "rt");
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("oauth2")) return json({ access_token: "at", expires_in: 3600 });
  if (url.includes("messages?q=")) return json({});
  if (url.includes("chat.googleapis.com")) return json({});
  if (url.includes("searchDirectoryPeople")) return json({ people: [{ resourceName: "people/1" }] });
  if (url.includes("DownloadFile")) return new Response(new Uint8Array(said ? 5000 : 100).fill(1));
  if (url.includes("call2all")) return json({});
  throw new Error("unmocked " + url);
};
const ectx = { waitUntil() {} };
const vals = { ApiCallId: "c1", ApiPhone: "0500000000" };
let out = "";
async function phone(v, speak) {
  if (v !== undefined || speak !== undefined) {
    const k = [...out.matchAll(/=(V\d+),/g)].pop()[1];
    if (speak !== undefined) { said = speak; vals[k] = "/r/" + k + ".wav"; console.log(">> [אומר]", speak || "(שקט)"); }
    else { vals[k] = v; console.log(">>", v); }
  }
  const u = new URL("https://w.dev/yemot/pk");
  for (const [k, x] of Object.entries(vals)) u.searchParams.set(k, x);
  out = await (await worker.fetch(new Request(u), env, ectx)).text();
  console.log("<<", out.replace(/=V\d+,.*$/, "").slice(0, 260));
}
async function claude(op, body) {
  const u = new URL(`https://w.dev/bridge/${op}?k=bk&sec=1`);
  const r = await worker.fetch(new Request(u, body ? { method: "POST", body: JSON.stringify(body) } : {}), env, ectx);
  const j = await r.json();
  console.log(`   [קלאוד ${op}]`, JSON.stringify(j).slice(0, 200));
  return j;
}

console.log("--- מפתח שגוי נחסם:", (await worker.fetch(new Request("https://w.dev/bridge/peek?k=bad"), env, ectx)).status);
console.log("--- 1. קלאוד לא מחובר: משאירים הודעה");
await phone(); await phone("1234"); await phone("7");
await phone(undefined, "תוסיף לאתר ראש בראש כפתור להאזנה");
await phone(undefined, "");
console.log("--- 2. הריצה המתוזמנת עונה עם בקשה לאישור");
await claude("peek");
const t = await claude("take");
await claude("answer", { re: t.messages[0].id, text: "הכנתי כפתור כחול מתחת לכותרת שמנגן את התוכנית האחרונה.", confirm: "להעלות לאתר ראש בראש את כפתור ההאזנה" });
console.log("--- 3. מתקשרים שוב: שומעים, מאשרים, ומנהלים שיחה חיה");
vals.ApiCallId = "c2"; for (const k of Object.keys(vals)) if (/^V/.test(k)) delete vals[k];
await claude("live", { on: true });
await phone(); await phone("1234"); await phone("7");
await phone("1");
await claude("take");
await phone(undefined, "מה השעה בלוס אנגלס");
await phone("none");
const t2 = await claude("take");
await claude("answer", { re: t2.messages[0].id, text: "בלוס אנג'לס השעה עכשיו בערך תשע בערב." });
await phone("none");
await phone(undefined, "");
await claude("live", { on: false });
