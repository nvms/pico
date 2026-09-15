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


private let lock = NSLock()
private var recordingEngine: AVAudioEngine?
private var recordingFile: AVAudioFile?
private var recordingURL: URL?
private var timer: DispatchSourceTimer?
private var mutedDevice: AudioObjectID?

func start() async throws {
    cancel()
    guard await microphoneAllowed() else {
        throw NSError(domain: "pico-dictate", code: 1, userInfo: [NSLocalizedDescriptionKey: "microphone permission denied"])
    }

    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
        throw NSError(domain: "pico-dictate", code: 2, userInfo: [NSLocalizedDescriptionKey: "microphone is unavailable"])
    }

    try FileManager.default.createDirectory(at: audioDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let url = audioDirectory.appendingPathComponent("\(UUID().uuidString).caf")
    var started = false
    defer { if !started { try? FileManager.default.removeItem(at: url) } }
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
        do { try file.write(from: buffer) }
        catch { emit(["status": "error", "message": "audio recording failed: \(error.localizedDescription)"]) }
    }
    engine.prepare()
    try engine.start()

    lock.withLock {
        started = true
        mutedDevice = muteOutput()
        recordingEngine = engine
        recordingFile = file
        recordingURL = url
        let expiration = DispatchSource.makeTimerSource(queue: .global())
        expiration.schedule(deadline: .now() + 300)
        expiration.setEventHandler {
            expire()
        }
        timer = expiration
        expiration.resume()
    }
}

func stop() -> URL? {
    lock.lock()
    defer { lock.unlock() }
    guard let engine = recordingEngine else { return nil }
    timer?.cancel()
    timer = nil
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    recordingEngine = nil
    restoreOutput(mutedDevice)
    mutedDevice = nil
    recordingFile = nil
    let result = recordingURL
    recordingURL = nil
    return result
}

func cancel() {
    if let url = stop() { try? FileManager.default.removeItem(at: url) }
    try? FileManager.default.removeItem(at: audioDirectory)
}

private func expire() {
    guard let url = stop() else { return }
    try? FileManager.default.removeItem(at: url)
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

        while let line = readLine(strippingNewline: true) {
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
                guard let url = stop() else {
                    emit(["id": request.id, "error": "dictation is not recording"])
                    continue
                }
                defer { try? FileManager.default.removeItem(at: url) }
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
