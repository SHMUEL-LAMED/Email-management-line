// סימולציה: ה-API של אתר הצאט (shmuel-lamed.github.io/chat)
import worker from "../worker.js";

const kv = new Map([["g:refresh", "rt"], ["g:me", "1"]]);
const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } };
const env = { KV, PIN: "1234", BRIDGE_KEY: "bk", BUSINESS_EMAIL: "x@example-biz.com" };
const sent = [];
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("oauth2")) return json({ access_token: "at", expires_in: 3600 });
  if (url.includes("people.googleapis.com")) return json({ names: [{ displayName: "משה" }] });
  if (url.includes("/spaceReadState")) return init.method === "PATCH" ? json({}) : json({ lastReadTime: "2026-11-01T00:00:00Z" });
  if (url.endsWith("/messages") && init.method === "POST") { sent.push(JSON.parse(init.body).text); return json({ name: "spaces/A/messages/9" }); }
  if (url.includes("/members")) return json({ memberships: [{ member: { name: "users/1", displayName: "אני" } }, { member: { name: "users/2", displayName: "משה כהן" } }] });
  if (url.includes("/messages?")) return json({ messages: [{ name: "spaces/A/messages/2", sender: { name: "users/2" }, text: "שלום", createTime: "2026-11-08T10:00:00Z" }, { name: "spaces/A/messages/1", sender: { name: "users/1" }, text: "היי", createTime: "2026-11-08T09:00:00Z" }] });
  if (url.includes("chat.googleapis.com/v1/spaces?")) return json({ spaces: [{ name: "spaces/A", spaceType: "DIRECT_MESSAGE", lastActiveTime: "2026-11-08T10:00:00Z" }, { name: "spaces/B", spaceType: "SPACE", displayName: "צוות", lastActiveTime: "2026-10-01T00:00:00Z" }] });
  throw new Error("unmocked " + url);
};
const ectx = { waitUntil() {} };
const ORIGIN = "https://shmuel-lamed.github.io";
async function call(op, body, token, q = "") {
  const r = await worker.fetch(new Request(`https://w.dev/chatsite/${op}${q}`, { method: body ? "POST" : "GET", headers: { origin: ORIGIN, ...(token ? { "x-chat-token": token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, ectx);
  return { status: r.status, cors: r.headers.get("access-control-allow-origin"), j: await r.json() };
}
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok -", m); };

assert((await call("spaces")).status === 401, "בלי כניסה – חסום");
assert((await call("login", { pin: "0000" })).status === 401, "קוד שגוי נדחה");
const lg = await call("login", { pin: "1234" });
assert(lg.status === 200 && lg.j.token && lg.cors === ORIGIN, "כניסה עם הקוד הנכון");
const T = lg.j.token;
assert(![...kv.keys()].some((k) => k.includes(T)), "האסימון לא נשמר גלוי ב-KV");
const sp = await call("spaces", null, T);
assert(sp.j.spaces.length === 2 && sp.j.spaces[0].title === "משה כהן" && sp.j.spaces[0].unread === true && sp.j.spaces[1].unread === false, "רשימת שיחות עם שם ולא-נקרא");
const ms = await call("messages", null, T, "?space=spaces/A");
assert(ms.j.messages.length === 2 && ms.j.messages[0].text === "היי" && ms.j.messages[0].mine && ms.j.messages[1].who === "משה כהן", "הודעות בסדר הנכון, עם שולח");
assert((await call("messages", null, T, "?space=../x")).status === 400, "מזהה שיחה לא תקין נדחה");
const sd = await call("send", { space: "spaces/A", text: "מה נשמע" }, T);
assert(sd.j.ok && sent[0] === "מה נשמע", "שליחת הודעה");
await call("mute", { space: "spaces/B", on: true }, T);
assert(JSON.parse(kv.get("mute")).includes("spaces/B"), "השתקת קבוצה");
assert((await call("logout", {}, T)).j.ok && (await call("spaces", null, T)).status === 401, "יציאה מבטלת את האסימון");
const pre = await worker.fetch(new Request("https://w.dev/chatsite/spaces", { method: "OPTIONS", headers: { origin: ORIGIN } }), env, ectx);
assert(pre.status === 204 && pre.headers.get("access-control-allow-headers").includes("x-chat-token"), "בקשת CORS מקדימה");
console.log("כל בדיקות אתר הצאט עברו");
