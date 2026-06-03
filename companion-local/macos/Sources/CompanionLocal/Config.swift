import Foundation
import Security

/// Persistent configuration. URL + cwd live in UserDefaults; the token is
/// stored in the macOS Keychain (it's a secret — UserDefaults is a plaintext
/// plist any process running as the user could read).
struct Config {
    var url: String
    var cwd: String

    private static let urlKey = "companion.url"
    private static let cwdKey = "companion.cwd"
    private static let keychainService = "eu.odyssai.companion-local"
    private static let keychainAccount = "agents-token"

    static func load() -> Config {
        let d = UserDefaults.standard
        let url = d.string(forKey: urlKey) ?? "https://nemo.thecomp.ai"
        let cwd = d.string(forKey: cwdKey)
            ?? FileManager.default.homeDirectoryForCurrentUser.path
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

    // ── Token (Keychain) ────────────────────────────────────────────────

    static func loadToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return nil
        }
        return token
    }

    static func saveToken(_ token: String) {
        // Delete any existing, then add fresh.
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(base as CFDictionary)
        guard !token.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = token.data(using: .utf8)!
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
