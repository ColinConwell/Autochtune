import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VocoderEngine } from './audio/VocoderEngine.js'
import {
  PARTYKEYS_RANGE,
  clearKeyColors,
  connectPartyKeys,
  hexToRgb,
  noteName,
  setKeyColors,
} from './lib/partykeys.js'

const INITIAL_SETTINGS = {
  waveform: 'sawtooth', tune: 0, unison: 2, spread: 55, glide: 80,
  bands: 20, low: 100, high: 8000, formant: 0, character: 0.35,
  attack: 10, release: 180, mix: 1, width: 0.86, inputGain: 6,
  gate: -52, output: -3, limiter: true, monitor: true,
}

const BUNDLED_SAMPLE = {
  name: 'Voice Clone — Love Song of Prufrock',
  url: '/audio/prufrock-voice-clone.mp3',
  bundled: true,
}

const PRESETS = {
  'Glass Choir': { ...INITIAL_SETTINGS },
  'Clean Ensemble': { ...INITIAL_SETTINGS, bands: 24, character: 0.16, attack: 5, release: 130, spread: 32, output: -4 },
  'Warm Analog': { ...INITIAL_SETTINGS, bands: 16, low: 90, high: 6200, formant: -1.5, character: 0.52, attack: 18, release: 240, waveform: 'sawtooth', unison: 3 },
  'Robot Whisper': { ...INITIAL_SETTINGS, bands: 12, low: 180, high: 9200, formant: 4, character: 0.72, attack: 2, release: 75, waveform: 'square', mix: 0.92 },
}

const DEMO_BPM = 88
const DEMO_BEATS_PER_CHORD = 4
const DEMO_CHORDS = [
  { name: 'Cmaj7', notes: [60, 64, 67, 71], color: '#ff684f' },
  { name: 'Am7', notes: [57, 60, 64, 67], color: '#f59f45' },
  { name: 'Fmaj7', notes: [53, 57, 60, 64], color: '#b7dc26' },
  { name: 'Gsus4', notes: [55, 60, 62, 67], color: '#5aa8ff' },
]

