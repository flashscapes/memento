"""Synthesize Memento's original instrumental tracks.

Usage: python3 tools/make_music.py [name ...]   (needs numpy and scipy; ffmpeg encodes the mp3s)
Names: gentle warm sunny musicbox waltz calm golden cafe porch aurora neon parade. With no names, all twelve are built.

Everything is generated from math: FM electric piano, soft pads, plucks, bell
tones, and algorithmic reverb. Deterministic (fixed seeds), so the files can be
rebuilt. Output: public/audio/<name>.mp3, 120 s each. The four newer tracks are
loudness-matched to the first two (about -16.3 LUFS) so switching never jumps.
"""
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, lfilter, sosfilt

SR = 44100
LENGTH = 120.0
OUT = Path(__file__).resolve().parent.parent / "public" / "audio"


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def epiano(f, dur, vel):
    t = np.arange(int(SR * dur)) / SR
    index = 1.1 * vel * np.exp(-t * 2.6) + 0.08
    mod = np.sin(2 * np.pi * f * t)
    car = np.sin(2 * np.pi * f * t + index * mod)
    body = 0.28 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 2.2)
    tine = 0.07 * vel * np.sin(2 * np.pi * 7 * f * t) * np.exp(-t * 16)
    env = np.minimum(t / 0.005, 1.0) * np.exp(-t * 1.25)
    tail = np.minimum((dur - t) / 0.08, 1.0)
    return (car + body + tine) * env * tail * vel * 0.45


def bell(f, dur, vel):
    t = np.arange(int(SR * dur)) / SR
    s = (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2.01 * f * t) * np.exp(-t * 2)
         + 0.12 * np.sin(2 * np.pi * 3.02 * f * t) * np.exp(-t * 4))
    env = np.minimum(t / 0.01, 1.0) * np.exp(-t * 0.9)
    tail = np.minimum((dur - t) / 0.1, 1.0)
    return s * env * tail * vel * 0.3


def pad(freqs, dur, attack=1.4, release=1.8):
    t = np.arange(int(SR * dur)) / SR
    out = np.zeros_like(t)
    for f in freqs:
        for detune in (-0.0035, 0.0, 0.0035):
            ff = f * (1 + detune)
            out += np.sin(2 * np.pi * ff * t) + 0.25 * np.sin(2 * np.pi * 2 * ff * t)
    env = np.minimum(t / attack, 1.0) * np.minimum((dur - t) / release, 1.0)
    return out * env / (len(freqs) * 3)


def pluck(f, dur, vel):
    """Soft kalimba / marimba-like pluck: a few harmonics that die away at different speeds."""
    t = np.arange(int(SR * dur)) / SR
    s = (np.sin(2 * np.pi * f * t) * np.exp(-t * 3.2)
         + 0.42 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 6.5)
         + 0.16 * np.sin(2 * np.pi * 4.01 * f * t) * np.exp(-t * 14))
    env = np.minimum(t / 0.004, 1.0) * np.minimum((dur - t) / 0.06, 1.0)
    return s * env * vel * 0.5


def tine(f, dur, vel):
    """Music-box tine: bright, quick, with a slightly stretched upper partial."""
    t = np.arange(int(SR * dur)) / SR
    s = (np.sin(2 * np.pi * f * t) * np.exp(-t * 2.4)
         + 0.30 * np.sin(2 * np.pi * 2.76 * f * t) * np.exp(-t * 7)
         + 0.10 * np.sin(2 * np.pi * 5.4 * f * t) * np.exp(-t * 18))
    env = np.minimum(t / 0.002, 1.0) * np.minimum((dur - t) / 0.08, 1.0)
    return s * env * vel * 0.42


def swell(freqs, dur, attack, release, rate, depth):
    """A pad whose loudness slowly breathes, for the ambient track."""
    t = np.arange(int(SR * dur)) / SR
    out = pad(freqs, dur, attack, release)
    return out * (1 - depth + depth * (0.5 + 0.5 * np.sin(2 * np.pi * rate * t)))


# ---- drums and plucked strings for the newer, more rhythmic tracks ----

def _noise(n, rng):
    return rng.standard_normal(n)


def _band(x, lo, hi):
    sos = butter(2, [lo, hi], btype="band", fs=SR, output="sos")
    return sosfilt(sos, x)


def kick(vel=1.0):
    t = np.arange(int(SR * 0.4)) / SR
    phase = 2 * np.pi * np.cumsum(46 + 105 * np.exp(-t * 30)) / SR
    return np.sin(phase) * np.exp(-t * 9) * vel * 0.9


