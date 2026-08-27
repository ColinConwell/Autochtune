// Controller specification tests.
//
// Covers the path from an incoming MIDI packet to (a) the SysEx frames sent
// back to the PartyKeys LEDs and (b) the carrier voices handed to the vocoder.
// Both run headless: the MIDI ports and the Web Audio graph are stubbed.

import assert from 'node:assert/strict'
import {
  PARTYKEYS_RANGE, clearKeyColors, connectPartyKeys, enterLedMode, hexToRgb,
  isPartyKeysNote, keyIndexToNote, noteName, noteToKeyIndex, parseMidiNote,
  scaleRgb, setKeyColors,
} from '../src/lib/partykeys.js'

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

// A MIDIOutput stand-in that enforces what a real one enforces: SysEx frames
// must open with F0, close with F7, and carry only 7-bit data in between.
function fakeOutput(name = 'PartyKeys 36') {
  const sent = []
  return {
    name,
    sent,
    send(data) {
      const bytes = [...data]
      if (bytes[0] === 0xf0) {
        if (bytes[bytes.length - 1] !== 0xf7) throw new TypeError('SysEx message is not terminated with F7')
        for (let i = 1; i < bytes.length - 1; i += 1) {
          if (!Number.isInteger(bytes[i]) || bytes[i] < 0 || bytes[i] > 127) {
            throw new TypeError(`SysEx data byte ${i} is ${bytes[i]}, outside 0-127`)
          }
        }
      }
      sent.push(bytes)
    },
  }
}

const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')

// ---------------------------------------------------------------------------
section('SysEx frames match docs/PartyKeys-Reference.md')
// ---------------------------------------------------------------------------

await check('LED-mode init frame is byte-exact', async () => {
  const output = fakeOutput()
  assert.equal(enterLedMode(output), true)
  assert.deepEqual(output.sent[0], [0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00, 0x0f, 0x01, 0xf7])
  return hex(output.sent[0])
})

await check('all-off frame uses the dedicated command', async () => {
  const output = fakeOutput()
  assert.equal(clearKeyColors(output), true)
  assert.deepEqual(output.sent[0], [0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00, 0x71, 0x00, 0xf7])
  return hex(output.sent[0])
})

await check('CMD 15 reproduces the reference example byte for byte', async () => {
  // "set key 0 red, keys 12 and 24 blue" from section 4 of the reference.
  const output = fakeOutput()
  setKeyColors(output, [
    { color: { r: 255, g: 0, b: 0 }, keys: [0] },
    { color: { r: 0, g: 0, b: 255 }, keys: [12, 24] },
  ])
  assert.deepEqual(output.sent[0], [
    0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00, 0x15,
    0x02,
    0x01, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x7f, 0x02, 0x0c, 0x18,
    0xf7,
  ])
  return `${output.sent[0].length} bytes`
})

await check('colour channels split across two 7-bit bytes', async () => {
  const cases = [[0, [0x00, 0x00]], [51, [0x00, 0x33]], [128, [0x01, 0x00]], [255, [0x01, 0x7f]]]
  for (const [value, expected] of cases) {
    const output = fakeOutput()
    setKeyColors(output, [{ color: { r: value, g: 0, b: 0 }, keys: [0] }])
    assert.deepEqual(output.sent[0].slice(9, 11), expected, `channel value ${value}`)
  }
  return cases.map(([v]) => v).join(', ')
})

// ---------------------------------------------------------------------------
section('SysEx robustness — a bad frame must never reach the port')
// ---------------------------------------------------------------------------

await check('out-of-range key indices are filtered out', async () => {
  const output = fakeOutput()
  setKeyColors(output, [{ color: { r: 255, g: 0, b: 0 }, keys: [-5, 0, 35, 36, 200, 1.5, NaN, null] }])
  const frame = output.sent[0]
  const keyCount = frame[15]
  assert.deepEqual(frame.slice(15), [3, 0, 35, 2, 0xf7],
    `expected only keys 0, 35 and the rounded 1.5 to survive, got ${hex(frame.slice(15))}`)
  return `${keyCount} of 8 candidate keys kept`
})

