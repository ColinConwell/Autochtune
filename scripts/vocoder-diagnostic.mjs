import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SAMPLE_RATE = 48_000
const BLOCK_SIZE = 128
const writeIndex = process.argv.indexOf('--write')
const outputDirectory = writeIndex >= 0 ? resolve(process.argv[writeIndex + 1] ?? '/tmp/autochtune-vocoder-diagnostic') : null
const sourceArgument = process.argv.slice(2).find((argument, index, values) => argument !== '--write' && values[index - 1] !== '--write')
const sourcePath = resolve(sourceArgument ?? 'public/audio/prufrock-voice-clone.mp3')

globalThis.sampleRate = SAMPLE_RATE
let Processor
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} } }
}
globalThis.registerProcessor = (_name, implementation) => { Processor = implementation }
await import('../public/vocoder-processor.js')

const decoded = spawnSync('ffmpeg', [
  '-v', 'error', '-ss', '10', '-t', '12', '-i', sourcePath,
  '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
], { maxBuffer: 12 * SAMPLE_RATE * 4 + 1024 * 1024 })
if (decoded.status !== 0) throw new Error(decoded.stderr.toString() || 'ffmpeg could not decode the sample')
const speech = new Float32Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength / 4)

const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12)
const phase = new Map()
const chord = [60, 64, 67]
function carrierBlock() {
  const block = new Float32Array(BLOCK_SIZE)
  for (const note of chord) {
    for (const cents of [-6, 6]) {
      const frequency = midiToHz(note) * 2 ** (cents / 1200)
      const key = `${note}:${cents}`
      let current = phase.get(key) ?? 0
      for (let index = 0; index < BLOCK_SIZE; index += 1) {
        block[index] += ((current / Math.PI) - 1) * (0.16 * (96 / 127 / 4) / 2)
        current = (current + 2 * Math.PI * frequency / SAMPLE_RATE) % (2 * Math.PI)
      }
      phase.set(key, current)
    }
  }
  return block
}

function render({ monitor, carrier }) {
  phase.clear()
  const processor = new Processor()
  processor.port.onmessage({ data: { type: 'settings', settings: {
    bands: 20, low: 100, high: 8000, formant: 0, character: 0.35,
    attack: 10, release: 180, mix: 1, inputGain: 6, gate: -52,
    output: -3, limiter: false, monitor,
  } } })
  const rendered = new Float32Array(Math.floor(speech.length / BLOCK_SIZE) * BLOCK_SIZE)
  for (let offset = 0; offset < rendered.length; offset += BLOCK_SIZE) {
    const voice = speech.subarray(offset, offset + BLOCK_SIZE)
    const output = [new Float32Array(BLOCK_SIZE), new Float32Array(BLOCK_SIZE)]
    processor.process([[voice], [carrier ? carrierBlock() : new Float32Array(BLOCK_SIZE)]], [output])
    rendered.set(output[0], offset)
  }
  return rendered
}

function stats(samples) {
  let sumSquares = 0
  let peak = 0
  for (const sample of samples) {
    sumSquares += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  const rms = Math.sqrt(sumSquares / samples.length)
  return { rms, rmsDb: 20 * Math.log10(Math.max(rms, 1e-12)), peakDb: 20 * Math.log10(Math.max(peak, 1e-12)) }
}

function correlation(left, right) {
  let product = 0; let leftSquares = 0; let rightSquares = 0
  for (let index = 0; index < left.length; index += 1) {
    product += left[index] * right[index]
    leftSquares += left[index] ** 2
    rightSquares += right[index] ** 2
  }
  return product / Math.sqrt(leftSquares * rightSquares)
}

function writeWav(path, samples) {
  const header = Buffer.alloc(44)
  const dataSize = samples.length * 2
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataSize, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(dataSize, 40)
  const pcm = Buffer.alloc(dataSize)
  for (let index = 0; index < samples.length; index += 1) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), index * 2)
  }
  writeFileSync(path, Buffer.concat([header, pcm]))
}

const dryMonitor = render({ monitor: true, carrier: false })
const wetVocoder = render({ monitor: false, carrier: true })
const combined = render({ monitor: true, carrier: true })
const dry = stats(dryMonitor)
const wet = stats(wetVocoder)
const mix = stats(combined)

if (outputDirectory) {
  mkdirSync(outputDirectory, { recursive: true })
  writeWav(resolve(outputDirectory, 'monitor-only.wav'), dryMonitor)
  writeWav(resolve(outputDirectory, 'keyed-c-major-vocoder.wav'), combined)
}

console.log(JSON.stringify({
  source: sourcePath,
  analyzedSeconds: speech.length / SAMPLE_RATE,
  chord,
  dryMonitor: dry,
  wetVocoder: wet,
  combined: mix,
  wetToDryDb: 20 * Math.log10(wet.rms / dry.rms),
  combinedDryCorrelation: correlation(combined, dryMonitor),
  outputDirectory,
}, null, 2))
