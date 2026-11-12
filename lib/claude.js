import { G, H, R, kvJson, logEvent, nextVal, sp, text, trimText } from "./base.js";
import { gapi, gmailGet, gmailSend, llm } from "./google.js";
import { bridge } from "./state.js";
import { transcribeVal } from "./menus.js";
import { HOLD_DIR, gmailIds, nowIL } from "./assistant.js";
import { go } from "./flow.js";

// ================================================================ שיחה עם קלאוד (מקש 7)
// ההודעות נשמרות בתור. ריצה מתוזמנת של Claude בודקת כל שעה; כשהיא רצה היא "מחוברת", ואז אפשר לנהל שיחה חיה.
H.claudeStart = async (st, input, ctx) => {
  const b = await bridge(ctx.env, "state");
  st.cl = { list: b.unheard, i: 0, polls: 0 };
  if (b.unheard.length) {
    const n = b.unheard.length;
    return go(st, "clAnswer", undefined, ctx, n === 1 ? "יש לך תשובה חדשה מקלאוד." : `יש לך ${n} תשובות חדשות מקלאוד.`);
  }
  return go(st, "clIntro", undefined, ctx);
};
const CL_CONFIRM = "לאישור הקש 1. לביטול הקש 2. לבקשת שינוי הקש 3.";
H.clAnswer = async (st, input, ctx) => {
  const c = st.cl;
  if (c.i >= c.list.length) return go(st, "clIntro", undefined, ctx);
  const a = c.list[c.i];
  await bridge(ctx.env, "heard", { ids: [a.id] });
  if (a.confirm) {
    st.step = "clConfirm";
    return R.msg(a.text) + R.menu(st, CL_CONFIRM, "1.2.3");
  }
  c.i++;
  return R.msg(a.text) + (await go(st, "clAnswer", undefined, ctx));
};
H.clConfirm = async (st, input, ctx) => {
  const c = st.cl, a = c.list[c.i];
  if (input === "1" || input === "2") {
    await bridge(ctx.env, "add", { kind: "approval", text: `(${input === "1" ? "מאושר" : "לא מאושר, לבטל"}) לגבי הבקשה לאישור: ${a.confirm}` });
    c.i++;
    return go(st, "clAnswer", undefined, ctx, input === "1" ? "אישרת. קלאוד יבצע את זה." : "ביטלת. זה לא יבוצע.");
  }
  if (input === "3") { st.step = "clChange"; return R.record(st, "אמור מה לשנות אחרי הצליל, ובסיום הקש סולמית."); }
  return R.menu(st, CL_CONFIRM, "1.2.3");
};
H.clChange = async (st, input, ctx) => {
  const c = st.cl, a = c.list[c.i];
  const t = await transcribeVal(ctx.env, input, "message");
  if (!t) return go(st, "clAnswer", undefined, ctx, "לא שמעתי. הבקשה נשארה ממתינה.");
  await bridge(ctx.env, "add", { kind: "approval", text: `(בקשת שינוי) לגבי הבקשה לאישור: ${a.confirm}. מה לשנות: ${t}` });
  c.i++;
  return go(st, "clAnswer", undefined, ctx, "הבקשה לשינוי נשלחה לקלאוד.");
};
function ilTimeOf(ms) {
  const d = new Date(ms);
  const t = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const days = Math.floor((Date.now() - ms) / 86400e3);
  return `${days === 0 ? "היום" : days === 1 ? "אתמול" : `לפני ${days} ימים`} בשעה ${t}`;
}
H.clIntro = async (st, input, ctx, pre = "") => {
  const b = await bridge(ctx.env, "state");
  st.cl.live = b.live;
  st.step = "clRec";
  const last = b.lastRun && !st.cl.saidRun ? ` הבדיקה האחרונה של קלאוד הייתה ${ilTimeOf(b.lastRun)}.${b.pending ? ` ${b.pending === 1 ? "הודעה אחת" : b.pending + " הודעות"} שלך עדיין מחכות לתשובה.` : ""}` : "";
  st.cl.saidRun = true;
  const p = b.live
    ? "קלאוד מחובר עכשיו. דבר אחרי הצליל, ובסיום הקש סולמית. ליציאה הקש סולמית בלי לומר כלום."
    : `קלאוד לא מחובר כרגע.${last} השאר הודעה אחרי הצליל, וקלאוד יענה בבדיקה הבאה. הבדיקות הן פעם בשעה, בימים ראשון עד חמישי מאחת בצהריים עד ארבע ומשבע בערב עד שתיים בלילה, וגם במוצאי שבת. אפשר גם לשלוח לקלאוד מייל מהמייל העסקי לעצמך, עם המילה שש בנושא. בסיום הקש סולמית. ליציאה הקש סולמית בלי לומר כלום.`;
  return (pre ? R.msg(pre) : "") + R.record(st, p);
};
H.clRec = async (st, input, ctx) => {
  const t = await transcribeVal(ctx.env, input, "message");
  if (t === null) { delete st.cl; return go(st, "main", undefined, ctx, "יצאת משיחה עם קלאוד."); }
  if (!t) return go(st, "clIntro", undefined, ctx, "לא שמעתי. נסה שוב.");
  const { id } = await bridge(ctx.env, "add", { text: (st.cl.prefix || "") + t });
  const b = await bridge(ctx.env, "state");
  if (!b.live) return go(st, "clIntro", undefined, ctx, "ההודעה נשמרה. תשמע את התשובה כשתתקשר שוב.");
  st.cl.wait = id;
  st.cl.polls = 0;
  st.step = "clWait";
  return clWaitPrompt(st, "ההודעה נשלחה. קלאוד עונה, רגע");
};
function clWaitPrompt(st, text = "") {
  st.cl.music = ((st.cl.music || 0) % 3) + 1;
  const v = nextVal(st);
  return `read=${(text ? sp(text, "m") + "." : "") + `f-${HOLD_DIR}${st.cl.music}`}=${v},no,1,1,1,No,yes,no,,,,Ok,none,`;
}
H.clWait = async (st, input, ctx) => {
  const c = st.cl;
  const r = await bridge(ctx.env, "answerFor", { re: c.wait });
  if (r.answer) {
    c.list = [r.answer]; c.i = 0;
    return go(st, "clAnswer", undefined, ctx);
  }
  c.polls++;
  if (!r.live && c.polls > 3) return go(st, "clIntro", undefined, ctx, "קלאוד התנתק בינתיים. התשובה תחכה לך כאן בפעם הבאה שתתקשר.");
  if (c.polls % 45 === 0) {
    st.step = "clWaitMore";
    return R.menu(st, "קלאוד עדיין עובד על התשובה. להמשך המתנה הקש 1. לחזרה לתפריט הראשי הקש 2, והתשובה תחכה לך.", "1.2");
  }
  return clWaitPrompt(st);
};
H.clWaitMore = async (st, input, ctx) => {
  if (input === "1") { st.step = "clWait"; st.cl.polls++; return clWaitPrompt(st, "ממשיכים לחכות"); }
  delete st.cl;
  return go(st, "main", undefined, ctx);
};

