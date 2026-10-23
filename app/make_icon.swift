// make_icon.swift — draws Reactor's 1024x1024 app icon with AppKit / CoreGraphics.
// Run: swift make_icon.swift  →  writes icon_1024.png next to this file.
//
// Design: Big Sur rounded square, painted steel in sea-foam enamel, one round
// analogue meter with a cream dial, radiation trefoil, red danger arc and a
// needle sitting in the red zone. No text.

import AppKit
import CoreGraphics
import Foundation

// ---------------------------------------------------------------- canvas ----
let size: CGFloat = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(
    data: nil, width: Int(size), height: Int(size),
    bitsPerComponent: 8, bytesPerRow: 0, space: cs,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("no context") }

ctx.setShouldAntialias(true)
ctx.interpolationQuality = .high

// Work in y-down (top-left origin) so the design reads like a page.
ctx.translateBy(x: 0, y: size)
ctx.scaleBy(x: 1, y: -1)

// --------------------------------------------------------------- helpers ----
func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    let r = CGFloat((hex >> 16) & 0xFF) / 255
    let g = CGFloat((hex >> 8) & 0xFF) / 255
    let b = CGFloat(hex & 0xFF) / 255
    return CGColor(srgbRed: r, green: g, blue: b, alpha: alpha)
}

// Palette
let enamel      = color(0xA9BFB3)
let enamelHi    = color(0xC9D8CF)
let enamelLo    = color(0x93A99C)
let seam        = color(0x6E8478)
let cream       = color(0xEEE5CC)
let creamHi     = color(0xF8F2E1)
let creamLo     = color(0xE1D5B6)
let bakelite    = color(0x1F1D1B)
let danger      = color(0xE5372E)
let ink         = color(0x2A2925)

func roundedPath(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}
func circle(_ c: CGPoint, _ r: CGFloat) -> CGPath {
    CGPath(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r), transform: nil)
}
func grad(_ colors: [CGColor], _ locs: [CGFloat]) -> CGGradient {
    CGGradient(colorsSpace: cs, colors: colors as CFArray, locations: locs)!
}
func fillLinear(_ path: CGPath, _ colors: [CGColor], _ locs: [CGFloat],
                from: CGPoint, to: CGPoint) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.drawLinearGradient(grad(colors, locs), start: from, end: to,
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.restoreGState()
}
// Design-space polar point: angle 0 = right, 90 = down, -90 = up.
func pt(_ c: CGPoint, _ r: CGFloat, _ deg: CGFloat) -> CGPoint {
    let a = deg * .pi / 180
    return CGPoint(x: c.x + r * cos(a), y: c.y + r * sin(a))
}
// Annular sector, sampled so it behaves identically under the flipped CTM.
func sector(_ c: CGPoint, _ rIn: CGFloat, _ rOut: CGFloat,
            _ a0: CGFloat, _ a1: CGFloat, steps: Int = 72) -> CGPath {
    let p = CGMutablePath()
    p.move(to: pt(c, rOut, a0))
    for i in 1...steps {
        p.addLine(to: pt(c, rOut, a0 + (a1 - a0) * CGFloat(i) / CGFloat(steps)))
    }
    p.addLine(to: pt(c, rIn, a1))
    for i in stride(from: steps, through: 0, by: -1) {
        p.addLine(to: pt(c, rIn, a0 + (a1 - a0) * CGFloat(i) / CGFloat(steps)))
    }
    p.closeSubpath()
    return p
}
func strokeLine(_ a: CGPoint, _ b: CGPoint, _ w: CGFloat, _ col: CGColor, cap: CGLineCap = .butt) {
    ctx.saveGState()
    ctx.setStrokeColor(col)
    ctx.setLineWidth(w)
    ctx.setLineCap(cap)
    ctx.move(to: a); ctx.addLine(to: b); ctx.strokePath()
    ctx.restoreGState()
}

// Deterministic noise for the enamel grain.
var seed: UInt64 = 0x9E3779B97F4A7C15
func rnd() -> CGFloat {
    seed = seed &* 6364136223846793005 &+ 1442695040888963407
    return CGFloat((seed >> 33) % 100000) / 100000
}

