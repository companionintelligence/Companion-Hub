//
//  AuthSession.swift
//  Companion Hub (mobile)
//
//  In-app Safari authentication sheet. `SFSafariViewController` and system
//  Safari both leave the app (or swallow `cihub://`). ASWebAuthenticationSession
//  returns the callback URL while the app stays in the foreground — the same
//  sheet Companion Memory uses for Portal sign-in.
//

import AuthenticationServices
import UIKit

public typealias CihubAuthSessionCallback = @convention(c) (
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?
) -> Void

/// The app's window lives on `TaoSceneDelegate`, not `AppDelegate`. A missing
/// anchor is why an in-app sheet never appears under the UIScene lifecycle.
private final class AuthSessionAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first

        if let scene {
            if let key = scene.windows.first(where: \.isKeyWindow) {
                return key
            }
            if let any = scene.windows.first {
                return any
            }
        }

        return ASPresentationAnchor()
    }
}

/// Kept alive until the sheet finishes. UIKit drops an `ASWebAuthenticationSession`
/// that is only a local if `start()` returns before the user completes it.
private final class AuthSessionStore {
    static let shared = AuthSessionStore()
    var session: ASWebAuthenticationSession?
    let anchor = AuthSessionAnchor()
}

private func invokeCallback(
    _ callback: CihubAuthSessionCallback,
    url: String?,
    code: String?,
    message: String?
) {
    func withOptionalCString(_ value: String?, _ body: (UnsafePointer<CChar>?) -> Void) {
        if let value {
            value.withCString(body)
        } else {
            body(nil)
        }
    }

    withOptionalCString(url) { urlPtr in
        withOptionalCString(code) { codePtr in
            withOptionalCString(message) { messagePtr in
                callback(urlPtr, codePtr, messagePtr)
            }
        }
    }
}

/// Called from Rust `start_auth_session`. The callback is invoked once the
/// sheet finishes (success, cancel, or failure).
@_cdecl("cihub_start_auth_session")
public func cihub_start_auth_session(
    _ urlC: UnsafePointer<CChar>?,
    _ schemeC: UnsafePointer<CChar>?,
    _ callback: CihubAuthSessionCallback?
) {
    guard let urlC, let callback else {
        return
    }

    let urlString = String(cString: urlC)
    let schemeToUse: String = {
        guard let schemeC else { return "cihub" }
        let trimmed = String(cString: schemeC).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "cihub" : trimmed
    }()

    DispatchQueue.main.async {
        guard let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            invokeCallback(callback, url: nil, code: "FAILED", message: "A valid http(s) url is required")
            return
        }

        let store = AuthSessionStore.shared
        store.session?.cancel()

        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: schemeToUse) { callbackURL, error in
            store.session = nil

            if let callbackURL {
                invokeCallback(callback, url: callbackURL.absoluteString, code: nil, message: nil)
                return
            }

            if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                invokeCallback(callback, url: nil, code: "CANCELLED", message: "Sign-in cancelled")
                return
            }

            invokeCallback(
                callback,
                url: nil,
                code: "FAILED",
                message: error?.localizedDescription ?? "Sign-in failed"
            )
        }

        session.presentationContextProvider = store.anchor
        // A shared cookie jar signs the next attempt in as whoever was here last
        // and never shows the email field. Ephemeral drops those cookies when
        // the sheet closes, so the next Log in starts empty. Same as Memory.
        session.prefersEphemeralWebBrowserSession = true
        store.session = session

        if !session.start() {
            store.session = nil
            invokeCallback(callback, url: nil, code: "FAILED", message: "Could not present the sign-in sheet")
        }
    }
}
