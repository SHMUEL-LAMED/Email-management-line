import { G, H, R, logEvent, nextVal, sleep, text, trimText } from "./base.js";
import { NotConnected, chatUnread, gapi, gmailGet, gmailSend, gmailUnread, llm, ym } from "./google.js";
import { busyOf, claimInput, dropState, loadState, saveState } from "./state.js";
import { TODO_LABEL, mailMeta, restoreSnoozed, ymDelete } from "./menus.js";
import { LOOKUP, gmailIds, gmailLabelId, nowIL } from "./assistant.js";
import { renderPlain, renderSpeech, saveResume } from "./voice.js";
import { isShabbatIL } from "./web.js";

// ---- סיכום יומי במייל (רץ מהמשימה המתוזמנת של Cloudflare בערב)
async function dailySummaryEmail(env) {
  const [prim, upd] = await Promise.all([gmailUnread(env, 15, "primary"), gmailUnread(env, 10, "updates")]);
  const mails = (await Promise.all([...prim.map((id) => [id, "ראשי"]), ...upd.map((id) => [id, "עדכונים"])].map(([id, cat]) => gmailGet(env, id).then((m) => ({ ...m, cat })).catch(() => null)))).filter(Boolean);
  let convs = [];
  try { convs = await chatUnread(env, "all"); } catch {}
  const todo = await gmailLabelId(env, TODO_LABEL).then((l) => gmailIds(env, `label:${TODO_LABEL}`, 20)).catch(() => []);
  const todoMeta = (await mailMeta(env, todo.slice(0, 10))).filter(Boolean);
  const tomorrow = await LOOKUP.list_events.run(env, { from: new Date(Date.now() + 86400e3).toISOString().slice(0, 10), to: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) }).catch(() => []);
  const data = [
    ...mails.map((m) => `מייל (${m.cat}) מאת ${m.fromName}, נושא: ${m.subject}. ${trimText(m.body, 500)}`),
    ...convs.map((c) => (c.dm ? `צאט פרטי מ${c.title}: ` : `קבוצת ${c.title}: `) + trimText(c.msgs.map((m) => (c.dm ? m.t : m.n + ": " + m.t)).join(" | "), 600)),
  ].join("\n\n");
  const sum = data ? await llm(env, "סכם בעברית את המיילים והודעות הצאט שלא נקראו, עד 200 מילים, מסודר: קודם מה שדחוף או מבקשים ממני לעשות, אחר כך השאר בקצרה. ציין שמות. אל תמציא.", data, 800).catch(() => "") : "לא הגיעו מיילים או הודעות חדשים שלא נקראו.";
  const body = [
    `סיכום יומי מהקו, ${nowIL()}`, "",
    `מיילים שלא נקראו: ${prim.length} בראשי, ${upd.length} בעדכונים. שיחות צאט עם הודעות חדשות: ${convs.length}.`, "",
    sum, "",
    todoMeta.length ? "ברשימת לטיפול:\n" + todoMeta.map((m) => `- ${m.from.name}: ${m.subject}`).join("\n") : "רשימת לטיפול ריקה.", "",
    tomorrow.length ? "מחר ביומן:\n" + tomorrow.map((e) => `- ${String(e.start).slice(11, 16) || "כל היום"} ${e.title}`).join("\n") : "מחר אין אירועים ביומן.",
  ].join("\n");
  await gmailSend(env, { to: env.BUSINESS_EMAIL, subject: `סיכום יומי מהקו ${nowIL().slice(0, 10)}`, body });
  await logEvent(env, "נשלח סיכום יומי במייל");
}
// המשימה המתוזמנת של Cloudflare (כל 15 דקות)
async function scheduledTick(env) {
  await restoreSnoozed(env).catch((e) => logEvent(env, "שגיאת דחיות: " + e.message));
  const il = nowIL(); // "YYYY-MM-DD HH:MM, יום"
  const day = il.slice(0, 10), hm = il.slice(11, 16);
  if (hm >= "20:00" && hm < "20:20" && !isShabbatIL() && !(await env.KV.get("daily:" + day))) {
    await env.KV.put("daily:" + day, "1", { expirationTtl: 2 * 86400 });
    await dailySummaryEmail(env).catch((e) => logEvent(env, "סיכום יומי נכשל: " + e.message));
  }
  // בדיקת תקינות פעם ביום, בבוקר (לא בשבת)
  if (hm >= "08:00" && hm < "08:20" && !isShabbatIL() && !(await env.KV.get("health:" + day))) {
    await env.KV.put("health:" + day, "1", { expirationTtl: 2 * 86400 });
    await healthCheck(env).catch((e) => logEvent(env, "בדיקת התקינות נכשלה: " + e.message));
  }
}

