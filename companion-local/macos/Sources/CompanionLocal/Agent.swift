import Foundation

enum AgentState: Equatable {
    case stopped
    case connecting
    case connected
    case error(String)
}

/// Connects to Companion via an SSE stream (delegate-based, so chunks are
/// delivered incrementally — URLSession.bytes/.lines buffers and never
/// yields events in practice), executes tool calls locally, posts results
/// back. Auto-reconnects with backoff.
@MainActor
final class Agent {
    private(set) var state: AgentState = .stopped {
        didSet { if state != oldValue { onStateChange?(state) } }
    }
    private(set) var lastAction: String = "" {
        didSet { onStateChange?(state) }
    }
    var onStateChange: ((AgentState) -> Void)?

    private(set) var config: Config
    private var token: String
    private var conn: SSEConnection?
    private var stopped = true
    private var reconnectWork: DispatchWorkItem?
    private var backoff: TimeInterval = 2

    init(config: Config, token: String) {
        self.config = config
        self.token = token
    }

    func update(config: Config, token: String) {
        self.config = config
        self.token = token
    }

    func start() {
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        reconnectWork?.cancel()
        conn?.cancel()
        conn = nil
        state = .stopped
        lastAction = ""
    }

    private func connect() {
        guard !stopped else { return }
        state = .connecting

        guard var comps = URLComponents(string: config.url) else {
            state = .error("bad URL"); scheduleReconnect(); return
        }
        comps.path = "/api/local-agent/events"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url else {
            state = .error("bad URL"); scheduleReconnect(); return
        }

        let c = SSEConnection(url: url)
        conn = c
        c.onEvent = { [weak self] event, data in
            Task { @MainActor in await self?.handleEvent(event, data) }
        }
        c.onOpen = { [weak self] in
            Task { @MainActor in
                self?.state = .connected
                self?.backoff = 2
            }
        }
        c.onClose = { [weak self] errMsg in
            Task { @MainActor in
                guard let self, !self.stopped else { return }
                self.state = errMsg.map { .error($0) } ?? .connecting
                self.scheduleReconnect()
            }
        }
        c.start()
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        reconnectWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.stopped else { return }
            self.connect()
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff, execute: work)
        backoff = min(backoff * 1.5, 30)
    }

    // ── Event handling ──────────────────────────────────────────────────

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
            let eventCwd = (obj["cwd"] as? String)?.trimmingCharacters(in: .whitespaces)
            let cwd = (eventCwd?.isEmpty == false) ? eventCwd! : config.cwd
            lastAction = "\(tool)(\(shortArgs(args)))"
            let result = await ToolExecutor.run(tool: tool, args: args, cwd: cwd)
            await sendResult(requestId: requestId, result: result)
        default:
            break
        }
    }

    private func shortArgs(_ args: [String: Any]) -> String {
        if let c = args["command"] as? String { return String(c.prefix(40)) }
        if let p = args["path"] as? String { return String(p.prefix(40)) }
        if let p = args["prefix"] as? String { return String(p.prefix(40)) }
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
        _ = try? await URLSession.shared.data(for: req)
    }
}

// ── SSE connection (delegate-based incremental streaming) ───────────────────

final class SSEConnection: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    var onEvent: ((String, String) -> Void)?
    var onOpen: (() -> Void)?
    var onClose: ((String?) -> Void)?

    private let url: URL
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var buffer = Data()
    private var opened = false

    init(url: URL) { self.url = url }

    func start() {
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        req.timeoutInterval = .infinity
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = .infinity
        cfg.timeoutIntervalForResource = .infinity
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        session = s
        let t = s.dataTask(with: req)
        task = t
        t.resume()
    }

    func cancel() {
        task?.cancel()
        session?.invalidateAndCancel()
        onEvent = nil; onOpen = nil; onClose = nil
    }

    // Response headers received → stream is open.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
            opened = true
            onOpen?()
            completionHandler(.allow)
        } else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            onClose?("HTTP \(code)")
            completionHandler(.cancel)
        }
    }

    // Body chunks arrive here incrementally. Parse complete SSE events
    // (separated by a blank line) from the rolling buffer.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        // SSE events are delimited by "\n\n".
        while let range = buffer.range(of: Data("\n\n".utf8)) {
            let chunk = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            parseEvent(chunk)
        }
    }

    private func parseEvent(_ chunk: Data) {
        guard let text = String(data: chunk, encoding: .utf8) else { return }
        var event = "message"
        var dataLines: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
        }
        onEvent?(event, dataLines.joined(separator: "\n"))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let msg = error.map { "\($0.localizedDescription)" }
        onClose?(opened ? nil : (msg ?? "connection failed"))
    }
}
