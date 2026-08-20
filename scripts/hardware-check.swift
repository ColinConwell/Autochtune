#!/usr/bin/env swift

import Foundation
import CoreAudio
import CoreMIDI
import AVFoundation

struct Options {
    var checkPartyKeys = false
    var checkMicrophone = false
    var ledTest = false
    var micTestSeconds: Double?
    var micMatch = "hyper|solocast"
    var json = false

    static func parse() -> Options {
        var options = Options()
        let args = Array(CommandLine.arguments.dropFirst())
        var index = 0
        while index < args.count {
            switch args[index] {
            case "--partykeys": options.checkPartyKeys = true
            case "--microphone": options.checkMicrophone = true
            case "--led-test": options.ledTest = true; options.checkPartyKeys = true
            case "--json": options.json = true
            case "--mic-test":
                options.checkMicrophone = true
                if index + 1 < args.count, let seconds = Double(args[index + 1]) {
                    options.micTestSeconds = max(1, min(30, seconds))
                    index += 1
                } else {
                    options.micTestSeconds = 4
                }
            case "--mic-match":
                if index + 1 < args.count {
                    options.micMatch = args[index + 1]
                    index += 1
                }
            case "--help", "-h":
                printHelp()
                exit(0)
            default:
                fputs("Unknown option: \(args[index])\n", stderr)
                printHelp()
                exit(2)
            }
            index += 1
        }
        if !options.checkPartyKeys && !options.checkMicrophone {
            options.checkPartyKeys = true
            options.checkMicrophone = true
        }
        return options
    }
}

func printHelp() {
    print("""
    Autochtune hardware diagnostics

      --partykeys           Check PartyKeys USB and CoreMIDI availability
      --led-test            Send a reversible RGB LED test, then clear it
      --microphone          Check recording-input presence and format
      --mic-test [seconds]  Record the default input and score signal quality
      --mic-match <regex>   Preferred microphone name (default: hyper|solocast)
      --json                Emit machine-readable JSON
    """)
}

func run(_ executable: String, _ arguments: [String]) -> (status: Int32, output: String) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    } catch {
        return (-1, error.localizedDescription)
    }
}

func usbProductNames() -> [String] {
    let result = run("/usr/sbin/ioreg", ["-r", "-c", "IOUSBHostDevice", "-l", "-w", "0"])
    guard result.status == 0 else { return [] }
    let pattern = #"\"USB Product Name\" = \"([^\"]+)\""#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(result.output.startIndex..., in: result.output)
    let names: [String] = regex.matches(in: result.output, range: range).compactMap { match -> String? in
        guard let swiftRange = Range(match.range(at: 1), in: result.output) else { return nil }
        return String(result.output[swiftRange])
    }
    return Array(Set(names)).sorted()
}

func midiName(_ endpoint: MIDIEndpointRef) -> String {
    var value: Unmanaged<CFString>?
    guard MIDIObjectGetStringProperty(endpoint, kMIDIPropertyDisplayName, &value) == noErr,
          let string = value?.takeRetainedValue() else { return "Unknown MIDI endpoint" }
    return string as String
}

