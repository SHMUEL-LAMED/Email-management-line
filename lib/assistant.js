import { G, H, R, b64, b64url, kvJson, logEvent, nextVal, randKey, sp, text, trimText, unb64url, utf8b64 } from "./base.js";
import { SPOKEN, accessToken, chatDMSpace, chatSend, chatSpaces, chatUnread, contactBook, encHeader, findPeople, gapi, geminiBusy, geminiCall, gmailGet, gmailMarkRead, gmailSend, header, isBusy, isDM, isForeign, isGroup, isInlineImage, llm, markBusy, msgText, myUserId, normName, spaceMembers, spaceMessages, toHebrew } from "./google.js";
import { getJob, setJob, stub } from "./state.js";
import { transcribeVal } from "./menus.js";
import { runMediaJob, startMediaJob, ytDur, ytGet, ytTitles } from "./media.js";
import { updateAiMemory } from "./claude.js";
import { bump } from "./voice.js";
import { go } from "./flow.js";

// ================================================================ העוזר החכם
// עוזר קולי עם גישה לחשבון הגוגל. חיפושים רצים מיד; כל פעולה מחכה לאישור (1 לאישור, 2 לחזרה),
// ופעולה בלתי הפיכה (שליחה, מחיקה, יצירת אירוע) מבקשת אישור פעמיים. ההחלטה על אישור כפול נקבעת כאן בקוד, לא על ידי ה-AI.

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/";
const DRIVE = "https://www.googleapis.com/drive/v3/";

function ilOffset(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", timeZoneName: "longOffset" }).formatToParts(d);
  return (p.find((x) => x.type === "timeZoneName")?.value || "GMT+02:00").replace("GMT", "") || "+02:00";
}
function nowIL() {
  const d = new Date();
  const f = (o) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", ...o }).format(d);
  return `${f({ year: "numeric", month: "2-digit", day: "2-digit" })} ${f({ hour: "2-digit", minute: "2-digit", hour12: false })}, ${new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long" }).format(d)}`;
}
const spokenLabels = (t) => String(t).replace(/^\s*(מאת|נושא|תוכן)\s*:\s*/gm, (x, w) => (w === "תוכן" ? "" : w + " ")).replace(/\n+/g, ". ");
const catOf = (labels = []) => labels.includes("CATEGORY_UPDATES") ? "עדכונים" : labels.includes("CATEGORY_PROMOTIONS") ? "קידומי מכירות" : labels.includes("CATEGORY_SOCIAL") ? "רשתות חברתיות" : "ראשי";

async function chatTitle(env, space) {
  try {
    const s = await gapi(env, `${G.chat}${space}`);
    if (!isDM(s)) return "קבוצת " + (s.displayName || "בלי שם");
    const me = await myUserId(env);
    const names = await spaceMembers(env, space);
    return Object.entries(names).find(([u]) => u !== "users/" + me)?.[1] || "איש קשר";
  } catch { return "השיחה"; }
}
async function nameForEmail(env, email) {
  const book = await contactBook(env).catch(() => []);
  return book.find((c) => c.e.toLowerCase() === String(email).toLowerCase())?.n || String(email);
}
async function heb(env, t) { return isForeign(t) ? toHebrew(env, t, 800) : t; }

