import { G, H, R, logEvent, text, trimText } from "./base.js";
import { accessToken, chatDMSpace, chatSend, findPeople, gapi, gmailSend, header, llm, parseAddr, transcribe } from "./google.js";
import { MAIL_KEYS, MAIL_MENU, attachmentBytes, buildMailQuery, convMenuRead, driveFolder, driveUpload, dupName, recordingBytes, relDate, transcribeVal, ymDelete } from "./menus.js";
import { ACTIONS, DRIVE, LOOKUP, attachmentsOf, gmailIds, heb, nowIL } from "./assistant.js";
import { startMediaJob } from "./media.js";
import { chunkText } from "./voice.js";
import { go } from "./flow.js";

// ================================================================ קבצים והקלטות (מקש 8)

H.filesMenu = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "filesMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, "לשיתוף קובץ עם מישהו הקש 1. להקלטה ושמירה בדרייב או תמלול למסמך הקש 2. לקבצים ששותפו איתך לאחרונה הקש 3. לתפריט הראשי הקש 0.", "0.1.2.3"); }
  if (input === "1") { st.share = { back: "files" }; return go(st, "shareSrc", undefined, ctx); }
  if (input === "2") { st.recd = { parts: [] }; return go(st, "recDoc", undefined, ctx); }
  if (input === "3") return go(st, "sharedWithMe", undefined, ctx);
  return go(st, "main", undefined, ctx);
};

