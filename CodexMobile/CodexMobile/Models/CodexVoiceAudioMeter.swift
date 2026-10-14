import Foundation

nonisolated struct CodexVoiceAudioSample: Sendable {
    enum Source: Equatable, Sendable { case microphone, assistant }

    let source: Source
    let id: String
    let timestamp: Double
    let level: Double?
    let energy: Double?
    let duration: Double?

    init?(id: String, type: String, timestamp: Double, values: [String: NSObject]) {
        guard values["kind"] as? String == "audio", timestamp.isFinite else { return nil }
        switch type {
        case "media-source": source = .microphone
        case "inbound-rtp": source = .assistant
        default: return nil
        }
        self.id = id
        self.timestamp = timestamp
        func number(_ key: String) -> Double? {
            guard let value = (values[key] as? NSNumber)?.doubleValue,
                  value.isFinite, value >= 0 else { return nil }
            return value
        }
        level = number("audioLevel")
        energy = number("totalAudioEnergy")
        duration = number("totalSamplesDuration")
    }
}

nonisolated struct CodexVoiceAudioMeter: Sendable {
    static let sampleInterval: TimeInterval = 0.1
    static let capacity = 60

    private(set) var levels: [CGFloat] = []
    private var previous: CodexVoiceAudioSample?

    mutating func append(_ sample: CodexVoiceAudioSample?, enabled: Bool = true) {
        let last = previous
        previous = sample
        var rms = 0.0
        if enabled, let sample {
            if let last, last.id == sample.id {
                if sample.timestamp > last.timestamp {
                    if let energy = sample.energy, let duration = sample.duration,
                       let oldEnergy = last.energy, let oldDuration = last.duration {
                        // Cumulative counters give this window's RMS; unchanged counters mean silence.
                        if energy >= oldEnergy, duration > oldDuration {
                            rms = sqrt((energy - oldEnergy) / (duration - oldDuration))
                        }
                    } else {
                        rms = sample.level ?? 0
                    }
                }
            } else {
                rms = sample.level ?? 0
            }
        }
        let decibels = 20 * log10(max(rms.isFinite ? rms : 0, 1e-6))
        levels.append(CGFloat(max(0, min(1, (decibels + 50) / 50))))
        if levels.count > Self.capacity { levels.removeFirst(levels.count - Self.capacity) }
    }

    mutating func reset() {
        levels.removeAll(keepingCapacity: true)
        previous = nil
    }
}