await check('a note below the PartyKeys range cannot produce a negative key index', async () => {
  // The original bug: a note-off from any MIDI source outside 48-83 produced
  // note - 48 as a key index and corrupted the frame.
  const output = fakeOutput()
  for (let note = 0; note <= 127; note += 1) {
    if (!isPartyKeysNote(note)) continue
    assert.doesNotThrow(() => setKeyColors(output, [{ color: { r: 200, g: 0, b: 0 }, keys: [noteToKeyIndex(note)] }]))
  }
  // And the guard itself rejects everything outside the range.
  const outside = [...Array(128).keys()].filter((note) => !isPartyKeysNote(note))
  for (const note of outside) {
    assert.equal(setKeyColors(output, [{ color: { r: 1, g: 1, b: 1 }, keys: [noteToKeyIndex(note)] }]), false,
      `note ${note} produced a frame it should have refused`)
  }
  return `${outside.length} out-of-range notes refused, 36 accepted`
})

await check('empty and malformed groups are dropped, not emitted', async () => {
  const output = fakeOutput()
  assert.equal(setKeyColors(output, [{ color: { r: 255, g: 0, b: 0 }, keys: [] }]), false, 'an empty group was sent')
  assert.equal(setKeyColors(output, []), false, 'an empty group list was sent')
  assert.equal(setKeyColors(output, null), false, 'a null group list was sent')
  assert.equal(setKeyColors(null, [{ color: {}, keys: [0] }]), false, 'a frame was sent with no output port')
  assert.equal(output.sent.length, 0, `${output.sent.length} frames escaped`)
  return 'four degenerate cases refused'
})

await check('non-finite and out-of-gamut colours still encode legally', async () => {
  const output = fakeOutput()
  for (const color of [{ r: NaN, g: 0, b: 0 }, { r: -40, g: 900, b: undefined }, { r: 12.7, g: 0.4, b: 255.9 }, {}]) {
    assert.doesNotThrow(() => setKeyColors(output, [{ color, keys: [0] }]), `colour ${JSON.stringify(color)}`)
  }
  return `${output.sent.length} frames, all within 0-127`
})

await check('a brightness-scaled colour never exceeds the channel range', async () => {
  const output = fakeOutput()
  for (const brightness of [0, 0.5, 1, 1.9, -3, NaN]) {
    assert.doesNotThrow(() => setKeyColors(output, [{ color: scaleRgb(hexToRgb('#ff684f'), brightness), keys: [0] }]))
  }
  return 'six brightness values encoded legally'
})

await check('invalid hex colours degrade to black rather than NaN', async () => {
  for (const value of ['#ff684f', 'ff684f', '', null, undefined, '#xyzxyz', '#fff']) {
    const { r, g, b } = hexToRgb(value)
    assert.ok([r, g, b].every(Number.isFinite), `hexToRgb(${JSON.stringify(value)}) produced NaN`)
  }
  assert.deepEqual(hexToRgb('#fff'), { r: 0, g: 0, b: 0 }, 'short hex should not be half-parsed')
  return 'seven inputs, all finite'
})

// ---------------------------------------------------------------------------
section('Key layout')
// ---------------------------------------------------------------------------

await check('key indices map to MIDI notes as the reference describes', async () => {
  assert.equal(PARTYKEYS_RANGE.first, 48)
  assert.equal(PARTYKEYS_RANGE.last, 83)
  assert.equal(PARTYKEYS_RANGE.count, 36)
  assert.equal(noteToKeyIndex(48), 0)
  assert.equal(noteToKeyIndex(83), 35)
  assert.equal(keyIndexToNote(0), 48)
  assert.equal(keyIndexToNote(35), 83)
  for (let index = 0; index < 36; index += 1) {
    assert.equal(noteToKeyIndex(keyIndexToNote(index)), index, `round trip failed at index ${index}`)
  }
  return 'index 0 = MIDI 48 (C3), index 35 = MIDI 83 (B5)'
})

await check('note names cover the full range without gaps', async () => {
  assert.equal(noteName(48), 'C3')
  assert.equal(noteName(60), 'C4')
  assert.equal(noteName(83), 'B5')
  for (let note = 0; note <= 127; note += 1) {
    assert.ok(/^[A-G][♯♭]?-?\d+$/.test(noteName(note)), `noteName(${note}) = ${noteName(note)}`)
  }
  return 'C3 at 48, C4 at 60, B5 at 83'
})

// ---------------------------------------------------------------------------
section('MIDI message parsing')
// ---------------------------------------------------------------------------