// ---- חיפושים (רצים בלי אישור)
const LOOKUP = {
  search_email: {
    desc: "חיפוש מיילים בתיבה. מקבל שאילתה בתחביר החיפוש של Gmail (למשל from:(avrahami OR אברהמי), subject:חשבונית, is:unread category:primary, newer_than:7d). מחזיר מזהה, שולח, נושא, תאריך, קטגוריה ותקציר קצר בלבד, לא את התוכן המלא.",
    params: { query: ["STRING", "שאילתת החיפוש"], max: ["INTEGER", "מספר תוצאות, עד 10"] }, req: ["query"],
    async run(env, a) {
      const max = Math.min(10, +a.max || 5);
      const j = await gapi(env, `${G.gmail}messages?q=${encodeURIComponent(a.query || "")}&maxResults=${max}`);
      return Promise.all((j.messages || []).map(async (m) => {
        const x = await gapi(env, `${G.gmail}messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        return { id: m.id, from: header(x, "From"), subject: header(x, "Subject"), date: header(x, "Date"), category: catOf(x.labelIds), unread: (x.labelIds || []).includes("UNREAD"), snippet: (x.snippet || "").slice(0, 160) };
      }));
    },
  },
  search_contacts: {
    desc: "חיפוש איש קשר לפי שם (אפשר שם בעברית גם כשהוא שמור באנגלית). מחזיר שמות וכתובות מייל בלבד. למספרי טלפון השתמש ב-get_contact_details.",
    params: { name: ["STRING", "השם"] }, req: ["name"],
    async run(env, a) { return (await findPeople(env, a.name || "")).map((c) => ({ name: c.n, email: c.e })); },
  },
  list_chats: {
    desc: "רשימת שיחות הצאט (פרטיות וקבוצות) שיש בהן הודעות שלא נקראו: מזהה שיחה, שם, סוג ומספר הודעות חדשות.",
    params: {}, req: [],
    async run(env) { return (await chatUnread(env, "all")).map((c) => ({ space: c.space, name: c.title, type: c.dm ? "פרטי" : "קבוצה", new_messages: c.msgs.length })); },
  },
  find_group: {
    desc: "מציאת קבוצת צאט לפי שם. מחזיר מזהה שיחה ושם.",
    params: { name: ["STRING", "שם הקבוצה או חלק ממנו"] }, req: ["name"],
    async run(env, a) {
      const n = normName(a.name);
      return (await chatSpaces(env)).filter(isGroup).filter((s) => { const d = normName(s.displayName); return d && (d.includes(n) || n.includes(d)); })
        .slice(0, 6).map((s) => ({ space: s.name, name: s.displayName }));
    },
  },
  list_events: {
    desc: "אירועים ביומן בטווח תאריכים: מזהה, כותרת, התחלה, סיום ומיקום.",
    params: { from: ["STRING", "תאריך התחלה YYYY-MM-DD"], to: ["STRING", "תאריך סיום YYYY-MM-DD (כולל)"] }, req: ["from", "to"],
    async run(env, a) {
      // ההפרש משעון UTC לפי התאריך המבוקש (שעון קיץ/חורף), לא לפי היום
      const offFrom = ilOffset(new Date(a.from + "T12:00:00Z")), offTo = ilOffset(new Date(a.to + "T12:00:00Z"));
      const j = await gapi(env, `${CAL}events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin=${encodeURIComponent(a.from + "T00:00:00" + offFrom)}&timeMax=${encodeURIComponent(a.to + "T23:59:59" + offTo)}`);
      return (j.items || []).map((e) => ({ id: e.id, title: e.summary || "", start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || "" }));
    },
  },
  search_drive: {
    desc: "חיפוש קבצים בגוגל דרייב לפי מילה בשם הקובץ או בתוכן. מחזיר מזהה, שם, סוג ותאריך שינוי.",
    params: { text: ["STRING", "מילת חיפוש"] }, req: ["text"],
    async run(env, a) {
      const t = String(a.text || "").replace(/\\/g, "").replace(/'/g, "\\'");
      const q = `trashed=false and (name contains '${t}' or fullText contains '${t}')`;
      const j = await gapi(env, `${DRIVE}files?pageSize=8&fields=files(id,name,mimeType,modifiedTime)&q=${encodeURIComponent(q)}`);
      return j.files || [];
    },
  },
};

// ---- פעולות (מחכות לאישור). twice = פעולה בלתי הפיכה, אישור כפול
// שגיאה "רכה" מ-describe: חסר פרט או אין תוצאות. חוזרת למודל כתשובת כלי כדי שישאל או יסביר, במקום "לא מצאתי"
const soft = (msg) => Object.assign(new Error(msg), { soft: true });
const ACTIONS = {
  play_email: {
    desc: "השמעת מייל מלא למשתמש (מתורגם לעברית אם הוא בשפה אחרת).",
    params: { id: ["STRING", "מזהה המייל מתוצאות החיפוש"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `להשמיע את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) {
      const e = await gmailGet(env, a.id);
      let t = `מאת: ${e.fromName}\nנושא: ${e.subject}\nתוכן: ${trimText(e.body, 3500)}`;
      if (isForeign(t)) t = "המייל באנגלית, הנה תרגום. " + (await toHebrew(env, t, 2500));
      return spokenLabels(t);
    },
  },
  summarize_email: {
    desc: "סיכום קצר של מייל.",
    params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `לסכם את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) {
      const e = await gmailGet(env, a.id);
      return llm(env, "סכם את המייל בשניים שלושה משפטים בעברית. ציין אם מבקשים ממני משהו ועד מתי. " + SPOKEN, `מאת: ${e.fromName}\nנושא: ${e.subject}\n\n${e.body}`, 400);
    },
  },
  mark_email_read: {
    desc: "סימון מייל כנקרא.", params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `לסמן כנקרא את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) { await gmailMarkRead(env, a.id); return "המייל סומן כנקרא."; },
  },
  archive_email: {
    desc: "העברת מייל לארכיון (הוצאה מתיבת הדואר הנכנס).", params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `להעביר לארכיון את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) { await gapi(env, `${G.gmail}messages/${a.id}/modify`, { body: { removeLabelIds: ["INBOX", "UNREAD"] } }); return "המייל הועבר לארכיון."; },
  },
  trash_email: {
    twice: true, desc: "מחיקת מייל (העברה לאשפה).", params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `למחוק את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) { await gapi(env, `${G.gmail}messages/${a.id}/trash`, { method: "POST" }); return "המייל נמחק."; },
  },
  reply_email: {
    twice: true, desc: "שליחת תשובה למייל. הגוף הוא בדיוק מה שהמשתמש ביקש לכתוב.",
    params: { id: ["STRING", "מזהה המייל שעונים עליו"], body: ["STRING", "תוכן התשובה"] }, req: ["id", "body"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return `לשלוח תשובה ל${await heb(env, e.fromName)} על המייל בנושא ${await heb(env, e.subject)}. תוכן התשובה: ${a.body}`; },
    async run(env, a) {
      const e = await gmailGet(env, a.id);
      const subject = /^(re|תשובה|השב)\s*:/i.test(e.subject) ? e.subject : "Re: " + e.subject;
      await gmailSend(env, { to: e.replyTo, subject, body: a.body, threadId: e.threadId, inReplyTo: e.msgId, refs: e.refs });
      return "התשובה נשלחה.";
    },
  },
  send_email: {
    twice: true, desc: "שליחת מייל חדש. את כתובת הנמען מוצאים קודם עם search_contacts.",
    params: { to: ["STRING", "כתובת המייל של הנמען"], subject: ["STRING", "נושא"], body: ["STRING", "תוכן המייל"] }, req: ["to", "subject", "body"],
    async describe(env, a) { return `לשלוח מייל אל ${await heb(env, await nameForEmail(env, a.to))} בנושא ${a.subject}. תוכן המייל: ${a.body}`; },
    async run(env, a) { await gmailSend(env, { to: a.to, subject: a.subject, body: a.body }); return "המייל נשלח."; },
  },
  play_chat: {
    desc: "השמעת ההודעות האחרונות בשיחת צאט.", params: { space: ["STRING", "מזהה השיחה (spaces/...)"] }, req: ["space"],
    async describe(env, a) { return `להשמיע את ההודעות האחרונות ב${await heb(env, await chatTitle(env, a.space))}`; },
    async run(env, a) {
      const me = await myUserId(env);
      const names = await spaceMembers(env, a.space);
      const msgs = await spaceMessages(env, a.space, null, 10);
      let t = msgs.map((m) => `${m.sender?.name === "users/" + me ? "אתה" : names[m.sender?.name] || "משתתף"} כתב: ${msgText(m)}`).join("\n");
      if (!t) return "אין הודעות בשיחה הזו.";
      if (isForeign(t)) t = "ההודעות באנגלית, הנה תרגום. " + (await toHebrew(env, t, 1500));
      return t;
    },
  },
  send_chat: {
    twice: true, desc: "שליחת הודעה בצאט: לשיחה קיימת (space) או לאדם לפי כתובת מייל (to_email, שמוצאים עם search_contacts).",
    params: { space: ["STRING", "מזהה שיחה קיימת, אם יש"], to_email: ["STRING", "כתובת מייל של אדם, אם אין מזהה שיחה"], text: ["STRING", "תוכן ההודעה"] }, req: ["text"],
    async describe(env, a) {
      if (!a.space && !a.to_email) throw soft("חסר נמען: צריך מזהה שיחה (space) או כתובת מייל של האדם (to_email).");
      const who = a.space ? await chatTitle(env, a.space) : await nameForEmail(env, a.to_email);
      return `לשלוח הודעה בצאט אל ${await heb(env, who)}. תוכן ההודעה: ${a.text}`;
    },
    async run(env, a) {
      const space = a.space || (await chatDMSpace(env, a.to_email));
      await chatSend(env, space, a.text);
      return "ההודעה נשלחה.";
    },
  },
  read_drive_file: {
    desc: "הקראת תוכן של מסמך מהדרייב (מסמך גוגל או קובץ טקסט).", params: { id: ["STRING", "מזהה הקובץ"] }, req: ["id"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return heb(env, `להקריא את הקובץ ${f.name}`); },
    async run(env, a) {
      const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name,mimeType`);
      const tok = await accessToken(env);
      let url;
      if (f.mimeType === "application/vnd.google-apps.document" || f.mimeType === "application/vnd.google-apps.presentation") url = `${DRIVE}files/${a.id}/export?mimeType=text/plain`;
      else if (f.mimeType === "application/vnd.google-apps.spreadsheet") url = `${DRIVE}files/${a.id}/export?mimeType=text/csv`;
      else if (/^text\//.test(f.mimeType)) url = `${DRIVE}files/${a.id}?alt=media`;
      else return "אי אפשר להקריא קובץ מהסוג הזה בטלפון.";
      const r = await fetch(url, { headers: { Authorization: "Bearer " + tok } });
      if (!r.ok) return "לא הצלחתי לפתוח את הקובץ.";
      let t = trimText(await r.text(), 3000);
      if (isForeign(t)) t = "הקובץ באנגלית, הנה תרגום. " + (await toHebrew(env, t, 2500));
      return t || "הקובץ ריק.";
    },
  },
  create_event: {
    twice: true, desc: "יצירת אירוע ביומן. אם יש משתתפים, הם יקבלו הזמנה במייל.",
    params: { title: ["STRING", "כותרת"], start: ["STRING", "התחלה YYYY-MM-DDTHH:MM (שעון ישראל)"], end: ["STRING", "סיום YYYY-MM-DDTHH:MM (שעון ישראל)"], attendees: ["STRING", "כתובות מייל של משתתפים מופרדות בפסיק (לא חובה)"] }, req: ["title", "start", "end"],
    async describe(env, a) {
      const fmt = (s) => String(s).replace("T", " בשעה ");
      return `ליצור ביומן אירוע בשם ${a.title}, מתאריך ${fmt(a.start)} עד ${fmt(a.end)}${a.attendees ? ", ולשלוח הזמנה למשתתפים" : ""}`;
    },
    async run(env, a) {
      const ev = { summary: a.title, start: { dateTime: a.start.length === 16 ? a.start + ":00" : a.start, timeZone: "Asia/Jerusalem" }, end: { dateTime: a.end.length === 16 ? a.end + ":00" : a.end, timeZone: "Asia/Jerusalem" } };
      const att = String(a.attendees || "").split(",").map((x) => x.trim()).filter((x) => x.includes("@"));
      if (att.length) ev.attendees = att.map((email) => ({ email }));
      await gapi(env, `${CAL}events?sendUpdates=all`, { body: ev });
      return "האירוע נוצר ביומן.";
    },
  },
  delete_event: {
    twice: true, desc: "מחיקת אירוע מהיומן.", params: { id: ["STRING", "מזהה האירוע"] }, req: ["id"],
    async describe(env, a) { const e = await gapi(env, `${CAL}events/${a.id}`); return heb(env, `למחוק מהיומן את האירוע ${e.summary || ""} שמתחיל ב ${String(e.start?.dateTime || e.start?.date || "").slice(0, 16).replace("T", " בשעה ")}`); },
    async run(env, a) { await gapi(env, `${CAL}events/${a.id}?sendUpdates=all`, { method: "DELETE" }); return "האירוע נמחק מהיומן."; },
  },
};

// ---- יכולות נוספות: משימות, מסמכים, גיליונות, אנשי קשר, תוויות, העברה, מענה אוטומטי, שיתוף, Meet
const TASKS = "https://tasks.googleapis.com/tasks/v1/";
const DOCS = "https://docs.googleapis.com/v1/documents";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";

async function gmailLabelId(env, name, create = false) {
  const j = await gapi(env, `${G.gmail}labels`);
  const found = (j.labels || []).find((l) => l.name.toLowerCase() === String(name).toLowerCase());
  if (found) return found.id;
  if (!create) throw new Error("תווית לא קיימת");
  return (await gapi(env, `${G.gmail}labels`, { body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } })).id;
}
async function emailLine(env, id) { const e = await gmailGet(env, id); return heb(env, `המייל מ${e.fromName} בנושא ${e.subject}`); }
const modifyEmail = (env, id, add = [], remove = []) => gapi(env, `${G.gmail}messages/${id}/modify`, { body: { addLabelIds: add, removeLabelIds: remove } });

Object.assign(LOOKUP, {
  list_tasks: {
    desc: "רשימת המשימות הפתוחות ב-Google Tasks: מזהה, כותרת ותאריך יעד.",
    params: {}, req: [],
    async run(env) {
      const j = await gapi(env, `${TASKS}lists/@default/tasks?showCompleted=false&maxResults=30`);
      return (j.items || []).map((t) => ({ id: t.id, title: t.title, due: t.due || "", notes: (t.notes || "").slice(0, 100) }));
    },
  },
  list_labels: {
    desc: "רשימת התוויות (תיקיות) שיש בתיבת המייל.",
    params: {}, req: [],
    async run(env) { return ((await gapi(env, `${G.gmail}labels`)).labels || []).filter((l) => l.type === "user").map((l) => l.name); },
  },
  get_auto_reply: {
    desc: "בדיקה אם המענה האוטומטי (חופשה/היעדרות) במייל פעיל ומה הוא אומר.",
    params: {}, req: [],
    async run(env) {
      const v = await gapi(env, `${G.gmail}settings/vacation`);
      return { on: !!v.enableAutoReply, subject: v.responseSubject || "", message: (v.responseBodyPlainText || "").slice(0, 300), until: v.endTime ? new Date(+v.endTime).toISOString() : "" };
    },
  },
});

Object.assign(ACTIONS, {
  mark_email_unread: {
    desc: "סימון מייל כלא נקרא.", params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { return `לסמן כלא נקרא את ${await emailLine(env, a.id)}`; },
    async run(env, a) { await modifyEmail(env, a.id, ["UNREAD"]); return "המייל סומן כלא נקרא."; },
  },
  star_email: {
    desc: "סימון מייל בכוכב (או הסרת הכוכב).", params: { id: ["STRING", "מזהה המייל"], remove: ["BOOLEAN", "true כדי להסיר את הכוכב"] }, req: ["id"],
    async describe(env, a) { return `${a.remove ? "להסיר את הכוכב מ" : "לסמן בכוכב את "}${await emailLine(env, a.id)}`; },
    async run(env, a) { await (a.remove ? modifyEmail(env, a.id, [], ["STARRED"]) : modifyEmail(env, a.id, ["STARRED"])); return a.remove ? "הכוכב הוסר." : "המייל סומן בכוכב."; },
  },
  restore_email: {
    desc: "שחזור מייל מהאשפה.", params: { id: ["STRING", "מזהה המייל (חיפוש עם in:trash)"] }, req: ["id"],
    async describe(env, a) { return `לשחזר מהאשפה את ${await emailLine(env, a.id)}`; },
    async run(env, a) { await gapi(env, `${G.gmail}messages/${a.id}/untrash`, { method: "POST" }); return "המייל שוחזר מהאשפה."; },
  },
  label_email: {
    desc: "הוספת תווית (תיקייה) למייל. אם התווית לא קיימת, היא תיווצר.", params: { id: ["STRING", "מזהה המייל"], label: ["STRING", "שם התווית"] }, req: ["id", "label"],
    async describe(env, a) { return `להוסיף את התווית ${a.label} ל${await emailLine(env, a.id)}`; },
    async run(env, a) { await modifyEmail(env, a.id, [await gmailLabelId(env, a.label, true)]); return `התווית ${a.label} נוספה למייל.`; },
  },
  forward_email: {
    twice: true, desc: "העברת מייל (כולל הקבצים המצורפים) לאדם אחר, עם הערה קצרה. את הכתובת מוצאים עם search_contacts.",
    params: { id: ["STRING", "מזהה המייל"], to: ["STRING", "כתובת המייל של הנמען"], note: ["STRING", "הערה קצרה שתופיע מעל המייל (לא חובה)"] }, req: ["id", "to"],
    async describe(env, a) { return `להעביר את ${await emailLine(env, a.id)} אל ${await heb(env, await nameForEmail(env, a.to))}${a.note ? `, עם ההערה: ${a.note}` : ""}`; },
    async run(env, a) {
      const e = await gmailGet(env, a.id);
      const raw = await gapi(env, `${G.gmail}messages/${a.id}?format=raw`);
      const original = unb64url(raw.raw); // נשאר בייטים: מייל מקורי בקידוד windows-1255 היה נהרס במעבר דרך מחרוזת UTF-8
      const b = "fwd" + randKey(16);
      const subject = /^(fwd?|הועבר)\s*:/i.test(e.subject) ? e.subject : "Fwd: " + e.subject;
      const head = new TextEncoder().encode([`To: ${a.to}`, `Subject: ${encHeader(subject)}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${b}"`, "",
        `--${b}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", utf8b64(a.note || "מצורף מייל שהועבר.").replace(/(.{76})/g, "$1\r\n"),
        `--${b}`, "Content-Type: message/rfc822", 'Content-Disposition: attachment; filename="forwarded.eml"', "", ""].join("\r\n"));
      const tail = new TextEncoder().encode(`\r\n--${b}--\r\n`);
      const msg = new Uint8Array(head.length + original.length + tail.length);
      msg.set(head); msg.set(original, head.length); msg.set(tail, head.length + original.length);
      if (msg.length > 4e6) {
        // מייל גדול (קבצים מצורפים): העלאת הבייטים ישירות, לא דרך JSON (שמוגבל לכמה מגה)
        const r = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", { method: "POST", headers: { Authorization: "Bearer " + (await accessToken(env)), "Content-Type": "message/rfc822" }, body: msg });
        if (!r.ok) throw new Error("gmail upload " + r.status + " " + ((await r.json().catch(() => ({}))).error?.message || ""));
      } else await gapi(env, `${G.gmail}messages/send`, { body: { raw: b64(msg).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") } });
      return "המייל הועבר.";
    },
  },
  set_auto_reply: {
    twice: true, desc: "הפעלה או כיבוי של מענה אוטומטי במייל (למשל בזמן היעדרות). כשמפעילים, כל מי ששולח מייל יקבל את ההודעה.",
    params: { on: ["BOOLEAN", "true להפעלה, false לכיבוי"], subject: ["STRING", "נושא ההודעה האוטומטית"], message: ["STRING", "תוכן ההודעה האוטומטית"], until: ["STRING", "עד איזה תאריך YYYY-MM-DD (לא חובה)"] }, req: ["on"],
    async describe(env, a) {
      if (a.on && !String(a.message || "").trim()) throw soft("חסר תוכן להודעה האוטומטית. שאל את המשתמש מה לכתוב.");
      return a.on ? `להפעיל מענה אוטומטי במייל${a.until ? ` עד ${a.until}` : ""}, עם ההודעה: ${a.message || ""}` : "לכבות את המענה האוטומטי במייל";
    },
    async run(env, a) {
      if (!a.on) {
        // כיבוי: שומרים את הנוסח הקיים (PUT מחליף את כל ההגדרה)
        const cur = await gapi(env, `${G.gmail}settings/vacation`).catch(() => ({}));
        await gapi(env, `${G.gmail}settings/vacation`, { method: "PUT", body: { ...cur, enableAutoReply: false } });
        return "המענה האוטומטי כובה.";
      }
      const body = { enableAutoReply: true, responseSubject: a.subject || "", responseBodyPlainText: a.message || "", restrictToContacts: false, restrictToDomain: false };
      if (a.until) body.endTime = String(Date.parse(a.until + "T23:59:59" + ilOffset(new Date(a.until + "T12:00:00Z"))));
      await gapi(env, `${G.gmail}settings/vacation`, { method: "PUT", body });
      return "המענה האוטומטי הופעל.";
    },
  },
  add_task: {
    desc: "הוספת משימה ל-Google Tasks.", params: { title: ["STRING", "המשימה"], due: ["STRING", "תאריך יעד YYYY-MM-DD (לא חובה)"], notes: ["STRING", "פרטים (לא חובה)"] }, req: ["title"],
    async describe(env, a) { return `להוסיף משימה: ${a.title}${a.due ? `, עד ${a.due}` : ""}`; },
    async run(env, a) {
      const t = { title: a.title, notes: a.notes || undefined };
      if (a.due) t.due = a.due + "T00:00:00.000Z";
      await gapi(env, `${TASKS}lists/@default/tasks`, { body: t });
      return "המשימה נוספה.";
    },
  },
  complete_task: {
    desc: "סימון משימה כבוצעה.", params: { id: ["STRING", "מזהה המשימה מ-list_tasks"] }, req: ["id"],
    async describe(env, a) { const t = await gapi(env, `${TASKS}lists/@default/tasks/${a.id}`); return `לסמן כבוצעה את המשימה: ${t.title}`; },
    async run(env, a) { await gapi(env, `${TASKS}lists/@default/tasks/${a.id}`, { method: "PATCH", body: { status: "completed" } }); return "המשימה סומנה כבוצעה."; },
  },
  delete_task: {
    twice: true, desc: "מחיקת משימה.", params: { id: ["STRING", "מזהה המשימה"] }, req: ["id"],
    async describe(env, a) { const t = await gapi(env, `${TASKS}lists/@default/tasks/${a.id}`); return `למחוק את המשימה: ${t.title}`; },
    async run(env, a) { await gapi(env, `${TASKS}lists/@default/tasks/${a.id}`, { method: "DELETE" }); return "המשימה נמחקה."; },
  },
  create_contact: {
    desc: "הוספת איש קשר חדש.", params: { name: ["STRING", "שם מלא"], email: ["STRING", "מייל (לא חובה)"], phone: ["STRING", "טלפון (לא חובה)"] }, req: ["name"],
    async describe(env, a) { return `להוסיף איש קשר בשם ${a.name}${a.phone ? `, טלפון ${a.phone.split("").join(" ")}` : ""}${a.email ? `, מייל ${a.email}` : ""}`; },
    async run(env, a) {
      const p = { names: [{ unstructuredName: a.name }] };
      if (a.email) p.emailAddresses = [{ value: a.email }];
      if (a.phone) p.phoneNumbers = [{ value: a.phone }];
      await gapi(env, `${G.people}people:createContact`, { body: p });
      await env.KV.delete("contacts").catch(() => {});
      return "איש הקשר נוסף.";
    },
  },
  create_doc: {
    desc: "יצירת מסמך גוגל חדש עם טקסט (למשל רשימה או סיכום שהמשתמש מכתיב).", params: { title: ["STRING", "שם המסמך"], text: ["STRING", "התוכן"] }, req: ["title", "text"],
    async describe(env, a) { return `ליצור מסמך חדש בשם ${a.title}, עם התוכן: ${trimText(a.text, 400)}`; },
    async run(env, a) {
      const d = await gapi(env, DOCS, { body: { title: a.title } });
      await gapi(env, `${DOCS}/${d.documentId}:batchUpdate`, { body: { requests: [{ insertText: { location: { index: 1 }, text: a.text } }] } });
      return { say: "המסמך נוצר בדרייב.", mem: `מזהה המסמך: ${d.documentId}` };
    },
  },
  append_to_doc: {
    desc: "הוספת טקסט לסוף מסמך גוגל קיים.", params: { id: ["STRING", "מזהה המסמך מ-search_drive"], text: ["STRING", "הטקסט להוספה"] }, req: ["id", "text"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `להוסיף לסוף המסמך ${await heb(env, f.name)} את הטקסט: ${trimText(a.text, 400)}`; },
    async run(env, a) {
      const d = await gapi(env, `${DOCS}/${a.id}?fields=body(content(endIndex))`);
      const end = Math.max(1, (d.body?.content || []).reduce((m, c) => Math.max(m, c.endIndex || 1), 1) - 1);
      await gapi(env, `${DOCS}/${a.id}:batchUpdate`, { body: { requests: [{ insertText: { location: { index: end }, text: "\n" + a.text } }] } });
      return "הטקסט נוסף למסמך.";
    },
  },
  read_sheet: {
    desc: "קריאת נתונים מגיליון גוגל (Sheets).", params: { id: ["STRING", "מזהה הגיליון מ-search_drive"], range: ["STRING", "טווח, למשל A1:F20 (לא חובה)"] }, req: ["id"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `להקריא נתונים מהגיליון ${await heb(env, f.name)}`; },
    async run(env, a) {
      const j = await gapi(env, `${SHEETS}${a.id}/values/${encodeURIComponent(a.range || "A1:H25")}`);
      const rows = (j.values || []).map((r) => r.join(", "));
      return rows.length ? llm(env, "הקרא בעברית את הנתונים מהטבלה בצורה ברורה לשמיעה בטלפון, שורה אחרי שורה, בקצרה. " + SPOKEN, rows.join("\n"), 800) : "הגיליון ריק בטווח הזה.";
    },
  },
  add_sheet_row: {
    desc: "הוספת שורה לסוף גיליון גוגל.", params: { id: ["STRING", "מזהה הגיליון"], values: ["STRING", "ערכי השורה מופרדים בפסיק"] }, req: ["id", "values"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `להוסיף לגיליון ${await heb(env, f.name)} שורה עם: ${a.values}`; },
    async run(env, a) {
      await gapi(env, `${SHEETS}${a.id}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { body: { values: [String(a.values).split(",").map((x) => x.trim())] } });
      return "השורה נוספה לגיליון.";
    },
  },
  share_drive_file: {
    twice: true, desc: "שיתוף קובץ מהדרייב עם אדם (הוא יקבל מייל הודעה).", params: { id: ["STRING", "מזהה הקובץ"], email: ["STRING", "מייל של מי שמשתפים איתו"], edit: ["BOOLEAN", "true להרשאת עריכה, אחרת צפייה בלבד"] }, req: ["id", "email"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `לשתף את הקובץ ${await heb(env, f.name)} עם ${await heb(env, await nameForEmail(env, a.email))}, ${a.edit ? "עם הרשאת עריכה" : "לצפייה בלבד"}`; },
    async run(env, a) { await gapi(env, `${DRIVE}files/${a.id}/permissions?sendNotificationEmail=true`, { body: { role: a.edit ? "writer" : "reader", type: "user", emailAddress: a.email } }); return "הקובץ שותף."; },
  },
  trash_drive_file: {
    twice: true, desc: "מחיקת קובץ מהדרייב (העברה לאשפה).", params: { id: ["STRING", "מזהה הקובץ"] }, req: ["id"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `למחוק מהדרייב את הקובץ ${await heb(env, f.name)}`; },
    async run(env, a) { await gapi(env, `${DRIVE}files/${a.id}`, { method: "PATCH", body: { trashed: true } }); return "הקובץ נמחק."; },
  },
  update_event: {
    twice: true, desc: "שינוי אירוע קיים ביומן (שעה, כותרת). משתתפים יקבלו עדכון.",
    params: { id: ["STRING", "מזהה האירוע"], title: ["STRING", "כותרת חדשה (לא חובה)"], start: ["STRING", "התחלה חדשה YYYY-MM-DDTHH:MM (לא חובה)"], end: ["STRING", "סיום חדש YYYY-MM-DDTHH:MM (לא חובה)"] }, req: ["id"],
    async describe(env, a) {
      const e = await gapi(env, `${CAL}events/${a.id}`);
      const fmt = (s) => String(s).slice(0, 16).replace("T", " בשעה ");
      return `לשנות ביומן את האירוע ${await heb(env, e.summary || "")}${a.title ? `, לשם ${a.title}` : ""}${a.start ? `, לזמן ${fmt(a.start)}${a.end ? ` עד ${fmt(a.end)}` : ""}` : ""}`;
    },
    async run(env, a) {
      const p = {};
      if (a.title) p.summary = a.title;
      const dt = (s) => ({ dateTime: s.length === 16 ? s + ":00" : s, timeZone: "Asia/Jerusalem" });
      if (a.start) p.start = dt(a.start);
      if (a.end) p.end = dt(a.end);
      if (a.start && !a.end) {
        // רק שעת התחלה חדשה: שומרים על אורך האירוע, אחרת גוגל דוחה התחלה שאחרי הסיום הישן
        const e = await gapi(env, `${CAL}events/${a.id}`);
        const dur = Date.parse(e.end?.dateTime || "") - Date.parse(e.start?.dateTime || "");
        const startMs = Date.parse(p.start.dateTime + ilOffset(new Date(p.start.dateTime + "Z")));
        if (dur > 0 && startMs) p.end = { dateTime: new Date(startMs + dur).toISOString(), timeZone: "Asia/Jerusalem" };
      }
      await gapi(env, `${CAL}events/${a.id}?sendUpdates=all`, { method: "PATCH", body: p });
      return "האירוע עודכן.";
    },
  },
  create_meet: {
    desc: "יצירת קישור לפגישת Google Meet חדשה (אפשר אחר כך לשלוח אותו במייל או בצאט).", params: {}, req: [],
    async describe() { return "ליצור קישור לפגישת מיט חדשה"; },
    async run(env) { const m = await gapi(env, "https://meet.googleapis.com/v2/spaces", { body: {} }); return { say: "נוצר קישור לפגישת מיט. אפשר לבקש ממני לשלוח אותו במייל או בצאט.", mem: `הקישור: ${m.meetingUri}` }; },
  },
});

