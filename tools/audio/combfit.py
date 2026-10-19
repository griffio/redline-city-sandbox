"""Estimate harmonic comb spacing b (Hz) per window → rpm = 120*b for a V8 (b = half engine order).
usage: combfit.py file t1 t2 ... [--win 0.4] [--lo 5 --hi 70]"""
import sys, numpy as np
sys.path.insert(0, __import__('os').path.dirname(__file__))
from analyze import load, SR
def fit(seg, lo, hi):
    n = 1 << 16
    sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n)); df = SR / n
    ls = np.log1p(sp / sp[int(40/df):int(1500/df)].max() * 300)
    bs = np.arange(lo, hi, 0.05)
    score = np.zeros_like(bs)
    for i, b in enumerate(bs):
        hs = np.arange(2, int(1400 / b) + 1)
        hs = hs[hs * b > 45]
        on = ls[np.round(hs * b / df).astype(int)].mean()
        off = ls[np.round((hs + 0.5) * b / df).astype(int)].mean()
        score[i] = on - off      # comb contrast: peaks on the teeth, valleys between
    j = int(np.argmax(score))
    return bs[j], score[j]
if __name__ == "__main__":
    args = sys.argv[1:]
    opt = {"--win": 0.4, "--lo": 5.0, "--hi": 70.0}
    for k in list(opt):
        if k in args: i = args.index(k); opt[k] = float(args[i+1]); del args[i:i+2]
    x = load(args[0])
    def fit_at(t, w=opt["--win"]):
        return fit(x[int((t - w/2)*SR):int((t + w/2)*SR)], opt["--lo"], opt["--hi"])
    for t in map(float, args[1:]):
        b, s = fit_at(t)
        print(f"t={t:6.2f}  b={b:5.2f} Hz  rpm≈{b*120:5.0f}  contrast={s:.2f}")