// ---- שיתוף קובץ: מקור -> למי -> איך -> אישור
H.shareSrc = async (st, input, ctx) => {
  if (input === undefined) { st.step = "shareSrc"; return R.menu(st, "לקובץ מהדרייב הקש 1. לקובץ שצורף למייל הקש 2. לקובץ שנשלח בצאט הקש 3. להקלטה חדשה הקש 4. לחזרה הקש 0.", "0.1.2.3.4"); }
  if (input === "1") { st.step = "shareDriveRec"; return R.record(st, "אמור את שם הקובץ או מילה מתוכו, ובסיום הקש סולמית."); }
  if (input === "2") { st.step = "shareMailRec"; return R.record(st, "אמור איזה מייל לחפש, למשל: המייל מדוד עם החשבונית. בסיום הקש סולמית."); }
  if (input === "3") { st.share.fromChat = true; return go(st, "chatSearchRec", undefined, ctx); }
  if (input === "4") { st.step = "shareRec"; return R.record(st, "הקלט אחרי הצליל, ובסיום הקש סולמית."); }
  return go(st, "filesMenu", undefined, ctx);
};
H.shareDriveRec = async (st, input, ctx) => {
  const spoken = await transcribeVal(ctx.env, input, "command");
  if (!spoken) return go(st, "shareSrc", undefined, ctx, "לא שמעתי.");
  const files = await LOOKUP.search_drive.run(ctx.env, { text: spoken }).catch(() => []);
  if (!files.length) return go(st, "shareSrc", undefined, ctx, `לא מצאתי בדרייב קובץ עם ${spoken}.`);
  st.share.srcList = files.slice(0, 8).map((f) => ({ type: "drive", id: f.id, name: f.name, mime: f.mimeType }));
  return go(st, "sharePickSrc", undefined, ctx);
};
H.shareMailRec = async (st, input, ctx) => {
  const env = ctx.env;
  const spoken = await transcribeVal(env, input, "nav");
  if (!spoken) return go(st, "shareSrc", undefined, ctx, "לא שמעתי.");
  const ids = await gmailIds(env, (await buildMailQuery(env, spoken)) + " has:attachment", 6);
  if (!ids.length) return go(st, "shareSrc", undefined, ctx, "לא מצאתי מייל עם קובץ מצורף לפי החיפוש.");
  const list = [];
  for (const id of ids) {
    const m = await gapi(env, `${G.gmail}messages/${id}?format=full`).catch(() => null);
    if (!m) continue;
    const from = parseAddr(header(m, "From")).name;
    for (const a of attachmentsOf(m.payload).slice(0, 3)) list.push({ type: "gmail", mailId: id, attId: a.id, name: a.name, mime: a.mime, size: a.size, label: `${a.name} מהמייל של ${from}` });
  }
  if (!list.length) return go(st, "shareSrc", undefined, ctx, "לא מצאתי קבצים מצורפים.");
  st.share.srcList = list.slice(0, 8);
  return go(st, "sharePickSrc", undefined, ctx);
};
H.shareRec = async (st, input, ctx) => {
  if (!input || input === "none") return go(st, "shareSrc", undefined, ctx, "לא הוקלט כלום.");
  st.share.src = { type: "rec", path: input, name: `הקלטה ${nowIL().slice(0, 16).replace(/[: ]/g, "-")}.wav`, label: "ההקלטה שהקלטת עכשיו", mime: "audio/wav" };
  return go(st, "shareWho", undefined, ctx);
};
H.sharePickChat = async (st, input, ctx) => {
  const list = st.share.srcList;
  if (input === undefined) {
    st.step = "sharePickChat";
    const parts = await Promise.all(list.map(async (a, i) => `${await heb(ctx.env, a.name)}${a.from ? " ששלח " + a.from : ""} הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => i + 1)].join("."));
  }
  const a = list[+input - 1];
  if (!a) { st.step = "convMenu"; return convMenuRead(st, st.conv.items[st.conv.i]); }
  st.share.src = { type: "chat", res: a.res, drive: a.drive, name: a.name, mime: a.mime };
  return go(st, "shareWho", undefined, ctx);
};
H.sharePickSrc = async (st, input, ctx) => {
  const list = st.share.srcList;
  if (input === undefined) {
    if (list.length === 1) return go(st, "sharePickSrc", "1", ctx);
    st.step = "sharePickSrc";
    const parts = await Promise.all(list.map(async (a, i) => `${await heb(ctx.env, a.label || a.name)} הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => i + 1)].join("."));
  }
  const a = list[+input - 1];
  if (!a) return go(st, "shareSrc", undefined, ctx);
  st.share.src = a;
  return go(st, "shareWho", undefined, ctx);
};
H.shareWho = async (st, input, ctx) => {
  if (input === undefined) { st.step = "shareWho"; return R.msg(st.share.src.label ? `נבחרה ${st.share.src.label}.` : `נבחר הקובץ ${await heb(ctx.env, st.share.src.name)}.`) + R.record(st, "אמור למי לשלוח, ובסיום הקש סולמית."); }
  const spoken = await transcribeVal(ctx.env, input, "name");
  const found = spoken ? await findPeople(ctx.env, spoken) : [];
  if (!found.length) return go(st, "shareWho", undefined, ctx, spoken ? `לא מצאתי איש קשר בשם ${spoken}.` : "לא שמעתי.");
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "shareWhoPick";
  return R.menu(st, st.cands.map((c, i) => `עבור ${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לביטול הקש 0.", ["0", ...st.cands.map((_, i) => i + 1)].join("."));
};
H.shareWhoPick = async (st, input, ctx) => {
  const c = st.cands?.[+input - 1];
  if (!c) return shareBack(st, ctx, "בוטל.");
  st.share.to = c;
  st.step = "shareHow";
  return R.menu(st, "איך לשלוח? כקובץ מצורף במייל הקש 1. כקישור בצאט הקש 2. כהרשאה בדרייב הקש 3. לביטול הקש 0.", "0.1.2.3");
};
H.shareHow = async (st, input, ctx) => {
  const how = { 1: "mail", 2: "chat", 3: "drive" }[input];
  if (!how) return shareBack(st, ctx, "בוטל.");
  st.share.how = how;
  st.step = "shareConfirm";
  const w = { mail: "כקובץ מצורף במייל", chat: "כקישור בצאט", drive: "כהרשאת צפייה בדרייב" }[how];
  return R.menu(st, `לשלוח את ${st.share.src.label || await heb(ctx.env, st.share.src.name)} אל ${st.share.to.n} ${w}? לאישור הקש 1. לביטול הקש 0.`, "0.1");
};
H.shareConfirm = async (st, input, ctx) => {
  if (input !== "1") return shareBack(st, ctx, "בוטל.");
  try {
    await doShare(ctx.env, st.share);
    await logEvent(ctx.env, `קובץ ${st.share.src.name} נשלח ל${st.share.to.n} (${st.share.how})`);
    return shareBack(st, ctx, "נשלח.");
  } catch (e) {
    await logEvent(ctx.env, "שיתוף נכשל: " + e.message);
    return shareBack(st, ctx, "השליחה נכשלה.");
  }
};
function shareBack(st, ctx, pre = "") {
  const back = st.share?.back;
  if (st.share?.src?.type === "rec") ymDelete(ctx.env, st.share.src.path);
  delete st.share; delete st.cands;
  if (back === "mail" && st.cur) { st.step = "mailMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  if (back === "conv" && st.conv) { st.step = "convMenu"; return (pre ? R.msg(pre) : "") + convMenuRead(st, st.conv.items[st.conv.i]); }
  return go(st, "filesMenu", undefined, ctx, pre);
}
const GOOGLE_EXPORT = { "application/vnd.google-apps.document": ["application/pdf", ".pdf"], "application/vnd.google-apps.spreadsheet": ["application/pdf", ".pdf"], "application/vnd.google-apps.presentation": ["application/pdf", ".pdf"] };
// הבאת תוכן הקובץ ממקורו (דרייב, מייל, צאט או הקלטה)
async function srcBytes(env, src) {
  if (src.type === "rec") return { bytes: await recordingBytes(env, src.path), name: src.name, mime: "audio/wav" };
  if (src.type === "gmail") return { bytes: await attachmentBytes(env, src.mailId, src.attId), name: src.name, mime: src.mime || "application/octet-stream" };
  if (src.type === "chat") {
    if (src.drive) return srcBytes(env, { type: "drive", id: src.drive, name: src.name, mime: src.mime });
    const r = await fetch(`${G.chat}media/${src.res.split("/").map(encodeURIComponent).join("/")}?alt=media`, { headers: { Authorization: "Bearer " + (await accessToken(env)) } });
    if (!r.ok) throw new Error("chat media " + r.status);
    return { bytes: new Uint8Array(await r.arrayBuffer()), name: src.name, mime: src.mime || "application/octet-stream" };
  }
  const f = await gapi(env, `${DRIVE}files/${src.id}?fields=name,mimeType,size`);
  const ex = GOOGLE_EXPORT[f.mimeType];
  const url = ex ? `${DRIVE}files/${src.id}/export?mimeType=${encodeURIComponent(ex[0])}` : `${DRIVE}files/${src.id}?alt=media`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + (await accessToken(env)) } });
  if (!r.ok) throw new Error("drive download " + r.status);
  return { bytes: new Uint8Array(await r.arrayBuffer()), name: ex ? f.name + ex[1] : f.name, mime: ex ? ex[0] : f.mimeType };
}
// מוודא שהקובץ נמצא בדרייב (מעלה אם צריך) ומחזיר מזהה וקישור
async function ensureInDrive(env, src) {
  if (src.type === "drive" || (src.type === "chat" && src.drive)) {
    const id = src.type === "drive" ? src.id : src.drive;
    const f = await gapi(env, `${DRIVE}files/${id}?fields=id,name,webViewLink`);
    return f;
  }
  const b = await srcBytes(env, src);
  return driveUpload(env, { name: b.name, mime: b.mime, bytes: b.bytes, folder: await driveFolder(env, "קבצים מהקו") });
}
async function doShare(env, share) {
  const { src, to, how } = share;
  if (how === "mail") {
    const b = await srcBytes(env, src);
    if (b.bytes.length > 20e6) throw new Error("גדול מדי למייל");
    await gmailSend(env, { to: to.e, subject: b.name, body: `שלום ${to.n},\nמצורף הקובץ ${b.name}.\n`, att: b });
    return;
  }
  const f = await ensureInDrive(env, src);
  await gapi(env, `${DRIVE}files/${f.id}/permissions?sendNotificationEmail=${how === "drive"}`, { body: { role: "reader", type: "user", emailAddress: to.e } });
  if (how === "chat") {
    const space = await chatDMSpace(env, to.e);
    await chatSend(env, space, `${f.name}\n${f.webViewLink}`);
  }
}

// ---- הקלטה לדרייב או תמלול למסמך (אפשר בכמה חלקים)
H.recDoc = async (st, input, ctx, pre = "") => {
  const n = st.recd.parts.length;
  if (input === undefined) { st.step = "recDoc"; return (pre ? R.msg(pre) : "") + R.record(st, n ? `הקלט את חלק ${n + 1} אחרי הצליל, ובסיום הקש סולמית.` : "הקלט אחרי הצליל: הכתבה, שיעור או פגישה, עד שלוש דקות בכל חלק. בסיום הקש סולמית."); }
  if (!input || input === "none") return st.recd.parts.length ? go(st, "recDocMenu", undefined, ctx) : go(st, "filesMenu", undefined, ctx, "לא הוקלט כלום.");
  st.recd.parts.push(input);
  return go(st, "recDocMenu", undefined, ctx);
};
H.recDocMenu = async (st, input, ctx) => {
  const n = st.recd.parts.length;
  if (input === undefined) { st.step = "recDocMenu"; return R.menu(st, `${n === 1 ? "הוקלט חלק אחד" : `הוקלטו ${n} חלקים`}. לשמירה כקובץ קול בדרייב הקש 1. לתמלול למסמך גוגל הקש 2. לשניהם הקש 3. להקלטת חלק נוסף הקש 4. לביטול הקש 0.`, "0.1.2.3.4"); }
  if (input === "4") return go(st, "recDoc", undefined, ctx);
  const mode = { 1: "audio", 2: "doc", 3: "both" }[input];
  if (!mode) { st.recd.parts.forEach((p) => ymDelete(ctx.env, p)); delete st.recd; return go(st, "filesMenu", undefined, ctx, "בוטל."); }
  st.media = { back: "files" };
  return startMediaJob(ctx, st, { type: "recsave", parts: st.recd.parts, mode });
};
async function runRecSave(env, job) {
  const folder = await driveFolder(env, "הקלטות מהקו");
  const stamp = nowIL().slice(0, 16);
  const texts = [];
  let saved = 0;
  for (let i = 0; i < job.parts.length; i++) {
    const bytes = await recordingBytes(env, job.parts[i]);
    if (job.mode !== "doc") { await driveUpload(env, { name: `הקלטה ${stamp}${job.parts.length > 1 ? ` חלק ${i + 1}` : ""}.wav`, mime: "audio/wav", bytes, folder }); saved++; }
    if (job.mode !== "audio") texts.push(await transcribe(env, bytes, "document").catch(() => ""));
    ymDelete(env, job.parts[i]);
  }
  let docMsg = "";
  if (job.mode !== "audio") {
    const text = texts.filter(Boolean).join("\n\n");
    if (!text) docMsg = "התמלול יצא ריק.";
    else {
      let title = "";
      try { title = (await llm(env, "תן כותרת של עד 5 מילים לטקסט הבא. החזר רק את הכותרת.", trimText(text, 800), 30)).split("\n")[0].trim(); } catch {}
      await driveUpload(env, { name: (title || "תמלול") + " " + stamp, mime: "text/plain", bytes: new TextEncoder().encode(text), folder, convertTo: "application/vnd.google-apps.document" });
      docMsg = `התמלול נשמר כמסמך בשם ${title || "תמלול"}. תחילת התמלול: ${trimText(text, 300)}`;
    }
  }
  await logEvent(env, `הקלטה נשמרה בדרייב (${job.mode}), ${job.parts.length} חלקים`);
  return { kind: "say", text: `${saved ? (saved === 1 ? "קובץ הקול נשמר בדרייב בתיקייה הקלטות מהקו. " : `${saved} קבצי קול נשמרו בדרייב. `) : ""}${docMsg}` };
}

// ---- קבצים ששותפו איתי לאחרונה
const isDriveMedia = (f) => /^(audio|video)\//.test(f.mime || "");
H.sharedWithMe = async (st, input, ctx) => {
  const env = ctx.env;
  if (input === undefined) {
    const j = await gapi(env, `${DRIVE}files?q=${encodeURIComponent("sharedWithMe=true and trashed=false")}&orderBy=sharedWithMeTime desc&pageSize=8&fields=files(id,name,mimeType,sharingUser(displayName),sharedWithMeTime)`);
    const files = j.files || [];
    if (!files.length) return go(st, "filesMenu", undefined, ctx, "לא שותפו איתך קבצים.");
    st.shared = files.map((f) => ({ id: f.id, name: f.name, mime: f.mimeType, by: f.sharingUser?.displayName || "", at: f.sharedWithMeTime || "" }));
    st.step = "sharedWithMe";
    const parts = await Promise.all(st.shared.map(async (f, i) => `${await heb(env, f.name)}${f.by ? " מאת " + (await heb(env, f.by)) : ""}${f.at ? " " + relDate(f.at) : ""} הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...st.shared.map((_, i) => i + 1)].join("."));
  }
  const f = st.shared?.[+input - 1];
  if (!f) return go(st, "filesMenu", undefined, ctx);
  st.sharedCur = f; st.step = "sharedMenu";
  if (isDriveMedia(f)) return R.menu(st, `${/^video\//.test(f.mime) ? "סרטון" : "הקלטה"}, ${await heb(env, f.name)}. לשמיעה הקש 1. לשליחה לאדם אחר הקש 2. לחזרה הקש 0.`, "0.1.2");
  return R.menu(st, `${await heb(env, f.name)}. להקראה או סיכום הקש 1. לשליחה לאדם אחר הקש 2. לחזרה הקש 0.`, "0.1.2");
};
H.sharedMenu = async (st, input, ctx) => {
  const f = st.sharedCur;
  if (input === "1" && isDriveMedia(f)) {
    st.media = { back: "files" };
    return startMediaJob(ctx, st, { type: "file", drive: f.id, mime: f.mime, name: f.name });
  }
  if (input === "1") {
    const t = await ACTIONS.read_drive_file.run(ctx.env, { id: f.id }).catch(() => "לא הצלחתי לקרוא את הקובץ.");
    st.media = { back: "files", pages: chunkText(t, 2000), page: 0 };
    return go(st, "mediaText", undefined, ctx);
  }
  if (input === "2") { st.share = { src: { type: "drive", id: f.id, name: f.name, mime: f.mime }, back: "files" }; return go(st, "shareWho", undefined, ctx); }
  return go(st, "sharedWithMe", undefined, ctx);
};

export { shareBack, GOOGLE_EXPORT, srcBytes, ensureInDrive, doShare, runRecSave, isDriveMedia };
