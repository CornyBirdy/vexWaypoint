#!/usr/bin/env python3
"""Waypoint reveal: lo-fi score and sound design (numpy only, no samples).

Slow, warm and sparse: electric-piano chords with a lazy swing, a soft boom-bap beat, kalimba
melody, dusty vinyl, a touch of tape wobble. Chords follow the picture: each shot has its own
harmony, and the end card lands on the home chord (A minor 9).

    python3 promo/audio.py            -> promo/out/score.wav (48 kHz stereo)
"""
import json
import os
import wave

import numpy as np

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
EV = json.load(open(os.path.join(HERE, 'out', 'events.json')))
T = float(EV['total'])
N = int(SR * T)
rng = np.random.default_rng(52111)  # team number: same performance every run
SWING = 0.04                         # every second eighth (0.25 s grid) arrives 40 ms late


# ----------------------------------------------------------------------------- helpers
def tt(n):
    return np.arange(n) / SR


def place(buf, sig, t, gain=1.0, pan=0.0):
    i = int(round(t * SR))
    if i >= N or i + len(sig) <= 0:
        return
    a = max(0, -i)
    b = min(len(sig), N - i)
    ang = (pan + 1) * np.pi / 4
    buf[0, i + a:i + b] += sig[a:b] * gain * np.cos(ang)
    buf[1, i + a:i + b] += sig[a:b] * gain * np.sin(ang)


def fft_filter(x, lo=None, hi=None, order=2):
    n = len(x)
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    m = np.ones_like(f)
    if lo:
        m *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-6)) ** (2 * order))
    if hi:
        m *= 1 / np.sqrt(1 + (f / hi) ** (2 * order))
    return np.fft.irfft(spec * m, n)


def stft_band(x, centers, bw_oct=0.8):
    n = len(x)
    win = np.hanning(2048)
    hop = 512
    pad = np.concatenate([np.zeros(2048), x, np.zeros(2048)])
    out = np.zeros_like(pad)
    freqs = np.fft.rfftfreq(2048, 1 / SR)[1:]
    for s in range(0, len(pad) - 2048, hop):
        fc = centers[min(n - 1, max(0, s + 1024 - 2048))]
        spec = np.fft.rfft(pad[s:s + 2048] * win)
        m = np.zeros(len(spec))
        m[1:] = np.exp(-0.5 * (np.log2(freqs / fc) / bw_oct) ** 2)
        out[s:s + 2048] += np.fft.irfft(spec * m) * win
    return out[2048:2048 + n] / 1.5


def reverb_ir(seconds=2.6, tone=4200.0):
    n = int(SR * seconds)
    t = tt(n)
    ir = []
    for _ in range(2):
        noise = rng.standard_normal(n) * np.exp(-t / (seconds / 5.0))
        noise = fft_filter(noise, lo=180, hi=tone, order=2)
        noise[:int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
        ir.append(noise / np.sqrt(np.sum(noise ** 2)))
    return np.array(ir)


def convolve(sig, ir):
    n = len(sig) + len(ir) - 1
    m = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(sig, m) * np.fft.rfft(ir, m), m)[:len(sig)]


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def jit(ms=9):
    """a human's timing error, seconds"""
    return rng.normal(0, ms / 1000)


def vel(v, spread=0.12):
    return float(np.clip(v * (1 + rng.normal(0, spread)), 0.05, 1.3))


# ----------------------------------------------------------------------------- instruments
def rhodes(freq, dur, v=0.8):
    """FM electric piano: soft bell attack, long warm decay, a little tremolo"""
    rel = 0.45
    n = int((dur + rel) * SR)
    t = tt(n)
    idx = (0.9 + 2.0 * v) * np.exp(-t / 0.28) + 0.25
    car = np.sin(2 * np.pi * freq * t + idx * np.sin(2 * np.pi * freq * t))
    tine = np.sin(2 * np.pi * freq * 7.0 * t) * np.exp(-t / 0.05) * 0.22 * v
    y = (car * np.exp(-t / 2.1) + tine) * (1 + 0.05 * np.sin(2 * np.pi * 4.6 * t + rng.uniform(0, 6)))
    env = np.minimum(1, t / 0.004) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.16))
    return fft_filter(y * env, hi=5200, order=2) * 0.5


def kalimba(freq, dur=1.6, v=0.8):
    n = int(SR * dur)
    t = tt(n)
    y = np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.55)
    y += np.sin(2 * np.pi * freq * 2.0 * t) * 0.22 * np.exp(-t / 0.25)
    y += np.sin(2 * np.pi * freq * 5.4 * t) * 0.10 * np.exp(-t / 0.06)
    y *= np.minimum(1, t / 0.002)
    return y * 0.45 * v