def snare(rng, vel=1.0):
    t = np.arange(int(SR * 0.28)) / SR
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t * 28) * 0.45
    hiss = _band(_noise(len(t), rng), 1400, 6500) * np.exp(-t * 20) * 0.55
    return (body + hiss) * vel * 0.8


def hat(rng, vel=1.0, open_=False):
    t = np.arange(int(SR * (0.25 if open_ else 0.07))) / SR
    return _band(_noise(len(t), rng), 6500, 14000) * np.exp(-t * (14 if open_ else 70)) * vel * 0.28


def brush(rng, dur=0.16, vel=1.0):
    t = np.arange(int(SR * dur)) / SR
    env = np.minimum(t / 0.035, 1.0) * np.exp(-t * 14)
    return _band(_noise(len(t), rng), 2200, 8000) * env * vel * 0.4


def shaker(rng, vel=1.0):
    t = np.arange(int(SR * 0.09)) / SR
    return _band(_noise(len(t), rng), 4500, 12000) * np.minimum(t / 0.01, 1.0) * np.exp(-t * 32) * vel * 0.3


def guitar(f, dur, vel, rng, bright=0.5):
    """Plucked string by Karplus-Strong, written as one feedback filter so it stays fast."""
    n = int(SR * dur)
    period = SR / f
    N = int(period)
    frac = period - N
    burst = _noise(N + 2, rng)
    burst = sosfilt(butter(1, 600 + 5000 * bright, btype="low", fs=SR, output="sos"), burst)
    x = np.zeros(n)
    x[: N + 2] = burst
    a = np.zeros(N + 3)
    a[0] = 1.0
    g = 0.996
    a[N] = -(1 - frac) * 0.5 * g
    a[N + 1] = -0.5 * g
    a[N + 2] = -frac * 0.5 * g
    y = lfilter([1.0], a, x)
    env = np.minimum((dur - np.arange(n) / SR) / 0.06, 1.0)
    return y / (np.max(np.abs(y)) + 1e-9) * env * vel * 0.5


def saw_pad(freqs, dur, attack=1.2, release=1.6, cutoff=1400):
    """Detuned saws through a low-pass: the warm, slightly buzzy string-and-synth bed."""
    t = np.arange(int(SR * dur)) / SR
    out = np.zeros_like(t)
    for f in freqs:
        for d in (-0.006, -0.002, 0.002, 0.006):
            out += 2 * ((f * (1 + d) * t) % 1.0) - 1
    out = sosfilt(butter(2, cutoff, btype="low", fs=SR, output="sos"), out)
    env = np.minimum(t / attack, 1.0) * np.minimum((dur - t) / release, 1.0)
    return out * env / (len(freqs) * 4)


def echo(buf, delay, feedback, mix, taps=5):
    out = buf.copy()
    d = int(delay * SR)
    for k in range(1, taps + 1):
        sh = d * k
        if sh >= buf.shape[1]:
            break
        out[:, sh:] += buf[:, : buf.shape[1] - sh] * (feedback ** k) * mix
    return out


def crackle(buf, rng, level=0.012):
    n = buf.shape[1]
    hits = rng.random(n) < 14 / SR
    x = hits * np.clip(rng.standard_normal(n), -2.5, 2.5)
    x = sosfilt(butter(2, [800, 7000], btype="band", fs=SR, output="sos"), x)
    hiss = sosfilt(butter(2, 5000, btype="low", fs=SR, output="sos"), rng.standard_normal(n)) * 0.0025
    both = (x * 1.0 + hiss) * level * 8
    return buf + np.stack([both, np.roll(both, 311)])


def add(buf, sig, start, pan=0.0, gain=1.0):
    i = max(0, int(start * SR))
    if i >= buf.shape[1]:
        return
    n = min(len(sig), buf.shape[1] - i)
    left = np.cos((pan + 1) * np.pi / 4)
    right = np.sin((pan + 1) * np.pi / 4)
    buf[0, i:i + n] += sig[:n] * left * gain
    buf[1, i:i + n] += sig[:n] * right * gain