await check('note on and note off are decoded with channel and velocity', async () => {
  assert.deepEqual(parseMidiNote([0x90, 60, 100]), { type: 'noteOn', note: 60, velocity: 100, channel: 1 })
  assert.deepEqual(parseMidiNote([0x83, 60, 0]), { type: 'noteOff', note: 60, velocity: 0, channel: 4 })
  assert.deepEqual(parseMidiNote([0x9f, 72, 1]), { type: 'noteOn', note: 72, velocity: 1, channel: 16 })
  return 'channels 1, 4, and 16'
})

await check('note on with velocity 0 is a note off', async () => {
  const parsed = parseMidiNote([0x90, 60, 0])
  assert.equal(parsed.type, 'noteOff', 'running-status note off was treated as a note on')
  return 'running-status note off handled'
})

await check('non-note traffic is ignored', async () => {
  // Clock, active sensing, SysEx, control change, pitch bend, aftertouch, and
  // truncated packets all reach onmidimessage and must not become notes.
  const ignored = [
    [0xf8], [0xfe], [0xf0, 0x05, 0xf7], [0xb0, 7, 100], [0xe0, 0, 64],
    [0xd0, 64], [0xa0, 60, 40], [0x90], [0x90, 60], [], null, undefined,
  ]
  for (const data of ignored) {
    assert.equal(parseMidiNote(data), null, `${JSON.stringify(data)} was parsed as a note`)
  }
  return `${ignored.length} non-note messages ignored`
})

await check('every possible note packet yields a valid LED frame or none at all', async () => {
  // Fuzz the whole controller path: any status/note/velocity triple must either
  // be ignored or produce a frame the port accepts.
  const output = fakeOutput()
  let notes = 0
  let lit = 0
  for (let status = 0x80; status <= 0x9f; status += 1) {
    for (let note = 0; note <= 127; note += 1) {
      for (const velocity of [0, 1, 64, 127]) {
        const parsed = parseMidiNote([status, note, velocity])
        if (!parsed) continue
        notes += 1
        if (!isPartyKeysNote(parsed.note)) continue
        lit += 1
        assert.doesNotThrow(
          () => setKeyColors(output, [{ color: { r: parsed.velocity * 2, g: 0, b: 0 }, keys: [noteToKeyIndex(parsed.note)] }]),
          `status ${status.toString(16)} note ${note} velocity ${velocity} produced an invalid frame`,
        )
      }
    }
  }
  return `${notes} note events, ${lit} valid LED frames, 0 invalid`
})

// ---------------------------------------------------------------------------
section('Connection lifecycle')
// ---------------------------------------------------------------------------

function fakeAccess({ inputNames = ['PartyKeys 36'], outputNames = ['PartyKeys 36'] } = {}) {
  const makeInput = (name) => ({ name, onmidimessage: null })
  const access = {
    inputs: new Map(inputNames.map((name, index) => [String(index), makeInput(name)])),
    outputs: new Map(outputNames.map((name, index) => [String(index), fakeOutput(name)])),
    onstatechange: null,
  }
  return access
}

const withMidiAccess = async (access, body) => {
  // globalThis.navigator is an accessor in modern Node, so it has to be
  // redefined rather than assigned.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { requestMIDIAccess: async () => access },
    configurable: true,
    writable: true,
  })
  try {
    return await body()
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  }
}

await check('connecting enters LED mode and attaches the note handler', async () => {
  const access = fakeAccess()
  const handler = () => {}
  const result = await withMidiAccess(access, () => connectPartyKeys(handler))
  assert.equal(result.identified, true, 'a PartyKeys port was not identified')
  assert.equal(result.input.onmidimessage, handler, 'the note handler was not attached')
  assert.deepEqual(result.output.sent[0], [0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00, 0x0f, 0x01, 0xf7],
    'LED mode was not entered on connect')
  return 'handler attached, LED mode entered'
})

await check('a non-PartyKeys device is used but reported as unidentified', async () => {
  const access = fakeAccess({ inputNames: ['Some Other Keyboard'], outputNames: ['Some Other Keyboard'] })
  const result = await withMidiAccess(access, () => connectPartyKeys(() => {}))
  assert.equal(result.identified, false, 'an unrelated device was reported as a PartyKeys')
  assert.equal(result.output.name, 'Some Other Keyboard')
  return 'fallback port used, identified = false'
})

