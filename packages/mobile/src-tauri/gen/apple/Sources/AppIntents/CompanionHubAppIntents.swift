//
//  CompanionHubAppIntents.swift
//  Companion Hub (mobile)
//
//  App Intents expose the app's core actions to Siri, the Shortcuts app,
//  Spotlight, and the Action Button. See:
//  https://developer.apple.com/documentation/appintents
//
//  The app itself is a Tauri webview — all of the real navigation logic lives
//  in the embedded React frontend. So rather than reimplement it in Swift, each
//  intent simply opens a `cihub://intent/<action>` deep link. The Rust shell
//  (`src/lib.rs`) captures that URL, stashes the action, and emits a
//  `deep-link-intent` event the frontend routes (see `lib/app-intents.ts`).
//  This reuses the exact deep-link pipeline that already powers the Portal SSO
//  (`cihub://auth`) and pairing (`cihub://pair`) flows — no new IPC surface.
//
//  Everything is gated on iOS 16 (App Intents' minimum). The app's deployment
//  target is iOS 16, so the guards are belt-and-suspenders / future-proofing.
//

import Foundation

#if canImport(AppIntents)
import AppIntents
#endif

#if canImport(UIKit)
import UIKit
#endif

// MARK: - Deep-link bridge

/// Builds and opens a `cihub://intent/<action>` URL. iOS routes the custom
/// scheme back into the app, where the Tauri deep-link plugin delivers it to
/// the Rust shell. Centralised so every intent shares one code path.
@available(iOS 16.0, *)
enum CompanionHubIntentBridge {
    @MainActor
    static func open(action: String, query: [String: String] = [:]) async {
        var components = URLComponents()
        components.scheme = "cihub"
        components.host = "intent"
        components.path = "/\(action)"
        if !query.isEmpty {
            components.queryItems = query
                .sorted { $0.key < $1.key }
                .map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { return }
        #if canImport(UIKit)
        await UIApplication.shared.open(url)
        #endif
    }
}

// MARK: - Intents

/// Open the currently connected Hub (the app's home screen).
@available(iOS 16.0, *)
struct OpenCompanionHubIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Companion Hub"
    static var description = IntentDescription("Open your connected Companion Hub.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await CompanionHubIntentBridge.open(action: "home")
        return .result()
    }
}

/// Start the connect flow — sign in to the cloud and pick a Hub.
@available(iOS 16.0, *)
struct ConnectHubIntent: AppIntent {
    static var title: LocalizedStringResource = "Connect a Hub"
    static var description = IntentDescription("Sign in and choose a Companion Hub to use on this device.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await CompanionHubIntentBridge.open(action: "connect")
        return .result()
    }
}

/// Disconnect from the current Hub and return to the picker.
@available(iOS 16.0, *)
struct SwitchHubIntent: AppIntent {
    static var title: LocalizedStringResource = "Switch Hub"
    static var description = IntentDescription("Disconnect from the current Hub and choose another one.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await CompanionHubIntentBridge.open(action: "switch")
        return .result()
    }
}

/// Jump straight to the Hub settings screen.
@available(iOS 16.0, *)
struct OpenHubSettingsIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Hub Settings"
    static var description = IntentDescription("Open the Companion Hub settings screen.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await CompanionHubIntentBridge.open(action: "settings")
        return .result()
    }
}

/// Open a specific Hub by name. The name is matched against the user's known
/// Hubs by the frontend (`lib/app-intents.ts`); an unknown name falls back to
/// the connect screen.
@available(iOS 16.0, *)
struct OpenNamedHubIntent: AppIntent {
    static var title: LocalizedStringResource = "Open a Specific Hub"
    static var description = IntentDescription("Open one of your Companion Hubs by name.")
    static var openAppWhenRun = true

    @Parameter(title: "Hub", description: "The name of the Hub to open.", requestValueDialog: "Which Hub?")
    var hubName: String

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$hubName) in Companion Hub")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let trimmed = hubName.trimmingCharacters(in: .whitespacesAndNewlines)
        await CompanionHubIntentBridge.open(action: "open", query: ["hub": trimmed])
        return .result()
    }
}

// MARK: - Shortcuts

/// Surfaces the intents to Siri, Spotlight, the Shortcuts app, and the Action
/// Button with ready-made phrases. Every phrase includes `\(.applicationName)`
/// as Apple requires.
@available(iOS 16.0, *)
struct CompanionHubShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenCompanionHubIntent(),
            phrases: [
                "Open \(.applicationName)",
                "Open my Hub in \(.applicationName)",
                "Show my Companion in \(.applicationName)",
            ],
            shortTitle: "Open Hub",
            systemImageName: "house"
        )
        AppShortcut(
            intent: ConnectHubIntent(),
            phrases: [
                "Connect a Hub in \(.applicationName)",
                "Add a Hub in \(.applicationName)",
            ],
            shortTitle: "Connect Hub",
            systemImageName: "link"
        )
        AppShortcut(
            intent: SwitchHubIntent(),
            phrases: [
                "Switch Hub in \(.applicationName)",
                "Change Hub in \(.applicationName)",
            ],
            shortTitle: "Switch Hub",
            systemImageName: "arrow.triangle.2.circlepath"
        )
        AppShortcut(
            intent: OpenHubSettingsIntent(),
            phrases: [
                "Open \(.applicationName) settings",
            ],
            shortTitle: "Hub Settings",
            systemImageName: "gearshape"
        )
        // NOTE: a parameterized phrase (`\(\.$hubName)`) requires the parameter
        // to be an AppEntity/AppEnum, not a free-form String. So this phrase
        // omits the parameter — Siri triggers the intent and then asks
        // "Which Hub?" (the parameter's requestValueDialog). The parameter still
        // appears in the Shortcuts editor via `parameterSummary`.
        AppShortcut(
            intent: OpenNamedHubIntent(),
            phrases: [
                "Open a Hub in \(.applicationName)",
                "Open a Companion Hub in \(.applicationName)",
            ],
            shortTitle: "Open a Hub",
            systemImageName: "rectangle.stack"
        )
    }
}
