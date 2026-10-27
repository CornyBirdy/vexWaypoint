#!/usr/bin/env python3
"""Waypoint reveal: synthesized score + sound design (numpy only, no samples).

120 BPM, A minor, 30.0 s = 15 bars. Every cut in the picture lands on a beat, and the
whish / click / tick sounds are placed from the same event list (promo/out/events.json).

    python3 promo/audio.py            -> promo/out/score.wav (48 kHz stereo, 24-bit-safe float WAV)
"""
import json
import os
import struct
import sys
import wave

import numpy as np

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
EV = json.load(open(os.path.join(HERE, 'out', 'events.json')))
T = float(EV['total'])
N = int(SR * T)
BPM = 120.0
BEAT = 60.0 / BPM
rng = np.random.default_rng(52111)  # team number: same noise every run


# ----------------------------------------------------------------------------- helpers
def tt(n):
    return np.arange(n) / SR


def place(buf, sig, t, gain=1.0, pan=0.0):
    """mix a mono signal into stereo buffer `buf` (2, N) at time t, equal-power pan -1..1"""
    i = int(round(t * SR))
    if i >= N or i + len(sig) <= 0:
        return
    a = max(0, -i)
    b = min(len(sig), N - i)
    ang = (pan + 1) * np.pi / 4
    buf[0, i + a:i + b] += sig[a:b] * gain * np.cos(ang)
    buf[1, i + a:i + b] += sig[a:b] * gain * np.sin(ang)


def stft_filter(x, centers, bw_oct=0.7, lo=None, hi=None):
    """time-varying band-pass via STFT; centers = array (Hz) per sample (or scalar)"""
    n = len(x)
    win = np.hanning(2048)
    hop = 512
    pad = np.concatenate([np.zeros(2048), x, np.zeros(2048)])
    out = np.zeros_like(pad)
    freqs = np.fft.rfftfreq(2048, 1 / SR)[1:]
    for s in range(0, len(pad) - 2048, hop):
        fc = centers if np.isscalar(centers) else centers[min(n - 1, max(0, s + 1024 - 2048))]
        spec = np.fft.rfft(pad[s:s + 2048] * win)
        m = np.zeros(len(spec))
        m[1:] = np.exp(-0.5 * (np.log2(freqs / fc) / bw_oct) ** 2)
        out[s:s + 2048] += np.fft.irfft(spec * m) * win
    return out[2048:2048 + n] / 1.5


def fft_filter(x, lo=None, hi=None, order=4):
    """smooth high-pass / low-pass by FFT magnitude shaping"""
    n = len(x)
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    m = np.ones_like(f)
    if lo:
        m *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-6)) ** (2 * order))
    if hi:
        m *= 1 / np.sqrt(1 + (f / hi) ** (2 * order))
    return np.fft.irfft(spec * m, n)


def reverb_ir(seconds=2.2, tone=3500.0):
    n = int(SR * seconds)
    t = tt(n)
    ir = []
    for _ in range(2):
        noise = rng.standard_normal(n) * np.exp(-t / (seconds / 5.5))
        noise = fft_filter(noise, lo=200, hi=tone, order=2)
        noise[:int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
        ir.append(noise / np.sqrt(np.sum(noise ** 2)))
    return np.array(ir)


def convolve(sig, ir):
    n = len(sig) + len(ir) - 1
    m = 1 << (n - 1).bit_length()
    s = np.fft.rfft(sig, m)
    return np.fft.irfft(s * np.fft.rfft(ir, m), m)[:len(sig)]


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def saw(freq, n, harmonics=24, rolloff=1.0, detune=0.0, phase0=0.0):
    t = tt(n)
    out = np.zeros(n)
    for k in range(1, harmonics + 1):
        if freq * k * (1 + abs(detune)) > 18000:
            break
        out += np.sin(2 * np.pi * freq * (1 + detune) * k * t + phase0 * k) / (k ** rolloff)
    return out * (2 / np.pi)


# ----------------------------------------------------------------------------- drums
def kick(dur=0.45):
    n = int(SR * dur)
    t = tt(n)
    f = 54 + 110 * np.exp(-t / 0.03)
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.sin(ph) * np.exp(-t / 0.13)
    click = fft_filter(rng.standard_normal(n), lo=2500, hi=9000) * np.exp(-t / 0.004) * 0.45
    return np.tanh(1.8 * (y + click)) * 0.9


def clap():
    n = int(SR * 0.35)
    t = tt(n)
    noise = fft_filter(rng.standard_normal(n), lo=900, hi=7500, order=2)
    env = np.zeros(n)
    for off in (0.0, 0.011, 0.022):
        e = np.exp(-np.maximum(t - off, 0) / 0.004) * (t >= off)
        env += e * 0.7
    env += np.exp(-np.maximum(t - 0.03, 0) / 0.07) * (t >= 0.03)
    return noise * env * 0.8


def hat(open_=False):
    n = int(SR * (0.22 if open_ else 0.06))
    t = tt(n)
    return fft_filter(rng.standard_normal(n), lo=7000, hi=16000, order=3) * np.exp(-t / (0.07 if open_ else 0.014)) * 0.5


def snare():
    n = int(SR * 0.3)
    t = tt(n)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)
    noise = fft_filter(rng.standard_normal(n), lo=1500, hi=9000, order=2) * np.exp(-t / 0.09)
    return (tone * 0.5 + noise * 0.9) * 0.8


