// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package tools

// macOSSnippet is the Swift source of the macOS computer-use helper, ported
// verbatim from the TS reference (src/tools/snippets.ts MACOS_SNIPPET) and
// verified byte-identical. It is written to a temp file at runtime and executed
// with `swift <file>`; the JSON action payload arrives base64-encoded in the
// YUKINO_COMPUTER_INPUT environment variable.
const macOSSnippet = `
import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data(message.utf8))
  exit(2)
}

guard let encoded = ProcessInfo.processInfo.environment["YUKINO_COMPUTER_INPUT"],
  let data = Data(base64Encoded: encoded),
  let object = try? JSONSerialization.jsonObject(with: data),
  let input = object as? [String: Any],
  let action = input["action"] as? String
else {
  fail("Invalid computer action payload.")
}

let keyCodes: [String: CGKeyCode] = [
  "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7,
  "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
  "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
  "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35, "RETURN": 36,
  "ENTER": 36, "L": 37, "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "N": 45, "M": 46, ".": 47, "TAB": 48, "SPACE": 49,
  "GRAVE": 50, "BACKTICK": 50, "BACKSPACE": 51, "DELETE": 51, "ESC": 53, "ESCAPE": 53,
  "CMD": 55, "COMMAND": 55, "META": 55, "SHIFT": 56, "CAPSLOCK": 57,
  "ALT": 58, "OPTION": 58, "CTRL": 59, "CONTROL": 59, "LEFT": 123,
  "RIGHT": 124, "DOWN": 125, "UP": 126, "HOME": 115, "END": 119,
  "PAGEUP": 116, "PAGEDOWN": 121, "F1": 122, "F2": 120, "F3": 99,
  "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101,
  "F10": 109, "F11": 103, "F12": 111,
]

func number(_ name: String) -> CGFloat {
  guard let value = input[name] as? NSNumber else { fail("Missing " + name + ".") }
  return CGFloat(value.doubleValue)
}

func keys() -> [String] {
  return (input["keys"] as? [String] ?? []).map { $0.uppercased() }
}

func keyCode(_ name: String) -> CGKeyCode {
  guard let code = keyCodes[name.uppercased()] else { fail("Unsupported key: " + name) }
  return code
}

func keyEvent(_ name: String, _ down: Bool) {
  guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode(name), keyDown: down)
  else {
    fail("Unable to create keyboard event.")
  }
  event.post(tap: .cghidEventTap)
}

func withKeys(_ names: [String], _ body: () -> Void) {
  for name in names { keyEvent(name, true) }
  body()
  for name in names.reversed() { keyEvent(name, false) }
}

func mouseEvent(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) {
  guard
    let event = CGEvent(
      mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  else {
    fail("Unable to create mouse event.")
  }
  event.setIntegerValueField(.mouseEventClickState, value: clicks)
  event.post(tap: .cghidEventTap)
}

if action == "screen_size" {
  let bounds = CGDisplayBounds(CGMainDisplayID())
  print("\(Int(bounds.width)),\(Int(bounds.height))")
  exit(0)
}

if action == "cursor_position" {
  guard let event = CGEvent(source: nil) else { fail("Unable to read cursor position.") }
  print("\(Int(event.location.x)),\(Int(event.location.y))")
  exit(0)
}

if !AXIsProcessTrusted() {
  fail(
    "Accessibility permission is required. Enable it for the terminal running Yukino in System Settings > Privacy & Security > Accessibility."
  )
}

let point = CGPoint(
  x: (input["x"] as? NSNumber)?.doubleValue ?? 0,
  y: (input["y"] as? NSNumber)?.doubleValue ?? 0
)
let heldKeys = keys()

switch action {
case "mouse_move":
  withKeys(heldKeys) { mouseEvent(.mouseMoved, point, .left) }
case "left_mouse_down":
  mouseEvent(.leftMouseDown, CGEvent(source: nil)?.location ?? point, .left)
case "left_mouse_up":
  mouseEvent(.leftMouseUp, CGEvent(source: nil)?.location ?? point, .left)
case "mouse_click":
  let buttonName = input["button"] as? String ?? "left"
  let button: CGMouseButton =
    buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
  let downType: CGEventType =
    button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
  let upType: CGEventType =
    button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
  let count = (input["clicks"] as? NSNumber)?.int64Value ?? 1
  withKeys(heldKeys) {
    mouseEvent(.mouseMoved, point, button)
    for click in 1...count {
      mouseEvent(downType, point, button, clicks: click)
      mouseEvent(upType, point, button, clicks: click)
      Thread.sleep(forTimeInterval: 0.08)
    }
  }
case "left_click_drag":
  guard let path = input["path"] as? [[String: NSNumber]], let first = path.first else {
    fail("Drag path is missing.")
  }
  let start = CGPoint(x: first["x"]?.doubleValue ?? 0, y: first["y"]?.doubleValue ?? 0)
  withKeys(heldKeys) {
    mouseEvent(.mouseMoved, start, .left)
    mouseEvent(.leftMouseDown, start, .left)
    for item in path.dropFirst() {
      let next = CGPoint(x: item["x"]?.doubleValue ?? 0, y: item["y"]?.doubleValue ?? 0)
      mouseEvent(.leftMouseDragged, next, .left)
      Thread.sleep(forTimeInterval: 0.02)
    }
    let end = path.last ?? first
    mouseEvent(
      .leftMouseUp, CGPoint(x: end["x"]?.doubleValue ?? 0, y: end["y"]?.doubleValue ?? 0), .left)
  }
case "scroll":
  if let x = input["x"] as? NSNumber, let y = input["y"] as? NSNumber {
    mouseEvent(.mouseMoved, CGPoint(x: x.doubleValue, y: y.doubleValue), .left)
  }
  let horizontal = Int32((input["scrollX"] as? NSNumber)?.intValue ?? 0)
  let vertical = Int32((input["scrollY"] as? NSNumber)?.intValue ?? 0)
  withKeys(heldKeys) {
    CGEvent(
      scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: -vertical,
      wheel2: -horizontal, wheel3: 0)?.post(tap: .cghidEventTap)
  }
case "key", "hold_key":
  let names = keys()
  if names.isEmpty { fail("No keys supplied.") }
  for name in names { keyEvent(name, true) }
  if action == "hold_key" {
    Thread.sleep(forTimeInterval: (input["duration"] as? NSNumber)?.doubleValue ?? 0)
  }
  for name in names.reversed() { keyEvent(name, false) }
case "type":
  let text = input["text"] as? String ?? ""
  let units = Array(text.utf16)
  units.withUnsafeBufferPointer { buffer in
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    else {
      fail("Unable to create text input events.")
    }
    down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
    up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
  }
default:
  fail("Unsupported action: " + action)
}
`
