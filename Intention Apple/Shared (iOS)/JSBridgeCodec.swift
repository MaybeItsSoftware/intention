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
// Always wraps the value in {"value": ...} before base64-encoding, so the
// embedded string is a single JS-side atob('...') expression regardless of
// whether `value` is a scalar, array, object, or nil — this sidesteps all
// quote/backslash-escaping pitfalls of interpolating arbitrary values
// directly into a JS source string. Corresponding JS side:
//   JSON.parse(atob('<b64>')).value
enum JSBridgeCodec {
    static func encode(_ value: Any?) -> String? {
        let wrapped: [String: Any] = ["value": value ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: wrapped, options: []) else { return nil }
        return data.base64EncodedString()
    }
}
