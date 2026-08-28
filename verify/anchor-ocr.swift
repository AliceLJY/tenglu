import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("无法读取图片\n".data(using: .utf8)!); exit(1)
}
let W = Double(cg.width), H = Double(cg.height)

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([req])

var out: [[String: Any]] = []
for obs in (req.results ?? []) {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    out.append([
        "text": top.string,
        "conf": Double(round(1000 * top.confidence) / 1000),
        "x": Int(b.minX * W),
        "y": Int((1 - b.maxY) * H),
        "w": Int(b.width * W),
        "h": Int(b.height * H),
    ])
}
let data = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .withoutEscapingSlashes])
FileHandle.standardOutput.write(data)
