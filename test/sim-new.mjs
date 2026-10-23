// סימולציה של התפריטים החדשים: מייל (עוד אפשרויות, חיפוש, דחייה), צ'אט (עוד אפשרויות), קבצים, הגדרות, ניווט בדיבור,
// המשך מאיפה שעצרת, קול טבעי, משימה מתוזמנת ומיילים לקלאוד
import worker, { scheduledTick, claudeMails, renderSpeech } from "../worker.js";

const kv = new Map();
const KV = { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } };
const sent = [];
const AI = { run: async () => ({ text: globalThis.__nextTranscript ?? "" , response: "x" }) };
const env = { KV, AI, YM_TOKEN: "ym", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", PIN: "1234", PATH_KEY: "pk", SETUP_KEY: "sk", GEMINI_KEY: "gk", ALLOWED_PHONES: "0500000000", BUSINESS_EMAIL: "me@example-biz.com" };
kv.set("g:refresh", "rt"); kv.set("voice", "off");

const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const mkMail = (id, from, subject, body, labels = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], extra = {}) => ({ id, threadId: "t" + id, labelIds: labels, snippet: body.slice(0, 40), internalDate: String(Date.now() - 3 * 86400e3),
  payload: { headers: [{ name: "From", value: from }, { name: "To", value: "me@example-biz.com" }, { name: "Subject", value: subject }, { name: "Date", value: new Date(Date.now() - 86400e3).toUTCString() }, { name: "Message-ID", value: `<${id}@ex>` }], mimeType: "multipart/mixed",
    parts: [{ mimeType: "text/plain", body: { data: b64u(body) } }, ...(extra.att ? [{ mimeType: "application/pdf", filename: "חשבונית.pdf", body: { attachmentId: "A1", size: 20000 } }] : [])] } });
