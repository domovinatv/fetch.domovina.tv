// vision_best_frame — izbor najljepšeg kadra kroz Apple Vision (lokalno, $0, bez mreže).
//
//   vision_best_frame --original <idx> c01.png c02.png ... c21.png
//   vision_best_frame --text a.png b.png ...     (ima li teksta na kadru, vidi niže)
//
// <idx> je 1-based indeks kadra točno na timestampu. Ispisuje JSON na stdout:
//   { best, best_score, original_score, reason, frames: [ metrike po kadru ] }
// Isti oblik odluke kao Gemini/agy u screenshot_youtube.js (best = "c07").
//
// Metrike po kadru (sve iz Visiona, Neural Engine):
//   - VNDetectFaceCaptureQualityRequest  → kvaliteta lica 0..1 (oči, oštrina, svjetlo, poza)
//   - VNDetectFaceLandmarksRequest        → otvorenost očiju (visina/širina oka) + pitch/yaw glave
//   - VNCalculateImageAestheticsScoresRequest → estetika cijelog kadra -1..1 (macOS 15+)
//   - VNGenerateImageFeaturePrintRequest  → nad izrezom lica: „ista osoba" kao na timestampu,
//                                           nad cijelim kadrom: „isti kadar kamere"
// Pravila odluke su opisana u docs/2026-10-26-screenshot-izbor-kadra.md (§Apple Vision).

import Foundation
import Vision
import CoreGraphics
import ImageIO

struct FaceInfo {
    var box: CGRect          // normalizirano, ishodište dolje lijevo
    var quality: Float
    var eyeOpen: Double      // 0..1
    var pitch: Double
    var yaw: Double
}

