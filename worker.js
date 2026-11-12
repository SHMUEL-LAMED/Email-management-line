// קו טלפוני לניהול מייל וצ'אט (Google Workspace) דרך ימות המשיח – Cloudflare Worker, שלוחת API.
// הקובץ הזה רק מחבר: הקוד עצמו בתיקייה lib/ (base: כלי עזר ודיבור, google: ימות, AI וגוגל, state: מצב השיחה,
// menus: מייל וצאט, assistant: העוזר החכם, media: סרטונים והקלטות, claude: שיחה עם Claude, voice: קול טבעי,
// files: קבצים, settings: הגדרות וניווט, web: דפי ניהול וגשר, flow: הניתוב של ימות והמשימה המתוזמנת).
// כל השמות מיובאים לכאן גם כדי שקוד שמוזרק לסוף הקובץ בשרת החי (גשר הווידאו) ימשיך למצוא אותם.
import { G, H, HEB_ABBR, HEB_MONTHS, MAX_CHAT_SPACES, R, SCOPES, SP0, SP1, YM, b64, b64url, checkPin, cleanForSpeech, decodeBody, esc, hasPin, hmacHex, html, kvJson, logEvent, nextVal, normPhone, pinRecord, pinSecret, randKey, safeEq, say, sha, sleep, sp, text, trimText, unb64url, utf8b64 } from "./lib/base.js";
import { CAT_NAME, DWD_SCOPES, MAIL_CATS, NotConnected, SPOKEN, STT_CONTEXT, YT_RE, accessToken, bodyOf, chatDMSpace, chatMarkRead, chatSend, chatSpaces, chatUnread, contactBook, countAttachments, encHeader, findPeople, gapi, geminiBusy, geminiCall, gmailGet, gmailMarkRead, gmailSend, gmailUnread, header, htmlToText, isBusy, isDM, isForeign, isGroup, isInlineImage, isMediaAtt, llm, markBusy, mediaOf, msgText, myUserId, nameHints, normName, parseAddr, readState, saToken, spaceMembers, spaceMessages, toHebrew, transcribe, userName, wrap76, ym } from "./lib/google.js";
import { BUSY_MS, CallState, bridge, bridgeOp, busyOf, claimInput, dropState, getJob, loadState, saveState, setJob, stub } from "./lib/state.js";
import { CANNED_DEFAULT, CONV_MENU, MAIL_KEYS, MAIL_LIST_NAMES, MAIL_MENU, MAIN_KEYS, MAIN_PROMPT, MAIN_SHORT, REC_PROMPT, SNOOZE_LABEL, TODO_LABEL, attachmentBytes, attsOf, buildMailQuery, cannedList, chatSearchRun, chatSendAudio, confirmKeys, confirmPrompt, convMedia, convMenuRead, convMorePrompt, convSpeech, draftWithAi, driveFolder, driveUpload, dupName, isMailMedia, isMailVideo, lastRefs, mailMeta, mailMorePrompt, mailSearchRun, openConv, recordingBytes, relDate, restoreSnoozed, retryOr, saveMailToDrive, sendCompose, snoozeUntil, sortImportant, startCat, styleProfile, transcribeVal, vipList, vipQuery, vipUnreadCount, ymDelete } from "./lib/menus.js";
import { ACTIONS, AI_LISTEN, ASK_CHOICE, BULK_MAX, CAL, DOCS, DRIVE, HOLD_DIR, LOOKUP, SHEETS, SLOW_ACTIONS, TASKS, actionJobResult, aiExit, aiJobResult, aiSystem, aiTurn, aiWaitPrompt, attachmentsOf, batchModify, catOf, chatTitle, choicePrompt, countWord, emailLine, geminiTools, gmailIds, gmailLabelId, heb, ilOffset, modifyEmail, nameForEmail, nowIL, pushHist, resultMemo, resultSpoken, runJob, soft, spokenLabels, startBgJob, toolDecls } from "./lib/assistant.js";
import { ASK_FILE_TEXT, GEMINI_MEDIA, MEDIA_EXT, MEDIA_EXTS, MEDIA_MAX, VIDEO_EXT, YT_API, canAskFile, geminiUpload, mediaBack, mediaBytes, mediaExt, mediaWaitPrompt, mediaWords, runFileJob, runMediaJob, startMediaJob, uploadMedia, ytDur, ytGet, ytModeKeys, ytModePrompt, ytTitles } from "./lib/media.js";
import { CL_CONFIRM, CL_COPY_SUBJECT, CL_SUBJECT, clWaitPrompt, claudeEmailReply, claudeMailHtml, claudeMails, escHtml, ilTimeOf, inlineMd, mailCopyOfAnswer, markClaudeMailDone, mdToHtml, myAddresses, updateAiMemory } from "./lib/claude.js";
import { SP_RE, bump, chunkText, cleanForVoice, decSp, pcmToWav, renderPlain, renderSpeech, saveResume, securityAlert, sentenceChunks, ttsBytes, ttsFile, ttsRound, voiceMode, voiceOn, voiceSay } from "./lib/voice.js";
import { GOOGLE_EXPORT, doShare, ensureInDrive, isDriveMedia, runRecSave, shareBack, srcBytes } from "./lib/files.js";
import { NAV_TARGETS, SETTINGS_PROMPT, SITES_DEFAULT, aiAsk, botSpace, phoneLookup, sitesCheck } from "./lib/settings.js";
import { PAGE, bridgeApi, connect, isShabbatIL, oauthCallback, statusPage, sunsetIL, testConnection } from "./lib/web.js";
import { PRE_STEPS, WAIT_STEPS, dailySummaryEmail, go, handleYemot, healthCheck, mergeMessages, scheduledTick } from "./lib/flow.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (env.PATH_KEY && path.startsWith("/yemot/") && (await safeEq(path.slice(7), env.PATH_KEY))) return handleYemot(req, env, ctx);
    if (path.startsWith("/bridge/")) return bridgeApi(req, env, url);
    if (path === "/connect") return connect(env, url);
    if (path === "/oauth/callback") return oauthCallback(env, url);
    if (path === "/" || path === "/status") return statusPage(env, url);
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(scheduledTick(env)); },
};

// לבדיקות
export { CallState, healthCheck, safeEq, checkPin, hasPin, pinRecord, claudeMailHtml, isShabbatIL, sunsetIL, saveMailToDrive, H, say, bodyOf, parseAddr, handleYemot, findPeople, toHebrew, transcribe, geminiTools, aiSystem, runMediaJob, scheduledTick, claudeMails, renderSpeech, chunkText };
