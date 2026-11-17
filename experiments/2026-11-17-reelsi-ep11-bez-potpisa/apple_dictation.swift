// Apple DictationTranscriber (hr-HR, on-device) nad audio datotekom → JSON [{text,start,end}] po rezultatu.
// swiftc -O -parse-as-library apple_dictation.swift -o apple_dictation && ./apple_dictation in.wav out.json
import AVFoundation
import Foundation
import Speech

@main
struct Main {
    static func main() async {
        let a = CommandLine.arguments
        guard a.count >= 3 else { print("upotreba: apple_dictation <audio> <out.json> [locale]"); exit(2) }
        let locale = Locale(identifier: a.count > 3 ? a[3] : "hr-HR")
        do {
            let supported = await DictationTranscriber.supportedLocales
            print("podržano hr:", supported.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) })
            let tr = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation],
                                          reportingOptions: [], attributeOptions: [.audioTimeRange])
            if let req = try await AssetInventory.assetInstallationRequest(supporting: [tr]) {
                print("preuzimam model…"); try await req.downloadAndInstall()
            }
            let analyzer = SpeechAnalyzer(modules: [tr])
            let collect = Task { () throws -> [[String: Any]] in
                var out: [[String: Any]] = []
                for try await r in tr.results {
                    var s = Double.nan, e = Double.nan
                    for run in r.text.runs {
                        if let tr = run.audioTimeRange {
                            if s.isNaN { s = tr.start.seconds }
                            e = tr.end.seconds
                        }
                    }
                    out.append(["text": String(r.text.characters), "start": s.isNaN ? r.range.start.seconds : s,
                                "end": e.isNaN ? r.range.end.seconds : e])
                }
                return out
            }
            let t0 = Date()
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: a[1]))
            if let last = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            let res = try await collect.value
            let data = try JSONSerialization.data(withJSONObject: res, options: [.prettyPrinted])
            try data.write(to: URL(fileURLWithPath: a[2]))
            print(String(format: "rezultata %d, %.1f s", res.count, Date().timeIntervalSince(t0)))
        } catch {
            print("greška:", error); exit(1)
        }
    }
}