// ---- עוד יכולות: פעולות על הרבה מיילים, טיוטות, קבצים מצורפים, זמנים פנויים, הזמנות, פרטי אנשי קשר, פתקים
async function gmailIds(env, q, max = 500) {
  let ids = [], tok = "";
  while (ids.length < max) {
    const j = await gapi(env, `${G.gmail}messages?q=${encodeURIComponent(q)}&maxResults=500${tok ? "&pageToken=" + tok : ""}`);
    ids = ids.concat((j.messages || []).map((m) => m.id));
    if (!(tok = j.nextPageToken)) break;
  }
  return ids.slice(0, max);
}
const BULK_MAX = 5000; // פעולות על הרבה מיילים: עד כאן בבת אחת (ולא 500 בשקט כאילו זה הכל)
const batchModify = (env, ids, add = [], remove = []) => gapi(env, `${G.gmail}messages/batchModify`, { body: { ids, addLabelIds: add, removeLabelIds: remove } });
const countWord = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
function attachmentsOf(payload) {
  const out = [];
  const walk = (p) => { if (!p) return; if (p.filename && p.body?.attachmentId && !isInlineImage(p)) out.push({ name: p.filename, mime: p.mimeType, id: p.body.attachmentId, size: p.body.size || 0 }); (p.parts || []).forEach(walk); };
  walk(payload);
  return out;
}