func midiEndpoints() -> (sources: [(MIDIEndpointRef, String)], destinations: [(MIDIEndpointRef, String)]) {
    var client = MIDIClientRef()
    let clientStatus = MIDIClientCreateWithBlock("Autochtune Endpoint Probe" as CFString, &client) { _ in }
    if clientStatus == noErr {
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    defer { if client != 0 { MIDIClientDispose(client) } }
    let sources = (0..<MIDIGetNumberOfSources()).map { index in
        let endpoint = MIDIGetSource(index)
        return (endpoint, midiName(endpoint))
    }
    let destinations = (0..<MIDIGetNumberOfDestinations()).map { index in
        let endpoint = MIDIGetDestination(index)
        return (endpoint, midiName(endpoint))
    }
    return (sources, destinations)
}

func sendMIDI(_ bytes: [UInt8], to destination: MIDIEndpointRef, port: MIDIPortRef) -> OSStatus {
    var packetList = MIDIPacketList()
    let packet = MIDIPacketListInit(&packetList)
    return bytes.withUnsafeBufferPointer { buffer in
        guard let base = buffer.baseAddress else { return -1 }
        _ = MIDIPacketListAdd(&packetList, 1024, packet, 0, buffer.count, base)
        return MIDISend(port, destination, &packetList)
    }
}

func encodedColor(_ value: UInt8) -> [UInt8] { [value / 128, value % 128] }

func colorFrame(red: UInt8, green: UInt8, blue: UInt8, keys: [UInt8]) -> [UInt8] {
    [0xF0, 0x05, 0x30, 0x7F, 0x7F, 0x20, 0x00, 0x15, 0x01]
      + encodedColor(red) + encodedColor(green) + encodedColor(blue)
      + [UInt8(keys.count)] + keys + [0xF7]
}

func groupedColorFrame(_ groups: [(UInt8, UInt8, UInt8, [UInt8])]) -> [UInt8] {
    var bytes: [UInt8] = [0xF0, 0x05, 0x30, 0x7F, 0x7F, 0x20, 0x00, 0x15, UInt8(groups.count)]
    for (red, green, blue, keys) in groups {
        bytes += encodedColor(red) + encodedColor(green) + encodedColor(blue)
        bytes += [UInt8(keys.count)] + keys
    }
    bytes.append(0xF7)
    return bytes
}

func performLEDTest(destination: MIDIEndpointRef) -> [String: Any] {
    var client = MIDIClientRef()
    var port = MIDIPortRef()
    let clientStatus = MIDIClientCreateWithBlock("Autochtune Hardware Check" as CFString, &client) { _ in }
    guard clientStatus == noErr else { return ["sent": false, "status": clientStatus, "message": "Could not create CoreMIDI client"] }
    defer { MIDIClientDispose(client) }
    let portStatus = MIDIOutputPortCreate(client, "PartyKeys LED Test" as CFString, &port)
    guard portStatus == noErr else { return ["sent": false, "status": portStatus, "message": "Could not create CoreMIDI output port"] }
    defer { MIDIPortDispose(port) }

    let enterMode: [UInt8] = [0xF0, 0x05, 0x30, 0x7F, 0x7F, 0x20, 0x00, 0x0F, 0x01, 0xF7]
    let clear = colorFrame(red: 0, green: 0, blue: 0, keys: Array(0..<36).map(UInt8.init))
    let chord = groupedColorFrame([
        (255, 104, 79, [12]),
        (183, 220, 38, [16]),
        (90, 168, 255, [19]),
    ])
    let statuses = [sendMIDI(enterMode, to: destination, port: port), sendMIDI(clear, to: destination, port: port), sendMIDI(chord, to: destination, port: port)]
    Thread.sleep(forTimeInterval: 1.5)
    let clearStatus = sendMIDI(clear, to: destination, port: port)
    let success = statuses.allSatisfy { $0 == noErr } && clearStatus == noErr
    return [
        "sent": success,
        "statuses": statuses.map(Int.init) + [Int(clearStatus)],
        "message": success ? "C4/E4/G4 LED test sent and cleared" : "One or more CoreMIDI sends failed",
        "deviceAcknowledgement": false,
    ]
}

func audioStringProperty(_ id: AudioObjectID, selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
    guard status == noErr, let value else { return nil }
    return value.takeUnretainedValue() as String
}

func audioInputChannels(_ id: AudioDeviceID) -> UInt32 {
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let list = raw.assumingMemoryBound(to: AudioBufferList.self)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, list) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + $1.mNumberChannels }
}

func audioSampleRate(_ id: AudioDeviceID) -> Double? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = Float64(0)
    var size = UInt32(MemoryLayout<Float64>.size)
    return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr ? value : nil
}

