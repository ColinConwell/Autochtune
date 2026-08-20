const HEADER = [0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00]
export const PARTYKEYS_RANGE = { first: 48, last: 83, count: 36 }

const encode8Bit = (value) => {
  const safe = Math.max(0, Math.min(255, Math.round(value)))
  return [Math.floor(safe / 128), safe % 128]
}

export function enterLedMode(output) {
  output?.send([...HEADER, 0x0f, 0x01, 0xf7])
}

export function setKeyColors(output, groups) {
  if (!output || groups.length === 0) return
  const payload = [...HEADER, 0x15, groups.length]
  groups.forEach(({ color, keys }) => {
    payload.push(...encode8Bit(color.r), ...encode8Bit(color.g), ...encode8Bit(color.b))
    payload.push(keys.length, ...keys)
  })
  payload.push(0xf7)
  output.send(payload)
}

export function clearKeyColors(output) {
  setKeyColors(output, [{ color: { r: 0, g: 0, b: 0 }, keys: Array.from({ length: 36 }, (_, i) => i) }])
}

export function hexToRgb(hex) {
  const value = hex.replace('#', '')
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

export async function connectPartyKeys(onMidiMessage) {
  if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not available in this browser.')
  const access = await navigator.requestMIDIAccess({ sysex: true })
  const inputs = [...access.inputs.values()]
  const outputs = [...access.outputs.values()]
  const preferredInput = inputs.find((port) => /partykey/i.test(port.name)) ?? inputs[0]
  const preferredOutput = outputs.find((port) => /partykey/i.test(port.name)) ?? outputs[0]
  if (!preferredInput || !preferredOutput) throw new Error('No MIDI input and output were found.')
  preferredInput.onmidimessage = onMidiMessage
  enterLedMode(preferredOutput)
  return { access, input: preferredInput, output: preferredOutput }
}

export const noteName = (midi) => {
  const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`
}