struct FrameInfo {
    var label: String
    var face: FaceInfo?
    var faceCount: Int
    var aesthetics: Double   // -1..1, 0 ako nije dostupno
    var utility: Bool
    var sceneDist: Double    // feature print cijelog kadra vs original
    var faceDist: Double     // feature print lica vs lice na originalu (-1 = nema)
    var score: Double = 0
    var eligible: Bool = false
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func loadImage(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func featurePrint(_ img: CGImage) -> VNFeaturePrintObservation? {
    let req = VNGenerateImageFeaturePrintRequest()
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    return req.results?.first
}

func distance(_ a: VNFeaturePrintObservation?, _ b: VNFeaturePrintObservation?) -> Double {
    guard let a = a, let b = b else { return -1 }
    var d: Float = 0
    do { try a.computeDistance(&d, to: b) } catch { return -1 }
    return Double(d)
}

// Omjer visina/širina oka iz landmark točaka; otvoreno oko ~0.28+, zatvoreno ~0.10.
func eyeRatio(_ region: VNFaceLandmarkRegion2D?) -> Double? {
    guard let r = region, r.pointCount >= 4 else { return nil }
    let pts = r.normalizedPoints
    let xs = pts.map { Double($0.x) }, ys = pts.map { Double($0.y) }
    let w = xs.max()! - xs.min()!, h = ys.max()! - ys.min()!
    return w > 0 ? h / w : nil
}

func cropFace(_ img: CGImage, _ box: CGRect, margin: CGFloat = 0.25) -> CGImage? {
    let W = CGFloat(img.width), H = CGFloat(img.height)
    var r = CGRect(x: box.minX * W, y: (1 - box.maxY) * H, width: box.width * W, height: box.height * H)
    r = r.insetBy(dx: -r.width * margin, dy: -r.height * margin)
    r = r.intersection(CGRect(x: 0, y: 0, width: W, height: H))
    return r.isEmpty ? nil : img.cropping(to: r)
}

// Lica na cijelom kadru: landmarks (oči, poza) + capture quality, spojeni po položaju.
// Svaki zahtjev zasebno: jedna greška u zajedničkom perform() poništi sve rezultate.
func detectFaces(_ img: CGImage) -> [FaceInfo] {
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    let landmarks = VNDetectFaceLandmarksRequest()
    let quality = VNDetectFaceCaptureQualityRequest()
    // Poza glave (pitch = glava dolje prema laptopu/stolu) dolazi samo iz rectangles revision 3.
    let rects = VNDetectFaceRectanglesRequest()
    rects.revision = VNDetectFaceRectanglesRequestRevision3
    for r in [landmarks, quality, rects] as [VNRequest] {
        do { try handler.perform([r]) } catch {
            FileHandle.standardError.write("⚠️ \(type(of: r)): \(error)\n".data(using: .utf8)!)
        }
    }
    let fq = quality.results ?? []
    let fr = rects.results ?? []
    func nearest(_ list: [VNFaceObservation], _ b: CGRect) -> VNFaceObservation? {
        list.min(by: { hypot($0.boundingBox.midX - b.midX, $0.boundingBox.midY - b.midY)
                     < hypot($1.boundingBox.midX - b.midX, $1.boundingBox.midY - b.midY) })
    }
    return (landmarks.results ?? []).map { obs in
        let pose = nearest(fr, obs.boundingBox)
        let q = fq.min(by: { hypot($0.boundingBox.midX - obs.boundingBox.midX, $0.boundingBox.midY - obs.boundingBox.midY)
                           < hypot($1.boundingBox.midX - obs.boundingBox.midX, $1.boundingBox.midY - obs.boundingBox.midY) })
        let ratios = [eyeRatio(obs.landmarks?.leftEye), eyeRatio(obs.landmarks?.rightEye)].compactMap { $0 }
        let ratio = ratios.isEmpty ? 0.2 : ratios.reduce(0, +) / Double(ratios.count)
        return FaceInfo(box: obs.boundingBox,
                        quality: q?.faceCaptureQuality ?? 0,
                        eyeOpen: min(1, max(0, (ratio - 0.12) / (0.28 - 0.12))),
                        pitch: pose?.pitch?.doubleValue ?? 0,
                        yaw: pose?.yaw?.doubleValue ?? 0)
    }
}

// Govornik u malom PiP prozoru preko snimke ekrana ima lice od ~40 px, a Vision interno
// smanjuje ulaz pa ga na cijelom kadru ne nađe. Drugi prolaz: 3x2 preklapajuće pločice,
// boxovi se vrate u koordinate cijelog kadra. Kvaliteta lica se računa unutar pločice.
func detectFacesTiled(_ img: CGImage) -> [FaceInfo] {
    let W = CGFloat(img.width), H = CGFloat(img.height)
    let cols = 3, rows = 2, overlap: CGFloat = 0.25
    let tw = W / CGFloat(cols) * (1 + overlap), th = H / CGFloat(rows) * (1 + overlap)
    var out: [FaceInfo] = []
    for r in 0..<rows {
        for c in 0..<cols {
            let x = min(W - tw, max(0, CGFloat(c) * W / CGFloat(cols) - tw * overlap / 2))
            let yTop = min(H - th, max(0, CGFloat(r) * H / CGFloat(rows) - th * overlap / 2))
            guard let tile = img.cropping(to: CGRect(x: x, y: yTop, width: tw, height: th)) else { continue }
            for var f in detectFaces(tile) {
                // tile box (ishodište dolje lijevo) → cijeli kadar
                let bx = (x + f.box.minX * tw) / W
                let by = (H - yTop - th + f.box.minY * th) / H
                f.box = CGRect(x: bx, y: by, width: f.box.width * tw / W, height: f.box.height * th / H)
                if !out.contains(where: { $0.box.intersection(f.box).width > 0.5 * min($0.box.width, f.box.width) }) {
                    out.append(f)
                }
            }
        }
    }
    return out
}

// ── način --text: ima li na kadru teksta (snimka ekrana, slajd) ──
//
//   vision_best_frame --text a.png b.png ...
//
// Za og-sections (generate_og_sections.py): preko snimke ekrana s tekstom se ne smije
// lijepiti naslov sekcije. Po slici: broj redaka teksta i udio površine koju pokrivaju,
// ukupno i u donjih 65 % kadra (tamo ide gradijent s naslovom).
if CommandLine.arguments.dropFirst().first == "--text" {
    var out: [[String: Any]] = []
    for p in CommandLine.arguments.dropFirst(2) {
        guard let img = loadImage(p) else { out.append(["path": p, "error": "ne mogu učitati"]); continue }
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .fast
        req.usesLanguageCorrection = false
        do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([req]) } catch {
            out.append(["path": p, "error": "\(error)"]); continue
        }
        let obs = (req.results ?? []).filter { $0.confidence >= 0.3 }
        var area = 0.0, lowArea = 0.0, lowLines = 0, lowBigArea = 0.0, maxH = 0.0
        for o in obs {
            let b = o.boundingBox
            maxH = max(maxH, Double(b.height))
            area += Double(b.width * b.height)
            // donjih 65 % kadra (Vision: ishodište dolje lijevo)
            let low = max(0, min(b.maxY, 0.65) - b.minY)
            if low > 0 { lowArea += Double(b.width * low); lowLines += 1 }
            // Krupan tekst (redak ≥ 2,5 % visine kadra) = slajd, natpis, titl — čitljiv i
            // namijenjen gledatelju. Projekcija u dvorani snimljena izdaleka je sitna.
            if low > 0 && b.height >= 0.025 { lowBigArea += Double(b.width * low) }
        }
        let cls = VNClassifyImageRequest()
        try? VNImageRequestHandler(cgImage: img, options: [:]).perform([cls])
        let screenshot = Double((cls.results ?? []).first { $0.identifier == "screenshot" }?.confidence ?? 0)
        // isUtility = Appleova oznaka za snimku ekrana, dokument, slajd (macOS 15+).
        var utility = false, aes = 0.0
        if #available(macOS 15.0, *) {
            let a = VNCalculateImageAestheticsScoresRequest()
            try? VNImageRequestHandler(cgImage: img, options: [:]).perform([a])
            if let o = a.results?.first { utility = o.isUtility; aes = Double(o.overallScore) }
        }
        let humans = VNDetectHumanRectanglesRequest()
        humans.upperBodyOnly = false
        try? VNImageRequestHandler(cgImage: img, options: [:]).perform([humans])
        let people = (humans.results ?? []).filter { $0.confidence >= 0.5 }
        let peopleArea = people.reduce(0.0) { $0 + Double($1.boundingBox.width * $1.boundingBox.height) }
        // Odluka (kalibrirano 28.10. na QkcpHsj43rE, nBPDxzrAW0Q, n38M_g__TxQ): kadar dvorane
        // ima najviši redak ≤ 4,4 % (logo na zidu, daleka projekcija) i ≤ 1,5 % teksta dolje;
        // slajd ima naslov ≥ 4,4 % i/ili ≥ 3,6 % teksta dolje. Pogreška prema „ima teksta"
        // je bezopasna (og slika bez natpisa), obrnuta lijepi naslov preko slajda.
        let env = ProcessInfo.processInfo.environment
        let maxHLimit = Double(env["VISION_TEXT_MAX_H"] ?? "") ?? 0.05
        let lowLimit = Double(env["VISION_TEXT_LOW_AREA"] ?? "") ?? 0.03
        var why: [String] = []
        if screenshot >= 0.5 { why.append("snimka ekrana") }
        if maxH >= maxHLimit { why.append(String(format: "krupan tekst %.1f %%", maxH * 100)) }
        if lowArea >= lowLimit { why.append(String(format: "tekst dolje %.1f %%", lowArea * 100)) }
        out.append(["path": p, "has_text": !why.isEmpty, "why": why.joined(separator: ", "),
                    "lines": obs.count, "low_lines": lowLines,
                    "area": (area * 10000).rounded() / 10000, "low_area": (lowArea * 10000).rounded() / 10000,
                    "low_big_area": (lowBigArea * 10000).rounded() / 10000,
                    "max_h": (maxH * 1000).rounded() / 1000,
                    "screenshot": (screenshot * 100).rounded() / 100,
                    "utility": utility, "aes": (aes * 1000).rounded() / 1000,
                    "people": people.count, "people_area": (peopleArea * 1000).rounded() / 1000])
    }
    let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}

