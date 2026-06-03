import Foundation

enum AgentState: Equatable {
    case stopped
    case connecting
    case connected
    case error(String)
}

/// Connects to Companion via SSE, executes tool calls locally, returns
/// results. Runs an internal reconnect loop with exponential backoff.
@MainActor
final class Agent {
    private(set) var state: AgentState = .stopped {
        didSet { if state != oldValue { onStateChange?(state) } }
    }
    private(set) var lastAction: String = "" {
        didSet { onStateChange?(state) }
    }

    /// Called on the main actor whenever state or lastAction changes.
    var onStateChange: ((AgentState) -> Void)?

    private(set) var config: Config
    private var token: String
    private var runTask: Task<Void, Never>?
    private let session = URLSession(configuration: .default)

    init(config: Config, token: String) {
        self.config = config
        self.token = token
    }

    func update(config: Config, token: String) {
        self.config = config
        self.token = token
    }

    func start() {
        guard runTask == nil else { return }
        state = .connecting
        runTask = Task { await self.runLoop() }
    }

    func stop() {
        runTask?.cancel()
        runTask = nil
        state = .stopped
        lastAction = ""
    }

    // ── Connection loop ─────────────────────────────────────────────────

    private func runLoop() async {
        var delay: UInt64 = 2_000_000_000 // 2s in ns
        while !Task.isCancelled {
            do {
                try await connectOnce()
            } catch is CancellationError {
                break
            } catch {
                state = .error(error.localizedDescription)
            }
            if Task.isCancelled { break }
            state = .connecting
            try? await Task.sleep(nanoseconds: delay)
            delay = min(delay * 3 / 2, 30_000_000_000) // backoff, max 30s
        }
    }

    private func connectOnce() async throws {
        guard var comps = URLComponents(string: config.url) else {
            throw AgentError.badURL
        }
        comps.path = "/api/local-agent/events"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url else { throw AgentError.badURL }

        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = .infinity

        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw AgentError.noResponse
        }
        if http.statusCode != 200 {
            throw AgentError.http(http.statusCode)
        }

        state = .connected

        // Parse SSE: accumulate event + data lines, dispatch on blank line.
        var eventType = ""
        var dataBuf = ""
        for try await line in bytes.lines {
            if Task.isCancelled { throw CancellationError() }
            if line.hasPrefix("event:") {
                eventType = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataBuf = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            } else if line.isEmpty {
                await handleEvent(eventType, dataBuf)
                eventType = ""
                dataBuf = ""
            }
        }
        // Stream ended — treat as disconnect, loop reconnects.
        throw AgentError.disconnected
    }

    private func handleEvent(_ type: String, _ data: String) async {
        switch type {
        case "connected":
            state = .connected
        case "ping":
            break
        case "tool_execute":
            guard let json = data.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
                  let requestId = obj["requestId"] as? String,
                  let tool = obj["tool"] as? String else { return }
            let args = obj["args"] as? [String: Any] ?? [:]
            lastAction = "\(tool)(\(shortArgs(args)))"
            let result = await ToolExecutor.run(tool: tool, args: args, cwd: config.cwd)
            await sendResult(requestId: requestId, result: result)
        default:
            break
        }
    }

    private func shortArgs(_ args: [String: Any]) -> String {
        if let c = args["command"] as? String { return String(c.prefix(40)) }
        if let p = args["path"] as? String { return String(p.prefix(40)) }
        return ""
    }

    private func sendResult(requestId: String, result: [String: Any]) async {
        guard var comps = URLComponents(string: config.url) else { return }
        comps.path = "/api/local-agent/result"
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var payload = result
        payload["requestId"] = requestId
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        _ = try? await session.data(for: req)
    }
}

enum AgentError: LocalizedError {
    case badURL
    case noResponse
    case http(Int)
    case disconnected

    var errorDescription: String? {
        switch self {
        case .badURL: return "bad URL"
        case .noResponse: return "no response"
        case .http(let code): return "HTTP \(code)"
        case .disconnected: return "disconnected"
        }
    }
}
