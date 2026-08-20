class BiquadBandpass {
  constructor() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0
  }
  configure(frequency, q) {
    const omega = 2 * Math.PI * Math.min(frequency, sampleRate * 0.45) / sampleRate
    const alpha = Math.sin(omega) / (2 * q)
    const a0 = 1 + alpha
    this.b0 = alpha / a0
    this.b1 = 0
    this.b2 = -alpha / a0
    this.a1 = (-2 * Math.cos(omega)) / a0
    this.a2 = (1 - alpha) / a0
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y
    return y
  }
}

class AutochtuneVocoder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.settings = { bands: 20, low: 100, high: 8000, formant: 0, character: 0.35, attack: 10, release: 180, mix: 1, inputGain: 0, gate: -52, output: -3, limiter: true, monitor: true }
    this.modFilters = []
    this.carFilters = []
    this.envelopes = []
    this.needsRebuild = true
    this.meterFrames = 0
    this.inputSquares = 0
    this.outputSquares = 0
    this.carrierSquares = 0
    this.wetSquares = 0
    this.effectActive = false
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'settings') return
      const before = `${this.settings.bands}:${this.settings.low}:${this.settings.high}:${this.settings.formant}`
      this.settings = { ...this.settings, ...data.settings }
      const after = `${this.settings.bands}:${this.settings.low}:${this.settings.high}:${this.settings.formant}`
      if (before !== after) this.needsRebuild = true
    }
  }

  rebuild() {
    const count = Math.max(8, Math.min(32, Math.round(this.settings.bands)))
    const ratio = (this.settings.high / this.settings.low) ** (1 / Math.max(1, count - 1))
    const shift = 2 ** (this.settings.formant / 12)
    this.modFilters = Array.from({ length: count }, (_, i) => {
      const filter = new BiquadBandpass(); filter.configure(this.settings.low * ratio ** i, 4.2); return filter
    })
    this.carFilters = Array.from({ length: count }, (_, i) => {
      const filter = new BiquadBandpass(); filter.configure(this.settings.low * ratio ** i * shift, 3.6); return filter
    })
    this.envelopes = Array.from({ length: count }, () => 0)
    this.needsRebuild = false
  }

  process(inputs, outputs) {
    if (this.needsRebuild) this.rebuild()
    const mic = inputs[0]?.[0]
    const carrier = inputs[1]?.[0]
    const output = outputs[0]
    if (!output?.[0]) return true
    const inputGain = 10 ** (this.settings.inputGain / 20)
    const outputGain = 10 ** (this.settings.output / 20)
    const gate = 10 ** (this.settings.gate / 20)
    const attack = Math.exp(-1 / (sampleRate * Math.max(0.001, this.settings.attack / 1000)))
    const release = Math.exp(-1 / (sampleRate * Math.max(0.005, this.settings.release / 1000)))
    let carrierBlockSquares = 0
    for (let i = 0; i < output[0].length; i += 1) carrierBlockSquares += (carrier?.[i] ?? 0) ** 2
    const carrierActive = carrierBlockSquares / output[0].length > 1e-8
    // With no held note, Monitor provides a quiet confidence feed. Once a
    // carrier is present, Dry/Wet becomes a true crossfade so 100% wet cannot
    // be masked by the original voice.
    const dryAmount = this.settings.monitor ? (carrierActive ? 1 - this.settings.mix : 0.35) : 0
    for (let i = 0; i < output[0].length; i += 1) {
      const dry = (mic?.[i] ?? 0) * inputGain
      const mod = Math.abs(dry) < gate ? 0 : dry
      const car = carrier?.[i] ?? 0
      let vocoded = 0
      for (let band = 0; band < this.modFilters.length; band += 1) {
        const analyzed = Math.abs(this.modFilters[band].process(mod))
        const coefficient = analyzed > this.envelopes[band] ? attack : release
        this.envelopes[band] = coefficient * this.envelopes[band] + (1 - coefficient) * analyzed
        vocoded += this.carFilters[band].process(car) * this.envelopes[band]
      }
      vocoded *= 37.5 / Math.sqrt(this.modFilters.length)
      const shaped = Math.tanh(vocoded * (1 + this.settings.character * 3))
      const wet = shaped * this.settings.mix * outputGain
      let value = dry * dryAmount * outputGain + wet
      if (this.settings.limiter) value = Math.tanh(value * 1.4) / 1.4
      output[0][i] = value
      if (output[1]) output[1][i] = value
      this.inputSquares += dry * dry
      this.outputSquares += value * value
      this.carrierSquares += car * car
      this.wetSquares += wet * wet
      this.effectActive ||= carrierActive
      this.meterFrames += 1
    }
    if (this.meterFrames >= sampleRate / 10) {
      const inputRms = Math.sqrt(this.inputSquares / this.meterFrames)
      const outputRms = Math.sqrt(this.outputSquares / this.meterFrames)
      const carrierRms = Math.sqrt(this.carrierSquares / this.meterFrames)
      const wetRms = Math.sqrt(this.wetSquares / this.meterFrames)
      this.port.postMessage({
        type: 'meter',
        inputDb: 20 * Math.log10(Math.max(inputRms, 1e-6)),
        outputDb: 20 * Math.log10(Math.max(outputRms, 1e-6)),
        carrierDb: 20 * Math.log10(Math.max(carrierRms, 1e-6)),
        wetDb: 20 * Math.log10(Math.max(wetRms, 1e-6)),
        effectActive: this.effectActive,
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

registerProcessor('autochtune-vocoder', AutochtuneVocoder)
