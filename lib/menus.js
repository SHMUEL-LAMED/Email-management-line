import { G, H, R, checkPin, kvJson, logEvent, normPhone, pinRecord, randKey, sp, text, trimText, unb64url } from "./base.js";
import { NotConnected, SPOKEN, accessToken, chatDMSpace, chatMarkRead, chatSend, chatSpaces, chatUnread, findPeople, gapi, gmailGet, gmailMarkRead, gmailSend, gmailUnread, header, isForeign, isGroup, llm, mediaOf, msgText, myUserId, normName, parseAddr, spaceMembers, spaceMessages, toHebrew, transcribe, userName, ym } from "./google.js";
import { bridge } from "./state.js";
import { ACTIONS, DRIVE, attachmentsOf, gmailIds, gmailLabelId, heb, ilOffset, modifyEmail, nowIL } from "./assistant.js";
import { startMediaJob } from "./media.js";
import { chunkText, securityAlert } from "./voice.js";
import { phoneLookup } from "./settings.js";
import { go } from "./flow.js";

// ---------------------------------------------------------------- התפריטים

const MAIN_PROMPT = "לתיבת המייל הקש 1. להודעות פרטיות בצאט הקש 2. לקבוצות הקש 3. לשליחת הודעה חדשה הקש 4. לסיכום של כל מה שהגיע הקש 5. לעוזר החכם הקש 6. לשיחה עם קלאוד הקש 7. לקבצים ולהקלטות הקש 8. להגדרות ולמערכות הקש 9. כדי לומר בדיבור לאן ללכת הקש 0. בכל שלב, לשמיעה חוזרת הקש כוכבית.";
const MAIN_SHORT = "מייל 1. צאט פרטי 2. קבוצות 3. הודעה חדשה 4. סיכום 5. העוזר החכם 6. קלאוד 7. קבצים 8. הגדרות 9. בדיבור 0.";
const MAIN_KEYS = "0.1.2.3.4.5.6.7.8.9";
const MAIL_MENU = "להקראה מלאה הקש 1. לתשובה בהקלטה הקש 2. למייל הבא הקש 3. לסימון כנקרא ומעבר לבא הקש 4. לתקציר הקש 5. לעוד אפשרויות הקש 6. לתפריט הראשי הקש 0.";
const MAIL_KEYS = "0.1.2.3.4.5.6";
const CONV_MENU = "לשמיעה חוזרת הקש 1. לתשובה בהקלטה הקש 2. לשיחה הבאה הקש 3. לסימון כנקרא ומעבר לבאה הקש 4. לעוד אפשרויות הקש 6. לתפריט הראשי הקש 0.";
const REC_PROMPT = "אמור את ההודעה אחרי הצליל. בסיום הקש סולמית.";


H.start = async (st, input, ctx) => {
  const allowed = String(ctx.env.ALLOWED_PHONES || "").split(",").map(normPhone).filter(Boolean);
  if (!allowed.includes(normPhone(ctx.q.ApiPhone))) {
    await logEvent(ctx.env, "ניסיון כניסה ממספר לא מורשה: " + (ctx.q.ApiPhone || "חסוי"));
    securityAlert(ctx.env, ctx, "מישהו ניסה להיכנס לקו ממספר לא מורשה: " + (ctx.q.ApiPhone || "חסוי"));
    return R.msg("המספר שממנו התקשרת אינו מורשה להיכנס לקו הזה") + R.hangup();
  }
  const fails = +(await ctx.env.KV.get("pinfails")) || 0;
  if (fails >= 6) return R.msg("הכניסה חסומה זמנית בגלל ניסיונות כניסה שגויים. נסה שוב בעוד שעה") + R.hangup();
  st.step = "pin";
  return R.digits(st, "שלום. הקש את הקוד הסודי ובסיום סולמית", 4, 8);
};


H.pin = async (st, input, ctx) => {
  const env = ctx.env;
  if (input && input !== "none" && (await checkPin(env, input))) {
    await env.KV.delete("pinfails").catch(() => {});
    st.authed = true;
    return go(st, "welcome", undefined, ctx);
  }
  st.tries = (st.tries || 0) + 1;
  if (input && input !== "none") {
    const f = (+(await env.KV.get("pinfails")) || 0) + 1;
    await env.KV.put("pinfails", String(f), { expirationTtl: 3600 });
    if (f >= 6) { await logEvent(env, "הקו ננעל לשעה אחרי 6 קודים שגויים"); securityAlert(env, ctx, "הקו ננעל לשעה אחרי 6 קודים שגויים ברצף."); }
  }
  if (st.tries >= 3) { securityAlert(env, ctx, `הוקש קוד סודי שגוי 3 פעמים בשיחה אחת, מהמספר ${ctx.q.ApiPhone || "חסוי"}.`); return R.msg("הקוד שגוי. להתראות") + R.hangup(); }
  return R.digits(st, input === "none" ? "לא הוקש קוד. הקש את הקוד הסודי ובסיום סולמית" : "הקוד שגוי. נסה שוב ובסיום סולמית", 4, 8);
};

H.welcome = async (st, input, ctx) => {
  const env = ctx.env;
  let intro = "";
  try {
    const [prim, upd] = await Promise.all([gmailUnread(env, 50, "primary"), gmailUnread(env, 50, "updates")]);
    const mails = prim.length, upds = upd.length;
    const n50 = (n) => (n >= 50 ? "יותר מ 50" : n);
    let convs = [];
    try { convs = await chatUnread(env, "all"); } catch (e) { await logEvent(env, "שגיאת צאט בכניסה: " + e.message); }
    const dms = convs.filter((c) => c.dm).length, grs = convs.length - dms;
    const mentions = convs.filter((c) => c.mention).length;
    const parts = [];
    const vipN = await vipUnreadCount(env).catch(() => 0);
    parts.push(mails ? (mails === 1 ? "בתיבה הראשית יש מייל אחד חדש" : `בתיבה הראשית יש ${n50(mails)} מיילים חדשים`) + (vipN ? `, מתוכם ${vipN === 1 ? "אחד מאדם חשוב" : vipN + " מאנשים חשובים"}` : "") : "אין מיילים חדשים בתיבה הראשית");
    parts.push(upds ? (upds === 1 ? "בעדכונים יש מייל אחד חדש" : `בעדכונים יש ${n50(upds)} מיילים חדשים`) : "אין מיילים חדשים בעדכונים");
    parts.push(dms ? (dms === 1 ? "שיחה פרטית אחת עם הודעות חדשות" : `${dms} שיחות פרטיות עם הודעות חדשות`) : "אין הודעות פרטיות חדשות");
    parts.push(grs ? (grs === 1 ? "וקבוצה אחת עם הודעות חדשות" : `ו ${grs} קבוצות עם הודעות חדשות`) : "ואין הודעות חדשות בקבוצות");
    if (mentions) parts.push(mentions === 1 ? "בשיחה אחת מזכירים אותך" : `ב ${mentions} שיחות מזכירים אותך`);
    try {
      const b = await bridge(env, "state");
      const n = b.unheard.length;
      if (n) parts.push(n === 1 ? "יש לך תשובה חדשה מקלאוד" : `יש לך ${n} תשובות חדשות מקלאוד`);
      if (b.live) parts.push("קלאוד מחובר עכשיו לשיחה");
    } catch {}
    intro = parts.join(". ") + ".";
  } catch (e) {
    if (e instanceof NotConnected) return R.msg("חשבון הגוגל עדיין לא מחובר לקו. צריך להיכנס לדף החיבור ולחבר אותו. להתראות") + R.hangup();
    throw e;
  }
  // תקלה שנמצאה בבדיקת התקינות היומית מוקראת בתחילת כל שיחה, עד שהבדיקה הבאה עוברת
  const bad = await kvJson(env, "health:bad");
  if (bad?.items?.length) intro = "שים לב: בבדיקת התקינות היומית נמצאה תקלה ב" + bad.items.join(", וב") + ". " + intro;
  const r = await kvJson(env, "resume");
  if (r && Date.now() - r.t < 3 * 3600e3 && (r.kind !== "mail" || r.ids?.length)) { st.resume = r; return R.note(intro) + (await go(st, "resumeAsk", undefined, ctx)); }
  return R.note(intro) + (await go(st, "main", undefined, ctx));
};

H.main = async (st, input, ctx, pre = "") => {
  if (input === undefined) {
    st.step = "main";
    st.mainN = (st.mainN || 0) + 1;
    delete st.mail; delete st.conv; delete st.share; delete st.cands; // הקשר של זרימה שנקטעה לא נגרר לזרימה הבאה
    return (pre ? R.msg(pre) : "") + R.menu(st, st.mainN > 1 ? MAIN_SHORT : MAIN_PROMPT, MAIN_KEYS);
  }
  if (input === "none") {
    st.idle = (st.idle || 0) + 1;
    if (st.idle >= 3) return R.msg("להתראות") + R.hangup();
    return R.menu(st, MAIN_PROMPT, MAIN_KEYS);
  }
  st.idle = 0;
  const to = { 1: "mailStart", 2: "dmStart", 3: "grpStart", 4: "newStart", 5: "summary", 6: "aiStart", 7: "claudeStart", 8: "filesMenu", 9: "settingsMenu", 0: "navRec" }[input];
  if (!to) return R.menu(st, "בחירה לא קיימת. " + MAIN_SHORT, MAIN_KEYS);
  return go(st, to, undefined, ctx);
};

// ---- מייל

