# העלאת קוד בלבד ל-Cloudflare: שומר את כל הסודות וההגדרות הקיימות (keep_bindings)
# שימוש: CF_TOKEN=... python3 deploy_code.py
import json, os, sys, uuid, urllib.request

TOKEN = os.environ.get("CF_TOKEN") or sys.exit("חסר CF_TOKEN")
ACC = "7c5ecc8cc6dc99838cfbf1b3a1086b74"
NAME = "yemot-mail"
HERE = os.path.dirname(os.path.abspath(__file__))
# המודולים שעולים: entry.js (נקודת הכניסה) מחבר את worker.js (הקו) ואת chatsite.js (אתר הצאט)
MODULES = ["entry.js", "worker.js", "chatsite.js"]
meta = {
    "main_module": "entry.js",
    "compatibility_date": "2025-09-01",
    "keep_bindings": ["secret_text", "plain_text", "kv_namespace", "ai", "durable_object_namespace"],
}
b = uuid.uuid4().hex
body = f"--{b}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n".encode()
for m in MODULES:
    body += f"--{b}\r\nContent-Disposition: form-data; name=\"{m}\"; filename=\"{m}\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode()
    body += open(os.path.join(HERE, m), "rb").read() + b"\r\n"
body += f"--{b}--\r\n".encode()
req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/scripts/{NAME}", data=body, method="PUT",
                             headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": f"multipart/form-data; boundary={b}"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=60))
except urllib.error.HTTPError as e:
    r = json.load(e)
print("upload:", r.get("success"), r.get("errors"))
if not r.get("success"):
    sys.exit(1)
if "--code-only" in sys.argv[1:]:
    sys.exit(0)
# משימה מתוזמנת של Cloudflare: כל 15 דקות (דחיות מייל, סיכום יומי בערב)
req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/scripts/{NAME}/schedules", data=json.dumps([{"cron": "*/15 * * * *"}]).encode(), method="PUT",
                             headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=60))
except urllib.error.HTTPError as e:
    r = json.load(e)
print("cron:", r.get("success"), r.get("errors"))
if not r.get("success"):
    sys.exit(1)
