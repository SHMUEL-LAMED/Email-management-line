// סימולציה של שיחות מול ה-Worker עם גוגל וימות מדומים
import worker from "../worker.js";

const kv = new Map();
const KV = {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  put: async (k, v) => { kv.set(k, String(v)); },
  delete: async (k) => { kv.delete(k); },
};
const sent = [];
const AI = {
  run: async (model, input) => {
    if (model.includes("whisper")) return { text: globalThis.__nextTranscript ?? "שלום זו תשובה לבדיקה" };
    const sys = input.messages[0].content;
    if (sys.includes("צורות כתיב")) return { response: "יוסי כהן\nYossi Cohen\nיוסף כהן" };
    if (sys.includes("נושא קצר")) return { response: "בדיקת מערכת" };
    return { response: "סיכום: יוסי ביקש את הדוח עד מחר. בקבוצת הצוות דנים בפגישה." };
  },
};
const env = {
  KV, AI,
  YM_TOKEN: "ym", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs",
  PIN: "1234", PATH_KEY: "pk", SETUP_KEY: "sk",
  ALLOWED_PHONES: "0500000000", BUSINESS_EMAIL: "me@example-biz.com",
};
kv.set("g:refresh", "rt");

const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const mails = {
  m1: { id: "m1", threadId: "t1", snippet: "שלום, אפשר לקבל את הדוח", payload: { headers: [{ name: "From", value: '"יוסי כהן" <yossi@ex.com>' }, { name: "Subject", value: "הדוח החודשי" }, { name: "Message-ID", value: "<a1@ex.com>" }], mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64u("שלום,\nאפשר לקבל את הדוח עד מחר? https://x.com/a\nתודה.\n\nOn Mon, Oct 5 2026 Shmuel wrote:\n> old text") } }] } },
  m2: { id: "m2", threadId: "t2", snippet: "מבצע", payload: { headers: [{ name: "From", value: "news@shop.com" }, { name: "Subject", value: "Sale - 50% off!" }], mimeType: "text/html", body: { data: b64u("<p>Big <b>sale</b> today &amp; tomorrow</p>") } } },
};
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init.method || "GET";
  if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
  if (url.includes("gmail/v1/users/me/messages?q=")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
  const mm = url.match(/messages\/(m\d)\?format=full/);
  if (mm) return json(mails[mm[1]]);
  if (url.includes("/modify")) { sent.push(["markread", url]); return json({}); }
  if (url.endsWith("messages/send")) {
    const raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString("utf8");
    const [head, body] = raw.split("\r\n\r\n");
    sent.push(["email", head, Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), JSON.parse(init.body).threadId]);
    return json({ id: "s1" });
  }
  if (url.includes("searchDirectoryPeople")) return json({ people: [{ resourceName: "people/111", emailAddresses: [{ value: "me@example-biz.com" }] }] });
  if (url.match(/people\/(222|333)\?/)) return json({ names: [{ displayName: url.includes("222") ? "דוד לוי" : "משה" }] });
  if (url.includes("people/me/connections")) return json({ connections: [{ names: [{ displayName: "Yossi Cohen" }], emailAddresses: [{ value: "yossi@ex.com" }] }, { names: [{ displayName: "דוד לוי" }], emailAddresses: [{ value: "david@example-biz.com" }] }] });
  if (url.includes("listDirectoryPeople") || url.includes("otherContacts")) return json({});
  if (url.includes("chat.googleapis.com/v1/spaces?")) return json({ spaces: [
    { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE", lastActiveTime: new Date().toISOString() },
    { name: "spaces/G1", spaceType: "SPACE", displayName: "צוות העבודה", lastActiveTime: new Date().toISOString() },
    { name: "spaces/G2", spaceType: "SPACE", displayName: "ישנה", lastActiveTime: "2026-10-01T00:00:00Z" },
  ] });
  if (url.includes("spaceReadState") && method === "PATCH") { sent.push(["chatread", url]); return json({}); }
  if (url.includes("spaceReadState")) return json({ lastReadTime: url.includes("G2") ? "2026-10-02T00:00:00Z" : "2026-10-10T00:00:00Z" });
  if (url.match(/spaces\/(DM1|G1|G2)\/messages\?/)) {
    const s = url.match(/spaces\/(\w+)\//)[1];
    return json({ messages: s === "DM1" ? [{ sender: { name: "users/222" }, text: "היי, מתי נפגשים?" }] : [{ sender: { name: "users/333" }, text: "מחר בעשר" }, { sender: { name: "users/111" }, text: "שלי" }] });
  }
  if (url.match(/spaces\/\w+\/members/)) return json({ memberships: [{ member: { name: "users/111", displayName: "שמואל" } }, { member: { name: "users/222", displayName: "דוד לוי" } }, { member: { name: "users/333", displayName: "משה" } }] });
  if (url.match(/spaces\/\w+\/messages$/) && method === "POST") { sent.push(["chat", url, JSON.parse(init.body).text]); return json({ name: "x" }); }
  if (url.includes("findDirectMessage")) return json({ name: "spaces/DM1" });
  if (url.includes("call2all.co.il/ym/api/DownloadFile")) return new Response(new Uint8Array(5000).fill(1));
  if (url.includes("call2all.co.il/ym/api/FileAction")) return json({ responseStatus: "OK" });
  throw new Error("unmocked fetch " + method + " " + url);
};

let call = 0;
async function dial(steps, phone = "0500000000") {
  const id = "c" + ++call;
  const vals = {};
  const req = async () => {
    const u = new URL("https://w.dev/yemot/pk");
    u.searchParams.set("ApiCallId", id); u.searchParams.set("ApiPhone", phone);
    for (const [k, v] of Object.entries(vals)) u.searchParams.set(k, v);
    const r = await worker.fetch(new Request(u), env, { waitUntil() {} });
    return r.text();
  };
  let out = await req();
  console.log(`\n===== שיחה ${id} (${phone})`);
  console.log("<<", out);
  for (const s of steps) {
    const m = [...out.matchAll(/read=[^&]*?=(V\d+),/g)].pop();
    if (!m) { console.log("!! no read in response, stop"); break; }
    if (typeof s === "object") { globalThis.__nextTranscript = s.say; vals[m[1]] = "/rec/" + m[1] + ".wav"; console.log(">> [הקלטה]", s.say); }
    else { vals[m[1]] = s; console.log(">>", s); }
    out = await req();
    console.log("<<", out);
  }
  return out;
}

await dial([], "0501111111");
await dial(["9999", "9999", "9999"]);
kv.delete("pinfails");
await dial(["1234", "1", "1", "1", "5", "2", { say: "בסדר אשלח לך מחר" }, "1", "4", "2", "2", { say: "בעשר מתאים לי" }, "1", "3", "1", "2", { say: "אני מגיע" }, "3", { say: "בעוד חמש דקות" }, "1"]);
await dial(["1234", "4", "1", { say: "יוסי כהן" }, "1", { say: "רציתי לבדוק שהמערכת עובדת" }, "1", "4", "2", { say: "דוד" }, "1", { say: "שלום דוד" }, "0", "5", "9", "1", "1", "5678", "5678", "1"]);
await dial(["5678", "3", "1"]);
console.log("\n===== פעולות שבוצעו");
for (const s of sent) console.log(JSON.stringify(s));
console.log("\n===== יומן"); console.log(kv.get("log"));