const mails = {
  m1: mkMail("m1", '"יוסי כהן" <yossi@ex.com>', "הדוח החודשי", "שלום, אפשר לקבל את הדוח עד מחר?", ["INBOX", "UNREAD", "IMPORTANT"], { att: true }),
  m2: mkMail("m2", '"דוד לוי" <david@example-biz.com>', "חשבונית", "מצורפת החשבונית לחודש ספטמבר", ["INBOX", "UNREAD"], { att: true }),
  m3: mkMail("m3", '"שמואל" <me@example-biz.com>', "שאלה על ההצעה", "היי, מה עם ההצעה?", ["SENT"]),
  m4: mkMail("m4", '"שמואל" <me@example-biz.com>', "שש מה דעתך על הרעיון", "קלאוד, מה דעתך על הרעיון שלי לאתר?", ["SENT", "INBOX"]),
};
let drive = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init.method || (init.body ? "POST" : "GET");
  if (process.env.DBG && url.includes("drive")) console.log("   [fetch]", method, url.slice(0, 100));
  if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
  if (url.includes("generativelanguage")) {
    const b = JSON.parse(init.body);
    const text = JSON.stringify(b).slice(0, 4000);
    if (b.generationConfig?.responseModalities) return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.alloc(4000).toString("base64") } }] } }] });
    if (b.tools?.[0]?.google_search) return json({ candidates: [{ content: { parts: [{ text: "לפי האינטרנט, התשובה היא 42." }] } }] });
    if (b.tools) return json({ candidates: [{ content: { parts: [{ text: "העוזר: בדקתי, הכל בסדר." }] } }] });
    let out = "טקסט מהבינה";
    if (text.includes('"mime_type":"audio/wav"')) out = globalThis.__nextTranscript ?? "";
    else if (text.includes("inline_data")) out = "הקובץ הוא חשבונית על 500 שקל.";
    else if (text.includes("צורות כתיב")) out = "יוסי כהן\nYossi Cohen";
    else if (text.includes("person (שם")) out = '{"person":"יוסי","subject":"דוח","days":30,"sent":false}';
    else if (text.includes("who (שם הקבוצה")) out = '{"who":"צוות","keyword":""}';
    else if (text.includes("target אחד מתוך")) out = globalThis.__nav ?? '{"target":"phone_lookup","query":"יוסי"}';
    else if (text.includes("נושא קצר")) out = "בדיקה";
    else if (text.includes("לאנגלית")) out = "Hello David, I confirm.";
    else if (text.includes("כותב בשם שמואל")) out = "שלום דוד, מאשר. תודה, שמואל";
    else if (text.includes("סגנון הכתיבה שלו")) out = "פותח בשלום, חותם בשמואל, קצר וענייני";
    else if (text.includes("כותרת של עד 5")) out = "שיעור בגמרא";
    else if (text.includes("תן כותרת")) out = "שיעור";
    return json({ candidates: [{ content: { parts: [{ text: out }] } }] });
  }
  if (url.includes("gmail/v1/users/me/labels") && method === "POST") return json({ id: "L_new", name: JSON.parse(init.body).name });
  if (url.includes("gmail/v1/users/me/labels")) return json({ labels: [{ id: "L1", name: "לטיפול", type: "user" }] });
  if (url.includes("gmail/v1/users/me/messages?q=")) {
    const q = decodeURIComponent(url.split("q=")[1].split("&")[0]);
    if (q.includes("category:updates")) return json({});
    if (q.includes("label:לטיפול")) return json({ messages: [{ id: "m2" }] });
    if (q.includes("in:sent")) return json({ messages: [{ id: "m3" }] });
    if (q.includes("subject:שש")) return json({ messages: [{ id: "m4" }] });
    if (q.includes("has:attachment")) return json({ messages: [{ id: "m2" }] });
    return json({ messages: [{ id: "m2" }, { id: "m1" }] });
  }
  const mm = url.match(/messages\/(m\d)\?format=/);
  if (mm) return json(mails[mm[1]]);
  if (url.match(/threads\/t\w+\?/)) return json({ messages: [mails.m3] });
  if (url.includes("/attachments/A1")) return json({ data: Buffer.from("%PDF-1.4 fake").toString("base64url") });
  if (url.includes("/modify") || url.includes("batchModify")) { sent.push(["modify", url.split("/me/")[1], init.body]); return json({}); }
  if (url.endsWith("messages/send")) {
    const raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString("utf8");
    const head = raw.split("\r\n\r\n")[0];
    sent.push(["email", head.match(/To: (.*)/)[1], head.match(/Subject: (.*)/)[1].slice(0, 40), head.includes("multipart/mixed") ? "+attachment" : "", JSON.parse(init.body).threadId || ""]);
    return json({ id: "s" + sent.length });
  }
  if (url.includes("searchDirectoryPeople")) return json({ people: [{ resourceName: "people/111", emailAddresses: [{ value: "me@example-biz.com" }] }] });
  if (url.includes("people:searchContacts")) return json({ results: url.includes("query=&") ? [] : [{ person: { names: [{ displayName: "יוסי כהן" }], phoneNumbers: [{ value: "050-1234567" }], emailAddresses: [{ value: "yossi@ex.com" }] } }] });
  if (url.includes("people:createContact")) { sent.push(["contact", init.body]); return json({}); }
  if (url.includes("people/me/connections")) return json({ connections: [{ names: [{ displayName: "Yossi Cohen" }], emailAddresses: [{ value: "yossi@ex.com" }] }, { names: [{ displayName: "דוד לוי" }], emailAddresses: [{ value: "david@example-biz.com" }] }] });
  if (url.includes("listDirectoryPeople") || url.includes("otherContacts")) return json({});
  if (url.match(/people\/\d+\?/)) return json({ names: [{ displayName: "משה" }] });
  if (url.includes("chat.googleapis.com/v1/spaces?")) return json({ spaces: [
    { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE", lastActiveTime: new Date().toISOString() },
    { name: "spaces/G1", spaceType: "SPACE", displayName: "צוות העבודה", lastActiveTime: new Date().toISOString() },
  ] });
  if (url.includes("spaceReadState") && method === "PATCH") return json({});
  if (url.includes("spaceReadState")) return json({ lastReadTime: "2026-10-10T00:00:00Z" });
  if (url.match(/spaces\/(DM1|G1)\/messages\?/)) {
    const s = url.match(/spaces\/(\w+)\//)[1];
    return json({ messages: s === "DM1"
      ? [{ name: "spaces/DM1/messages/x1", sender: { name: "users/222" }, text: "היי, מתי נפגשים?", attachment: [{ contentName: "תמונה.jpg", contentType: "image/jpeg", attachmentDataRef: { resourceName: "spaces/DM1/messages/x1/attachments/a" } }] }, { name: "spaces/DM1/messages/x2", sender: { name: "users/111" }, text: "מחר" }]
      : [{ name: "spaces/G1/messages/y1", sender: { name: "users/333" }, text: "מחר בעשר @שמואל", annotations: [{ type: "USER_MENTION", userMention: { user: { name: "users/111" } } }] }] });
  }
  if (url.match(/spaces\/\w+\/members/) && method === "POST") { sent.push(["member", init.body]); return json({}); }
  if (url.match(/spaces\/\w+\/members/)) return json({ memberships: [{ member: { name: "users/111", displayName: "שמואל" } }, { member: { name: "users/222", displayName: "דוד לוי" } }, { member: { name: "users/333", displayName: "משה" } }] });
  if (url.includes("/reactions")) { sent.push(["like", url]); return json({}); }
  if (url.match(/messages\/x2$/) && method === "DELETE") { sent.push(["delmsg", url]); return json({}); }
  if (url.match(/messages\/x2\?updateMask/)) { sent.push(["editmsg", JSON.parse(init.body).text]); return json({}); }
  if (url.match(/spaces\/\w+\/messages(\?.*)?$/) && method === "POST") { sent.push(["chat", url.split("/v1/")[1].split("/messages")[0], JSON.parse(init.body).text?.slice(0, 50), JSON.parse(init.body).attachment ? "+audio" : ""]); return json({ name: "spaces/DM1/messages/new" }); }
  if (url.includes("attachments:upload")) return json({ attachmentDataRef: { resourceName: "spaces/DM1/attachments/up1", attachmentUploadToken: "tok" } }); // המבנה האמיתי של media.upload
  if (url.includes("findDirectMessage")) return json({ name: "spaces/DM1" });
  if (url.includes("chat.googleapis.com/v1/media/")) return new Response(new Uint8Array(3000));
  if (url.includes("upload/drive/v3/files")) { try { const b = Buffer.from(init.body).toString("utf8"); const meta = JSON.parse(b.split("\r\n\r\n")[1].split("\r\n")[0]); drive.push(meta); return json({ id: "up" + drive.length, name: meta.name, webViewLink: "https://drive/up" }); } catch (e) { console.log("UPLOAD MOCK ERR", e.message); throw e; } }
  if (url.includes("drive/v3/files?") && url.includes("sharedWithMe")) return json({ files: [{ id: "d9", name: "מצגת.pdf", mimeType: "application/pdf", sharingUser: { displayName: "דוד" }, sharedWithMeTime: new Date().toISOString() }] });
  if (url.includes("drive/v3/files?") && url.includes("folder")) return json({ files: [] });
  if (url.includes("drive/v3/files?")) return json({ files: [{ id: "d1", name: "חוזה שכירות.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }] });
  if (url.includes("drive/v3/files/d1?alt=media")) return new Response(new Uint8Array(2000));
  if (url.match(/drive\/v3\/files\/\w+\?fields/)) return json({ id: "d1", name: "חוזה שכירות.docx", mimeType: "application/octet-stream", webViewLink: "https://drive/d1" });
  if (url.includes("drive/v3/files") && method === "POST" && url.includes("permissions")) { sent.push(["perm", url.split("files/")[1].split("/")[0], init.body]); return json({}); }
  if (url.includes("drive/v3/files") && method === "POST") return json({ id: "folder1" });
  if (url.includes("calendar/v3/calendars/primary/events?")) return json({ items: [{ id: "e1", summary: "פגישה", start: { dateTime: "2026-10-12T10:00:00+03:00" }, end: { dateTime: "2026-10-12T11:00:00+03:00" } }] });
  if (url.includes("call2all.co.il/ym/api/DownloadFile")) return new Response(new Uint8Array(5000).fill(1));
  if (url.includes("call2all.co.il/ym/api/FileAction")) return json({ responseStatus: "OK" });
  if (url.includes("call2all.co.il/ym/api/UploadFile")) { sent.push(["ymupload"]); return json({ responseStatus: "OK" }); }
  if (url.startsWith("https://shmuel-lamed") || url.includes("workers.dev")) return new Response("ok");
  throw new Error("unmocked fetch " + method + " " + url);
};

let call = 0;
const pending = [];
const ectx = { waitUntil: (p) => pending.push(p) };
let fails = 0;
async function dial(steps, opts = {}) {
  const id = "c" + ++call;
  const vals = {};
  const req = async () => {
    await Promise.all(pending.splice(0));
    const u = new URL("https://w.dev/yemot/pk");
    u.searchParams.set("ApiCallId", id); u.searchParams.set("ApiPhone", "0500000000");
    for (const [k, v] of Object.entries(vals)) u.searchParams.set(k, v);
    return (await worker.fetch(new Request(u), env, ectx)).text();
  };
  let out = await req();
  console.log(`\n===== שיחה ${id}`);
  console.log("<<", out.slice(0, 400));
  for (const s of steps) {
    const m = [...out.matchAll(/read=[^&]*?=(V\d+),/g)].pop();
    if (!m) { console.log("!! no read in response, stop"); fails++; break; }
    if (typeof s === "object") { globalThis.__nextTranscript = s.say; if (s.nav) globalThis.__nav = s.nav; vals[m[1]] = "/rec/" + m[1] + ".wav"; console.log(">> [הקלטה]", s.say); }
    else { vals[m[1]] = s; console.log(">>", s); }
    out = await req();
    if (/תקלה|unmocked/.test(out)) fails++;
    console.log("<<", out.slice(0, 500));
  }
  if (opts.hangup) { const u = new URL("https://w.dev/yemot/pk"); u.searchParams.set("ApiCallId", id); u.searchParams.set("hangup", "yes"); await worker.fetch(new Request(u), env, ectx); await Promise.all(pending.splice(0)); console.log("-- ניתוק"); }
  return out;
}

// מייל: ראשי (חשובים קודם: m1 IMPORTANT לפני m2), עוד אפשרויות: לטיפול, דחייה, שמירה לדרייב, קבצים מצורפים, שמירת שולח, VIP
await dial(["1234", "1", "1", "6", "3", "6", "5", "6", "6", "1", "1", "6", "7", "1", "6", "8", "6", "4", "1"], { hangup: true });
// המשך מאיפה שעצרת (נשאר מייל אחד) -> 1, ואז הקראה מלאה בעמודים, תשובה מוכנה
await dial(["1234", "1", "1", "0", "6", "1", "2", "1", "0"]);
// חיפוש מייל בדיבור, לא נענו, ניסוח AI עם תרגום, צירוף הקלטה
await dial(["1234", "1", "5", { say: "המייל מיוסי על הדוח" }, "6", "2", { say: "תגיד לו שאני מאשר" }, "4", "5", "1", "0"]);
await dial(["1234", "1", "6", "3", "0"]);
// צ'אט: פרטי עם עוד אפשרויות: לייק, עריכת ההודעה האחרונה, מחיקה, הודעה קולית, קבצים מהשיחה -> שיתוף
await dial(["1234", "2", "6", "2", "6", "5", "1", { say: "מחרתיים" }, "1", "6", "5", "2", "1", "6", "6", { say: "שלום" }, "1", "6", "7", "1", { say: "יוסי" }, "1", "2", "1", "0"]);
// קבוצות: אזכור, סיכום, הוספת אדם, השתקה, ביטול השתקה בהגדרות
await dial(["1234", "3", "6", "1", "6", "4", { say: "יוסי" }, "1", "6", "3", "9", "5", "1", "0"]);
// חיפוש בצ'אט בדיבור מהתפריט הראשי (0) ומפתיחת קבוצה
await dial(["1234", "2", "4", "1", { say: "צוות העבודה" }, "0", "4", "3", { say: "דוד" }, "2", { say: "תכתוב לו שנפגש מחר" }, "1", "4", "4", { say: "יוסי" }, "0"]);
// קבצים: שיתוף מהדרייב במייל, שיתוף הקלטה בצ'אט, הקלטה לדרייב + תמלול, קבצים ששותפו
await dial(["1234", "8", "1", "1", { say: "חוזה" }, { say: "יוסי" }, "1", "1", "1", "1", "4", { say: "הקלטה" }, { say: "דוד" }, "1", "2", "1", "2", { say: "חלק ראשון" }, "4", { say: "חלק שני" }, "3", "none", "none", "0", "3", "1", "2", "0", "0", "0"]);
// הגדרות: קול, VIP, תשובות מוכנות, דוח שימוש, אתרים, שינוי באתר דרך קלאוד
await dial(["1234", "9", "2", "1", "3", "1", { say: "יוסי" }, "1", "0", "4", "1", { say: "אני בשיעור, אחזור אחר כך" }, "0", "6", "7", "9", { say: "תשנה את הצבע באתר ראש בראש לכחול" }, "none", "0"]);
// ניווט בדיבור: טלפון, חיפוש מייל, עוזר
await dial(["1234", "0", { say: "מה הטלפון של יוסי" }, "0", { say: "תפתח את המייל מיוסי", nav: '{"target":"mail_search","query":"המייל מיוסי"}' }, "0", "0", { say: "מה השעה בניו יורק", nav: '{"target":"assistant","query":""}' }, "none", "none", "0"]);
// חירום: קוד שגוי לא מנתק
await dial(["1234", "9", "1", "2", "0000", "0"]);

console.log("\n===== בדיקת קול טבעי");
kv.set("voice", "all");
const v = await renderSpeech(env, "id_list_message=\u0001c" + Buffer.from("שלום, יש לך 3 מיילים חדשים.").toString("base64url") + "\u0002&read=\u0001m" + Buffer.from("הקש 1").toString("base64url") + "\u0002=V1,no,1,1,10,No,yes,no,,0.1.*,,Ok,none,");
console.log(v);
if (!/f-\/tts\//.test(v)) fails++;
const v2 = await renderSpeech(env, "id_list_message=\u0001c" + Buffer.from("שלום, יש לך 3 מיילים חדשים.").toString("base64url") + "\u0002&");
console.log("cached:", v2, kv.has("tts:" + v.match(/tts\/(\w+)/)[1]) ? "(במטמון)" : "(!! לא במטמון)");
kv.set("voice", "off");

console.log("\n===== משימה מתוזמנת: דחיות + סיכום יומי");
kv.set("snooze", JSON.stringify([{ id: "m2", until: Date.now() - 1000, lid: "L_new" }]));
const realNow = Date.now;
await scheduledTick(env);
console.log("snooze after:", kv.get("snooze"));
kv.set("daily:" + new Date().toISOString().slice(0, 10), ""); kv.delete("daily:" + new Date().toISOString().slice(0, 10));
console.log("\n===== מיילים לקלאוד");
const cm = await claudeMails(env);
console.log(cm.map((m) => m.subject));
if (cm.length !== 1) fails++;
const bridgeKey = "bk"; env.BRIDGE_KEY = bridgeKey;
const r = await worker.fetch(new Request("https://w.dev/bridge/email_reply", { method: "POST", headers: { "x-bridge-key": bridgeKey }, body: JSON.stringify({ id: "m4", text: "רעיון מצוין, בוא נתחיל." }) }), env, ectx);
console.log(await r.text(), "| after reply:", (await claudeMails(env)).length);
const pk = await (await worker.fetch(new Request("https://w.dev/bridge/peek?k=" + bridgeKey), env, ectx)).json();
console.log("peek:", pk);

console.log("\n===== פעולות שבוצעו");
for (const s of sent) console.log(JSON.stringify(s));
console.log("drive uploads:", drive.map((d) => d.name));
console.log("\n===== יומן"); console.log(kv.get("log"));
console.log("\nFAILS:", fails);
process.exit(fails ? 1 : 0);
