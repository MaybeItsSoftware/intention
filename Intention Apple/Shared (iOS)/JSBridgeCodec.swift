//
//  JSBridgeCodec.swift
//  Shared (iOS)
//
//  Created by Adam on 09/07/2026.
//

import Foundation

// Encodes a native value for safe embedding into a WKWebView
// evaluateJavaScript(...) call, used by both BackgroundJSHost and
// ViewController's bridge callbacks.
//
// Always wraps the value in {"value": ...} before encoding, so the embedded
// expression is a single JS string literal regardless of whether `value` is a
// scalar, array, object, or nil. Corresponding JS side:
//   JSON.parse('<literal>').value
//
// This used to base64-encode and let the JS side call atob(). That silently
// corrupted every non-ASCII character: atob() returns one JS code unit per
// *byte*, so the UTF-8 bytes of "—", "£" or an emoji came back as the
// individual Latin-1 characters they encode to. "gently — spend £5 at café 🎯"
// arrived as "gently â€” spend Â£5 at cafÃ© ð�Ž¯". Coach replies are full of
// em dashes and curly quotes, so this hit almost every message on iOS.
//
// Emitting a properly escaped JS string literal avoids the round trip
// entirely, and matches how Android's bridge has always done it (JSONObject.quote
// in BackgroundJsHelper.kt). The JS decoders are unchanged -- they already
// JSON.parse a string argument; only what Swift hands them differs.
enum JSBridgeCodec {
    /// The JSON text for `{"value": <value>}`, or nil if it isn't serialisable.
    static func encode(_ value: Any?) -> String? {
        let wrapped: [String: Any] = ["value": value ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: wrapped, options: []) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// `text` as a quoted JS string literal, safe to interpolate into source.
    ///
    /// Built by serialising a single-element array and stripping the brackets:
    /// JSONSerialization cannot serialise a bare string fragment below
    /// macOS 10.15, and this project still deploys to 10.14.
    ///
    /// U+2028 and U+2029 are escaped afterwards. Both are legal unescaped
    /// inside a JSON string but were line terminators in JS before ES2019, so
    /// leaving them raw risks a syntax error in the evaluated source rather
    /// than a value that merely looks wrong.
    static func jsLiteral(_ text: String) -> String {
        guard
            let data = try? JSONSerialization.data(withJSONObject: [text], options: []),
            let array = String(data: data, encoding: .utf8),
            array.count >= 2
        else {
            return "\"\""
        }
        return String(array.dropFirst().dropLast())
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    /// Convenience: `value` wrapped, serialised, and quoted ready to embed.
    static func encodedLiteral(_ value: Any?) -> String? {
        guard let json = encode(value) else { return nil }
        return jsLiteral(json)
    }
}
