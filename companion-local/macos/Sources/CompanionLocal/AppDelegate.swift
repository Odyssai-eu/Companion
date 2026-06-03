import AppKit
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var agent: Agent!
    private var settings: SettingsWindow!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        let cfg = Config.load()
        let token = Config.loadToken() ?? ""
        agent = Agent(config: cfg, token: token)
        agent.onStateChange = { [weak self] _ in self?.refresh() }

        settings = SettingsWindow { [weak self] cfg, token in
            self?.agent.update(config: cfg, token: token)
            self?.agent.stop()
            self?.agent.start()
        }

        refresh()

        // Auto-start if configured, else open settings on first launch.
        if cfg.isComplete {
            agent.start()
        } else {
            settings.show()
        }
    }

    // ── Menu bar ────────────────────────────────────────────────────────

    private func icon(for state: AgentState) -> String {
        switch state {
        case .connected:  return "●"
        case .connecting: return "◌"
        case .stopped:    return "○"
        case .error:      return "⚠"
        }
    }

    private func statusLine(_ state: AgentState) -> String {
        let host = URL(string: agent.config.url)?.host ?? agent.config.url
        switch state {
        case .connected:  return "● Connected · \(host)"
        case .connecting: return "◌ Connecting…"
        case .stopped:    return "○ Stopped"
        case .error(let e): return "⚠ \(e)"
        }
    }

    private func refresh() {
        let state = agent.state
        statusItem.button?.title = icon(for: state)

        let menu = NSMenu()

        let status = NSMenuItem(title: statusLine(state), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)

        if !agent.lastAction.isEmpty {
            let la = NSMenuItem(title: "   ↳ \(agent.lastAction)", action: nil, keyEquivalent: "")
            la.isEnabled = false
            menu.addItem(la)
        }

        menu.addItem(.separator())

        let cwd = NSMenuItem(title: "   \(agent.config.cwd)", action: nil, keyEquivalent: "")
        cwd.isEnabled = false
        menu.addItem(cwd)

        menu.addItem(.separator())

        switch state {
        case .stopped, .error:
            menu.addItem(NSMenuItem(title: "Start", action: #selector(start), keyEquivalent: "s"))
        default:
            menu.addItem(NSMenuItem(title: "Stop", action: #selector(stop), keyEquivalent: "s"))
        }
        menu.addItem(NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ","))

        menu.addItem(.separator())

        let launchItem = NSMenuItem(
            title: "Launch at Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        launchItem.state = launchAtLoginEnabled ? .on : .off
        menu.addItem(launchItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))

        // Target all action items at self (skip the Launch-at-Login auto-target).
        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu
    }


    // ── Actions ─────────────────────────────────────────────────────────

    @objc private func start()  { agent.start() }
    @objc private func stop()   { agent.stop() }
    @objc private func openSettings() { settings.show() }
    @objc private func quit()   { agent.stop(); NSApp.terminate(nil) }

    // ── Launch at Login (SMAppService, macOS 13+) ───────────────────────

    private var launchAtLoginEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    @objc private func toggleLaunchAtLogin() {
        do {
            if launchAtLoginEnabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSLog("Launch at login toggle failed: \(error)")
        }
        refresh()
    }
}