def crash(dur=2.6):
    n = int(SR * dur)
    t = tt(n)
    return fft_filter(rng.standard_normal(n), lo=3000, hi=15000, order=2) * np.exp(-t / 0.8) * 0.6


# ----------------------------------------------------------------------------- tonal
def bass_note(freq, dur):
    n = int(SR * dur)
    t = tt(n)
    env = np.minimum(1, t / 0.004) * np.exp(-t / (dur * 0.9)) * np.minimum(1, (dur - t) / 0.02)
    y = saw(freq, n, harmonics=16, rolloff=0.9) * 1.0 + np.sin(2 * np.pi * freq * t) * 0.55
    return np.tanh(1.5 * y) * env * 0.7


def pad_chord(freqs, dur):
    n = int(SR * dur)
    t = tt(n)
    y = np.zeros(n)
    for f in freqs:
        for d in (-0.004, 0.0, 0.004):
            y += saw(f, n, harmonics=9, rolloff=1.5, detune=d, phase0=rng.uniform(0, 6.28)) * 0.2
    y = fft_filter(y, hi=2800, order=2)
    env = np.minimum(1, t / 0.5) * np.minimum(1, (dur - t) / 0.7)
    return y * env * (0.85 + 0.15 * np.sin(2 * np.pi * 0.25 * t))


def pluck(freq, dur=0.5, bright=1.0):
    n = int(SR * dur)
    t = tt(n)
    y = saw(freq, n, harmonics=14, rolloff=1.1) * 0.7 + np.sin(2 * np.pi * freq * t) * 0.5
    # a plucked filter: bright at the start, dark at the end
    y = y * np.exp(-t / 0.18)
    y2 = fft_filter(y, hi=min(9000, freq * 7 * bright), order=2)
    return y2 * np.minimum(1, t / 0.002) * 0.8


def bell(freq, dur=1.6):
    n = int(SR * dur)
    t = tt(n)
    y = np.zeros(n)
    for ratio, amp, dec in ((1, 1.0, 0.9), (2.76, 0.4, 0.45), (5.4, 0.22, 0.25), (8.93, 0.1, 0.12)):
        y += np.sin(2 * np.pi * freq * ratio * t) * amp * np.exp(-t / dec)
    return y * 0.5 * np.minimum(1, t / 0.002)


def impact(dur=3.2):
    n = int(SR * dur)
    t = tt(n)
    f = 28 + 60 * np.exp(-t / 0.35)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.7) * 0.6
    body = fft_filter(rng.standard_normal(n), hi=500, order=2) * np.exp(-t / 0.22) * 1.2
    air = fft_filter(rng.standard_normal(n), lo=2500, hi=12000, order=2) * np.exp(-t / 0.5) * 0.7
    return np.tanh(1.3 * (boom * 1.1 + body * 0.7 + air)) * 0.9


def riser(dur, f0=300, f1=9000, level=1.0):
    n = int(SR * dur)
    x = np.linspace(0, 1, n)
    centers = f0 * (f1 / f0) ** (x ** 1.6)
    noise = stft_filter(rng.standard_normal(n), centers, bw_oct=0.9)
    noise /= np.max(np.abs(noise)) + 1e-9
    tone = np.sin(2 * np.pi * np.cumsum(200 * (8 ** x ** 1.3)) / SR) * 0.18
    return (noise * 0.9 + tone) * (x ** 2.2) * level


