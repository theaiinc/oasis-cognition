import Foundation
import Combine

/// Owns the active CU session state and polls the dev-agent for updates.
/// The dev-agent proxies `/cu-overlay/active-session` to the gateway, which
/// avoids any cross-origin / Electron-quirk concerns the HTML version had.
@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var session: CUSession?
    @Published private(set) var isStale: Bool = false   // true once we've seen many consecutive nulls
    @Published private(set) var lastUpdated: Date?

    private let devAgentURL: URL
    private let gatewayURL: URL
    private let initialSessionId: String?
    private var pollTask: Task<Void, Never>?
    private var nullCount: Int = 0
    private static let nullThreshold = 5

    init(devAgentPort: Int, gatewayPort: Int, initialSessionId: String?) {
        self.devAgentURL = URL(string: "http://localhost:\(devAgentPort)")!
        self.gatewayURL = URL(string: "http://localhost:\(gatewayPort)")!
        self.initialSessionId = initialSessionId
    }

    func start() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            await self?.pollLoop()
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            await pollOnce()
            // 700 ms — fast enough that quick Chrome Bridge transitions don't
            // get skipped (steps can complete in <1s), but slow enough not to
            // hammer the gateway. The Electron overlay used 1.5s and felt
            // visibly stale; users complained the indicator stayed on a
            // step the agent had already moved past.
            try? await Task.sleep(nanoseconds: 700_000_000)
        }
    }

    private func pollOnce() async {
        let url: URL = {
            if let id = initialSessionId, !id.isEmpty, session?.session_id == nil {
                // First fetch — try the specific session first
                return gatewayURL.appendingPathComponent("api/v1/computer-use/sessions/\(id)")
            }
            return devAgentURL.appendingPathComponent("cu-overlay/active-session")
        }()

        do {
            var req = URLRequest(url: url, timeoutInterval: 5)
            req.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                handleNoSession()
                return
            }
            let decoder = JSONDecoder()
            // Gateway returns CUSession directly when fetched by id; envelope when fetched as active.
            if let direct = try? decoder.decode(CUSession.self, from: data), !direct.session_id.isEmpty {
                session = direct
                nullCount = 0
                isStale = false
                lastUpdated = Date()
                return
            }
            if let env = try? decoder.decode(ActiveSessionEnvelope.self, from: data),
               let s = env.session {
                session = s
                nullCount = 0
                isStale = false
                lastUpdated = Date()
                return
            }
            handleNoSession()
        } catch {
            handleNoSession()
        }
    }

    private func handleNoSession() {
        nullCount += 1
        if nullCount > Self.nullThreshold {
            isStale = true
        }
    }

    // MARK: - Mutations

    enum Action: String { case pause, resume, cancel }

    func send(_ action: Action) async {
        guard let id = session?.session_id else { return }
        let path: String
        let method: String
        switch action {
        case .pause: path = "pause"; method = "POST"
        case .resume: path = "resume"; method = "POST"
        case .cancel: path = ""; method = "DELETE"
        }
        var url = gatewayURL.appendingPathComponent("api/v1/computer-use/sessions/\(id)")
        if !path.isEmpty { url.appendPathComponent(path) }
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.httpMethod = method
        do {
            _ = try await URLSession.shared.data(for: req)
            await pollOnce()
        } catch {
            // Best-effort — failures are surfaced through next poll.
        }
    }

    func sendFeedback(_ message: String) async {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let id = session?.session_id else { return }
        let url = gatewayURL.appendingPathComponent("api/v1/computer-use/sessions/\(id)/feedback")
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["message": trimmed]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: req)
        await pollOnce()
    }
}
