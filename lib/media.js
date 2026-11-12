import { G, H, R, YM, b64, logEvent, nextVal, sha, sp, text, trimText } from "./base.js";
import { SPOKEN, accessToken, gapi } from "./google.js";
import { getJob } from "./state.js";
import { MAIL_KEYS, MAIL_MENU, attachmentBytes, convMenuRead } from "./menus.js";
import { DRIVE, HOLD_DIR, heb, startBgJob } from "./assistant.js";
import { bump } from "./voice.js";
import { runRecSave } from "./files.js";
import { go } from "./flow.js";

// ================================================================ סרטונים והקלטות (מהצאט ומיוטיוב)
// קובץ מהצאט: מורידים, מעלים לימות עם המרה לשמע, ומשמיעים. יוטיוב: Gemini צופה בסרטון ומחזיר תקציר או תמלול בעברית
// (את השמע המקורי של יוטיוב אי אפשר להוריד ולהשמיע). ההכנה רצה ברקע ב-Durable Object, והמתקשר שומע מנגינת המתנה.
const YT_API = "https://www.googleapis.com/youtube/v3/";
// יוטיוב: עם מפתח API (YT_KEY) אם הוגדר, אחרת עם ההרשאה של החשבון (דורשת youtube.readonly בחיבור לגוגל)
async function ytGet(env, path) {
  if (env.YT_KEY) {
    const r = await fetch(`${YT_API}${path}&key=${encodeURIComponent(env.YT_KEY)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`youtube ${r.status}: ${j?.error?.message || ""}`.slice(0, 300));
    return j;
  }
  return gapi(env, `${YT_API}${path}`);
}
async function ytTitles(env, ids) {
  if (!ids.length) return {};
  try {
    const j = await ytGet(env, `videos?part=snippet,contentDetails&id=${ids.join(",")}`);
    return Object.fromEntries((j.items || []).map((v) => [v.id, { title: v.snippet?.title || "", channel: v.snippet?.channelTitle || "", dur: v.contentDetails?.duration || "" }]));
  } catch { return {}; }
}
const ytDur = (d) => { const m = String(d).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); if (!m) return ""; const h = +m[1] || 0, mi = +m[2] || 0; return h ? `${h} שעות ו ${mi} דקות` : mi ? `${mi} דקות` : "פחות מדקה"; };

// ---- השמעת קובץ שמע או וידאו (מהצאט, מהמייל או מהדרייב) בטלפון
// ימות ממירה את הקובץ ל-wav (מווידאו נשאר רק הקול). אם ההמרה נכשלת, או כשמבקשים במילים, Gemini מתמלל את מה שנאמר.
const MEDIA_MAX = 45e6;
const MEDIA_EXT = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/x-aac": "aac",
  "audio/ogg": "ogg", "audio/opus": "opus", "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/amr": "amr",
  "audio/3gpp": "3gp", "audio/flac": "flac", "audio/x-flac": "flac", "audio/x-ms-wma": "wma",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp", "video/x-msvideo": "avi", "video/x-matroska": "mkv", "video/x-ms-wmv": "wmv", "video/x-m4v": "m4v", "video/mpeg": "mpeg",
};
const GEMINI_MEDIA = { mp3: "audio/mp3", m4a: "audio/aac", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac", amr: "audio/amr", wma: "video/wmv", webm: "video/webm", mp4: "video/mp4", m4v: "video/mp4", mov: "video/mov", "3gp": "video/3gpp", avi: "video/avi", mkv: "video/webm", wmv: "video/wmv", mpeg: "video/mpeg" };
const MEDIA_EXTS = new Set(Object.values(MEDIA_EXT));
const VIDEO_EXT = /^(mp4|mov|webm|3gp|avi|mkv|m4v|wmv|mpeg)$/;
// הסיומת קובעת איך ימות ממירה. שם בעברית או בלי סיומת (הודעה קולית) גורם לכשל, לכן שולחים תמיד שם באנגלית עם סיומת נכונה
function mediaExt(name, mime) {
  const m = String(name || "").match(/\.([a-z0-9]{2,4})$/i);
  if (m && MEDIA_EXTS.has(m[1].toLowerCase())) return m[1].toLowerCase();
  const t = String(mime || "").split(";")[0].trim().toLowerCase();
  return MEDIA_EXT[t] || (/^video\//.test(t) ? "mp4" : "mp3");
}
async function mediaBytes(env, job) {
  if (job.mailId) {
    if (job.size > MEDIA_MAX) return null;
    return attachmentBytes(env, job.mailId, job.attId);
  }
  const url = job.res ? `${G.chat}media/${job.res.split("/").map(encodeURIComponent).join("/")}?alt=media` : `${DRIVE}files/${job.drive}?alt=media`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + (await accessToken(env)) } });
  if (!r.ok) throw new Error("download " + r.status);
  if ((+r.headers.get("content-length") || 0) > MEDIA_MAX) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  return bytes.length > MEDIA_MAX ? null : bytes;
}
async function uploadMedia(env, file, bytes, ext) {
  const fd = new FormData();
  fd.append("token", env.YM_TOKEN);
  fd.append("path", `ivr2:${file}.wav`);
  fd.append("convertAudio", "1");
  fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), `media.${ext}`);
  const r = await fetch(YM + "UploadFile", { method: "POST", body: fd, signal: AbortSignal.timeout(300000) });
  const u = await r.json().catch(() => ({ responseStatus: "HTTP " + r.status }));
  if (u.responseStatus !== "OK") throw new Error("upload: " + (u.message || u.responseStatus));
}
// קובץ גדול עולה ל-Gemini דרך ה-Files API (בבקשה רגילה מותר עד 20 מגה כולל הקידוד)
async function geminiUpload(env, bytes, mime) {
  const base = "https://generativelanguage.googleapis.com";
  const start = await fetch(`${base}/upload/v1beta/files?key=${env.GEMINI_KEY}`, {
    method: "POST",
    headers: { "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(bytes.length), "X-Goog-Upload-Header-Content-Type": mime, "content-type": "application/json" },
    body: JSON.stringify({ file: { display_name: "phone-media" } }),
  });
  const upUrl = start.headers.get("x-goog-upload-url");
  if (!upUrl) throw new Error("gemini upload start " + start.status);
  const j = await (await fetch(upUrl, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: bytes, signal: AbortSignal.timeout(300000) })).json();
  let f = j.file;
  if (!f?.uri) throw new Error("gemini upload " + JSON.stringify(j).slice(0, 150));
  for (let i = 0; f.state === "PROCESSING" && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    f = await (await fetch(`${base}/v1beta/${f.name}?key=${env.GEMINI_KEY}`)).json();
  }
  if (f.state && f.state !== "ACTIVE") throw new Error("gemini file " + f.state);
  return f.uri;
}
async function mediaWords(env, bytes, ext) {
  if (!env.GEMINI_KEY) throw new Error("no GEMINI_KEY");
  const mime = GEMINI_MEDIA[ext] || "audio/mp3";
  const media = bytes.length <= 14e6 ? { inline_data: { mime_type: mime, data: b64(bytes) } } : { file_data: { mime_type: mime, file_uri: await geminiUpload(env, bytes, mime) } };
  const prompt = "כתוב בעברית את כל מה שנאמר בקובץ, מההתחלה ועד הסוף, כמו תמלול מלא. אם הדיבור בשפה אחרת, תרגם לעברית. אל תתאר מה רואים, רק מה שנאמר. אם יש שירה או מוזיקה בלי דיבור, כתוב רק שמדובר בשיר או במוזיקה. אם לא נאמר כלום, כתוב: לא נאמר כלום בקובץ. " + SPOKEN;
  let last = "";
  for (const m of ["gemini-flash-latest", "gemini-flash-lite-latest"]) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [media, { text: prompt }] }], generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW", maxOutputTokens: 8000, temperature: 0.2 } }),
        signal: AbortSignal.timeout(240000),
      });
      const j = await r.json();
      bump(env, "gemini");
      const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (t) return t;
      last = j?.error?.message || "empty";
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
}
async function runFileJob(env, job) {
  // מזהה הקובץ במייל משתנה בין בקשות, לכן המפתח למטמון הוא המייל + שם הקובץ + הגודל
  const key = (await sha(job.mailId ? `gmail:${job.mailId}:${job.name}:${job.size}` : job.res || job.drive)).slice(0, 16);
  const file = "/Media/" + key, words = job.mode === "words";
  if (!words && (await env.KV.get("media:" + key))) return { kind: "play", file };
  if (words) { const c = await env.KV.get("mw:" + key); if (c) return { kind: "say", text: c }; }
  const bytes = await mediaBytes(env, job);
  if (!bytes) return { kind: "say", text: "הקובץ גדול מדי להשמעה בטלפון." };
  const ext = mediaExt(job.name, job.mime);
  if (!words) {
    try {
      await uploadMedia(env, file, bytes, ext);
      await env.KV.put("media:" + key, "1", { expirationTtl: 30 * 86400 });
      return { kind: "play", file };
    } catch (e) { await logEvent(env, `המרת ${VIDEO_EXT.test(ext) ? "סרטון" : "הקלטה"} לשמע נכשלה (${ext}, ${Math.round(bytes.length / 1024)} קילובייט): ${e.message}`); }
  }
  try {
    const t = await mediaWords(env, bytes, ext);
    await env.KV.put("mw:" + key, t, { expirationTtl: 30 * 86400 });
    return { kind: "say", text: words ? t : "לא הצלחתי להשמיע את הקול המקורי, לכן הנה מה שנאמר בקובץ. " + t };
  } catch (e) {
    await logEvent(env, "תמלול קובץ שמע או וידאו נכשל: " + e.message);
    return { kind: "say", text: words ? "לא הצלחתי לתמלל את הקובץ." : "לא הצלחתי להכין את הקובץ לשמיעה." };
  }
}
async function runMediaJob(env, job) {
  if (job.type === "recsave") return runRecSave(env, job);
  if (job.type === "file") return runFileJob(env, job);
  if (job.type === "youtube") {
    if (!env.GEMINI_KEY) return { kind: "say", text: "השמעת סרטוני יוטיוב לא זמינה כרגע." };
    const ck = `yt:${job.id}:${job.mode}`;
    const c = await env.KV.get(ck);
    if (c) return { kind: "say", text: c };
    const prompt = job.mode === "full"
      ? "כתוב בעברית את כל מה שנאמר בסרטון, מההתחלה ועד הסוף, כמו תמלול מלא. אם הדיבור בשפה אחרת, תרגם לעברית. אל תתאר מה רואים, רק מה שנאמר. אם יש שירה, כתוב רק שמדובר בשיר ובמה הוא עוסק. " + SPOKEN
      : "סכם בעברית את הסרטון: במה הוא עוסק, מי מדבר אם זה ידוע, והנקודות העיקריות לפי הסדר. " + SPOKEN;
    let last = "";
    for (const m of ["gemini-flash-latest", "gemini-flash-lite-latest"]) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ file_data: { file_uri: "https://www.youtube.com/watch?v=" + job.id } }, { text: prompt }] }], generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW", maxOutputTokens: job.mode === "full" ? 8000 : 1500, temperature: 0.2 } }),
          signal: AbortSignal.timeout(240000),
        });
        const j = await r.json();
        const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        if (t) { await env.KV.put(ck, t, { expirationTtl: 30 * 86400 }); return { kind: "say", text: t }; }
        last = j?.error?.message || "empty";
      } catch (e) { last = e.message; }
    }
    await logEvent(env, "יוטיוב נכשל: " + last);
    return { kind: "say", text: "לא הצלחתי לעבד את הסרטון. ייתכן שהוא פרטי, מוגבל, או ארוך מדי." };
  }
  return { kind: "say", text: "סוג לא מוכר." };
}
async function startMediaJob(ctx, st, job) {
  const id = "mj" + st.n;
  st.media = { ...(st.media || {}), job: id, polls: 0, ...(job.type === "file" ? { fileJob: job } : {}) };
  await startBgJob(ctx, id, job);
  st.step = "mediaWait";
  return mediaWaitPrompt(st, job.type === "youtube" ? "מכין את הסרטון. זה יכול לקחת עד כמה דקות" : job.type === "recsave" ? "שומר ומתמלל, זה יכול לקחת קצת זמן" : job.mode === "words" ? "מתמלל את הקובץ, זה יכול לקחת קצת זמן" : "מכין את הקובץ לשמיעה, רגע");
}
function mediaWaitPrompt(st, text = "") {
  st.media.music = ((st.media.music || 0) % 3) + 1;
  const v = nextVal(st);
  return `read=${(text ? sp(text, "m") + "." : "") + `f-${HOLD_DIR}${st.media.music}`}=${v},no,1,1,1,No,yes,no,,,,Ok,none,`;
}

H.mediaPick = async (st, input, ctx) => {
  const list = st.media.list;
  if (input === undefined) {
    const titles = await ytTitles(ctx.env, list.filter((x) => x.kind === "youtube").map((x) => x.id));
    list.forEach((x) => { if (x.kind === "youtube") x.title = titles[x.id]?.title || ""; if (x.kind === "youtube") x.dur = ytDur(titles[x.id]?.dur || ""); });
    if (list.length === 1) return go(st, "mediaPick", "1", ctx);
    st.step = "mediaPick";
    const label = (x) => x.kind === "youtube" ? `סרטון יוטיוב${x.title ? " " + x.title : ""}${x.from ? " ששלח " + x.from : ""}` : `${x.video ? "סרטון" : "הקלטה"}${x.from ? " ששלח " + x.from : ""}`;
    const parts = await Promise.all(list.map(async (x, i) => `${await heb(ctx.env, label(x))}: הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => String(i + 1))].join("."));
  }
  if (input === "none") return go(st, "mediaPick", undefined, ctx);
  const x = list[+input - 1];
  if (!x) return mediaBack(st, ctx);
  st.media.cur = x;
  if (x.kind === "file") return startMediaJob(ctx, st, { type: "file", res: x.res, drive: x.drive, mime: x.mime, name: x.name });
  st.step = "mediaYtMode";
  const about = x.title ? `הסרטון ${await heb(ctx.env, x.title)}${x.dur ? `, באורך ${x.dur}` : ""}.` : "";
  return (about ? R.msg(about) : "") + R.menu(st, "את השמע המקורי של יוטיוב אי אפשר להשמיע, אבל אפשר לשמוע אותו במילים. " + ytModePrompt(st), ytModeKeys(st));
};
const canAskFile = (st) => !!(st.media?.cur?.msgName && st.media.back === "conv" && st.conv);
const ytModePrompt = (st) => "לתקציר הסרטון הקש 1. לתמלול מלא בעברית הקש 2. " + (canAskFile(st) ? "לבקש בשרשור שישלחו את הסרטון כקובץ, כדי לשמוע את הקול המקורי, הקש 3. " : "") + "לחזרה הקש 0.";
const ytModeKeys = (st) => (canAskFile(st) ? "0.1.2.3" : "0.1.2");
const ASK_FILE_TEXT = "אפשר לשלוח את הסרטון הזה כקובץ? אני בטלפון ולא יכול לפתוח יוטיוב. תודה!";
H.mediaYtMode = async (st, input, ctx) => {
  if (input === "none") return R.menu(st, ytModePrompt(st), ytModeKeys(st));
  if (input === "3" && canAskFile(st)) {
    st.step = "mediaAskFile";
    return R.msg(`תישלח תשובה בשרשור, עם ציטוט של ההודעה עם הקישור: ${ASK_FILE_TEXT}`) + R.menu(st, "לשליחה הקש 1. לביטול הקש 0.", "0.1");
  }
  if (input !== "1" && input !== "2") return mediaBack(st, ctx);
  return startMediaJob(ctx, st, { type: "youtube", id: st.media.cur.id, mode: input === "2" ? "full" : "summary" });
};
H.mediaAskFile = async (st, input, ctx) => {
  if (input !== "1") return mediaBack(st, ctx, "לא נשלח.");
  const x = st.media.cur, space = st.conv.items[st.conv.i].space;
  const q = x.thread ? "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : "";
  const base = { text: ASK_FILE_TEXT, ...(x.thread ? { thread: { name: x.thread } } : {}) };
  try {
    await gapi(ctx.env, `${G.chat}${space}/messages${q}`, { body: { ...base, quotedMessageMetadata: { name: x.msgName, lastUpdateTime: x.ut } } });
  } catch (e) {
    // אם הציטוט נדחה, שולחים בלי ציטוט רשמי אבל עם הטקסט המקורי
    await gapi(ctx.env, `${G.chat}${space}/messages${q}`, { body: { ...base, text: `"${trimText(x.text, 120)}"\n${ASK_FILE_TEXT}` } });
  }
  await logEvent(ctx.env, "נשלחה בקשה בשרשור לשלוח סרטון יוטיוב כקובץ");
  return mediaBack(st, ctx, "הבקשה נשלחה. כשישלחו את הקובץ, תוכל לשמוע אותו בשיחה בהקשה על 5.");
};
H.mediaWait = async (st, input, ctx) => {
  const job = await getJob(ctx.env, ctx.q.ApiCallId || "nocall");
  if (!job || job.id !== st.media.job || job.status !== "done") {
    st.media.polls++;
    if (st.media.polls > 70) return mediaBack(st, ctx, "זה לוקח יותר מדי זמן. נסה שוב מאוחר יותר.");
    return mediaWaitPrompt(st);
  }
  if (job.kind === "play") {
    st.media.file = job.file;
    return go(st, "mediaPlay", undefined, ctx);
  }
  const pages = [];
  let t = String(job.text || "");
  while (t.length) { const cut = t.length <= 2500 ? t.length : Math.max(t.lastIndexOf(". ", 2500) + 1, 1500); pages.push(t.slice(0, cut)); t = t.slice(cut).trim(); }
  st.media.pages = pages; st.media.page = 0;
  return go(st, "mediaText", undefined, ctx);
};
H.mediaPlay = async (st, input, ctx) => {
  if (input === undefined || input === "1") {
    st.step = "mediaPlay";
    const v = nextVal(st);
    return `read=f-${st.media.file}.${sp("לשמיעה חוזרת הקש 1. לשמיעת מה שנאמר בקובץ במילים, אם הקול לא ברור, הקש 2. לחזרה הקש 0.", "m")}=${v},no,1,1,10,No,no,no,,0.1.2.*,,Ok,none,`;
  }
  if (input === "2" && st.media.fileJob) return startMediaJob(ctx, st, { ...st.media.fileJob, mode: "words" });
  return mediaBack(st, ctx);
};
H.mediaText = async (st, input, ctx) => {
  const m = st.media;
  if (input === "1") m.page++;
  else if (input === "2") m.page = 0;
  else if (input !== undefined) return mediaBack(st, ctx);
  if (m.page >= m.pages.length) return mediaBack(st, ctx, "זה הסוף.");
  st.step = "mediaText";
  const more = m.page < m.pages.length - 1;
  return R.msg(m.pages[m.page]) + R.menu(st, (more ? "להמשך הקש 1. " : "") + "לשמיעה מההתחלה הקש 2. לחזרה הקש 0.", more ? "0.1.2" : "0.2");
};
function mediaBack(st, ctx, pre = "") {
  const back = st.media?.back;
  delete st.media;
  if (back === "conv" && st.conv) { st.step = "convMenu"; return (pre ? R.msg(pre) : "") + convMenuRead(st, st.conv.items[st.conv.i]); }
  if (back === "ai" && st.ai) return go(st, "aiListen", undefined, ctx, pre);
  if (back === "mail" && st.cur) { st.step = "mailMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  if (back === "files") return go(st, "filesMenu", undefined, ctx, pre);
  return go(st, "main", undefined, ctx, pre);
}

export { YT_API, ytGet, ytTitles, ytDur, MEDIA_MAX, MEDIA_EXT, GEMINI_MEDIA, MEDIA_EXTS, VIDEO_EXT, mediaExt, mediaBytes, uploadMedia, geminiUpload, mediaWords, runFileJob, runMediaJob, startMediaJob, mediaWaitPrompt, canAskFile, ytModePrompt, ytModeKeys, ASK_FILE_TEXT, mediaBack };
