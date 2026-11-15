import Capacitor
import UIKit
import WebKit

/// The app's root view controller: Capacitor's bridge plus the local plugins
/// that live in this target (they are not npm packages, so Capacitor cannot
/// discover them on its own).
class MainViewController: CAPBridgeViewController {
    /// Over the web view, under the status bar and the Dynamic Island.
    private let topStrip = UIView()
    /// Under the web view, between where the page ends and the screen's edge.
    private let bottomStrip = UIView()
    private var webBottom: NSLayoutConstraint?

    /// How much of the bottom safe area the page keeps clear of: half of it.
    /// The whole of it (builds 3 and 4, 34pt on a Face ID iPhone) lifted the
    /// tab bar and the composer too far; none of it (build 2) left them on the
    /// rounded corners (Omer, 2026-11-15).
    static let bottomLift: CGFloat = 0.5

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NavigationPolicyPlugin())
        let content = webView?.configuration.userContentController
        content?.addUserScript(
            WKUserScript(source: Self.viewportScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        content?.addUserScript(
            WKUserScript(source: Self.edgeColorScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        content?.add(EdgeColorHandler(owner: self), name: Self.edgeColorMessage)
    }

    /// ★ The app, not the page, keeps clear of the iPhone's edges (Omer, 2026-11-15).
    ///
    /// The web view sits between the status bar and `bottomLift` of the bottom
    /// safe area; strips in the page's own edge colours fill the rest. The page
    /// is not asked for `viewport-fit=cover`, so its `env(safe-area-inset-*)`
    /// stays 0 and its own padding cannot add to the app's.
    ///
    /// History, so nobody repeats it:
    /// - Build 2 asked the page for cover and let it pad by env(): on the
    ///   device the bottom still sat on the rounded corners.
    /// - Builds 3 and 5 (simulator) let the web view reach into the safe area:
    ///   WebKit then hands the page the overlap as env(), and the page pads
    ///   it again (measured: envBottom=17px over a 17pt native lift).
    /// - Build 4 overrode the web view's `safeAreaInsets` to hide that: the
    ///   conversation lost its top bar. Do not override them.
    ///
    /// Capacitor's `loadView` is final and makes the web view the root view, so
    /// the swap into a container happens here, before the view is on screen.
    override open func viewDidLoad() {
        super.viewDidLoad()
        guard let web = webView else { return }

        let container = UIView(frame: web.frame)
        // The splash's colour until the page reports its own.
        let splash = UIColor(red: 0x12 / 255, green: 0x12 / 255, blue: 0x12 / 255, alpha: 1)
        container.backgroundColor = splash
        view = container

        for strip in [topStrip, bottomStrip] {
            strip.backgroundColor = splash
            strip.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(strip)
        }
        web.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(web)

        let bottom = web.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        webBottom = bottom
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            web.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            bottom,

            topStrip.topAnchor.constraint(equalTo: container.topAnchor),
            topStrip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            topStrip.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            topStrip.bottomAnchor.constraint(equalTo: web.topAnchor),

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

    /// `edge` is "top" or "bottom"; `css` is a computed background colour.
    fileprivate func setEdgeColor(edge: String, css: String) {
        guard let color = Self.color(fromCSS: css) else { return }
        if edge == "top" {
            topStrip.backgroundColor = color
        } else {
            bottomStrip.backgroundColor = color
            view.backgroundColor = color
        }
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

    static let edgeColorMessage = "gotchaEdgeColor"

    /// Reports the colours at the page's top and bottom edges (the header's
    /// paper, the tab bar's white), so the strips continue them.
    static let edgeColorScript = """
    (function () {
      var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(edgeColorMessage);
      if (!handler) return;
      var last = { top: '', bottom: '' };
      function opaque(c) {
        return c && c !== 'transparent' && !/rgba\\([^)]*,\\s*0\\)$/.test(c);
      }
      function colorAt(y) {
        var el = document.elementFromPoint(window.innerWidth / 2, y);
        while (el) {
          var c = getComputedStyle(el).backgroundColor;
          if (opaque(c)) return c;
          el = el.parentElement;
        }
        return document.body ? getComputedStyle(document.body).backgroundColor : '';
      }
      function report() {
        [['top', 1], ['bottom', window.innerHeight - 1]].forEach(function (e) {
          var c = colorAt(e[1]);
          if (!opaque(c) || c === last[e[0]]) return;
          last[e[0]] = c;
          handler.postMessage(e[0] + '|' + c);
        });
      }
      report();
      setInterval(report, 500);
      window.addEventListener('resize', report);
    })();
    """

    /// ★ The sign-in pages keep the screen's width (Omer, 2026-11-14 and 2026-11-15).
    ///
    /// iOS zooms in when a field under 16px is focused and does not zoom back,
    /// so the page was left wider than the screen. `maximum-scale=1` stops that
    /// zoom. On prod the sign-in is the app's own page
    /// (app.gotcha.co.il/he/sign-in), not the auth host, so it is matched by
    /// path too, and taken off again once the person leaves those pages (the
    /// app's navigation does not reload). Pinch zoom elsewhere stays (the photo
    /// viewer relies on it). No `viewport-fit=cover`: see `viewDidLoad`.
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
private final class EdgeColorHandler: NSObject, WKScriptMessageHandler {
    weak var owner: MainViewController?

    init(owner: MainViewController) {
        self.owner = owner
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String, let bar = body.firstIndex(of: "|") else { return }
        let edge = String(body[..<bar])
        let css = String(body[body.index(after: bar)...])
        DispatchQueue.main.async { [weak owner] in owner?.setEdgeColor(edge: edge, css: css) }
    }
}