await check('a PartyKeys port is preferred over other connected devices', async () => {
  const access = fakeAccess({
    inputNames: ['Launchpad', 'PartyKeys 36', 'IAC Driver'],
    outputNames: ['Launchpad', 'PartyKeys 36'],
  })
  const result = await withMidiAccess(access, () => connectPartyKeys(() => {}))
  assert.equal(result.input.name, 'PartyKeys 36')
  assert.equal(result.output.name, 'PartyKeys 36')
  return 'selected PartyKeys from three inputs'
})

await check('missing ports fail with a usable message', async () => {
  const access = fakeAccess({ inputNames: [], outputNames: [] })
  await assert.rejects(
    () => withMidiAccess(access, () => connectPartyKeys(() => {})),
    /No MIDI input and output/,
  )
  return 'rejects with guidance'
})

await check('reconnecting re-enters LED mode and re-attaches the handler', async () => {
  // The firmware requires the LED-mode frame after every connection, so a
  // hot-plug that only restores the ports would leave the lights dead.
  const access = fakeAccess({ inputNames: [], outputNames: [] })
  access.inputs.set('0', { name: 'PartyKeys 36', onmidimessage: null })
  access.outputs.set('0', fakeOutput('PartyKeys 36'))
  const handler = () => {}
  const states = []
  const result = await withMidiAccess(access, () => connectPartyKeys(handler, (state) => states.push(state)))
  const initialFrames = result.output.sent.length

  const replacement = fakeOutput('PartyKeys 36')
  access.inputs.set('0', { name: 'PartyKeys 36', onmidimessage: null })
  access.outputs.set('0', replacement)
  access.onstatechange()

  assert.equal(replacement.sent.length, 1, 'LED mode was not re-entered after a reconnect')
  assert.equal(access.inputs.get('0').onmidimessage, handler, 'the note handler was not re-attached')
  assert.equal(states.length, 1, 'the reconnect was not reported to the UI')
  assert.equal(states[0].connected, true)
  return `${initialFrames} frame on connect, LED mode re-sent on reconnect`
})

await check('unplugging is reported as disconnected', async () => {
  const access = fakeAccess()
  const states = []
  await withMidiAccess(access, () => connectPartyKeys(() => {}, (state) => states.push(state)))
  access.inputs.clear()
  access.outputs.clear()
  access.onstatechange()
  assert.equal(states.at(-1).connected, false, 'an unplug was not reported')
  return 'disconnect surfaced to the UI'
})

// ---------------------------------------------------------------------------
section('Note to carrier — the vocoder is played, not just triggered')
// ---------------------------------------------------------------------------

// Minimal Web Audio stand-in. Only what VocoderEngine touches is modelled.
function fakeAudioContext() {
  const created = { oscillators: [], gains: [], filters: [] }
  const param = (value) => ({
    value,
    events: [],
    setValueAtTime(v, t) { this.value = v; this.events.push(['setValueAtTime', v, t]); return this },
    linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['linearRamp', v, t]); return this },
    exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push(['exponentialRamp', v, t]); return this },
    setTargetAtTime(v, t, c) { this.events.push(['setTarget', v, t, c]); return this },
    cancelScheduledValues() { return this },
  })
  const node = (extra = {}) => ({
    connections: [],
    connect(target) { this.connections.push(target); return target },
    disconnect() { this.connections = [] },
    ...extra,
  })
  return {
    created,
    currentTime: 0,
    sampleRate: 48000,
    state: 'running',
    destination: node(),
    async resume() { this.state = 'running' },
    async suspend() { this.state = 'suspended' },
    async close() { this.state = 'closed' },
    createGain() { const g = node({ gain: param(1) }); created.gains.push(g); return g },
    createBiquadFilter() { const f = node({ type: '', frequency: param(350), Q: param(1) }); created.filters.push(f); return f },
    createOscillator() {
      const o = node({
        type: 'sine', frequency: param(440), detune: param(0), onended: null,
        started: null, stopped: null,
        start(t) { this.started = t }, stop(t) { this.stopped = t; this.onended?.() },
      })
      created.oscillators.push(o)
      return o
    },
  }
}

const { VocoderEngine } = await import('../src/audio/VocoderEngine.js')

function engineWithFakeContext(settings = {}) {
  const engine = new VocoderEngine()
  const context = fakeAudioContext()
  engine.context = context
  engine.carrierBus = context.createGain()
  engine.node = { port: { postMessage() {} } }
  engine.settings = { waveform: 'sawtooth', tune: 0, unison: 1, spread: 55, glide: 0, ...settings }
  context.created.oscillators.length = 0
  return { engine, context }
}