def bass_note(freq, dur, v=0.8):
    n = int(SR * (dur + 0.12))
    t = tt(n)
    y = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2 * t) * np.exp(-t / 0.4)
    env = np.minimum(1, t / 0.02) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.06))
    return np.tanh(1.3 * y) * env * 0.6 * v


def pad_chord(freqs, dur):
    n = int(SR * dur)
    t = tt(n)
    y = np.zeros(n)
    for f in freqs:
        for d in (-0.003, 0.0, 0.003):
            ph = rng.uniform(0, 6.28)
            for k in range(1, 7):
                y += np.sin(2 * np.pi * f * (1 + d) * k * t + ph * k) / (k ** 1.6) * 0.14
    y = fft_filter(y, hi=1400, order=2)
    env = np.minimum(1, t / 1.2) * np.minimum(1, (dur - t) / 1.4)
    return y * env


def kick():
    n = int(SR * 0.5)
    t = tt(n)
    f = 46 + 75 * np.exp(-t / 0.035)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.24)
    y += fft_filter(rng.standard_normal(n), lo=1500, hi=5000) * np.exp(-t / 0.004) * 0.12
    return np.tanh(1.2 * y) * 0.85


def snare():
    n = int(SR * 0.32)
    t = tt(n)
    tone = np.sin(2 * np.pi * 178 * t) * np.exp(-t / 0.06) * 0.45
    noise = fft_filter(rng.standard_normal(n), lo=900, hi=5200, order=2) * np.exp(-t / 0.12)
    return fft_filter(tone + noise * 0.8, hi=6500) * 0.8


def hat(v=0.7, open_=False):
    n = int(SR * (0.2 if open_ else 0.07))
    t = tt(n)
    y = fft_filter(rng.standard_normal(n), lo=6000, hi=11500, order=2) * np.exp(-t / (0.09 if open_ else 0.022))
    return y * 0.55 * v


def thump(dur=0.9, f0=70, f1=38):
    n = int(SR * dur)
    t = tt(n)
    f = f1 + (f0 - f1) * np.exp(-t / 0.12)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.35)


def swell(dur, f0=300, f1=2600):
    n = int(SR * dur)
    x = np.linspace(0, 1, n)
    centers = f0 * (f1 / f0) ** x
    noise = stft_band(rng.standard_normal(n), centers, 0.9)
    noise /= np.max(np.abs(noise)) + 1e-9
    return noise * x ** 2.0


def whoosh(half=0.3):
    n = int(SR * half * 2)
    x = np.linspace(-1, 1, n)
    f = np.where(x < 0, 350 * (3200 / 350) ** ((x + 1) ** 1.2), 3200 * (700 / 3200) ** (np.maximum(x, 0) ** 0.8))
    noise = stft_band(rng.standard_normal(n), f, 0.9)
    noise /= np.max(np.abs(noise)) + 1e-9
    return noise * np.where(x < 0, (x + 1) ** 2.2, (1 - x) ** 1.4)


def tap(freq=1100, dur=0.045):
    n = int(SR * dur)
    t = tt(n)
    y = np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.008)
    y += fft_filter(rng.standard_normal(n), lo=1500, hi=5000) * np.exp(-t / 0.004) * 0.35
    return y * 0.6


# ----------------------------------------------------------------------------- harmony
CH = {  # name: (bass MIDI, voicing, melody notes)
    'Am9': (45, [55, 59, 60, 64], [76, 72, 74, 69]),
    'Dm9': (38, [53, 57, 60, 64], [77, 69, 72, 74]),
    'G13': (43, [53, 59, 62, 64], [71, 74, 76, 79]),
    'Cmaj9': (48, [55, 59, 62, 64], [67, 76, 74, 72]),
    'Fmaj9': (41, [57, 60, 64, 67], [69, 72, 76, 79]),
}
c0, c1, c2, c3, c4, c5, c6 = EV['cuts']  # title, run, draw, tune, explore, grid, end
SEGMENTS = [
    (0.0, c0, 'Am9'), (c0, c1, 'Fmaj9'),
    (c1, c1 + 2.5, 'Dm9'), (c1 + 2.5, c2, 'G13'),
    (c2, c2 + 3.0, 'Cmaj9'), (c2 + 3.0, c3, 'Am9'),
    (c3, c3 + 2.0, 'Fmaj9'), (c3 + 2.0, c4, 'Dm9'),
    (c4, c4 + 2.0, 'G13'), (c4 + 2.0, c5, 'Cmaj9'),
    (c5, c6, 'Fmaj9'),
    (c6, T + 1, 'Am9'),
]

keys = np.zeros((2, N))     # chords
pads = np.zeros((2, N))
bass = np.zeros((2, N))
mel = np.zeros((2, N))
drums = np.zeros((2, N))
fx = np.zeros((2, N))
verb = np.zeros((2, N))


def swung(t_local):
    """map a straight position on the 0.25 s grid to its swung time"""
    k = int(round(t_local / 0.25))
    return t_local + (SWING if k % 2 else 0.0)