// ── argumenti ─────────────────────────────────────────────
var args = Array(CommandLine.arguments.dropFirst())
var originalIdx = 0
if let i = args.firstIndex(of: "--original"), i + 1 < args.count {
    originalIdx = Int(args[i + 1]) ?? 0
    args.removeSubrange(i...(i + 1))
}
let paths = args
if paths.count < 2 || originalIdx < 1 || originalIdx > paths.count {
    fail("upotreba: vision_best_frame --original <idx> c01.png c02.png ...")
}

// ── analiza svakog kadra ──────────────────────────────────
var frames: [FrameInfo] = []
var images: [CGImage] = []
var facePrints: [VNFeaturePrintObservation?] = []
var scenePrints: [VNFeaturePrintObservation?] = []

for p in paths {
    guard let img = loadImage(p) else { fail("ne mogu učitati \(p)") }
    images.append(img)
    var faces = detectFaces(img)
    if faces.isEmpty { faces = detectFacesTiled(img) }
    // Glavno lice = najveće (govornik u kadru ili u PiP prozoru, ne publika u pozadini).
    let face = faces.max(by: { $0.box.width * $0.box.height < $1.box.width * $1.box.height })
    var aesReq: VNRequest? = nil
    if #available(macOS 15.0, *) {
        let a = VNCalculateImageAestheticsScoresRequest()
        do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([a]) } catch {
            FileHandle.standardError.write("⚠️ estetika: \(error)\n".data(using: .utf8)!)
        }
        aesReq = a
    }
    var aes = 0.0, utility = false
    if #available(macOS 15.0, *), let a = aesReq as? VNCalculateImageAestheticsScoresRequest, let o = a.results?.first {
        aes = Double(o.overallScore); utility = o.isUtility
    }
    facePrints.append(face.flatMap { cropFace(img, $0.box) }.flatMap { featurePrint($0) })
    scenePrints.append(featurePrint(img))
    let label = "c" + String(format: "%02d", frames.count + 1)
    frames.append(FrameInfo(label: label, face: face, faceCount: faces.count, aesthetics: aes,
                            utility: utility, sceneDist: 0, faceDist: -1))
}