func defaultInputDeviceID() -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr ? id : nil
}

func inputDevices() -> [[String: Any]] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = Array(repeating: AudioDeviceID(0), count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
    let defaultID = defaultInputDeviceID()
    return ids.compactMap { id in
        let channels = audioInputChannels(id)
        guard channels > 0 else { return nil }
        return [
            "id": id,
            "name": audioStringProperty(id, selector: kAudioObjectPropertyName) ?? "Unknown input",
            "manufacturer": audioStringProperty(id, selector: kAudioObjectPropertyManufacturer) ?? "Unknown",
            "inputChannels": channels,
            "sampleRate": audioSampleRate(id) ?? 0,
            "isDefault": id == defaultID,
        ]
    }
}

final class SampleStats: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var sampleCount: UInt64 = 0
    private(set) var zeroCount: UInt64 = 0
    private(set) var clippedCount: UInt64 = 0
    private(set) var sumSquares = 0.0
    private(set) var peak = 0.0
    private(set) var buffers: UInt64 = 0

    func add(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData else { return }
        let frameCount = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        lock.lock()
        defer { lock.unlock() }
        buffers += 1
        for channel in 0..<channelCount {
            for frame in 0..<frameCount {
                let sample = Double(channels[channel][frame])
                let absolute = abs(sample)
                sampleCount += 1
                sumSquares += sample * sample
                peak = max(peak, absolute)
                if absolute < 0.0000001 { zeroCount += 1 }
                if absolute >= 0.99 { clippedCount += 1 }
            }
        }
    }

    func result() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard sampleCount > 0 else { return ["captured": false, "rating": "no-data"] }
        let rms = sqrt(sumSquares / Double(sampleCount))
        let rmsDb = 20 * log10(max(rms, 0.000000000001))
        let peakDb = 20 * log10(max(peak, 0.000000000001))
        let clipRatio = Double(clippedCount) / Double(sampleCount)
        let zeroRatio = Double(zeroCount) / Double(sampleCount)
        let rating: String
        let guidance: String
        if zeroRatio > 0.98 || rmsDb < -70 {
            rating = "no-signal"; guidance = "No usable signal detected; check mute, input selection, and cable"
        } else if clipRatio > 0.001 || peakDb > -0.3 {
            rating = "clipping"; guidance = "Input is clipping; lower microphone gain or move farther away"
        } else if rmsDb < -40 {
            rating = "too-quiet"; guidance = "Signal is very quiet; raise input gain or move closer"
        } else if rmsDb > -8 {
            rating = "too-hot"; guidance = "Signal is hot; reduce gain slightly for vocal headroom"
        } else {
            rating = "good"; guidance = "Signal level has useful vocal headroom and no measured clipping"
        }
        return [
            "captured": true,
            "rating": rating,
            "guidance": guidance,
            "rmsDbFS": (rmsDb * 10).rounded() / 10,
            "peakDbFS": (peakDb * 10).rounded() / 10,
            "clippedPercent": (clipRatio * 10000).rounded() / 100,
            "zeroPercent": (zeroRatio * 10000).rounded() / 100,
            "samples": sampleCount,
            "buffers": buffers,
        ]
    }
}

func microphoneAuthorization() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unknown"
    }
}

func requestMicrophoneAccessIfNeeded() -> Bool {
    let current = AVCaptureDevice.authorizationStatus(for: .audio)
    if current == .authorized { return true }
    if current == .denied || current == .restricted { return false }
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { value in granted = value; semaphore.signal() }
    semaphore.wait()
    return granted
}

