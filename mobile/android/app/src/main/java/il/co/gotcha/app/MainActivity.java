package il.co.gotcha.app;

import android.os.Bundle;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered BEFORE super.onCreate() builds the bridge.
        registerPlugin(NavigationPolicyPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /*
     * Session persistence. The GOTCHA session is a cookie with an explicit expiry.
     * android.webkit.CookieManager keeps cookies in memory and writes them to disk
     * on its own schedule; Capacitor's bridge never calls flush() (it does only when
     * CapacitorCookies is enabled, which this app keeps off). Without a flush, a
     * login followed by a swipe-kill within that window loses the session. Flush
     * whenever the app leaves the foreground.
     */
    @Override
    public void onPause() {
        super.onPause();
        flushCookies();
    }

    @Override
    public void onStop() {
        super.onStop();
        flushCookies();
    }

    private static void flushCookies() {
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {
            // No WebView provider (e.g. being updated): nothing to flush.
        }
    }
}
