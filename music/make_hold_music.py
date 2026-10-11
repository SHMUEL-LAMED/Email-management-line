# מנגינת המתנה מקורית (נוצרה בקוד): ארפג'יו רגוע, מחולק ל-3 קטעים של 4 שניות שממשיכים זה את זה
import math, struct, wave
SR = 8000
BEAT = 0.5  # 120 BPM, חצי שנייה לפעמה
def note(f): return 440 * 2 ** ((f - 69) / 12)
# אקורדים: דו מז'ור, לה מינור, פה מז'ור, סול מז'ור (2 שניות לכל אחד)
chords = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67], [60, 64, 67, 72], [57, 60, 64, 69]]
pattern = [0, 1, 2, 3]  # ארפג'יו עולה
total = len(chords) * 4 * BEAT
n = int(total * SR)
buf = [0.0] * n
def add_tone(start, dur, freq, amp, decay):
    s = int(start * SR)
    for i in range(int(dur * SR)):
        if s + i >= n: break
        t = i / SR
        env = math.exp(-t * decay) * min(1, t * 200)
        v = math.sin(2 * math.pi * freq * t) + 0.35 * math.sin(4 * math.pi * freq * t) + 0.1 * math.sin(6 * math.pi * freq * t)
        buf[s + i] += amp * env * v
t = 0.0
for ch in chords:
    add_tone(t, 4 * BEAT, note(ch[0] - 12), 0.22, 0.9)  # בס רך לכל האקורד
    for k, idx in enumerate(pattern):
        add_tone(t + k * BEAT, 1.2, note(ch[idx] + 12), 0.25, 3.2)
    t += 4 * BEAT
peak = max(abs(x) for x in buf) or 1
pcm = [int(32767 * 0.7 * x / peak) for x in buf]
seg = int(4 * SR)
for k in range(3):
    part = pcm[k * seg:(k + 1) * seg]
    with wave.open(f"wait{k + 1}.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(struct.pack("<%dh" % len(part), *part))
print("ok", len(pcm) / SR, "seconds")
