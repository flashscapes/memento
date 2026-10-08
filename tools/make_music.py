"""Synthesize Memento's two original instrumental tracks.

Usage: python3 tools/make_music.py   (needs numpy and scipy; ffmpeg encodes the mp3s)

Everything is generated from math: FM electric piano, soft pads, a little bell
tone, and algorithmic reverb. Deterministic (fixed seeds), so the files can be
rebuilt. Output: public/audio/gentle.mp3 and public/audio/warm.mp3, 120 s each.
"""
import subprocess
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

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


def add(buf, sig, start, pan=0.0, gain=1.0):
    i = int(start * SR)
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


def finish(buf, name):
    hp = butter(2, 40, btype="high", fs=SR, output="sos")
    buf = np.stack([sosfilt(hp, buf[0]), sosfilt(hp, buf[1])])
    n = buf.shape[1]
    fi, fo = int(0.5 * SR), int(5.0 * SR)
    buf[:, :fi] *= np.linspace(0, 1, fi)
    buf[:, n - fo:] *= np.linspace(1, 0, fo) ** 1.5
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
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame",
                    "-b:a", "96k", str(OUT / f"{name}.mp3")], check=True)
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


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    gentle()
    warm()