// בדיקת תקינות: החיבור לגוגל, המפתח של ימות, והמפתח של Gemini.
// אם משהו לא עובד: נרשם ביומן, נשלח מייל (אם המייל עצמו עובד), ומוקרא בכניסה לקו עד שהבעיה נפתרת.
async function healthCheck(env) {
  const checks = {
    "החיבור לגוגל": async () => { await gapi(env, `${G.gmail}profile`); },
    "המפתח של ימות": async () => {
      const j = await ym(env, "GetSession");
      if (j?.responseStatus !== "OK") throw new Error(j?.message || j?.responseStatus || "אין תשובה");
    },
    "המפתח של Gemini": async () => {
      if (!env.GEMINI_KEY) throw new Error("לא הוגדר");
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${env.GEMINI_KEY}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
    },
  };
  const failed = [];
  for (const [name, fn] of Object.entries(checks)) {
    try { await fn(); } catch (e) { failed.push({ name, err: e instanceof NotConnected ? "לא מחובר" : String(e.message || e).slice(0, 200) }); }
  }
  if (!failed.length) {
    if (await env.KV.get("health:bad")) await logEvent(env, "בדיקת התקינות עברה – התקלה נפתרה");
    await env.KV.delete("health:bad");
    return failed;
  }
  await env.KV.put("health:bad", JSON.stringify({ at: Date.now(), items: failed.map((f) => f.name) }), { expirationTtl: 3 * 86400 });
  await logEvent(env, "בדיקת התקינות מצאה תקלה: " + failed.map((f) => f.name + " (" + f.err + ")").join(", "));
  if (!failed.some((f) => f.name === "החיבור לגוגל") && env.BUSINESS_EMAIL) {
    await gmailSend(env, {
      to: env.BUSINESS_EMAIL,
      subject: "תקלה בקו המייל",
      body: "בבדיקת התקינות היומית נמצאו תקלות:\n" + failed.map((f) => "- " + f.name + ": " + f.err).join("\n") + "\n\nזמן: " + nowIL() + "\nאפשר לראות פרטים ביומן בדף הניהול.",
    }).catch((e) => logEvent(env, "שליחת התראת תקינות נכשלה: " + e.message));
  }
  return failed;
}

// שלבים שבהם "none" הוא פול רגיל של המתנה למשימת רקע (מנגינת המתנה), ולא שתיקה של המתקשר
const WAIT_STEPS = new Set(["aiWait", "mediaWait", "clWait", "botWait"]);
// מעבר לשלב אחר (מריץ אותו מיד, בלי קלט)
const PRE_STEPS = new Set(["main", "grpBrowse", "rec", "aiListen", "clIntro", "mailStart", "mailSearchRec", "chatEmpty", "chatSearchRec", "filesMenu", "settingsMenu", "navRec", "recDoc", "resumeAsk"]);
async function go(st, step, input, ctx, pre = "") {
  st.step = step;
  if (!PRE_STEPS.has(step) && pre) {
    // הודעה מקדימה לפני שלב שאינו מקבל אותה ישירות
    const out = await H[step](st, input, ctx);
    return R.msg(pre) + out;
  }
  return H[step](st, input, ctx, pre);
}