const PARAMS = {
  tune: { label: 'Tune', min: -12, max: 12, step: 1, unit: ' st' },
  spread: { label: 'Spread', min: 0, max: 100, step: 1, unit: '%' },
  glide: { label: 'Glide', min: 0, max: 400, step: 5, unit: ' ms' },
  low: { label: 'Low', min: 60, max: 400, step: 5, unit: ' Hz' },
  high: { label: 'High', min: 3000, max: 12000, step: 100, format: (v) => `${(v / 1000).toFixed(1)} kHz` },
  formant: { label: 'Formant', min: -12, max: 12, step: 0.5, unit: ' st', signed: true },
  character: { label: 'Character', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  attack: { label: 'Attack', min: 1, max: 100, step: 1, unit: ' ms' },
  release: { label: 'Release', min: 30, max: 600, step: 5, unit: ' ms' },
  mix: { label: 'Dry / wet', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  width: { label: 'Stereo width', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  output: { label: 'Output', min: -18, max: 6, step: 0.5, unit: ' dB', signed: true },
  inputGain: { label: 'Input gain', min: -12, max: 24, step: 0.5, unit: ' dB', signed: true },
  gate: { label: 'Gate threshold', min: -80, max: -20, step: 1, unit: ' dB' },
}

function formatValue(value, config) {
  if (config.format) return config.format(value)
  const prefix = config.signed && value > 0 ? '+' : ''
  return `${prefix}${value}${config.unit ?? ''}`
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

function Icon({ name, size = 18 }) {
  const paths = {
    audio: <><path d="M3 10h2m3-4v8m3-11v14m3-10v6m3-3h2" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    save: <><path d="M5 3h12l2 2v14H5z" /><path d="M8 3v6h8V3M8 19v-6h8v6" /></>,
    spark: <><path d="M12 2v4m0 12v4M4.9 4.9l2.8 2.8m8.6 8.6 2.8 2.8M2 12h4m12 0h4M4.9 19.1l2.8-2.8m8.6-8.6 2.8-2.8" /></>,
    midi: <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h10M9 8h6M9 16h6" /></>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-3 0h6" /></>,
    play: <path d="m9 7 8 5-8 5z" />,
    stop: <rect x="8" y="8" width="8" height="8" rx="1" />,
    pause: <><path d="M9 7v10M15 7v10" /></>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4" /><path d="M5 14v5h14v-5" /></>,
  }
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function SourcePanel({ mode, onModeChange, sample, playback, loading, onTogglePlayback, onSeek, onUpload, onRestore }) {
  return (
    <section className={`source-panel ${mode === 'sample' ? 'sample-active' : ''}`} aria-label="Voice source">
      <div className="source-modes" role="group" aria-label="Voice source mode">
        <button className={mode === 'microphone' ? 'active' : ''} onClick={() => onModeChange('microphone')}><Icon name="mic" size={15} /> Live microphone</button>
        <button className={mode === 'sample' ? 'active' : ''} onClick={() => onModeChange('sample')}><Icon name="audio" size={15} /> Audio sample</button>
      </div>
      {mode === 'microphone' ? (
        <p>Sing into the selected microphone, then hold PartyKeys notes to shape the vocoder carrier.</p>
      ) : (
        <div className="sample-player">
          <button className={`sample-play ${playback.playing ? 'playing' : ''}`} onClick={onTogglePlayback} disabled={loading} aria-label={playback.playing ? 'Pause sample' : 'Play sample'}>
            <Icon name={playback.playing ? 'pause' : 'play'} size={18} />
          </button>
          <div className="sample-identity"><strong>{sample.name}</strong><span>{sample.bundled ? 'Included sample · hold MIDI notes while it plays' : 'Uploaded sample · processed locally'}</span></div>
          <input aria-label="Sample position" type="range" min="0" max={Math.max(playback.duration, 0)} step="0.05" value={Math.min(playback.currentTime, playback.duration || 0)} onChange={(event) => onSeek(Number(event.target.value))} />
          <div className="sample-time"><button aria-label="Back 10 seconds" onClick={() => onSeek(Math.max(0, playback.currentTime - 10))}>−10</button><time>{formatTime(playback.currentTime)} / {formatTime(playback.duration)}</time><button aria-label="Forward 10 seconds" onClick={() => onSeek(Math.min(playback.duration, playback.currentTime + 10))}>+10</button></div>
          <label className="sample-upload"><Icon name="upload" size={15} /> Choose audio<input type="file" accept="audio/*" onChange={onUpload} /></label>
          {!sample.bundled && <button className="sample-restore" onClick={onRestore}>Use Prufrock sample</button>}
        </div>
      )}
    </section>
  )
}

function Knob({ name, value, onChange, small = false }) {
  const config = PARAMS[name]
  const fraction = (value - config.min) / (config.max - config.min)
  const angle = -132 + fraction * 264
  return (
    <label className={`knob-control ${small ? 'knob-small' : ''}`}>
      <span className="control-label">{config.label}</span>
      <span className="knob" style={{ '--angle': `${angle}deg`, '--fill': `${fraction * 100}%` }}>
        <span className="knob-indicator" />
        <input aria-label={config.label} type="range" min={config.min} max={config.max} step={config.step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      </span>
      <output>{formatValue(value, config)}</output>
    </label>
  )
}

function Meter({ level = 'input', value = -60, compact = false }) {
  const numericValue = Number.isFinite(value) ? Math.max(-60, Math.min(0, value)) : -60
  const displayValue = numericValue <= -59.5 ? '−∞' : numericValue.toFixed(1)
  const fill = ((numericValue + 60) / 60) * 100
  return (
    <div className={`meter-wrap ${compact ? 'compact' : ''}`} style={{ '--meter-fill': `${fill}%` }} aria-label={`${level} level ${displayValue} dBFS`}>
      <div className="meter-scale"><span>0</span><span>−12</span><span>−24</span><span>−48</span><span>−60</span></div>
      <div className="meter-bars"><i /><i /></div>
      <div className="meter-value"><strong>{displayValue}</strong><span>dBFS</span></div>
    </div>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span /><em>{label ?? (checked ? 'On' : 'Off')}</em>
    </button>
  )
}

function Piano({ activeNotes, onNoteOn, onNoteOff }) {
  const notes = useMemo(() => Array.from({ length: PARTYKEYS_RANGE.count }, (_, index) => PARTYKEYS_RANGE.first + index), [])
  const whites = notes.filter((note) => ![1, 3, 6, 8, 10].includes(note % 12))
  const blacks = notes.filter((note) => [1, 3, 6, 8, 10].includes(note % 12)).map((note) => {
    const precedingWhites = notes.filter((candidate) => candidate < note && ![1, 3, 6, 8, 10].includes(candidate % 12)).length
    return { note, left: `${(precedingWhites / whites.length) * 100}%` }
  })
  const release = (note) => onNoteOff(note)
  return (
    <div className="keyboard-scroll">
      <div className="keyboard" role="application" aria-label="36-key MIDI keyboard from C3 to B5">
        <div className="white-keys">
          {whites.map((note) => <button key={note} className={`piano-key white ${activeNotes.has(note) ? 'active' : ''}`} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); onNoteOn(note, 104) }} onPointerUp={() => release(note)} onPointerCancel={() => release(note)} aria-label={noteName(note)}><span>{note % 12 === 0 ? noteName(note) : ''}</span></button>)}
        </div>
        {blacks.map(({ note, left }) => <button key={note} style={{ left }} className={`piano-key black ${activeNotes.has(note) ? 'active' : ''}`} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); onNoteOn(note, 104) }} onPointerUp={() => release(note)} onPointerCancel={() => release(note)} aria-label={noteName(note)} />)}
      </div>
    </div>
  )
}

