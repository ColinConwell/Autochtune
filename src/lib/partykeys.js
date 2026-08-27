// PartyKeys 36 SysEx. Frames follow protocol.partykeys.org; see
// docs/PartyKeys-Reference.md for the byte-level tables these encoders match.

const HEADER = [0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00]
const CMD_LED_MODE = 0x0f
const CMD_KEY_RGB = 0x15
const CMD_ALL_OFF = 0x71
const SYSEX_END = 0xf7
const MAX_GROUPS = 127

export const PARTYKEYS_RANGE = { first: 48, last: 83, count: 36 }

export const isPartyKeysNote = (note) =>
  Number.isInteger(note) && note >= PARTYKEYS_RANGE.first && note <= PARTYKEYS_RANGE.last

export const noteToKeyIndex = (note) => note - PARTYKEYS_RANGE.first
export const keyIndexToNote = (index) => index + PARTYKEYS_RANGE.first

// 8-bit colour channels are split across two 7-bit MIDI data bytes.
const encode8Bit = (value) => {
  const safe = Math.max(0, Math.min(255, Math.round(Number.isFinite(value) ? value : 0)))
  return [Math.floor(safe / 128), safe % 128]
}

const validKeys = (keys) => (Array.isArray(keys) ? keys : [])
  // Filter before rounding: Math.round(null) is 0, which would silently light
  // the leftmost key for a malformed entry.
  .filter((key) => typeof key === 'number' && Number.isFinite(key))
  .map((key) => Math.round(key))
  .filter((key) => key >= 0 && key < PARTYKEYS_RANGE.count)

// A SysEx body may only contain 0-127. A single out-of-range byte makes the
// whole frame invalid and send() throws, which would tear down the MIDI note
// handler mid-performance, so frames are checked before they leave.
function sendSysEx(output, payload) {
  if (!output) return false
  for (let index = 1; index < payload.length - 1; index += 1) {
    const byte = payload[index]
    if (!Number.isInteger(byte) || byte < 0 || byte > 127) return false
  }
  try {
    output.send(payload)
    return true
  } catch {
    return false
  }
}

// Required after every connection; colour commands are ignored without it.
export function enterLedMode(output) {
  return sendSysEx(output, [...HEADER, CMD_LED_MODE, 0x01, SYSEX_END])
}

// CMD 15 — per-key RGB. Each group paints one colour across a list of key
// indices. Groups with no valid keys are dropped rather than emitted with a
// zero key count, which the firmware rejects.
export function setKeyColors(output, groups) {
  if (!output || !Array.isArray(groups)) return false
  const usable = groups
    .map((group) => ({ color: group?.color ?? {}, keys: validKeys(group?.keys) }))
    .filter((group) => group.keys.length > 0)
    .slice(0, MAX_GROUPS)
  if (usable.length === 0) return false

  const payload = [...HEADER, CMD_KEY_RGB, usable.length]
  for (const { color, keys } of usable) {
    payload.push(...encode8Bit(color.r), ...encode8Bit(color.g), ...encode8Bit(color.b))
    payload.push(keys.length, ...keys)
  }
  payload.push(SYSEX_END)
  return sendSysEx(output, payload)
}

// CMD 71 with a zero key count is the firmware's dedicated all-off.
export function clearKeyColors(output) {
  return sendSysEx(output, [...HEADER, CMD_ALL_OFF, 0x00, SYSEX_END])
}

export function hexToRgb(hex) {
  const value = String(hex ?? '').replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) return { r: 0, g: 0, b: 0 }
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

export const scaleRgb = ({ r, g, b }, amount) => {
  const factor = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 1))
  return { r: r * factor, g: g * factor, b: b * factor }
}

const looksLikePartyKeys = (port) => /partykey/i.test(port?.name ?? '')

const pickPorts = (access) => {
  const inputs = [...access.inputs.values()]
  const outputs = [...access.outputs.values()]
  const input = inputs.find(looksLikePartyKeys) ?? inputs[0] ?? null
  const output = outputs.find(looksLikePartyKeys) ?? outputs[0] ?? null
  return { input, output, identified: Boolean(input && looksLikePartyKeys(input)) }
}

// Resolves the PartyKeys ports and keeps them resolved across hot-plugs. The
// LED-mode frame is re-sent on every (re)connection, as the firmware requires.
export async function connectPartyKeys(onMidiMessage, onStateChange) {
  if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not available in this browser. Use Chrome or Edge.')
  const access = await navigator.requestMIDIAccess({ sysex: true })

  let current = pickPorts(access)
  if (!current.input || !current.output) {
    throw new Error('No MIDI input and output were found. Connect PartyKeys and try again.')
  }

  const attach = (ports) => {
    if (ports.input) ports.input.onmidimessage = onMidiMessage
    enterLedMode(ports.output)
  }
  attach(current)

  access.onstatechange = () => {
    const next = pickPorts(access)
    const changed = next.input !== current.input || next.output !== current.output
    if (current.input && current.input !== next.input) current.input.onmidimessage = null
    current = next
    if (changed && next.input && next.output) attach(next)
    onStateChange?.({
      connected: Boolean(next.input && next.output),
      identified: next.identified,
      name: next.output?.name ?? next.input?.name ?? '',
    })
  }

  return { access, input: current.input, output: current.output, identified: current.identified }
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
export const noteName = (midi) =>
  `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`

// Parses a raw Web MIDI packet into a note event, or null for anything that is
// not a note (clock, sensing, SysEx, control change).
export function parseMidiNote(data) {
  if (!data || data.length < 3) return null
  const status = data[0]
  const command = status & 0xf0
  if (command !== 0x90 && command !== 0x80) return null
  const note = data[1]
  const velocity = data[2]
  if (!Number.isInteger(note) || note < 0 || note > 127) return null
  return {
    type: command === 0x90 && velocity > 0 ? 'noteOn' : 'noteOff',
    note,
    velocity: command === 0x90 ? velocity : 0,
    channel: (status & 0x0f) + 1,
  }
}
