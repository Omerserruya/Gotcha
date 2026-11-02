package il.co.gotcha.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.text.TextUtils;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Decides, for every navigation the WebView is about to make, whether it stays
 * inside the shell or goes to the system browser.
 *
 * Capacitor already sends any host NOT in server.allowNavigation to the system
 * browser. This plugin adds the path rule for the app's own origin, which
 * Capacitor cannot express (allowNavigation is host-only):
 *
 *   app origin, /<locale>/m/...     stays in the WebView (the mobile screens)
 *   app origin, /api/auth/...       stays (sign-in, callback, sign-out)
 *   auth host(s), any path          stays (Authentik login runs in the WebView)
 *   app origin, any other path      system browser
 *   anything else                   left to Capacitor's default rule
 *
 * Config: plugins.NavigationPolicy in capacitor.config.js. Mirror of
 * ios/App/App/NavigationPolicyPlugin.swift; keep the two in step.
 *
 * Note: only real navigations reach this hook. A client-side route change
 * (history.pushState by the Next.js router) never does; see mobile/README.md.
 */
@CapacitorPlugin(name = "NavigationPolicy")
public class NavigationPolicyPlugin extends Plugin {

    private Uri appOrigin;
    private List<String> authHosts = Collections.emptyList();
    private List<String> inAppPathPrefixes = Collections.emptyList();
    private Pattern mobilePath;

    @Override
    public void load() {
        String origin = getConfig().getString("appOrigin");
        appOrigin = origin != null ? Uri.parse(origin) : null;
        authHosts = lower(getConfig().getArray("authHosts", new String[0]));
        inAppPathPrefixes = Arrays.asList(getConfig().getArray("inAppPathPrefixes", new String[0]));
        String[] locales = getConfig().getArray("locales", new String[] { "he", "en" });
        mobilePath = Pattern.compile("^/(" + TextUtils.join("|", quote(locales)) + ")/m(/.*)?$");
    }

    /**
     * @return true = cancel (we handled it), false = load in the WebView,
     *         null = no opinion, fall through to Capacitor's default rule.
     */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (appOrigin == null || url == null) return null;
        String scheme = url.getScheme();
        String host = url.getHost() != null ? url.getHost().toLowerCase(Locale.ROOT) : null;
        if (scheme == null || host == null) return null;

        if ("https".equals(scheme) && authHosts.contains(host)) return false;

        boolean sameOrigin =
            scheme.equals(appOrigin.getScheme()) &&
            host.equals(appOrigin.getHost()) &&
            url.getPort() == appOrigin.getPort();
        if (!sameOrigin) return null;

        if (isInApp(url.getPath())) return false;

        openInSystemBrowser(url);
        return true;
    }

    private boolean isInApp(String path) {
        if (path == null || path.isEmpty()) return false;
        if (mobilePath.matcher(path).matches()) return true;
        for (String prefix : inAppPathPrefixes) {
            if (path.startsWith(prefix)) return true;
        }
        return false;
    }

    private void openInSystemBrowser(Uri url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, url);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            getActivity().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Logger.warn("NavigationPolicy", "No browser to open " + url);
        }
    }

    private static List<String> lower(String[] values) {
        String[] out = new String[values.length];
        for (int i = 0; i < values.length; i++) out[i] = values[i].toLowerCase(Locale.ROOT);
        return Arrays.asList(out);
    }

    private static String[] quote(String[] values) {
        String[] out = new String[values.length];
        for (int i = 0; i < values.length; i++) out[i] = Pattern.quote(values[i]);
        return out;
    }
}
