import Foundation

/// Mirrors the gateway's CU session JSON shape — only the fields we render.
/// The gateway returns sessions whose `plan` array entries have these fields
/// (and many more we ignore here).
struct CUSession: Codable {
    let session_id: String
    let status: String
    let goal: String?
    let current_step: Int?
    let error: String?
    let plan: [CUStep]?
}

struct CUStep: Codable {
    let index: Int?
    let status: String?
    let action: String?
    let description: String?
}

/// Wrapper shape returned by `/cu-overlay/active-session` (dev-agent proxy).
struct ActiveSessionEnvelope: Codable {
    let session: CUSession?
}

extension CUSession {
    var displayStatus: String {
        switch status {
        case "executing": return "CU Active"
        case "paused": return "Paused"
        case "planning": return "Planning…"
        case "awaiting_approval": return "Awaiting Approval"
        case "awaiting_click_assist": return "Click Assist Needed"
        case "awaiting_credential": return "Credential Needed"
        case "completed": return "Completed"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        default: return status
        }
    }

    var isActive: Bool {
        ["executing", "paused", "planning", "awaiting_click_assist", "awaiting_approval", "awaiting_credential"].contains(status)
    }

    var isTerminal: Bool {
        ["completed", "failed", "cancelled"].contains(status)
    }

    var isPaused: Bool {
        status == "paused" || status == "awaiting_click_assist"
    }
}