def reverb(buf, rt60, wet, seed):
    rng = np.random.default_rng(seed)
    n = int(SR * rt60)
    t = np.arange(n) / SR
    out = np.zeros_like(buf)
    sos = butter(2, 3800, btype="low", fs=SR, output="sos")
    for ch in range(2):
        ir = rng.standard_normal(n) * np.exp(-6.9 * t / rt60)
        ir = sosfilt(sos, ir)
        ir[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
        ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
        out[ch] = fftconvolve(buf[ch], ir)[: buf.shape[1]]
    return buf * (1 - wet * 0.5) + out * wet


def loudness(path):
    out = subprocess.run(["ffmpeg", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", out.split("Summary")[-1]).group(1))


def finish(buf, name, match=None, soft=0.0):
    hp = butter(2, 40, btype="high", fs=SR, output="sos")
    buf = np.stack([sosfilt(hp, buf[0]), sosfilt(hp, buf[1])])
    n = buf.shape[1]
    fi, fo = int(0.5 * SR), int(5.0 * SR)
    buf[:, :fi] *= np.linspace(0, 1, fi)
    buf[:, n - fo:] *= np.linspace(1, 0, fo) ** 1.5
    if soft:  # gently round off the loudest hits so the track can sit as loud as the others
        peak = np.max(np.abs(buf))
        buf = np.tanh(buf / peak * soft) / soft * peak
    buf *= 0.80 / np.max(np.abs(buf))
    pcm = (buf.T * 32767).astype("<i2")
    wav = OUT / f"{name}.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    rms = 20 * np.log10(np.sqrt(np.mean(buf ** 2)))
    print(f"{name}: peak {np.max(np.abs(buf)):.2f}, rms {rms:.1f} dBFS, {n / SR:.1f}s")
    mp3 = OUT / f"{name}.mp3"
    encode = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav)]

    def write(gain_db):
        subprocess.run(encode + ["-af", f"volume={gain_db:.2f}dB", "-codec:a", "libmp3lame", "-b:a", "96k", str(mp3)], check=True)

    def decoded_peak():
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(mp3), "-f", "f32le", "-ac", "1", "-ar", "44100", "-"],
                             capture_output=True).stdout
        return float(np.abs(np.frombuffer(raw, dtype="<f4")).max())

    write(0.0)
    gain = 0.0
    if match is not None:
        gain = match - loudness(mp3)
        write(gain)
    # MP3 encoding can overshoot the WAV's peak, so measure the decoded file and back off until it is clean.
    for _ in range(4):
        peak = decoded_peak()
        if peak <= 0.97:
            break
        gain -= 20 * np.log10(peak / 0.94)
        write(gain)
    print(f"{name}: {loudness(mp3):.1f} LUFS, decoded peak {decoded_peak():.2f}")
    wav.unlink()