def whoosh(center_t, half=0.3):
    n = int(SR * half * 2)
    x = np.linspace(-1, 1, n)
    f = np.where(x < 0, 450 * (5200 / 450) ** ((x + 1) ** 1.2), 5200 * (900 / 5200) ** (x ** 0.8))
    noise = stft_filter(rng.standard_normal(n), f, bw_oct=0.8)
    noise /= np.max(np.abs(noise)) + 1e-9
    env = np.where(x < 0, (x + 1) ** 2.2, (1 - x) ** 1.4)
    return noise * env


def tick(freq=2100, dur=0.05):
    n = int(SR * dur)
    t = tt(n)
    y = np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.006) * 0.7
    y += fft_filter(rng.standard_normal(n), lo=2500, hi=9000) * np.exp(-t / 0.003) * 0.4
    return y


def sweep_up(dur=0.35, f0=500, f1=2600):
    n = int(SR * dur)
    t = tt(n)
    x = t / dur
    f = f0 * (f1 / f0) ** x
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * x) ** 1.5
    return y * 0.5


# ----------------------------------------------------------------------------- arrangement
drums = np.zeros((2, N))
bass = np.zeros((2, N))
pads = np.zeros((2, N))
arp = np.zeros((2, N))
fx = np.zeros((2, N))
verb = np.zeros((2, N))   # send into the reverb
sfx = np.zeros((2, N))

CHORDS = [  # Am, F, C, G  (one per bar)
    dict(root=33, pad=[57, 60, 64, 69], arp=[57, 60, 64, 69]),
    dict(root=29, pad=[53, 57, 60, 65], arp=[53, 57, 60, 65]),
    dict(root=36, pad=[55, 60, 64, 67], arp=[60, 64, 67, 72]),
    dict(root=31, pad=[55, 59, 62, 67], arp=[55, 59, 62, 67]),
]
bars = int(round(T / (4 * BEAT)))
beat_t = lambda b: b * BEAT