// ------------------------------------------------------------------ body ----
// 824x824 body inset 100px, Big Sur-ish corner radius 22.5% of the body.
let bodyRect = CGRect(x: 100, y: 100, width: 824, height: 824)
let bodyRadius: CGFloat = 824 * 0.225
let bodyPath = roundedPath(bodyRect, bodyRadius)

// Soft drop shadow.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -16), blur: 38, color: color(0x000000, 0.34))
ctx.addPath(bodyPath)
ctx.setFillColor(enamel)
ctx.fillPath()
ctx.restoreGState()

// Enamelled steel: light falls from the top.
fillLinear(bodyPath,
           [enamelHi, enamel, color(0x9FB4A7), enamelLo],
           [0.0, 0.30, 0.72, 1.0],
           from: CGPoint(x: 512, y: 100), to: CGPoint(x: 512, y: 924))

// Enamel grain, clipped to the body.
ctx.saveGState()
ctx.addPath(bodyPath)
ctx.clip()
for _ in 0..<7000 {
    let x = 100 + rnd() * 824
    let y = 100 + rnd() * 824
    let d: CGFloat = 1.4 + rnd() * 2.4
    let light = rnd() > 0.5
    ctx.setFillColor(color(light ? 0xFFFFFF : 0x000000, light ? 0.030 : 0.022))
    ctx.fill(CGRect(x: x, y: y, width: d, height: d))
}
ctx.restoreGState()

// Bevel: bright top lip, dark bottom lip, crisp outer rim.
ctx.saveGState()
ctx.addPath(bodyPath)
ctx.clip()
ctx.setLineWidth(10)
ctx.setStrokeColor(color(0xFFFFFF, 0.30))
ctx.addPath(roundedPath(bodyRect.insetBy(dx: 2, dy: 2), bodyRadius - 2))
ctx.strokePath()

ctx.setLineWidth(16)
ctx.setStrokeColor(color(0x000000, 0.13))
ctx.addPath(roundedPath(bodyRect.insetBy(dx: -10, dy: -8), bodyRadius + 8))
ctx.strokePath()
ctx.restoreGState()

ctx.saveGState()
ctx.setLineWidth(3.5)
ctx.setStrokeColor(color(0x4F625A, 0.55))
ctx.addPath(roundedPath(bodyRect.insetBy(dx: 1.75, dy: 1.75), bodyRadius - 1.75))
ctx.strokePath()
ctx.restoreGState()

// Subtle wide highlight across the upper face.
fillLinear(bodyPath,
           [color(0xFFFFFF, 0.13), color(0xFFFFFF, 0.0), color(0x000000, 0.0), color(0x000000, 0.10)],
           [0.0, 0.18, 0.70, 1.0],
           from: CGPoint(x: 512, y: 100), to: CGPoint(x: 512, y: 924))

// --------------------------------------------------------------- screws -----
func screw(at c: CGPoint, angle: CGFloat) {
    // seat shadow
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -3), blur: 6, color: color(0x000000, 0.45))
    ctx.addPath(circle(c, 27))
    ctx.setFillColor(color(0x8FA398))
    ctx.fillPath()
    ctx.restoreGState()

    // domed head
    ctx.saveGState()
    ctx.addPath(circle(c, 27))
    ctx.clip()
    ctx.drawRadialGradient(
        grad([color(0xD9E2D9), color(0xB9C8BD), color(0x82978B)],
             [0.0, 0.62, 1.0]),
        startCenter: CGPoint(x: c.x - 8, y: c.y - 10), startRadius: 2,
        endCenter: c, endRadius: 30,
        options: [.drawsAfterEndLocation])
    ctx.restoreGState()

    // rim + inner light
    ctx.saveGState()
    ctx.setStrokeColor(color(0x4C5C53, 0.9))
    ctx.setLineWidth(3.5)
    ctx.addPath(circle(c, 26))
    ctx.strokePath()
    ctx.setStrokeColor(color(0xFFFFFF, 0.35))
    ctx.setLineWidth(2)
    ctx.addPath(circle(c, 22))
    ctx.strokePath()
    ctx.restoreGState()

    // slot
    ctx.saveGState()
    ctx.translateBy(x: c.x, y: c.y)
    ctx.rotate(by: angle * .pi / 180)
    let slot = CGPath(roundedRect: CGRect(x: -21, y: -4.5, width: 42, height: 9),
                      cornerWidth: 4.5, cornerHeight: 4.5, transform: nil)
    ctx.addPath(slot)
    ctx.setFillColor(color(0x2B302C))
    ctx.fillPath()
    // light catches the lower lip of the slot
    ctx.addPath(CGPath(roundedRect: CGRect(x: -20, y: 2.0, width: 40, height: 2.6),
                       cornerWidth: 1.3, cornerHeight: 1.3, transform: nil))
    ctx.setFillColor(color(0xFFFFFF, 0.30))
    ctx.fillPath()
    ctx.restoreGState()
}
screw(at: CGPoint(x: 172, y: 172), angle: -38)
screw(at: CGPoint(x: 852, y: 172), angle: 24)
screw(at: CGPoint(x: 172, y: 852), angle: 64)
screw(at: CGPoint(x: 852, y: 852), angle: -12)