let oi = originalIdx - 1
for i in frames.indices {
    frames[i].sceneDist = distance(scenePrints[i], scenePrints[oi])
    frames[i].faceDist = distance(facePrints[i], facePrints[oi])
}

// ── odluka ────────────────────────────────────────────────
// Pragovi kalibrirani na QkcpHsj43rE (28.10.2026.) — vidi doc.
let SAME_FACE_MAX_DIST = Double(ProcessInfo.processInfo.environment["VISION_SAME_FACE_DIST"] ?? "") ?? 0.75
let SAME_SHOT_MAX_DIST = Double(ProcessInfo.processInfo.environment["VISION_SAME_SHOT_DIST"] ?? "") ?? 0.75
let MIN_GAIN = 0.08   // manje od toga nije vrijedno pomicanja s timestampa
// Lice niže od ~6 % kadra (PiP govornika preko snimke ekrana, ~40–65 px u 1080p): oči i
// kvaliteta su tu šumni, pa se kadar pomiče samo uz jasan dobitak.
let SMALL_FACE_H = 0.06
let MIN_GAIN_SMALL = 0.15

func faceScore(_ f: FrameInfo) -> Double {
    guard let face = f.face else { return 0 }
    let aesN = (f.aesthetics + 1) / 2
    // Glava dolje/u stranu: Vision kvaliteta to djelomično hvata, ovo je dodatna kazna.
    let posePenalty = max(0, abs(face.pitch) - 0.3) * 0.5 + max(0, abs(face.yaw) - 0.6) * 0.3
    return 0.55 * Double(face.quality) + 0.30 * face.eyeOpen + 0.15 * aesN - posePenalty
}

let orig = frames[oi]
var reason = ""
var bestIdx = oi