Object.assign(LOOKUP, {
  search_youtube: {
    desc: "חיפוש סרטונים ביוטיוב. מחזיר מזהה, כותרת, ערוץ ואורך.",
    params: { query: ["STRING", "מה לחפש"] }, req: ["query"],
    async run(env, a) {
      const j = await ytGet(env, `search?part=snippet&type=video&maxResults=6&q=${encodeURIComponent(a.query)}`);
      const ids = (j.items || []).map((v) => v.id?.videoId).filter(Boolean);
      const info = await ytTitles(env, ids);
      return ids.map((id) => ({ id, title: info[id]?.title || "", channel: info[id]?.channel || "", length: ytDur(info[id]?.dur || "") }));
    },
  },
  get_contact_details: {
    desc: "פרטי איש קשר לפי שם: טלפונים, מיילים וחברה.",
    params: { name: ["STRING", "השם"] }, req: ["name"],
    async run(env, a) {
      const out = [];
      const add = (p) => out.push({ name: p.names?.[0]?.displayName || "", phones: (p.phoneNumbers || []).map((x) => x.value), emails: (p.emailAddresses || []).map((x) => x.value), company: p.organizations?.[0]?.name || "" });
      await gapi(env, `${G.people}people:searchContacts?query=&readMask=names`).catch(() => {});
      const j = await gapi(env, `${G.people}people:searchContacts?query=${encodeURIComponent(a.name)}&readMask=names,emailAddresses,phoneNumbers,organizations&pageSize=8`).catch(() => ({}));
      (j.results || []).forEach((r) => add(r.person));
      const d = await gapi(env, `${G.people}people:searchDirectoryPeople?query=${encodeURIComponent(a.name)}&readMask=names,emailAddresses,phoneNumbers,organizations&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE`).catch(() => ({}));
      (d.people || []).forEach(add);
      if (!out.length) return (await findPeople(env, a.name)).map((c) => ({ name: c.n, emails: [c.e] }));
      return out.slice(0, 8);
    },
  },
  count_emails: {
    desc: "ספירת מיילים לפי חיפוש (למשל כמה מיילים לא נקראו בעדכונים: is:unread category:updates).",
    params: { query: ["STRING", "שאילתת חיפוש בתחביר Gmail"] }, req: ["query"],
    async run(env, a) { const n = (await gmailIds(env, a.query, 1000)).length; return { count: n, more_than: n >= 1000 }; },
  },
  list_attachments: {
    desc: "רשימת הקבצים המצורפים למייל.",
    params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async run(env, a) { const m = await gapi(env, `${G.gmail}messages/${a.id}?format=full`); return attachmentsOf(m.payload).map((x, i) => ({ index: i + 1, name: x.name, type: x.mime, kb: Math.round(x.size / 1024) })); },
  },
  list_drafts: {
    desc: "רשימת טיוטות המייל: מזהה, נמען ונושא.",
    params: {}, req: [],
    async run(env) {
      const j = await gapi(env, `${G.gmail}drafts?maxResults=10`);
      return Promise.all((j.drafts || []).map(async (d) => {
        const x = await gapi(env, `${G.gmail}drafts/${d.id}?format=metadata`);
        return { id: d.id, to: header(x.message, "To"), subject: header(x.message, "Subject") };
      }));
    },
  },
  find_free_time: {
    desc: "הזמנים התפוסים ביומן בתאריך מסוים, כדי למצוא מתי המשתמש פנוי.",
    params: { date: ["STRING", "תאריך YYYY-MM-DD"] }, req: ["date"],
    async run(env, a) {
      const off = ilOffset(new Date(a.date + "T12:00:00Z"));
      const j = await gapi(env, "https://www.googleapis.com/calendar/v3/freeBusy", { body: { timeMin: `${a.date}T07:00:00${off}`, timeMax: `${a.date}T23:00:00${off}`, timeZone: "Asia/Jerusalem", items: [{ id: "primary" }] } });
      return { busy: (j.calendars?.primary?.busy || []).map((b) => ({ from: b.start, to: b.end })), note: "השעות בפורמט עם אזור זמן; השעות הפנויות הן מה שבין התפוסים, בין 7:00 ל-23:00" };
    },
  },
  list_invitations: {
    desc: "הזמנות לאירועים ביומן שעדיין לא הגבתי עליהן (ב-30 הימים הקרובים).",
    params: {}, req: [],
    async run(env) {
      const j = await gapi(env, `${CAL}events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${encodeURIComponent(new Date().toISOString())}&timeMax=${encodeURIComponent(new Date(Date.now() + 30 * 86400e3).toISOString())}`);
      return (j.items || []).filter((e) => (e.attendees || []).some((x) => x.self && x.responseStatus === "needsAction"))
        .map((e) => ({ id: e.id, title: e.summary || "", start: e.start?.dateTime || e.start?.date, organizer: e.organizer?.displayName || e.organizer?.email || "" }));
    },
  },
  list_recent_files: {
    desc: "הקבצים האחרונים ששונו בדרייב.",
    params: {}, req: [],
    async run(env) { return ((await gapi(env, `${DRIVE}files?pageSize=10&orderBy=modifiedTime desc&q=${encodeURIComponent("trashed=false")}&fields=files(id,name,mimeType,modifiedTime)`)).files || []); },
  },
  list_notes: {
    desc: "הפתקים שהמשתמש ביקש ממך לזכור בשיחות קודמות.",
    params: {}, req: [],
    async run(env) { return (await kvJson(env, "notes", [])).map((n) => ({ id: n.id, text: n.t, saved: n.d })); },
  },
});