func recordQuality(seconds: Double) -> [String: Any] {
    guard requestMicrophoneAccessIfNeeded() else {
        return ["captured": false, "rating": "permission-denied", "guidance": "Allow microphone access for the terminal/Codex app in System Settings → Privacy & Security → Microphone"]
    }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.inputFormat(forBus: 0)
    guard format.channelCount > 0, format.sampleRate > 0 else {
        return ["captured": false, "rating": "no-input-format", "guidance": "The default recording input has no active audio format"]
    }
    let stats = SampleStats()
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in stats.add(buffer) }
    do {
        try engine.start()
        Thread.sleep(forTimeInterval: seconds)
        engine.stop()
        input.removeTap(onBus: 0)
        var result = stats.result()
        result["seconds"] = seconds
        result["sampleRate"] = format.sampleRate
        result["channels"] = format.channelCount
        return result
    } catch {
        input.removeTap(onBus: 0)
        return ["captured": false, "rating": "engine-error", "guidance": error.localizedDescription]
    }
}

func regexMatches(_ pattern: String, _ value: String) -> Bool {
    value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
}

let options = Options.parse()
let usbNames = usbProductNames()
var report: [String: Any] = [
    "timestamp": ISO8601DateFormatter().string(from: Date()),
    "platform": "macOS",
]

if options.checkPartyKeys {
    let endpoints = midiEndpoints()
    let partySources = endpoints.sources.filter { regexMatches("partykey", $0.1) }
    let partyDestinations = endpoints.destinations.filter { regexMatches("partykey", $0.1) }
    let partyRegistry = run("/usr/sbin/ioreg", ["-r", "-n", "PartyKeys", "-l", "-w", "0"]).output
    let midiDriverRegistry = run("/usr/sbin/ioreg", ["-r", "-c", "AppleUSBAudioMIDIInterface", "-l", "-w", "0"]).output
    let usbVisible = usbNames.contains { regexMatches("partykey", $0) }
    let declaresMIDI = partyRegistry.contains("\"bInterfaceSubClass\" = 3")
    let midiDriverBound = regexMatches("partykey", midiDriverRegistry)
    let status: String
    let guidance: String
    if !usbVisible {
        status = "usb-missing"; guidance = "Reconnect PartyKeys directly or verify the USB-C cable supports data"
    } else if !declaresMIDI {
        status = "midi-interface-missing"; guidance = "USB is present, but the device did not expose a USB-MIDI streaming interface"
    } else if !midiDriverBound {
        status = "driver-not-bound"; guidance = "macOS sees the USB-MIDI descriptor, but its class driver did not bind; reconnect the device, then inspect Audio MIDI Setup"
    } else if partyDestinations.isEmpty {
        status = "coremidi-unavailable"; guidance = "The USB MIDI driver is bound, but CoreMIDI exposes no writable destination; restart the CoreMIDI service or log out/in"
    } else {
        status = "ready"; guidance = "PartyKeys is visible as a writable CoreMIDI destination"
    }
    var party: [String: Any] = [
        "usbVisible": usbVisible,
        "usbMatches": usbNames.filter { regexMatches("partykey", $0) },
        "usbMIDIInterfaceDeclared": declaresMIDI,
        "coreMIDIDriverBound": midiDriverBound,
        "midiSources": endpoints.sources.map { $0.1 },
        "midiDestinations": endpoints.destinations.map { $0.1 },
        "partyKeysInputVisible": !partySources.isEmpty,
        "partyKeysOutputVisible": !partyDestinations.isEmpty,
        "programmable": !partyDestinations.isEmpty,
        "status": status,
        "guidance": guidance,
    ]
    if options.ledTest {
        party["ledTest"] = partyDestinations.first.map { performLEDTest(destination: $0.0) }
          ?? ["sent": false, "message": "No PartyKeys MIDI output destination"]
    }
    report["partyKeys"] = party
}

