// Autochtune channel vocoder.
//
// Design notes that the numbers below depend on:
//
// - Bands are logarithmically spaced, and filter Q is derived from that spacing
//   (Q = sqrt(r) / (r - 1) for a band ratio r) so adjacent bands always cross at
//   -3 dB. A fixed Q leaves spectral holes at low band counts and over-overlaps
//   at high ones, which makes "Bands" behave like a loudness control.
// - Each synthesis band is normalised by its own excitation level, so output
//   loudness tracks the voice rather than how many keys are held, how hard they
//   were struck, or which waveform the carrier uses.
// - Unvoiced speech (sibilants, plosives) carries almost no energy at the
//   carrier's harmonics, so a pitched carrier cannot reproduce it. An
//   unvoiced-ness detector blends noise into the excitation to fill those bands.

const MIN_BANDS = 8
const MAX_BANDS = 32

// Restores unity gain through the normalised synthesis bank, so a full-band
// modulator at -20 dBFS leaves at about -20 dBFS with mix = 1, character = 0,
// output = 0. Verified by scripts/vocoder-spec-test.mjs.
const SYNTHESIS_MAKEUP = 0.60

// Character is a drive control with auto-makeup: the shaper's own gain at
// CHARACTER_REFERENCE (-20 dBFS, the nominal operating level) is divided back
// out, so turning it up adds saturation rather than volume.
const CHARACTER_REFERENCE = 0.1
const CHARACTER_MAX_DRIVE = 6

// Q follows the band spacing (Q = sqrt(r) / (r - 1) puts the -3 dB points on the
// neighbouring centres). Slightly wider than that minimises the residual ripple
// a bank of second-order sections leaves behind; ~1 dB is its floor.
const ANALYSIS_Q_SCALE = 0.8

// Excitation below this fraction of the carrier's own broadband level is not
// normalised up; without the floor, empty bands would amplify numerical noise.
const EXCITATION_FLOOR = 0.06
const ABSOLUTE_FLOOR = 1e-5

// The carrier is normalised in two stages. Its broadband level is divided out
// completely, which is what makes output loudness independent of polyphony,
// velocity, and how hard the carrier bus is driven. Its spectrum is only
// partially flattened: at 1.0 a sine carrier would sound as bright as a
// sawtooth, which is wrong, and at 0.0 sparse carriers leave audible holes
// between harmonics.
const CARRIER_WHITENING = 0.7

// Unvoiced detection: fraction of energy above UNVOICED_SPLIT_HZ, mapped from
// "clearly voiced" to "clearly unvoiced" across these two ratios.
const UNVOICED_SPLIT_HZ = 3800
const UNVOICED_LOW = 0.28
const UNVOICED_HIGH = 0.62
const UNVOICED_NOISE = 1.4

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value)
const dbToGain = (db) => 10 ** (db / 20)
const onePole = (ms, floorMs) => Math.exp(-1 / (sampleRate * Math.max(floorMs, ms) / 1000))

class Biquad {
  constructor() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0
  }

  // RBJ constant 0 dB peak-gain bandpass.
  bandpass(frequency, q) {
    const omega = 2 * Math.PI * clamp(frequency, 10, sampleRate * 0.47) / sampleRate
    const alpha = Math.sin(omega) / (2 * Math.max(0.25, q))
    const a0 = 1 + alpha
    this.b0 = alpha / a0
    this.b1 = 0
    this.b2 = -alpha / a0
    this.a1 = (-2 * Math.cos(omega)) / a0
    this.a2 = (1 - alpha) / a0
  }

  // RBJ high-pass, used by the unvoiced detector.
  highpass(frequency, q) {
    const omega = 2 * Math.PI * clamp(frequency, 10, sampleRate * 0.47) / sampleRate
    const alpha = Math.sin(omega) / (2 * q)
    const cos = Math.cos(omega)
    const a0 = 1 + alpha
    this.b0 = ((1 + cos) / 2) / a0
    this.b1 = (-(1 + cos)) / a0
    this.b2 = ((1 + cos) / 2) / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  reset() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0
  }

  process(x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    // Flush denormals; sustained silence otherwise leaves subnormal state behind.
    if (y > -1e-25 && y < 1e-25) y = 0
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y
    return y
  }
}