const A440 = 69

await check('a MIDI note produces a carrier at the right frequency', async () => {
  const { engine, context } = engineWithFakeContext()
  for (const [note, expected] of [[A440, 440], [60, 261.6256], [48, 130.8128], [83, 987.7666]]) {
    context.created.oscillators.length = 0
    engine.noteOn(note, 100)
    const frequency = context.created.oscillators[0].frequency.value
    assert.ok(Math.abs(frequency - expected) / expected < 1e-4,
      `note ${note} produced ${frequency.toFixed(2)} Hz, expected ${expected.toFixed(2)} Hz`)
    engine.noteOff(note)
  }
  return 'A4 = 440 Hz, C3 = 130.81 Hz, B5 = 987.77 Hz'
})

await check('Tune transposes the carrier by whole semitones', async () => {
  for (const tune of [-12, -5, 0, 7, 12]) {
    const { engine, context } = engineWithFakeContext({ tune })
    engine.noteOn(A440, 100)
    const frequency = context.created.oscillators[0].frequency.value
    const expected = 440 * 2 ** (tune / 12)
    assert.ok(Math.abs(frequency - expected) / expected < 1e-6,
      `tune ${tune} produced ${frequency.toFixed(2)} Hz, expected ${expected.toFixed(2)} Hz`)
  }
  return 'five transpositions exact'
})

await check('Unison creates the selected number of detuned oscillators', async () => {
  for (const [unison, count] of [[1, 1], [2, 2], [3, 3]]) {
    const { engine, context } = engineWithFakeContext({ unison })
    engine.noteOn(60, 100)
    assert.equal(context.created.oscillators.length, count, `unison ${unison} created ${context.created.oscillators.length} oscillators`)
  }
  const { engine, context } = engineWithFakeContext({ unison: 3, spread: 100 })
  engine.noteOn(60, 100)
  const detunes = context.created.oscillators.map((o) => o.detune.value)
  assert.ok(new Set(detunes).size === 3, `unison voices share a detune value: ${detunes.join(', ')}`)
  return '1, 2, and 3 voices with distinct detune'
})

await check('Spread scales the detune amount', async () => {
  const detuneFor = (spread) => {
    const { engine, context } = engineWithFakeContext({ unison: 3, spread })
    engine.noteOn(60, 100)
    return Math.max(...context.created.oscillators.map((o) => Math.abs(o.detune.value)))
  }
  assert.equal(detuneFor(0), 0, 'spread 0 should collapse the unison detune')
  assert.ok(detuneFor(100) > detuneFor(50), 'spread 100 is not wider than spread 50')
  return `0%, 50%, 100% -> ${detuneFor(0)}, ${detuneFor(50).toFixed(1)}, ${detuneFor(100).toFixed(1)} cents`
})

await check('Glide is legato only', async () => {
  // Sliding from a note that stopped sounding minutes ago would be wrong; a
  // slide only makes sense while something is still held.
  const { engine, context } = engineWithFakeContext({ glide: 120 })
  engine.noteOn(60, 100)
  const firstEvents = context.created.oscillators[0].frequency.events
  assert.ok(!firstEvents.some(([kind]) => kind === 'exponentialRamp'),
    'the first note glided from nothing')

  context.created.oscillators.length = 0
  engine.noteOn(67, 100) // held together with 60 -> legato
  const ramp = context.created.oscillators[0].frequency.events.find(([kind]) => kind === 'exponentialRamp')
  assert.ok(ramp, 'a legato note did not glide')
  assert.ok(Math.abs(ramp[1] - 440 * 2 ** ((67 - 69) / 12)) < 0.01, 'the glide did not land on the target pitch')
  assert.ok(Math.abs(ramp[2] - 0.12) < 1e-9, `glide took ${ramp[2]}s, expected 0.12s`)
  return 'no glide on the first note, 120 ms glide when legato'
})

await check('Glide at zero produces no pitch ramp', async () => {
  const { engine, context } = engineWithFakeContext({ glide: 0 })
  engine.noteOn(60, 100)
  context.created.oscillators.length = 0
  engine.noteOn(67, 100)
  assert.ok(!context.created.oscillators[0].frequency.events.some(([kind]) => kind === 'exponentialRamp'),
    'glide 0 still produced a pitch ramp')
  return 'no ramp scheduled'
})

