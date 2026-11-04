package il.co.gotcha.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.text.TextUtils;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
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

    /**
     * A message's document (a PDF), opened in the phone's own viewer, not the
     * browser: the browser only downloaded it (Omer, 2026-11-04).
     *
     * The page passes a short-lived signed link on the app's own origin (the
     * conversation service's /api/media/s/...). It is fetched here into the
     * app's cache and handed to whichever app views that type, by a
     * FileProvider content URI with a one-off read grant. Only the app's own
     * origin is fetched: this is not a general downloader.
     *
     * Resolves { opened: true }, or rejects ("no_viewer", "failed") so the page
     * can fall back to the browser.
     */
    @PluginMethod
    public void openDocument(PluginCall call) {
        String raw = call.getString("url");
        String name = call.getString("fileName", "document");
        Uri url = raw == null ? null : Uri.parse(raw);
        if (url == null || appOrigin == null || !"https".equals(url.getScheme()) ||
            url.getHost() == null || !url.getHost().equalsIgnoreCase(appOrigin.getHost()) ||
            url.getPath() == null || !url.getPath().startsWith("/api/media/s/")) {
            call.reject("refused");
            return;
        }
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url.toString()).openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000);
                if (connection.getResponseCode() != 200) throw new IllegalStateException("status " + connection.getResponseCode());
                String type = connection.getContentType();
                if (type != null && type.contains(";")) type = type.substring(0, type.indexOf(';')).trim();
                String safe = name.replaceAll("[^\\p{L}\\p{N}._-]+", "_");
                if (safe.isEmpty() || safe.startsWith(".")) safe = "document" + safe;
                if (type == null || type.isEmpty() || "application/octet-stream".equals(type)) {
                    String ext = MimeTypeMap.getFileExtensionFromUrl(safe);
                    String guess = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase(Locale.ROOT));
                    type = guess != null ? guess : "application/octet-stream";
                }
                File dir = new File(getContext().getCacheDir(), "documents");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cache");
                File file = new File(dir, safe);
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                    byte[] buffer = new byte[16384];
                    int n;
                    while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                }
                Uri content = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(content, type);
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getActivity().startActivity(view);
                    JSObject result = new JSObject();
                    result.put("opened", true);
                    call.resolve(result);
                } catch (ActivityNotFoundException e) {
                    call.reject("no_viewer");
                }
            } catch (Exception e) {
                Logger.warn("NavigationPolicy", "openDocument failed: " + e.getMessage());
                call.reject("failed");
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
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
