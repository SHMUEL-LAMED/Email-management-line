# העלאה מלאה ל-Cloudflare: הקוד (כל המודולים) וגם כל ההגדרות והסודות.
# זהירות: מחליף את כל ההגדרות שבשרת במה שבתיקייה. לעדכון קוד בלבד משתמשים ב-deploy_code.py.
# שימוש: python3 deploy.py <תיקייה-עם-סודות>
# בתיקייה: .cf_token, secrets.json, kv_id, ואופציונלי sa_worker.json (מפתח חשבון שירות של גוגל)
import json, os, sys
import deploy_code as dc

if len(sys.argv) < 2:
    sys.exit("שימוש: python3 deploy.py <תיקייה-עם-סודות>")
S = sys.argv[1]
TOKEN = open(os.path.join(S, ".cf_token")).read().strip()
sec = json.load(open(os.path.join(S, "secrets.json")))
kv_id = open(os.path.join(S, "kv_id")).read().strip()

bindings = [
    {"type": "kv_namespace", "name": "KV", "namespace_id": kv_id},
    {"type": "ai", "name": "AI"},
    {"type": "durable_object_namespace", "name": "CALLS", "class_name": "CallState"},
]
# משתני טקסט (לא סודיים)
for k in ("ALLOWED_PHONES", "BUSINESS_EMAIL", "GOOGLE_CLIENT_ID", "TTS_VOICE", "TTS_MODELS", "GEMINI_MODELS", "AGENT_MODELS", "VOICE_BUDGET_MS"):
    if sec.get(k):
        bindings.append({"type": "plain_text", "name": k, "text": str(sec[k])})
for k in ("ALLOWED_PHONES", "BUSINESS_EMAIL"):
    if not sec.get(k):
        sys.exit(f"חסר {k} ב-secrets.json")
# סודות
for k in ("YM_TOKEN", "PIN", "PIN_SECRET", "PATH_KEY", "SETUP_KEY", "GOOGLE_CLIENT_SECRET", "GEMINI_KEY", "BRIDGE_KEY", "YT_KEY"):
    if sec.get(k):
        bindings.append({"type": "secret_text", "name": k, "text": sec[k]})
sa = os.path.join(S, "sa_worker.json")
if os.path.exists(sa):
    bindings.append({"type": "secret_text", "name": "GOOGLE_SA_KEY", "text": open(sa).read()})

meta = {"main_module": dc.MAIN, "compatibility_date": dc.COMPAT, "bindings": bindings}
# יצירת מחלקת ה-Durable Object בפעם הראשונה בלבד
cur = dc.api(TOKEN, "GET", f"/workers/scripts/{dc.NAME}/settings")
if not cur.get("success") and not any(e.get("code") == 10007 for e in cur.get("errors") or []):  # 10007: ה-Worker עוד לא קיים
    sys.exit("לא הצלחתי לקרוא את ההגדרות הקיימות: " + json.dumps(cur.get("errors"), ensure_ascii=False))
has_do = any(b.get("type") == "durable_object_namespace" for b in (cur.get("result") or {}).get("bindings", []))
if not has_do:
    meta["migrations"] = {"new_tag": "v1", "new_sqlite_classes": ["CallState"]}

dc.upload(TOKEN, meta)
dc.set_cron(TOKEN)
r = dc.api(TOKEN, "POST", f"/workers/scripts/{dc.NAME}/subdomain", json.dumps({"enabled": True, "previews_enabled": False}).encode())
print("workers.dev:", r.get("success"), r.get("errors"))
