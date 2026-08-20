import assert from 'node:assert/strict'

globalThis.sampleRate = 48_000
let Processor

globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} }
  }
}
globalThis.registerProcessor = (_name, implementation) => { Processor = implementation }

await import('../public/vocoder-processor.js')

const blockSize = 128
const sineBlock = (frequency, block) => Float32Array.from(
  { length: blockSize },
  (_, index) => Math.sin(2 * Math.PI * frequency * (block * blockSize + index) / sampleRate) * 0.2,
)
const silentBlock = () => new Float32Array(blockSize)
const rms = (values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)

function render({ monitor, carrier = false, blocks = 80 }) {
  const processor = new Processor()
  processor.port.onmessage({ data: { type: 'settings', settings: {
    monitor, mix: 1, inputGain: 0, output: 0, gate: -80, limiter: false,
  } } })
  let lastOutput
  for (let block = 0; block < blocks; block += 1) {
    lastOutput = [silentBlock(), silentBlock()]
    processor.process(
      [[sineBlock(220, block)], [carrier ? sineBlock(130.81, block) : silentBlock()]],
      [lastOutput],
    )
  }
  return rms(lastOutput[0])
}

assert.ok(render({ monitor: true }) > 0.02, 'monitoring should pass an audible direct microphone signal while no key is held')
assert.ok(render({ monitor: false }) < 1e-6, 'disabling monitor should silence the direct microphone path without a carrier')
const wetOnly = render({ monitor: false, carrier: true })
const keyedWithMonitor = render({ monitor: true, carrier: true })
assert.ok(wetOnly > 1e-4, 'a keyed carrier should produce processed vocal output')
assert.ok(Math.abs(keyedWithMonitor - wetOnly) / wetOnly < 0.01, '100% wet must not leak the direct voice while a key is held')

console.log('Audio routing checks passed')
