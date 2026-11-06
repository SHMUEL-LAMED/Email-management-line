// סימולציה: השמעת קובץ שמע או וידאו בטלפון (מהצאט, מהמייל ומהדרייב), כולל נפילה לתמלול כשההמרה בימות נכשלת
import { runMediaJob, H } from "../worker.js";

const kv = new Map([["g:refresh", "rt"]]);
const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } };
const env = { KV, AI: { run: async () => ({ text: "" }) }, YM_TOKEN: "ym", GEMINI_KEY: "gk", PIN: "1", PATH_KEY: "pk", SETUP_KEY: "sk", ALLOWED_PHONES: "0500000000", BUSINESS_EMAIL: "x@y.com" };
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
let ymFails = false, uploads = [], gemini = [], geminiFiles = 0, downloads = [];
const big = new Uint8Array(16e6);
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("oauth2")) return json({ access_token: "at", expires_in: 3600 });
  if (url.includes("chat.googleapis.com/v1/media/")) { downloads.push("chat"); return new Response(new Uint8Array(30000), { headers: { "content-length": "30000" } }); }
  if (url.includes("googleapis.com/drive/v3/files/BIG")) { downloads.push("drive-big"); return new Response(big); }
  if (url.includes("googleapis.com/drive/v3/files/")) { downloads.push("drive"); return new Response(new Uint8Array(20000)); }
  if (url.includes("/attachments/")) { downloads.push("gmail"); return json({ data: Buffer.from("fake video bytes").toString("base64url") }); }
  if (url.includes("UploadFile")) {
    const f = init.body.get("file");
    uploads.push({ path: init.body.get("path"), name: f.name, convert: init.body.get("convertAudio") });
    return json(ymFails ? { responseStatus: "Exception", message: "file type not supported" } : { responseStatus: "OK" });
  }
  if (url.includes("upload/v1beta/files")) { geminiFiles++; return new Response("{}", { headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/up/123" } }); }
  if (url.includes("/up/123")) return json({ file: { name: "files/abc", uri: "https://g/files/abc", state: "ACTIVE" } });
  if (url.includes("generativelanguage")) {
    const b = JSON.parse(init.body);
    const part = b.contents[0].parts[0];
    gemini.push(part.inline_data ? "inline:" + part.inline_data.mime_type : "file:" + part.file_data.mime_type);
    return json({ candidates: [{ content: { parts: [{ text: "שלום, זו הודעה קולית לבדיקה." }] } }] });
  }
  if (url.includes("call2all")) return json({});
  throw new Error("unmocked " + url);
};
let fails = 0;
// הטקסט בתשובה לימות מקודד (לפני ההמרה לקול), לכן מפענחים אותו לבדיקה
const plain = (o) => o.replace(/\u0001[cm]([A-Za-z0-9_-]*)\u0002/g, (_, b) => Buffer.from(b, "base64url").toString("utf8"));
const check = (name, cond, extra = "") => { console.log((cond ? "ok: " : "FAIL: ") + name, extra); if (!cond) fails++; };

// 1. הודעה קולית בצאט: שם בעברית בלי סיומת. לימות נשלח שם באנגלית עם הסיומת לפי הסוג
let r = await runMediaJob(env, { type: "file", res: "spaces/S/messages/M/attachments/A", mime: "audio/ogg", name: "הודעה קולית" });
check("הודעה קולית מהצאט מושמעת", r.kind === "play" && /^\/Media\//.test(r.file));
check("נשלח לימות בשם media.ogg עם המרה", uploads[0]?.name === "media.ogg" && uploads[0].convert === "1" && uploads[0].path.endsWith(".wav"), JSON.stringify(uploads[0]));

// 2. סרטון שמצורף למייל
r = await runMediaJob(env, { type: "file", mailId: "m1", attId: "ATT1", size: 15, mime: "video/mp4", name: "סרטון מהחתונה.mp4" });
check("סרטון מהמייל מומר לשמע ומושמע", r.kind === "play" && downloads.includes("gmail") && uploads[1]?.name === "media.mp4");
// בפעם השנייה (מזהה הקובץ במייל השתנה) לא מעלים שוב
r = await runMediaJob(env, { type: "file", mailId: "m1", attId: "ATT1-other", size: 15, mime: "video/mp4", name: "סרטון מהחתונה.mp4" });
check("שמיעה חוזרת מהמטמון בלי העלאה נוספת", r.kind === "play" && uploads.length === 2);

// 3. ההמרה בימות נכשלת: תמלול במילים במקום שתיקה
ymFails = true;
r = await runMediaJob(env, { type: "file", mailId: "m2", attId: "ATT2", size: 15, mime: "audio/amr", name: "rec.amr" });
check("כשההמרה נכשלת שומעים את מה שנאמר במילים", r.kind === "say" && r.text.includes("לא הצלחתי להשמיע את הקול המקורי") && r.text.includes("הודעה קולית לבדיקה"), r.text);
check("התמלול נשלח ל-Gemini כ-amr", gemini.at(-1) === "inline:audio/amr");
const log = JSON.parse(kv.get("log") || "[]").join(" | ");
check("הכשל נרשם ביומן עם הסיבה", log.includes("file type not supported"));
ymFails = false;

// 4. בקשה לשמוע במילים (מקש 2 בתפריט השמיעה)
r = await runMediaJob(env, { type: "file", mailId: "m1", attId: "x", size: 15, mime: "video/mp4", name: "סרטון מהחתונה.mp4", mode: "words" });
check("תמלול במילים לפי בקשה", r.kind === "say" && r.text === "שלום, זו הודעה קולית לבדיקה.", r.text);
check("סרטון נשלח לתמלול כ-mp4", gemini.at(-1) === "inline:video/mp4");

// 5. קובץ גדול מהדרייב שלא הומר: עולה ל-Gemini דרך ה-Files API
ymFails = true;
r = await runMediaJob(env, { type: "file", drive: "BIG", mime: "video/quicktime", name: "lesson.mov" });
check("קובץ גדול מתומלל דרך ה-Files API", r.kind === "say" && geminiFiles === 1 && gemini.at(-1) === "file:video/mov");
ymFails = false;

// 6. קובץ גדול מדי במייל
r = await runMediaJob(env, { type: "file", mailId: "m3", attId: "A", size: 60e6, mime: "video/mp4", name: "x.mp4" });
check("קובץ גדול מדי", r.kind === "say" && r.text.includes("גדול מדי"));

// 7. תפריט השמיעה: מקש 2 מפעיל תמלול של אותו קובץ
const jobs = [];
const ctx = { env, q: { ApiCallId: "c1" }, ctx: { waitUntil: (p) => jobs.push(p) } };
const st = { n: 1, step: "mediaPlay", media: { back: "mail", file: "/Media/abc", fileJob: { type: "file", mailId: "m1", attId: "x", size: 15, mime: "video/mp4", name: "סרטון מהחתונה.mp4" } } };
let out = plain(await H.mediaPlay(st, undefined, ctx));
check("בתפריט השמיעה יש אפשרות לשמוע במילים", out.includes("f-/Media/abc") && out.includes("במילים") && out.includes("0.1.2.*"));
out = await H.mediaPlay(st, "2", ctx);
await Promise.all(jobs);
const job = JSON.parse(kv.get("job:c1"));
check("מקש 2 מתמלל את הקובץ", st.step === "mediaWait" && job.kind === "say" && job.text.includes("הודעה קולית"), out.slice(0, 80));

// 8. קבצים ששותפו איתי: הקלטה מהדרייב
const st2 = { n: 2, shared: [{ id: "D1", name: "שיעור.m4a", mime: "audio/mp4" }] };
out = plain(await H.sharedWithMe(st2, "1", ctx));
check("הקלטה מהדרייב מציעה שמיעה", out.includes("לשמיעה הקש 1"));
out = await H.sharedMenu(st2, "1", ctx);
await Promise.all(jobs);
const job2 = JSON.parse(kv.get("job:c1"));
check("הקלטה מהדרייב מומרת ומושמעת", st2.step === "mediaWait" && job2.kind === "play" && uploads.at(-1).name === "media.m4a");

// 9. קובץ מצורף במייל: מקש 1 בתפריט הקובץ ממיר ומשמיע
const st3 = { n: 3, cur: { id: "m9" }, att: { id: "A9", name: "הקלטה מהשיעור.mp3", mime: "audio/mpeg", size: 100 } };
await H.attMenu(st3, "1", ctx);
await Promise.all(jobs);
const job3 = JSON.parse(kv.get("job:c1"));
check("הקלטה שמצורפת למייל מומרת ומושמעת", st3.step === "mediaWait" && job3.kind === "play" && uploads.at(-1).name === "media.mp3");

console.log("\nFAILS:", fails);
process.exit(fails ? 1 : 0);
