import AppKit

/// Frameless, always-on-top floating panel that hosts the SwiftUI overlay.
/// Mirrors the Electron settings: 320×480, top-right of the primary screen,
/// floating level, visible on all spaces, no taskbar entry.
final class OverlayPanel: NSPanel {
    init(initialSize: NSSize = NSSize(width: 320, height: 480)) {
        let screen = NSScreen.main ?? NSScreen.screens.first!
        let visible = screen.visibleFrame
        let origin = NSPoint(
            x: visible.maxX - initialSize.width - 20,
            y: visible.maxY - initialSize.height - 60
        )
        let frame = NSRect(origin: origin, size: initialSize)

        super.init(
            contentRect: frame,
            styleMask: [.borderless, .resizable, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        // Floating above normal windows, visible on every Space and full-screen apps.
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        hidesOnDeactivate = false
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true
        worksWhenModal = true

        // Visual chrome
        isMovableByWindowBackground = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        titleVisibility = .hidden
        titlebarAppearsTransparent = true

        // Don't appear in Dock or Cmd-Tab.
        if let app = NSApplication.shared as NSApplication? {
            app.setActivationPolicy(.accessory)
        }

        // Reasonable size constraints.
        minSize = NSSize(width: 280, height: 300)
        maxSize = NSSize(width: 600, height: 900)

        // Don't auto-close when the user clicks elsewhere.
        isReleasedWhenClosed = false
    }

    // Borderless panels don't accept key input by default — but we still want
    // typing in the steering text field to work.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
