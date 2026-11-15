import Capacitor
import UIKit
import WebKit

/// The app's root view controller: Capacitor's bridge plus the local plugins
/// that live in this target (they are not npm packages, so Capacitor cannot
/// discover them on its own).
class MainViewController: CAPBridgeViewController {
    /// Under the web view, between where the page ends and the screen's edge.
    private let bottomStrip = UIView()
    /// The web view's bottom edge, kept above the screen's edge by `bottomLift`.
    private var webBottom: NSLayoutConstraint?

    /// How much of the bottom safe area the page keeps clear of: half of it.
    /// The whole of it (build 3, 34pt on a Face ID iPhone) lifted the tab bar
    /// and the composer too far (Omer, 2026-11-15); none of it (build 2) left
    /// them on the rounded corners.
    static let bottomLift: CGFloat = 0.5

    // ⚠ Build 4 also overrode the web view's `safeAreaInsets` (bottom 0) so
    //   the page's env() padding could not add to the lift. On the device the
    //   page then lost its top bar (Omer, 2026-11-15): WebKit lays out from
    //   the real insets too, and the two disagreed. Do not override them.

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NavigationPolicyPlugin())
        let content = webView?.configuration.userContentController
        content?.addUserScript(
            WKUserScript(source: Self.viewportScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        content?.addUserScript(
            WKUserScript(source: Self.bottomColorScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        content?.add(BottomColorHandler(owner: self), name: Self.bottomColorMessage)
    }

    /// ★ The web view stops above the bottom of the screen (Omer, 2026-11-15, TestFlight builds 2 and 3).
    ///
    /// Build 2 asked the page for `viewport-fit=cover` so its own
    /// `env(safe-area-inset-bottom)` padding would lift the tab bar and the
    /// composer, and on the device they still sat on the rounded corners and
    /// the home indicator. Rather than depend on what the page does, the app
    /// keeps the page out of part of that area (`bottomLift`), and a strip
    /// painted in the page's own bottom colour fills the rest. The top stays as
    /// it was (the page pads it).
    ///
    /// Capacitor's `loadView` is final and makes the web view the root view, so
    /// the swap into a container happens here, before the view is on screen.
    override open func viewDidLoad() {
        super.viewDidLoad()
        guard let web = webView else { return }

        let container = UIView(frame: web.frame)
        // The splash's colour until the page reports its own.
        container.backgroundColor = UIColor(red: 0x12 / 255, green: 0x12 / 255, blue: 0x12 / 255, alpha: 1)
        view = container

        bottomStrip.backgroundColor = container.backgroundColor
        bottomStrip.translatesAutoresizingMaskIntoConstraints = false
        web.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(bottomStrip)
        container.addSubview(web)

        let bottom = web.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        webBottom = bottom
        NSLayoutConstraint.activate([
            bottom,
            web.topAnchor.constraint(equalTo: container.topAnchor),
            web.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: container.trailingAnchor),

            bottomStrip.topAnchor.constraint(equalTo: web.bottomAnchor),
            bottomStrip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            bottomStrip.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            bottomStrip.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }

    override open func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        webBottom?.constant = -(view.safeAreaInsets.bottom * Self.bottomLift).rounded()
    }

    fileprivate func setBottomColor(_ css: String) {
        guard let color = Self.color(fromCSS: css) else { return }
        bottomStrip.backgroundColor = color
        view.backgroundColor = color
    }

    /// `rgb(r, g, b)` or `rgba(r, g, b, a)`, as `getComputedStyle` writes it.
    static func color(fromCSS css: String) -> UIColor? {
        guard let open = css.firstIndex(of: "("), let close = css.lastIndex(of: ")") else { return nil }
        let parts = css[css.index(after: open)..<close]
            .split(separator: ",")
            .map { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count >= 3, let r = parts[0], let g = parts[1], let b = parts[2] else { return nil }
        let a = parts.count >= 4 ? (parts[3] ?? 1) : 1
        guard a > 0 else { return nil }
        return UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: 1)
    }

    static let bottomColorMessage = "gotchaBottomColor"

    /// Reports the colour at the page's bottom edge (the tab bar's white, the
    /// conversation's paper), so the strip under the web view continues it.
    static let bottomColorScript = """
    (function () {
      var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(bottomColorMessage);
      if (!handler) return;
      var last = '';
      function opaque(c) {
        return c && c !== 'transparent' && !/rgba\\([^)]*,\\s*0\\)$/.test(c);
      }
      function report() {
        var el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1);
        var color = '';
        while (el) {
          var c = getComputedStyle(el).backgroundColor;
          if (opaque(c)) { color = c; break; }
          el = el.parentElement;
        }
        if (!color && document.body) color = getComputedStyle(document.body).backgroundColor;
        if (!opaque(color) || color === last) return;
        last = color;
        handler.postMessage(color);
      }
      report();
      setInterval(report, 500);
      window.addEventListener('resize', report);
    })();
    """

    /// ★ The iPhone's viewport, per page (Omer, 2026-11-14 and 2026-11-15).
    ///
    /// - The app's pages (*.gotcha.co.il): `viewport-fit=cover`, so the page's
    ///   `env(safe-area-inset-top)` is real. Pinch zoom stays (the photo viewer
    ///   relies on it).
    /// - The sign-in pages: iOS zooms in when a field under 16px is focused and
    ///   does not zoom back, so the page was left wider than the screen.
    ///   `maximum-scale=1` stops that zoom. On prod the sign-in is the app's
    ///   own page (app.gotcha.co.il/he/sign-in), not the auth host, which build
    ///   2 missed: it is matched by path too, and taken off again once the
    ///   person leaves those pages (the app's navigation does not reload).
    ///
    /// Re-applied when the head changes, because React may re-render the tag.
    static let viewportScript = """
    (function () {
      var host = location.hostname;
      var authHost = /^auth[.-]/.test(host);
      var appHost = !authHost && /(^|\\.)gotcha\\.co\\.il$/.test(host);
      if (!authHost && !appHost) return;
      var AUTH_PATH = /^\\/(?:(?:he|en)\\/)?(?:sign-in|recover|join|setup-link)(?:[\\/?#]|$)/;
      function apply() {
        var m = document.querySelector('meta[name="viewport"]');
        if (!m) {
          m = document.createElement('meta');
          m.setAttribute('name', 'viewport');
          m.setAttribute('content', 'width=device-width, initial-scale=1');
          (document.head || document.documentElement).appendChild(m);
        }
        var c = m.getAttribute('content') || '';
        var noZoom = authHost || AUTH_PATH.test(location.pathname);
        var parts = c.split(',').map(function (p) { return p.trim(); }).filter(function (p) {
          return p && p.indexOf('maximum-scale') !== 0;
        });
        if (appHost && !parts.some(function (p) { return p.indexOf('viewport-fit') === 0; })) {
          parts.push('viewport-fit=cover');
        }
        if (noZoom) parts.push('maximum-scale=1');
        var next = parts.join(', ');
        if (next !== c) m.setAttribute('content', next);
      }
      apply();
      if (document.head) {
        new MutationObserver(apply).observe(document.head, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['content']
        });
      }
      ['pushState', 'replaceState'].forEach(function (k) {
        var orig = history[k];
        history[k] = function () {
          var r = orig.apply(this, arguments);
          apply();
          return r;
        };
      });
      window.addEventListener('popstate', apply);
    })();
    """
}

/// The script message handler holds the controller weakly: the content
/// controller keeps its handlers alive, and a strong one would never let go.
private final class BottomColorHandler: NSObject, WKScriptMessageHandler {
    weak var owner: MainViewController?

    init(owner: MainViewController) {
        self.owner = owner
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let css = message.body as? String else { return }
        DispatchQueue.main.async { [weak owner] in owner?.setBottomColor(css) }
    }
}