const TODO_LABEL = "לטיפול";
const SNOOZE_LABEL = "נדחה";
async function vipList(env) { return kvJson(env, "vip", []); }
const vipQuery = (vip) => (vip.length ? ` from:(${vip.map((v) => v.e).join(" OR ")})` : "");
async function vipUnreadCount(env) {
  const vip = await vipList(env);
  if (!vip.length) return 0;
  return (await gmailUnread(env, 50, "primary")).length ? (await gmailIds(env, "in:inbox is:unread" + vipQuery(vip), 50)).length : 0;
}
// נתוני מייל קצרים (שולח, תוויות) להרבה מיילים בבת אחת
async function mailMeta(env, ids) {
  return Promise.all(ids.map((id) => gapi(env, `${G.gmail}messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`)
    .then((x) => ({ id, threadId: x.threadId || "", from: parseAddr(header(x, "From")), subject: header(x, "Subject"), to: header(x, "To"), date: header(x, "Date"), labels: x.labelIds || [], snippet: x.snippet || "" })).catch(() => null)));
}
// מיון: אנשים חשובים קודם, אחר כך מה שגוגל סימן כחשוב, ואחר כך השאר
async function sortImportant(env, ids) {
  if (ids.length < 2) return ids;
  const vip = new Set((await vipList(env)).map((v) => v.e.toLowerCase()));
  const meta = (await mailMeta(env, ids.slice(0, 30))).filter(Boolean);
  const rank = (m) => (vip.has(m.from.email.toLowerCase()) ? 0 : m.labels.includes("IMPORTANT") ? 1 : 2);
  const sorted = meta.slice().sort((a, b) => rank(a) - rank(b)).map((m) => m.id);
  return sorted.concat(ids.filter((id) => !sorted.includes(id)));
}
const MAIL_LIST_NAMES = { primary: "התיבה הראשית", updates: "העדכונים", vip: "המיילים מאנשים חשובים", todo: "רשימת לטיפול", search: "תוצאות החיפוש", unanswered: "המיילים שלא נענו" };

H.mailStart = async (st, input, ctx, pre = "") => {
  const env = ctx.env;
  if (input === undefined) {
    const [prim, upd, vip, todo] = await Promise.all([
      gmailUnread(env, 25, "primary"), gmailUnread(env, 25, "updates"),
      vipList(env).then((v) => (v.length ? gmailIds(env, "in:inbox is:unread" + vipQuery(v), 25) : [])).catch(() => []),
      gmailLabelId(env, TODO_LABEL).then((l) => gmailIds(env, `label:${TODO_LABEL}`, 25)).catch(() => []),
    ]);
    st.cats = { primary: prim, updates: upd, vip, todo };
    st.step = "mailStart";
    const c = (n, one, many) => (n ? (n === 1 ? one : `${n} ${many}`) : null);
    const counts = [c(prim.length, "בתיבה הראשית מייל אחד חדש", "בתיבה הראשית"), c(upd.length, "בעדכונים מייל אחד", "בעדכונים"), c(vip.length, "מאנשים חשובים מייל אחד", "מאנשים חשובים"), c(todo.length, "ברשימת לטיפול מייל אחד", "ברשימת לטיפול")].filter(Boolean);
    const head = counts.length ? counts.map((x) => (/^\d/.test(x) ? x.replace(/^(\d+) (.*)$/, "$2 $1") : x)).join(", ") + "." : "אין מיילים חדשים.";
    return (pre ? R.msg(pre) : "") + R.msg(head) + R.menu(st, "לתיבה הראשית הקש 1. לעדכונים הקש 2. למיילים מאנשים חשובים הקש 3. לרשימת לטיפול הקש 4. לחיפוש מייל בדיבור הקש 5. למיילים ששלחת ולא נענו הקש 6. לתפריט הראשי הקש 0.", "0.1.2.3.4.5.6");
  }
  const cat = { 1: "primary", 2: "updates", 3: "vip", 4: "todo" }[input];
  if (cat) {
    if (!st.cats?.[cat]?.length) return go(st, "mailStart", undefined, ctx, `אין מיילים ב${MAIL_LIST_NAMES[cat]}.`);
    const ids = cat === "primary" ? await sortImportant(env, st.cats[cat]) : st.cats[cat];
    return startCat(st, ctx, cat, ids);
  }
  if (input === "5") return go(st, "mailSearchRec", undefined, ctx);
  if (input === "6") return go(st, "unanswered", undefined, ctx);
  return go(st, "main", undefined, ctx);
};
function startCat(st, ctx, cat, ids, pre = "") {
  st.mail = { ids, i: 0, cat, name: MAIL_LIST_NAMES[cat] };
  delete st.cats;
  return go(st, "mailItem", undefined, ctx, (pre ? pre + " " : "") + MAIL_LIST_NAMES[cat] + ".");
}

