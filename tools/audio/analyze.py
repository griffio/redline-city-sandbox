"""Pitch-track engine recordings and render spectrogram strips.
usage: python3 -I analyze.py OUT_DIR file1.mp3 [file2 ...]
Writes OUT_DIR/<name>.png and prints a per-second summary: rms dB, firing freq, est V8 rpm."""
import sys, os, subprocess, json
import numpy as np
from PIL import Image, ImageDraw

SR = 22050
def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768

def stft(x, n=4096, hop=512):
    w = np.hanning(n)
    frames = max(1, 1 + (len(x) - n) // hop)
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    return np.abs(np.fft.rfft(x[idx] * w, axis=1)), hop / SR

def track(mag):
    """Firing frequency via harmonic sum over 25..500 Hz (engine orders are strongly harmonic)."""
    freqs = np.fft.rfftfreq(4096, 1 / SR)
    cands = np.arange(25, 500, 0.5)
    lm = np.log1p(mag * 50)
    score = np.zeros((mag.shape[0], len(cands)))
    for h in range(1, 7):
        bins = np.clip(np.round(cands * h / (SR / 4096)).astype(int), 0, mag.shape[1] - 1)
        score += lm[:, bins] / h ** 0.3
    best = cands[np.argmax(score, axis=1)]
    conf = score.max(1) / (score.mean(1) + 1e-9)
    return best, conf

def render(mag, f0, conf, dt, title, out):
    freqs = np.fft.rfftfreq(4096, 1 / SR)
    H = 220
    logf = np.geomspace(20, 3000, H)
    bins = np.clip(np.round(logf / (SR / 4096)).astype(int), 0, mag.shape[1] - 1)
    img = 20 * np.log10(mag[:, bins] + 1e-6)
    img = np.clip((img - (img.max() - 70)) / 70, 0, 1)
    W = mag.shape[0]
    step = max(1, W // 1400)
    img = img[::step]
    a = (np.flipud(img.T) * 255).astype(np.uint8)
    rgb = np.stack([a, (a * 0.8).astype(np.uint8), (255 - a) // 3], -1)
    im = Image.fromarray(rgb).convert("RGB")
    im = im.resize((im.width, H))
    d = ImageDraw.Draw(im)
    ys = lambda f: H - 1 - np.log(f / 20) / np.log(3000 / 20) * (H - 1)
    for f in (50, 100, 200, 400, 800, 1600):
        d.line([(0, ys(f)), (8, ys(f))], fill=(255, 255, 255)); d.text((10, ys(f) - 6), f"{f}", fill=(200, 200, 200))
    pts = [(i, ys(f0[i * step])) for i in range(len(img)) if conf[i * step] > 1.6]
    for p in pts: d.point(p, fill=(0, 255, 120))
    secs = int(len(img) * step * dt)
    for s in range(0, secs + 1, 5):
        x = s / (step * dt); d.line([(x, H - 6), (x, H)], fill=(255, 255, 255)); d.text((x + 2, H - 14), f"{s}s", fill=(255, 255, 255))
    canvas = Image.new("RGB", (im.width, H + 18), (0, 0, 0)); canvas.paste(im, (0, 18))
    ImageDraw.Draw(canvas).text((4, 3), title, fill=(255, 255, 0))
    canvas.save(out)

if __name__ == "__main__":
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    for path in sys.argv[2:]:
        x = load(path)
        name = os.path.splitext(os.path.basename(path))[0]
        mag, dt = stft(x)
        f0, conf = track(mag)
        rms = 20 * np.log10(np.sqrt(np.convolve(x * x, np.ones(SR // 2) / (SR // 2), "same")) + 1e-6)
        render(mag, f0, conf, dt, f"{name}  {len(x)/SR:.1f}s", f"{out}/{name}.png")
        per = int(1 / dt)
        summ = []
        for s in range(0, len(f0), per):
            seg, c = f0[s:s + per], conf[s:s + per]
            ok = seg[c > 1.6]
            summ.append(f"{s//per}s:{int(np.median(ok)*15) if len(ok) else '-'}rpm/{rms[min(len(rms)-1, int(s*dt*SR))]:.0f}dB")
        print(name, f"{len(x)/SR:.1f}s", " ".join(summ))
