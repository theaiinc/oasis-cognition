import AppKit
import SwiftUI

/// `LSUIElement = true` keeps the app out of the Dock / Cmd-Tab; we treat the
/// floating panel itself as the entire app surface, just like the Electron one.
@main
struct OasisCUOverlayApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: OverlayPanel?
    private var store: SessionStore?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Parse CLI args — keep flags compatible with the Electron launcher
        // (--session=cu-... --gateway=8000 --port=8008) so dev-agent can swap
        // launcher impls without changing its argv.
        var sessionId: String? = nil
        var gatewayPort: Int = 8000
        var devAgentPort: Int = 8008

        for arg in CommandLine.arguments.dropFirst() {
            if let v = Self.value(of: "--session", in: arg) { sessionId = v.isEmpty ? nil : v }
            if let v = Self.value(of: "--gateway", in: arg), let n = Int(v) { gatewayPort = n }
            if let v = Self.value(of: "--port", in: arg), let n = Int(v) { devAgentPort = n }
        }

        let store = SessionStore(devAgentPort: devAgentPort, gatewayPort: gatewayPort, initialSessionId: sessionId)
        self.store = store

        let panel = OverlayPanel()
        let view = OverlayView(store: store) { [weak self] in
            self?.closePanel()
        }
        panel.contentView = NSHostingView(rootView: view)
        panel.makeKeyAndOrderFront(nil)
        self.panel = panel

        store.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func closePanel() {
        store?.stop()
        panel?.orderOut(nil)
        NSApplication.shared.terminate(nil)
    }

    /// Parses --key=value style args. Returns nil if the arg's prefix doesn't
    /// match `key=`, otherwise returns the value (which may be empty).
    private static func value(of key: String, in arg: String) -> String? {
        let prefix = key + "="
        guard arg.hasPrefix(prefix) else { return nil }
        return String(arg.dropFirst(prefix.count))
    }
}