function BandDisplay({ count, low, high }) {
  const bands = Array.from({ length: count }, (_, index) => {
    const x = index / Math.max(1, count - 1)
    return 28 + Math.round((1 - x * 0.72 + Math.sin(index * 0.72) * 0.08) * 42)
  })
  return (
    <div className="band-display" aria-label={`${count} analysis bands from ${low} hertz to ${high} hertz`}>
      <div className="band-bars">{bands.map((height, index) => <i key={index} style={{ '--height': `${height}%`, '--delay': `${index * -70}ms` }} />)}</div>
      <div className="band-axis"><span>{low}</span><span>1k</span><span>{high >= 1000 ? `${Math.round(high / 1000)}k` : high}</span></div>
    </div>
  )
}

function DemoDialog({ microphone, midiConnected, onClose, onPreview, onStart, loading }) {
  return (
    <div className="demo-overlay" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="demo-dialog" role="dialog" aria-modal="true" aria-labelledby="demo-title">
        <div className="demo-dialog-head">
          <div className="demo-mic-mark"><Icon name="mic" size={24} /></div>
          <button onClick={onClose} aria-label="Close demo setup">×</button>
        </div>
        <h2 id="demo-title">Sing one note. Hear four harmonies.</h2>
        <p>Hold a comfortable <strong>“ah”</strong> while Autochtune plays a four-chord vocoder progression around your voice.</p>
        <div className="demo-progression" aria-label="Demo chord progression">
          {DEMO_CHORDS.map((chord, index) => <div key={chord.name} style={{ '--chord-color': chord.color }}><span>0{index + 1}</span><strong>{chord.name}</strong><small>{chord.notes.map(noteName).join(' · ')}</small></div>)}
        </div>
        <div className="demo-checks">
          <span><i className="ready" /> Microphone <strong>{microphone}</strong></span>
          <span><i className={midiConnected ? 'ready' : ''} /> PartyKeys <strong>{midiConnected ? 'Connected' : 'Optional — connect for LEDs'}</strong></span>
          <span><i className="ready" /> Tempo <strong>{DEMO_BPM} BPM · loops</strong></span>
        </div>
        <p className="demo-tip">Headphones recommended. Start with a relaxed, sustained note—the chord movement comes from the keyboard carrier.</p>
        <div className="demo-actions">
          <button className="demo-secondary" onClick={onPreview}><Icon name="play" size={16} /> Preview silently</button>
          <button className="demo-primary" onClick={onStart} disabled={loading}><Icon name="mic" size={17} /> {loading ? 'Opening microphone…' : 'Start with microphone'}</button>
        </div>
      </section>
    </div>
  )
}

function DemoTransport({ demo, onStop }) {
  const current = demo.step >= 0 ? DEMO_CHORDS[demo.step] : null
  const next = DEMO_CHORDS[(Math.max(demo.step, -1) + 1) % DEMO_CHORDS.length]
  const count = demo.status === 'countIn' ? Math.max(1, 5 - demo.beat) : null
  return (
    <section className="demo-transport" aria-live="polite">
      <div className="demo-instruction"><Icon name="mic" size={19} /><div><span>{demo.silent ? 'Silent choreography' : 'Keep singing'}</span><strong>{count ? `Count in ${count}` : 'Hold a steady “ah”'}</strong></div></div>
      <div className="demo-now"><span>Now</span><strong>{current?.name ?? 'Get ready'}</strong><small>{current ? current.notes.map(noteName).join(' · ') : `${DEMO_BPM} BPM`}</small></div>
      <div className="demo-timeline">{DEMO_CHORDS.map((chord, index) => <div key={chord.name} className={index === demo.step ? 'active' : ''} style={{ '--chord-color': chord.color }}><i /><span>{chord.name}</span></div>)}</div>
      <div className="demo-next"><span>Next</span><strong>{next.name}</strong></div>
      <button className="demo-stop" onClick={onStop}><Icon name="stop" size={16} /> Stop demo</button>
    </section>
  )
}

