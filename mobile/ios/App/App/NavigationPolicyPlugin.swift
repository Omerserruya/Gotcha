import Capacitor
import QuickLook
import UIKit
import WebKit

/// Decides, for every navigation the WebView is about to make, whether it stays
/// inside the shell or goes to the system browser.
///
/// Capacitor already sends any host NOT in `server.allowNavigation` to the system
/// browser. This plugin adds the path rule for the app's own origin, which
/// Capacitor cannot express (allowNavigation is host-only):
///
///     app origin, /<locale>/m/...     stays in the WebView (the mobile screens)
///     app origin, /api/auth/...       stays (sign-in, callback, sign-out)
///     auth host(s), any path          stays (Authentik login runs in the WebView)
///     app origin, any other path      system browser
///     anything else                   left to Capacitor's default rule
///
/// Config: `plugins.NavigationPolicy` in capacitor.config.js. Mirror of
/// android/app/src/main/java/il/co/gotcha/app/NavigationPolicyPlugin.java;
/// keep the two in step.
///
/// Only real navigations reach this hook. A client-side route change
/// (history.pushState by the Next.js router) never does; see mobile/README.md.
@objc(NavigationPolicyPlugin)
public class NavigationPolicyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NavigationPolicyPlugin"
    public let jsName = "NavigationPolicy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openDocument", returnType: CAPPluginReturnPromise)
    ]

    private var appOrigin: URL?
    private var authHosts: Set<String> = []
    private var inAppPathPrefixes: [String] = []
    private var locales: [String] = ["he", "en"]
    /// Quick Look holds its data source weakly: keep the open one alive here.
    private var preview: DocumentPreview?

    override public func load() {
        let config = getConfig()
        appOrigin = config.getString("appOrigin").flatMap { URL(string: $0) }
        authHosts = Set((config.getArray("authHosts") ?? []).compactMap { ($0 as? String)?.lowercased() })
        inAppPathPrefixes = (config.getArray("inAppPathPrefixes") ?? []).compactMap { $0 as? String }
        if let configured = config.getArray("locales")?.compactMap({ $0 as? String }), !configured.isEmpty {
            locales = configured
        }
    }

    /// true = cancel (we handled it), false = allow in the WebView,
    /// nil = no opinion, fall through to Capacitor's default rule.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let origin = appOrigin, let url = navigationAction.request.url,
              let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
            return nil
        }

        // Sub-frames (iframes) are not page navigations: leave them alone.
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? false
        guard isMainFrame else { return nil }

        if scheme == "https" && authHosts.contains(host) {
            return NSNumber(value: false)
        }

        let sameOrigin = scheme == origin.scheme?.lowercased()
            && host == origin.host?.lowercased()
            && url.port == origin.port
        guard sameOrigin else { return nil }

        if isInApp(path: url.path) {
            return NSNumber(value: false)
        }

        openInSystemBrowser(url)
        return NSNumber(value: true)
    }

    private func isInApp(path: String) -> Bool {
        let segments = path.split(separator: "/", omittingEmptySubsequences: true)
        if segments.count >= 2, locales.contains(String(segments[0])), segments[1] == "m" {
            return true
        }
        return inAppPathPrefixes.contains { path.hasPrefix($0) }
    }

    private func openInSystemBrowser(_ url: URL) {
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }

    /// A message's document (a PDF), shown in the phone's own viewer (Quick
    /// Look) inside the app, not the browser (Omer, 2026-11-04). Mirror of
    /// openDocument in NavigationPolicyPlugin.java; keep the two in step.
    ///
    /// The page passes a short-lived signed link on the app's own origin
    /// (/api/media/s/...). Only that is fetched: this is not a general
    /// downloader. Resolves { opened: true }, or rejects ("refused",
    /// "no_viewer", "failed") so the page falls back to the browser.
    @objc func openDocument(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), let origin = appOrigin,
              url.scheme?.lowercased() == "https",
              url.host?.lowercased() == origin.host?.lowercased(),
              url.path.hasPrefix("/api/media/s/") else {
            call.reject("refused")
            return
        }
        let name = Self.safeName(call.getString("fileName") ?? "document")
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        URLSession.shared.downloadTask(with: request) { [weak self] location, response, _ in
            guard let self = self, let location = location,
                  (response as? HTTPURLResponse)?.statusCode == 200 else {
                call.reject("failed")
                return
            }
            do {
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent("documents", isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let file = dir.appendingPathComponent(name)
                try? FileManager.default.removeItem(at: file)
                try FileManager.default.moveItem(at: location, to: file)
                DispatchQueue.main.async {
                    guard QLPreviewController.canPreview(file as NSURL),
                          let host = self.bridge?.viewController else {
                        call.reject("no_viewer")
                        return
                    }
                    let source = DocumentPreview(file: file) { [weak self] in self?.preview = nil }
                    self.preview = source
                    let controller = QLPreviewController()
                    controller.dataSource = source
                    controller.delegate = source
                    host.present(controller, animated: true)
                    call.resolve(["opened": true])
                }
            } catch {
                call.reject("failed")
            }
        }.resume()
    }

    /// Letters, digits, dot, dash, underscore; never a hidden or empty name.
    private static func safeName(_ raw: String) -> String {
        var out = ""
        var lastWasJoin = false
        for scalar in raw.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) || ".-_".unicodeScalars.contains(scalar) {
                out.unicodeScalars.append(scalar)
                lastWasJoin = false
            } else if !lastWasJoin {
                out.append("_")
                lastWasJoin = true
            }
        }
        if out.isEmpty || out.hasPrefix(".") { out = "document" + out }
        return out
    }
}

/// Quick Look's data source for one file; tells the plugin when it closes.
private final class DocumentPreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    private let file: URL
    private let onClose: () -> Void

    init(file: URL, onClose: @escaping () -> Void) {
        self.file = file
        self.onClose = onClose
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        file as NSURL
    }

    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        onClose()
    }
}
