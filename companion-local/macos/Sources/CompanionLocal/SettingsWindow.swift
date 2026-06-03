import AppKit

/// Simple config window: Companion URL, agents token, bash working dir.
/// Persists on Save and calls `onSave` so the app can reconnect.
final class SettingsWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let urlField = NSTextField()
    private let tokenField = NSSecureTextField()
    private let cwdField = NSTextField()
    private let onSave: (Config, String) -> Void

    init(onSave: @escaping (Config, String) -> Void) {
        self.onSave = onSave
    }

    func show() {
        if let w = window {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 280),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        w.title = "companion-local — Settings"
        w.delegate = self
        w.center()
        w.isReleasedWhenClosed = false

        let content = NSView(frame: w.contentView!.bounds)
        content.autoresizingMask = [.width, .height]

        let cfg = Config.load()

        func label(_ text: String, y: CGFloat) -> NSTextField {
            let l = NSTextField(labelWithString: text)
            l.frame = NSRect(x: 24, y: y, width: 412, height: 16)
            l.font = .systemFont(ofSize: 11, weight: .semibold)
            l.textColor = .secondaryLabelColor
            return l
        }
        func field(_ tf: NSTextField, y: CGFloat, value: String, placeholder: String) {
            tf.frame = NSRect(x: 24, y: y, width: 412, height: 24)
            tf.stringValue = value
            tf.placeholderString = placeholder
            tf.font = .systemFont(ofSize: 13)
            tf.bezelStyle = .roundedBezel
        }

        content.addSubview(label("Companion URL", y: 244))
        field(urlField, y: 218, value: cfg.url, placeholder: "https://nemo.thecomp.ai")
        content.addSubview(urlField)

        content.addSubview(label("Agents token (Settings → External agents → Create token)", y: 184))
        field(tokenField, y: 158, value: Config.loadToken() ?? "", placeholder: "hms_…")
        content.addSubview(tokenField)

        content.addSubview(label("Bash working directory", y: 124))
        field(cwdField, y: 98, value: cfg.cwd, placeholder: "/Users/you/projects")
        content.addSubview(cwdField)

        let saveBtn = NSButton(title: "Save & Connect", target: self, action: #selector(save))
        saveBtn.frame = NSRect(x: 296, y: 24, width: 140, height: 32)
        saveBtn.bezelStyle = .rounded
        saveBtn.keyEquivalent = "\r"
        content.addSubview(saveBtn)

        let cancelBtn = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelBtn.frame = NSRect(x: 200, y: 24, width: 88, height: 32)
        cancelBtn.bezelStyle = .rounded
        content.addSubview(cancelBtn)

        w.contentView = content
        window = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func save() {
        var cfg = Config.load()
        cfg.url = urlField.stringValue.trimmingCharacters(in: .whitespaces)
        cfg.cwd = cwdField.stringValue.trimmingCharacters(in: .whitespaces)
        cfg.save()
        let token = tokenField.stringValue.trimmingCharacters(in: .whitespaces)
        Config.saveToken(token)
        window?.close()
        onSave(cfg, token)
    }

    @objc private func cancel() {
        window?.close()
    }
}