// ---------------------------------------------------------------- meter -----
let c = CGPoint(x: 512, y: 512)
let rOuter: CGFloat = 284      // painted steel collar
let rBezel: CGFloat = 260      // outside of black bakelite bezel
let rDial: CGFloat  = 240      // cream dial

// Meter drops a small shadow onto the panel.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 20, color: color(0x000000, 0.35))
ctx.addPath(circle(c, rOuter))
ctx.setFillColor(color(0x93A79B))
ctx.fillPath()
ctx.restoreGState()

// Steel collar.
ctx.saveGState()
ctx.addPath(circle(c, rOuter))
ctx.clip()
ctx.drawRadialGradient(
    grad([color(0xD2DED5), color(0xADBEB3), color(0x8FA398), color(0x7D958A)],
         [0.0, 0.55, 0.88, 1.0]),
    startCenter: CGPoint(x: c.x - 70, y: c.y - 80), startRadius: 10,
    endCenter: c, endRadius: rOuter,
    options: [.drawsAfterEndLocation])
ctx.restoreGState()
ctx.setStrokeColor(color(0x5E7167, 0.85))
ctx.setLineWidth(4)
ctx.addPath(circle(c, rOuter - 2))
ctx.strokePath()

// Bakelite bezel.
ctx.saveGState()
ctx.addPath(circle(c, rBezel))
ctx.clip()
ctx.drawRadialGradient(
    grad([color(0x4A4641), color(0x2A2724), bakelite, color(0x121110)],
         [0.0, 0.55, 0.86, 1.0]),
    startCenter: CGPoint(x: c.x - 60, y: c.y - 70), startRadius: 40,
    endCenter: c, endRadius: rBezel,
    options: [.drawsAfterEndLocation])
ctx.restoreGState()

// Bezel highlight ring (top edge of the bakelite).
ctx.saveGState()
ctx.addPath(circle(c, rBezel - 3))
ctx.setStrokeColor(color(0xFFFFFF, 0.18))
ctx.setLineWidth(3)
ctx.strokePath()
ctx.restoreGState()

// Cream dial.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -4), blur: 10, color: color(0x000000, 0.5))
ctx.addPath(circle(c, rDial))
ctx.setFillColor(cream)
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(circle(c, rDial))
ctx.clip()
ctx.drawRadialGradient(
    grad([creamHi, cream, cream, creamLo],
         [0.0, 0.45, 0.82, 1.0]),
    startCenter: CGPoint(x: c.x - 55, y: c.y - 65), startRadius: 0,
    endCenter: c, endRadius: rDial,
    options: [.drawsAfterEndLocation])
// inner shadow around the dial edge
ctx.setStrokeColor(color(0x8A7C5E, 0.22))
ctx.setLineWidth(18)
ctx.addPath(circle(c, rDial + 4))
ctx.strokePath()
ctx.restoreGState()

// Dial graduations: bold ticks, skipped across the danger band.
for i in 0..<36 {
    let a = CGFloat(i) * 10 - 90          // start at top, go clockwise
    if a > -98 && a < -2 { continue }     // red band occupies the top-right
    let major = i % 3 == 0
    let w: CGFloat = major ? 10 : 7
    strokeLine(pt(c, major ? 214 : 222, a), pt(c, 236, a), w,
               major ? ink : color(0x2A2925, 0.7))
}