class AutochtuneVocoder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.settings = {
      bands: 20, low: 100, high: 8000, formant: 0, character: 0.35,
      attack: 10, release: 180, mix: 1, width: 0.86, inputGain: 0,
      gate: -52, output: -3, limiter: true, monitor: true,
    }
    this.modFilters = []
    this.carFilters = []
    this.envelopes = []
    this.excitation = []
    this.bandCount = 0
    this.needsRebuild = true

    this.unvoicedFilter = new Biquad()
    this.unvoicedFilter.highpass(UNVOICED_SPLIT_HZ, 0.707)
    this.totalEnv = 0
    this.highEnv = 0
    this.unvoiced = 0
    this.gateGain = 0
    this.gateEnv = 0
    this.gateOpen = false
    this.carrierEnv = 0
    this.noiseState = 0x9e3779b9

    this.meterFrames = 0
    this.inputSquares = 0
    this.outputSquares = 0
    this.carrierSquares = 0
    this.wetSquares = 0
    this.effectActive = false

    this.port.onmessage = ({ data }) => {
      if (data?.type !== 'settings' || !data.settings) return
      const key = (s) => `${s.bands}:${s.low}:${s.high}:${s.formant}`
      const before = key(this.settings)
      this.settings = { ...this.settings, ...data.settings }
      if (before !== key(this.settings)) this.needsRebuild = true
    }
  }

  // Deterministic xorshift; a worklet must not allocate, and a seeded generator
  // keeps the offline test suite reproducible.
  noise() {
    let x = this.noiseState
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    this.noiseState = x
    return x / 0x80000000 - 1
  }

  // Log-spaced plan whose Q follows the spacing, so the analysis bank sums flat
  // at every band count and "Bands" changes resolution rather than loudness.
  plan() {
    const count = Math.round(clamp(this.settings.bands, MIN_BANDS, MAX_BANDS))
    const ceiling = sampleRate * 0.45
    const high = clamp(this.settings.high, 400, ceiling)
    const low = clamp(this.settings.low, 20, high / 4)
    const ratio = (high / low) ** (1 / (count - 1))
    const q = clamp(ANALYSIS_Q_SCALE * Math.sqrt(ratio) / (ratio - 1), 0.6, 26)
    return { count, low, high, ratio, q, ceiling }
  }

  // Carries follower state across a rebuild. Bands are log-spaced, so band i of
  // the old layout and band i * (new / old) of the new one sit at the same place
  // in the spectrum; without this a band-count change dumps every envelope to
  // zero and the output dips for a few tens of milliseconds.
  static resample(source, count) {
    const out = new Float64Array(count)
    if (!source || source.length === 0) return out
    if (source.length === 1 || count === 1) { out.fill(source[0]); return out }
    for (let index = 0; index < count; index += 1) {
      const position = (index / (count - 1)) * (source.length - 1)
      const lower = Math.floor(position)
      const upper = Math.min(source.length - 1, lower + 1)
      const blend = position - lower
      out[index] = source[lower] * (1 - blend) + source[upper] * blend
    }
    return out
  }

  rebuild() {
    const { count, low, ratio, q, ceiling } = this.plan()
    const shift = 2 ** (this.settings.formant / 12)

    this.modFilters = new Array(count)
    this.carFilters = new Array(count)
    this.envelopes = AutochtuneVocoder.resample(this.envelopes, count)
    this.excitation = AutochtuneVocoder.resample(this.excitation, count)
    this.carrierGains = new Float64Array(count)

    for (let band = 0; band < count; band += 1) {
      const centre = low * ratio ** band
      const analysis = new Biquad()
      analysis.bandpass(centre, q)
      this.modFilters[band] = analysis

      const shifted = centre * shift
      const synthesis = new Biquad()
      // A slightly wider synthesis band fills the gaps a sparse harmonic
      // carrier leaves between analysis bands.
      synthesis.bandpass(shifted, q * 0.85)
      this.carFilters[band] = synthesis
      // Mute rather than fold bands a formant shift pushes past Nyquist;
      // clamping would stack duplicate bands on top of each other.
      this.carrierGains[band] = shifted < ceiling ? 1 : 0
    }

    this.bandCount = count
    this.needsRebuild = false
  }

  process(inputs, outputs) {
    const output = outputs[0]
    const left = output?.[0]
    if (!left) return true
    const frames = left.length
    if (frames === 0) return true
    if (this.needsRebuild) this.rebuild()

    const right = output[1]
    const mic = inputs[0]?.[0]
    const carrier = inputs[1]?.[0]
    const settings = this.settings
    const count = this.bandCount

    const inputGain = dbToGain(settings.inputGain)
    const outputGain = dbToGain(settings.output)
    const gateThreshold = dbToGain(settings.gate)
    // Hysteresis keeps the gate from chattering on a signal sitting on the line.
    const gateCloseThreshold = gateThreshold * 0.5
    const mix = clamp(settings.mix ?? 1, 0, 1)
    const width = clamp(settings.width ?? 0, 0, 1)
    const drive = 1 + clamp(settings.character ?? 0, 0, 1) * (CHARACTER_MAX_DRIVE - 1)
    const characterMakeup = CHARACTER_REFERENCE / Math.tanh(CHARACTER_REFERENCE * drive)

    const attack = onePole(settings.attack, 0.5)
    const release = onePole(settings.release, 5)
    const gateRise = onePole(2, 0.5)
    const gateFall = onePole(60, 5)
    const gateTrack = onePole(30, 5)
    const detectAttack = onePole(3, 0.5)
    const detectRelease = onePole(80, 5)
    const excitationSmooth = onePole(12, 1)
    const carrierSmooth = onePole(30, 1)

    let carrierBlockSquares = 0
    for (let i = 0; i < frames; i += 1) carrierBlockSquares += (carrier?.[i] ?? 0) ** 2
    const carrierActive = carrierBlockSquares / frames > 1e-8
    if (carrierActive) this.effectActive = true

    // With no held note, Monitor provides a quiet confidence feed. Once a
    // carrier is present, Dry/Wet becomes a true crossfade so 100% wet cannot
    // be masked by the original voice.
    const dryAmount = settings.monitor ? (carrierActive ? 1 - mix : 0.35) : 0

    for (let i = 0; i < frames; i += 1) {
      const dry = (mic?.[i] ?? 0) * inputGain
      const car = carrier?.[i] ?? 0
      const absDry = dry < 0 ? -dry : dry

      // Level-detecting gate. The signal itself is never reshaped; only a
      // smoothed gain is applied, so anything above threshold passes clean.
      const gateEnvCoefficient = absDry > this.gateEnv ? gateRise : gateTrack
      this.gateEnv = gateEnvCoefficient * this.gateEnv + (1 - gateEnvCoefficient) * absDry
      if (this.gateEnv > gateThreshold) this.gateOpen = true
      else if (this.gateEnv < gateCloseThreshold) this.gateOpen = false
      const gateTarget = this.gateOpen ? 1 : 0
      const gateCoefficient = gateTarget > this.gateGain ? gateRise : gateFall
      this.gateGain = gateCoefficient * this.gateGain + (1 - gateCoefficient) * gateTarget
      const mod = dry * this.gateGain

      // Unvoiced-ness: high-band share of the modulator's energy.
      const absMod = mod < 0 ? -mod : mod
      const high = this.unvoicedFilter.process(mod)
      const absHigh = high < 0 ? -high : high
      const totalCoefficient = absMod > this.totalEnv ? detectAttack : detectRelease
      this.totalEnv = totalCoefficient * this.totalEnv + (1 - totalCoefficient) * absMod
      const highCoefficient = absHigh > this.highEnv ? detectAttack : detectRelease
      this.highEnv = highCoefficient * this.highEnv + (1 - highCoefficient) * absHigh
      const highShare = this.totalEnv > ABSOLUTE_FLOOR ? this.highEnv / this.totalEnv : 0
      this.unvoiced = clamp((highShare - UNVOICED_LOW) / (UNVOICED_HIGH - UNVOICED_LOW), 0, 1)

      // Broadband carrier level, used both as the normalisation floor and to
      // keep injected noise silent when no key is held.
      const absCar = car < 0 ? -car : car
      this.carrierEnv = carrierSmooth * this.carrierEnv + (1 - carrierSmooth) * absCar
      const excite = car + this.noise() * this.unvoiced * UNVOICED_NOISE * this.carrierEnv
      const level = Math.max(this.carrierEnv, ABSOLUTE_FLOOR)
      const floor = level * EXCITATION_FLOOR

      let mid = 0
      let side = 0
      for (let band = 0; band < count; band += 1) {
        const analysed = this.modFilters[band].process(mod)
        const absAnalysed = analysed < 0 ? -analysed : analysed
        const envelopeCoefficient = absAnalysed > this.envelopes[band] ? attack : release
        this.envelopes[band] = envelopeCoefficient * this.envelopes[band]
          + (1 - envelopeCoefficient) * absAnalysed

        const excited = this.carFilters[band].process(excite) * this.carrierGains[band]
        const absExcited = excited < 0 ? -excited : excited
        this.excitation[band] = excitationSmooth * this.excitation[band]
          + (1 - excitationSmooth) * absExcited

        // Broadband normalisation makes output level follow the voice instead
        // of the chord or the velocity; the whitening term fills gaps between
        // carrier harmonics without erasing the waveform's own colour.
        const whitening = (level / Math.max(this.excitation[band], floor)) ** CARRIER_WHITENING
        const contribution = (excited / level) * whitening * this.envelopes[band]
        mid += contribution
        side += band % 2 === 0 ? contribution : -contribution
      }

      // Band contributions alternate across the stereo image. Neighbouring
      // bands overlap enough to stay correlated, so the cross terms cancel and
      // per-channel level holds without a width-dependent normalisation.
      //
      // Drive into tanh, then divide the shaper's reference gain back out, so
      // Character changes saturation rather than loudness.
      const unityL = (mid + width * side) * SYNTHESIS_MAKEUP
      const unityR = (mid - width * side) * SYNTHESIS_MAKEUP
      const shapeL = Math.tanh(unityL * drive) * characterMakeup
      const shapeR = Math.tanh(unityR * drive) * characterMakeup

      const wetL = shapeL * mix * outputGain
      const wetR = shapeR * mix * outputGain
      const dryOut = dry * dryAmount * outputGain
      let valueL = dryOut + wetL
      let valueR = dryOut + wetR
      if (settings.limiter) {
        valueL = softClip(valueL)
        valueR = softClip(valueR)
      }
      left[i] = valueL
      if (right) right[i] = valueR

      this.inputSquares += dry * dry
      this.outputSquares += valueL * valueL
      this.carrierSquares += car * car
      this.wetSquares += wetL * wetL
      this.meterFrames += 1
    }

    if (this.meterFrames >= sampleRate / 10) {
      const toDb = (squares) => 20 * Math.log10(Math.max(Math.sqrt(squares / this.meterFrames), 1e-6))
      this.port.postMessage({
        type: 'meter',
        inputDb: toDb(this.inputSquares),
        outputDb: toDb(this.outputSquares),
        carrierDb: toDb(this.carrierSquares),
        wetDb: toDb(this.wetSquares),
        effectActive: this.effectActive,
        unvoiced: this.unvoiced,
        gateGain: this.gateGain,
        bands: this.bandCount,
      })
      this.meterFrames = 0
      this.inputSquares = 0
      this.outputSquares = 0
      this.carrierSquares = 0
      this.wetSquares = 0
      this.effectActive = false
    }
    return true
  }
}

// Soft-knee ceiling: transparent below the knee, asymptotic to 1.0 above it.
// A bare tanh() distorts the whole signal, not just the peaks.
const KNEE = 0.7
function softClip(value) {
  const magnitude = value < 0 ? -value : value
  if (magnitude <= KNEE) return value
  const excess = (magnitude - KNEE) / (1 - KNEE)
  const shaped = KNEE + (1 - KNEE) * Math.tanh(excess)
  return value < 0 ? -shaped : shaped
}

registerProcessor('autochtune-vocoder', AutochtuneVocoder)