await check('velocity sets carrier brightness, not loudness', async () => {
  // The worklet normalises the carrier, so velocity driving gain would do
  // nothing audible. It has to reach the sound some other way.
  const brightness = []
  const loudness = []
  for (const velocity of [1, 32, 64, 96, 127]) {
    const { engine, context } = engineWithFakeContext()
    context.created.filters.length = 0
    context.created.gains.length = 0
    engine.noteOn(60, velocity)
    brightness.push(context.created.filters[0].frequency.value)
    loudness.push(context.created.gains[0].gain.value)
  }
  for (let i = 1; i < brightness.length; i += 1) {
    assert.ok(brightness[i] > brightness[i - 1], `brightness did not rise at velocity step ${i}: ${brightness.join(', ')}`)
  }
  assert.equal(new Set(loudness).size, 1, `velocity changed carrier gain: ${loudness.join(', ')}`)
  return `${brightness[0].toFixed(0)} Hz to ${brightness.at(-1).toFixed(0)} Hz cutoff, gain constant`
})

await check('re-attacking a held key starts a new voice instead of being dropped', async () => {
  // The original engine kept the note in its voice map for 200 ms after
  // release, so a fast repeat was silently swallowed.
  const { engine, context } = engineWithFakeContext()
  engine.noteOn(60, 100)
  engine.noteOff(60)
  assert.equal(engine.voices.size, 0, 'the voice was not released from the active map immediately')
  context.created.oscillators.length = 0
  engine.noteOn(60, 100)
  assert.equal(context.created.oscillators.length, 1, 'the re-attack produced no new oscillator')
  assert.equal(engine.voices.size, 1, 'the re-attacked voice is not active')
  return 'repeat within the release window sounds'
})

await check('a repeated note-on without a note-off does not stack voices', async () => {
  const { engine } = engineWithFakeContext()
  for (let i = 0; i < 10; i += 1) engine.noteOn(60, 100)
  assert.equal(engine.voices.size, 1, `${engine.voices.size} voices are active for one key`)
  return '10 note-ons, 1 active voice'
})

await check('released voices disconnect themselves', async () => {
  const { engine, context } = engineWithFakeContext()
  const before = context.created.gains.length
  engine.noteOn(60, 100)
  // Everything the voice created: its envelope gain, its tone filter, and one
  // gain per unison oscillator.
  const voiceNodes = [...context.created.gains.slice(before), ...context.created.filters.slice(-1)]
  engine.noteOff(60)
  for (const node of voiceNodes) {
    assert.deepEqual(node.connections, [], 'a voice node stayed connected after release')
  }
  return `${voiceNodes.length} nodes released on ended`
})

await check('note off for a key that is not held is harmless', async () => {
  const { engine } = engineWithFakeContext()
  assert.doesNotThrow(() => engine.noteOff(60))
  assert.doesNotThrow(() => engine.noteOff(-1))
  assert.equal(engine.voices.size, 0)
  return 'no throw, no phantom voices'
})

await check('all notes off clears every voice', async () => {
  const { engine } = engineWithFakeContext()
  for (const note of [48, 52, 55, 59, 62]) engine.noteOn(note, 100)
  assert.equal(engine.voices.size, 5)
  engine.allNotesOff()
  assert.equal(engine.voices.size, 0, `${engine.voices.size} voices survived allNotesOff`)
  assert.equal(engine.lastFrequency, null, 'the glide origin was not cleared')
  return '5 voices released'
})

await check('notes before the graph exists are ignored rather than throwing', async () => {
  const engine = new VocoderEngine()
  assert.doesNotThrow(() => engine.noteOn(60, 100))
  assert.doesNotThrow(() => engine.noteOff(60))
  assert.equal(engine.voices.size, 0)
  return 'no throw with a null AudioContext'
})

await check('stop parks the graph but keeps the media element routable', async () => {
  // Closing the context would strand the sample player: an HTMLMediaElement can
  // only be routed into Web Audio once per document.
  const { engine, context } = engineWithFakeContext()
  engine.mediaSource = { disconnect() {} }
  engine.noteOn(60, 100)
  await engine.stop()
  assert.equal(context.state, 'suspended', `context state is ${context.state}, expected suspended`)
  assert.notEqual(engine.context, null, 'stop() discarded the AudioContext')
  assert.notEqual(engine.mediaSource, null, 'stop() discarded the media element source')
  assert.equal(engine.voices.size, 0, 'stop() left voices sounding')

  await engine.dispose()
  assert.equal(engine.context, null, 'dispose() kept the AudioContext')
  assert.equal(engine.mediaSource, null, 'dispose() kept the media element source')
  return 'stop suspends, dispose closes'
})

