import Foundation

/// Executes a tool call locally and returns an OpenAI-style result dict
/// `{ok: Bool, data?: Any, error?: String}`.
enum ToolExecutor {
    static let bashTimeout: TimeInterval = 30

    static func run(tool: String, args: [String: Any], cwd rawCwd: String) async -> [String: Any] {
        // Expand ~ so a project working_dir like "~/projects/foo" resolves.
        let cwd = (rawCwd as NSString).expandingTildeInPath
        try? FileManager.default.createDirectory(
            atPath: cwd, withIntermediateDirectories: true)
        switch tool {
        case "bash":      return runBash(args, cwd: cwd)
        case "fs_read":   return runRead(args, cwd: cwd)
        case "fs_write":  return runWrite(args, cwd: cwd)
        case "fs_list":   return runList(args, cwd: cwd)
        default:          return ["ok": false, "error": "unknown tool: \(tool)"]
        }
    }

    // ── bash ────────────────────────────────────────────────────────────

    private static func runBash(_ args: [String: Any], cwd: String) -> [String: Any] {
        guard let command = (args["command"] as? String)?.trimmingCharacters(in: .whitespaces),
              !command.isEmpty else {
            return ["ok": false, "error": "missing 'command'"]
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["-c", command]
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        do {
            try proc.run()
        } catch {
            return ["ok": false, "error": "spawn failed: \(error.localizedDescription)"]
        }

        // Manual timeout: terminate the process if it overruns.
        let timeoutItem = DispatchWorkItem {
            if proc.isRunning { proc.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + bashTimeout, execute: timeoutItem)

        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        timeoutItem.cancel()

        let stdout = String(data: outData, encoding: .utf8) ?? ""
        let stderr = String(data: errData, encoding: .utf8) ?? ""

        if proc.terminationStatus != 0 && stdout.isEmpty {
            return ["ok": false, "error": stderr.isEmpty
                ? "exit code \(proc.terminationStatus)"
                : String(stderr.prefix(500))]
        }
        return ["ok": true, "data": [
            "stdout": String(stdout.prefix(16000)),
            "stderr": String(stderr.prefix(4000)),
            "command": command,
            "exit_code": Int(proc.terminationStatus),
        ]]
    }

    // ── fs_read ─────────────────────────────────────────────────────────

    private static func runRead(_ args: [String: Any], cwd: String) -> [String: Any] {
        guard let raw = args["path"] as? String, !raw.isEmpty else {
            return ["ok": false, "error": "missing 'path'"]
        }
        let path = resolve(raw, cwd: cwd)
        do {
            let content = try String(contentsOfFile: path, encoding: .utf8)
            return ["ok": true, "data": [
                "path": path,
                "content": content,
                "sizeBytes": content.utf8.count,
            ]]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    // ── fs_write ────────────────────────────────────────────────────────

    private static func runWrite(_ args: [String: Any], cwd: String) -> [String: Any] {
        guard let raw = args["path"] as? String, !raw.isEmpty else {
            return ["ok": false, "error": "missing 'path'"]
        }
        let content = args["content"] as? String ?? ""
        let path = resolve(raw, cwd: cwd)
        let dir = (path as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            try content.write(toFile: path, atomically: true, encoding: .utf8)
            return ["ok": true, "data": ["path": path, "sizeBytes": content.utf8.count]]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    // ── fs_list ─────────────────────────────────────────────────────────

    private static func runList(_ args: [String: Any], cwd: String) -> [String: Any] {
        let prefix = (args["prefix"] as? String) ?? "."
        let dir = resolve(prefix, cwd: cwd)
        let fm = FileManager.default
        do {
            // URL API with resource keys: directory-ness + size come back in
            // the enumeration itself, avoiding a per-entry stat() that would
            // trip macOS TCC on protected subfolders and hang the call.
            let dirURL = URL(fileURLWithPath: dir)
            let urls = try fm.contentsOfDirectory(
                at: dirURL,
                includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
                options: [])
            var files: [[String: Any]] = []
            for u in urls.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                let vals = try? u.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
                files.append([
                    "name": u.lastPathComponent,
                    "path": u.path,
                    "sizeBytes": vals?.fileSize ?? 0,
                    "isDir": vals?.isDirectory ?? false,
                ])
            }
            // Shape matches the Node daemon + folder-picker UI: {dir, files}.
            return ["ok": true, "data": ["dir": dir, "files": files]]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private static func resolve(_ path: String, cwd: String) -> String {
        if path.hasPrefix("/") { return path }
        if path.hasPrefix("~") {
            return (path as NSString).expandingTildeInPath
        }
        return (cwd as NSString).appendingPathComponent(path)
    }
}
