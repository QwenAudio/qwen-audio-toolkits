#!/usr/bin/env swift

import AppKit
import Foundation

struct Cue: Decodable {
    let start: Double
    let end: Double
    let text: String
}

struct Payload: Decodable {
    let width: Int
    let height: Int
    let cues: [Cue]
}

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: render-subtitle-overlays.swift <payload.json> <output-directory>\n", stderr)
    exit(2)
}

let payloadURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let payload = try JSONDecoder().decode(Payload.self, from: Data(contentsOf: payloadURL))
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

func render(text: String?, name: String) throws {
    let width = max(2, payload.width)
    let height = max(2, payload.height)
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: width * 4,
        bitsPerPixel: 32
    ) else { throw NSError(domain: "SubtitleOverlay", code: 1) }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    if let text, !text.isEmpty {
        let scale = max(0.7, CGFloat(width) / 960)
        let fontSize = min(42, max(24, 30 * scale))
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.maximumLineHeight = fontSize * 1.25
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.8)
        shadow.shadowBlurRadius = max(2, 3 * scale)
        shadow.shadowOffset = NSSize(width: 0, height: -1 * scale)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .semibold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph,
            .shadow: shadow,
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)
        let maximumWidth = CGFloat(width) * 0.82
        let measured = attributed.boundingRect(
            with: NSSize(width: maximumWidth, height: CGFloat(height) * 0.3),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        let horizontalPadding = 20 * scale
        let verticalPadding = 10 * scale
        let boxWidth = min(CGFloat(width) - 24, ceil(measured.width) + horizontalPadding * 2)
        let boxHeight = ceil(measured.height) + verticalPadding * 2
        let boxRect = NSRect(
            x: (CGFloat(width) - boxWidth) / 2,
            y: max(22 * scale, CGFloat(height) * 0.075),
            width: boxWidth,
            height: boxHeight
        )
        NSColor.black.withAlphaComponent(0.68).setFill()
        NSBezierPath(roundedRect: boxRect, xRadius: 8 * scale, yRadius: 8 * scale).fill()
        attributed.draw(
            with: boxRect.insetBy(dx: horizontalPadding, dy: verticalPadding),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
    }

    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "SubtitleOverlay", code: 2)
    }
    try png.write(to: outputURL.appendingPathComponent(name), options: .atomic)
}

try render(text: nil, name: "blank.png")
for (index, cue) in payload.cues.enumerated() {
    try render(text: cue.text, name: String(format: "cue-%03d.png", index + 1))
}