Object.assign(ACTIONS, {
  listen_youtube: {
    desc: "שמיעת סרטון יוטיוב בטלפון במילים: תקציר או תמלול מלא בעברית (את השמע המקורי של יוטיוב אי אפשר להשמיע). את המזהה מוצאים עם search_youtube, או מקישור שהמשתמש קיבל.",
    params: { id: ["STRING", "מזהה הסרטון (11 תווים)"], mode: ["STRING", "summary לתקציר או full לתמלול מלא"] }, req: ["id"],
    async describe(env, a) { const t = (await ytTitles(env, [a.id]))[a.id]; return `${a.mode === "full" ? "להקריא תמלול מלא בעברית של" : "לשמוע תקציר של"} הסרטון ${t ? await heb(env, t.title) : ""}${t?.dur ? `, באורך ${ytDur(t.dur)}` : ""}`; },
    async run() { return ""; },
  },
  mark_all_read: {
    desc: "סימון הרבה מיילים כנקראו בבת אחת לפי חיפוש (למשל כל העדכונים: is:unread category:updates).",
    params: { query: ["STRING", "שאילתת חיפוש בתחביר Gmail"] }, req: ["query"],
    async describe(env, a) { const n = (await gmailIds(env, a.query + " is:unread", BULK_MAX)).length; if (!n) throw soft("אין מיילים שלא נקראו שמתאימים לחיפוש הזה."); return `לסמן כנקראו ${countWord(n, "מייל אחד", "מיילים")}${n >= BULK_MAX ? " (החלק הראשון)" : ""} לפי החיפוש ${a.query}`; },
    async run(env, a) { const ids = await gmailIds(env, a.query + " is:unread", BULK_MAX); for (let i = 0; i < ids.length; i += 1000) await batchModify(env, ids.slice(i, i + 1000), [], ["UNREAD"]); return `${countWord(ids.length, "מייל אחד סומן", "מיילים סומנו")} כנקראו.`; },
  },
  archive_many: {
    desc: "העברת הרבה מיילים לארכיון בבת אחת לפי חיפוש.",
    params: { query: ["STRING", "שאילתת חיפוש בתחביר Gmail"] }, req: ["query"],
    async describe(env, a) { const n = (await gmailIds(env, a.query + " in:inbox", BULK_MAX)).length; if (!n) throw soft("אין מיילים בתיבה שמתאימים לחיפוש הזה."); return `להעביר לארכיון ${countWord(n, "מייל אחד", "מיילים")}${n >= BULK_MAX ? " (החלק הראשון)" : ""} לפי החיפוש ${a.query}`; },
    async run(env, a) { const ids = await gmailIds(env, a.query + " in:inbox", BULK_MAX); for (let i = 0; i < ids.length; i += 1000) await batchModify(env, ids.slice(i, i + 1000), [], ["INBOX"]); return `${countWord(ids.length, "מייל אחד הועבר", "מיילים הועברו")} לארכיון.`; },
  },
  trash_many: {
    twice: true, desc: "מחיקת הרבה מיילים בבת אחת לפי חיפוש (העברה לאשפה).",
    params: { query: ["STRING", "שאילתת חיפוש בתחביר Gmail"] }, req: ["query"],
    async describe(env, a) { const n = (await gmailIds(env, a.query, BULK_MAX)).length; if (!n) throw soft("אין מיילים שמתאימים לחיפוש הזה."); return `למחוק ${countWord(n, "מייל אחד", "מיילים")}${n >= BULK_MAX ? " (החלק הראשון)" : ""} לפי החיפוש ${a.query}`; },
    async run(env, a) { const ids = await gmailIds(env, a.query, BULK_MAX); for (let i = 0; i < ids.length; i += 1000) await batchModify(env, ids.slice(i, i + 1000), ["TRASH"], ["INBOX"]); return `${countWord(ids.length, "מייל אחד נמחק", "מיילים נמחקו")}.`; },
  },
  read_attachment: {
    desc: "הקראה או סיכום של קובץ מצורף למייל (PDF, תמונה, מסמך טקסט). את מספר הקובץ לוקחים מ-list_attachments.",
    params: { id: ["STRING", "מזהה המייל"], index: ["INTEGER", "מספר הקובץ ברשימה (ברירת מחדל 1)"], mode: ["STRING", "summary לסיכום או full להקראה מלאה"] }, req: ["id"],
    async describe(env, a) {
      const m = await gapi(env, `${G.gmail}messages/${a.id}?format=full`);
      const att = attachmentsOf(m.payload)[(+a.index || 1) - 1];
      if (!att) throw soft("אין קובץ מצורף במספר הזה. בדוק עם list_attachments.");
      return `${a.mode === "full" ? "להקריא" : "לסכם"} את הקובץ המצורף ${await heb(env, att.name)}`;
    },
    async run(env, a) {
      const m = await gapi(env, `${G.gmail}messages/${a.id}?format=full`);
      const att = attachmentsOf(m.payload)[(+a.index || 1) - 1];
      if (!att) return "לא מצאתי את הקובץ.";
      if (att.size > 12e6) return "הקובץ גדול מדי להקראה בטלפון.";
      const data = (await gapi(env, `${G.gmail}messages/${a.id}/attachments/${att.id}`)).data.replace(/-/g, "+").replace(/_/g, "/");
      const mime = /pdf|image\/|text\//.test(att.mime) ? att.mime : /\.pdf$/i.test(att.name) ? "application/pdf" : att.mime;
      if (!/pdf|image\/|text\//.test(mime)) return "אי אפשר להקריא קובץ מהסוג הזה בטלפון.";
      if (!env.GEMINI_KEY) return "הקראת קבצים לא זמינה כרגע.";
      return geminiCall(env, [
        { text: (a.mode === "full" ? "הקרא בעברית את התוכן של הקובץ, בצורה ברורה לשמיעה בטלפון. אם הוא בשפה אחרת, תרגם לעברית. " : "סכם בעברית את הקובץ: במה מדובר, הפרטים החשובים (סכומים, תאריכים, שמות), ומה מבקשים ממני. ") + SPOKEN },
        { inline_data: { mime_type: mime, data } },
      ], 2000, Date.now() + 90000); // רץ ברקע (משימת DO), לכן מותר לו יותר זמן מקריאה רגילה
    },
  },
  create_draft: {
    desc: "שמירת מייל כטיוטה בלי לשלוח אותו.",
    params: { to: ["STRING", "כתובת הנמען"], subject: ["STRING", "נושא"], body: ["STRING", "תוכן"] }, req: ["to", "subject", "body"],
    async describe(env, a) { return `לשמור טיוטה של מייל אל ${await heb(env, await nameForEmail(env, a.to))} בנושא ${a.subject}. התוכן: ${a.body}`; },
    async run(env, a) {
      const raw = [`To: ${a.to}`, `Subject: ${encHeader(a.subject)}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", utf8b64(a.body)].join("\r\n");
      await gapi(env, `${G.gmail}drafts`, { body: { message: { raw: b64url(raw) } } });
      return "הטיוטה נשמרה.";
    },
  },
  send_draft: {
    twice: true, desc: "שליחת טיוטה קיימת. את המזהה לוקחים מ-list_drafts.",
    params: { id: ["STRING", "מזהה הטיוטה"] }, req: ["id"],
    async describe(env, a) { const x = await gapi(env, `${G.gmail}drafts/${a.id}?format=metadata`); return heb(env, `לשלוח את הטיוטה אל ${header(x.message, "To")} בנושא ${header(x.message, "Subject")}`); },
    async run(env, a) { await gapi(env, `${G.gmail}drafts/send`, { body: { id: a.id } }); return "הטיוטה נשלחה."; },
  },
  respond_invitation: {
    twice: true, desc: "תגובה להזמנה לאירוע ביומן: אישור הגעה, סירוב או אולי. המארגן יקבל את התשובה.",
    params: { id: ["STRING", "מזהה האירוע"], response: ["STRING", "accepted לאישור, declined לסירוב, tentative לאולי"] }, req: ["id", "response"],
    async describe(env, a) {
      const e = await gapi(env, `${CAL}events/${a.id}`);
      const word = { accepted: "לאשר הגעה", declined: "לסרב", tentative: "לענות אולי" }[a.response] || "להגיב";
      return heb(env, `${word} להזמנה ${e.summary || ""} של ${e.organizer?.displayName || e.organizer?.email || ""}`);
    },
    async run(env, a) {
      const e = await gapi(env, `${CAL}events/${a.id}`);
      const attendees = (e.attendees || []).map((x) => (x.self ? { ...x, responseStatus: a.response } : x));
      await gapi(env, `${CAL}events/${a.id}?sendUpdates=all`, { method: "PATCH", body: { attendees } });
      return "התשובה להזמנה נשלחה.";
    },
  },
  save_note: {
    desc: "שמירת פתק שהמשתמש מבקש שתזכור (למשל מספר, סיסמה לשער, דבר לזכור). נשמר גם לשיחות הבאות.",
    params: { text: ["STRING", "מה לזכור"] }, req: ["text"],
    async describe(env, a) { return `לשמור פתק: ${a.text}`; },
    async run(env, a) {
      const n = await kvJson(env, "notes", []);
      n.push({ id: randKey(6), t: a.text, d: nowIL() });
      await env.KV.put("notes", JSON.stringify(n.slice(-100)));
      return "הפתק נשמר.";
    },
  },
  delete_note: {
    desc: "מחיקת פתק שמור. את המזהה לוקחים מ-list_notes.",
    params: { id: ["STRING", "מזהה הפתק"] }, req: ["id"],
    async describe(env, a) { const n = (await kvJson(env, "notes", [])).find((x) => x.id === a.id); if (!n) throw soft("אין פתק עם המזהה הזה. בדוק עם list_notes."); return `למחוק את הפתק: ${n.t}`; },
    async run(env, a) { const n = await kvJson(env, "notes", []); await env.KV.put("notes", JSON.stringify(n.filter((x) => x.id !== a.id))); return "הפתק נמחק."; },
  },
});

// תפריט בחירה: כשיש ספק, העוזר מציג אפשרויות ממוספרות והמשתמש בוחר במקש
const ASK_CHOICE = {
  name: "ask_choice",
  description: "[תפריט שאלה] הצגת שאלה עם אפשרויות ממוספרות שהמשתמש בוחר בהן במקש בטלפון. השתמש בזה בכל פעם שיש ספק מה המשתמש התכוון, כשיש כמה התאמות (כמה מיילים, כמה אנשים בשם דומה, כמה אירועים), או כשחסר פרט ויש כמה אפשרויות סבירות. כל אפשרות צריכה להיות קצרה וברורה (עד 12 מילים), עם הפרטים שמבדילים בין האפשרויות.",
  parameters: {
    type: "OBJECT",
    properties: {
      question: { type: "STRING", description: "השאלה, קצרה" },
      options: { type: "ARRAY", items: { type: "STRING" }, description: "בין 2 ל-8 אפשרויות" },
    },
    required: ["question", "options"],
  },
};
function toolDecls() {
  const all = { ...LOOKUP, ...ACTIONS };
  return [ASK_CHOICE].concat(Object.entries(all).map(([name, t]) => ({
    name,
    description: (ACTIONS[name] ? "[פעולה שדורשת אישור מהמשתמש] " : "[חיפוש] ") + t.desc,
    // כלי בלי פרמטרים נשלח בלי parameters: סכמת OBJECT עם properties ריק נדחית על ידי Gemini (400) ומפילה את כל השיחה
    ...(Object.keys(t.params).length ? {
      parameters: {
        type: "OBJECT",
        properties: Object.fromEntries(Object.entries(t.params).map(([k, [type, description]]) => [k, { type, description }])),
        required: t.req,
      },
    } : {}),
  })));
}

function aiSystem(env, mem = "") {
  return `${mem ? "זיכרון משיחות קודמות (לשימושך, אל תקריא אותו סתם):\n" + mem + "\n\n" : ""}אתה העוזר האישי הקולי והחכם של שמואל, שמדבר איתו בטלפון. יש לך גישה לחשבון הגוגל העסקי שלו (${env.BUSINESS_EMAIL}): מייל (קטגוריות ראשי ועדכונים, תוויות, כוכבים, העברה, מענה אוטומטי, טיוטות, קבצים מצורפים ופעולות על הרבה מיילים בבת אחת), צאט, יומן (כולל זמנים פנויים והזמנות), יוטיוב (חיפוש ושמיעת סרטון במילים: תקציר או תמלול), דרייב, מסמכים וגיליונות, משימות (Google Tasks), אנשי קשר עם טלפונים, קישורי Meet, ופתקים שהמשתמש ביקש שתזכור. יש לך גם חיפוש באינטרנט (web_search) לשאלות כלליות, חדשות, שעות וזמנים.
בתחילת שיחה, אם המשתמש שואל על משהו שאולי ביקש ממך לזכור, בדוק ב-list_notes.
השעה עכשיו בישראל: ${nowIL()}.
חשוב: הבקשות שלך מגיעות מתמלול אוטומטי של דיבור בטלפון, ולכן ייתכנו בהן שגיאות: מילה שנשמעה דומה במקום המילה הנכונה, שם שנכתב קצת אחרת, מספרים או שעות שנכתבו בצורה מוזרה, או חוסר בפיסוק.
- הבן את הכוונה הסבירה ביותר לפי ההקשר, ולא לפי המילים המדויקות. למשל "תשמיע לי את המייל מאברהם" יכול להיות אברהמי, ו"בשלוש" יכול להיות 15:00.
- כשמחפשים אדם לפי שם, חפש גם צורות דומות של השם (search_contacts כבר מחפש התאמה חלקית) ואם צריך חפש שוב בצורה אחרת לפני שאתה אומר שלא מצאת.
- בתוכן של הודעה שהמשתמש מכתיב, תקן רק שגיאות תמלול ברורות (מילה שלא מתאימה למשפט), בלי לשנות את המשמעות.
- בכל פעם שיש לך ספק מה המשתמש התכוון, או שיש כמה התאמות אפשריות (כמה מיילים, כמה אנשים בשם דומה, כמה אירועים), אל תנחש: פתח תפריט עם ask_choice, עם אפשרויות ממוספרות וברורות שמבדילות ביניהן (למשל שם מלא, נושא, תאריך). אם יש רק פירוש סביר אחד, המשך, כי המשתמש ישמע את הפרטים ויאשר לפני הביצוע.
- מותר תמיד לפתוח תפריט שאלה עם ask_choice גם כדי לברר פרט חסר (למשל לאיזה יום, לחצי שעה או לשעה, איזה מסמך).
- אם הבקשה עמומה ואין בשיחה הקשר שמבהיר אותה (למשל "תמחק את זה" בלי שדיברנו על משהו), פתח קודם תפריט עם ask_choice שמציע את הפירושים הסבירים, במקום לחפש לפי ניחוש.
כללים:
- ענה תמיד בעברית, בצורה מלאה, מדויקת ומפורטת כמה שצריך כדי לענות באמת על הבקשה: כלול את הפרטים החשובים (שמות, תאריכים, שעות, מספרים, מה מבקשים ממנו). אל תמציא פרטים שלא מצאת. כי התשובה מוקראת בטלפון, כתוב במשפטים ברורים, בלי רשימות, כוכביות, סימנים או אימוג'י. שמות באנגלית כתוב באותיות עבריות.
- מותר לך להשתמש בכלי החיפוש בחופשיות כדי למצוא מידע, ולספר למשתמש מה מצאת (למשל ממי הגיעו מיילים ובאיזה נושא, או מה יש ביומן).
- כדי להשמיע תוכן מלא או לבצע כל פעולה (השמעה, סיכום, שליחה, תשובה, מחיקה, ארכיון, יצירת אירוע) חובה לקרוא לכלי הפעולה המתאים. המערכת תשאל את המשתמש אם לאשר. לעולם אל תגיד שפעולה בוצעה, אלא אם בהיסטוריה כתוב שהיא בוצעה.
- הצע פעולה אחת בכל פעם.
- כשמחפשים מייל לפי שם אדם, חפש גם בכתיב העברי וגם בכתיב האנגלי, למשל from:(avrahami OR אברהמי). אם יש כמה התאמות, בחר את האחרונה שמתאימה לבקשה, או שאל את המשתמש איזו.
- בשליחת הודעות, כתוב בדיוק את מה שהמשתמש ביקש לומר, רק עם תיקון קל של ניסוח. אל תמציא תוכן. אם חסר נמען או תוכן, שאל.
- את כתובת המייל של אדם מוצאים עם search_contacts. אם יש כמה אנשים מתאימים, שאל איזה.
- אם המשתמש ביקש לבטל, לא לבצע, או לחזור, פשוט ענה בקצרה.`;
}

async function geminiTools(env, sys, contents, deadline = Date.now() + 30000) {
  const all = (env.AGENT_MODELS || "gemini-3.8-flash,gemini-flash-latest,gemini-flash-lite-latest").split(",").map((s) => s.trim());
  const models = all.filter((m) => !isBusy(m)).concat(all.filter(isBusy));
  let last = "";
  for (const m of models) {
    const left = deadline - Date.now();
    if (left < 1500) { last = last || "timeout"; break; }
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, tools: [{ functionDeclarations: toolDecls() }], generationConfig: { temperature: 0.3, maxOutputTokens: 2000 } }),
        signal: AbortSignal.timeout(Math.min(14000, left)),
      });
      const j = await r.json();
      const parts = j?.candidates?.[0]?.content?.parts;
      bump(env, "gemini");
      if (parts?.length) return parts;
      markBusy(m, j);
      if (j?.error?.code === 429) bump(env, "quota");
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) { last = e.message; if (e.name === "TimeoutError") geminiBusy.set(m, Date.now() + 60e3); }
  }
  throw new Error("agent: " + last);
}

// תור אחד של שיחה עם העוזר: מריץ חיפושים עד שיש תשובה או הצעה לפעולה
async function aiTurn(env, history, userText) {
  const deadline = Date.now() + 22000;
  const sys = aiSystem(env, (await env.KV.get("ai:mem")) || "");
  // Gemini דורש תורות מתחלפות: מאחדים תורות רצופות של אותו צד
  const contents = [];
  for (const h of [...history, { r: "user", t: userText }]) {
    const last = contents[contents.length - 1];
    if (last && last.role === h.r) last.parts[0].text += "\n" + h.t;
    else contents.push({ role: h.r, parts: [{ text: h.t }] });
  }
  if (contents[0]?.role === "model") contents.shift();
  for (let i = 0; i < 6; i++) {
    if (Date.now() > deadline) return { kind: "say", text: "זה לוקח יותר מדי זמן. נסה לבקש שוב בצורה פשוטה יותר." };
    const parts = await geminiTools(env, sys, contents, deadline + 8000);
    const call = parts.find((p) => p.functionCall)?.functionCall;
    if (!call) {
      const text = parts.map((p) => p.text || "").join(" ").trim();
      return { kind: "say", text: text || "לא הבנתי, אפשר לומר שוב?" };
    }
    const { name } = call, args = call.args || {};
    if (name === "ask_choice") {
      const options = (Array.isArray(args.options) ? args.options : String(args.options || "").split("|")).map((o) => String(o).trim()).filter(Boolean).slice(0, 8);
      if (options.length >= 2) return { kind: "choice", question: String(args.question || "למה התכוונת?"), options };
      return { kind: "say", text: String(args.question || "לא הבנתי, אפשר לומר שוב?") };
    }
    if (ACTIONS[name]) {
      let desc;
      try { desc = await ACTIONS[name].describe(env, args); }
      catch (e) {
        if (e.soft) {
          contents.push({ role: "model", parts });
          contents.push({ role: "user", parts: [{ functionResponse: { name, response: { result: { error: e.message } } } }] });
          continue;
        }
        return { kind: "say", text: "לא מצאתי את מה שביקשת. אפשר לנסות שוב בניסוח אחר." };
      }
      return { kind: "confirm", action: { name, args }, desc, twice: !!ACTIONS[name].twice };
    }
    contents.push({ role: "model", parts });
    let result;
    try { result = LOOKUP[name] ? await LOOKUP[name].run(env, args) : { error: "כלי לא קיים" }; }
    catch (e) { result = { error: e.message }; }
    contents.push({ role: "user", parts: [{ functionResponse: { name, response: { result } } }] });
    if (Date.now() > deadline) return { kind: "say", text: "זה לוקח יותר מדי זמן. נסה לבקש שוב בצורה פשוטה יותר." };
  }
  return { kind: "say", text: "לא הצלחתי להשלים את הבקשה. נסה לנסח אותה אחרת." };
}

// תור של העוזר כמשימת רקע: job = { type: "ai", path | chosen | text, history }. מחזיר את התוצאה (בלי לכתוב ל-DO)
async function aiJobResult(env, job) {
  const { path, history = [], chosen = "", text = "" } = job;
  let user = "";
  try {
    if (chosen) user = chosen;
    else if (text) user = text;
    else {
      user = await transcribeVal(env, path, "assistant");
      if (user === null) return { kind: "exit" };
      if (!user) return { kind: "empty" };
    }
    const res = await aiTurn(env, history, chosen ? `(בחרתי בתפריט את האפשרות: ${chosen})` : "(תמלול של מה שאמרתי) " + user);
    return { user, ...res };
  } catch (e) {
    await logEvent(env, "שגיאה בעוזר החכם: " + e.message);
    return { user, kind: "say", text: "הייתה תקלה. נסה שוב." };
  }
}
// תוצאת פעולה: מחרוזת, או { say, mem } כשיש פרט (קישור, מזהה) שהמודל צריך לזכור אבל אין טעם להקריא
const resultSpoken = (r) => String(r?.say ?? r ?? "בוצע.");
const resultMemo = (r) => (r?.mem ? `${resultSpoken(r)} ${r.mem}` : resultSpoken(r));
// פעולה ארוכה של העוזר (קובץ מצורף גדול, מאות מיילים) כמשימת רקע
const SLOW_ACTIONS = new Set(["read_attachment", "mark_all_read", "archive_many", "trash_many"]);
async function actionJobResult(env, job) {
  try {
    const out = await ACTIONS[job.name].run(env, job.args);
    if (job.desc) await logEvent(env, `העוזר החכם ביצע באישור: ${job.desc}`);
    return { kind: "action", ok: true, text: resultSpoken(out), memo: resultMemo(out), desc: job.desc || "" };
  } catch (e) {
    await logEvent(env, `פעולת העוזר נכשלה (${job.name}): ${e.message}`);
    return { kind: "action", ok: false, text: job.name === "read_attachment" ? "לא הצלחתי לקרוא את הקובץ." : "הפעולה נכשלה ולא בוצעה.", desc: job.desc || "" };
  }
}
// כל משימות הרקע (מדיה, הקלטה לדרייב, תור של העוזר, פעולה ארוכה)
async function runJob(env, job) {
  if (job.type === "ai") return aiJobResult(env, job);
  if (job.type === "action") return actionJobResult(env, job);
  return runMediaJob(env, job);
}
// הפעלת משימת רקע. ב-Cloudflare היא רצה בתוך ה-Durable Object (alarm) שמותר לו לרוץ עד 15 דקות,
// ולא ב-waitUntil של ה-Worker, שנקטע אחרי 30 שניות (ואז המתקשר היה שומע "לא הצלחתי לקבל תשובה בזמן")
async function startBgJob(ctx, id, job) {
  const env = ctx.env, callId = ctx.q.ApiCallId || "nocall";
  if (env.CALLS) { await stub(env, callId).fetch("https://do/startjob", { method: "POST", body: JSON.stringify({ id, job }) }); return; }
  await setJob(env, callId, { id, status: "run" });
  const p = runJob(env, job).catch(() => ({ kind: "say", text: job.type === "ai" ? "הייתה תקלה. נסה שוב." : "לא הצלחתי." })).then((res) => setJob(env, callId, { id, status: "done", ...res }));
  ctx.ctx?.waitUntil?.(p);
}

const AI_LISTEN = "דבר אחרי הצליל ובסיום הקש סולמית. ליציאה, הקש סולמית בלי לומר כלום.";
const pushHist = (st, r, t) => { st.ai.h.push({ r, t: String(t).slice(0, 1500) }); st.ai.h = st.ai.h.slice(-14); };

H.aiStart = async (st, input, ctx) => {
  if (!ctx.env.GEMINI_KEY) return go(st, "main", undefined, ctx, "העוזר החכם עדיין לא מוגדר.");
  st.ai = { h: [] };
  return go(st, "aiListen", undefined, ctx, "שלום, אני העוזר החכם. אפשר לבקש ממני כל דבר בחשבון הגוגל שלך, וכל פעולה אבצע רק אחרי שתאשר.");
};
H.aiListen = async (st, input, ctx, pre = "") => {
  st.step = "aiRec";
  return (pre ? R.msg(pre) : "") + R.record(st, st.ai.h.length ? "עוד משהו? " + AI_LISTEN : AI_LISTEN);
};
function aiExit(st, ctx) {
  const h = st.ai?.h || [];
  delete st.ai;
  if (h.length >= 2) ctx.ctx?.waitUntil?.(updateAiMemory(ctx.env, h));
  return go(st, "main", undefined, ctx, "יצאת מהעוזר החכם.");
}
H.aiRec = async (st, input, ctx) => {
  if (!input || input === "none") return aiExit(st, ctx);
  const jobId = "j" + st.n;
  st.ai.job = jobId;
  st.ai.polls = 0;
  await startBgJob(ctx, jobId, { type: "ai", path: input, history: st.ai.h });
  st.step = "aiWait";
  return aiWaitPrompt(st, "רגע, אני בודק");
};
// המתנה עם מנגינה: כל בדיקה משמיעה קטע של 4 שניות (שלושה קטעים שממשיכים זה את זה, בלולאה)
const HOLD_DIR = "/Hold/wait";
function aiWaitPrompt(st, text = "") {
  st.ai.music = ((st.ai.music || 0) % 3) + 1;
  const v = nextVal(st);
  const msgs = (text ? sp(text, "m") + "." : "") + `f-${HOLD_DIR}${st.ai.music}`;
  return `read=${msgs}=${v},no,1,1,1,No,yes,no,,,,Ok,none,`;
}
H.aiWait = async (st, input, ctx) => {
  const job = await getJob(ctx.env, ctx.q.ApiCallId || "nocall");
  if (!job || job.id !== st.ai.job || job.status !== "done") {
    st.ai.polls++;
    if (st.ai.polls > 14) return go(st, "aiListen", undefined, ctx, "לא הצלחתי לקבל תשובה בזמן. נסה שוב.");
    return aiWaitPrompt(st);
  }
  if (job.kind === "exit") return aiExit(st, ctx);
  if (job.kind === "empty") return go(st, "aiListen", undefined, ctx, "לא שמעתי. נסה שוב.");
  if (job.kind === "action") {
    pushHist(st, "user", job.ok ? `(אישרתי. בוצע: ${job.desc}. התוצאה: ${String(job.memo || job.text).slice(0, 300)})` : `(הפעולה נכשלה: ${job.desc})`);
    return go(st, "aiListen", undefined, ctx, job.text);
  }
  pushHist(st, "user", job.user);
  if (job.kind === "say") {
    pushHist(st, "model", job.text);
    return go(st, "aiListen", undefined, ctx, job.text);
  }
  if (job.kind === "choice") {
    st.ai.choice = job.options;
    pushHist(st, "model", `(שאלתי: ${job.question} האפשרויות: ${job.options.map((o, i) => `${i + 1}. ${o}`).join(" ")})`);
    st.step = "aiChoice";
    return R.msg(job.question) + R.menu(st, choicePrompt(job.options), "0." + job.options.map((_, i) => i + 1).join("."));
  }
  st.ai.pending = { action: job.action, desc: job.desc, twice: job.twice, stage: 1 };
  pushHist(st, "model", `(הצעתי לבצע: ${job.desc}. מחכה לאישור)`);
  st.step = "aiConfirm";
  return R.msg(job.desc) + R.menu(st, "לאישור הקש 1. לחזרה לשיחה הקש 2.", "1.2");
};
const choicePrompt = (opts) => opts.map((o, i) => `${o}: הקש ${i + 1}`).join(". ") + ". אם זה לא אחד מאלה, הקש 0 ואמור שוב.";
H.aiChoice = async (st, input, ctx) => {
  const opts = st.ai.choice || [];
  const pick = opts[+input - 1];
  if (!pick) {
    if (input === "none") return R.menu(st, choicePrompt(opts), "0." + opts.map((_, i) => i + 1).join("."));
    delete st.ai.choice;
    return go(st, "aiListen", undefined, ctx, "בסדר, אמור שוב מה תרצה.");
  }
  delete st.ai.choice;
  const jobId = "j" + st.n;
  st.ai.job = jobId;
  st.ai.polls = 0;
  await startBgJob(ctx, jobId, { type: "ai", history: st.ai.h, chosen: pick });
  st.step = "aiWait";
  return aiWaitPrompt(st, "בחרת " + pick);
};
H.aiConfirm = async (st, input, ctx) => {
  const p = st.ai.pending;
  if (!p) return go(st, "aiListen", undefined, ctx);
  if (input !== "1") {
    delete st.ai.pending;
    pushHist(st, "user", `(לא אישרתי את הפעולה: ${p.desc})`);
    return go(st, "aiListen", undefined, ctx, "הפעולה לא בוצעה.");
  }
  if (p.twice && p.stage === 1) {
    p.stage = 2;
    return R.msg("שים לב, את הפעולה הזו אי אפשר לבטל אחרי הביצוע.") + R.menu(st, "לאישור סופי הקש 1. לחזרה לשיחה הקש 2.", "1.2");
  }
  delete st.ai.pending;
  if (SLOW_ACTIONS.has(p.action.name)) {
    // פעולה ארוכה: רצה ברקע עם מנגינת המתנה, במקום לחכות בתוך הבקשה של ימות (שלא מחכה הרבה)
    const jobId = "j" + st.n;
    st.ai.job = jobId; st.ai.polls = 0;
    await startBgJob(ctx, jobId, { type: "action", name: p.action.name, args: p.action.args, desc: p.desc });
    st.step = "aiWait";
    return aiWaitPrompt(st, "רגע, מבצע");
  }
  if (p.action.name === "listen_youtube") {
    pushHist(st, "user", `(אישרתי: ${p.desc})`);
    st.media = { back: "ai" };
    return startMediaJob(ctx, st, { type: "youtube", id: p.action.args.id, mode: p.action.args.mode === "full" ? "full" : "summary" });
  }
  let out;
  try {
    const res = await ACTIONS[p.action.name].run(ctx.env, p.action.args);
    out = resultSpoken(res);
    pushHist(st, "user", `(אישרתי. בוצע: ${p.desc}. התוצאה: ${resultMemo(res).slice(0, 300)})`);
    await logEvent(ctx.env, `העוזר החכם ביצע באישור: ${p.desc}`);
  } catch (e) {
    await logEvent(ctx.env, `פעולת העוזר נכשלה (${p.action.name}): ${e.message}`);
    pushHist(st, "user", `(הפעולה נכשלה: ${p.desc})`);
    out = "הפעולה נכשלה ולא בוצעה.";
  }
  return go(st, "aiListen", undefined, ctx, out);
};

// ---- חיפוש באינטרנט (דרך Gemini עם Google Search)
Object.assign(LOOKUP, {
  web_search: {
    desc: "חיפוש באינטרנט (חדשות, מידע כללי, שעות פתיחה, מחירים, זמני כניסת שבת וכדומה). מחזיר תשובה מסוכמת מהרשת.",
    params: { query: ["STRING", "מה לחפש, בניסוח של שאלה"] }, req: ["query"],
    async run(env, a) {
      for (const m of ["gemini-flash-latest", "gemini-3.8-flash"].filter((x) => !isBusy(x))) {
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `חפש באינטרנט וענה בעברית, בקצרה ובמדויק, עם התאריך של המידע אם רלוונטי: ${a.query}` }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 700, temperature: 0.2 } }),
            signal: AbortSignal.timeout(15000),
          });
          const j = await r.json();
          bump(env, "gemini");
          const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
          if (t) return { answer: t };
          markBusy(m, j);
        } catch {}
      }
      return { error: "החיפוש באינטרנט לא זמין כרגע" };
    },
  },
});

export { CAL, DRIVE, ilOffset, nowIL, spokenLabels, catOf, chatTitle, nameForEmail, heb, LOOKUP, soft, ACTIONS, TASKS, DOCS, SHEETS, gmailLabelId, emailLine, modifyEmail, gmailIds, BULK_MAX, batchModify, countWord, attachmentsOf, ASK_CHOICE, toolDecls, aiSystem, geminiTools, aiTurn, aiJobResult, resultSpoken, resultMemo, SLOW_ACTIONS, actionJobResult, runJob, startBgJob, AI_LISTEN, pushHist, aiExit, HOLD_DIR, aiWaitPrompt, choicePrompt };
