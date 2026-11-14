import Capacitor
import UIKit
import WebKit

/// The app's root view controller: Capacitor's bridge plus the local plugins
/// that live in this target (they are not npm packages, so Capacitor cannot
/// discover them on its own).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NavigationPolicyPlugin())
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: Self.viewportScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
    }

    /// ★ The iPhone's viewport, per host (Omer, 2026-11-14, first TestFlight build).
    ///
    /// - The app's pages (*.gotcha.co.il): the site's viewport has no
    ///   `viewport-fit=cover`, so on iOS `env(safe-area-inset-bottom)` is 0 and
    ///   the composer and the tab bar sat on the home indicator. The mobile CSS
    ///   already pads by `env(safe-area-inset-*)`; cover is what makes those
    ///   values real. Pinch zoom stays (the photo viewer relies on it).
    /// - The sign-in pages (auth.gotcha.co.il, Authentik): iOS zooms in when a
    ///   field under 16px is focused and does not zoom back, so the page was
    ///   left wider than the screen. `maximum-scale=1` stops that zoom there.
    ///
    /// Re-applied when the head changes, because React may re-render the tag.
    static let viewportScript = """
    (function () {
      var host = location.hostname;
      var isAuth = host.indexOf('auth.') === 0;
      var isApp = !isAuth && /(^|\\.)gotcha\\.co\\.il$/.test(host);
      if (!isAuth && !isApp) return;
      var want = isAuth ? ['maximum-scale=1'] : ['viewport-fit=cover'];
      function apply() {
        var m = document.querySelector('meta[name="viewport"]');
        if (!m) {
          m = document.createElement('meta');
          m.setAttribute('name', 'viewport');
          m.setAttribute('content', 'width=device-width, initial-scale=1');
          (document.head || document.documentElement).appendChild(m);
        }
        var c = m.getAttribute('content') || '';
        var next = c;
        want.forEach(function (w) {
          if (next.indexOf(w.split('=')[0]) === -1) next = next ? next + ', ' + w : w;
        });
        if (next !== c) m.setAttribute('content', next);
      }
      apply();
      if (document.head) {
        new MutationObserver(apply).observe(document.head, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['content']
        });
      }
    })();
    """
}
