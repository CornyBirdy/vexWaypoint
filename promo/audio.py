#!/usr/bin/env python3
"""Waypoint reveal: score and sound design (numpy only, no samples).

96 BPM, A minor / F major colours. Electronic but played rather than looped:
  - plucked-string arps (Karplus-Strong) whose pattern changes every bar, with rests and accents
  - a phrased lead melody with vibrato that answers itself between chords
  - warm pads whose filter drifts, a bass that varies its rhythm, a soft syncopated beat with fills
  - human timing and velocity, tape-ish saturation, a real-sounding room instead of one flat reverb
Chords follow the picture: every shot has its own harmony and the end card lands on A minor 9.

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
BPM = 96.0
B = 60.0 / BPM                 # one beat = 0.625 s
EIGHTH = B / 2
SWING = 0.022                  # every second eighth lands a touch late
rng = np.random.default_rng(52111)  # team number: the same performance every run


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


def room_ir(seconds=2.8, tone=5200.0, predelay=0.018):
    """a stereo room: a few early reflections, then a dense tail that darkens as it decays"""
    n = int(SR * seconds)
    t = tt(n)
    ir = []
    for ch in range(2):
        tail = rng.standard_normal(n) * np.exp(-t / (seconds / 5.2))
        dark = fft_filter(tail, lo=160, hi=tone, order=2) * 0.7 + fft_filter(tail, lo=160, hi=1500, order=2) * (t / seconds) * 0.6
        early = np.zeros(n)
        for d, g in ((0.011, 0.5), (0.019, 0.38), (0.027, 0.3), (0.041, 0.22), (0.058, 0.15)):
            early[int((d + 0.004 * ch) * SR)] += g * (1 if rng.random() > 0.3 else -1)
        sig = dark + early * 0.35
        sig[:int(predelay * SR)] = 0
        sig = np.roll(sig, int(predelay * SR))
        sig[:int(0.006 * SR)] *= np.linspace(0, 1, int(0.006 * SR))
        ir.append(sig / np.sqrt(np.sum(sig ** 2)))
    return np.array(ir)


def convolve(sig, ir):
    n = len(sig) + len(ir) - 1
    m = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(sig, m) * np.fft.rfft(ir, m), m)[:len(sig)]


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def cents(c):
    return 2 ** (c / 1200.0)


def jit(ms):
    return rng.normal(0, ms / 1000)


def vel(v, spread=0.1):
    return float(np.clip(v * (1 + rng.normal(0, spread)), 0.08, 1.25))


def swung(k):
    """time of eighth-note number k (0 = bar start), light swing"""
    return k * EIGHTH + (SWING if k % 2 else 0.0)


# ----------------------------------------------------------------------------- instruments
def ks_pluck(freq, dur, v=0.8, tau=0.45, bright=0.6):
    """Karplus-Strong string: a noise burst circulating in a delay line. Sounds played, not generated."""
    L = max(8, int(round(SR / freq)))
    f_act = SR / L
    n_out = int(dur * SR)
    n_src = int(n_out * freq / f_act) + 3 * L
    y = np.zeros(n_src + L)
    exc = rng.uniform(-1, 1, L)
    if bright < 0.9:  # a softer pick
        k = 3 if bright > 0.4 else 5
        exc = np.convolve(np.concatenate([exc[-k:], exc, exc[:k]]), np.ones(k) / k, mode='same')[k:-k]
    y[:L] = exc * v
    damp = np.exp(-1.0 / (tau * f_act))
    k = 1
    while k * L < n_src:
        prev = y[(k - 1) * L:k * L]
        last = y[(k - 1) * L - 1] if k > 1 else 0.0
        y[k * L:(k + 1) * L] = damp * 0.5 * (prev + np.concatenate([[last], prev[:-1]]))
        k += 1
    pos = np.arange(n_out) * (freq / f_act)
    out = np.interp(pos, np.arange(len(y)), y)
    env = np.minimum(1, np.arange(n_out) / (0.0012 * SR)) * np.minimum(1, (n_out - np.arange(n_out)) / (0.05 * SR))
    return out * env * 0.9


def lead(freq, dur, v=0.8):
    """a soft analogue lead: two slightly detuned voices, vibrato that arrives late, a filter that closes"""
    rel = 0.45
    n = int((dur + rel) * SR)
    t = tt(n)
    vib = 0.0042 * np.clip((t - 0.2) / 0.45, 0, 1) * np.sin(2 * np.pi * (5.1 + rng.normal(0, 0.15)) * t + rng.uniform(0, 6))
    out = np.zeros(n)
    for d in (-0.0035, 0.0035):
        ph = 2 * np.pi * np.cumsum(freq * (1 + d) * cents(rng.normal(0, 3)) * (1 + vib)) / SR
        for k in range(1, 6):
            out += np.sin(k * ph) / k ** 1.4
    env = np.minimum(1, t / 0.035) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.2)) * (0.8 + 0.2 * np.exp(-t / 0.6))
    return fft_filter(out * env, hi=2300 + 1400 * v, order=2) * 0.42 * v


def pad_chord(freqs, dur):
    n = int(SR * dur)
    t = tt(n)
    y = np.zeros(n)
    for f in freqs:
        for d in (-0.0042, 0.0, 0.0042):
            ph = rng.uniform(0, 6.28)
            for k in range(1, 8):
                y += np.sin(2 * np.pi * f * (1 + d) * cents(rng.normal(0, 2)) * k * t + ph * k) / k ** 1.25 * 0.11
    dark = fft_filter(y, hi=900, order=2)
    open_ = fft_filter(y, hi=2600, order=2)
    m = 0.5 + 0.5 * np.sin(2 * np.pi * 0.13 * t + rng.uniform(0, 6))   # the filter breathes
    env = np.minimum(1, t / 1.4) * np.minimum(1, (dur - t) / 1.6)
    return (dark * (1 - m) + open_ * m) * env


def bass_note(freq, dur, v=0.8):
    n = int((dur + 0.1) * SR)
    t = tt(n)
    saw = sum(np.sin(2 * np.pi * freq * k * t) / k for k in range(1, 7)) * 0.35
    y = np.sin(2 * np.pi * freq * t) * 0.9 + fft_filter(saw, hi=500 + 900 * np.exp(-t.mean() / 1.0), order=2) * np.exp(-t / 0.5) * 0.6
    env = np.minimum(1, t / 0.012) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.07))
    return np.tanh(1.4 * y) * env * 0.62 * v


def kick(v=1.0):
    n = int(SR * 0.55)
    t = tt(n)
    f = 52 + 95 * np.exp(-t / 0.03)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.2)
    y += fft_filter(rng.standard_normal(n), lo=1800, hi=6000) * np.exp(-t / 0.005) * 0.16
    return np.tanh(1.3 * y) * 0.9 * v


def snare(v=1.0):
    n = int(SR * 0.4)
    t = tt(n)
    tone = np.sin(2 * np.pi * (185 - 25 * np.exp(-t / 0.02)) * t) * np.exp(-t / 0.07) * 0.5
    noise = fft_filter(rng.standard_normal(n), lo=1000, hi=7500, order=2) * np.exp(-t / 0.13)
    return (tone + noise * 0.85) * 0.75 * v


def clap(v=1.0):
    n = int(SR * 0.4)
    t = tt(n)
    noise = fft_filter(rng.standard_normal(n), lo=900, hi=6500, order=2)
    env = np.zeros(n)
    for off, g in ((0.0, 0.6), (0.012, 0.7), (0.024, 0.8)):
        env += np.exp(-np.maximum(t - off, 0) / 0.005) * (t >= off) * g
    env += np.exp(-np.maximum(t - 0.03, 0) / 0.09) * (t >= 0.03) * 0.7
    return noise * env * 0.5 * v


def hat(v=0.7, open_=False):
    n = int(SR * (0.28 if open_ else 0.08))
    t = tt(n)
    y = fft_filter(rng.standard_normal(n), lo=6500, hi=13000, order=2) * np.exp(-t / (0.11 if open_ else 0.02))
    return y * 0.5 * v


def shaker(v=0.5):
    n = int(SR * 0.09)
    t = tt(n)
    env = np.minimum(1, t / 0.012) * np.exp(-t / 0.03)
    return fft_filter(rng.standard_normal(n), lo=4500, hi=11000, order=2) * env * 0.4 * v


def impact(dur=3.0, v=1.0):
    n = int(SR * dur)
    t = tt(n)
    f = 30 + 48 * np.exp(-t / 0.3)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.75) * 0.7
    body = fft_filter(rng.standard_normal(n), hi=420, order=2) * np.exp(-t / 0.2) * 0.7
    air = fft_filter(rng.standard_normal(n), lo=2200, hi=11000, order=2) * np.exp(-t / 0.5) * 0.5
    return np.tanh(1.2 * (boom + body + air)) * 0.9 * v


def swell(dur, f0=300, f1=7000, bw=0.9):
    n = int(SR * dur)
    x = np.linspace(0, 1, n)
    centers = f0 * (f1 / f0) ** (x ** 1.5)
    noise = stft_band(rng.standard_normal(n), centers, bw)
    noise /= np.max(np.abs(noise)) + 1e-9
    return noise * x ** 2.2


def whoosh(half=0.4):
    n = int(SR * half * 2)
    x = np.linspace(-1, 1, n)
    f = np.where(x < 0, 380 * (4200 / 380) ** ((x + 1) ** 1.2), 4200 * (800 / 4200) ** (np.maximum(x, 0) ** 0.8))
    noise = stft_band(rng.standard_normal(n), f, 0.9)
    noise /= np.max(np.abs(noise)) + 1e-9
    return noise * np.where(x < 0, (x + 1) ** 2.2, (1 - x) ** 1.4)


def bell(freq, dur=1.8, v=0.7):
    n = int(SR * dur)
    t = tt(n)
    y = np.zeros(n)
    for ratio, amp, dec in ((1, 1.0, 1.0), (2.76, 0.35, 0.5), (5.4, 0.18, 0.28), (8.93, 0.08, 0.14)):
        y += np.sin(2 * np.pi * freq * ratio * t) * amp * np.exp(-t / dec)
    return y * 0.4 * v * np.minimum(1, t / 0.002)


def tap(freq=1200, dur=0.05):
    n = int(SR * dur)
    t = tt(n)
    y = np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.007)
    y += fft_filter(rng.standard_normal(n), lo=1800, hi=6000) * np.exp(-t / 0.004) * 0.3
    return y * 0.6


# ----------------------------------------------------------------------------- harmony and melody
# name: (bass note, pad voicing, seven arp tones low->high, lead phrase [(beat, midi, beats, velocity)])
CH = {
    'Am9': (45, [57, 60, 64, 67, 71], [57, 60, 64, 67, 69, 71, 72],
            [(0, 76, 1.5, .8), (2, 72, 1.0, .6), (3, 74, .5, .5), (3.5, 76, 2.5, .78), (6.5, 72, 1.0, .55)]),
    'Fmaj9': (41, [53, 57, 60, 64, 67], [53, 57, 60, 64, 65, 67, 69],
              [(.5, 72, 1.0, .62), (1.5, 69, 1.0, .5), (3, 76, 2.0, .78), (5.5, 74, .5, .5), (6, 72, 1.5, .62)]),
    'Cmaj9': (36, [52, 55, 59, 62, 67], [55, 59, 62, 64, 67, 71, 74],
              [(0, 79, 1.5, .78), (2, 76, 1.0, .6), (3.5, 74, .5, .5), (4, 72, 2.0, .68), (6.5, 74, 1.0, .5)]),
    'G69': (43, [50, 55, 59, 62, 64], [55, 59, 62, 64, 67, 71, 74],
            [(0, 74, 1.0, .62), (1, 71, 1.0, .55), (2.5, 79, 2.0, .78), (5, 76, 1.5, .62)]),
    'Dm9': (38, [53, 57, 60, 64, 69], [57, 60, 62, 64, 65, 69, 72],
            [(0, 77, 1.5, .78), (2, 74, .5, .55), (2.5, 72, .5, .5), (3, 69, 2.0, .68), (6, 72, 1.5, .55)]),
}
c0, c1, c2, c3, c4, c5, c6 = EV['cuts']      # title, run, draw, tune, explore, grid, end
SEGMENTS = [
    (0.0, c0, 'Am9'), (c0, c1, 'Fmaj9'),
    (c1, c1 + 8 * B, 'Am9'), (c1 + 8 * B, c2, 'Fmaj9'),
    (c2, c2 + 8 * B, 'Cmaj9'), (c2 + 8 * B, c3, 'G69'),
    (c3, c4, 'Dm9'),
    (c4, c4 + 4.5 * B, 'Fmaj9'), (c4 + 4.5 * B, c5, 'G69'),
    (c5, c6, 'Fmaj9'),
    (c6, T + 1, 'Am9'),
]
ARP_PATTERNS = [
    [0, 2, 4, 2, 5, 4, 2, 1],
    [0, 4, 2, 5, 4, 2, 6, 4],
    [0, 2, 3, 5, 3, 2, 4, 1],
    [0, 3, 4, 6, 4, 3, 2, 1],
    [1, 4, 2, 5, 3, 6, 4, 2],
]
BASS_PATTERNS = [   # (beat, semitones above root, beats, velocity)
    [(0, 0, 1.4, .9), (1.5, 0, .45, .55), (2.5, 7, .45, .6), (3.25, 12, .5, .5)],
    [(0, 0, 1.9, .9), (2, 0, .7, .65), (2.75, 7, .45, .55), (3.5, 0, .4, .5)],
    [(0, 0, 1.2, .9), (1.5, 7, .45, .55), (2, 0, .9, .7), (3.5, 12, .4, .5)],
]

keys = np.zeros((2, N))   # arps
pads = np.zeros((2, N))
leadb = np.zeros((2, N))
bass = np.zeros((2, N))
drums = np.zeros((2, N))
fx = np.zeros((2, N))
verb = np.zeros((2, N))
kick_times = []

BEAT_ON = c0                 # the groove starts with the title
GROOVE = c1                  # full band from the run
END_DRUMS = c6 + 2 * 4 * B   # two bars of band on the end card, then it rings out


def seg_of(t):
    for a, b, name in SEGMENTS:
        if a <= t < b:
            return a, b, name
    return SEGMENTS[-1]


# ---------- pads, bass, lead melody
for si, (a, b, name) in enumerate(SEGMENTS):
    root, voic, arp_tones, phrase = CH[name]
    L = min(b, T) - a
    pad = pad_chord([midi(n) for n in voic], L + 2.0)
    place(pads, pad, a - 0.25, gain=0.34 if a >= c0 else 0.22, pan=0.0)
    # lead: from the run on; sparser while the screen is busy (tune)
    if c1 <= a < c6 - 0.1:
        thin = c3 <= a < c4
        for k, (bt, n, dur_b, vv) in enumerate(phrase):
            tl = bt * B
            if tl >= L - 0.5 or (thin and k % 2):
                continue
            tn = a + tl + jit(12)
            dd = min(dur_b * B, L - tl + 0.2)
            sig = lead(midi(n), dd, vel(vv, 0.08))
            pan = 0.18 if k % 2 else -0.18
            place(leadb, sig, tn, gain=0.85, pan=pan)
            place(verb, sig, tn, gain=0.35)
            place(leadb, sig, tn + 0.75 * B, gain=0.2, pan=-pan)  # dotted-eighth echo
    # bass
    if c1 <= a < c6 + 1.0:
        bar = 0
        t = 0.0
        while t < L - 0.4:
            tb = a + t
            if tb >= END_DRUMS:
                break
            pat = BASS_PATTERNS[(si + bar) % len(BASS_PATTERNS)]
            if tb >= c6:
                pat = pat[:1]   # the end card: just the root
            for bt, semi, dur_b, vv in pat:
                tn = tb + bt * B + jit(6)
                if tn >= min(a + L - 0.15, T - 0.5) or tn >= END_DRUMS:
                    continue
                place(bass, bass_note(midi(root + semi), dur_b * B, vel(vv, 0.1)), tn, gain=0.62)
            t += 4 * B
            bar += 1

# ---------- arpeggios: a different shape every bar, with rests, accents and a little push and pull
bar_idx = 0
t0 = c0
while t0 < T - 0.5:
    a, b, name = seg_of(t0)
    root, voic, arp_tones, phrase = CH[name]
    pat = ARP_PATTERNS[(bar_idx * 3 + (1 if name in ('Fmaj9', 'G69') else 0)) % len(ARP_PATTERNS)]
    for k in range(8):
        tn = t0 + swung(k) + jit(7)
        if tn >= T - 0.3 or tn >= b:
            continue
        thin = c3 <= tn < c4
        if tn < c1:
            lvl = 0.55
        elif tn >= c6 + 4 * B:
            lvl = max(0.0, 1 - (tn - (c6 + 4 * B)) / 4.0)
        else:
            lvl = 0.9
        if thin and k % 2:
            continue
        if k in (1, 5) and rng.random() < 0.22:   # rests
            continue
        idx = pat[k] + (1 if (rng.random() < 0.12 and k not in (0, 4)) else 0)   # the odd passing tone
        n = arp_tones[min(idx, len(arp_tones) - 1)]
        octave = 12 if (tn >= c5 and k % 4 == 3) else 0
        accent = 1.0 if k in (0, 4) else (0.78 if k in (2, 6) else 0.58)
        v = vel(accent * lvl, 0.12)
        sig = ks_pluck(midi(n + octave), 0.9, v * 0.9, tau=0.5, bright=0.55)
        pan = rng.uniform(-0.45, 0.45)
        place(keys, sig, tn, gain=1.15, pan=pan)
        place(verb, sig, tn, gain=0.4)
        place(keys, sig, tn + 0.75 * B, gain=0.36, pan=-pan)   # ping-pong echo, three-quarter beat
    t0 += 4 * B
    bar_idx += 1

# ---------- drums: syncopated and soft, with fills at the end of every fourth bar
kk, sn, cl = kick(), snare(), clap()


def drum_bar(b0, full, bar_no, last_of_phrase):
    # kick: 1, the "and" of 2 and 3 (+ an occasional pick-up)
    ks = [(0.0, 1.0), (1.5, 0.62), (2.5, 0.78)]
    if bar_no % 2 == 1:
        ks.append((3.5, 0.5))
    for bt, vv in ks:
        tn = b0 + bt * B + jit(5)
        place(drums, kk, tn, gain=0.46 * vel(vv, 0.07), pan=0.0)
        kick_times.append(tn)
    # backbeat on 2 and 4: snare with a clap layered, slightly behind the beat
    for bt in (1, 3):
        if bt == 3 and last_of_phrase:
            continue
        tn = b0 + bt * B + 0.008 + jit(8)
        place(drums, sn, tn, gain=0.4 * vel(0.95, 0.1), pan=0.04)
        place(drums, cl, tn + 0.004, gain=0.7 * vel(0.8, 0.12), pan=-0.05)
        place(verb, sn, tn, gain=0.22)
    # hats on eighths, a ghost sixteenth now and then; open hat on the last "and"
    for k in range(8):
        v0 = 0.75 if k % 2 == 0 else 0.45
        tn = b0 + swung(k) + jit(6)
        place(drums, hat(vel(v0, 0.16), open_=(k == 7 and bar_no % 2 == 1)), tn, gain=0.85, pan=0.28)
        if k % 2 == 1 and rng.random() < 0.4 and full:
            place(drums, shaker(vel(0.5, 0.2)), tn + EIGHTH / 2, gain=0.5, pan=-0.3)
    if last_of_phrase:   # snare roll into the next phrase
        for j in range(8):
            x = j / 8
            place(drums, sn, b0 + 3 * B + j * (B / 8) + jit(3), gain=0.3 * (0.4 + 0.9 * x) * vel(1, 0.08), pan=0.0)


bar_no = 0
b0 = c0
while b0 < END_DRUMS:
    if b0 >= c1:
        phrase_end = (bar_no + 1) % 4 == 0
        drum_bar(b0, True, bar_no, phrase_end)
    else:
        # title: a soft heartbeat and hats only
        for bt in (0.0, 2.0):
            place(drums, kk, b0 + bt * B + jit(5), gain=0.32, pan=0.0)
            kick_times.append(b0 + bt * B)
        for k in range(8):
            place(drums, hat(vel(0.5 if k % 2 == 0 else 0.3, 0.15)), b0 + swung(k) + jit(6), gain=0.4, pan=0.28)
    b0 += 4 * B
    bar_no += 1

# ----------------------------------------------------------------------------- moments in the picture
# logo: breath, a deep soft hit as the wipe slices in (0.4 s), glints when "52111A" appears
place(fx, swell(0.4, 250, 2400), 0.0, gain=0.5)
place(fx, impact(2.6, 0.55), 0.4, gain=0.5)
for tm, n, pn in ((1.55, 88, -0.35), (1.72, 91, 0.0), (1.9, 95, 0.35)):
    sig = bell(midi(n), 1.8, 0.6)
    place(fx, sig, tm, gain=0.35, pan=pn)
    place(verb, sig, tm, gain=0.5)
place(fx, swell(1.4, 600, 9000, 1.1), 2.3, gain=0.18)
# every wipe: a breath of air and a soft low thump
for i, c in enumerate(EV['cuts']):
    big = c in (c0, c1, c6)
    place(fx, whoosh(0.4), c - 0.4, gain=0.34 if big else 0.26, pan=0.0)
    place(fx, impact(2.0 if big else 1.4, 0.8 if big else 0.4), c, gain=0.34)
    if c in (c2, c3, c4, c5, c6):
        place(fx, swell(1.6, 400, 8000), c - 1.6, gain=0.4)
place(fx, impact(3.4, 1.0), c6, gain=0.5)
# title: the waypoint nodes ping as the robot passes
for tm, n, pn in ((c0 + 0.8, 81, -0.5), (c0 + 1.6, 84, -0.15), (c0 + 2.05, 88, 0.2), (c0 + 2.6, 93, 0.5)):
    sig = bell(midi(n), 1.5, 0.55)
    place(fx, sig, tm, gain=0.3, pan=pn)
    place(verb, sig, tm, gain=0.45)
# grid: tiles pop in as an ascending A minor pentatonic run
for i, n in enumerate((81, 84, 86, 88, 91, 93)):
    tm = c5 + 0.45 + i * 0.12
    sig = bell(midi(n), 1.7, 0.7)
    place(fx, sig, tm, gain=0.32, pan=-0.7 + i * 0.28)
    place(verb, sig, tm, gain=0.45)
# end card: the answer to everything, slowly
for j, n in enumerate((45, 57, 60, 64, 67, 71)):
    sig = ks_pluck(midi(n), 3.6, 0.9, tau=1.6, bright=0.5)
    place(keys, sig, c6 + 0.03 * j, gain=0.8, pan=-0.35 + 0.14 * j)
    place(verb, sig, c6 + 0.03 * j, gain=0.4)
for i, (n, tm) in enumerate(((76, 0.5), (72, 1.4), (69, 2.3), (64, 3.3))):
    sig = lead(midi(n), 1.6, 0.8)
    place(leadb, sig, c6 + tm, gain=0.6, pan=-0.2 + 0.13 * i)
    place(verb, sig, c6 + tm, gain=0.4)
# UI: soft key taps, a whoosh for the paste, a falling then rising blip run while the RPM changes
for c in EV['clicks']:
    place(fx, tap(1200 if c['real'] else 950), c['t'], gain=0.17 if c['real'] else 0.1, pan=0.15)
place(fx, whoosh(0.18), c1 + 1.9, gain=0.12, pan=0.2)
for t_a, t_b, up in ((c3 + 0.9, c3 + 1.8, False), (c3 + 3.1, c3 + 4.0, True)):
    for j in range(11):
        x = j / 10
        f = (700 + 900 * x) if up else (1600 - 900 * x)
        place(fx, tap(f, 0.04), t_a + (t_b - t_a) * x, gain=0.06, pan=0.3)
sig = bell(midi(64), 1.4, 0.5)
place(fx, sig, c3 + 2.0, gain=0.22, pan=0.2)       # over the limit: low and a little sour
place(fx, bell(midi(88), 1.8, 0.8), c3 + 4.2, gain=0.3, pan=0.2)   # spare time: bright
place(verb, bell(midi(88), 1.8, 0.8), c3 + 4.2, gain=0.4)


# ----------------------------------------------------------------------------- mix
def duck_curve(depth=0.32, release=0.22):
    d = np.ones(N)
    L = int(SR * release * 4)
    seg = 1 - depth * np.exp(-np.arange(L) / (SR * release))
    for tk in kick_times:
        i = int(tk * SR)
        if 0 <= i < N:
            j = min(N, i + L)
            d[i:j] = np.minimum(d[i:j], seg[:j - i])
    return d


duck = duck_curve()
ir = room_ir()
wet = np.array([convolve(verb[0], ir[0]), convolve(verb[1], ir[1])])
drum_room = np.array([convolve(drums[0], ir[0][:int(SR * 0.5)]), convolve(drums[1], ir[1][:int(SR * 0.5)])])

mix = (
    drums * 1.0 + drum_room * 0.35
    + bass * duck * 0.95
    + pads * duck * 0.9
    + keys * (0.5 + 0.5 * duck) * 0.9
    + leadb * 1.0
    + fx * 0.85
    + wet * 0.6
)
mix = np.array([fft_filter(mix[0], lo=32, hi=15000, order=2), fft_filter(mix[1], lo=32, hi=15000, order=2)])
peak = np.max(np.abs(mix))
mix = np.tanh(mix / peak * 1.6) / np.tanh(1.6)                  # glue
t = tt(N)
mix *= np.clip(t / 0.35, 0, 1) ** 1.5                           # open gently
mix *= np.clip((T - t) / 2.2, 0, 1) ** 1.6                      # and let it go
mix *= 0.85

out = os.path.join(HERE, 'out', 'score.wav')
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', out, '%.1fs' % (N / SR), 'peak %.3f' % np.max(np.abs(mix)), 'kicks', len(kick_times))