function DeviceDrawer({ open, onToggle, midi, led, setLed, onIdentify, log, onClear }) {
  return (
    <section className={`device-drawer ${open ? 'open' : ''}`}>
      <button className="drawer-title" onClick={onToggle} aria-expanded={open}><Icon name="chevron" size={16} /> Device &amp; lighting</button>
      {open && <div className="drawer-content">
        <div className="device-card">
          <div className="mini-keyboard" aria-hidden="true">▮▯▮▯▯▮▯▮▯▮</div>
          <div><strong>PartyKeys 36</strong><span className={midi.connected ? 'online' : ''}>{midi.connected ? 'Connected' : 'Not connected'}</span><small>36 keys · C3–B5</small></div>
          <button onClick={onIdentify}><Icon name="spark" size={16} /> Identify LEDs</button>
        </div>
        <div className="lighting-controls">
          <label><span>LED mode</span><select value={led.mode} onChange={(e) => setLed({ ...led, mode: e.target.value })}><option>Active notes</option><option>Velocity heatmap</option><option>Pitch classes</option><option>Off</option></select></label>
          <label><span>Active note</span><div className="color-field"><input type="color" value={led.active} onChange={(e) => setLed({ ...led, active: e.target.value })} /><code>{led.active.toUpperCase()}</code></div></label>
          <label><span>Idle color</span><div className="color-field"><input type="color" value={led.idle} onChange={(e) => setLed({ ...led, idle: e.target.value })} /><code>{led.idle.toUpperCase()}</code></div></label>
          <label className="brightness"><span>Brightness</span><input type="range" min="10" max="100" value={led.brightness} onChange={(e) => setLed({ ...led, brightness: Number(e.target.value) })} /><output>{led.brightness}%</output></label>
          <label><span>LED latency</span><div className="unit-input"><input type="number" min="0" max="500" value={led.latency} onChange={(e) => setLed({ ...led, latency: Number(e.target.value) })} /><span>ms</span></div></label>
        </div>
        <div className="midi-log">
          <div><strong>MIDI activity</strong><span><i /> Live</span></div>
          <ol>{log.slice(0, 5).map((item) => <li key={item.id}><time>{item.time}</time><span>{item.type}</span><b>{item.note}</b><span>Vel {item.velocity}</span><span>Ch {item.channel}</span></li>)}</ol>
          <button onClick={onClear}>Clear</button>
        </div>
      </div>}
    </section>
  )
}

