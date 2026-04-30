import SwiftUI

/// SwiftUI root for the overlay panel. Mirrors the Electron HTML's layout:
///   header (status dot + title + close)  ──► warning banner (when executing)
///   goal (one line, ellipsized)
///   steps list (icon + description, autoscrolls to running step)
///   click-assist banner (when status == awaiting_click_assist)
///   steering input (disabled when no active session)
///   controls (EMERGENCY STOP / RESUME)
struct OverlayView: View {
    @ObservedObject var store: SessionStore
    let onClose: () -> Void

    @State private var steeringText: String = ""

    private var session: CUSession? { store.session }

    var body: some View {
        ZStack(alignment: .top) {
            // Solid translucent panel — transparent windows on macOS skip repaints
            // when unfocused, which we learned the hard way in the Electron version.
            VisualEffectBackground()
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )

            VStack(spacing: 0) {
                header
                if shouldShowWarning { warningBanner }
                goalRow
                stepList
                if session?.status == "awaiting_click_assist" { clickAssistBanner }
                steeringRow
                controlRow
            }
        }
        .padding(4)
        .frame(minWidth: 280, minHeight: 300)
        .preferredColorScheme(.dark)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 6) {
            StatusDot(status: session?.status, isStale: store.isStale)
            Text(headerTitle)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Color(white: 0.92))
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(Color(white: 0.55))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Close overlay")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(Color.clear)
        .overlay(Divider().opacity(0.4), alignment: .bottom)
    }

    private var headerTitle: String {
        if let s = session, !store.isStale { return s.displayStatus }
        if store.isStale { return "No Active Session" }
        return "Connecting…"
    }

    private var shouldShowWarning: Bool {
        session?.status == "executing" && !store.isStale
    }

    private var warningBanner: some View {
        Text("Agent is controlling the browser — avoid interacting")
            .font(.system(size: 10))
            .foregroundColor(Color.red.opacity(0.8))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Color.red.opacity(0.12))
    }

    // MARK: - Goal

    private var goalRow: some View {
        Text(session?.goal ?? "Waiting for a computer-use session…")
            .font(.system(size: 11))
            .foregroundColor(Color(white: 0.85))
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .help(session?.goal ?? "")
            .overlay(Divider().opacity(0.4), alignment: .bottom)
    }

    // MARK: - Steps

    private var stepList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    let visible = (session?.plan ?? []).filter { ($0.status ?? "") != "skipped" }
                    if visible.isEmpty {
                        Text("Waiting for steps…")
                            .font(.system(size: 11))
                            .foregroundColor(Color(white: 0.5))
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 30)
                    } else {
                        ForEach(Array(visible.enumerated()), id: \.offset) { idx, step in
                            StepRow(step: step)
                                .id(step.index ?? idx)
                        }
                    }
                    if let err = session?.error, session?.isTerminal == true {
                        Text(err)
                            .font(.system(size: 10))
                            .foregroundColor(.red)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if session?.status == "completed" {
                        Text("Goal achieved")
                            .font(.system(size: 11))
                            .foregroundColor(.green)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 8)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            // Note: macOS 13 syntax — onChange(of:perform:). The two-arg
            // closure variant is macOS 14+ only.
            .onChange(of: session?.current_step ?? -1) { newStep in
                guard newStep >= 0 else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(newStep, anchor: .center)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Click-assist banner

    private var clickAssistBanner: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Click failed — manual action needed")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.orange)
            Text(session?.error ?? "Please perform the click manually, then press Resume.")
                .font(.system(size: 10))
                .foregroundColor(Color(white: 0.6))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.orange.opacity(0.15))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.orange.opacity(0.4), lineWidth: 1)
        )
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    // MARK: - Steering input

    private var steeringRow: some View {
        HStack(spacing: 4) {
            TextField("Steer the agent…", text: $steeringText, onCommit: sendSteer)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(Color.white.opacity(0.05))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.white.opacity(0.12), lineWidth: 1)
                )
                .disabled(!isInteractive)
            Button("Send", action: sendSteer)
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color.purple.opacity(isInteractive ? 0.85 : 0.3))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .disabled(!isInteractive)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .overlay(Divider().opacity(0.4), alignment: .top)
    }

    private var isInteractive: Bool {
        guard let s = session, !store.isStale else { return false }
        return s.isActive
    }

    private func sendSteer() {
        let msg = steeringText
        guard !msg.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        steeringText = ""
        Task { await store.sendFeedback(msg) }
    }

    // MARK: - Controls

    private var controlRow: some View {
        HStack(spacing: 6) {
            Button(action: stopOrResume) {
                Text(showResume ? "RESUME" : "EMERGENCY STOP")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(showResume ? Color.green : Color.red)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .opacity(isInteractive ? 1 : 0.4)
            }
            .buttonStyle(.plain)
            .disabled(!isInteractive)

            Button(action: cancelSession) {
                Image(systemName: "stop.circle")
                    .font(.system(size: 14))
                    .foregroundColor(Color(white: 0.7))
                    .frame(width: 36, height: 36)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(Color.white.opacity(0.12), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
            .help("Cancel session")
            .disabled(session?.session_id == nil)
        }
        .padding(8)
        .overlay(Divider().opacity(0.4), alignment: .top)
    }

    private var showResume: Bool {
        guard let s = session else { return false }
        return s.isPaused
    }

    private func stopOrResume() {
        Task { await store.send(showResume ? .resume : .pause) }
    }

    private func cancelSession() {
        Task { await store.send(.cancel) }
    }
}

// MARK: - Helpers

private struct StatusDot: View {
    let status: String?
    let isStale: Bool

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .overlay(
                Circle()
                    .stroke(color.opacity(0.5), lineWidth: 1)
                    .scaleEffect(animating ? 1.6 : 1.0)
                    .opacity(animating ? 0 : 1)
                    .animation(animating
                               ? .easeOut(duration: 1.4).repeatForever(autoreverses: false)
                               : .default,
                               value: animating)
            )
    }

    private var color: Color {
        if isStale { return Color(white: 0.4) }
        switch status {
        case "executing", "planning": return .green
        case "paused", "awaiting_click_assist", "awaiting_approval", "awaiting_credential": return .orange
        case "failed", "cancelled": return .red
        default: return Color(white: 0.4)
        }
    }

    private var animating: Bool {
        status == "executing" || status == "planning"
    }
}

