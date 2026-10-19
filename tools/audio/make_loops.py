"""Cut pitch-flattened, cycle-aligned, seamless engine loops from real recordings.
usage: make_loops.py spec.json OUT_DIR  (spec: list of {src, t0, t1, name, kind, rpm?, len?})"""
import sys, os, json, subprocess, wave
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from combfit import fit  # noqa: E402  (fit(seg, lo, hi) at analyze.SR)
import analyze

OUT_SR = 32000

def load(path, sr):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float64) / 32768

def highpass(x, sr, fc=28):
    # one-pole high-pass, run forward+backward for zero phase
    a = np.exp(-2 * np.pi * fc / sr)
    def hp(v):
        y = np.empty_like(v); prev_x = prev_y = 0.0
        for i, s in enumerate(v):
            prev_y = a * (prev_y + s - prev_x); prev_x = s; y[i] = prev_y
        return y
    return hp(hp(x)[::-1])[::-1]

def write_wav(path, x, sr):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())

def make(spec, out_dir, cache={}):
    src = spec["src"]
    if src not in cache: cache[src] = (load(src, analyze.SR), load(src, OUT_SR))
    x22, x = cache[src]
    t0, t1 = spec["t0"], spec["t1"]
    track = spec.get("track", True)
    if track:
        ts = np.arange(t0 + 0.2, t1 - 0.2 + 1e-9, 0.05)
        bs = np.array([fit(x22[int((t - 0.2) * analyze.SR):int((t + 0.2) * analyze.SR)], spec.get("lo", 20), spec.get("hi", 70))[0] for t in ts])
        med = np.median(bs)
        ok = np.abs(bs / med - 1) < 0.08                    # drop octave errors
        p = np.polyfit(ts[ok], bs[ok], 1)                     # b(t) ≈ linear across a short window
        bfun = lambda t: np.polyval(p, t)
        bstar = float(bfun((t0 + t1) / 2))
        # time-warp so pitch is constant: read input at rate b*/b(τ)
        n_out = int((t1 - t0) * OUT_SR * 0.97)
        tau = np.empty(n_out); tt = t0
        for i in range(n_out):
            tau[i] = tt; tt += (bstar / bfun(tt)) / OUT_SR
        y = np.interp(tau * OUT_SR, np.arange(len(x)), x)
        rpm = bstar * 120
        drift = (bfun(t1) / bfun(t0) - 1) * 100
    else:
        y = x[int(t0 * OUT_SR):int(t1 * OUT_SR)].copy()
        bstar = spec.get("rpm", 1) / 120; rpm = spec.get("rpm", 0); drift = 0.0; ok = np.array([True])
    y = highpass(y, OUT_SR, spec.get("hp", 28))
    if spec["kind"] == "oneshot":
        fi, fo = int(0.015 * OUT_SR), int(spec.get("fadeOut", 0.4) * OUT_SR)
        y[:fi] *= np.linspace(0, 1, fi); y[-fo:] *= np.linspace(1, 0, fo) ** 2
        y *= 10 ** (spec.get("db", -14) / 20) / max(np.sqrt(np.mean(y ** 2)), 1e-6)
        y *= min(1, 0.98 / np.abs(y).max())
        write_wav(os.path.join(out_dir, spec["name"] + ".wav"), y, OUT_SR)
        return {"file": spec["name"] + ".wav", "kind": "oneshot", "len": round(len(y) / OUT_SR, 3)}
    # loop length = whole number of engine cycles (one cycle = 2 revs = 1/b seconds)
    xf = int(spec.get("xfade", 0.06) * OUT_SR)
    want = len(y) - xf
    cyc = OUT_SR / bstar
    L = int(round(int(want / cyc) * cyc)) if track else want
    w = np.sin(np.linspace(0, np.pi / 2, xf)) ** 2
    loop = y[:L].copy()
    loop[:xf] = y[:xf] * np.sqrt(w) + y[L:L + xf] * np.sqrt(1 - w)   # equal-power
    rms = np.sqrt(np.mean(loop ** 2))
    loop *= 10 ** (spec.get("db", -16) / 20) / max(rms, 1e-6)
    peak = np.abs(loop).max()
    if peak > 0.98: loop *= 0.98 / peak
    name = spec["name"]
    write_wav(os.path.join(out_dir, name + ".wav"), loop, OUT_SR)
    if not track:
        return {"file": name + ".wav", "kind": spec["kind"], "rpm": spec.get("rpm"), "len": round(L / OUT_SR, 3)}
    return {"file": name + ".wav", "rpm": round(spec.get("rpm", rpm)), "kind": spec["kind"], "len": round(L / OUT_SR, 3),
            "measuredRpm": round(rpm), "drift%": round(drift, 1), "trackedFrac": round(float(ok.mean()), 2)}

if __name__ == "__main__":
    specs = json.load(open(sys.argv[1])); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
    base = os.path.dirname(os.path.abspath(sys.argv[1]))
    for s in specs:
        s["src"] = os.path.join(base, s["src"])   # spec paths are relative to the spec file
        if not os.path.exists(s["src"]):
            sys.exit(f"missing source {s['src']} (download the Freesound preview listed in assets/audio/CREDITS.md)")
    man = [make(s, out) for s in specs]
    for m in man: print(m)
    json.dump(man, open(os.path.join(out, "manifest.json"), "w"), indent=1)
