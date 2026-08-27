// Offline harness that runs public/vocoder-processor.js outside the browser.
// Node has no AudioWorkletGlobalScope, so the two globals the processor relies
// on are stubbed here and the module is imported for its registerProcessor call.

import { fileURLToPath } from 'node:url'

export const SAMPLE_RATE = 48_000
export const BLOCK_SIZE = 128

let Processor = null

export async function loadProcessor(sampleRate = SAMPLE_RATE) {
  if (Processor) return Processor
  globalThis.sampleRate = sampleRate
  globalThis.currentTime = 0
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} }
    }
  }
  globalThis.registerProcessor = (_name, implementation) => { Processor = implementation }
  await import(fileURLToPath(new URL('../../public/vocoder-processor.js', import.meta.url)))
  if (!Processor) throw new Error('vocoder-processor.js did not call registerProcessor')
  return Processor
}

export const DEFAULT_SETTINGS = {
  bands: 20, low: 100, high: 8000, formant: 0, character: 0.35,
  attack: 10, release: 180, mix: 1, width: 0, inputGain: 0,
  gate: -80, output: 0, limiter: false, monitor: false,
}

export async function makeProcessor(settings = {}) {
  const Implementation = await loadProcessor()
  const processor = new Implementation()
  const meters = []
  processor.port.postMessage = (message) => meters.push(message)
  processor.port.onmessage({ data: { type: 'settings', settings: { ...DEFAULT_SETTINGS, ...settings } } })
  processor.rebuild()
  return { processor, meters }
}

// Renders modulator + carrier through the processor and returns both channels.
export function render(processor, modulator, carrier) {
  const frames = Math.floor(modulator.length / BLOCK_SIZE) * BLOCK_SIZE
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const silence = new Float32Array(BLOCK_SIZE)
  for (let offset = 0; offset < frames; offset += BLOCK_SIZE) {
    const block = [new Float32Array(BLOCK_SIZE), new Float32Array(BLOCK_SIZE)]
    processor.process([
      [modulator.subarray(offset, offset + BLOCK_SIZE)],
      [carrier ? carrier.subarray(offset, offset + BLOCK_SIZE) : silence],
    ], [block])
    left.set(block[0], offset)
    right.set(block[1], offset)
  }
  return { left, right, frames }
}

// ---------------------------------------------------------------------------
// Signal generators and measurements
// ---------------------------------------------------------------------------

export const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12)

export function noise(length, seed = 1, amplitude = 0.15) {
  let state = seed >>> 0
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[index] = (state / 2 ** 32 - 0.5) * 2 * amplitude
  }
  return out
}

export function sine(length, frequency, amplitude = 0.2, sampleRate = SAMPLE_RATE) {
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    out[index] = Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude
  }
  return out
}

// Two-pole resonator, used to build formant-like and sibilant-like test signals.
export function resonate(source, frequency, radius = 0.985, sampleRate = SAMPLE_RATE) {
  const out = new Float32Array(source.length)
  const omega = 2 * Math.PI * frequency / sampleRate
  const a1 = -2 * radius * Math.cos(omega)
  const a2 = radius * radius
  let y1 = 0
  let y2 = 0
  for (let index = 0; index < source.length; index += 1) {
    const y = source[index] - a1 * y1 - a2 * y2
    y2 = y1
    y1 = y
    out[index] = y * (1 - radius) * 2
  }
  return out
}

// Reproduces exactly what VocoderEngine sends to the worklet's carrier input:
// per-note gain max(0.025, velocity/127/4), unison detune, carrier bus at 0.16.
export function carrierFor(notes, length, { velocity = 96, unison = 2, waveform = 'sawtooth', busGain = 0.16 } = {}) {
  const detunes = unison >= 3 ? [-10, 0, 10] : unison === 2 ? [-6, 6] : [0]
  const noteGain = Math.max(0.025, velocity / 127 / 4)
  const out = new Float32Array(length)
  for (const note of notes) {
    for (const cents of detunes) {
      const frequency = midiToHz(note) * 2 ** (cents / 1200)
      let phase = 0
      for (let index = 0; index < length; index += 1) {
        const value = waveform === 'square' ? (phase < 0.5 ? 1 : -1)
          : waveform === 'triangle' ? 4 * Math.abs(phase - 0.5) - 1
            : waveform === 'sine' ? Math.sin(2 * Math.PI * phase)
              : phase * 2 - 1
        out[index] += value * (noteGain / detunes.length) * busGain
        phase = (phase + frequency / SAMPLE_RATE) % 1
      }
    }
  }
  return out
}