if options.checkMicrophone {
    let devices = inputDevices()
    let matches = devices.filter { device in regexMatches(options.micMatch, device["name"] as? String ?? "") }
    let authorization = microphoneAuthorization()
    let usbVisible = usbNames.contains { regexMatches(options.micMatch, $0) }
    let status: String
    let guidance: String
    if !usbVisible {
        status = "usb-missing"; guidance = "Reconnect the recording microphone or verify the USB-C cable supports data"
    } else if authorization == "denied" || authorization == "restricted" {
        status = "permission-denied"; guidance = "Enable microphone access for Codex or your terminal in System Settings → Privacy & Security → Microphone"
    } else if matches.isEmpty {
        status = "coreaudio-unavailable"; guidance = "The microphone is on USB, but Core Audio exposes no matching input; inspect Sound → Input and reconnect the device"
    } else {
        status = "ready"; guidance = "The preferred recording microphone is available to Core Audio"
    }
    var microphone: [String: Any] = [
        "usbVisible": usbVisible,
        "usbMatches": usbNames.filter { regexMatches(options.micMatch, $0) },
        "inputs": devices,
        "preferredMatch": matches,
        "preferredPresent": !matches.isEmpty,
        "authorization": authorization,
        "status": status,
        "guidance": guidance,
    ]
    if let seconds = options.micTestSeconds {
        microphone["quality"] = recordQuality(seconds: seconds)
    }
    report["microphone"] = microphone
}

if options.json {
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
} else {
    print("Autochtune hardware check")
    print("==========================")
    if let party = report["partyKeys"] as? [String: Any] {
        print("PartyKeys USB:       \((party["usbVisible"] as? Bool) == true ? "PASS" : "FAIL")")
        print("PartyKeys MIDI in:   \((party["partyKeysInputVisible"] as? Bool) == true ? "PASS" : "FAIL")")
        print("PartyKeys MIDI out:  \((party["partyKeysOutputVisible"] as? Bool) == true ? "PASS" : "FAIL")")
        print("USB MIDI interface:  \((party["usbMIDIInterfaceDeclared"] as? Bool) == true ? "PASS" : "FAIL")")
        print("macOS MIDI driver:   \((party["coreMIDIDriverBound"] as? Bool) == true ? "PASS" : "FAIL")")
        if let led = party["ledTest"] as? [String: Any] {
            print("PartyKeys LED write: \((led["sent"] as? Bool) == true ? "PASS" : "FAIL") — \(led["message"] ?? "")")
        }
        let sources = party["midiSources"] as? [String] ?? []
        let destinations = party["midiDestinations"] as? [String] ?? []
        print("  MIDI sources:      \(sources.isEmpty ? "none visible" : sources.joined(separator: ", "))")
        print("  MIDI destinations: \(destinations.isEmpty ? "none visible" : destinations.joined(separator: ", "))")
        print("  Status:            \(party["status"] ?? "unknown")")
        print("  Guidance:          \(party["guidance"] ?? "")")
    }
    if let microphone = report["microphone"] as? [String: Any] {
        print("Microphone USB:      \((microphone["usbVisible"] as? Bool) == true ? "PASS" : "FAIL")")
        print("Recording input:     \((microphone["preferredPresent"] as? Bool) == true ? "PASS" : "FAIL")")
        print("Microphone access:   \(microphone["authorization"] ?? "unknown")")
        print("  Status:            \(microphone["status"] ?? "unknown")")
        print("  Guidance:          \(microphone["guidance"] ?? "")")
        if let inputs = microphone["inputs"] as? [[String: Any]] {
            for input in inputs {
                let marker = (input["isDefault"] as? Bool) == true ? " (default)" : ""
                print("  • \(input["name"] ?? "Unknown")\(marker) — \(input["inputChannels"] ?? 0) ch @ \(input["sampleRate"] ?? 0) Hz")
            }
        }
        if let quality = microphone["quality"] as? [String: Any] {
            print("Signal quality:      \(String(describing: quality["rating"] ?? "unknown").uppercased())")
            if let rms = quality["rmsDbFS"] { print("  RMS / peak:        \(rms) / \(quality["peakDbFS"] ?? "?") dBFS") }
            print("  Guidance:          \(quality["guidance"] ?? "")")
        }
    }
}
