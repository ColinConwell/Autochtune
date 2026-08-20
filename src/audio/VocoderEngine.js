const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12)

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
    if (!this.context || !this.carrierBus || this.voices.has(note)) return
    const now = this.context.currentTime
    const frequency = midiToHz(note + (this.settings.tune ?? 0))
    const gain = this.context.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(Math.max(0.025, velocity / 127 / 4), now + 0.012)
    const detunes = this.settings.unison >= 3 ? [-10, 0, 10] : this.settings.unison === 2 ? [-6, 6] : [0]
    const oscillators = detunes.map((detune, index) => {
      const oscillator = this.context.createOscillator()
      oscillator.type = this.settings.waveform ?? 'sawtooth'
      oscillator.frequency.setValueAtTime(frequency, now)
      oscillator.detune.value = detune * ((this.settings.spread ?? 55) / 55)
      const voiceGain = this.context.createGain()
      voiceGain.gain.value = 1 / detunes.length
      oscillator.connect(voiceGain).connect(gain)
      oscillator.start(now + index * 0.0003)
      return oscillator
    })
    gain.connect(this.carrierBus)
    this.voices.set(note, { gain, oscillators })
  }

  noteOff(note) {
    const voice = this.voices.get(note)
    if (!voice || !this.context) return
    const now = this.context.currentTime
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setTargetAtTime(0, now, 0.018)
    voice.oscillators.forEach((oscillator) => oscillator.stop(now + 0.15))
    setTimeout(() => {
      voice.gain.disconnect()
      this.voices.delete(note)
    }, 200)
  }

  async stop() {
    this.disconnectSource()
    await this.context?.close()
    this.context = null
    this.node = null
    this.stream = null
    this.sourceNode = null
    this.mediaElement = null
    this.mediaSource = null
    this.carrierBus = null
    this.voices.clear()
  }
}