private struct StepRow: View {
    let step: CUStep

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            icon
                .frame(width: 14, height: 14)
                .padding(.top, 1)
            Text(step.description ?? step.action ?? "")
                .font(.system(size: 10))
                .foregroundColor(textColor)
                .lineLimit(2)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var background: some View {
        Group {
            if step.status == "running" {
                Color.blue.opacity(0.08)
            } else {
                Color.clear
            }
        }
    }

    private var textColor: Color {
        switch step.status {
        case "completed": return Color(white: 0.5)
        case "failed": return Color(white: 0.6)
        default: return Color(white: 0.85)
        }
    }

    @ViewBuilder
    private var icon: some View {
        switch step.status {
        case "completed":
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(.green)
        case "running":
            ProgressView()
                .controlSize(.mini)
                .scaleEffect(0.6)
        case "failed":
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(.red)
        case "skipped":
            Image(systemName: "minus")
                .font(.system(size: 10))
                .foregroundColor(Color(white: 0.4))
        default:
            Image(systemName: "circle")
                .font(.system(size: 9))
                .foregroundColor(Color(white: 0.45))
        }
    }
}

/// Wraps NSVisualEffectView so we get the system blur + dark material that
/// matches the Electron version's `backdrop-filter: blur(16px)` + dark bg.
private struct VisualEffectBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        v.appearance = NSAppearance(named: .vibrantDark)
        return v
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
