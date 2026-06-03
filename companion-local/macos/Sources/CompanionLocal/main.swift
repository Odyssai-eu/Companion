import AppKit

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // .accessory = menubar-only, no Dock icon, no main menu bar.
    app.setActivationPolicy(.accessory)
    // Keep a strong reference to the delegate for the app's lifetime.
    objc_setAssociatedObject(app, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
    app.run()
}