for si, (a, b, name) in enumerate(SEGMENTS):
    root, voic, mnotes = CH[name]
    L = min(b, T) - a
    # pad: one soft chord for the whole segment
    pad = pad_chord([midi(n) for n in voic], L + 1.6)
    place(pads, pad, a - 0.2, gain=0.30 if a >= c0 else 0.18)
    # keys: long chord on the downbeat, a soft answer on the swung "and of 3"; repeat every 2 s inside long segments
    t = 0.0
    bar = 0
    while t < L - 0.3:
        hits = [(0.0, 0.9, 1.7, 0), (1.25, 0.55, 0.5, 1)]
        for off, vv, dd, kind in hits:
            tl = t + swung(off) + (SWING if kind else 0)
            if tl >= L - 0.2:
                continue
            for j, n in enumerate(voic):
                # tiny strum, human velocity
                tn = a + tl + 0.012 * j + jit(7)
                if tn >= T:
                    continue
                f = midi(n + (12 if (bar % 2 and j == 3 and kind == 0) else 0))
                sig = rhodes(f, min(dd, L - tl + 0.15), vel(vv, 0.1))
                pan = -0.25 + 0.17 * j
                place(keys, sig, tn, gain=0.55, pan=pan)
                place(verb, sig, tn, gain=0.25)
        t += 2.0
        bar += 1
    # melody (kalimba): a few unhurried notes per segment, none while the screen needs your eyes less
    if a >= c0 and a < c6 - 0.1:
        order = [0, 2, 1, 3, 2, 0]
        times = [0.55, 1.45, 2.2, 3.1, 3.7]
        density = 0.6 if c3 <= a < c4 else 1.0
        for k, tm in enumerate(times):
            if tm >= L - 0.35 or (density < 1 and k % 2):
                continue
            n = mnotes[order[(k + si) % len(order)]]
            tn = a + swung(round(tm / 0.25) * 0.25) + jit(10)
            sig = kalimba(midi(n), 1.8, vel(0.8, 0.12))
            place(mel, sig, tn, gain=0.55, pan=0.25 if k % 2 else -0.25)
            place(verb, sig, tn, gain=0.4)
            place(mel, sig, tn + 0.375, gain=0.18, pan=-0.3 if k % 2 else 0.3)   # soft echo
    # bass: root on the downbeat, a short fifth
    if c1 <= a < c6 + 2:
        t = 0.0
        while t < L - 0.5:
            tb = a + t
            if tb < 28.0:
                place(bass, bass_note(midi(root), 1.5, vel(0.8)), tb + jit(6))
                if t + 1.29 < L - 0.3:
                    place(bass, bass_note(midi(root + 7), 0.4, vel(0.55)), tb + 1.29 + jit(6))
            t += 2.0

# end card: resolve slowly, ring out
for i, (n, tm) in enumerate(((57, 0.15), (64, 0.9), (69, 1.65), (76, 2.4))):
    sig = kalimba(midi(n), 2.6, 0.9)
    place(mel, sig, c6 + tm, gain=0.55, pan=-0.3 + i * 0.2)
    place(verb, sig, c6 + tm, gain=0.5)
for j, n in enumerate((45, 57, 60, 64, 67, 71)):
    sig = rhodes(midi(n), 3.4, 0.95)
    place(keys, sig, c6 + 0.02 + 0.03 * j, gain=0.55, pan=-0.35 + 0.14 * j)
    place(verb, sig, c6 + 0.02 + 0.03 * j, gain=0.35)

# ----------------------------------------------------------------------------- beat
kk, sn = kick(), snare()
BAR = 2.0
b = c1
while b < 28.0:
    for off, v in ((0.0, 0.95), (0.79, 0.55), (1.54, 0.65)):
        if b + off < 28.0 and not (b >= c6 and off > 0):
            place(drums, kk, b + off + jit(8), gain=0.40 * vel(v), pan=0.0)
    if b + 1.0 < 28.0 and b < c6:
        place(drums, sn, b + 1.0 + jit(10) + 0.01, gain=0.46 * vel(0.9), pan=0.05)
        place(verb, sn, b + 1.0, gain=0.15)
    b += BAR
# hats: eighths with swing, soft/softer; start with the title, drop at the end card
tt_ = c0
while tt_ < 28.0:
    k = int(round((tt_ - c0) / 0.25))
    if not (tt_ >= c6 and k % 2 == 0):
        v = 0.7 if k % 4 == 0 else (0.45 if k % 2 == 0 else 0.32)
        sw = SWING if k % 2 else 0.0
        place(drums, hat(vel(v, 0.15), open_=(k % 8 == 7 and tt_ >= c1)), tt_ + sw + jit(6), gain=0.75 * (0.7 if tt_ < c1 else 1.0), pan=0.3)
    tt_ += 0.25

