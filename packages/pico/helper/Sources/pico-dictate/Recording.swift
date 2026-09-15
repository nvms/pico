import AVFoundation
import CoreAudio
import Foundation

struct LevelMeter {
    static func level(samples: UnsafePointer<Float>, count: Int) -> Double {
        guard count > 0 else { return 0 }
        var sum = 0.0
        for index in 0..<count {
            let sample = Double(samples[index])
            sum += sample * sample
        }
        let rms = sqrt(sum / Double(count))
        let decibels = 20 * log10(max(rms, 0.00001))
        return min(1, max(0, (decibels + 50) / 44))
    }
}

struct RecordingState {
    var engine: AVAudioEngine?
    var file: AVAudioFile?
    var url: URL?
    var timer: DispatchSourceTimer?
    var configurationObserver: NSObjectProtocol?
    var mutedDevice: AudioObjectID?
    var frames: AVAudioFramePosition = 0
    var active = false
    var failure: String?
    var lastLevelTime = DispatchTime(uptimeNanoseconds: 0)
}

let recordingLock = NSLock()
var recording = RecordingState()

func writeRecordingBuffer(_ buffer: AVAudioPCMBuffer) {
    var failure: String?
    recordingLock.withLock {
        guard recording.active, let file = recording.file else { return }
        do {
            try file.write(from: buffer)
            recording.frames += AVAudioFramePosition(buffer.frameLength)
            let now = DispatchTime.now()
            if now.uptimeNanoseconds - recording.lastLevelTime.uptimeNanoseconds >= 75_000_000,
               let channel = buffer.floatChannelData?[0] {
                recording.lastLevelTime = now
                emit(["status": "level", "level": LevelMeter.level(samples: channel, count: Int(buffer.frameLength))])
            }
        } catch {
            recording.active = false
            recording.failure = "audio recording failed: \(error.localizedDescription)"
            failure = recording.failure
        }
    }
    if let failure { DispatchQueue.main.async { failRecording(failure) } }
}

func releaseRecordingFile() {
    autoreleasepool {
        recordingLock.withLock {
            if #available(macOS 15.0, *) { recording.file?.close() }
            recording.file = nil
        }
    }
}

func failRecording(_ message: String) {
    guard stopRecording(deleteFile: true) != nil else { return }
    emit(["status": "error", "message": message])
}

func stopRecording(deleteFile: Bool = false) -> (URL, String?)? {
    let resources = recordingLock.withLock { () -> (AVAudioEngine, URL, DispatchSourceTimer?, NSObjectProtocol?, AudioObjectID?, String?)? in
        guard let engine = recording.engine, let url = recording.url else { return nil }
        recording.active = false
        recording.engine = nil
        recording.url = nil
        let result = (engine, url, recording.timer, recording.configurationObserver, recording.mutedDevice, recording.failure)
        recording.timer = nil
        recording.configurationObserver = nil
        recording.mutedDevice = nil
        return result
    }
    guard let (engine, url, timer, observer, mutedDevice, failure) = resources else { return nil }
    timer?.cancel()
    if let observer { NotificationCenter.default.removeObserver(observer) }
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    releaseRecordingFile()
    restoreOutput(mutedDevice)
    if deleteFile { try? FileManager.default.removeItem(at: url) }
    return (url, failure)
}


func recordingConfigurationFailure(running: Bool, sampleRate: Double, channels: AVAudioChannelCount, expectedSampleRate: Double, expectedChannels: AVAudioChannelCount) -> String? {
    if !running { return "audio recording failed: microphone stopped" }
    if sampleRate != expectedSampleRate || channels != expectedChannels {
        return "audio recording failed: microphone format changed"
    }
    return nil
}
