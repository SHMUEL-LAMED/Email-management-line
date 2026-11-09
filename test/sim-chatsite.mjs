// סימולציה: ה-API של אתר הצאט (shmuel-lamed.github.io/chat)
import worker, * as entry from "../entry.js";

const kv = new Map([["g:refresh", "rt"], ["g:me", "1"]]);
const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } };
const env = { KV, PIN: "1234", BRIDGE_KEY: "bk", BUSINESS_EMAIL: "x@example-biz.com" };
const sent = [], sentFull = [], calls = [], uploads = [], changed = [];
let reacted = false;
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("oauth2")) return json({ access_token: "at", expires_in: 3600 });
  if (url.includes("people.googleapis.com") && !url.includes(":search")) return json({ names: [{ displayName: "משה" }] });
  const method = init.method || "GET";
  calls.push(method + " " + url);
  if (url.includes("/attachments:upload")) { uploads.push({ type: init.headers["Content-Type"], size: init.body.length, text: new TextDecoder().decode(init.body) }); return json({ attachmentDataRef: { attachmentUploadToken: "UP1" } }); }
  if (url.includes("/reactions")) {
    if (method === "POST") { if (reacted) return new Response(JSON.stringify({ error: { message: "exists" } }), { status: 409 }); reacted = true; return json({ name: "spaces/A/messages/2/reactions/r1" }); }
    if (method === "DELETE") { reacted = false; return json({}); }
    return json({ reactions: [{ name: "spaces/A/messages/2/reactions/r1" }] });
  }
  if (/\/messages\/[\w.-]+(\?|$)/.test(url)) {
    if (method === "GET") return json({ name: "x", sender: { name: url.includes("messages/1") ? "users/1" : "users/2" } });
    changed.push(method + " " + url.split("/v1/")[1] + (init.body ? " " + JSON.parse(init.body).text : "")); return json({});
  }
  if (url.includes("spaces:findDirectMessage")) return new Response("{}", { status: 404 });
  if (url.includes("spaces:setup")) { changed.push("setup " + JSON.parse(init.body).memberships[0].member.name); return json({ name: "spaces/NEW" }); }
  if (url.includes("people:search") || url.includes("otherContacts:search")) return url.includes("searchContacts") ? json({ results: [{ person: { names: [{ displayName: "דוד לוי" }], emailAddresses: [{ value: "David@Example-Biz.com" }] } }] }) : json({});
  if (url.includes("/spaceReadState")) return init.method === "PATCH" ? json({}) : json({ lastReadTime: "2026-11-01T00:00:00Z" });
  if (/\/messages(\?messageReplyOption=\w+)?$/.test(url) && init.method === "POST") { const b = JSON.parse(init.body); sent.push(b.text); sentFull.push(b); return json({ name: "spaces/A/messages/9" }); }
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
assert(ms.j.lastRead === "2026-11-01T00:00:00Z" && ms.j.more === false && ms.j.oldest === "2026-11-08T09:00:00Z", "הודעות: עד איפה קראתי, והאם יש ישנות יותר");
await call("messages", null, T, "?space=spaces/A&before=2026-11-08T09:00:00Z");
assert(decodeURIComponent(calls.filter((c) => c.includes("/messages?")).pop()).includes('createTime < "2026-11-08T09:00:00Z"'), "טעינת הודעות ישנות יותר");
assert((await call("messages", null, T, '?space=spaces/A&before=x" OR 1')).status === 400, "זמן לא תקין נדחה");
const r1 = await call("react", { space: "spaces/A", id: "spaces/A/messages/2", emoji: "👍" }, T);
const r2 = await call("react", { space: "spaces/A", id: "spaces/A/messages/2", emoji: "👍" }, T);
assert(r1.j.on === true && r2.j.on === false && reacted === false, "אמוג'י: לחיצה מוסיפה, לחיצה נוספת מסירה");
assert((await call("react", { space: "spaces/A", id: "spaces/B/messages/2", emoji: "👍" }, T)).status === 400 && (await call("react", { space: "spaces/A", id: "spaces/A/messages/2", emoji: 'a" OR' }, T)).status === 400, "אמוג'י: הודעה משיחה אחרת או אמוג'י לא תקין נדחים");
assert((await call("edit", { space: "spaces/A", id: "spaces/A/messages/2", text: "x" }, T)).status === 403 && (await call("delete", { space: "spaces/A", id: "spaces/A/messages/2" }, T)).status === 403 && !changed.length, "אי אפשר לתקן או למחוק הודעה של מישהו אחר");
await call("edit", { space: "spaces/A", id: "spaces/A/messages/1", text: "היי!" }, T);
await call("delete", { space: "spaces/A", id: "spaces/A/messages/1" }, T);
assert(changed[0] === "PATCH spaces/A/messages/1?updateMask=text היי!" && changed[1] === "DELETE spaces/A/messages/1", "תיקון ומחיקה של הודעה שלי");
const up = await call("send", { space: "spaces/A", text: "", file: { name: "דוח.pdf", type: "application/pdf", data: btoa("PDFDATA") } }, T);
assert(up.j.ok && uploads.length === 1 && uploads[0].text.includes("PDFDATA") && uploads[0].text.includes("דוח.pdf") && sentFull.pop().attachment[0].attachmentDataRef.attachmentUploadToken === "UP1", "שליחת קובץ מצורף");
assert((await call("send", { space: "spaces/A", file: { name: "a", data: "<script>" } }, T)).status === 400, "קובץ לא תקין נדחה");
const pp = await call("people", null, T, "?q=" + encodeURIComponent("דוד"));
assert(pp.j.people.length === 1 && pp.j.people[0].email === "david@example-biz.com" && pp.j.people[0].name === "דוד לוי", "חיפוש אדם לשיחה חדשה");
const dm = await call("dm", { email: "david@example-biz.com", name: "דוד לוי" }, T);
assert(dm.j.space === "spaces/NEW" && dm.j.title === "דוד לוי" && changed.includes("setup users/david@example-biz.com"), "פתיחת שיחה פרטית חדשה");
assert((await call("dm", { email: "x/../y" }, T)).status === 400, "כתובת לא תקינה נדחית");
await call("mute", { space: "spaces/B", on: true }, T);
assert(JSON.parse(kv.get("mute")).includes("spaces/B"), "השתקת קבוצה");
assert((await call("logout", {}, T)).j.ok && (await call("spaces", null, T)).status === 401, "יציאה מבטלת את האסימון");
const pre = await worker.fetch(new Request("https://w.dev/chatsite/spaces", { method: "OPTIONS", headers: { origin: ORIGIN } }), env, ectx);
assert(pre.status === 204 && pre.headers.get("access-control-allow-headers").includes("x-chat-token"), "בקשת CORS מקדימה");
assert(typeof entry.CallState === "function" && typeof worker.scheduled === "function", "נקודת הכניסה מייצאת את מחלקת השיחה ואת המשימה המתוזמנת");
assert((await worker.fetch(new Request("https://w.dev/bridge/peek?k=bad"), env, ectx)).status === 403, "שאר הקו ממשיך לעבוד דרך נקודת הכניסה");
console.log("כל בדיקות אתר הצאט עברו");