def chord_at(t):
    return CHORDS[int(t // (4 * BEAT)) % 4]


# sections in seconds (picture cuts): see events.json
CUT = EV['cuts']          # [3, 5, 10, 16, 20, 23.5, 26]
T_TITLE, T_RUN, T_DRAW, T_TUNE, T_EXPLORE, T_GRID, T_END = CUT
GROOVE_FROM = T_RUN

# pads: one chord per bar, overlapping
for b in range(bars):
    t0 = b * 4 * BEAT
    ch = CHORDS[b % 4]
    amp = 0.55 if t0 < T_END else 0.7
    sig = pad_chord([midi(n) for n in ch['pad']], 4 * BEAT + 0.9)
    place(pads, sig, t0 - 0.05, gain=amp * (0.35 if t0 < T_TITLE else 1.0), pan=0.0)

# bass: off-beat eighths from the run shot until the end card, root + octave
for k in range(int(T / (BEAT / 2))):
    t = k * BEAT / 2
    if not (GROOVE_FROM <= t < 28.0):
        continue
    ch = chord_at(t)
    on_off = k % 2  # 1 = off-beat
    if on_off == 1:
        note = ch['root'] + (12 if (k // 2) % 4 == 3 else 0)
        place(bass, bass_note(midi(note), BEAT * 0.42), t, gain=0.9)
    elif (k // 2) % 4 == 0:
        place(bass, bass_note(midi(ch['root']), BEAT * 0.9), t, gain=0.0 if t < T_RUN else 0.55)

# drums: kick every beat from the title; clap on 2 and 4; hats
kk = kick()
cl = clap()
hh = hat(False)
oh = hat(True)
sn = snare()
for b in range(int(T / BEAT)):
    t = b * BEAT
    in_title = T_TITLE <= t < T_RUN
    in_groove = T_RUN <= t < 28.0
    if in_title or in_groove:
        place(drums, kk, t, gain=0.62 if in_groove else 0.45)
    if in_groove and b % 4 in (1, 3):
        place(drums, cl, t, gain=0.85, pan=0.05)
        place(verb, cl, t, gain=0.25)
    if (in_groove or (T_TITLE + 1 <= t < T_RUN)):
        place(drums, oh, t + BEAT / 2, gain=0.6, pan=-0.2)
    if in_groove:
        for s in (0, 2):  # 16th hats around the off-beat
            place(drums, hh, t + s * BEAT / 4 + BEAT / 4 * (1 if s == 0 else 1), gain=0.38, pan=0.25)

# snare rolls into each big cut, accelerating
def snare_roll(t_end, beats=2.0, gain=0.6):
    t = t_end - beats * BEAT
    step = BEAT / 2
    while t < t_end - 1e-6:
        x = (t - (t_end - beats * BEAT)) / (beats * BEAT)
        place(drums, sn, t, gain=gain * (0.35 + 0.65 * x), pan=0.0)
        place(verb, sn, t, gain=0.2 * x)
        step = max(BEAT / 8, step * 0.72)
        t += step

snare_roll(T_RUN, 1.0, 0.45)
snare_roll(T_GRID, 2.0, 0.6)
snare_roll(T_END, 1.5, 0.6)

# arpeggio: 16ths, pattern up-down over the chord, from the title cut onward
PATTERN = [0, 1, 2, 3, 2, 1, 2, 3, 0, 2, 1, 3, 2, 1, 0, 1]
step = BEAT / 4
for k in range(int(T / step)):
    t = k * step
    if not (T_TITLE <= t < 29.0):
        continue
    ch = chord_at(t)
    nsel = ch['arp'][PATTERN[k % 16] % 4]
    octave = 12 if (k % 16) in (3, 7, 11, 15) else 0
    vel = 0.55 if (k % 4 == 0) else 0.35
    lvl = 0.5 if t < T_RUN else 1.0
    if t >= 28.0:
        lvl *= max(0.0, 1 - (t - 28.0) / 1.0)
    sig = pluck(midi(nsel + octave), 0.45, bright=1.0 + (0.8 if t >= T_GRID else 0))
    pan = -0.35 if (k % 2) else 0.35
    place(arp, sig, t, gain=vel * lvl * 0.95, pan=pan)
    place(verb, sig, t, gain=0.22 * lvl)
    # ping-pong echo, dotted eighth
    for tap, g in ((1, 0.35), (2, 0.16)):
        place(arp, sig, t + tap * BEAT * 0.75, gain=vel * lvl * 0.95 * g, pan=-pan)

# --- logo hit (picture: the wipe slices in at 0.3 s), sparkle when "52111A" appears
place(fx, impact(2.4), 0.3, gain=0.5)
place(fx, riser(2.7, 250, 9000, 0.8), 0.0, gain=0.85)
place(sfx, sweep_up(0.5, 400, 3000), 0.15, gain=0.6, pan=-0.3)
for i, (tm, nt) in enumerate(((1.45, 93), (1.6, 100), (1.78, 105))):
    place(verb, bell(midi(nt), 1.2), tm, gain=0.35)
    place(sfx, bell(midi(nt), 1.2), tm, gain=0.12, pan=-0.3 + 0.3 * i)

# --- title (3.0): big hit; waypoint nodes ping as the robot passes them
place(fx, impact(3.0), T_TITLE, gain=0.95)
place(fx, crash(2.4), T_TITLE, gain=0.5)
node_t = [T_TITLE + 0.55, T_TITLE + 0.9, T_TITLE + 1.25, T_TITLE + 1.6]
for i, tm in enumerate(node_t):
    nt = (81, 84, 88, 93)[i]
    place(sfx, bell(midi(nt), 0.9), tm, gain=0.18, pan=-0.5 + i * 0.33)
    place(verb, bell(midi(nt), 0.9), tm, gain=0.3)

# --- run cut (5.0)
place(fx, impact(2.4), T_RUN, gain=0.75)
place(fx, crash(2.0), T_RUN, gain=0.35)

# --- end card (26.0): the big finish
place(fx, impact(3.5), T_END, gain=1.0)
place(fx, crash(3.2), T_END, gain=0.6)
place(fx, riser(1.5, 400, 11000, 1.0), T_END - 1.5, gain=0.6)
for i, nt in enumerate((57, 64, 69, 72, 76)):
    place(pads, saw(midi(nt), int(SR * 3.4), harmonics=10, rolloff=1.4, detune=0.003) * np.exp(-tt(int(SR * 3.4)) / 1.4), T_END, gain=0.16, pan=-0.4 + i * 0.2)
for i, nt in enumerate((81, 84, 88, 93, 96)):
    place(sfx, bell(midi(nt), 1.8), T_END + 0.2 + i * 0.28, gain=0.14, pan=-0.6 + i * 0.3)
    place(verb, bell(midi(nt), 1.8), T_END + 0.2 + i * 0.28, gain=0.3)

# --- grid (23.5): tiles pop in as an ascending A-minor pentatonic run
for i, nt in enumerate((81, 84, 86, 88, 91, 93)):
    tm = T_GRID + 0.3 + i * 0.07
    place(sfx, bell(midi(nt), 1.4), tm, gain=0.2, pan=-0.7 + i * 0.28)
    place(verb, bell(midi(nt), 1.4), tm, gain=0.32)
place(fx, impact(2.4), T_GRID, gain=0.7)
place(fx, riser(1.5, 300, 9000, 0.9), T_GRID - 1.5, gain=0.7)
place(fx, riser(2.0, 300, 8000, 0.9), T_END - 2.0 - 1.5 + 0.0, gain=0.0)

# --- risers into the other cuts
place(fx, riser(1.0, 300, 7000, 0.6), T_DRAW - 1.0, gain=0.6)
place(fx, riser(1.0, 300, 7000, 0.6), T_TUNE - 1.0, gain=0.6)
place(fx, riser(1.0, 300, 7000, 0.6), T_EXPLORE - 1.0, gain=0.6)
for c in (T_DRAW, T_TUNE, T_EXPLORE):
    place(fx, impact(1.4), c, gain=0.45)

# --- whooshes on every wipe
for i, c in enumerate(CUT):
    place(sfx, whoosh(c, 0.3), c - 0.3, gain=0.55, pan=0.0)

# --- UI sounds: real clicks get a tick, fake (hover-click) a softer one
for c in EV['clicks']:
    place(sfx, tick(2100 if c['real'] else 1700), c['t'], gain=0.3 if c['real'] else 0.18, pan=0.15)
# paste (run shot, local 1.15) and the tune counter blips
place(sfx, sweep_up(0.3, 600, 3200), T_RUN + 1.15, gain=0.35, pan=0.2)
for t0, t1, up in ((T_TUNE + 0.6, T_TUNE + 1.1, False), (T_TUNE + 2.0, T_TUNE + 2.5, True)):
    steps = 9
    for j in range(steps):
        x = j / (steps - 1)
        f = (700 + 1100 * x) if up else (1800 - 1100 * x)
        place(sfx, tick(f, 0.04), t0 + (t1 - t0) * x, gain=0.16, pan=0.3)
# green / red result stings
place(sfx, bell(midi(76), 1.0), T_TUNE + 1.45, gain=0.1, pan=0.2)   # over the limit (low, slightly sour)
place(sfx, bell(midi(70), 1.0), T_TUNE + 1.45, gain=0.08, pan=0.2)
place(sfx, bell(midi(88), 1.2), T_TUNE + 2.95, gain=0.16, pan=0.2)  # spare: bright
place(sfx, bell(midi(93), 1.2), T_TUNE + 3.0, gain=0.12, pan=0.2)

# ----------------------------------------------------------------------------- mix
rev = reverb_ir()
wet = np.array([convolve(verb[0] + 0.0, rev[0]), convolve(verb[1] + 0.0, rev[1])])


def duck(sig, depth=0.55, release=0.16, start=T_TITLE, stop=28.0):
    t = tt(N)
    ph = (t % BEAT)
    env = 1 - depth * np.exp(-ph / release) * ((t >= start) & (t < stop))
    return sig * env


mix = (
    drums * 1.0
    + duck(bass, 0.75) * 1.1
    + duck(pads, 0.5) * 0.9
    + duck(arp, 0.35) * 0.9
    + fx * 0.75
    + sfx * 1.0
    + wet * 0.8
)

# gentle bus: high-pass the sub rumble, soft-clip, fade out
mix = np.array([fft_filter(mix[0], lo=36, order=3), fft_filter(mix[1], lo=36, order=3)])
peak = np.max(np.abs(mix))
mix = np.tanh(mix / peak * 1.8) / np.tanh(1.8)
t = tt(N)
mix *= np.clip((T - t) / 1.2, 0, 1) ** 1.5      # fade out over the last 1.2 s
mix *= np.clip(t / 0.02, 0, 1)
mix *= 0.89

out = os.path.join(HERE, 'out', 'score.wav')
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', out, '%.1fs' % (N / SR), 'peak %.3f' % np.max(np.abs(mix)))