// איחוד כמה הודעות להשמעה לפקודת id_list_message אחת (ימות מקבל אחת בלבד)
function mergeMessages(out) {
  const segs = out.split("&").filter(Boolean);
  const msgs = segs.filter((s) => s.startsWith("id_list_message=")).map((s) => s.slice("id_list_message=".length));
  const rest = segs.filter((s) => !s.startsWith("id_list_message="));
  return (msgs.length ? ["id_list_message=" + msgs.join(".")] : []).concat(rest).join("&");
}

async function handleYemot(req, env, ctx) {
  const url = new URL(req.url);
  const q = Object.fromEntries(url.searchParams);
  if (req.method === "POST") {
    try { const f = await req.formData(); for (const [k, v] of f) q[k] = String(v); } catch {}
  }
  const callId = q.ApiCallId || "nocall";
  if (q.hangup === "yes") {
    const old = await loadState(env, callId).catch(() => null);
    if (old) await saveResume(env, old).catch(() => {});
    await dropState(env, callId);
    return text("");
  }

  let st = (await loadState(env, callId)) || { step: "start", n: 0 };
  let input;
  if (st.expect) {
    input = q[st.expect];
    if (input === undefined) return text(st.last || R.hangup()); // בקשה חוזרת בלי קלט חדש
    if (input === "None" || input === "") input = "none";
    if (input === "*" && st.last) {
      // כוכבית: שמיעה חוזרת של מה שנאמר, עם שם משתנה חדש (ימות לא אוהבת read על משתנה שכבר קיבל ערך)
      const out = st.last.replace(/=V\d+,/, () => "=" + nextVal(st) + ",");
      st.last = out;
      await saveState(env, callId, st);
      return text(out);
    }
    if (input !== "none") st.idle = 0;
    // מתקשר ששותק לאורך זמן (לא בזמן המתנה למשימת רקע): מסיימים את השיחה במקום לחזור על התפריט בלי סוף
    if (input === "none" && !WAIT_STEPS.has(st.step)) {
      st.silent = (st.silent || 0) + 1;
      if (st.silent >= 6) {
        if (st.compose?.audio) ymDelete(env, st.compose.audio);
        await dropState(env, callId);
        return text(renderPlain(R.msg("לא התקבלה הקשה. להתראות") + R.hangup()));
      }
    } else if (input !== "none") st.silent = 0;
    // ימות עלולה לשלוח את אותה בקשה פעם נוספת כשהתשובה מתעכבת. מטפלים בכל הקשה פעם אחת בלבד:
    // הבקשה הכפולה מחכה שהראשונה תסיים ומחזירה את אותה תשובה (במקום לבצע את הפעולה פעמיים)
    if (!(await claimInput(env, callId, st.expect).catch(() => true))) {
      for (let i = 0; i < 36; i++) {
        await sleep(700);
        const b = await busyOf(env, callId).catch(() => null);
        if (!b || b.expect !== st.expect) break;
      }
      const fresh = await loadState(env, callId).catch(() => null);
      return text(fresh?.last || st.last || R.hangup());
    }
  }
  if (st.step !== "start" && st.step !== "pin" && !st.authed) st = { step: "start", n: st.n || 0 };

  let out;
  try {
    out = await H[st.step](st, input, { env, q, ctx });
  } catch (e) {
    await logEvent(env, `שגיאה בשלב ${st.step}: ${e.message}`);
    if (e instanceof NotConnected) out = R.msg("החיבור לחשבון הגוגל נותק. צריך לחבר אותו מחדש בדף החיבור. להתראות") + R.hangup();
    else if (st.authed) { try { out = await go(st, "main", undefined, { env, q, ctx }, "אירעה תקלה. חוזרים לתפריט הראשי."); } catch { out = R.msg("אירעה תקלה. להתראות") + R.hangup(); } }
    else out = R.msg("אירעה תקלה. להתראות") + R.hangup();
  }
  out = mergeMessages(out);
  try { out = await renderSpeech(env, out); } catch (e) { await logEvent(env, "שגיאת קול: " + e.message); out = renderPlain(out); }
  st.last = out;
  await saveState(env, callId, st);
  return text(out);
}

export { dailySummaryEmail, scheduledTick, healthCheck, WAIT_STEPS, PRE_STEPS, go, mergeMessages, handleYemot };
