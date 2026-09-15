import AVFoundation
import CoreAudio
import Darwin
import FluidAudio
import Foundation

struct Request: Decodable {
    let id: Int
    let op: String
}

let output = FileHandle.standardOutput
let outputLock = NSLock()

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    outputLock.lock()
    output.write(data)
    output.write(Data([0x0a]))
    outputLock.unlock()
}

let audioDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("pico-dictate-\(UUID().uuidString)")

func muteOutput() -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var device = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return nil }
    address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var muted: UInt32 = 0
    size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &muted) == noErr, muted == 0 else { return nil }
    muted = 1
    guard AudioObjectSetPropertyData(device, &address, 0, nil, size, &muted) == noErr else { return nil }
    return device
}

func restoreOutput(_ device: AudioObjectID?) {
    guard let device else { return }
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var muted: UInt32 = 0
    _ = AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &muted)
}


func start() async throws {
    cancel()
    guard await microphoneAllowed() else {
        throw NSError(domain: "pico-dictate", code: 1, userInfo: [NSLocalizedDescriptionKey: "microphone permission denied"])
    }

    let mutedDevice = muteOutput()
    var started = false
    defer { if !started { restoreOutput(mutedDevice) } }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
        throw NSError(domain: "pico-dictate", code: 2, userInfo: [NSLocalizedDescriptionKey: "microphone is unavailable"])
    }

    try FileManager.default.createDirectory(at: audioDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let url = audioDirectory.appendingPathComponent("\(UUID().uuidString).caf")
    defer { if !started { try? FileManager.default.removeItem(at: url) } }
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
        writeRecordingBuffer(buffer)
    }
    recordingLock.withLock {
        recording.engine = engine
        recording.file = file
        recording.url = url
        recording.active = true
        recording.failure = nil
        recording.lastLevelTime = .now()
        recording.mutedDevice = mutedDevice
        recording.frames = 0
        let expiration = DispatchSource.makeTimerSource(queue: .global())
        expiration.schedule(deadline: .now() + 300)
        expiration.setEventHandler { expire() }
        recording.timer = expiration
        expiration.resume()
        recording.configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { _ in
            DispatchQueue.main.async { [weak engine] in
                guard let engine else { return }
                let current = recordingLock.withLock { recording.active && recording.engine === engine }
                guard current else { return }
                let currentFormat = engine.inputNode.outputFormat(forBus: 0)
                if let failure = recordingConfigurationFailure(
                    running: engine.isRunning,
                    sampleRate: currentFormat.sampleRate,
                    channels: currentFormat.channelCount,
                    expectedSampleRate: format.sampleRate,
                    expectedChannels: format.channelCount
                ) {
                    failRecording(failure)
                }
            }
        }
    }
    engine.prepare()
    try engine.start()
    for _ in 0..<100 {
        let state = recordingLock.withLock { (recording.frames, recording.active, recording.failure) }
        if !state.1 {
            throw NSError(domain: "pico-dictate", code: 3, userInfo: [NSLocalizedDescriptionKey: state.2 ?? "microphone stopped during startup"])
        }
        if state.0 > 0 {
            started = true
            return
        }
        try await Task.sleep(nanoseconds: 50_000_000)
    }
    throw NSError(domain: "pico-dictate", code: 4, userInfo: [NSLocalizedDescriptionKey: "microphone did not deliver audio"])
}

func stop() -> (URL, String?)? {
    stopRecording()
}

func cancel() {
    if let (url, _) = stopRecording() { try? FileManager.default.removeItem(at: url) }
    try? FileManager.default.removeItem(at: audioDirectory)
}

private func expire() {
    guard stopRecording(deleteFile: true) != nil else { return }
    emit(["status": "error", "message": "dictation recording exceeded 5 minutes"])
}

private func microphoneAllowed() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
    default: return false
    }
}

@main
struct Main {
    static func main() async {
        installCleanup()
        emit(["status": "loading"])

        let manager = AsrManager(config: .default)
        do {
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            try await manager.loadModels(models)
        } catch {
            emit(["status": "error", "message": "\(error)"])
            return
        }
        emit(["status": "ready"])

        while let line = await Task.detached(priority: .userInitiated, operation: { readLine(strippingNewline: true) }).value {
            guard let data = line.data(using: .utf8) else { continue }
            let request: Request
            do { request = try JSONDecoder().decode(Request.self, from: data) }
            catch { continue }

            switch request.op {
            case "start":
                do {
                    try await start()
                    emit(["id": request.id])
                } catch {
                    cancel()
                    emit(["id": request.id, "error": error.localizedDescription])
                }
            case "stop":
                guard let (url, recordingFailure) = stop() else {
                    emit(["id": request.id, "error": "dictation is not recording"])
                    continue
                }
                defer { try? FileManager.default.removeItem(at: url) }
                if let recordingFailure {
                    emit(["id": request.id, "error": recordingFailure])
                    continue
                }
                do {
                    var state = TdtDecoderState.make()
                    let result = try await manager.transcribe(url, decoderState: &state)
                    emit(["id": request.id, "text": result.text])
                } catch {
                    emit(["id": request.id, "error": error.localizedDescription])
                }
            case "cancel":
                cancel()
                emit(["id": request.id])
            default:
                emit(["id": request.id, "error": "unknown op \(request.op)"])
            }
        }
        cancel()
    }

    static func installCleanup() {
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        for code in [SIGINT, SIGTERM] {
            let source = DispatchSource.makeSignalSource(signal: code, queue: .global())
            source.setEventHandler {
                cancel()
                exit(128 + code)
            }
            source.resume()
            signalSources.append(source)
        }
    }
}

var signalSources: [DispatchSourceSignal] = []