// Danger band across the top-right of the dial.
let bandIn: CGFloat = 170
let bandOut: CGFloat = 224
let bandA0: CGFloat = -84
let bandA1: CGFloat = -16
ctx.saveGState()
ctx.addPath(sector(c, bandIn, bandOut, bandA0, bandA1))
ctx.setFillColor(danger)
ctx.fillPath()
ctx.restoreGState()

// Thin ink edges define the danger zone without hairlines.
strokeLine(pt(c, bandIn, bandA0), pt(c, bandOut, bandA0), 7, ink, cap: .round)
strokeLine(pt(c, bandIn, bandA1), pt(c, bandOut, bandA1), 7, ink, cap: .round)
// A darker inner line keeps the band from looking flat.
ctx.saveGState()
ctx.addPath(sector(c, bandIn, bandIn + 8, bandA0, bandA1))
ctx.setFillColor(color(0x000000, 0.18))
ctx.fillPath()
ctx.restoreGState()

// Radiation trefoil — the real proportions: three 60° blades, 60° gaps.
let trOut: CGFloat = 134
let trIn: CGFloat  = 40
let trDot: CGFloat = 40
for start in stride(from: CGFloat(-120), through: 120, by: 120) {
    ctx.addPath(sector(c, trIn, trOut, start, start + 60))
}
ctx.setFillColor(bakelite)
ctx.fillPath()
ctx.addPath(circle(c, trDot))
ctx.setFillColor(bakelite)
ctx.fillPath()

// Needle, resting in the red band at -50°.
let needleAngle: CGFloat = -50
let needleLen: CGFloat = 214
let nad = needleAngle * .pi / 180
let nx = cos(nad), ny = sin(nad)      // along the needle
let px = -ny, py = nx                 // perpendicular

func needlePolygon(len: CGFloat, baseHalf: CGFloat, tipHalf: CGFloat) -> CGPath {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: c.x + px * baseHalf, y: c.y + py * baseHalf))
    p.addLine(to: CGPoint(x: c.x + nx * len + px * tipHalf,
                          y: c.y + ny * len + py * tipHalf))
    p.addLine(to: CGPoint(x: c.x + nx * len - px * tipHalf,
                          y: c.y + ny * len - py * tipHalf))
    p.addLine(to: CGPoint(x: c.x - px * baseHalf, y: c.y - py * baseHalf))
    p.closeSubpath()
    return p
}

// Counterweight tail.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 2, height: -3), blur: 5, color: color(0x000000, 0.45))
ctx.addPath(needlePolygon(len: -44, baseHalf: 10, tipHalf: 6))
ctx.setFillColor(bakelite)
ctx.fillPath()
ctx.restoreGState()

// Blade.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 3, height: -4), blur: 7, color: color(0x000000, 0.40))
ctx.addPath(needlePolygon(len: needleLen, baseHalf: 15, tipHalf: 3.5))
ctx.setFillColor(bakelite)
ctx.fillPath()
ctx.restoreGState()

// Pivot hub: black, with a fine cream ring so the trefoil's centre dot still reads.
ctx.setFillColor(bakelite)
ctx.addPath(circle(c, 30))
ctx.fillPath()
ctx.setStrokeColor(cream)
ctx.setLineWidth(4.5)
ctx.addPath(circle(c, 33))
ctx.strokePath()
ctx.setFillColor(color(0x000000, 0.55))
ctx.addPath(circle(c, 12))
ctx.fillPath()

// Glass: a soft sheen over the dial only.
ctx.saveGState()
ctx.addPath(circle(c, rDial))
ctx.clip()
ctx.drawLinearGradient(
    grad([color(0xFFFFFF, 0.16), color(0xFFFFFF, 0.05), color(0xFFFFFF, 0.0)],
         [0.0, 0.45, 1.0]),
    start: CGPoint(x: c.x, y: c.y - rDial),
    end: CGPoint(x: c.x, y: c.y + 70),
    options: [.drawsBeforeStartLocation])
ctx.restoreGState()

// --------------------------------------------------------------- output -----
guard let img = ctx.makeImage() else { fatalError("no image") }
let rep = NSBitmapImageRep(cgImage: img)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
let out = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("icon_1024.png")
try png.write(to: out)
print("wrote \(out.path) (\(png.count) bytes)")
