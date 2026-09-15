import AVFoundation
import XCTest
@testable import pico_dictate

final class RecordingTests: XCTestCase {
    func testFinalizesThirtySecondRecordingBeforeRead() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pico-recording-test-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        try autoreleasepool {
            recording.file = try AVAudioFile(forWriting: url, settings: format.settings)
            recording.active = true
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1600)!
            buffer.frameLength = 1600
            buffer.floatChannelData![0].initialize(repeating: 0.05, count: 1600)
            recording.lastLevelTime = .now()
            for _ in 0..<300 { writeRecordingBuffer(buffer) }
            recording.active = false
            releaseRecordingFile()
        }
        XCTAssertEqual(try AVAudioFile(forReading: url).length, 480_000)
    }

    func testConfigurationNotificationsRequireActualFailure() {
        XCTAssertNil(recordingConfigurationFailure(running: true, sampleRate: 48000, channels: 1, expectedSampleRate: 48000, expectedChannels: 1))
        XCTAssertEqual(recordingConfigurationFailure(running: false, sampleRate: 48000, channels: 1, expectedSampleRate: 48000, expectedChannels: 1), "audio recording failed: microphone stopped")
        XCTAssertEqual(recordingConfigurationFailure(running: true, sampleRate: 16000, channels: 1, expectedSampleRate: 48000, expectedChannels: 1), "audio recording failed: microphone format changed")
        XCTAssertNotNil(recordingConfigurationFailure(running: true, sampleRate: 48000, channels: 2, expectedSampleRate: 48000, expectedChannels: 1))
    }

    func testLevelScaling() {
        let silence = [Float](repeating: 0, count: 800)
        let speech = [Float](repeating: 0.05, count: 800)
        let loud = [Float](repeating: 1, count: 800)
        silence.withUnsafeBufferPointer { XCTAssertEqual(LevelMeter.level(samples: $0.baseAddress!, count: $0.count), 0) }
        speech.withUnsafeBufferPointer { XCTAssertEqual(LevelMeter.level(samples: $0.baseAddress!, count: $0.count), 0.5450, accuracy: 0.001) }
        loud.withUnsafeBufferPointer { XCTAssertEqual(LevelMeter.level(samples: $0.baseAddress!, count: $0.count), 1) }
    }
}
