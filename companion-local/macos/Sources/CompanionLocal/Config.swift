import Foundation

/// Persistent configuration. URL, cwd, and token all live in UserDefaults
/// (see token note below for why not Keychain).
struct Config {
    var url: String
    var cwd: String

    private static let urlKey = "companion.url"
    private static let cwdKey = "companion.cwd"

    static func load() -> Config {
        let d = UserDefaults.standard
        let url = d.string(forKey: urlKey) ?? "https://nemo.thecomp.ai"
        // Default working dir: ~/companion, created at first run.
        let defaultCwd = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("companion").path
        let cwd = d.string(forKey: cwdKey) ?? defaultCwd
        try? FileManager.default.createDirectory(
            atPath: cwd, withIntermediateDirectories: true)
        return Config(url: url, cwd: cwd)
    }

    func save() {
        let d = UserDefaults.standard
        d.set(url, forKey: Config.urlKey)
        d.set(cwd, forKey: Config.cwdKey)
    }

    /// Whether enough config is present to attempt a connection.
    var isComplete: Bool {
        !url.isEmpty && !(Config.loadToken() ?? "").isEmpty
    }

    // ── Token (UserDefaults) ───────────────────────────────────────────
    //
    // Stored in UserDefaults rather than Keychain: the app is ad-hoc signed
    // and re-signed on every rebuild, which changes the code identity and
    // breaks Keychain ACLs — the user would have to re-enter the token after
    // every update. This is a self-hosted tool running on the user's own
    // machine against their own LAN; the token in the app's prefs has the
    // same threat model as the Node daemon's --token flag.
    private static let tokenKey = "companion.token"

    static func loadToken() -> String? {
        let t = UserDefaults.standard.string(forKey: tokenKey)
        return (t?.isEmpty == false) ? t : nil
    }

    static func saveToken(_ token: String) {
        UserDefaults.standard.set(token, forKey: tokenKey)
    }
}