export const rms = (values) => {
  let sum = 0
  for (const value of values) sum += value * value
  return Math.sqrt(sum / values.length)
}
export const rmsDb = (values) => 20 * Math.log10(rms(values) + 1e-12)
export const peak = (values) => {
  let highest = 0
  for (const value of values) highest = Math.max(highest, Math.abs(value))
  return highest
}
export const peakDb = (values) => 20 * Math.log10(peak(values) + 1e-12)

// In-place radix-2 FFT.
export function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]];[im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const w = angle * k
        const wr = Math.cos(w)
        const wi = Math.sin(w)
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr
        re[i + k] = ur + vr; im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
      }
    }
  }
}

// Mean power per bin in `count` log-spaced bands, in dB.
export function logSpectrum(signal, offset, { size = 2048, low = 100, high = 8000, count = 24 } = {}) {
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let i = 0; i < size; i += 1) {
    re[i] = (signal[offset + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size))
  }
  fft(re, im)
  const bands = []
  for (let band = 0; band < count; band += 1) {
    const from = low * (high / low) ** (band / count)
    const to = low * (high / low) ** ((band + 1) / count)
    const k0 = Math.max(1, Math.round(from * size / SAMPLE_RATE))
    const k1 = Math.min(size / 2 - 1, Math.round(to * size / SAMPLE_RATE))
    let sum = 0
    for (let k = k0; k <= k1; k += 1) sum += re[k] ** 2 + im[k] ** 2
    bands.push(10 * Math.log10(sum / Math.max(1, k1 - k0 + 1) + 1e-14))
  }
  return bands
}

export function correlation(a, b) {
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  const ma = mean(a)
  const mb = mean(b)
  let product = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < a.length; i += 1) {
    product += (a[i] - ma) * (b[i] - mb)
    sa += (a[i] - ma) ** 2
    sb += (b[i] - mb) ** 2
  }
  return product / Math.sqrt(sa * sb + 1e-24)
}

// Analytic magnitude response of one Biquad instance.
export function biquadMagnitude(filter, frequency, sampleRate = SAMPLE_RATE) {
  const w = 2 * Math.PI * frequency / sampleRate
  const nr = filter.b0 + filter.b1 * Math.cos(-w) + filter.b2 * Math.cos(-2 * w)
  const ni = filter.b1 * Math.sin(-w) + filter.b2 * Math.sin(-2 * w)
  const dr = 1 + filter.a1 * Math.cos(-w) + filter.a2 * Math.cos(-2 * w)
  const di = filter.a1 * Math.sin(-w) + filter.a2 * Math.sin(-2 * w)
  return Math.hypot(nr, ni) / Math.hypot(dr, di)
}

// Total harmonic distortion of `signal` against a known fundamental, in percent.
export function thd(signal, fundamental, size = 1 << 14) {
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const start = Math.max(0, signal.length - size)
  for (let i = 0; i < size; i += 1) {
    re[i] = (signal[start + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size))
  }
  fft(re, im)
  const magnitudeAt = (frequency) => {
    const k = Math.round(frequency * size / SAMPLE_RATE)
    let best = 0
    for (let j = k - 2; j <= k + 2; j += 1) {
      if (j > 0 && j < size / 2) best = Math.max(best, Math.hypot(re[j], im[j]))
    }
    return best
  }
  const base = magnitudeAt(fundamental)
  let harmonics = 0
  for (let n = 2; n <= 9; n += 1) {
    if (fundamental * n < SAMPLE_RATE / 2) harmonics += magnitudeAt(fundamental * n) ** 2
  }
  return 100 * Math.sqrt(harmonics) / Math.max(base, 1e-12)
}

// Fraction of a signal's total energy that sits above `split` Hz. Robust to the
// tonal-versus-noise difference between a vocoder's input and its output, which
// per-bin power density is not.
export function highBandShare(signal, split = 4000, size = 4096) {
  let high = 0
  let total = 0
  for (let offset = size; offset + size < signal.length; offset += size) {
    const re = new Float64Array(size)
    const im = new Float64Array(size)
    for (let i = 0; i < size; i += 1) {
      re[i] = (signal[offset + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size))
    }
    fft(re, im)
    const kSplit = Math.round(split * size / SAMPLE_RATE)
    for (let k = 1; k < size / 2; k += 1) {
      const power = re[k] ** 2 + im[k] ** 2
      total += power
      if (k >= kSplit) high += power
    }
  }
  return high / Math.max(total, 1e-24)
}
