// vision_ocr — offline OCR sličica preko macOS Vision frameworka.
//
// Zašto zaseban binarni alat, a ne servis: OCR mora raditi bez mreže i bez
// ijednog API poziva, jer je cijela svrha da natpis s ekrana bude izvor
// identiteta NEOVISAN o modelu. Vision je na disku, ide na Neural Engine.
//
// Ulaz : putanje sličica kao argumenti, ili `-` pa putanje sa stdin (jedna po retku).
// Izlaz: JSONL, jedan redak po sličici:
//        {"path":"...","lines":[{"text":"...","conf":0.94,"box":[x,y,w,h]}]}
//
// `box` je u Visionovim normaliziranim koordinatama s ishodištem DOLJE-LIJEVO
// (y raste prema gore) — pozivatelj filtrira po tome gdje natpis stoji.
//
// Prevođenje: swiftc -O -o vision_ocr vision_ocr.swift

import Foundation
import Vision
import CoreImage
import AppKit

func recognize(path: String, languages: [String], fastPass: Bool) -> [[String: Any]] {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return []
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = fastPass ? .fast : .accurate
    req.usesLanguageCorrection = false   // imena nisu rječnik — korekcija ih kvari
    req.recognitionLanguages = languages
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { return [] }

    var out: [[String: Any]] = []
    for obs in (req.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        out.append([
            "text": top.string,
            "conf": top.confidence,
            "box": [b.origin.x, b.origin.y, b.size.width, b.size.height]
        ])
    }
    return out
}

// ── argumenti ──
var args = Array(CommandLine.arguments.dropFirst())
var languages = ["hr-HR", "en-US"]
var fastPass = false
var readStdin = false
var paths: [String] = []

var i = 0
while i < args.count {
    switch args[i] {
    case "--languages":
        i += 1; languages = args[i].split(separator: ",").map(String.init)
    case "--fast":
        fastPass = true
    case "--list-languages":
        let r = VNRecognizeTextRequest()
        r.recognitionLevel = .accurate
        let supported = (try? r.supportedRecognitionLanguages()) ?? []
        print(supported.joined(separator: "\n"))
        exit(0)
    case "-":
        readStdin = true
    default:
        paths.append(args[i])
    }
    i += 1
}

if readStdin {
    while let line = readLine(strippingNewline: true) {
        let t = line.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { paths.append(t) }
    }
}

for p in paths {
    let lines = recognize(path: p, languages: languages, fastPass: fastPass)
    let rec: [String: Any] = ["path": p, "lines": lines]
    if let d = try? JSONSerialization.data(withJSONObject: rec),
       let s = String(data: d, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}