// ---------------------------------------------------------------------------
section('Demo scheduling — the loop must hold tempo')
// ---------------------------------------------------------------------------

const { createScheduler } = await import('../src/lib/scheduler.js')

// Fake clock that runs timers in due order and injects processing lateness, so
// the drift behaviour is deterministic rather than a race against the event loop.
function fakeClock({ lateness = 0 } = {}) {
  let time = 0
  let nextHandle = 1
  const queue = new Map()
  return {
    now: () => time,
    setTimer: (callback, delay) => {
      const handle = nextHandle
      nextHandle += 1
      queue.set(handle, { due: time + delay, callback })
      return handle
    },
    clearTimer: (handle) => queue.delete(handle),
    run(until) {
      while (true) {
        const due = [...queue.entries()].filter(([, entry]) => entry.due <= until)
        if (due.length === 0) break
        due.sort((a, b) => a[1].due - b[1].due)
        const [handle, entry] = due[0]
        queue.delete(handle)
        // Every callback runs `lateness` ms after it was due: a slow render, a
        // garbage collection, a busy main thread.
        time = entry.due + lateness
        entry.callback()
      }
      time = Math.max(time, until)
    },
  }
}

const BPM = 88
const BEATS = 4
const BEAT_MS = 60000 / BPM
const CHORD_MS = BEAT_MS * BEATS

// The demo's own chaining shape: each chord schedules the next one.
function runDemo(clock, chords) {
  const scheduler = createScheduler(clock)
  const fired = []
  const playChord = (index) => {
    fired.push({ index, at: clock.now() })
    if (index + 1 >= chords) return
    const chordAt = BEATS * BEAT_MS + index * CHORD_MS
    scheduler.at(chordAt + CHORD_MS, () => playChord(index + 1))
  }
  scheduler.at(BEATS * BEAT_MS, () => playChord(0))
  return { scheduler, fired }
}

await check('a slow main thread does not accumulate tempo drift', async () => {
  const lateness = 40
  const clock = fakeClock({ lateness })
  const { fired } = runDemo(clock, 24)
  clock.run(BEATS * BEAT_MS + 24 * CHORD_MS + 1000)
  assert.equal(fired.length, 24, `only ${fired.length} of 24 chords fired`)
  const errors = fired.map((entry, index) => entry.at - (BEATS * BEAT_MS + index * CHORD_MS))
  const worst = Math.max(...errors)
  // Each chord is `lateness` late on its own account, but that must not add to
  // the next one; the old chained scheme reached 24 x 40 = 960 ms by chord 24.
  assert.ok(worst <= lateness + 1,
    `chord timing error grew to ${worst.toFixed(0)} ms over 24 chords (limit ${lateness + 1} ms)`)
  return `worst error ${worst.toFixed(0)} ms over 24 chords, ${(24 * lateness)} ms if it had accumulated`
})

await check('chords land on the beat when the thread is idle', async () => {
  const clock = fakeClock()
  const { fired } = runDemo(clock, 12)
  clock.run(BEATS * BEAT_MS + 12 * CHORD_MS + 1000)
  const periods = fired.slice(1).map((entry, index) => entry.at - fired[index].at)
  for (const period of periods) {
    assert.ok(Math.abs(period - CHORD_MS) < 1e-6, `chord period was ${period.toFixed(1)} ms, expected ${CHORD_MS.toFixed(1)} ms`)
  }
  return `${periods.length} chords at ${CHORD_MS.toFixed(1)} ms`
})

await check('cancelling stops every pending callback', async () => {
  const clock = fakeClock()
  const { scheduler, fired } = runDemo(clock, 12)
  clock.run(BEATS * BEAT_MS + CHORD_MS)
  const before = fired.length
  scheduler.cancel()
  clock.run(BEATS * BEAT_MS + 12 * CHORD_MS)
  assert.equal(fired.length, before, `${fired.length - before} callbacks fired after cancel`)
  assert.equal(scheduler.at(0, () => fired.push({ index: -1, at: 0 })), null, 'a cancelled scheduler accepted new work')
  return `${before} chords fired, none after cancel`
})

// ---------------------------------------------------------------------------
console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
