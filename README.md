# Autochtune

A playable browser vocoder for a PartyKeys 36 MIDI controller and a USB microphone.

## What is implemented

- A complete 36-key C3–B5 on-screen controller with mouse, touch, and hardware MIDI input.
- PartyKeys USB MIDI discovery with SysEx enabled, LED-mode initialization, and per-key RGB lighting using protocol command `0x15`.
- A real-time Web Audio vocoder worklet with 12–28 logarithmic analysis bands, separate attack/release envelope following, formant shift, character shaping, gate, dry/wet mix, and soft limiting.
- Polyphonic carrier synthesis with selectable waveform, tuning, unison, spread, and MIDI velocity response.
- USB microphone discovery and selection with browser-native permission handling.
- Switchable live-microphone or audio-file modulation, including the bundled Prufrock voice sample, local uploads, transport controls, and seeking.
- Four starting patches plus interactive device, lighting, and MIDI activity controls.
- A guided demo mode with a four-beat count-in and an 88 BPM `Cmaj7 → Am7 → Fmaj7 → Gsus4` loop. The progression drives the vocoder carrier, on-screen keyboard, MIDI log, and PartyKeys LEDs together.
- A silent choreography preview for inspecting the chord and lighting sequence before granting microphone access.
- Responsive layouts for desktop, laptop, and mobile. The keyboard remains horizontally playable on narrow screens.

## Run locally

```bash
just install
just dev
```

The app is served at a named `.localhost` URL (typically `https://autochtune.localhost`). Open it in Chrome or Edge. Click **Connect MIDI** to grant Web MIDI + SysEx access, then **Start audio** to grant microphone access. For best results, use headphones while microphone monitoring is active.

`just --list` covers build, preview, audio tests, vocoder diagnostics, and the macOS hardware checks. Equivalent `npm run` scripts remain available. Bypass portless in non-TTY environments with `PORTLESS=0`.

For the guided experience, click **Demo mode**, review the progression, then choose **Start with microphone**. Hold a comfortable “ah” through the count-in; the four-chord sequence loops until **Stop demo** is pressed. Connect MIDI first if you also want the chord tones mirrored on the PartyKeys LEDs.

Create a production build with `just build`.

## Hardware notes

Autochtune follows the [PartyKeys protocol documentation](https://protocol.partykeys.org/#protocol-partykeys) and its [source specification](https://github.com/allen4z/PartykeysProtocol):

- PartyKeys 36 uses MIDI notes 48–83.
- LED control requires SysEx access and the LED-mode initialization frame after every connection.
- Per-key RGB uses command `0x15`; the legacy note-on lighting method is intentionally not used because it echoes false key presses.
- The device documentation reports roughly 150–250 ms of LED latency. The lighting drawer defaults to 200 ms so future audio/visual synchronization has an explicit calibration point.

The browser audio engine requests raw mono input with echo cancellation, noise suppression, and automatic gain control disabled. Exact device labels, including the connected HyperX SoloCast 2 microphone, become available after microphone permission is granted.

## macOS hardware diagnostics

The backend diagnostics deliberately report USB presence, operating-system driver binding, MIDI programmability, recording-input availability, and captured signal quality as separate layers.

```bash
# Full non-invasive inventory
just hardware

# Machine-readable output for a health endpoint or CI artifact
just hardware-json

# PartyKeys-only discovery
just partykeys

# Reversible C4/E4/G4 RGB write test; lights clear after 1.5 seconds
just led-test

# Recording-input inventory
just microphone

# Four-second input-quality capture; sing during the measurement
just mic-test
```

The microphone test reports RMS and peak dBFS, clipped and zero-valued sample percentages, sample rate, channel count, and a `good`, `too-quiet`, `too-hot`, `clipping`, or `no-signal` rating. macOS may first require access for Codex or the terminal under **System Settings → Privacy & Security → Microphone**.

If PartyKeys passes USB discovery but fails CoreMIDI discovery, reconnect it while the Mac is unlocked, approve any new-accessory prompt, and inspect **Audio MIDI Setup → Window → Show MIDI Studio**. `just led-test` is the quickest repeatable check after each change.
