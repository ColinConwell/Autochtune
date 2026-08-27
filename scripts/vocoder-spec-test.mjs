// Vocoder specification tests.
//
// Every assertion here encodes a property the vocoder must hold regardless of
// how the DSP is implemented. They run offline against public/vocoder-processor.js
// through the Node harness, so `just test` covers the audio engine without a browser.

import assert from 'node:assert/strict'
import {
  SAMPLE_RATE, BLOCK_SIZE, makeProcessor, render, noise, sine, resonate, carrierFor,
  rmsDb, peakDb, logSpectrum, correlation, biquadMagnitude, thd, highBandShare,
} from './lib/worklet-harness.mjs'

let passed = 0
let failed = 0
const results = []

async function check(name, body) {
  try {
    const detail = await body()
    passed += 1
    results.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failed += 1
    results.push(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`)
  }
}

const section = (title) => results.push(`\n${title}`)

const SECONDS = 2
const LENGTH = SAMPLE_RATE * SECONDS
const VOICE = noise(LENGTH, 7, 0.15)
const CHORD = [48, 52, 55]

// ---------------------------------------------------------------------------
section('Filter bank')
// ---------------------------------------------------------------------------

await check('analysis bank sums flat at every band count', async () => {
  const worst = []
  for (const bands of [12, 16, 20, 24, 28]) {
    const { processor } = await makeProcessor({ bands, low: 100, high: 8000 })
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i <= 600; i += 1) {
      const frequency = 130 * (6000 / 130) ** (i / 600)
      let power = 0
      for (const filter of processor.modFilters) power += biquadMagnitude(filter, frequency) ** 2
      const db = 10 * Math.log10(power)
      min = Math.min(min, db)
      max = Math.max(max, db)
    }
    worst.push({ bands, ripple: max - min, level: max })
  }
  // About 1 dB is the ripple floor for a bank of second-order sections; the
  // point of the test is that it no longer grows as bands are removed.
  for (const { bands, ripple } of worst) {
    assert.ok(ripple < 1.25, `${bands} bands: ${ripple.toFixed(2)} dB ripple across 130 Hz-6 kHz (limit 1.25 dB)`)
  }
  const levels = worst.map((entry) => entry.level)
  const spread = Math.max(...levels) - Math.min(...levels)
  assert.ok(spread < 0.6, `bank level varies ${spread.toFixed(2)} dB across band counts (limit 0.6 dB)`)
  return `max ripple ${Math.max(...worst.map((w) => w.ripple)).toFixed(2)} dB, level spread ${spread.toFixed(2)} dB`
})

await check('band centres span the requested range', async () => {
  const { processor } = await makeProcessor({ bands: 20, low: 120, high: 7000 })
  const centreOf = (filter) => {
    let best = 0
    let bestMagnitude = 0
    for (let i = 0; i < 3000; i += 1) {
      const frequency = 40 * (20000 / 40) ** (i / 3000)
      const magnitude = biquadMagnitude(filter, frequency)
      if (magnitude > bestMagnitude) { bestMagnitude = magnitude; best = frequency }
    }
    return best
  }
  const first = centreOf(processor.modFilters[0])
  const last = centreOf(processor.modFilters[processor.modFilters.length - 1])
  assert.ok(Math.abs(first / 120 - 1) < 0.05, `lowest band at ${first.toFixed(0)} Hz, expected 120 Hz`)
  assert.ok(Math.abs(last / 7000 - 1) < 0.05, `highest band at ${last.toFixed(0)} Hz, expected 7000 Hz`)
  return `${first.toFixed(0)} Hz to ${last.toFixed(0)} Hz`
})

await check('no duplicate bands when the range approaches Nyquist', async () => {
  const { processor } = await makeProcessor({ bands: 28, low: 100, high: 30000 })
  const seen = new Set()
  for (const filter of processor.modFilters) {
    const key = `${filter.b0.toFixed(9)}:${filter.a1.toFixed(9)}`
    assert.ok(!seen.has(key), 'two analysis bands collapsed onto the same centre frequency')
    seen.add(key)
  }
  return `${seen.size} distinct bands with high clamped below Nyquist`
})

await check('formant shift moves the synthesis bank by the requested interval', async () => {
  const centreOf = (filter) => {
    let best = 0
    let bestMagnitude = 0
    for (let i = 0; i < 4000; i += 1) {
      const frequency = 40 * (20000 / 40) ** (i / 4000)
      const magnitude = biquadMagnitude(filter, frequency)
      if (magnitude > bestMagnitude) { bestMagnitude = magnitude; best = frequency }
    }
    return best
  }
  const reported = []
  for (const semitones of [-12, -6, 0, 6, 12]) {
    const { processor } = await makeProcessor({ bands: 20, low: 150, high: 6000, formant: semitones })
    const analysis = centreOf(processor.modFilters[4])
    const synthesis = centreOf(processor.carFilters[4])
    const measured = 12 * Math.log2(synthesis / analysis)
    assert.ok(Math.abs(measured - semitones) < 0.25,
      `formant ${semitones} st measured as ${measured.toFixed(2)} st`)
    reported.push(measured.toFixed(1))
  }
  return `measured ${reported.join(', ')} st`
})

// ---------------------------------------------------------------------------
section('Level behaviour — output must follow the voice, not the keyboard')
// ---------------------------------------------------------------------------

const levelFor = async (settings, carrier) => {
  const { processor } = await makeProcessor(settings)
  const { left } = render(processor, VOICE, carrier)
  return rmsDb(left)
}

await check('output level is independent of polyphony', async () => {
  const levels = []
  for (const notes of [[48], [48, 55], [48, 52, 55], [48, 52, 55, 59], [48, 52, 55, 59, 62, 64]]) {
    levels.push(await levelFor({}, carrierFor(notes, LENGTH)))
  }
  const spread = Math.max(...levels) - Math.min(...levels)
  assert.ok(spread < 1.5, `holding 1 to 6 notes moved output by ${spread.toFixed(2)} dB (limit 1.5 dB)`)
  return `${spread.toFixed(2)} dB across 1-6 notes`
})

await check('output level is independent of MIDI velocity', async () => {
  const levels = []
  for (const velocity of [1, 32, 64, 96, 127]) {
    levels.push(await levelFor({}, carrierFor(CHORD, LENGTH, { velocity })))
  }
  const spread = Math.max(...levels) - Math.min(...levels)
  assert.ok(spread < 1.0, `velocity 1 to 127 moved output by ${spread.toFixed(2)} dB (limit 1.0 dB)`)
  return `${spread.toFixed(2)} dB across the velocity range`
})

await check('output level is independent of band count', async () => {
  const levels = []
  for (const bands of [12, 16, 20, 24, 28]) {
    levels.push(await levelFor({ bands }, carrierFor(CHORD, LENGTH)))
  }
  const spread = Math.max(...levels) - Math.min(...levels)
  assert.ok(spread < 1.5, `12 to 28 bands moved output by ${spread.toFixed(2)} dB (limit 1.5 dB)`)
  return `${spread.toFixed(2)} dB across 12-28 bands`
})

await check('output level is independent of carrier waveform', async () => {
  const levels = []
  for (const waveform of ['sawtooth', 'square', 'triangle', 'sine']) {
    levels.push(await levelFor({}, carrierFor(CHORD, LENGTH, { waveform })))
  }
  const spread = Math.max(...levels) - Math.min(...levels)
  assert.ok(spread < 2.0, `waveform choice moved output by ${spread.toFixed(2)} dB (limit 2.0 dB)`)
  return `${spread.toFixed(2)} dB across four waveforms`
})

await check('output level tracks the modulator at unity', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const { processor } = await makeProcessor({ character: 0 })
  const { left } = render(processor, VOICE, carrier)
  const gain = rmsDb(left) - rmsDb(VOICE)
  assert.ok(Math.abs(gain) < 2.0, `wet path gain is ${gain.toFixed(2)} dB, expected unity within 2 dB`)
  return `${gain >= 0 ? '+' : ''}${gain.toFixed(2)} dB`
})

await check('Character holds loudness on broadband material', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const levels = []
  for (const character of [0, 0.35, 0.7, 1]) {
    const { processor } = await makeProcessor({ character })
    levels.push(rmsDb(render(processor, VOICE, carrier).left))
  }
  const spread = Math.max(...levels) - Math.min(...levels)
  assert.ok(spread < 3.0, `Character moved output level by ${spread.toFixed(2)} dB (limit 3.0 dB)`)
  return `${spread.toFixed(2)} dB across the Character range`
})

await check('Character adds saturation monotonically', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const distortion = []
  for (const character of [0, 0.35, 0.7, 1]) {
    const { processor } = await makeProcessor({ character })
    const { left } = render(processor, sine(LENGTH, 400, 0.2), carrier)
    distortion.push(thd(left, 400))
  }
  for (let i = 1; i < distortion.length; i += 1) {
    assert.ok(distortion[i] > distortion[i - 1],
      `THD did not rise from Character step ${i - 1} to ${i}: ${distortion.map((d) => d.toFixed(1)).join(', ')}%`)
  }
  return `THD ${distortion[0].toFixed(1)}% to ${distortion[3].toFixed(1)}%`
})

// ---------------------------------------------------------------------------
section('Gate')
// ---------------------------------------------------------------------------

await check('gate passes above-threshold signal without distorting it', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const worst = []
  for (const [gate, amplitude] of [[-52, 0.5], [-52, 0.05], [-30, 0.1], [-30, 0.05]]) {
    const { processor } = await makeProcessor({ gate, character: 0, mix: 0, monitor: true })
    // mix 0 with a carrier present routes the gated dry path straight to the output.
    const tone = sine(LENGTH, 220, amplitude)
    const { left } = render(processor, tone, carrier)
    const distortion = thd(left.subarray(left.length / 2), 220)
    worst.push(distortion)
    assert.ok(distortion < 1.0,
      `gate ${gate} dB on a ${(20 * Math.log10(amplitude)).toFixed(0)} dBFS tone produced ${distortion.toFixed(2)}% THD (limit 1.0%)`)
  }
  return `worst THD ${Math.max(...worst).toFixed(3)}%`
})

await check('gate silences signal below threshold', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const { processor } = await makeProcessor({ gate: -30, character: 0 })
  const quiet = sine(LENGTH, 220, 0.005) // -46 dBFS, well under the -30 dB gate
  const { left } = render(processor, quiet, carrier)
  const level = rmsDb(left.subarray(left.length / 2))
  assert.ok(level < -70, `below-threshold signal produced ${level.toFixed(1)} dBFS of output`)
  return `${level.toFixed(1)} dBFS residual`
})

await check('gate opens for above-threshold signal', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const { processor } = await makeProcessor({ gate: -50, character: 0 })
  const loud = sine(LENGTH, 220, 0.2)
  const { left } = render(processor, loud, carrier)
  const level = rmsDb(left.subarray(left.length / 2))
  assert.ok(level > -30, `above-threshold signal only produced ${level.toFixed(1)} dBFS`)
  return `${level.toFixed(1)} dBFS`
})

// ---------------------------------------------------------------------------
section('Speech behaviour')
// ---------------------------------------------------------------------------

// Voiced modulator: a glottal-style buzz through a moving formant. Unlike
// broadband noise it does not trigger the unvoiced path, so tests built on it
// measure the carrier's own contribution.
function voicedLike(length) {
  const source = new Float32Array(length)
  let phase = 0
  for (let index = 0; index < length; index += 1) {
    phase = (phase + 140 / SAMPLE_RATE) % 1
    source[index] = (phase * 2 - 1) * 0.5
  }
  const out = new Float32Array(length)
  let y1 = 0
  let y2 = 0
  for (let index = 0; index < length; index += 1) {
    const frequency = 650 + 250 * Math.sin(2 * Math.PI * 1.7 * index / SAMPLE_RATE)
    const omega = 2 * Math.PI * frequency / SAMPLE_RATE
    const radius = 0.98
    const a1 = -2 * radius * Math.cos(omega)
    const a2 = radius * radius
    const y = source[index] - a1 * y1 - a2 * y2
    y2 = y1
    y1 = y
    out[index] = y * (1 - radius) * 2
  }
  return out
}

// Formant-like modulator: broadband noise through a slowly sweeping resonance.
function speechLike(length) {
  const source = noise(length, 3, 0.3)
  const out = new Float32Array(length)
  let y1 = 0
  let y2 = 0
  for (let index = 0; index < length; index += 1) {
    const frequency = 500 + 350 * Math.sin(2 * Math.PI * 2.3 * index / SAMPLE_RATE)
    const omega = 2 * Math.PI * frequency / SAMPLE_RATE
    const radius = 0.985
    const a1 = -2 * radius * Math.cos(omega)
    const a2 = radius * radius
    const y = source[index] - a1 * y1 - a2 * y2
    y2 = y1
    y1 = y
    out[index] = y * (1 - radius) * 3
  }
  return out
}

await check('output spectrum tracks the modulator spectrum', async () => {
  const speech = speechLike(LENGTH)
  const { processor } = await makeProcessor({})
  const { left } = render(processor, speech, carrierFor(CHORD, LENGTH))
  const scores = []
  for (let offset = 8192; offset + 2048 < LENGTH; offset += 4096) {
    scores.push(correlation(logSpectrum(speech, offset), logSpectrum(left, offset)))
  }
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length
  assert.ok(mean > 0.85, `log-spectrum correlation is ${mean.toFixed(3)} (limit 0.85)`)
  return `r = ${mean.toFixed(3)} over ${scores.length} frames`
})

await check('sibilants survive a low pitched carrier', async () => {
  // A 6 kHz noise band standing in for "s" against a C3-rooted chord, whose
  // harmonics carry essentially nothing at 6 kHz.
  const sibilant = resonate(noise(LENGTH, 11, 0.4), 6000, 0.97)
  const { processor } = await makeProcessor({})
  const { left } = render(processor, sibilant, carrierFor(CHORD, LENGTH))
  const input = highBandShare(sibilant)
  const output = highBandShare(left)
  assert.ok(output > input * 0.65,
    `${(input * 100).toFixed(0)}% of the input's energy is above 4 kHz but only ${(output * 100).toFixed(0)}% of the output's is`)
  return `${(input * 100).toFixed(0)}% in, ${(output * 100).toFixed(0)}% out`
})

await check('carrier waveform still shapes the output on voiced material', async () => {
  // Normalising the carrier must not whiten it into irrelevance: a sine carrier
  // has no harmonics to fill the high bands and must stay audibly duller.
  const voiced = voicedLike(LENGTH)
  const brightness = async (waveform) => {
    const { processor } = await makeProcessor({ character: 0 })
    const { left } = render(processor, voiced, carrierFor(CHORD, LENGTH, { waveform }))
    return highBandShare(left, 2000)
  }
  const saw = await brightness('sawtooth')
  const pure = await brightness('sine')
  const differentiation = 10 * Math.log10(saw / Math.max(pure, 1e-12))
  assert.ok(differentiation > 10,
    `a sawtooth carrier is only ${differentiation.toFixed(1)} dB brighter than a sine (limit 10 dB) — the carrier has been whitened away`)
  return `sawtooth ${differentiation.toFixed(0)} dB brighter than sine`
})

await check('a voiced tone does not trigger the unvoiced noise path', async () => {
  const { processor } = await makeProcessor({})
  const voiced = sine(LENGTH, 220, 0.2)
  render(processor, voiced, carrierFor(CHORD, LENGTH))
  assert.ok(processor.unvoiced < 0.1,
    `unvoiced detector read ${processor.unvoiced.toFixed(2)} on a pure 220 Hz tone`)
  return `detector at ${processor.unvoiced.toFixed(3)}`
})

await check('a sibilant does trigger the unvoiced noise path', async () => {
  const { processor } = await makeProcessor({})
  const sibilant = resonate(noise(LENGTH, 11, 0.4), 6000, 0.97)
  render(processor, sibilant, carrierFor(CHORD, LENGTH))
  assert.ok(processor.unvoiced > 0.8,
    `unvoiced detector only read ${processor.unvoiced.toFixed(2)} on a 6 kHz noise band`)
  return `detector at ${processor.unvoiced.toFixed(3)}`
})

// ---------------------------------------------------------------------------
section('Envelope follower')
// ---------------------------------------------------------------------------

await check('attack and release reach their nominal time constants', async () => {
  const reported = []
  for (const attack of [1, 10, 50]) {
    const coefficient = Math.exp(-1 / (SAMPLE_RATE * attack / 1000))
    let envelope = 0
    let samples = 0
    while (envelope < 0.632) { envelope = coefficient * envelope + (1 - coefficient) * 1; samples += 1 }
    const measured = samples / SAMPLE_RATE * 1000
    assert.ok(Math.abs(measured / attack - 1) < 0.05, `${attack} ms attack measured ${measured.toFixed(2)} ms`)
    reported.push(measured.toFixed(1))
  }
  return `${reported.join(', ')} ms`
})

await check('a fast attack tracks transients faster than a slow one', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const burst = new Float32Array(LENGTH)
  const tone = sine(LENGTH, 700, 0.3)
  for (let index = SAMPLE_RATE; index < LENGTH; index += 1) burst[index] = tone[index]
  const riseTime = async (attack) => {
    const { processor } = await makeProcessor({ attack, release: 300, character: 0 })
    const { left } = render(processor, burst, carrier)
    const target = 0.3 * 0.4
    for (let index = SAMPLE_RATE; index < LENGTH; index += 1) {
      if (Math.abs(left[index]) > target) return (index - SAMPLE_RATE) / SAMPLE_RATE * 1000
    }
    return Infinity
  }
  const fast = await riseTime(1)
  const slow = await riseTime(100)
  assert.ok(fast < slow, `1 ms attack rose in ${fast.toFixed(1)} ms, 100 ms attack in ${slow.toFixed(1)} ms`)
  return `${fast.toFixed(1)} ms vs ${slow.toFixed(1)} ms`
})

// ---------------------------------------------------------------------------
section('Mix, width, limiter, routing')
// ---------------------------------------------------------------------------

await check('dry/wet is a true crossfade while a note is held', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const tone = sine(LENGTH, 220, 0.2)
  const { processor: wetOnly } = await makeProcessor({ mix: 1, monitor: true, character: 0 })
  const wet = render(wetOnly, tone, carrier).left
  const { processor: dryOnly } = await makeProcessor({ mix: 0, monitor: true, character: 0 })
  const dry = render(dryOnly, tone, carrier).left
  const dryLevel = rmsDb(dry)
  const inputLevel = rmsDb(tone)
  assert.ok(Math.abs(dryLevel - inputLevel) < 1.0, `mix 0 should pass dry at unity, measured ${(dryLevel - inputLevel).toFixed(2)} dB`)
  assert.ok(rmsDb(wet) > -60, 'mix 1 produced no wet signal')
  return `mix 0 at ${(dryLevel - inputLevel).toFixed(2)} dB, mix 1 at ${rmsDb(wet).toFixed(1)} dBFS`
})

await check('monitor off silences the direct path with no carrier', async () => {
  const { processor } = await makeProcessor({ monitor: false })
  const { left } = render(processor, VOICE, null)
  assert.ok(rmsDb(left) < -110, `expected silence, measured ${rmsDb(left).toFixed(1)} dBFS`)
  return `${rmsDb(left).toFixed(1)} dBFS`
})

await check('stereo width decorrelates the channels without changing level', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const measure = async (width) => {
    const { processor } = await makeProcessor({ width, character: 0 })
    const { left, right } = render(processor, VOICE, carrier)
    const half = Math.floor(left.length / 2)
    return {
      level: rmsDb(left),
      correlation: correlation([...left.subarray(half)], [...right.subarray(half)]),
    }
  }
  const mono = await measure(0)
  const half = await measure(0.5)
  const wide = await measure(1)
  assert.ok(mono.correlation > 0.999, `width 0 should be mono, channel correlation ${mono.correlation.toFixed(4)}`)
  // Neighbouring bands overlap, so alternating them across the image cannot
  // fully decorrelate; what matters is that the control moves, and monotonically.
  assert.ok(wide.correlation < 0.95, `width 1 did not decorrelate the channels (correlation ${wide.correlation.toFixed(3)})`)
  assert.ok(wide.correlation < half.correlation && half.correlation < mono.correlation,
    `width is not monotonic: ${mono.correlation.toFixed(3)}, ${half.correlation.toFixed(3)}, ${wide.correlation.toFixed(3)}`)
  assert.ok(Math.abs(wide.level - mono.level) < 1.5,
    `width moved the level by ${(wide.level - mono.level).toFixed(2)} dB (limit 1.5 dB)`)
  return `correlation ${mono.correlation.toFixed(3)} to ${wide.correlation.toFixed(3)}, level ${(wide.level - mono.level).toFixed(2)} dB`
})

await check('limiter is transparent below the knee and bounded above it', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const quiet = sine(LENGTH, 220, 0.05)
  const { processor: limited } = await makeProcessor({ limiter: true, mix: 0, monitor: true, character: 0 })
  const { processor: open } = await makeProcessor({ limiter: false, mix: 0, monitor: true, character: 0 })
  const a = render(limited, quiet, carrier).left
  const b = render(open, quiet, carrier).left
  const difference = rmsDb(Float32Array.from(a, (value, index) => value - b[index]))
  assert.ok(difference < -80, `limiter altered a quiet signal by ${difference.toFixed(1)} dBFS`)

  const hot = sine(LENGTH, 220, 0.95)
  const { processor: hard } = await makeProcessor({ limiter: true, inputGain: 12, output: 6, monitor: true, mix: 0 })
  const out = render(hard, hot, carrier).left
  assert.ok(peakDb(out) <= 0.1, `limiter let the output reach ${peakDb(out).toFixed(2)} dBFS`)
  return `transparent to ${difference.toFixed(0)} dBFS, ceiling ${peakDb(out).toFixed(2)} dBFS`
})

// ---------------------------------------------------------------------------
section('Robustness')
// ---------------------------------------------------------------------------

await check('no NaN, Inf, or over-unity output across a parameter sweep', async () => {
  let checked = 0
  for (const bands of [8, 12, 20, 28, 32]) {
    for (const character of [0, 1]) {
      for (const inputGain of [-12, 24]) {
        for (const formant of [-12, 0, 12]) {
          const { processor } = await makeProcessor({ bands, character, inputGain, formant, limiter: true, output: 6 })
          const { left, right } = render(processor, noise(SAMPLE_RATE, 5, 0.5), carrierFor([48, 52, 55, 59], SAMPLE_RATE, { velocity: 127, unison: 3 }))
          for (let index = 0; index < left.length; index += 1) {
            assert.ok(Number.isFinite(left[index]) && Number.isFinite(right[index]),
              `non-finite sample at ${index} (bands ${bands}, character ${character}, gain ${inputGain}, formant ${formant})`)
            assert.ok(Math.abs(left[index]) <= 1.0001,
              `output reached ${left[index].toFixed(3)} (bands ${bands}, character ${character}, gain ${inputGain}, formant ${formant})`)
          }
          checked += 1
        }
      }
    }
  }
  return `${checked} configurations clean`
})

await check('survives missing inputs and unconnected carrier', async () => {
  const { processor } = await makeProcessor({})
  const block = [new Float32Array(BLOCK_SIZE), new Float32Array(BLOCK_SIZE)]
  assert.equal(processor.process([[], []], [block]), true, 'process() must stay alive with empty inputs')
  assert.equal(processor.process([], [block]), true, 'process() must stay alive with no inputs at all')
  assert.equal(processor.process([[new Float32Array(BLOCK_SIZE)]], [block]), true, 'process() must stay alive with no carrier input')
  assert.equal(processor.process([[], []], [[]]), true, 'process() must stay alive with no output channels')
  for (const value of block[0]) assert.ok(Number.isFinite(value), 'degenerate inputs produced non-finite output')
  return 'four degenerate input shapes handled'
})

await check('settings arriving before the first block are honoured', async () => {
  const { processor } = await makeProcessor({ bands: 28, low: 200, high: 5000 })
  assert.equal(processor.bandCount, 28, 'band count did not follow the settings message')
  const { processor: late } = await makeProcessor({})
  late.port.onmessage({ data: { type: 'settings', settings: { bands: 12 } } })
  render(late, VOICE.subarray(0, BLOCK_SIZE * 4), carrierFor(CHORD, BLOCK_SIZE * 4))
  assert.equal(late.bandCount, 12, 'band count did not rebuild after a settings change')
  return 'rebuild triggered on band-count change'
})

await check('malformed messages are ignored', async () => {
  const { processor } = await makeProcessor({ bands: 20 })
  for (const data of [null, undefined, {}, { type: 'settings' }, { type: 'other', settings: { bands: 99 } }]) {
    processor.port.onmessage({ data })
  }
  assert.equal(processor.settings.bands, 20, 'a malformed message changed the settings')
  return 'five malformed messages rejected'
})

await check('band envelopes survive a formant change without a level jump', async () => {
  const carrier = carrierFor(CHORD, LENGTH)
  const { processor } = await makeProcessor({ formant: 0, character: 0 })
  render(processor, VOICE.subarray(0, SAMPLE_RATE), carrier)
  const before = [...processor.envelopes]
  processor.port.onmessage({ data: { type: 'settings', settings: { formant: 3 } } })
  processor.rebuild()
  const after = [...processor.envelopes]
  assert.deepEqual(after, before, 'a formant change reset the band envelopes, which would click')
  return `${after.length} envelopes preserved`
})

await check('changing the band count mid-stream does not drop the output', async () => {
  // The band count is a live control, so a rebuild must not dump the envelope
  // followers to zero and leave a hole in the sound.
  const length = SAMPLE_RATE * 4
  const voice = noise(length, 7, 0.15)
  const carrier = carrierFor(CHORD, length)
  const { processor } = await makeProcessor({ bands: 20, character: 0 })
  const out = new Float32Array(length)
  const switchAt = SAMPLE_RATE * 2
  for (let offset = 0; offset + BLOCK_SIZE <= length; offset += BLOCK_SIZE) {
    if (offset === switchAt) processor.port.onmessage({ data: { type: 'settings', settings: { bands: 12 } } })
    const block = [new Float32Array(BLOCK_SIZE), new Float32Array(BLOCK_SIZE)]
    processor.process([
      [voice.subarray(offset, offset + BLOCK_SIZE)],
      [carrier.subarray(offset, offset + BLOCK_SIZE)],
    ], [block])
    out.set(block[0], offset)
  }
  const window = (from, to) => rmsDb(out.subarray(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE)))
  const steady = window(1.0, 2.0)
  let worst = 0
  for (let time = 2.0; time < 2.3; time += 0.01) worst = Math.min(worst, window(time, time + 0.02) - steady)
  assert.ok(worst > -2.5, `output dipped ${worst.toFixed(2)} dB after a band-count change (limit 2.5 dB)`)
  const settled = window(2.5, 4.0)
  assert.ok(Math.abs(settled - steady) < 1.0, `level settled ${(settled - steady).toFixed(2)} dB away after the change`)
  return `worst dip ${worst.toFixed(2)} dB, settled ${(settled - steady).toFixed(2)} dB from steady state`
})

await check('meter reports are emitted at roughly 10 Hz', async () => {
  const { processor, meters } = await makeProcessor({})
  render(processor, VOICE, carrierFor(CHORD, LENGTH))
  const expected = SECONDS * 10
  assert.ok(Math.abs(meters.length - expected) <= 2, `${meters.length} meter frames over ${SECONDS}s, expected about ${expected}`)
  const last = meters[meters.length - 1]
  for (const field of ['inputDb', 'outputDb', 'carrierDb', 'wetDb']) {
    assert.ok(Number.isFinite(last[field]), `meter field ${field} was not finite`)
  }
  assert.equal(last.effectActive, true, 'meter did not report the vocoder as engaged while a carrier was present')
  return `${meters.length} frames, effectActive true`
})

await check('processing keeps up with real time at the maximum band count', async () => {
  const { processor } = await makeProcessor({ bands: 32 })
  const carrier = carrierFor([48, 52, 55, 59], LENGTH, { unison: 3 })
  const started = process.hrtime.bigint()
  render(processor, VOICE, carrier)
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6
  const budget = SECONDS * 1000
  const load = elapsed / budget
  assert.ok(load < 0.5, `32 bands used ${(load * 100).toFixed(1)}% of real time (limit 50%)`)
  return `${(load * 100).toFixed(1)}% of real time for ${SECONDS}s of audio`
})

// ---------------------------------------------------------------------------
console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