// ================================================================ קלאוד במייל, זיכרון העוזר, חיפוש באינטרנט, משימות מתוזמנות

// ---- מיילים לקלאוד: מייל שהוא שולח מהמייל העסקי לעצמו, עם "שש" בנושא
const CL_SUBJECT = "שש";
const CL_COPY_SUBJECT = "תשובה מקלאוד בקו";
// כל הכתובות שהוא שולח מהן (המייל העסקי וכתובות "שלח בשם" שלו), במטמון ליום
async function myAddresses(env) {
  const c = await kvJson(env, "myaddrs");
  if (c && Date.now() - c.t < 86400e3) return c.list;
  const set = new Set([String(env.BUSINESS_EMAIL || "").toLowerCase()]);
  try { (await gapi(env, `${G.gmail}settings/sendAs`)).sendAs?.forEach((a) => a.sendAsEmail && set.add(a.sendAsEmail.toLowerCase())); } catch {}
  try { const p = await gapi(env, `${G.gmail}profile`); if (p.emailAddress) set.add(p.emailAddress.toLowerCase()); } catch {}
  const list = [...set];
  await env.KV.put("myaddrs", JSON.stringify({ t: Date.now(), list }));
  return list;
}
async function claudeMails(env) {
  const mine = new Set(await myAddresses(env));
  const done = new Set(await kvJson(env, "clmail:done", []));
  const ids = await gmailIds(env, `(subject:${CL_SUBJECT} OR subject:"${CL_COPY_SUBJECT}") newer_than:14d`, 30);
  const out = [];
  for (const id of ids.filter((x) => !done.has(x))) {
    const m = await gmailGet(env, id).catch(() => null);
    if (!m || !mine.has(m.fromEmail.toLowerCase())) continue;
    const subj = m.subject.replace(/^(re|fwd?)\s*:\s*/i, "");
    const isCopyThread = subj.startsWith(CL_COPY_SUBJECT);
    if (!isCopyThread && !/(^|\s)שש(\s|$|:)/.test(subj)) continue;
    if (/^\s*(השאלה שלך:|התשובה:)/.test(m.body)) continue; // עותק שהקו עצמו שלח
    out.push({ id, threadId: m.threadId, subject: m.subject, text: trimText(m.body, 6000), at: m.date, msgId: m.msgId, refs: m.refs });
  }
  return out;
}
async function markClaudeMailDone(env, ...ids) {
  const done = await kvJson(env, "clmail:done", []);
  await env.KV.put("clmail:done", JSON.stringify([...new Set([...done, ...ids])].slice(-300)));
}
async function claudeEmailReply(env, id, text) {
  const m = await gmailGet(env, id);
  const subject = /^re:/i.test(m.subject) ? m.subject : "Re: " + m.subject;
  const sent = await gmailSend(env, { to: env.BUSINESS_EMAIL, subject, body: text, html: claudeMailHtml([{ text }]), threadId: m.threadId, inReplyTo: m.msgId, refs: m.refs });
  await markClaudeMailDone(env, id, sent.id);
  await logEvent(env, "קלאוד ענה במייל: " + trimText(text, 100));
  return sent;
}
// ---- עיצוב המיילים מקלאוד: הופך טקסט (עם Markdown קל) למייל מעוצב מימין לשמאל
const escHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function inlineMd(t) {
  return escHtml(t)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,!?:]|$)/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, '<code style="background:#f1f3f4;padding:1px 5px;border-radius:4px;font-family:monospace;direction:ltr;unicode-bidi:embed">$1</code>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1a73e8">$1</a>');
}
function mdToHtml(text) {
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p style="margin:0 0 14px">${para.map(inlineMd).join("<br>")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag} style="margin:0 0 14px;padding-right:22px;padding-left:0">${list.items.map((i) => `<li style="margin:0 0 6px">${inlineMd(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^\s*(#{1,3})\s+(.*)$/))) {
      flushPara(); flushList();
      const sz = { 1: 21, 2: 18, 3: 16 }[m[1].length];
      out.push(`<div style="font-size:${sz}px;font-weight:bold;color:#1f3a5f;margin:18px 0 8px;border-bottom:${m[1].length === 1 ? "2px solid #d97757" : "none"};padding-bottom:${m[1].length === 1 ? 4 : 0}px">${inlineMd(m[2])}</div>`);
      continue;
    }
    if ((m = line.match(/^\s*([-*•])\s+(.*)$/)) || (m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
      continue;
    }
    if (/^\s*(-{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0">'); continue; }
    flushList();
    // שורה שמסתיימת בנקודתיים ונראית כמו כותרת קצרה
    if (/^[^.!?]{2,40}:$/.test(line.trim()) && !para.length) { out.push(`<div style="font-weight:bold;color:#1f3a5f;margin:10px 0 6px">${inlineMd(line.trim())}</div>`); continue; }
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("\n");
}
function claudeMailHtml(parts) {
  // parts: [{title?, text, muted?}]
  const blocks = parts.filter((p) => p.text).map((p) => `
    <div style="margin:0 0 18px;${p.muted ? "background:#f6f7f9;border-right:4px solid #c5cad3;padding:12px 16px;border-radius:6px;color:#444" : ""}">
      ${p.title ? `<div style="font-size:13px;font-weight:bold;color:${p.muted ? "#666" : "#d97757"};margin:0 0 8px">${escHtml(p.title)}</div>` : ""}
      ${mdToHtml(p.text)}
    </div>`).join("");
  return `<!doctype html><html dir="rtl" lang="he"><body style="margin:0;padding:0;background:#f2f2f2">
<div dir="rtl" style="max-width:640px;margin:0 auto;padding:16px;font-family:Arial,'Segoe UI',sans-serif;font-size:15px;line-height:1.7;color:#222;text-align:right">
  <div style="background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e3e3e3">
    <div style="background:#1f3a5f;color:#fff;padding:12px 18px;font-size:16px;font-weight:bold">✳ תשובה מקלאוד</div>
    <div style="padding:18px 20px">${blocks}</div>
    <div style="border-top:1px solid #eee;padding:10px 18px;font-size:12px;color:#888">אפשר להשיב למייל הזה, והתשובה תגיע לקלאוד.</div>
  </div>
</div></body></html>`;
}
// עותק במייל של תשובה שקלאוד נתן בקו
async function mailCopyOfAnswer(env, question, answer) {
  try {
    const r = await gmailSend(env, {
      to: env.BUSINESS_EMAIL, subject: CL_COPY_SUBJECT,
      body: `${question ? "השאלה שלך:\n" + question + "\n\n" : ""}התשובה:\n${answer}\n\n(אפשר להשיב למייל הזה, והתשובה תגיע לקלאוד)`,
      html: claudeMailHtml([{ title: "השאלה שלך (מהקו)", text: question, muted: true }, { title: "התשובה", text: answer }]),
    });
    if (r?.id) await markClaudeMailDone(env, r.id);
  } catch (e) { await logEvent(env, "עותק במייל נכשל: " + e.message); }
}

// ---- זיכרון של העוזר החכם בין שיחות (סיכום קצר של מה שחשוב)
async function updateAiMemory(env, history) {
  if (!history || history.length < 2) return;
  try {
    const old = (await env.KV.get("ai:mem")) || "";
    const conv = history.map((h) => (h.r === "user" ? "שמואל: " : "העוזר: ") + h.t).join("\n");
    const mem = await llm(env, "אתה מנהל זיכרון של עוזר אישי. לפניך הזיכרון הקיים והשיחה האחרונה. כתוב זיכרון מעודכן, עד 25 שורות קצרות, עם מה שכדאי לזכור לשיחות הבאות: העדפות של המשתמש, אנשים וקבוצות שהוא מזכיר הרבה, דברים שביקש לעקוב אחריהם, ומה נעשה לאחרונה (עם תאריך). בלי פרטים חד פעמיים חסרי חשיבות. החזר רק את הזיכרון.", `הזיכרון הקיים:\n${old || "(ריק)"}\n\nהשיחה האחרונה (${nowIL()}):\n${conv}`, 900);
    if (mem) await env.KV.put("ai:mem", trimText(mem, 3000));
  } catch (e) { await logEvent(env, "עדכון זיכרון נכשל: " + e.message); }
}

export { CL_CONFIRM, ilTimeOf, clWaitPrompt, CL_SUBJECT, CL_COPY_SUBJECT, myAddresses, claudeMails, markClaudeMailDone, claudeEmailReply, escHtml, inlineMd, mdToHtml, claudeMailHtml, mailCopyOfAnswer, updateAiMemory };