// חיפוש מייל בדיבור: "המייל מדוד על החשבונית מהשבוע שעבר"
H.mailSearchRec = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "mailSearchRec"; return (pre ? R.msg(pre) : "") + R.record(st, "אמור מה לחפש, למשל: המייל מדוד על החשבונית מהשבוע שעבר. בסיום הקש סולמית."); }
  const spoken = await transcribeVal(ctx.env, input, "nav");
  if (!spoken) return go(st, "mailStart", undefined, ctx, "לא שמעתי.");
  return mailSearchRun(st, ctx, spoken);
};
async function buildMailQuery(env, spoken) {
  let j = {};
  try {
    const out = await llm(env, `המשתמש אמר בטלפון מה לחפש בתיבת המייל שלו. חלץ JSON בלבד עם השדות: person (שם האדם או החברה ששלחו, או ריק), subject (מילות מפתח לנושא או לתוכן, עד 3 מילים, או ריק), days (כמה ימים אחורה לחפש, מספר, ברירת מחדל 60), sent (true אם הוא מחפש מייל ששלח בעצמו). התאריך היום ${nowIL()}. החזר רק JSON.`, spoken, 150);
    j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {}
  const parts = [];
  if (j.person) {
    const found = (await findPeople(env, j.person).catch(() => [])).slice(0, 4);
    const names = [j.person, ...found.map((f) => f.e), ...found.map((f) => f.n)].filter(Boolean).map((x) => `"${String(x).replace(/"/g, "")}"`);
    parts.push(`${j.sent ? "to" : "from"}:(${[...new Set(names)].join(" OR ")})`);
  }
  if (j.subject) parts.push(`(${String(j.subject).split(/\s+/).filter(Boolean).slice(0, 3).map((w) => `"${w}"`).join(" ")})`);
  if (!j.person && !j.subject) {
    // המודל לא חילץ כלום: מחפשים לפי המילים שנאמרו, במקום להחזיר 10 מיילים אקראיים
    const stop = new Set(["המייל", "מייל", "מיילים", "של", "על", "את", "עם", "מה", "מי", "לי", "לא", "יש", "זה", "תמצא", "תחפש", "חפש", "מצא", "בבקשה", "אני", "רוצה", "לשמוע", "תשמיע", "שלח", "ששלח", "ששלחתי", "קיבלתי", "שקיבלתי"]);
    const words = String(spoken).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter((w) => w.length >= 3 && !stop.has(w)).slice(0, 5);
    if (words.length) parts.push(`(${words.map((w) => `"${w}"`).join(" OR ")})`);
  }
  parts.push(`newer_than:${Math.min(365, Math.max(1, +j.days || 60))}d`);
  if (j.sent) parts.push("in:sent");
  return parts.join(" ");
}
async function mailSearchRun(st, ctx, spoken) {
  const env = ctx.env;
  const q = await buildMailQuery(env, spoken);
  const ids = await gmailIds(env, q, 10);
  if (!ids.length) return go(st, "mailStart", undefined, ctx, `לא מצאתי מיילים לפי החיפוש ${spoken}.`);
  st.mail = { ids, i: 0, cat: "search", name: "תוצאות החיפוש" };
  return go(st, "mailItem", undefined, ctx, `מצאתי ${ids.length === 1 ? "מייל אחד" : ids.length + " מיילים"}.`);
}

// מיילים ששלחתי ולא קיבלתי עליהם תשובה
H.unanswered = async (st, input, ctx) => {
  const env = ctx.env;
  const sent = await gmailIds(env, "in:sent newer_than:10d -subject:שש", 15);
  const meta = (await mailMeta(env, sent)).filter(Boolean);
  const seen = new Set(), picks = [];
  for (const m of meta) if (m.threadId && !seen.has(m.threadId)) { seen.add(m.threadId); picks.push(m); }
  // כל השרשורים במקביל (לא 30 קריאות אחת אחרי השנייה, שימות לא מחכה להן)
  const threads = await Promise.all(picks.map((m) => gapi(env, `${G.gmail}threads/${m.threadId}?format=metadata&metadataHeaders=From`).then((th) => ({ m, th })).catch(() => null)));
  const out = [];
  for (const x of threads) {
    if (!x) continue;
    const { m, th } = x;
    const last = th?.messages?.[th.messages.length - 1];
    if (!last) continue;
    const fromMe = parseAddr(header(last, "From")).email.toLowerCase() === String(env.BUSINESS_EMAIL).toLowerCase();
    const ageDays = (Date.now() - +last.internalDate) / 86400e3;
    if (fromMe && ageDays >= 1 && !/^(re|fwd?|הועבר):/i.test(m.subject || "") && !/^\s*(סיכום יומי|תשובה מקלאוד)/.test(m.subject || "")) out.push(last.id);
  }
  if (!out.length) return go(st, "mailStart", undefined, ctx, "כל המיילים ששלחת בעשרת הימים האחרונים נענו, או שלא נמצאו מיילים כאלה.");
  st.mail = { ids: out, i: 0, cat: "unanswered", name: "המיילים שלא נענו" };
  return go(st, "mailItem", undefined, ctx, `${out.length === 1 ? "מייל אחד ששלחת עדיין לא נענה" : out.length + " מיילים ששלחת עדיין לא נענו"}.`);
};

H.mailItem = async (st, input, ctx) => {
  const m = st.mail;
  if (m.i >= m.ids.length) { delete st.cur; return go(st, "main", undefined, ctx, `סיימת את ${m.name || "המיילים"}.`); }
  let e;
  try { e = await gmailGet(ctx.env, m.ids[m.i]); }
  catch (err) {
    if (err instanceof NotConnected) throw err;
    // מייל שנמחק או לא נגיש בינתיים: מדלגים עליו במקום להפיל את כל הרשימה ("אירעה תקלה")
    await logEvent(ctx.env, "דילוג על מייל שלא ניתן לקרוא: " + err.message);
    m.i++;
    return go(st, "mailItem", undefined, ctx);
  }
  st.cur = { id: e.id, threadId: e.threadId, fromName: e.fromName, fromEmail: e.fromEmail, replyTo: e.replyTo, subject: e.subject, msgId: e.msgId, refs: lastRefs(e.refs), body: e.body, to: e.to, nAtt: e.attachments, date: e.date };
  const att = e.attachments ? ` יש ${e.attachments === 1 ? "קובץ מצורף אחד" : e.attachments + " קבצים מצורפים"}.` : "";
  const sentByMe = m.cat === "unanswered";
  if (sentByMe) {
    // מייל ששלחתי: "הצד השני" הוא הנמען, ותשובה הולכת אליו (ולא אליי)
    const p = parseAddr(e.to);
    st.cur.fromName = p.name; st.cur.fromEmail = p.email; st.cur.replyTo = e.to || e.replyTo;
  }
  let head = sentByMe ? `אל: ${parseAddr(e.to).name}\nנושא: ${e.subject}\nתוכן: ${trimText(e.body, 350)}` : `מאת: ${e.fromName}\nנושא: ${e.subject}\nתוכן: ${trimText(e.body, 350)}`;
  const foreign = isForeign(e.subject + " " + e.body);
  if (foreign) head = await toHebrew(ctx.env, head, 600);
  st.cur.foreign = foreign;
  const spokenHead = head.replace(/^\s*(מאת|אל|נושא|תוכן)\s*:\s*/gm, (x, w) => (w === "תוכן" ? "" : w + " ")).replace(/\n/g, ". ");
  const when = e.date ? ` ${relDate(e.date)}.` : "";
  const intro = `מייל ${m.i + 1} מתוך ${m.ids.length}.${when}${foreign ? " המייל באנגלית, הנה תרגום." : ""} ${spokenHead}.${att}`;
  st.step = "mailMenu";
  return R.msg(intro) + R.menu(st, MAIL_MENU, MAIL_KEYS);
};
// References תקין: רק מזהים שלמים (חיתוך באמצע מזהה שובר את השרשור אצל הנמען)
const lastRefs = (r) => String(r || "").trim().split(/\s+/).filter(Boolean).slice(-12).join(" ");
function relDate(d) {
  const t = Date.parse(d);
  if (!t) return "";
  // לפי ימים בלוח (שעון ישראל): מייל מאתמול בלילה הוא "אתמול", לא "היום"
  const dayOf = (ms) => Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)));
  const days = Math.round((dayOf(Date.now()) - dayOf(t)) / 86400e3);
  return days <= 0 ? "היום" : days === 1 ? "אתמול" : days < 7 ? `לפני ${days} ימים` : days < 14 ? "לפני שבוע" : days < 60 ? `לפני ${Math.round(days / 7)} שבועות` : "לפני יותר מחודשיים";
}
// הקראה מלאה בעמודים: כל עמוד עד 1500 תווים, ואפשר לדלג בלחיצה
H.mailRead = async (st, input, ctx) => {
  const c = st.cur;
  if (input === undefined) {
    const full = c.foreign ? await toHebrew(ctx.env, trimText(c.body, 3500), 2500) : c.body;
    c.pages = chunkText(full || "המייל ריק", 1500); c.page = 0;
  } else if (input === "1") c.page++;
  else if (input === "2") c.page = 0;
  else { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  if (c.page >= c.pages.length) { st.step = "mailMenu"; return R.msg("זה סוף המייל.") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.step = "mailRead";
  const more = c.page < c.pages.length - 1;
  return R.msg(c.pages[c.page]) + R.menu(st, (more ? "להמשך הקש 1. " : "") + "לשמיעה מההתחלה הקש 2. לתפריט המייל הקש 0.", more ? "0.1.2" : "0.2");
};

H.mailMenu = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur;
  switch (input) {
    case "1": return go(st, "mailRead", undefined, ctx);
    case "2":
      st.compose = { kind: "reply", back: "mailAfterReply", label: c.fromName };
      return go(st, "rec", undefined, ctx);
    case "3": st.mail.i++; return go(st, "mailItem", undefined, ctx);
    case "4": await gmailMarkRead(env, c.id); st.mail.i++; return go(st, "mailItem", undefined, ctx, "סומן כנקרא.");
    case "5": {
      const sum = await llm(env, "סכם את המייל הבא בשניים שלושה משפטים. ציין אם מבקשים ממני משהו ועד מתי. " + SPOKEN, `מאת: ${c.fromName}\nנושא: ${c.subject}\n\n${c.body}`, 300).catch(() => "");
      return R.msg(sum || "לא הצלחתי לסכם את המייל") + R.menu(st, MAIL_MENU, MAIL_KEYS);
    }
    case "6": return go(st, "mailMore", undefined, ctx);
    case "0": return go(st, "main", undefined, ctx);
    default: {
      st.idle = (st.idle || 0) + 1;
      if (st.idle >= 3) return R.msg("להתראות") + R.hangup();
      return R.menu(st, MAIL_MENU, MAIL_KEYS);
    }
  }
};
H.mailAfterReply = async (st, input, ctx) => {
  await gmailMarkRead(ctx.env, st.cur.id).catch(() => {});
  st.mail.i++;
  return go(st, "mailItem", undefined, ctx, "התשובה נשלחה.");
};

// עוד אפשרויות למייל
const mailMorePrompt = (st) => `לתשובה מוכנה הקש 1. לניסוח תשובה עם AI הקש 2. ${st.mail.cat === "todo" ? "להסרה מרשימת לטיפול" : "להוספה לרשימת לטיפול"} הקש 3. לדחיית המייל למועד אחר הקש 4. לשמירת המייל בדרייב הקש 5. ${st.cur.nAtt ? "לקבצים המצורפים הקש 6. " : ""}לשמירת השולח באנשי הקשר הקש 7. להוספת השולח לרשימת האנשים החשובים הקש 8. להעברת המייל לאדם אחר הקש 9. לחזרה הקש 0.`;
H.mailMore = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur;
  const back = (pre = "") => { st.step = "mailMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, MAIL_MENU, MAIL_KEYS); };
  if (input === undefined) { st.step = "mailMore"; return R.menu(st, mailMorePrompt(st), "0.1.2.3.4.5.6.7.8.9"); }
  switch (input) {
    case "1": return go(st, "cannedPick", undefined, ctx);
    case "2":
      st.compose = { kind: "reply", back: "mailAfterReply", label: c.fromName, ai: true };
      return go(st, "rec", undefined, ctx, "אמור בקצרה מה לענות, ואני אנסח את התשובה בסגנון שלך.");
    case "3": {
      const lid = await gmailLabelId(env, TODO_LABEL, true);
      if (st.mail.cat === "todo") { await modifyEmail(env, c.id, [], [lid]); st.mail.i++; return go(st, "mailItem", undefined, ctx, "הוסר מרשימת לטיפול."); }
      await modifyEmail(env, c.id, [lid]);
      return back("נוסף לרשימת לטיפול. תמצא אותו בתפריט המייל, מקש 4.");
    }
    case "4": st.step = "snoozePick"; return R.menu(st, "לדחות למחר בבוקר הקש 1. להערב הקש 2. לעוד 3 שעות הקש 3. ליום ראשון הקש 4. לחזרה הקש 0.", "0.1.2.3.4");
    case "5": {
      const link = await saveMailToDrive(env, c);
      return back(link ? "המייל נשמר בדרייב, בתיקייה מיילים מהקו." : "השמירה נכשלה.");
    }
    case "6": if (c.nAtt) return go(st, "attList", undefined, ctx); return back();
    case "7": {
      if (!c.fromEmail || !c.fromEmail.includes("@")) return back("אין כתובת לשמור.");
      st.step = "saveSender";
      return R.menu(st, `לשמור את ${c.fromName}, בכתובת ${c.fromEmail}, באנשי הקשר? לאישור הקש 1. לחזרה הקש 0.`, "0.1");
    }
    case "8": {
      const vip = await vipList(env);
      if (!vip.some((v) => v.e.toLowerCase() === c.fromEmail.toLowerCase())) { vip.push({ n: c.fromName, e: c.fromEmail }); await env.KV.put("vip", JSON.stringify(vip.slice(-40))); }
      return back(`${c.fromName} נוסף לרשימת האנשים החשובים.`);
    }
    case "9": st.fwd = { id: c.id }; return go(st, "fwdName", undefined, ctx);
    default: return back();
  }
};
H.saveSender = async (st, input, ctx) => {
  if (input !== "1") { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  const c = st.cur;
  await ACTIONS.create_contact.run(ctx.env, { name: c.fromName, email: c.fromEmail });
  st.step = "mailMenu";
  return R.msg("איש הקשר נשמר.") + R.menu(st, MAIL_MENU, MAIL_KEYS);
};
// דחיית מייל: יוצא מהתיבה וחוזר אליה (כלא נקרא) בזמן שנבחר
function snoozeUntil(opt) {
  const now = new Date();
  const il = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  // ההפרש בין UTC לשעון ישראל נמדד בזמן היעד (לא עכשיו), כדי שדחייה שחוצה מעבר לשעון קיץ/חורף תגיע בשעה הנכונה
  const offAt = (wall) => { const m = ilOffset(new Date(wall)).match(/([+-])(\d{2}):(\d{2})/); return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60e3 : il - now; };
  const at = (dayAdd, h) => { const d = new Date(il); d.setDate(d.getDate() + dayAdd); d.setHours(h, 0, 0, 0); return d.getTime() - offAt(d.getTime()); };
  if (opt === "1") return at(1, 8);
  if (opt === "2") return il.getHours() < 19 ? at(0, 19) : at(1, 19);
  if (opt === "3") return Date.now() + 3 * 3600e3;
  if (opt === "4") return at((7 - il.getDay()) % 7 || 7, 8);
  return 0;
}
H.snoozePick = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur;
  const until = snoozeUntil(input);
  if (!until) { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  const lid = await gmailLabelId(env, SNOOZE_LABEL, true);
  await modifyEmail(env, c.id, [lid], ["INBOX"]);
  const list = await kvJson(env, "snooze", []);
  list.push({ id: c.id, until, lid });
  await env.KV.put("snooze", JSON.stringify(list.slice(-200)));
  await logEvent(env, `מייל נדחה: ${c.subject} עד ${new Date(until).toISOString()}`);
  st.mail.i++;
  return go(st, "mailItem", undefined, ctx, "המייל נדחה. הוא יחזור לתיבה כלא נקרא בזמן שבחרת.");
};
// מריץ מהמשימה המתוזמנת: מחזיר לתיבה מיילים שזמן הדחייה שלהם הגיע
async function restoreSnoozed(env) {
  const list = await kvJson(env, "snooze", []);
  if (!list.length) return;
  const now = Date.now();
  const due = list.filter((x) => x.until <= now), rest = list.filter((x) => x.until > now);
  for (const x of due) {
    try { await modifyEmail(env, x.id, ["INBOX", "UNREAD"], [x.lid]); }
    catch (e) {
      await logEvent(env, "החזרת מייל נדחה נכשלה: " + e.message);
      // תקלה זמנית: מנסים שוב בבדיקה הבאה (עד 3 ימים), כדי שהמייל לא יישאר מוסתר לתמיד
      if (e.status !== 404 && now - x.until < 3 * 86400e3) rest.push(x);
    }
  }
  if (due.length) await env.KV.put("snooze", JSON.stringify(rest));
}
// שמירת מייל כמסמך גוגל בתיקייה "מיילים מהקו"
async function driveFolder(env, name) {
  const k = "folder:" + name;
  const c = await env.KV.get(k);
  if (c) {
    // התיקייה עדיין קיימת? (תיקייה שנמחקה הייתה מפילה כל שמירה לדרייב לתמיד)
    const f = await gapi(env, `${DRIVE}files/${c}?fields=id,trashed`).catch((e) => (e.status === 404 ? null : { id: c }));
    if (f && !f.trashed) return c;
    await env.KV.delete(k).catch(() => {});
  }
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const j = await gapi(env, `${DRIVE}files?q=${encodeURIComponent(q)}&fields=files(id)`);
  let id = j.files?.[0]?.id;
  if (!id) id = (await gapi(env, `${DRIVE}files`, { body: { name, mimeType: "application/vnd.google-apps.folder" } })).id;
  await env.KV.put(k, id);
  return id;
}
async function driveUpload(env, { name, mime, bytes, folder, convertTo }) {
  const meta = { name, parents: folder ? [folder] : undefined };
  if (convertTo) meta.mimeType = convertTo;
  const b = "b" + randKey(12);
  const head = new TextEncoder().encode(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${b}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST", headers: { Authorization: "Bearer " + (await accessToken(env)), "Content-Type": `multipart/related; boundary=${b}` }, body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error("drive upload " + r.status + " " + (j.error?.message || ""));
  return j;
}
async function saveMailToDrive(env, c) {
  try {
    const folder = await driveFolder(env, "מיילים מהקו");
    const text = `מאת: ${c.fromName} <${c.fromEmail}>\nנושא: ${c.subject}\nתאריך: ${c.date || ""}\n\n${c.body}`;
    const f = await driveUpload(env, { name: c.subject || "מייל", mime: "text/plain", bytes: new TextEncoder().encode(text), folder, convertTo: "application/vnd.google-apps.document" });
    await logEvent(env, "מייל נשמר בדרייב: " + c.subject);
    return f.webViewLink || f.id;
  } catch (e) { await logEvent(env, "שמירת מייל לדרייב נכשלה: " + e.message); return ""; }
}

// תשובות מוכנות
const CANNED_DEFAULT = ["קיבלתי, תודה.", "תודה, אחזור אליך בהקדם.", "מאשר.", "לא רלוונטי עבורי, תודה."];
async function cannedList(env) {
  const l = await kvJson(env, "canned");
  if (Array.isArray(l) && l.length) return l;
  const phone = String(env.ALLOWED_PHONES || "").split(",")[0].trim();
  return phone ? [...CANNED_DEFAULT, `אפשר לדבר בטלפון? ${phone}`] : CANNED_DEFAULT;
}
H.cannedPick = async (st, input, ctx) => {
  const list = await cannedList(ctx.env);
  if (input === undefined) {
    st.step = "cannedPick";
    return R.menu(st, list.map((t, i) => `${t} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => i + 1)].join("."));
  }
  const t = list[+input - 1];
  if (!t) { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.compose = { kind: "reply", back: "mailAfterReply", label: st.cur.fromName, text: t };
  return go(st, "confirm", undefined, ctx);
};

// העברת מייל לאדם אחר
H.fwdName = async (st, input, ctx) => {
  if (input === undefined) { st.step = "fwdName"; return R.record(st, "אמור למי להעביר את המייל, ובסיום הקש סולמית."); }
  const spoken = await transcribeVal(ctx.env, input, "name");
  const found = spoken ? await findPeople(ctx.env, spoken) : [];
  if (!found.length) { st.step = "mailMenu"; return R.msg(spoken ? `לא מצאתי איש קשר בשם ${spoken}.` : "לא שמעתי.") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "fwdPick";
  return R.menu(st, st.cands.map((c, i) => `עבור ${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לביטול הקש 0.", ["0", ...st.cands.map((_, i) => i + 1)].join("."));
};
H.fwdPick = async (st, input, ctx) => {
  const c = st.cands?.[+input - 1];
  if (!c) { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.fwd.to = c; st.step = "fwdConfirm";
  return R.menu(st, `להעביר את המייל בנושא ${st.cur.subject} אל ${c.n}? לאישור הקש 1. לביטול הקש 0.`, "0.1");
};
H.fwdConfirm = async (st, input, ctx) => {
  st.step = "mailMenu";
  if (input !== "1") return R.msg("בוטל.") + R.menu(st, MAIL_MENU, MAIL_KEYS);
  await ACTIONS.forward_email.run(ctx.env, { id: st.fwd.id, to: st.fwd.to.e, note: "מצורף מייל שהועבר מהטלפון." });
  await logEvent(ctx.env, `מייל הועבר ל${st.fwd.to.n}: ${st.cur.subject}`);
  delete st.fwd;
  return R.msg("המייל הועבר.") + R.menu(st, MAIL_MENU, MAIL_KEYS);
};

// קבצים מצורפים למייל: סיכום, הקראה, שיתוף
H.attList = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur;
  if (input === undefined) {
    const m = await gapi(env, `${G.gmail}messages/${c.id}?format=full`);
    st.atts = attachmentsOf(m.payload).slice(0, 8);
    if (!st.atts.length) { st.step = "mailMenu"; return R.msg("אין קבצים מצורפים.") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
    if (st.atts.length === 1) return go(st, "attList", "1", ctx);
    st.step = "attList";
    const parts = await Promise.all(st.atts.map(async (a, i) => `${await heb(env, a.name)} הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...st.atts.map((_, i) => i + 1)].join("."));
  }
  const a = st.atts?.[+input - 1];
  if (!a) { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.att = { ...a, index: +input };
  st.step = "attMenu";
  const kb = Math.max(1, Math.round(a.size / 1024));
  // קובץ וידאו או אודיו: מקש 1 ממיר אותו לשמע ומשמיע (כמו קבצים מהצאט)
  if (isMailMedia(a)) return R.menu(st, `${isMailVideo(a) ? "סרטון" : "הקלטה"}, ${await heb(env, a.name)}, ${kb} קילובייט. לשמיעה הקש 1. לשליחה לאדם אחר הקש 3. לשמירה בדרייב הקש 4. לחזרה הקש 0.`, "0.1.3.4");
  return R.menu(st, `הקובץ ${await heb(env, a.name)}, ${kb} קילובייט. לסיכום הקש 1. להקראה מלאה הקש 2. לשליחה לאדם אחר הקש 3. לשמירה בדרייב הקש 4. לחזרה הקש 0.`, "0.1.2.3.4");
};
H.attMenu = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur, a = st.att;
  if (input === "1" && isMailMedia(a)) {
    st.media = { back: "mail" };
    return startMediaJob(ctx, st, { type: "file", mailId: c.id, attId: a.id, size: a.size, mime: a.mime, name: a.name });
  }
  if (input === "1" || input === "2") {
    // הקריאה רצה ברקע עם מנגינת המתנה: קובץ גדול לוקח יותר זמן ממה שימות מחכה לתשובה
    st.media = { back: "mail" };
    return startMediaJob(ctx, st, { type: "action", name: "read_attachment", args: { id: c.id, index: a.index, mode: input === "2" ? "full" : "summary" } });
  }
  if (input === "3") { st.share = { src: { type: "gmail", mailId: c.id, attId: a.id, name: a.name, mime: a.mime, size: a.size }, back: "mail" }; return go(st, "shareWho", undefined, ctx); }
  if (input === "4") {
    try {
      const bytes = await attachmentBytes(env, c.id, a.id);
      await driveUpload(env, { name: a.name, mime: a.mime || "application/octet-stream", bytes, folder: await driveFolder(env, "קבצים מהקו") });
      st.step = "mailMenu"; return R.msg("הקובץ נשמר בדרייב, בתיקייה קבצים מהקו.") + R.menu(st, MAIL_MENU, MAIL_KEYS);
    } catch (e) { await logEvent(env, "שמירת קובץ נכשלה: " + e.message); st.step = "mailMenu"; return R.msg("השמירה נכשלה.") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  }
  st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS);
};
const isMailVideo = (a) => /^video\//.test(a.mime || "") || /\.(mp4|mov|webm|3gp|avi|mkv|m4v|wmv)$/i.test(a.name || "");
const isMailMedia = (a) => isMailVideo(a) || /^audio\//.test(a.mime || "") || /\.(m4a|mp3|ogg|opus|wav|aac|amr|wma|flac)$/i.test(a.name || "");
async function attachmentBytes(env, mailId, attId) {
  const j = await gapi(env, `${G.gmail}messages/${mailId}/attachments/${attId}`);
  return unb64url(j.data);
}

// סגנון הכתיבה שלו, נלמד מהמיילים שהוא שלח (מטמון לשבוע)
async function styleProfile(env) {
  const c = await kvJson(env, "style");
  if (c && Date.now() - c.t < 7 * 86400e3) return c.s;
  let s = "";
  try {
    const ids = await gmailIds(env, "in:sent -subject:שש -subject:\"סיכום יומי\"", 20);
    const bodies = (await Promise.all(ids.map((id) => gmailGet(env, id).catch(() => null)))).filter((m) => m && m.body && m.body.length > 20 && !isForeign(m.body)).map((m) => trimText(m.body, 500));
    if (bodies.length >= 2) {
      s = await llm(env, "לפניך מיילים שכתב אדם. תאר בעד 10 שורות את סגנון הכתיבה שלו: איך הוא פותח, איך הוא חותם (ומה שמו אם מופיע), רמת הרשמיות, אורך המשפטים, ביטויים חוזרים, האם הוא משתמש בסימני קריאה. החזר רק את התיאור.", bodies.join("\n\n---\n\n"), 500);
    }
  } catch {}
  await env.KV.put("style", JSON.stringify({ t: Date.now(), s }));
  return s;
}
async function draftWithAi(env, st, instruction) {
  const cp = st.compose, c = st.cur;
  const style = await styleProfile(env);
  const ctxText = cp.kind === "reply" && c ? `המייל שעונים עליו:\nמאת: ${c.fromName}\nנושא: ${c.subject}\n${trimText(c.body, 1500)}` : `נמען: ${cp.label}`;
  return llm(env,
    `אתה כותב בשם שמואל הודעה ${cp.kind === "reply" ? "כתשובה למייל" : cp.kind === "email" ? "במייל" : "בצאט"} לפי הנחיה קצרה שאמר בטלפון. כתוב בעברית, בגוף ראשון, כמו שהוא כותב.${style ? `\nסגנון הכתיבה שלו: ${style}` : "\nסגנון: ענייני, מנומס וקצר."}\nכתוב רק את גוף ההודעה המוכנה לשליחה, בלי נושא, בלי הסברים ובלי מירכאות. אל תוסיף פרטים שלא נאמרו.`,
    `${ctxText}\n\nההנחיה שלו: ${instruction}`, 500);
}

// ---- צ'אט

H.dmStart = async (st, input, ctx) => {
  const convs = await chatUnread(ctx.env, "dm");
  if (!convs.length) return go(st, "chatEmpty", undefined, ctx, "אין הודעות פרטיות חדשות.");
  st.conv = { items: convs, i: 0, kind: "dm" };
  return go(st, "convItem", undefined, ctx);
};
H.grpStart = async (st, input, ctx) => {
  const convs = await chatUnread(ctx.env, "group");
  if (!convs.length) return go(st, "grpBrowse", undefined, ctx, "אין הודעות חדשות בקבוצות.");
  st.conv = { items: convs, i: 0, kind: "group" };
  return go(st, "convItem", undefined, ctx);
};
H.chatEmpty = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "chatEmpty"; return (pre ? R.msg(pre) : "") + R.menu(st, "לחיפוש שיחה או הודעה בדיבור הקש 1. לתפריט הראשי הקש 0.", "0.1"); }
  if (input === "1") return go(st, "chatSearchRec", undefined, ctx);
  return go(st, "main", undefined, ctx);
};

// בחירת קבוצה מתוך רשימה (גם בלי הודעות חדשות)
H.grpBrowse = async (st, input, ctx, pre = "") => {
  if (input === undefined) {
    const mute = await kvJson(ctx.env, "mute", []);
    const groups = (await chatSpaces(ctx.env)).filter(isGroup).filter((s) => !mute.includes(s.name)).slice(0, 8).map((s) => ({ space: s.name, title: s.displayName || "קבוצה בלי שם" }));
    if (!groups.length) return go(st, "main", undefined, ctx, (pre ? pre + " " : "") + "לא מצאתי קבוצות בחשבון.");
    st.groups = groups;
    st.step = "grpBrowse";
    const list = groups.map((g, i) => `לקבוצה ${g.title} הקש ${i + 1}`).join(". ");
    return (pre ? R.msg(pre) : "") + R.menu(st, list + ". לחיפוש בדיבור הקש 9. לתפריט הראשי הקש 0.", ["0", "9", ...groups.map((_, i) => String(i + 1))].join("."));
  }
  if (input === "9") return go(st, "chatSearchRec", undefined, ctx);
  if (input === "0" || input === "none") return go(st, "main", undefined, ctx);
  const g = st.groups?.[+input - 1];
  if (!g) return go(st, "main", undefined, ctx);
  return openConv(st, ctx, { space: g.space, dm: false, title: g.title });
}
// פתיחת שיחה (קבוצה או פרטית) עם ההודעות האחרונות, גם אם נקראו
async function openConv(st, ctx, sp, filter = "", n = 8) {
  const me = await myUserId(ctx.env);
  let msgs = (await spaceMessages(ctx.env, sp.space, null, filter ? 30 : n)).map((m) => ({ u: m.sender?.name || "", t: msgText(m), mine: m.sender?.name === "users/" + me, media: mediaOf(m), name: m.name || "", atts: attsOf(m) }));
  if (filter) {
    const f = normName(filter);
    const hit = msgs.filter((m) => normName(m.t).includes(f));
    msgs = hit.length ? hit.slice(-8) : msgs.slice(-8);
    sp.note = hit.length ? `${hit.length === 1 ? "הודעה אחת" : hit.length + " הודעות"} עם ${filter}.` : `לא מצאתי הודעות עם ${filter}, הנה האחרונות.`;
  } else msgs = msgs.slice(-n);
  const names = await spaceMembers(ctx.env, sp.space);
  for (const m of msgs) m.n = m.mine ? "אתה" : names[m.u] || (await userName(ctx.env, m.u));
  if (sp.dm && !sp.title) sp.title = Object.entries(names).find(([u]) => u !== "users/" + me)?.[1] || "איש קשר";
  st.conv = { items: [{ ...sp, msgs, recent: true }], i: 0, kind: sp.dm ? "dm" : "group" };
  if (st.share?.fromChat && st.share.back === "files") {
    delete st.share.fromChat;
    const atts = msgs.flatMap((m) => (m.atts || []).map((a) => ({ ...a, from: m.n })));
    if (!atts.length) return go(st, "filesMenu", undefined, ctx, "לא נשלחו קבצים בהודעות האחרונות של השיחה.");
    st.share.srcList = atts.slice(-8); st.share.back = "files";
    return go(st, "sharePickChat", undefined, ctx);
  }
  return go(st, "convItem", undefined, ctx);
}
const attsOf = (m) => (m.attachment || []).map((a) => ({ name: a.contentName || "קובץ", mime: a.contentType || "", res: a.attachmentDataRef?.resourceName || "", drive: a.driveDataRef?.driveFileId || "" }));

function convSpeech(c, idx, total) {
  const head = c.dm
    ? `${total > 1 ? `שיחה ${idx + 1} מתוך ${total}. ` : ""}הודעות מ${c.title}.${c.mention ? " מזכירים אותך." : ""}`
    : `${total > 1 ? `קבוצה ${idx + 1} מתוך ${total}. ` : ""}קבוצת ${c.title}. ${c.recent ? "ההודעות האחרונות" : c.msgs.length === 1 ? "הודעה חדשה אחת" : `${c.msgs.length} הודעות חדשות`}.${c.mention ? " מזכירים אותך." : ""}`;
  const body = c.spoken || c.msgs.slice(-10).map((m) => (c.dm && !m.mine ? m.t : `${m.n} כתב: ${m.t}`)).join(". ");
  return head + (c.note ? " " + c.note : "") + " " + trimText(body, 2500);
}
H.convItem = async (st, input, ctx) => {
  const v = st.conv;
  if (v.i >= v.items.length) return go(st, "main", undefined, ctx, v.kind === "dm" ? "סיימת את ההודעות הפרטיות." : "סיימת את הקבוצות.");
  const c = v.items[v.i];
  st.step = "convMenu";
  if (c.spoken === undefined) {
    const body = c.msgs.slice(-10).map((m) => (c.dm ? m.t : `${m.n} כתב: ${m.t}`)).join("\n");
    c.spoken = isForeign(body) ? "ההודעות באנגלית, הנה תרגום. " + (await toHebrew(ctx.env, body, 1500)) : null;
  }
  return R.msg(convSpeech(c, v.i, v.items.length)) + convMenuRead(st, c);
};
const convMedia = (c) => c.msgs.flatMap((m) => (m.media || []).map((x) => ({ ...x, from: m.n || "" })));
function convMenuRead(st, c, pre = "") {
  const has = convMedia(c).length > 0;
  const p = (pre ? pre + " " : "") + (has ? CONV_MENU.replace("לעוד אפשרויות", "לשמיעת הסרטונים וההקלטות מהשיחה הקש 5. לעוד אפשרויות") : CONV_MENU);
  return R.menu(st, p, has ? "0.1.2.3.4.5.6" : "0.1.2.3.4.6");
}
H.convMenu = async (st, input, ctx) => {
  const v = st.conv, c = v.items[v.i];
  switch (input) {
    case "1": return R.msg(convSpeech(c, v.i, v.items.length)) + convMenuRead(st, c);
    case "5": {
      const media = convMedia(c);
      if (!media.length) return convMenuRead(st, c);
      st.media = { list: media.slice(-8), back: "conv" };
      return go(st, "mediaPick", undefined, ctx);
    }
    case "2":
      st.compose = { kind: "chat", space: c.space, back: "convAfterReply", label: c.dm ? c.title : "קבוצת " + c.title };
      return go(st, "rec", undefined, ctx);
    case "3": v.i++; return go(st, "convItem", undefined, ctx);
    case "4": await chatMarkRead(ctx.env, c.space).catch(() => {}); v.i++; return go(st, "convItem", undefined, ctx, "סומן כנקרא.");
    case "6": return go(st, "convMore", undefined, ctx);
    case "0": return go(st, "main", undefined, ctx);
    default: {
      st.idle = (st.idle || 0) + 1;
      if (st.idle >= 3) return R.msg("להתראות") + R.hangup();
      return convMenuRead(st, c);
    }
  }
};
H.convAfterReply = async (st, input, ctx) => {
  const v = st.conv;
  await chatMarkRead(ctx.env, v.items[v.i].space).catch(() => {});
  if (v.items[v.i].recent) { st.step = "convMenu"; return R.msg("ההודעה נשלחה.") + convMenuRead(st, v.items[v.i]); }
  v.i++;
  return go(st, "convItem", undefined, ctx, "ההודעה נשלחה.");
};

// עוד אפשרויות בשיחה
const convMorePrompt = (c) => `לסיכום השיחה הקש 1. ללייק על ההודעה האחרונה הקש 2. ${c.dm ? "" : "להשתקת הקבוצה הקש 3. להוספת אדם לקבוצה הקש 4. "}לתיקון או מחיקה של ההודעה האחרונה ששלחת הקש 5. לשליחת הודעה קולית הקש 6. לקבצים שנשלחו בשיחה הקש 7. לחזרה הקש 0.`;
H.convMore = async (st, input, ctx) => {
  const env = ctx.env, v = st.conv, c = v.items[v.i];
  const back = (pre = "") => { st.step = "convMenu"; return (pre ? R.msg(pre) : "") + convMenuRead(st, c); };
  if (input === undefined) { st.step = "convMore"; return R.menu(st, convMorePrompt(c), c.dm ? "0.1.2.5.6.7" : "0.1.2.3.4.5.6.7"); }
  switch (input) {
    case "1": {
      const msgs = await spaceMessages(env, c.space, null, 40).catch(() => []);
      const names = await spaceMembers(env, c.space);
      const me = await myUserId(env);
      const text = msgs.map((m) => `${m.sender?.name === "users/" + me ? "אני" : names[m.sender?.name] || "משתתף"}: ${msgText(m)}`).join("\n");
      const sum = await llm(env, "סכם בעברית את השיחה הבאה מהצאט בעד 120 מילים: על מה דיברו, מה הוחלט, ומה מבקשים ממני (אני = שמואל). " + SPOKEN, text, 500).catch(() => "");
      return back(sum || "לא הצלחתי לסכם.");
    }
    case "2": {
      const last = c.msgs.filter((m) => !m.mine && m.name).pop();
      if (!last) return back("אין הודעה לסמן.");
      try { await gapi(env, `${G.chat}${last.name}/reactions`, { body: { emoji: { unicode: "👍" } } }); return back("סומן בלייק."); }
      catch (e) { await logEvent(env, "לייק נכשל: " + e.message); return back("הלייק נכשל."); }
    }
    case "3": {
      if (c.dm) return back();
      const mute = await kvJson(env, "mute", []);
      if (!mute.includes(c.space)) mute.push(c.space);
      await env.KV.put("mute", JSON.stringify(mute));
      v.i++;
      return go(st, "convItem", undefined, ctx, `הקבוצה ${c.title} הושתקה. אפשר לבטל בהגדרות.`);
    }
    case "4": if (c.dm) return back(); return go(st, "addMemberName", undefined, ctx);
    case "5": return go(st, "myLastMsg", undefined, ctx);
    case "6":
      st.compose = { kind: "chat", space: c.space, back: "convAfterReply", label: c.dm ? c.title : "קבוצת " + c.title, audioOnly: true };
      return go(st, "rec", undefined, ctx);
    case "7": {
      const atts = c.msgs.flatMap((m) => (m.atts || []).map((a) => ({ ...a, from: m.n })));
      if (!atts.length) return back("לא נשלחו קבצים בהודעות האלה.");
      st.share = { srcList: atts.slice(-8), back: "conv" };
      return go(st, "sharePickChat", undefined, ctx);
    }
    default: return back();
  }
};
H.addMemberName = async (st, input, ctx) => {
  if (input === undefined) { st.step = "addMemberName"; return R.record(st, "אמור את שם האדם להוספה לקבוצה, ובסיום הקש סולמית."); }
  const c = st.conv.items[st.conv.i];
  const spoken = await transcribeVal(ctx.env, input, "name");
  const found = spoken ? await findPeople(ctx.env, spoken) : [];
  if (!found.length) { st.step = "convMenu"; return R.msg(spoken ? `לא מצאתי איש קשר בשם ${spoken}.` : "לא שמעתי.") + convMenuRead(st, c); }
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "addMemberPick";
  return R.menu(st, st.cands.map((x, i) => `להוסיף את ${x.n}${dupName(st.cands, x) ? " בכתובת " + x.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לביטול הקש 0.", ["0", ...st.cands.map((_, i) => i + 1)].join("."));
};
H.addMemberPick = async (st, input, ctx) => {
  const c = st.conv.items[st.conv.i], x = st.cands?.[+input - 1];
  st.step = "convMenu";
  if (!x) return convMenuRead(st, c);
  try {
    await gapi(ctx.env, `${G.chat}${c.space}/members`, { body: { member: { name: "users/" + x.e, type: "HUMAN" } } });
    await logEvent(ctx.env, `${x.n} נוסף לקבוצה ${c.title}`);
    return R.msg(`${x.n} נוסף לקבוצה.`) + convMenuRead(st, c);
  } catch (e) { await logEvent(ctx.env, "הוספה לקבוצה נכשלה: " + e.message); return R.msg("ההוספה נכשלה. ייתכן שאין לך הרשאה לנהל את הקבוצה.") + convMenuRead(st, c); }
};
// תיקון או מחיקה של ההודעה האחרונה שלי בשיחה
H.myLastMsg = async (st, input, ctx) => {
  const env = ctx.env, c = st.conv.items[st.conv.i];
  if (input === undefined) {
    const me = await myUserId(env);
    const mine = (await spaceMessages(env, c.space, null, 25)).filter((m) => m.sender?.name === "users/" + me).pop();
    if (!mine) { st.step = "convMenu"; return R.msg("לא מצאתי הודעה שלך בשיחה הזו.") + convMenuRead(st, c); }
    st.editMsg = { name: mine.name, text: msgText(mine) };
    st.step = "myLastMsg";
    return R.menu(st, `ההודעה האחרונה שלך: ${st.editMsg.text}. לתיקון בהקלטה מחדש הקש 1. למחיקה הקש 2. לחזרה הקש 0.`, "0.1.2");
  }
  if (input === "1") { st.step = "editMsgRec"; return R.record(st, "אמור את הנוסח החדש של ההודעה, ובסיום הקש סולמית."); }
  if (input === "2") { st.step = "delMsgConfirm"; return R.menu(st, "למחוק את ההודעה? לאישור הקש 1. לביטול הקש 0.", "0.1"); }
  st.step = "convMenu"; return convMenuRead(st, c);
};
H.editMsgRec = async (st, input, ctx) => {
  const c = st.conv.items[st.conv.i];
  const t = await transcribeVal(ctx.env, input, "message");
  st.step = "convMenu";
  if (!t) return R.msg("לא שמעתי. ההודעה לא שונתה.") + convMenuRead(st, c);
  st.editMsg.newText = t; st.step = "editMsgConfirm";
  return R.menu(st, `הנוסח החדש: ${t}. לאישור התיקון הקש 1. לביטול הקש 0.`, "0.1");
};
H.editMsgConfirm = async (st, input, ctx) => {
  const c = st.conv.items[st.conv.i];
  st.step = "convMenu";
  if (input !== "1") return R.msg("בוטל.") + convMenuRead(st, c);
  try { await gapi(ctx.env, `${G.chat}${st.editMsg.name}?updateMask=text`, { method: "PATCH", body: { text: st.editMsg.newText } }); await logEvent(ctx.env, "הודעת צאט תוקנה: " + st.editMsg.newText); return R.msg("ההודעה תוקנה.") + convMenuRead(st, c); }
  catch (e) { await logEvent(ctx.env, "תיקון הודעה נכשל: " + e.message); return R.msg("התיקון נכשל.") + convMenuRead(st, c); }
};
H.delMsgConfirm = async (st, input, ctx) => {
  const c = st.conv.items[st.conv.i];
  st.step = "convMenu";
  if (input !== "1") return R.msg("בוטל.") + convMenuRead(st, c);
  try { await gapi(ctx.env, `${G.chat}${st.editMsg.name}`, { method: "DELETE" }); await logEvent(ctx.env, "הודעת צאט נמחקה"); return R.msg("ההודעה נמחקה.") + convMenuRead(st, c); }
  catch (e) { return R.msg("המחיקה נכשלה.") + convMenuRead(st, c); }
};

// חיפוש שיחה או הודעה בדיבור: "הקבוצה של השיעור", "מה דוד כתב על החשבונית"
H.chatSearchRec = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "chatSearchRec"; return (pre ? R.msg(pre) : "") + R.record(st, "אמור את שם הקבוצה או האדם, ואם תרצה גם על מה ההודעה. בסיום הקש סולמית."); }
  const spoken = await transcribeVal(ctx.env, input, "nav");
  if (!spoken) return go(st, "main", undefined, ctx, "לא שמעתי.");
  return chatSearchRun(st, ctx, spoken);
};
async function chatSearchRun(st, ctx, spoken) {
  const env = ctx.env;
  let j = { who: spoken, keyword: "" };
  try {
    const out = await llm(env, "המשתמש אמר בטלפון איזו שיחה בצאט לפתוח. חלץ JSON בלבד: who (שם הקבוצה או האדם, בלי המילים קבוצה או שיחה), keyword (מילה או שתיים שהוא מחפש בהודעות, או ריק). החזר רק JSON.", spoken, 100);
    j = { ...j, ...JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}") };
  } catch {}
  const who = normName(j.who || spoken);
  const cands = [];
  const mute = await kvJson(env, "mute", []);
  for (const s of (await chatSpaces(env)).filter(isGroup)) {
    const d = normName(s.displayName);
    if (d && who && (d.includes(who) || who.includes(d) || who.split(" ").some((w) => w.length > 2 && d.includes(w)))) cands.push({ space: s.name, dm: false, title: s.displayName, muted: mute.includes(s.name) });
  }
  for (const p of (await findPeople(env, j.who || spoken).catch(() => [])).slice(0, 3)) cands.push({ dm: true, title: p.n, email: p.e });
  if (!cands.length) return go(st, "main", undefined, ctx, `לא מצאתי שיחה או איש קשר בשם ${j.who || spoken}.`);
  st.chatCands = cands.slice(0, 6); st.chatKeyword = j.keyword || "";
  if (st.chatCands.length === 1) return go(st, "chatSearchPick", "1", ctx);
  st.step = "chatSearchPick";
  return R.menu(st, st.chatCands.map((c, i) => `${c.dm ? "שיחה עם " + c.title : "קבוצת " + c.title} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...st.chatCands.map((_, i) => i + 1)].join("."));
}
H.chatSearchPick = async (st, input, ctx) => {
  const c = st.chatCands?.[+input - 1];
  if (!c) return go(st, "main", undefined, ctx);
  if (c.dm) {
    let space = "";
    try { space = await chatDMSpace(ctx.env, c.email, false); } catch {}
    if (!space) return go(st, "main", undefined, ctx, `אין שיחה בצאט עם ${c.title}.`);
    return openConv(st, ctx, { space, dm: true, title: c.title }, st.chatKeyword);
  }
  return openConv(st, ctx, { space: c.space, dm: false, title: c.title }, st.chatKeyword);
};

// ---- הודעה חדשה

H.newStart = async (st, input, ctx) => {
  if (input === undefined) { st.step = "newStart"; return R.menu(st, "לשליחת מייל הקש 1. להודעה בצאט הקש 2. לניסוח מייל עם AI לפי הנחיה קצרה הקש 3. לשמיעת מספר טלפון של איש קשר הקש 4. לחזרה הקש 0.", "0.1.2.3.4"); }
  if (input === "1" || input === "2" || input === "3") { st.newKind = input === "2" ? "chat" : "email"; st.newAi = input === "3"; st.tries = 0; return go(st, "newName", undefined, ctx); }
  if (input === "4") { st.step = "phoneRec"; return R.record(st, "אמור את שם האיש, ובסיום הקש סולמית."); }
  return go(st, "main", undefined, ctx);
};
H.phoneRec = async (st, input, ctx) => {
  const spoken = await transcribeVal(ctx.env, input, "name");
  if (!spoken) return go(st, "newStart", undefined, ctx, "לא שמעתי.");
  return go(st, "newStart", undefined, ctx, await phoneLookup(ctx.env, spoken));
};
H.newName = async (st, input, ctx) => {
  if (input === undefined) { st.step = "newName"; return R.record(st, "אמור את שם האיש אחרי הצליל ובסיום הקש סולמית"); }
  const spoken = await transcribeVal(ctx.env, input, "name");
  if (!spoken) return retryOr(st, ctx, "newName", "לא שמעתי שם.");
  const found = await findPeople(ctx.env, spoken);
  if (!found.length) return retryOr(st, ctx, "newName", `לא מצאתי איש קשר בשם ${spoken}.`);
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "newPick";
  const list = st.cands.map((c, i) => `עבור ${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ");
  return R.menu(st, list + ". לאמירת השם מחדש הקש 9. לביטול הקש 0.", ["0", "9", ...st.cands.map((_, i) => String(i + 1))].join("."));
};
const dupName = (list, c) => list.filter((x) => x.n === c.n).length > 1;
H.newPick = async (st, input, ctx) => {
  if (input === "9") return go(st, "newName", undefined, ctx);
  const c = st.cands?.[+input - 1];
  if (!c) return go(st, "main", undefined, ctx);
  st.compose = st.newKind === "email"
    ? { kind: "email", to: c.e, back: "main", label: c.n, ai: !!st.newAi }
    : { kind: "chatNew", email: c.e, back: "main", label: c.n };
  delete st.newAi;
  return go(st, "rec", undefined, ctx, st.compose.ai ? `מייל עבור ${c.n}. אמור בקצרה מה לכתוב, ואני אנסח.` : `הודעה עבור ${c.n}.`);
};

// ---- הקלטה, אישור ושליחה (משותף לכל סוגי ההודעות)

async function transcribeVal(env, path, mode = "assistant", keep = false) {
  // null = לא הוקלט כלום (סולמית מיד), "" = הוקלט אבל לא זוהה דיבור. keep = להשאיר את קובץ ההקלטה בימות (לצירוף או לשמירה)
  if (!path || path === "none" || path === "None") return null;
  const audio = await ym(env, "DownloadFile", { path: "ivr2:" + path });
  if (!keep) ym(env, "FileAction", { action: "delete", what: "ivr2:" + path }).catch(() => {});
  if (!audio || audio.length < 2000 || audio[0] === 123) return null;
  return transcribe(env, audio, mode);
}
const ymDelete = (env, path) => ym(env, "FileAction", { action: "delete", what: "ivr2:" + path }).catch(() => {});
function retryOr(st, ctx, step, why) {
  st.tries = (st.tries || 0) + 1;
  if (st.tries >= 3) return go(st, "main", undefined, ctx, why + " חוזרים לתפריט הראשי.");
  return go(st, step, undefined, ctx, why + " נסה שוב.");
}

// ---- הקלטה, אישור ושליחה (משותף לכל סוגי ההודעות)

H.rec = async (st, input, ctx, pre = "") => {
  const cp = st.compose;
  if (input === undefined) { st.step = "rec"; return (pre ? R.msg(pre) : "") + R.record(st, cp.audioOnly ? "הקלט את ההודעה הקולית אחרי הצליל. בסיום הקש סולמית." : REC_PROMPT); }
  if (cp.audio && cp.audio !== input) ymDelete(ctx.env, cp.audio);
  cp.audio = input;
  const t = await transcribeVal(ctx.env, input, cp.ai ? "assistant" : "message", true);
  if (!t) {
    cp.fail = (cp.fail || 0) + 1;
    if (cp.fail >= 3) return go(st, "main", undefined, ctx, "לא הצלחתי לשמוע את ההודעה. חוזרים לתפריט הראשי.");
    return go(st, "rec", undefined, ctx, "לא הצלחתי לשמוע. נסה שוב.");
  }
  if (cp.ai && !cp.append) {
    cp.instruction = t;
    try { cp.text = (await draftWithAi(ctx.env, st, t)).trim(); cp.drafted = true; }
    catch { cp.text = t; }
  } else cp.text = cp.append ? (cp.text + " " + t).trim() : t;
  cp.append = false;
  return go(st, "confirm", undefined, ctx);
};
const confirmPrompt = (cp) => {
  const p = ["לשליחה הקש 1", "להקלטה מחדש הקש 2"];
  if (!cp.audioOnly) p.push("להוספה להודעה הקש 3");
  if (!cp.audioOnly && !cp.translated) p.push("לתרגום לאנגלית לפני השליחה הקש 4");
  if (!cp.audioOnly && cp.audio && (cp.kind === "reply" || cp.kind === "email")) p.push("לצירוף ההקלטה הקולית למייל הקש 5");
  if (!cp.audioOnly && cp.audio && (cp.kind === "chat" || cp.kind === "chatNew")) p.push("לשליחה כהודעה קולית במקום טקסט הקש 5");
  p.push("לביטול הקש 0");
  return p.join(". ") + ".";
};
const confirmKeys = (cp) => "0.1.2" + (cp.audioOnly ? "" : ".3.4.5");
H.confirm = async (st, input, ctx) => {
  const cp = st.compose;
  if (input === undefined) {
    st.step = "confirm";
    const what = cp.audioOnly ? `הודעה קולית עבור ${cp.label}, וזה מה שנאמר בה: ${cp.text}` : `${cp.drafted ? "ניסחתי כך. " : ""}ההודעה עבור ${cp.label}: ${cp.text}${cp.withAudio ? ". ההקלטה הקולית תצורף." : ""}`;
    return R.msg(what) + R.menu(st, confirmPrompt(cp), confirmKeys(cp));
  }
  if (input === "2") { cp.drafted = false; return go(st, "rec", undefined, ctx); }
  if (input === "3" && !cp.audioOnly) { cp.append = true; return go(st, "rec", undefined, ctx); }
  if (input === "4" && !cp.audioOnly && !cp.translated) {
    try {
      cp.orig = cp.text;
      cp.text = (await llm(ctx.env, "תרגם את ההודעה הבאה לאנגלית טבעית ומנומסת. החזר רק את התרגום.", cp.text, 400)).trim();
      cp.translated = true;
    } catch { return R.msg("התרגום נכשל.") + R.menu(st, confirmPrompt(cp), confirmKeys(cp)); }
    return go(st, "confirm", undefined, ctx);
  }
  if (input === "5" && !cp.audioOnly && cp.audio) {
    if (cp.kind === "chat" || cp.kind === "chatNew") cp.audioOnly = true;
    else cp.withAudio = true;
    return go(st, "confirm", undefined, ctx);
  }
  if (input === "1") {
    try {
      await sendCompose(ctx.env, st);
    } catch (e) {
      await logEvent(ctx.env, "שליחה נכשלה: " + e.message);
      return R.msg("השליחה נכשלה. ההודעה לא נשלחה") + R.menu(st, confirmPrompt(cp), confirmKeys(cp));
    }
    if (cp.audio) ymDelete(ctx.env, cp.audio);
    const back = cp.back;
    delete st.compose;
    if (back === "main") { st.lastSent = st.lastSent || null; return go(st, "main", undefined, ctx, "ההודעה נשלחה."); }
    return go(st, back, undefined, ctx, "");
  }
  if (input === "0") { if (cp.audio) ymDelete(ctx.env, cp.audio); delete st.compose; return go(st, "main", undefined, ctx, "ההודעה בוטלה."); }
  return R.menu(st, confirmPrompt(cp), confirmKeys(cp));
};

async function recordingBytes(env, path) {
  const b = await ym(env, "DownloadFile", { path: "ivr2:" + path });
  if (!b || b.length < 100 || b[0] === 123) throw new Error("אין הקלטה");
  return b;
}
async function sendCompose(env, st) {
  const cp = st.compose;
  const att = cp.withAudio && cp.audio ? { name: "הקלטה.wav", mime: "audio/wav", bytes: await recordingBytes(env, cp.audio) } : null;
  if (cp.kind === "reply") {
    const c = st.cur;
    const subject = /^(re|תשובה|השב)\s*:/i.test(c.subject) ? c.subject : "Re: " + c.subject;
    await gmailSend(env, { to: c.replyTo, subject, body: cp.text, threadId: c.threadId, inReplyTo: c.msgId, refs: c.refs, att });
    await logEvent(env, `נשלחה תשובה במייל ל${c.fromName}: ${cp.text}`);
  } else if (cp.kind === "email") {
    let subject = "";
    try { subject = (await llm(env, "כתוב נושא קצר (עד 6 מילים) למייל הבא. החזר רק את הנושא, בלי מירכאות.", cp.text, 40)).split("\n")[0].replace(/["']/g, "").trim(); } catch {}
    if (!subject || subject.length > 80) subject = cp.text.split(/\s+/).slice(0, 6).join(" ");
    await gmailSend(env, { to: cp.to, subject, body: cp.text, att });
    await logEvent(env, `נשלח מייל ל${cp.label} (${cp.to}): ${cp.text}`);
  } else if (cp.kind === "chat" || cp.kind === "chatNew") {
    const space = cp.space || (await chatDMSpace(env, cp.email));
    let m;
    if (cp.audioOnly) m = await chatSendAudio(env, space, await recordingBytes(env, cp.audio), cp.text);
    else m = await chatSend(env, space, cp.text);
    st.lastChat = { space, name: m?.name || "" };
    await logEvent(env, `נשלחה הודעת צאט ל${cp.label}: ${cp.audioOnly ? "(הקלטה קולית) " : ""}${cp.text}`);
  }
}
// שליחת הקלטה בצאט כקובץ שמע (העלאה ואז הודעה עם הקובץ)
async function chatSendAudio(env, space, bytes, caption = "") {
  const b = "b" + randKey(12);
  const head = new TextEncoder().encode(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename: "voice-" + Date.now() + ".wav" })}\r\n--${b}\r\nContent-Type: audio/wav\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${b}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const r = await fetch(`https://chat.googleapis.com/upload/v1/${space}/attachments:upload?uploadType=multipart`, {
    method: "POST", headers: { Authorization: "Bearer " + (await accessToken(env)), "Content-Type": `multipart/related; boundary=${b}` }, body,
  });
  const raw = await r.text();
  let j = {};
  try { j = JSON.parse(raw); } catch {}
  // התשובה של media.upload היא { attachmentDataRef: { attachmentUploadToken } }, וכך גם צריך לצרף להודעה
  const tok = j.attachmentDataRef?.attachmentUploadToken || j.attachmentUploadToken || j.attachment_upload_token || j.uploadedAttachment?.attachmentUploadToken;
  if (!r.ok || !tok) throw new Error("chat upload " + r.status + " " + trimText(raw, 200));
  return gapi(env, `${G.chat}${space}/messages`, { body: { text: caption ? "🎤 " + caption : "🎤 הודעה קולית", attachment: [{ attachmentDataRef: { attachmentUploadToken: tok } }] } });
}

// ---- סיכום

H.summary = async (st, input, ctx) => {
  const env = ctx.env;
  const [prim, upd] = await Promise.all([gmailUnread(env, 12, "primary"), gmailUnread(env, 6, "updates")]);
  const mails = await Promise.all([...prim.map((id) => [id, "ראשי"]), ...upd.map((id) => [id, "עדכונים"])]
    .map(([id, cat]) => gmailGet(env, id).then((m) => ({ ...m, cat })).catch(() => null)));
  let convs = [];
  try { convs = await chatUnread(env, "all"); } catch {}
  if (!mails.filter(Boolean).length && !convs.length) return go(st, "main", undefined, ctx, "אין שום דבר חדש. לא הגיעו מיילים או הודעות.");
  const data = [
    ...mails.filter(Boolean).map((m) => `מייל (${m.cat}) מאת ${m.fromName}, נושא: ${m.subject}. ${trimText(m.body, 600)}`),
    ...convs.map((c) => (c.dm ? `צאט פרטי מ${c.title}: ` : `קבוצת ${c.title}: `) + trimText(c.msgs.map((m) => (c.dm ? m.t : m.n + ": " + m.t)).join(" | "), 700)),
  ].join("\n\n");
  const sum = await llm(env,
    "אתה עוזר אישי. סכם עבורי בעברית את המיילים והודעות הצאט החדשים שלי, עד 150 מילים, גם אם הם כתובים באנגלית. התחל במה שבתיבה הראשית ובמה שדחוף או שמבקשים ממני לעשות, ורק אחר כך בקצרה את העדכונים. ציין שמות של מי שכתב, ושמות באנגלית כתוב באותיות עבריות. אל תמציא פרטים. " + SPOKEN,
    data, 600).catch(() => "");
  return go(st, "main", undefined, ctx, sum || "לא הצלחתי להכין סיכום כרגע.");
};

// ---- החלפת קוד

H.pinNew = async (st, input, ctx) => {
  if (input === undefined) { st.step = "pinNew"; return R.digits(st, "הקש קוד חדש בן 4 עד 8 ספרות ובסיום סולמית. לביטול הקש 0 וסולמית", 1, 8); }
  if (!input || input === "none" || input === "0") return go(st, "main", undefined, ctx);
  if (input.length < 4) return R.msg("הקוד קצר מדי") + R.digits(st, "הקש קוד חדש בן 4 עד 8 ספרות ובסיום סולמית", 1, 8);
  st.newPin = input;
  st.step = "pinNew2";
  return R.digits(st, "הקש את הקוד החדש פעם נוספת לאישור ובסיום סולמית", 4, 8);
};
H.pinNew2 = async (st, input, ctx) => {
  const p = st.newPin;
  delete st.newPin;
  if (input !== p) return go(st, "main", undefined, ctx, "הקודים לא תואמים. הקוד לא הוחלף.");
  await ctx.env.KV.put("pin_hash", await pinRecord(ctx.env, p));
  await logEvent(ctx.env, "הקוד הסודי הוחלף דרך הטלפון");
  return go(st, "main", undefined, ctx, "הקוד הוחלף בהצלחה.");
};

export { MAIN_PROMPT, MAIN_SHORT, MAIN_KEYS, MAIL_MENU, MAIL_KEYS, CONV_MENU, REC_PROMPT, TODO_LABEL, SNOOZE_LABEL, vipList, vipQuery, vipUnreadCount, mailMeta, sortImportant, MAIL_LIST_NAMES, startCat, buildMailQuery, mailSearchRun, lastRefs, relDate, mailMorePrompt, snoozeUntil, restoreSnoozed, driveFolder, driveUpload, saveMailToDrive, CANNED_DEFAULT, cannedList, isMailVideo, isMailMedia, attachmentBytes, styleProfile, draftWithAi, openConv, attsOf, convSpeech, convMedia, convMenuRead, convMorePrompt, chatSearchRun, dupName, transcribeVal, ymDelete, retryOr, confirmPrompt, confirmKeys, recordingBytes, sendCompose, chatSendAudio };
