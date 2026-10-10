// 伴读 OCR：用 macOS 自带的 Vision 识别扫描页文字，输出每一行的文字和位置。
// 位置是相对整页的比例坐标（0~1，原点在左上角），和渲染尺寸无关，缩放后也能对上。
//
// 用法：ocr <图片路径>              识别一张图（伴读服务用）
//      ocr --pdf <PDF 路径> <页码>  先把 PDF 的某一页渲染成图再识别（调试用，页码从 1 开始）
import Foundation
import ImageIO
import PDFKit
import Vision

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func loadImage(_ path: String) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("读不了图片：\(path)") }
    return img
}

func renderPDFPage(_ path: String, _ pageNumber: Int, width: CGFloat = 2000) -> CGImage {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { fail("打不开 PDF：\(path)") }
    guard let page = doc.page(at: pageNumber - 1) else { fail("没有第 \(pageNumber) 页") }
    let box = page.bounds(for: .mediaBox)
    let scale = width / box.width
    let w = Int(box.width * scale), h = Int(box.height * scale)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fail("建不了画布") }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    guard let img = ctx.makeImage() else { fail("渲染失败") }
    return img
}

let args = CommandLine.arguments
let image: CGImage
if args.count == 4 && args[1] == "--pdf", let n = Int(args[3]) {
    image = renderPDFPage(args[2], n)
} else if args.count == 2 {
    image = loadImage(args[1])
} else {
    fail("用法：ocr <图片路径> | ocr --pdf <PDF 路径> <页码>")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
do {
    try VNImageRequestHandler(cgImage: image).perform([request])
} catch {
    fail("识别失败：\(error.localizedDescription)")
}

func r4(_ v: CGFloat) -> Double { (Double(v) * 10000).rounded() / 10000 }

var lines: [[String: Any]] = []
for obs in request.results ?? [] {
    guard let best = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox  // Vision 的原点在左下角，这里翻成左上角
    lines.append([
        "text": best.string,
        "x": r4(b.minX), "y": r4(1 - b.maxY), "w": r4(b.width), "h": r4(b.height),
        "conf": r4(CGFloat(best.confidence)),
    ])
}
let out: [String: Any] = ["width": image.width, "height": image.height, "lines": lines]
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