export default function App() {
  const engine = useRef(new VocoderEngine())
  const midiOutput = useRef(null)
  const demoTimers = useRef([])
  const demoRun = useRef(0)
  const demoChordNotes = useRef([])
  const activeNotesRef = useRef(new Set())
  const mediaRef = useRef(null)
  const uploadUrlRef = useRef(null)
  const [settings, setSettings] = useState(INITIAL_SETTINGS)
  const [activePreset, setActivePreset] = useState('Glass Choir')
  const [activeNotes, setActiveNotes] = useState(new Set())
  const [audio, setAudio] = useState({ started: false, loading: false, error: '' })
  const [levels, setLevels] = useState({ inputDb: -60, outputDb: -60, carrierDb: -60, wetDb: -60, effectActive: false })
  const [sourceMode, setSourceMode] = useState('microphone')
  const [sample, setSample] = useState(BUNDLED_SAMPLE)
  const [playback, setPlayback] = useState({ playing: false, currentTime: 0, duration: 0 })
  const [midi, setMidi] = useState({ connected: false, name: 'PartyKeys 36', error: '' })
  const [microphones, setMicrophones] = useState([{ deviceId: '', label: 'Hypercast / USB microphone' }])
  const [microphoneId, setMicrophoneId] = useState('')
  const [led, setLed] = useState({ mode: 'Active notes', active: '#ff684f', idle: '#282828', brightness: 80, latency: 200 })
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [demo, setDemo] = useState({ open: false, status: 'idle', step: -1, beat: 0, cycle: 0, silent: false })
  const [log, setLog] = useState([
    { id: 1, time: 'Ready', type: 'Waiting', note: '—', velocity: '—', channel: '1' },
  ])

  const updateSetting = (name, value) => {
    const next = { ...settings, [name]: value }
    setSettings(next)
    engine.current.update(next)
  }

  const noteOn = useCallback((note, velocity = 100, channel = 1) => {
    activeNotesRef.current.add(note)
    setActiveNotes((current) => new Set(current).add(note))
    engine.current.noteOn(note, velocity)
    const rgb = hexToRgb(led.active)
    const amount = led.brightness / 100
    setKeyColors(midiOutput.current, [{ color: { r: rgb.r * amount, g: rgb.g * amount, b: rgb.b * amount }, keys: [note - 48] }])
    setLog((items) => [{ id: Date.now() + note, time: new Date().toLocaleTimeString([], { hour12: false }), type: 'Note On', note: noteName(note), velocity, channel }, ...items].slice(0, 24))
  }, [led.active, led.brightness])

  const noteOff = useCallback((note, channel = 1) => {
    activeNotesRef.current.delete(note)
    setActiveNotes((current) => { const next = new Set(current); next.delete(note); return next })
    engine.current.noteOff(note)
    const idle = led.mode === 'Off' ? { r: 0, g: 0, b: 0 } : hexToRgb(led.idle)
    setKeyColors(midiOutput.current, [{ color: idle, keys: [note - 48] }])
    setLog((items) => [{ id: Date.now() + note, time: new Date().toLocaleTimeString([], { hour12: false }), type: 'Note Off', note: noteName(note), velocity: 0, channel }, ...items].slice(0, 24))
  }, [led.idle, led.mode])

  const handleMidi = useCallback((event) => {
    const [status, note, velocity] = event.data
    const command = status & 0xf0
    const channel = (status & 0x0f) + 1
    if (command === 0x90 && velocity > 0 && note >= 48 && note <= 83) noteOn(note, velocity, channel)
    if (command === 0x80 || (command === 0x90 && velocity === 0)) noteOff(note, channel)
  }, [noteOff, noteOn])

  const connectMidi = async () => {
    try {
      const result = await connectPartyKeys(handleMidi)
      midiOutput.current = result.output
      setMidi({ connected: true, name: result.output.name || 'PartyKeys 36', error: '' })
      setLog((items) => [{ id: Date.now(), time: 'Now', type: 'Connected', note: '—', velocity: '—', channel: '1' }, ...items])
      return true
    } catch (error) {
      setMidi({ connected: false, name: 'PartyKeys 36', error: error.message })
      return false
    }
  }

  const startMicrophone = async () => {
    setAudio((state) => ({ ...state, loading: true, error: '' }))
    try {
      engine.current.update(settings)
      await engine.current.start(microphoneId)
      activeNotesRef.current.forEach((note) => engine.current.noteOn(note, 100))
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter((device) => device.kind === 'audioinput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }))
      if (inputs.length) setMicrophones(inputs)
      setAudio({ started: true, loading: false, error: '' })
      return true
    } catch (error) {
      setAudio({ started: false, loading: false, error: error.message })
      return false
    }
  }

  const toggleSamplePlayback = async () => {
    const player = mediaRef.current
    if (!player) return
    if (!player.paused) {
      player.pause()
      setPlayback((state) => ({ ...state, playing: false }))
      setAudio((state) => ({ ...state, started: false }))
      return
    }
    setAudio((state) => ({ ...state, loading: true, error: '' }))
    try {
      engine.current.update(settings)
      await engine.current.startMediaElement(player)
      activeNotesRef.current.forEach((note) => engine.current.noteOn(note, 100))
      await player.play()
      setPlayback((state) => ({ ...state, playing: true }))
      setAudio({ started: true, loading: false, error: '' })
    } catch (error) {
      setPlayback((state) => ({ ...state, playing: false }))
      setAudio({ started: false, loading: false, error: error.message })
    }
  }

  const changeSourceMode = (nextMode) => {
    if (nextMode === sourceMode) return
    mediaRef.current?.pause()
    engine.current.disconnectSource()
    setSourceMode(nextMode)
    setPlayback((state) => ({ ...state, playing: false }))
    setLevels({ inputDb: -60, outputDb: -60, carrierDb: -60, wetDb: -60, effectActive: false })
    setAudio({ started: false, loading: false, error: '' })
  }

  const chooseSample = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    mediaRef.current?.pause()
    engine.current.disconnectSource()
    if (uploadUrlRef.current) URL.revokeObjectURL(uploadUrlRef.current)
    uploadUrlRef.current = URL.createObjectURL(file)
    setSourceMode('sample')
    setSample({ name: file.name, url: uploadUrlRef.current, bundled: false })
    setPlayback({ playing: false, currentTime: 0, duration: 0 })
    setAudio({ started: false, loading: false, error: '' })
    event.target.value = ''
  }

  const restoreBundledSample = () => {
    mediaRef.current?.pause()
    engine.current.disconnectSource()
    if (uploadUrlRef.current) URL.revokeObjectURL(uploadUrlRef.current)
    uploadUrlRef.current = null
    setSample(BUNDLED_SAMPLE)
    setPlayback({ playing: false, currentTime: 0, duration: 0 })
    setAudio({ started: false, loading: false, error: '' })
  }

  const seekSample = (time) => {
    if (mediaRef.current) mediaRef.current.currentTime = time
    setPlayback((state) => ({ ...state, currentTime: time }))
  }

  const startSelectedSource = () => sourceMode === 'sample' ? toggleSamplePlayback() : startMicrophone()

  const applyPreset = (name) => {
    setActivePreset(name)
    setSettings(PRESETS[name])
    engine.current.update(PRESETS[name])
  }

  const identifyLeds = () => {
    if (!midiOutput.current) return connectMidi()
    const colors = ['#ff684f', '#b7e319', '#59a7ff'].map(hexToRgb)
    setKeyColors(midiOutput.current, colors.map((color, index) => ({ color, keys: Array.from({ length: 12 }, (_, key) => key + index * 12) })))
    window.setTimeout(() => clearKeyColors(midiOutput.current), 1200)
  }

  const clearDemoTimers = () => {
    demoTimers.current.forEach((timer) => window.clearTimeout(timer))
    demoTimers.current = []
  }

  const releaseDemoChord = () => {
    demoChordNotes.current.forEach((note) => engine.current.noteOff(note))
    demoChordNotes.current = []
    activeNotesRef.current.clear()
    setActiveNotes(new Set())
  }

  const stopDemo = () => {
    demoRun.current += 1
    clearDemoTimers()
    releaseDemoChord()
    clearKeyColors(midiOutput.current)
    setDemo({ open: false, status: 'idle', step: -1, beat: 0, cycle: 0, silent: false })
    setLog((items) => [{ id: Date.now(), time: 'Now', type: 'Demo Stop', note: '—', velocity: '—', channel: '1' }, ...items].slice(0, 24))
  }

  const beginDemoSequence = async ({ silent = false } = {}) => {
    if (!silent) {
      if (!midi.connected) await connectMidi()
      const started = await startMicrophone()
      if (!started) return
    }

    demoRun.current += 1
    const run = demoRun.current
    clearDemoTimers()
    releaseDemoChord()
    setDemo({ open: false, status: 'countIn', step: -1, beat: 1, cycle: 0, silent })

    const beatMs = 60000 / DEMO_BPM
    const chordMs = beatMs * DEMO_BEATS_PER_CHORD
    const queue = (callback, delay) => {
      const timer = window.setTimeout(() => { if (demoRun.current === run) callback() }, delay)
      demoTimers.current.push(timer)
    }

    for (let beat = 1; beat <= 4; beat += 1) {
      queue(() => setDemo((current) => ({ ...current, beat })), (beat - 1) * beatMs)
    }

    const playChord = (step, cycle) => {
      if (demoRun.current !== run) return
      const chord = DEMO_CHORDS[step]
      const rgb = hexToRgb(chord.color)
      const amount = led.brightness / 100
      const activeKeys = chord.notes.map((note) => note - PARTYKEYS_RANGE.first)
      const idleKeys = Array.from({ length: PARTYKEYS_RANGE.count }, (_, index) => index).filter((index) => !activeKeys.includes(index))
      const idleColor = led.mode === 'Off' ? { r: 0, g: 0, b: 0 } : hexToRgb(led.idle)
      setKeyColors(midiOutput.current, [
        { color: idleColor, keys: idleKeys },
        { color: { r: rgb.r * amount, g: rgb.g * amount, b: rgb.b * amount }, keys: activeKeys },
      ])

      const commitChord = () => {
        releaseDemoChord()
        if (!silent) chord.notes.forEach((note) => engine.current.noteOn(note, 96))
        demoChordNotes.current = silent ? [] : chord.notes
        setActiveNotes(new Set(chord.notes))
        setDemo({ open: false, status: 'playing', step, beat: 0, cycle, silent })
        setLog((items) => [{ id: Date.now() + step, time: new Date().toLocaleTimeString([], { hour12: false }), type: 'Demo Chord', note: chord.name, velocity: 96, channel: 1 }, ...items].slice(0, 24))
      }

      if (midiOutput.current && led.latency > 0) queue(commitChord, led.latency)
      else commitChord()
      queue(() => playChord((step + 1) % DEMO_CHORDS.length, step === DEMO_CHORDS.length - 1 ? cycle + 1 : cycle), chordMs)
    }

    queue(() => playChord(0, 0), beatMs * 4)
  }

  useEffect(() => () => {
    demoRun.current += 1
    clearDemoTimers()
    engine.current.stop()
    if (uploadUrlRef.current) URL.revokeObjectURL(uploadUrlRef.current)
  }, [])

  useEffect(() => {
    engine.current.setMeterListener(({ inputDb, outputDb, carrierDb, wetDb, effectActive }) => setLevels({ inputDb, outputDb, carrierDb, wetDb, effectActive }))
    return () => engine.current.setMeterListener(null)
  }, [])

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#instrument" aria-label="Autochtune home">AUTOCHTUNE</a>
        <nav aria-label="Primary navigation"><a className="active" href="#instrument">Instrument</a><a href="#patches">Patches</a><a href="#routing">Routing</a></nav>
        <div className="topbar-actions">
          <button className={`demo-button ${demo.status !== 'idle' ? 'active' : ''}`} onClick={() => demo.status === 'idle' ? setDemo((current) => ({ ...current, open: true })) : stopDemo()}><Icon name={demo.status === 'idle' ? 'play' : 'stop'} size={15} />{demo.status === 'idle' ? 'DEMO MODE' : 'STOP DEMO'}</button>
          <button className={`connect-button ${midi.connected && audio.started ? 'connected' : ''}`} onClick={midi.connected ? startSelectedSource : connectMidi}><span /><Icon name="midi" size={16} />{midi.connected ? (audio.started ? 'MIDI + AUDIO' : 'MIDI CONNECTED') : 'CONNECT MIDI'}<Icon name="chevron" size={14} /></button>
        </div>
      </header>

      <div className="studio-grid" id="instrument">
        <aside className="input-strip">
          <div className="strip-label">Microphone</div>
          <select value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)}>{microphones.map((mic) => <option key={mic.deviceId} value={mic.deviceId}>{mic.label}</option>)}</select>
          <Meter value={levels.inputDb} />
          <Knob name="inputGain" value={settings.inputGain} onChange={(value) => updateSetting('inputGain', value)} />
          <Knob name="gate" value={settings.gate} onChange={(value) => updateSetting('gate', value)} />
          <div className="toggle-block"><span className="control-label">Monitor</span><Toggle checked={settings.monitor} onChange={(value) => updateSetting('monitor', value)} /></div>
          {audio.error && <p className="inline-error">{audio.error}</p>}
        </aside>

        <section className="instrument-main">
          <header className="hero-row">
            <div><h1>Shape the voice. Play the harmony.</h1><p>A playable 36-key vocoder built for PartyKeys and your microphone.</p></div>
            <button className={`start-button ${audio.started ? 'running' : ''}`} onClick={startSelectedSource} disabled={audio.loading}><Icon name="audio" />{audio.loading ? 'Starting…' : sourceMode === 'sample' ? (playback.playing ? 'Pause sample' : 'Play sample') : audio.started ? 'Audio running' : 'Start audio'}</button>
          </header>
          <SourcePanel mode={sourceMode} onModeChange={changeSourceMode} sample={sample} playback={playback} loading={audio.loading} onTogglePlayback={toggleSamplePlayback} onSeek={seekSample} onUpload={chooseSample} onRestore={restoreBundledSample} />
          <audio ref={mediaRef} src={sample.url} preload="metadata" onLoadedMetadata={(event) => { const duration = event.currentTarget.duration || 0; setPlayback((state) => ({ ...state, duration })) }} onTimeUpdate={(event) => { const currentTime = event.currentTarget.currentTime; setPlayback((state) => ({ ...state, currentTime })) }} onCanPlay={() => setAudio((state) => ({ ...state, error: '' }))} onError={() => setAudio((state) => ({ ...state, started: false, loading: false, error: 'This browser could not decode that audio file. Try MP3, WAV, or AAC.' }))} onPlay={() => setPlayback((state) => ({ ...state, playing: true }))} onPause={() => setPlayback((state) => ({ ...state, playing: false }))} onEnded={() => { setPlayback((state) => ({ ...state, playing: false })); setAudio((state) => ({ ...state, started: false })) }} />
          {demo.status !== 'idle' && <DemoTransport demo={demo} onStop={stopDemo} />}
          <section className="keyboard-panel">
            <div className="panel-topline"><strong>C3 — B5 / 36 keys</strong><div className={`effect-readout ${levels.effectActive ? 'active' : ''}`}><i /><span>{levels.effectActive ? 'Vocoder engaged' : audio.started ? 'Hold a key to engage' : 'Vocoder idle'}</span>{levels.effectActive && <b>{levels.wetDb.toFixed(1)} dB wet</b>}</div><div className="velocity-readout"><span>Velocity</span><b>{activeNotes.size ? '104' : '—'}</b><i /></div></div>
            <Piano activeNotes={activeNotes} onNoteOn={noteOn} onNoteOff={noteOff} />
          </section>

          <div className="synthesis-panels">
            <section className="carrier-panel">
              <h2>Carrier</h2>
              <label className="waveform-select"><span className="waveform-icon">∿</span><select value={settings.waveform} onChange={(event) => updateSetting('waveform', event.target.value)}><option value="sawtooth">Saw</option><option value="square">Pulse</option><option value="triangle">Triangle</option><option value="sine">Sine</option></select></label>
              <div className="knob-grid"><Knob name="tune" value={settings.tune} onChange={(v) => updateSetting('tune', v)} small /><label className="step-control"><span className="control-label">Unison</span><select value={settings.unison} onChange={(e) => updateSetting('unison', Number(e.target.value))}><option value="1">1 voice</option><option value="2">2 voices</option><option value="3">3 voices</option></select></label><Knob name="spread" value={settings.spread} onChange={(v) => updateSetting('spread', v)} small /><Knob name="glide" value={settings.glide} onChange={(v) => updateSetting('glide', v)} small /></div>
            </section>

            <section className="voice-panel">
              <h2>Voice</h2>
              <div className="voice-controls"><label className="step-control"><span className="control-label">Bands</span><select value={settings.bands} onChange={(e) => updateSetting('bands', Number(e.target.value))}><option>12</option><option>16</option><option>20</option><option>24</option><option>28</option></select></label><Knob name="low" value={settings.low} onChange={(v) => updateSetting('low', v)} small /><Knob name="high" value={settings.high} onChange={(v) => updateSetting('high', v)} small /><Knob name="formant" value={settings.formant} onChange={(v) => updateSetting('formant', v)} small /><Knob name="character" value={settings.character} onChange={(v) => updateSetting('character', v)} small /></div>
              <div className="voice-bottom"><BandDisplay count={settings.bands} low={settings.low} high={settings.high} /><Knob name="attack" value={settings.attack} onChange={(v) => updateSetting('attack', v)} small /><Knob name="release" value={settings.release} onChange={(v) => updateSetting('release', v)} small /></div>
            </section>

            <section className="mix-panel">
              <h2>Mix</h2>
              <div className="mix-grid"><Knob name="mix" value={settings.mix} onChange={(v) => updateSetting('mix', v)} /><Knob name="width" value={settings.width} onChange={(v) => updateSetting('width', v)} /><Knob name="output" value={settings.output} onChange={(v) => updateSetting('output', v)} /><div className="toggle-block limiter"><span className="control-label">Limiter</span><Toggle checked={settings.limiter} onChange={(v) => updateSetting('limiter', v)} /></div><Meter level="output" value={levels.outputDb} compact /></div>
            </section>
          </div>
        </section>

        <aside className="patch-strip" id="patches">
          <div className="strip-label">Patch</div>
          <div className="patch-title"><button aria-label="Previous patch">‹</button><strong>{activePreset}</strong><button aria-label="Next patch">›</button></div>
          <div className="strip-label preset-label">Presets</div>
          <div className="preset-list">{Object.keys(PRESETS).map((preset) => <button key={preset} className={preset === activePreset ? 'active' : ''} onClick={() => applyPreset(preset)}>{preset}{preset === activePreset && <span className="preset-bars">▮▯▮</span>}</button>)}</div>
          <button className="save-button"><Icon name="save" size={17} /> Save patch</button>
          <div className="patch-note"><span>Vocoder engine</span><strong>{settings.bands} bands</strong><small>{Math.round(settings.attack)} ms attack · {Math.round(settings.release)} ms release</small></div>
        </aside>
      </div>

      <DeviceDrawer open={drawerOpen} onToggle={() => setDrawerOpen((value) => !value)} midi={midi} led={led} setLed={setLed} onIdentify={identifyLeds} log={log} onClear={() => setLog([])} />

      <footer className="status-rail" id="routing"><span><em>Sample rate</em><strong>{engine.current.context ? `${(engine.current.context.sampleRate / 1000).toFixed(1)} kHz` : '48.0 kHz'}</strong></span><span><em>Audio latency</em><strong>{engine.current.context ? `${((engine.current.context.baseLatency || 0.011) * 1000).toFixed(1)} ms` : '11.2 ms'}</strong></span><span><em>MIDI channel</em><strong>1</strong></span><span><em>Sustain</em><strong className="signal">On</strong></span><span><em>Engine</em><strong>{audio.started ? 'Live' : 'Standby'}</strong></span></footer>
      {demo.open && <DemoDialog microphone={microphones.find((item) => item.deviceId === microphoneId)?.label ?? microphones[0]?.label ?? 'Default input'} midiConnected={midi.connected} onClose={() => setDemo((current) => ({ ...current, open: false }))} onPreview={() => beginDemoSequence({ silent: true })} onStart={() => beginDemoSequence({ silent: false })} loading={audio.loading} />}
      {(midi.error || audio.error) && <div className="toast" role="status">{midi.error || audio.error}</div>}
    </main>
  )
}
