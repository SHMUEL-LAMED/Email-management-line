import { G, H, R, checkPin, kvJson, logEvent, text, trimText } from "./base.js";
import { chatSend, chatSpaces, findPeople, gapi, isDM, llm, msgText, myUserId, spaceMessages } from "./google.js";
import { cannedList, chatSearchRun, dupName, mailSearchRun, transcribeVal, vipList } from "./menus.js";
import { LOOKUP, aiWaitPrompt, chatTitle, startBgJob } from "./assistant.js";
import { mediaWaitPrompt } from "./media.js";
import { voiceMode } from "./voice.js";
import { go } from "./flow.js";

// ================================================================ הגדרות ומערכות (מקש 9)

const SETTINGS_PROMPT = "לקוד הסודי ולאבטחה הקש 1. לבחירת הקול, טבעי או רגיל, הקש 2. לרשימת האנשים החשובים הקש 3. לתשובות המוכנות הקש 4. לביטול השתקה של קבוצות הקש 5. לדוח השימוש בבינה מלאכותית הקש 6. למצב האתרים שלך הקש 7. לבוט מם כף הקש 8. לבקשת שינוי באתר דרך קלאוד הקש 9. לתפריט הראשי הקש 0.";
H.settingsMenu = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "settingsMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, SETTINGS_PROMPT, "0.1.2.3.4.5.6.7.8.9"); }
  const to = { 1: "securityMenu", 2: "voicePick", 3: "vipMenu", 4: "cannedMenu", 5: "unmute", 6: "usageReport", 7: "sitesStatus", 8: "botMenu", 9: "siteChange" }[input];
  return go(st, to || "main", undefined, ctx);
};
H.securityMenu = async (st, input, ctx) => {
  if (input === undefined) { st.step = "securityMenu"; return R.menu(st, "להחלפת הקוד הסודי הקש 1. לניתוק חירום של החיבור לחשבון גוגל הקש 2. לחזרה הקש 0.", "0.1.2"); }
  if (input === "1") return go(st, "pinNew", undefined, ctx);
  if (input === "2") { st.step = "emergencyPin"; return R.digits(st, "ניתוק חירום מנתק את הקו מחשבון הגוגל, וכדי לחבר מחדש תצטרך להיכנס לדף החיבור במחשב. הקש את הקוד הסודי ובסיום סולמית", 4, 8); }
  return go(st, "settingsMenu", undefined, ctx);
};
H.emergencyPin = async (st, input, ctx) => {
  if (!input || input === "none" || !(await checkPin(ctx.env, input))) return go(st, "settingsMenu", undefined, ctx, "הקוד שגוי. לא נותק.");
  st.step = "emergencyConfirm";
  return R.menu(st, "לאישור סופי של הניתוק הקש 1. לביטול הקש 0.", "0.1");
};
H.emergencyConfirm = async (st, input, ctx) => {
  const env = ctx.env;
  if (input !== "1") return go(st, "settingsMenu", undefined, ctx, "בוטל.");
  const refresh = await env.KV.get("g:refresh");
  if (refresh) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(refresh), { method: "POST" }).catch(() => {});
  await Promise.all(["g:refresh", "g:access", "g:email", "g:me", "contacts", "namehints", "resume"].map((k) => env.KV.delete(k).catch(() => {})));
  await logEvent(env, "ניתוק חירום: החיבור לגוגל בוטל מהטלפון");
  return R.msg("החיבור לחשבון גוגל נותק. להתראות.") + R.hangup();
};
H.voicePick = async (st, input, ctx) => {
  if (input === undefined) {
    const mode = await voiceMode(ctx.env);
    st.step = "voicePick";
    const cur = { all: "טבעי לכל דבר", content: "טבעי לתוכן ורגיל לתפריטים", off: "רגיל" }[mode];
    return R.menu(st, `הקול עכשיו ${cur}. לקול טבעי לתוכן ההודעות ולקול רגיל ומהיר לתפריטים, הקש 1. לקול טבעי לכל דבר, כולל תפריטים, שזה איטי יותר, הקש 2. לקול הרגיל של ימות בלבד הקש 3. לחזרה הקש 0.`, "0.1.2.3");
  }
  const m = { 1: "content", 2: "all", 3: "off" }[input];
  if (m) await ctx.env.KV.put("voice", m);
  return go(st, "settingsMenu", undefined, ctx, m ? "הקול שונה." : "");
};
// אנשים חשובים
H.vipMenu = async (st, input, ctx) => {
  const env = ctx.env;
  if (input === undefined) {
    const vip = await vipList(env);
    st.step = "vipMenu";
    const list = vip.length ? "ברשימה: " + vip.map((v) => v.n).join(", ") + ". " : "הרשימה ריקה. ";
    return R.menu(st, list + "להוספת אדם בדיבור הקש 1. להסרה הקש 2. לחזרה הקש 0.", "0.1.2");
  }
  if (input === "1") { st.step = "vipAddName"; return R.record(st, "אמור את שם האדם, ובסיום הקש סולמית."); }
  if (input === "2") {
    const vip = await vipList(env);
    if (!vip.length) return go(st, "vipMenu", undefined, ctx);
    st.step = "vipRemove";
    return R.menu(st, vip.slice(0, 9).map((v, i) => `להסרת ${v.n} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...vip.slice(0, 9).map((_, i) => i + 1)].join("."));
  }
  return go(st, "settingsMenu", undefined, ctx);
};
H.vipAddName = async (st, input, ctx) => {
  const spoken = await transcribeVal(ctx.env, input, "name");
  const found = spoken ? await findPeople(ctx.env, spoken) : [];
  if (!found.length) return go(st, "vipMenu", undefined, ctx, spoken ? `לא מצאתי איש קשר בשם ${spoken}.` : "לא שמעתי.");
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "vipAddPick";
  return R.menu(st, st.cands.map((c, i) => `${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לביטול הקש 0.", ["0", ...st.cands.map((_, i) => i + 1)].join("."));
};
H.vipAddPick = async (st, input, ctx) => {
  const c = st.cands?.[+input - 1];
  if (!c) return go(st, "vipMenu", undefined, ctx);
  const vip = await vipList(ctx.env);
  if (!vip.some((v) => v.e.toLowerCase() === c.e.toLowerCase())) vip.push(c);
  await ctx.env.KV.put("vip", JSON.stringify(vip.slice(-40)));
  return go(st, "vipMenu", undefined, ctx, `${c.n} נוסף.`);
};
H.vipRemove = async (st, input, ctx) => {
  const vip = await vipList(ctx.env), v = vip[+input - 1];
  if (!v) return go(st, "vipMenu", undefined, ctx);
  await ctx.env.KV.put("vip", JSON.stringify(vip.filter((x) => x !== v)));
  return go(st, "vipMenu", undefined, ctx, `${v.n} הוסר.`);
};
// תשובות מוכנות
H.cannedMenu = async (st, input, ctx) => {
  const env = ctx.env;
  const list = await cannedList(env);
  if (input === undefined) { st.step = "cannedMenu"; return R.menu(st, "התשובות המוכנות: " + list.map((t, i) => `${i + 1}, ${t}`).join(". ") + ". להוספת תשובה בדיבור הקש 1. למחיקת תשובה הקש 2. לחזרה הקש 0.", "0.1.2"); }
  if (input === "1") { st.step = "cannedAdd"; return R.record(st, "אמור את התשובה המוכנה, ובסיום הקש סולמית."); }
  if (input === "2") { st.step = "cannedDel"; return R.menu(st, list.map((t, i) => `למחיקת ${t} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => i + 1)].join(".")); }
  return go(st, "settingsMenu", undefined, ctx);
};
H.cannedAdd = async (st, input, ctx) => {
  const t = await transcribeVal(ctx.env, input, "message");
  if (!t) return go(st, "cannedMenu", undefined, ctx, "לא שמעתי.");
  const list = await cannedList(ctx.env);
  await ctx.env.KV.put("canned", JSON.stringify([...list, t].slice(-9)));
  return go(st, "cannedMenu", undefined, ctx, "נוסף.");
};
H.cannedDel = async (st, input, ctx) => {
  const list = await cannedList(ctx.env), t = list[+input - 1];
  if (!t) return go(st, "cannedMenu", undefined, ctx);
  await ctx.env.KV.put("canned", JSON.stringify(list.filter((x) => x !== t)));
  return go(st, "cannedMenu", undefined, ctx, "נמחק.");
};
// ביטול השתקה
H.unmute = async (st, input, ctx) => {
  const env = ctx.env;
  const mute = await kvJson(env, "mute", []);
  if (input === undefined) {
    if (!mute.length) return go(st, "settingsMenu", undefined, ctx, "אין קבוצות מושתקות.");
    const names = await Promise.all(mute.slice(0, 9).map((s) => chatTitle(env, s)));
    st.muteNames = names;
    st.step = "unmute";
    return R.menu(st, names.map((n, i) => `לביטול ההשתקה של ${n} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...names.map((_, i) => i + 1)].join("."));
  }
  const s = mute[+input - 1];
  if (!s) return go(st, "settingsMenu", undefined, ctx);
  await env.KV.put("mute", JSON.stringify(mute.filter((x) => x !== s)));
  return go(st, "settingsMenu", undefined, ctx, "ההשתקה בוטלה.");
};
// דוח שימוש
H.usageReport = async (st, input, ctx) => {
  const env = ctx.env;
  const days = [];
  for (let i = 0; i < 7; i++) days.push(new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10));
  const all = await Promise.all(days.map((d) => kvJson(env, "usage:" + d, {})));
  const sum = (arr, k) => arr.reduce((a, u) => a + (u[k] || 0), 0);
  const line = (u, label) => `${label}: ${u.stt || 0} תמלולים, ${u.gemini || 0} פניות לג׳מיני, ${u.tts || 0} קטעי קול טבעי, ${u.cf || 0} פניות לקלאודפלר${u.quota ? `, ו ${u.quota} פעמים שמודל היה חסום במכסה` : ""}.`;
  const week = { stt: sum(all, "stt"), gemini: sum(all, "gemini"), tts: sum(all, "tts"), cf: sum(all, "cf"), quota: sum(all, "quota") };
  const text = `${line(all[0], "היום")} ${line(week, "בשבוע האחרון")} הכל במכסה החינמית. כשמודל חסום, הקו עובר אוטומטית למודל אחר או לקול הרגיל.`;
  return go(st, "settingsMenu", undefined, ctx, text);
};
// מצב האתרים
const SITES_DEFAULT = [
  { n: "ראש בראש", u: "https://shmuel-lamed.github.io/rosh-berosh-2/" },
  { n: "כלי מוזיקה", u: "https://shmuel-lamed.github.io/SongToNotes/" },
  { n: "גלריית שמחות", u: "https://shmuel-lamed.github.io/1/" },
  { n: "השרת של הגלריה", u: "https://simchas-gallery-api.smwlyqswkwt232.workers.dev/" },
];
async function sitesCheck(env) {
  const sites = (await kvJson(env, "sites")) || SITES_DEFAULT;
  return Promise.all(sites.map(async (s) => {
    const t = Date.now();
    try {
      const r = await fetch(s.u, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "yemot-line-check" } });
      const sec = (Date.now() - t) / 1000;
      return `${s.n}: ${r.ok ? "תקין" : "מחזיר שגיאה " + r.status}, זמן תגובה ${sec < 1 ? "פחות משנייה" : Math.round(sec) + " שניות"}`;
    } catch (e) { return `${s.n}: לא מגיב`; }
  }));
}
H.sitesStatus = async (st, input, ctx) => go(st, "settingsMenu", undefined, ctx, (await sitesCheck(ctx.env)).join(". ") + ".");

// ---- בוט מ.כ: שיחה עם הבוט דרך השיחה הפרטית שלו בצאט (לא נוגעים בבוט עצמו)
async function botSpace(env) {
  const c = await env.KV.get("mc:space");
  if (c) return c;
  const me = await myUserId(env);
  for (const s of (await chatSpaces(env)).filter(isDM).slice(0, 40)) {
    try {
      const j = await gapi(env, `${G.chat}${s.name}/members?pageSize=10`);
      const bot = (j.memberships || []).find((m) => m.member?.type === "BOT" || /מ\.?כ|חימקה|בוט/.test(m.member?.displayName || ""));
      if (bot && !/^users\/\d+$/.test(bot.member?.name || "") || (bot && bot.member?.type === "BOT")) { await env.KV.put("mc:space", s.name); return s.name; }
    } catch {}
  }
  return "";
}
H.botMenu = async (st, input, ctx) => {
  const env = ctx.env;
  if (input === undefined) {
    const space = await botSpace(env);
    if (!space) return go(st, "settingsMenu", undefined, ctx, "לא מצאתי שיחה פרטית עם הבוט בצאט. שלח לו הודעה פעם אחת מהמחשב, ואז זה יעבוד.");
    const me = await myUserId(env);
    const msgs = (await spaceMessages(env, space, null, 4)).map((m) => `${m.sender?.name === "users/" + me ? "אתה" : "הבוט"}: ${trimText(msgText(m), 300)}`).join(". ");
    st.step = "botMenu";
    return R.msg(msgs ? "ההודעות האחרונות עם הבוט: " + msgs : "אין הודעות.") + R.menu(st, "לשליחת פקודה לבוט בדיבור, למשל מצב, עצור, הפעל, או אשר את הפוסט, הקש 1. לחזרה הקש 0.", "0.1");
  }
  if (input === "1") { st.step = "botRec"; return R.record(st, "אמור את הפקודה לבוט, ובסיום הקש סולמית."); }
  return go(st, "settingsMenu", undefined, ctx);
};
H.botRec = async (st, input, ctx) => {
  const env = ctx.env;
  const t = await transcribeVal(env, input, "command");
  if (!t) return go(st, "botMenu", undefined, ctx, "לא שמעתי.");
  st.bot = { text: t };
  st.step = "botConfirm";
  return R.menu(st, `לשלוח לבוט: ${t}? לאישור הקש 1. לביטול הקש 0.`, "0.1");
};
H.botConfirm = async (st, input, ctx) => {
  const env = ctx.env;
  if (input !== "1") return go(st, "botMenu", undefined, ctx, "בוטל.");
  const space = await botSpace(env);
  await chatSend(env, space, st.bot.text);
  await logEvent(env, "נשלחה פקודה לבוט מ.כ: " + st.bot.text);
  st.bot.sentAt = new Date().toISOString(); st.bot.polls = 0;
  st.step = "botWait"; st.media = { ...(st.media || {}), music: 0 };
  return mediaWaitPrompt(st, "נשלח. מחכה לתשובה מהבוט");
};
H.botWait = async (st, input, ctx) => {
  const env = ctx.env;
  const space = await botSpace(env);
  const me = await myUserId(env);
  const reply = (await spaceMessages(env, space, st.bot.sentAt, 5).catch(() => [])).filter((m) => m.sender?.name !== "users/" + me);
  if (reply.length) { delete st.media; return go(st, "botMenu", undefined, ctx, "הבוט ענה: " + reply.map(msgText).join(". ")); }
  st.bot.polls++;
  if (st.bot.polls > 12) { delete st.media; return go(st, "botMenu", undefined, ctx, "הבוט עדיין לא ענה. תוכל לבדוק שוב בתפריט הזה."); }
  return mediaWaitPrompt(st);
};
// בקשת שינוי באתר: נשלחת לקלאוד דרך הגשר, עם אישור בקו לפני העלאה
H.siteChange = async (st, input, ctx) => {
  st.cl = { list: [], i: 0, polls: 0, prefix: "(בקשה לשינוי באתר, מהטלפון) " };
  return go(st, "clIntro", undefined, ctx, "תאר מה לשנות ובאיזה אתר. קלאוד יכין את השינוי ויבקש ממך אישור בקו לפני שהוא עולה לאוויר.");
};

// ================================================================ ניווט בדיבור (מקש 0 בתפריט הראשי)
const NAV_TARGETS = "mail_primary, mail_updates, mail_vip, mail_todo, mail_search, mail_unanswered, dm, groups, chat_search, new_email, new_chat, summary, assistant, claude, files, share_file, record_to_drive, settings, phone_lookup, sites_status, bot, unknown";
H.navRec = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "navRec"; return (pre ? R.msg(pre) : "") + R.record(st, "אמור לאן ללכת או מה לחפש, למשל: המיילים החדשים, הקבוצה של השיעור, מה הטלפון של דוד, או תשלח הודעה לאברהם. בסיום הקש סולמית."); }
  const env = ctx.env;
  const spoken = await transcribeVal(env, input, "nav");
  if (!spoken) return go(st, "main", undefined, ctx, "לא שמעתי.");
  let j = { target: "unknown" };
  try {
    const out = await llm(env, `המשתמש אמר בטלפון לאן הוא רוצה להגיע בקו. החזר JSON בלבד: target אחד מתוך: ${NAV_TARGETS}. query: הטקסט הרלוונטי לחיפוש (שם אדם, שם קבוצה, נושא), או ריק. הסברים: mail_search לחיפוש מייל מסוים, chat_search לפתיחת קבוצה או שיחה לפי שם, new_email או new_chat לשליחת הודעה לאדם (query = שם האדם), phone_lookup למספר טלפון של מישהו, assistant לבקשה מורכבת או שאלה כללית, claude לדיבור עם קלאוד.`, spoken, 120);
    j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {}
  const t = j.target, q = String(j.query || "").trim();
  const cat = { mail_primary: "1", mail_updates: "2", mail_vip: "3", mail_todo: "4" }[t];
  if (cat) { await H.mailStart(st, undefined, ctx); return H.mailStart(st, cat, ctx); }
  if (t === "mail_search") return q ? mailSearchRun(st, ctx, q) : go(st, "mailSearchRec", undefined, ctx);
  if (t === "mail_unanswered") return go(st, "unanswered", undefined, ctx);
  if (t === "dm") return go(st, "dmStart", undefined, ctx);
  if (t === "groups") return go(st, "grpStart", undefined, ctx);
  if (t === "chat_search") return q ? chatSearchRun(st, ctx, q) : go(st, "chatSearchRec", undefined, ctx);
  if (t === "new_email" || t === "new_chat") {
    st.newKind = t === "new_email" ? "email" : "chat"; st.tries = 0;
    if (!q) return go(st, "newName", undefined, ctx);
    const found = await findPeople(env, q);
    if (!found.length) return go(st, "newName", undefined, ctx, `לא מצאתי איש קשר בשם ${q}.`);
    st.cands = found.map((f) => ({ n: f.n, e: f.e })); st.step = "newPick";
    return R.menu(st, st.cands.map((c, i) => `עבור ${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לאמירת השם מחדש הקש 9. לביטול הקש 0.", ["0", "9", ...st.cands.map((_, i) => String(i + 1))].join("."));
  }
  if (t === "summary") return go(st, "summary", undefined, ctx);
  if (t === "assistant") { st.ai = { h: [] }; return aiAsk(st, ctx, spoken); }
  if (t === "claude") return go(st, "claudeStart", undefined, ctx);
  if (t === "files") return go(st, "filesMenu", undefined, ctx);
  if (t === "share_file") { st.share = { back: "files" }; return go(st, "shareSrc", undefined, ctx); }
  if (t === "record_to_drive") { st.recd = { parts: [] }; return go(st, "recDoc", undefined, ctx); }
  if (t === "settings") return go(st, "settingsMenu", undefined, ctx);
  if (t === "sites_status") return go(st, "sitesStatus", undefined, ctx);
  if (t === "bot") return go(st, "botMenu", undefined, ctx);
  if (t === "phone_lookup") return go(st, "main", undefined, ctx, await phoneLookup(env, q || spoken));
  st.ai = { h: [] };
  return aiAsk(st, ctx, spoken);
};
async function phoneLookup(env, name) {
  const res = await LOOKUP.get_contact_details.run(env, { name }).catch(() => []);
  const hit = res.filter((p) => p.phones?.length);
  if (!hit.length) return `לא מצאתי מספר טלפון עבור ${name}.`;
  return hit.slice(0, 3).map((p) => `${p.name}: ${p.phones.slice(0, 2).join(", ו ")}`).join(". ") + ".";
}
// הפעלת העוזר החכם עם טקסט מוכן (בלי הקלטה נוספת)
async function aiAsk(st, ctx, text) {
  const jobId = "j" + st.n;
  st.ai.job = jobId; st.ai.polls = 0;
  await startBgJob(ctx, jobId, { type: "ai", history: st.ai.h, text });
  st.step = "aiWait";
  return aiWaitPrompt(st, "רגע, אני בודק");
}

export { SETTINGS_PROMPT, SITES_DEFAULT, sitesCheck, botSpace, NAV_TARGETS, phoneLookup, aiAsk };
