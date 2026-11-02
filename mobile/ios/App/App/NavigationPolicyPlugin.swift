import Capacitor
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
    public let pluginMethods: [CAPPluginMethod] = []

    private var appOrigin: URL?
    private var authHosts: Set<String> = []
    private var inAppPathPrefixes: [String] = []
    private var locales: [String] = ["he", "en"]

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
}
