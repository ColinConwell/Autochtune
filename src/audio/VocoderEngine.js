const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12)
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

// Velocity no longer sets output loudness — the worklet normalises the carrier
// so the voice governs level. It sets carrier brightness instead, which is what
// a harder key press does to a plucked or bowed source.
const brightnessFor = (frequency, velocity) => {
  const amount = clamp(velocity, 1, 127) / 127
  return clamp(frequency * (2 + 60 * amount ** 1.5), 200, 18000)
}

export class VocoderEngine {
  constructor() {
    this.context = null
    this.node = null
    this.stream = null
    this.sourceNode = null
    this.mediaElement = null
    this.mediaSource = null
    this.carrierBus = null
    this.voices = new Map()
    this.settings = {}
    this.meterListener = null
    this.lastFrequency = null
  }

  setMeterListener(listener) {
    this.meterListener = listener
  }

  async ensureGraph() {
    if (this.context) {
      await this.context.resume()
      return
    }
    this.context = new AudioContext({ latencyHint: 'interactive' })
    await this.context.audioWorklet.addModule('/vocoder-processor.js')
    this.node = new AudioWorkletNode(this.context, 'autochtune-vocoder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    this.node.port.onmessage = ({ data }) => {
      if (data?.type === 'meter') this.meterListener?.(data)
    }
    this.carrierBus = this.context.createGain()
    this.carrierBus.gain.value = 0.16
    this.carrierBus.connect(this.node, 0, 1)
    this.node.connect(this.context.destination)
    this.update(this.settings)
    await this.context.resume()
  }

  disconnectSource() {
    this.sourceNode?.disconnect()
    this.sourceNode = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }

  async start(deviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        channelCount: 1,
      },
    })
    try {
      await this.ensureGraph()
      this.disconnectSource()
      this.stream = stream
      this.sourceNode = this.context.createMediaStreamSource(stream)
      this.sourceNode.connect(this.node, 0, 0)
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      throw error
    }
  }

  async startMediaElement(element) {
    if (!element) throw new Error('The audio sample player is not ready.')
    await this.ensureGraph()
    this.disconnectSource()
    if (!this.mediaSource) {
      // An element can be routed into Web Audio exactly once per document, so
      // the node is created here and then kept for the life of the page.
      this.mediaElement = element
      this.mediaSource = this.context.createMediaElementSource(element)
    } else if (this.mediaElement !== element) {
      throw new Error('The audio sample player changed unexpectedly. Reload the app and try again.')
    }
    this.sourceNode = this.mediaSource
    this.sourceNode.connect(this.node, 0, 0)
    await this.context.resume()
  }

  update(settings) {
    this.settings = { ...this.settings, ...settings }
    this.node?.port.postMessage({ type: 'settings', settings: this.settings })
  }

  noteOn(note, velocity = 100) {
    if (!this.context || !this.carrierBus) return
    // Re-attacking a key that is still releasing must start a new voice rather
    // than be swallowed, or fast repeated notes go missing.
    if (this.voices.has(note)) this.noteOff(note)

    const now = this.context.currentTime
    const frequency = midiToHz(note + (this.settings.tune ?? 0))
    // Glide is legato: a note slides from the previous one only while something
    // is already sounding, so an isolated note starts in tune.
    const glide = (this.settings.glide ?? 0) / 1000
    const legato = glide > 0.005 && this.voices.size > 0 && this.lastFrequency

    const gain = this.context.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.2, now + 0.012)

    const tone = this.context.createBiquadFilter()
    tone.type = 'lowpass'
    tone.Q.value = 0.7
    tone.frequency.setValueAtTime(brightnessFor(frequency, velocity), now)

    const detunes = this.settings.unison >= 3 ? [-10, 0, 10] : this.settings.unison === 2 ? [-6, 6] : [0]
    const unisonGains = []
    const oscillators = detunes.map((detune, index) => {
      const oscillator = this.context.createOscillator()
      oscillator.type = this.settings.waveform ?? 'sawtooth'
      if (legato) {
        oscillator.frequency.setValueAtTime(this.lastFrequency, now)
        oscillator.frequency.exponentialRampToValueAtTime(frequency, now + glide)
      } else {
        oscillator.frequency.setValueAtTime(frequency, now)
      }
      oscillator.detune.value = detune * ((this.settings.spread ?? 55) / 55)
      const voiceGain = this.context.createGain()
      voiceGain.gain.value = 1 / detunes.length
      unisonGains.push(voiceGain)
      oscillator.connect(voiceGain).connect(tone)
      oscillator.start(now + index * 0.0003)
      return oscillator
    })

    tone.connect(gain)
    gain.connect(this.carrierBus)
    this.lastFrequency = frequency
    this.voices.set(note, { gain, tone, oscillators, unisonGains })
  }

  noteOff(note) {
    const voice = this.voices.get(note)
    if (!voice || !this.context) return
    // Drop the voice from the active map straight away so the same key can be
    // re-attacked while this one is still releasing.
    this.voices.delete(note)
    const now = this.context.currentTime
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
    voice.gain.gain.setTargetAtTime(0, now, 0.018)
    const last = voice.oscillators[voice.oscillators.length - 1]
    // Tear down on the oscillator's own ended event; a wall-clock timer drifts
    // from audio time and does not fire reliably in a backgrounded tab.
    last.onended = () => {
      voice.oscillators.forEach((oscillator) => oscillator.disconnect())
      voice.unisonGains.forEach((unisonGain) => unisonGain.disconnect())
      voice.tone.disconnect()
      voice.gain.disconnect()
    }
    voice.oscillators.forEach((oscillator) => oscillator.stop(now + 0.15))
  }

  allNotesOff() {
    for (const note of [...this.voices.keys()]) this.noteOff(note)
    this.lastFrequency = null
  }

  // Releases the microphone and parks the graph. The AudioContext is kept alive
  // because an HTMLMediaElement can only ever be routed into Web Audio once,
  // so closing it would strand the sample player. Use dispose() to tear down.
  async stop() {
    this.allNotesOff()
    this.disconnectSource()
    if (this.context && this.context.state !== 'closed') await this.context.suspend()
  }

  async dispose() {
    this.allNotesOff()
    this.disconnectSource()
    if (this.context && this.context.state !== 'closed') await this.context.close()
    this.context = null
    this.node = null
    this.mediaElement = null
    this.mediaSource = null
    this.carrierBus = null
    this.voices.clear()
    this.lastFrequency = null
  }
}