if let of = orig.face {
    // Ista osoba = slično lice (feature print) i približno isto mjesto u kadru.
    for i in frames.indices {
        guard let f = frames[i].face else { continue }
        let moved = hypot(f.box.midX - of.box.midX, f.box.midY - of.box.midY)
        let sameFace = frames[i].faceDist >= 0 && frames[i].faceDist <= SAME_FACE_MAX_DIST
        frames[i].eligible = i == oi || (sameFace && moved < 0.2)
        let offset = abs(Double(i - oi)) * 0.5
        frames[i].score = faceScore(frames[i]) - 0.004 * offset
    }
    let cands = frames.indices.filter { frames[$0].eligible }
    let top = cands.max(by: { frames[$0].score < frames[$1].score }) ?? oi
    let need = of.box.height < SMALL_FACE_H ? MIN_GAIN_SMALL : MIN_GAIN
    if top != oi && frames[top].score - frames[oi].score >= need { bestIdx = top }
    let b = frames[bestIdx]
    if bestIdx == oi {
        reason = String(format: "Vision: kadar na timestampu je najbolji među %d s istom osobom (kvaliteta lica %.2f, oči %.2f).",
                        cands.count, of.quality, of.eyeOpen)
    } else {
        reason = String(format: "Vision: ista osoba, kvaliteta lica %.2f→%.2f, oči %.2f→%.2f, estetika %.2f→%.2f.",
                        of.quality, b.face!.quality, of.eyeOpen, b.face!.eyeOpen, orig.aesthetics, b.aesthetics)
    }
} else {
    // Bez lica na timestampu (ekran, slajd, publika iz daljine): članak tu opisuje SADRŽAJ
    // kadra, pa se ne bježi na govornika. Bira se samo unutar istog kadra kamere/ekrana,
    // po estetici (oštrina, bez pretapanja), uz prednost bliže timestampu.
    for i in frames.indices {
        frames[i].eligible = i == oi || (frames[i].sceneDist >= 0 && frames[i].sceneDist <= SAME_SHOT_MAX_DIST && frames[i].face == nil)
        frames[i].score = (frames[i].aesthetics + 1) / 2 - 0.004 * abs(Double(i - oi)) * 0.5
    }
    let cands = frames.indices.filter { frames[$0].eligible }
    let top = cands.max(by: { frames[$0].score < frames[$1].score }) ?? oi
    if top != oi && frames[top].score - frames[oi].score >= MIN_GAIN { bestIdx = top }
    reason = bestIdx == oi
        ? "Vision: nema lica na timestampu (ekran/slajd) — zadržan točni kadar."
        : String(format: "Vision: nema lica, isti kadar ekrana, estetika %.2f→%.2f.", orig.aesthetics, frames[bestIdx].aesthetics)
}

func toTen(_ s: Double) -> Int { max(1, min(10, Int((1 + 9 * s).rounded()))) }

let out: [String: Any] = [
    "best": frames[bestIdx].label,
    "best_score": toTen(frames[bestIdx].score),
    "original_score": toTen(frames[oi].score),
    "reason": reason,
    "has_face": orig.face != nil,
    "frames": frames.map { f -> [String: Any] in
        var d: [String: Any] = [
            "label": f.label, "faces": f.faceCount,
            "aes": (f.aesthetics * 1000).rounded() / 1000, "utility": f.utility,
            "scene_dist": (f.sceneDist * 1000).rounded() / 1000,
            "score": (f.score * 1000).rounded() / 1000, "eligible": f.eligible
        ]
        if let face = f.face {
            d["quality"] = (Double(face.quality) * 1000).rounded() / 1000
            d["eye_open"] = (face.eyeOpen * 1000).rounded() / 1000
            d["pitch"] = (face.pitch * 100).rounded() / 100
            d["yaw"] = (face.yaw * 100).rounded() / 100
            d["face_dist"] = (f.faceDist * 1000).rounded() / 1000
            // box u pikselima, ishodište gore lijevo (za izrez/provjeru)
            let W = Double(images[0].width), H = Double(images[0].height)
            d["box"] = [Int(face.box.minX * W), Int((1 - face.box.maxY) * H), Int(face.box.width * W), Int(face.box.height * H)]
        }
        return d
    }
]
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