# ----------------------------------------------------------------------------- moments in the picture
place(fx, swell(0.3, 250, 1800), 0.0, gain=0.5)
place(fx, thump(1.4, 62, 36), 0.3, gain=0.55)
for tm, n, pn in ((1.45, 88, -0.3), (1.6, 91, 0.0), (1.78, 95, 0.3)):  # the "52111A" glint
    sig = kalimba(midi(n), 1.6, 0.7)
    place(mel, sig, tm, gain=0.5, pan=pn)
    place(verb, sig, tm, gain=0.5)
for i, c in enumerate(EV['cuts']):
    place(fx, whoosh(0.3), c - 0.3, gain=0.20 if c < c6 else 0.26)
    place(fx, thump(0.9, 64, 38), c, gain=0.34 if c in (c0, c1) else (0.5 if c == c6 else 0.22))
# waypoint nodes (title), grid tiles, UI taps
for tm, n, pn in ((c0 + 0.55, 81, -0.5), (c0 + 0.9, 84, -0.15), (c0 + 1.25, 88, 0.2), (c0 + 1.6, 93, 0.5)):
    sig = kalimba(midi(n), 1.4, 0.6)
    place(mel, sig, tm, gain=0.45, pan=pn)
    place(verb, sig, tm, gain=0.5)
for i, n in enumerate((81, 84, 86, 88, 91, 93)):
    tm = c5 + 0.3 + i * 0.07
    sig = kalimba(midi(n), 1.6, 0.7)
    place(mel, sig, tm, gain=0.5, pan=-0.7 + i * 0.28)
    place(verb, sig, tm, gain=0.45)
for c in EV['clicks']:
    place(fx, tap(1100 if c['real'] else 900), c['t'], gain=0.20 if c['real'] else 0.12, pan=0.15)
place(fx, whoosh(0.15), c1 + 1.0, gain=0.10, pan=0.2)   # the paste
for t0, t1, up in ((c3 + 0.6, c3 + 1.1, False), (c3 + 2.0, c3 + 2.5, True)):
    for j in range(9):
        x = j / 8
        f = (700 + 900 * x) if up else (1600 - 900 * x)
        place(fx, tap(f, 0.04), t0 + (t1 - t0) * x, gain=0.07, pan=0.3)
place(mel, kalimba(midi(64), 1.4, 0.6), c3 + 1.45, gain=0.35, pan=0.2)   # "over the limit": a soft low note
place(mel, kalimba(midi(88), 1.6, 0.8), c3 + 2.95, gain=0.5, pan=0.2)    # "9.6 s spare": a bright one
place(verb, kalimba(midi(88), 1.6, 0.8), c3 + 2.95, gain=0.4)

# ----------------------------------------------------------------------------- vinyl + tape
def vinyl():
    imp = np.zeros(N)
    count = int(T * 16)
    idx = rng.choice(N, size=count, replace=False)
    imp[idx] = rng.exponential(0.45, count) * rng.choice([-1, 1], count)
    kern = rng.standard_normal(160) * np.exp(-np.arange(160) / 28.0)
    crackle = np.convolve(imp, kern, mode='same')
    hiss = fft_filter(rng.standard_normal(N), lo=800, hi=6500, order=2) * 0.010
    out = crackle * 0.05 + hiss
    return np.array([out, np.roll(out, 211)])


def wobble(x):
    t = tt(N)
    d = 0.0007 * np.sin(2 * np.pi * 0.5 * t) + 0.00035 * np.sin(2 * np.pi * 2.9 * t + 1.0)
    pos = (t + d) * SR
    base = np.arange(N)
    return np.array([np.interp(pos, base, x[0]), np.interp(pos, base, x[1])])


# ----------------------------------------------------------------------------- mix
rev = reverb_ir()
wet = np.array([convolve(verb[0], rev[0]), convolve(verb[1], rev[1])])

music = wobble(keys * 1.0 + pads * 0.8 + mel * 1.35 + bass * 0.7)
mix = music + drums * 1.0 + fx * 0.8 + wet * 0.55 + vinyl()
# cassette: roll off the top, glue with a little saturation
mix = np.array([fft_filter(mix[0], lo=34, hi=11000, order=2), fft_filter(mix[1], lo=34, hi=11000, order=2)])
peak = np.max(np.abs(mix))
mix = np.tanh(mix / peak * 1.5) / np.tanh(1.5)
t = tt(N)
mix *= np.clip(t / 0.6, 0, 1) ** 1.5                  # open gently
mix *= np.clip((T - t) / 1.6, 0, 1) ** 1.5            # and close gently
mix *= 0.8

out = os.path.join(HERE, 'out', 'score.wav')
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', out, '%.1fs' % (N / SR), 'peak %.3f' % np.max(np.abs(mix)))
