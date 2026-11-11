# העלאת קוד בלבד ל-Cloudflare: שומר את כל הסודות וההגדרות הקיימות (keep_bindings)
# שימוש: CF_TOKEN=... python3 deploy_code.py
import email, json, os, sys, uuid, urllib.request

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
# גשר הווידאו (מאגר 07, scripts/deploy-news-archive.py) מוזרק לסוף worker.js בשרת החי.
# כדי שפריסה של הקו לא תמחק אותו, לוקחים אותו מהגרסה החיה ומחברים אותו שוב לקוד החדש.
BRIDGE_MARKER = "\n\nconst newsVideoAuth="
def live_bridge():
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/scripts/{NAME}/content/v2",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            ctype, raw = r.headers.get("Content-Type", ""), r.read()
    except Exception as e:
        print("אזהרה: לא הצלחתי לקרוא את הגרסה החיה (גשר הווידאו לא נשמר):", e)
        return ""
    msg = email.message_from_bytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
    for part in msg.walk():
        if part.is_multipart():
            continue
        name = part.get_param("name", header="content-disposition") or part.get_filename()
        if name == "worker.js":
            code = part.get_payload(decode=True).decode("utf-8")
            i = code.find(BRIDGE_MARKER)
            return code[i:] if i >= 0 and "const originalMailWorker = {" in code else ""
    return ""

def module_code(m, bridge):
    code = open(os.path.join(HERE, m), "rb").read()
    if m != "worker.js" or not bridge:
        return code
    text = code.decode("utf-8")
    if text.count("export default {") != 1 or "const newsVideoAuth=" in text:
        sys.exit("worker.js במבנה לא צפוי – עצרתי כדי לא לשבור את גשר הווידאו")
    return (text.replace("export default {", "const originalMailWorker = {", 1) + bridge).encode("utf-8")

bridge = live_bridge()
print("גשר הווידאו:", "נשמר" if bridge else "לא נמצא בגרסה החיה (יוחזר בהרצה הבאה של התהליך במאגר 07 עם repair_archive)")
b = uuid.uuid4().hex
body = f"--{b}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n".encode()
for m in MODULES:
    body += f"--{b}\r\nContent-Disposition: form-data; name=\"{m}\"; filename=\"{m}\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode()
    body += module_code(m, bridge) + b"\r\n"
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
