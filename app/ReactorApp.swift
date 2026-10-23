// Reactor — a tiny AppKit shell around the local fan-control panel.
//
// One window, one WKWebView pointed at http://127.0.0.1:7979/. If the daemon
// is not running, a native view explains what to do instead of a blank page.

import Cocoa
import WebKit

let appURL = URL(string: "http://127.0.0.1:7979/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var errorView: NSView!

    // MARK: - lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        loadPage()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    // MARK: - window

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 910)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Reactor"
        window.minSize = NSSize(width: 900, height: 640)
        window.appearance = NSAppearance(named: .darkAqua)
        // The page runs up under a see-through title bar, so the bar shows the page's own wall colour.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(srgbRed: 0x8c/255, green: 0x8b/255, blue: 0x82/255, alpha: 1.0)
        window.isReleasedWhenClosed = false
        window.center()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // Tells the page it sits under the title bar, so it leaves room for the window buttons.
        config.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('app-window')",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = WKWebView(frame: window.contentView?.bounds ?? frame,
                            configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView?.addSubview(webView)

        buildErrorView(in: window.contentView!)

        // The web view would swallow clicks in the title bar area; this strip keeps the window draggable.
        let bounds = window.contentView!.bounds
        let strip = DragStrip(frame: NSRect(x: 0, y: bounds.height - 28, width: bounds.width, height: 28))
        strip.autoresizingMask = [.width, .minYMargin]
        window.contentView?.addSubview(strip)

        window.makeKeyAndOrderFront(nil)
    }

    private func buildErrorView(in parent: NSView) {
        errorView = NSView(frame: parent.bounds)
        errorView.autoresizingMask = [.width, .height]
        errorView.wantsLayer = true
        errorView.layer?.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 1.0).cgColor
        errorView.isHidden = true

        let title = NSTextField(labelWithString: "The fan controller isn't running.")
        title.font = NSFont.systemFont(ofSize: 20, weight: .medium)
        title.textColor = NSColor(calibratedWhite: 0.95, alpha: 1.0)
        title.alignment = .center

        let subtitle = NSTextField(labelWithString: "Run install.sh to start it.")
        subtitle.font = NSFont.systemFont(ofSize: 14)
        subtitle.textColor = NSColor(calibratedWhite: 0.68, alpha: 1.0)
        subtitle.alignment = .center

        let retry = NSButton(title: "Retry", target: self, action: #selector(retryTapped(_:)))
        retry.bezelStyle = .rounded
        retry.keyEquivalent = "\r"
        retry.controlSize = .large

        let stack = NSStackView(views: [title, subtitle, retry])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(18, after: subtitle)
        stack.translatesAutoresizingMaskIntoConstraints = false
        errorView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: errorView.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: errorView.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: errorView.widthAnchor,
                                        constant: -80),
        ])

        parent.addSubview(errorView)
    }

    // MARK: - loading

    private func loadPage() {
        showError(false)
        window.title = "Reactor"
        webView.load(URLRequest(url: appURL))
    }

    @objc private func retryTapped(_ sender: Any?) {
        loadPage()
    }

    @objc private func reloadPage(_ sender: Any?) {
        if errorView.isHidden {
            webView.reload()
        } else {
            loadPage()
        }
    }

    private func showError(_ visible: Bool) {
        errorView.isHidden = !visible
        if visible {
            window.title = "Reactor — not running"
        } else {
            window.title = "Reactor"
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        showError(false)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!,
                 withError error: Error) {
        showError(true)
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        // Connection refused lands here: the daemon is not up yet.
        showError(true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - menu

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Reactor",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Reactor",
                        action: #selector(NSApplication.hide(_:)),
                        keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Reactor",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appItem.submenu = appMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        let reload = NSMenuItem(title: "Reload", action: #selector(reloadPage(_:)),
                                keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)
        viewMenu.addItem(withTitle: "Close Window",
                         action: #selector(NSWindow.performClose(_:)),
                         keyEquivalent: "w")
        viewItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }
}

final class DragStrip: NSView {
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.performZoom(nil)
        } else {
            window?.performDrag(with: event)
        }
    }
}

@main
struct ReactorMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
