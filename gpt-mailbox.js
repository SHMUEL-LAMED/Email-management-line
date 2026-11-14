// Private GPT inbox. The scheduled ChatGPT task reads and answers through D1's
// authenticated management API. The browser can only submit and read messages.
const ORIGIN = 'https://shmuel-lamed.github.io';
const OWNER = 'shmuel'; // Same single-owner PIN/session as chatsite.js.
export async function gptMailboxApi(req, env, url) {
  const cors = {'access-control-allow-origin': ORIGIN, 'access-control-allow-headers':'content-type, x-chat-token', 'access-control-allow-methods':'GET, POST, OPTIONS', vary:'Origin'};
  const json = (data,status=200)=>Response.json(data,{status,headers:{...cors,'cache-control':'no-store'}});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(!['GET','POST'].includes(req.method))return json({error:'שיטה לא מורשית'},405);
  const token=req.headers.get('x-chat-token')||'';
  if(!token||token.length>1024)return json({error:'צריך להיכנס מחדש'},401);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(!await env.KV.get('cs:tok:'+hash))return json({error:'צריך להיכנס מחדש'},401);
  if(!env.GPT_DB)return json({error:'תיבת ההודעות עדיין לא הוגדרה'},503);
  try {
    const op=url.pathname.split('/').pop();
    if(op==='gpt_history'&&req.method==='GET'){
      const conv=url.searchParams.get('conv');
      if(conv&&!/^[a-zA-Z0-9_-]{1,80}$/.test(conv))return json({error:'שיחה לא תקינה'},400);
      const query=conv?'SELECT id,conv,text,reply,status,created_at,answered_at FROM gpt_messages WHERE owner=? AND conv=? ORDER BY created_at DESC,id DESC LIMIT 300':'SELECT id,conv,text,reply,status,created_at,answered_at FROM gpt_messages WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT 500';
      const stmt=env.GPT_DB.prepare(query);
      const result=await (conv?stmt.bind(OWNER,conv):stmt.bind(OWNER)).all();
      return json({items:result.results.reverse(),mode:'hourly'});
    }
    if(op!=='gpt_send')return json({error:'לא נמצא'},404);
    if(req.method!=='POST')return json({error:'צריך לשלוח בקשת POST'},405);
    if(Number(req.headers.get('content-length'))>70000)return json({error:'הודעה ארוכה מדי'},413);
    const raw=await req.text();if(raw.length>20000)return json({error:'הודעה ארוכה מדי'},413);
    let b;try{b=JSON.parse(raw)}catch{return json({error:'בקשה לא תקינה'},400)}
    const id=String(b.id||''),conv=String(b.conv||''),text=String(b.text||'').trim();
    if(!/^[a-zA-Z0-9_-]{8,80}$/.test(id)||!/^[a-zA-Z0-9_-]{1,80}$/.test(conv))return json({error:'מזהה הודעה או שיחה לא תקין'},400);
    if(!text||text.length>16000)return json({error:'אפשר לשלוח בין 1 ל־16,000 תווים'},400);
    const existing=await env.GPT_DB.prepare('SELECT conv,text FROM gpt_messages WHERE owner=? AND id=?').bind(OWNER,id).first();
    if(existing)return existing.conv===conv&&existing.text===text?json({ok:true,id,duplicate:true}):json({error:'מזהה ההודעה כבר קיים'},409);
    // Keep submission and the hourly limit in a single atomic SQL statement.
    const result=await env.GPT_DB.prepare("INSERT OR IGNORE INTO gpt_messages(id,owner,conv,text,status,created_at) SELECT ?,?,?,?,'pending',? WHERE (SELECT COUNT(*) FROM gpt_messages WHERE owner=? AND created_at>?)<30").bind(id,OWNER,conv,text,Date.now(),OWNER,Date.now()-3600000).run();
    if(!result.meta.changes){const x=await env.GPT_DB.prepare('SELECT conv,text FROM gpt_messages WHERE owner=? AND id=?').bind(OWNER,id).first();if(x?.conv===conv&&x?.text===text)return json({ok:true,id,duplicate:true});return json({error:'הגעת למגבלת 30 הודעות בשעה. נסה מאוחר יותר.'},429)}
    return json({ok:true,id,status:'pending'});
  }catch{return json({error:'שגיאה בתיבת ההודעות. אפשר לנסות שוב.'},500)}
}