def gentle():
    rng = np.random.default_rng(11)
    bpm = 66
    beat = 60 / bpm
    eighth = beat / 2
    chords = [
        dict(bass=36, arp=[60, 64, 67, 71], mel=[72, 74, 76, 79, 83], pad=[48, 55, 64]),
        dict(bass=33, arp=[60, 64, 67, 69], mel=[72, 74, 76, 79, 81], pad=[45, 55, 64]),
        dict(bass=29, arp=[60, 64, 69, 72], mel=[72, 74, 77, 81, 79], pad=[41, 52, 60]),
        dict(bass=31, arp=[59, 62, 67, 71], mel=[71, 74, 76, 79, 81], pad=[43, 50, 59]),
    ]
    patterns = [[0, 1, 2, 3, 2, 1, 2, 3], [0, 2, 1, 3, 2, 1, 3, 2]]
    bars = int((LENGTH + 4) / (4 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    last_mel = 2
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 4 * beat
        add(buf, pad([hz(m) for m in c["pad"]], 4 * beat + 1.6), t0, 0.0, 0.07)
        add(buf, epiano(hz(c["bass"]), 3.6 * beat, 0.7), t0, -0.2, 0.9)
        if bar % 2 == 1:
            add(buf, epiano(hz(c["bass"] + 7), 2.2 * beat, 0.5), t0 + 2 * beat, -0.15, 0.7)
        pat = patterns[(bar // 4) % 2]
        for k, idx in enumerate(pat):
            note = c["arp"][idx]
            vel = (0.62 if k % 2 == 0 else 0.5) * rng.uniform(0.88, 1.1)
            when = t0 + k * eighth + rng.normal(0, 0.006)
            add(buf, epiano(hz(note), 1.7, vel), max(when, 0), (note - 60) / 40, 0.8)
        if bar >= 2 and bar % 2 == 0:
            last_mel = int(np.clip(last_mel + rng.choice([-1, 0, 1, 2]), 0, 4))
            add(buf, epiano(hz(c["mel"][last_mel]), 3.2 * beat, 0.75), t0 + rng.choice([0, 2]) * beat, 0.15, 0.95)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 2.4, 0.5, 5), "gentle")


def warm():
    rng = np.random.default_rng(23)
    bpm = 54
    beat = 60 / bpm
    chords = [
        dict(pad=[41, 48, 57, 64, 67], root=29, bells=[77, 79, 81, 84, 72]),
        dict(pad=[38, 45, 53, 60, 64], root=26, bells=[74, 77, 81, 84, 72]),
        dict(pad=[46, 53, 62, 65, 69], root=34, bells=[77, 79, 81, 74, 86]),
        dict(pad=[36, 43, 55, 62, 64], root=36, bells=[72, 76, 79, 81, 84]),
    ]
    bars = int((LENGTH + 4) / (4 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 4 * beat
        add(buf, pad([hz(m) for m in c["pad"]], 4 * beat + 2.4, 1.8, 2.4), t0, 0.0, 0.16)
        add(buf, pad([hz(c["root"])], 4 * beat + 2.0, 0.8, 2.0), t0, 0.0, 0.2)
        for k in range(int(rng.integers(2, 4))):
            note = int(rng.choice(c["bells"]))
            when = t0 + float(rng.choice([0.0, 1.0, 1.5, 2.0, 2.5, 3.0])) * beat + rng.normal(0, 0.01)
            add(buf, bell(hz(note), 5.0, rng.uniform(0.5, 0.9)), max(when, 0), float(rng.uniform(-0.5, 0.5)), 0.9)
        if bar % 2 == 0:
            add(buf, epiano(hz(c["pad"][2] + 12), 4.0, 0.42), t0 + 0.5 * beat, 0.1, 0.55)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 3.2, 0.6, 9), "warm")


MATCH = -16.3


def sunny():
    """Bright and light: kalimba arpeggios over a soft pad and a round bass. 92 bpm, C major."""
    rng = np.random.default_rng(31)
    beat = 60 / 92
    eighth = beat / 2
    chords = [  # C, G, Am, F
        dict(bass=36, arp=[60, 64, 67, 72], mel=[72, 74, 76, 79, 81], pad=[48, 55, 64]),
        dict(bass=31, arp=[59, 62, 67, 74], mel=[71, 74, 76, 79, 83], pad=[43, 55, 62]),
        dict(bass=33, arp=[60, 64, 69, 72], mel=[72, 76, 79, 81, 84], pad=[45, 55, 64]),
        dict(bass=29, arp=[60, 65, 69, 72], mel=[72, 74, 77, 79, 81], pad=[41, 53, 60]),
    ]
    patterns = [[0, 1, 2, 3, 2, 1, 2, 1], [0, 2, 1, 3, 2, 3, 1, 2], [0, 1, 3, 2, 1, 2, 3, 2]]
    bars = int((LENGTH + 4) / (4 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    last = 2
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 4 * beat
        add(buf, pad([hz(m) for m in c["pad"]], 4 * beat + 1.2, 0.9, 1.4), t0, 0.0, 0.06)
        add(buf, epiano(hz(c["bass"]), 1.6 * beat, 0.62), t0, -0.2, 0.8)
        add(buf, epiano(hz(c["bass"]), 1.2 * beat, 0.5), t0 + 2.5 * beat, -0.2, 0.6)
        pat = patterns[(bar // 2) % 3]
        for k, idx in enumerate(pat):
            note = c["arp"][idx]
            vel = (0.7 if k % 2 == 0 else 0.5) * rng.uniform(0.9, 1.08)
            when = t0 + k * eighth * (4 / 4) + rng.normal(0, 0.004)
            add(buf, pluck(hz(note), 1.3, vel), max(when, 0), (note - 66) / 30, 0.85)
        if bar >= 1:
            last = int(np.clip(last + rng.choice([-1, 0, 1, 1]), 0, 4))
            add(buf, bell(hz(c["mel"][last] + 12 if bar % 4 == 3 else c["mel"][last]), 2.6, 0.55), t0 + rng.choice([0, 1.5, 2]) * beat, 0.2, 0.7)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 1.7, 0.38, 41), "sunny", MATCH)


def musicbox():
    """A lullaby on music-box tines, in three. 70 bpm, F major."""
    rng = np.random.default_rng(47)
    beat = 60 / 70
    chords = [  # F, Dm, Bb, C
        dict(low=[53, 57, 60], scale=[77, 79, 81, 84, 86]),
        dict(low=[50, 57, 62], scale=[77, 81, 84, 86, 89]),
        dict(low=[46, 53, 62], scale=[77, 79, 82, 86, 89]),
        dict(low=[48, 55, 64], scale=[76, 79, 81, 84, 88]),
    ]
    bars = int((LENGTH + 4) / (3 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    mel = 2
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 3 * beat
        # waltz figure: low note, then the chord's upper two, all on tines
        add(buf, tine(hz(c["low"][0] - 12), 2.4, 0.8), t0, -0.25, 0.9)
        add(buf, tine(hz(c["low"][1] + 12), 1.6, 0.55), t0 + beat, 0.1, 0.8)
        add(buf, tine(hz(c["low"][2] + 12), 1.6, 0.5), t0 + 2 * beat, 0.25, 0.8)
        add(buf, pad([hz(m - 12) for m in c["low"]], 3 * beat + 1.4, 1.2, 1.6), t0, 0.0, 0.05)
        if bar >= 1:
            for k in range(2):
                mel = int(np.clip(mel + rng.choice([-2, -1, 1, 1, 2]), 0, 4))
                add(buf, tine(hz(c["scale"][mel]), 2.2, rng.uniform(0.7, 0.95)), t0 + (0 if k == 0 else 1.5) * beat + rng.normal(0, 0.005), (mel - 2) / 6, 0.9)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 2.6, 0.5, 53), "musicbox", MATCH)


def waltz():
    """Slow, nostalgic waltz on electric piano and strings-like pad. 60 bpm, A minor."""
    rng = np.random.default_rng(59)
    beat = 60 / 60
    chords = [  # Am, F, C, G
        dict(bass=45, chord=[57, 60, 64], pad=[45, 52, 57, 60], mel=[69, 72, 74, 76, 79]),
        dict(bass=41, chord=[57, 60, 65], pad=[41, 48, 57, 60], mel=[69, 72, 74, 77, 81]),
        dict(bass=48, chord=[55, 60, 64], pad=[48, 55, 60, 64], mel=[72, 74, 76, 79, 81]),
        dict(bass=43, chord=[55, 59, 62], pad=[43, 50, 55, 59], mel=[71, 74, 76, 79, 83]),
    ]
    bars = int((LENGTH + 4) / (3 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    mel = 2
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 3 * beat
        add(buf, pad([hz(m) for m in c["pad"]], 3 * beat + 1.8, 1.4, 1.9), t0, 0.0, 0.09)
        add(buf, epiano(hz(c["bass"] - 12), 2.4 * beat, 0.7), t0, -0.2, 0.95)
        for k in (1, 2):
            for note in c["chord"]:
                add(buf, epiano(hz(note), 1.3, 0.34 * rng.uniform(0.9, 1.1)), t0 + k * beat + rng.normal(0, 0.008), (note - 60) / 30, 0.55)
        if bar % 2 == 1 and bar >= 3:
            mel = int(np.clip(mel + rng.choice([-1, 1, 2, -2]), 0, 4))
            add(buf, epiano(hz(c["mel"][mel]), 2.8 * beat, 0.78), t0 + rng.choice([0, 1]) * beat, 0.15, 0.95)
            if rng.random() < 0.5:
                mel = int(np.clip(mel - 1, 0, 4))
                add(buf, epiano(hz(c["mel"][mel]), 1.8 * beat, 0.66), t0 + 2 * beat, 0.15, 0.9)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 2.8, 0.55, 61), "waltz", MATCH)


def calm():
    """Beatless: slow breathing pads with a few soft bells. D major, no pulse."""
    rng = np.random.default_rng(71)
    span = 8.0
    chords = [  # Dmaj7, Bm7, Gmaj7, Asus
        dict(pad=[38, 50, 57, 61, 66], bells=[74, 78, 81, 86]),
        dict(pad=[35, 47, 54, 62, 66], bells=[74, 78, 83, 86]),
        dict(pad=[31, 43, 55, 59, 66], bells=[74, 79, 83, 86]),
        dict(pad=[33, 45, 52, 57, 64], bells=[73, 76, 81, 88]),
    ]
    bars = int((LENGTH + 4) / span) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * span
        add(buf, swell([hz(m) for m in c["pad"]], span + 3.5, 3.0, 3.5, 0.11, 0.35), t0, 0.0, 0.2)
        add(buf, swell([hz(c["pad"][0])], span + 3.0, 2.0, 3.0, 0.07, 0.2), t0, 0.0, 0.25)
        for _ in range(int(rng.integers(1, 3))):
            note = int(rng.choice(c["bells"]))
            add(buf, bell(hz(note), 6.0, rng.uniform(0.35, 0.6)), t0 + float(rng.uniform(1.0, 6.5)), float(rng.uniform(-0.6, 0.6)), 0.8)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 3.6, 0.65, 73), "calm", MATCH)


def golden():
    """Lo-fi beat: dusty electric-piano chords, swung drums, vinyl crackle. 76 bpm, A minor."""
    rng = np.random.default_rng(83)
    beat = 60 / 76
    swing = 0.18
    chords = [  # Am9, Dm9, G13, Cmaj9
        dict(bass=33, notes=[57, 60, 64, 67, 71], mel=[76, 79, 81, 83]),
        dict(bass=38, notes=[53, 57, 60, 64, 69], mel=[77, 79, 81, 84]),
        dict(bass=31, notes=[53, 59, 62, 64, 69], mel=[74, 76, 79, 81]),
        dict(bass=36, notes=[55, 59, 62, 64, 67], mel=[76, 79, 83, 84]),
    ]
    bars = int((LENGTH + 4) / (4 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    mel = 1
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 4 * beat
        for k, off in enumerate((0.0, 2.5)):  # two chord hits per bar, the second a touch late
            for note in c["notes"]:
                add(buf, epiano(hz(note), 2.2 * beat, 0.5 * rng.uniform(0.9, 1.1)), t0 + off * beat + rng.normal(0, 0.012), (note - 62) / 30, 0.4)
        add(buf, epiano(hz(c["bass"]), 1.7 * beat, 0.7), t0, -0.1, 0.9)
        add(buf, epiano(hz(c["bass"] + 7), 1.0 * beat, 0.55), t0 + 2.5 * beat, -0.1, 0.7)
        if bar >= 2 and bar % 2 == 0:
            mel = int(np.clip(mel + rng.choice([-1, 1, 1, 2]), 0, 3))
            add(buf, epiano(hz(c["mel"][mel]), 1.6 * beat, 0.6), t0 + rng.choice([1.5, 3.0]) * beat, 0.2, 0.55)
        if bar >= 1:  # drums join after the first bar
            for k in (0, 2.5):
                add(buf, kick(0.9 if k == 0 else 0.75), t0 + k * beat, 0.0, 0.75)
            for k in (1, 3):
                add(buf, snare(rng, 0.8), t0 + k * beat + rng.normal(0, 0.006), 0.05, 0.55)
            for j in range(8):
                late = swing * beat / 2 if j % 2 else 0.0
                add(buf, hat(rng, 0.9 if j % 2 == 0 else 0.55), t0 + j * beat / 2 + late, 0.2, 0.6)
    buf = buf[:, : int(LENGTH * SR)]
    buf = sosfilt(butter(2, 4200, btype="low", fs=SR, output="sos"), buf, axis=1)  # tape-like dullness
    buf = crackle(reverb(buf, 1.4, 0.3, 89), rng)
    finish(buf, "golden", MATCH, soft=2.2)


def cafe():
    """Soft jazz: brushes, walking bass, electric-piano comping. 92 bpm, C major ii-V-I turnaround."""
    rng = np.random.default_rng(97)
    beat = 60 / 92
    swing = 0.2
    chords = [  # Dm7, G7, Cmaj7, A7
        dict(root=38, walk=[38, 41, 45, 43], comp=[53, 57, 60, 64], mel=[69, 72, 74, 77]),
        dict(root=43, walk=[43, 47, 50, 48], comp=[53, 55, 59, 62], mel=[67, 71, 74, 77]),
        dict(root=36, walk=[36, 40, 43, 45], comp=[52, 55, 59, 64], mel=[72, 74, 76, 79]),
        dict(root=45, walk=[45, 49, 52, 50], comp=[55, 57, 61, 64], mel=[69, 73, 76, 79]),
    ]
    bars = int((LENGTH + 4) / (4 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    mel = 1
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 4 * beat
        for k, note in enumerate(c["walk"]):  # walking bass, one note a beat
            add(buf, epiano(hz(note), 0.95 * beat, 0.62), t0 + k * beat + rng.normal(0, 0.006), -0.2, 0.75)
        for off in (0.0, 1.5 + swing * 0.5, 3.0):  # comping hits
            for note in c["comp"]:
                add(buf, epiano(hz(note), 0.9 * beat, 0.4 * rng.uniform(0.9, 1.1)), t0 + off * beat + rng.normal(0, 0.008), (note - 58) / 24, 0.4)
        # brushes: a steady swung ride pattern plus a soft sweep on 2 and 4
        for j in range(8):
            late = swing * beat / 2 if j % 2 else 0.0
            add(buf, brush(rng, 0.09, 0.8 if j % 2 == 0 else 0.5), t0 + j * beat / 2 + late, 0.25, 0.5)
        for k in (1, 3):
            add(buf, brush(rng, 0.2, 1.0), t0 + k * beat, -0.1, 0.55)
        if bar >= 2 and bar % 2 == 1:
            mel = int(np.clip(mel + rng.choice([-1, 1, 2]), 0, 3))
            add(buf, epiano(hz(c["mel"][mel]), 1.6 * beat, 0.7), t0 + rng.choice([0.0, 2.0]) * beat, 0.15, 0.7)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 1.6, 0.3, 101), "cafe", MATCH)


def porch():
    """Acoustic-guitar folk: fingerpicked arpeggios, a soft bass and shaker. 98 bpm, G major."""
    rng = np.random.default_rng(103)
    beat = 60 / 98
    chords = [  # G, Em, C, D
        dict(bass=43, pick=[55, 59, 62, 67], mel=[74, 79, 83]),
        dict(bass=40, pick=[55, 59, 64, 67], mel=[71, 76, 79]),
        dict(bass=36, pick=[55, 60, 64, 67], mel=[72, 76, 79]),
        dict(bass=38, pick=[54, 57, 62, 66], mel=[74, 78, 81]),
    ]
    pattern = [0, 2, 1, 3, 2, 1, 3, 2]
    bars = int((LENGTH + 4) / (4 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    mel = 1
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 4 * beat
        add(buf, guitar(hz(c["bass"]), 2.0 * beat, 0.8, rng, 0.2), t0, -0.25, 0.9)
        add(buf, guitar(hz(c["bass"] + (7 if bar % 2 else 0)), 1.6 * beat, 0.65, rng, 0.2), t0 + 2 * beat, -0.2, 0.8)
        for j, idx in enumerate(pattern):
            note = c["pick"][idx]
            vel = (0.75 if j % 4 == 0 else 0.55) * rng.uniform(0.9, 1.08)
            add(buf, guitar(hz(note + 12), 1.6, vel, rng, 0.55), t0 + j * beat / 2 + rng.normal(0, 0.005), (note - 60) / 22, 0.55)
        if bar >= 2 and bar % 2 == 1:
            mel = int(np.clip(mel + rng.choice([-1, 0, 1]), 0, 2))
            add(buf, guitar(hz(c["mel"][mel]), 3.0 * beat, 0.8, rng, 0.7), t0 + rng.choice([0.0, 1.0]) * beat, 0.25, 0.7)
        if bar >= 1:
            for j in range(8):
                add(buf, shaker(rng, 0.8 if j % 2 == 0 else 0.5), t0 + j * beat / 2, 0.3, 0.4)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 1.3, 0.25, 107), "porch", MATCH, soft=1.8)


def aurora():
    """Cinematic and wide: slow string-like swells, a deep drone, sparse piano and shimmering bells. 56 bpm, D minor."""
    rng = np.random.default_rng(109)
    beat = 60 / 56
    chords = [  # Dm, Bb, F, C
        dict(pad=[38, 50, 53, 57, 62], root=26, notes=[74, 77, 81, 86], bells=[89, 93, 86]),
        dict(pad=[34, 46, 53, 58, 62], root=34, notes=[74, 77, 82, 86], bells=[86, 89, 94]),
        dict(pad=[41, 53, 57, 60, 65], root=29, notes=[72, 77, 81, 84], bells=[88, 91, 96]),
        dict(pad=[36, 48, 55, 60, 64], root=36, notes=[72, 76, 79, 84], bells=[88, 91, 84]),
    ]
    span = 8 * beat
    bars = int((LENGTH + 4) / span) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    note_i = 1
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * span
        add(buf, saw_pad([hz(m) for m in c["pad"]], span + 4.0, 3.2, 3.8, 1100 + 250 * (bar % 3)), t0, 0.0, 0.5)
        add(buf, swell([hz(c["root"])], span + 3.0, 2.4, 3.0, 0.05, 0.25), t0, 0.0, 0.55)
        if bar >= 1:
            note_i = int(np.clip(note_i + rng.choice([-1, 1, 1]), 0, 3))
            add(buf, epiano(hz(c["notes"][note_i]), 4.0 * beat, 0.55), t0 + 1 * beat, 0.1, 0.55)
            add(buf, epiano(hz(c["notes"][(note_i + 2) % 4] - 12), 3.0 * beat, 0.45), t0 + 4.5 * beat, -0.1, 0.45)
        for _ in range(2):
            add(buf, bell(hz(int(rng.choice(c["bells"]))), 6.5, rng.uniform(0.3, 0.55)), t0 + float(rng.uniform(2, 7.5)) * beat, float(rng.uniform(-0.7, 0.7)), 0.55)
    buf = buf[:, : int(LENGTH * SR)]
    finish(echo(reverb(buf, 4.2, 0.7, 113), 0.62, 0.45, 0.35, 4), "aurora", MATCH)


def neon():
    """Dreamy synth: a detuned-saw arpeggio with a long echo over a soft pad and pulse. 100 bpm, A minor."""
    rng = np.random.default_rng(127)
    beat = 60 / 100
    sixteenth = beat / 4
    chords = [  # Am, F, C, G
        dict(bass=33, arp=[57, 60, 64, 69], pad=[45, 57, 60, 64]),
        dict(bass=29, arp=[57, 60, 65, 69], pad=[41, 57, 60, 65]),
        dict(bass=36, arp=[55, 60, 64, 67], pad=[48, 55, 60, 64]),
        dict(bass=31, arp=[55, 59, 62, 67], pad=[43, 55, 59, 62]),
    ]
    order = [0, 1, 2, 3, 2, 1, 2, 3, 0, 2, 1, 3, 2, 3, 1, 2]
    bars = int((LENGTH + 4) / (4 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 4 * beat
        add(buf, saw_pad([hz(m) for m in c["pad"]], 4 * beat + 1.2, 0.8, 1.2, 900), t0, 0.0, 0.5)
        for k in range(16):
            note = c["arp"][order[k]] + (12 if k % 8 >= 4 else 0)
            tt = np.arange(int(SR * 0.4)) / SR
            f = hz(note)
            tone = sum(np.sin(2 * np.pi * f * (1 + d) * tt) + 0.3 * np.sin(2 * np.pi * 2 * f * (1 + d) * tt) for d in (-0.004, 0.0, 0.004)) / 3
            tone = tone * np.minimum(tt / 0.004, 1.0) * np.exp(-tt * 9) * (0.55 if k % 4 == 0 else 0.4)
            add(buf, tone, t0 + k * sixteenth, (k % 8 - 4) / 9, 0.55)
        add(buf, epiano(hz(c["bass"]), 1.8 * beat, 0.7), t0, 0.0, 0.8)
        add(buf, epiano(hz(c["bass"]), 1.4 * beat, 0.6), t0 + 2 * beat, 0.0, 0.7)
        if bar >= 1:
            for k in range(4):
                add(buf, kick(0.7), t0 + k * beat, 0.0, 0.5)
            for k in (1, 3):
                add(buf, snare(rng, 0.5), t0 + k * beat, 0.0, 0.4)
    buf = buf[:, : int(LENGTH * SR)]
    buf = echo(buf, beat * 0.75, 0.5, 0.4, 5)
    finish(reverb(buf, 2.2, 0.4, 131), "neon", MATCH)


def parade():
    """Playful and bouncy: marimba-like plucks, a hopping bass and a shaker. 116 bpm, F major."""
    rng = np.random.default_rng(137)
    beat = 60 / 116
    chords = [  # F, Bb, C, F
        dict(bass=41, hop=[53, 57, 60], tune=[72, 74, 76, 77, 79, 81]),
        dict(bass=46, hop=[53, 58, 62], tune=[70, 74, 77, 79, 81, 82]),
        dict(bass=36, hop=[55, 60, 64], tune=[72, 74, 76, 79, 81, 84]),
        dict(bass=41, hop=[53, 57, 60], tune=[72, 76, 77, 79, 81, 84]),
    ]
    bars = int((LENGTH + 4) / (4 * beat)) + 1
    buf = np.zeros((2, int((LENGTH + 4) * SR)))
    step = 2
    for bar in range(bars):
        c = chords[bar % 4]
        t0 = bar * 4 * beat
        for k in range(4):  # oom-pah: bass on the beat, a short chord on the off-beat
            add(buf, pluck(hz(c["bass"] + (12 if k % 2 else 0)), 0.5 * beat, 0.8), t0 + k * beat, -0.2, 0.9)
            for note in c["hop"]:
                add(buf, pluck(hz(note + 12), 0.35 * beat, 0.45), t0 + (k + 0.5) * beat, (note - 58) / 20, 0.55)
        if bar >= 1:
            for j in range(8):
                step = int(np.clip(step + rng.choice([-2, -1, 1, 2]), 0, 5))
                if rng.random() < 0.7:
                    add(buf, pluck(hz(c["tune"][step]), 0.9 * beat, 0.75), t0 + j * beat / 2, 0.25, 0.8)
            for j in range(8):
                add(buf, shaker(rng, 0.8 if j % 2 else 0.55), t0 + j * beat / 2, 0.3, 0.4)
    buf = buf[:, : int(LENGTH * SR)]
    finish(reverb(buf, 1.1, 0.22, 139), "parade", MATCH)


BUILDERS = dict(gentle=gentle, warm=warm, sunny=sunny, musicbox=musicbox, waltz=waltz, calm=calm, golden=golden, cafe=cafe, porch=porch, aurora=aurora, neon=neon, parade=parade)

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:] or list(BUILDERS):
        BUILDERS[name]()
