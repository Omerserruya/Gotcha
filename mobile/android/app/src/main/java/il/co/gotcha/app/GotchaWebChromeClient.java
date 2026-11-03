package il.co.gotcha.app;

import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.List;

/**
 * The composer's image button opens the phone's GALLERY, not its files.
 *
 * The web composer has two inputs: one with accept="image/*" (the image
 * button) and one with no accept (the file button). Capacitor's chooser sends
 * both to the same document picker, so the image button opened "Files" - Omer,
 * 2026-11-03. Here an image-only, non-capture request goes to Android's Photo
 * Picker (the gallery, with no storage permission), and everything else -
 * the file button, a camera capture - stays Capacitor's.
 */
public class GotchaWebChromeClient extends BridgeWebChromeClient {

    /** Most images one pick may hand the composer (the Photo Picker's own cap applies too). */
    private static final int MAX_IMAGES = 10;

    private final ActivityResultLauncher<PickVisualMediaRequest> pickOne;
    private final ActivityResultLauncher<PickVisualMediaRequest> pickMany;
    private ValueCallback<Uri[]> pending;

    public GotchaWebChromeClient(Bridge bridge) {
        super(bridge);
        pickOne = bridge.registerForActivityResult(new ActivityResultContracts.PickVisualMedia(), (uri) ->
            deliver(uri == null ? null : new Uri[] { uri })
        );
        pickMany = bridge.registerForActivityResult(new ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGES), (uris) ->
            deliver(uris == null || uris.isEmpty() ? null : uris.toArray(new Uri[0]))
        );
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams params) {
        if (!imagesOnly(params) || params.isCaptureEnabled()) {
            return super.onShowFileChooser(webView, filePathCallback, params);
        }
        // ⚠ A WebView chooser must always be answered, or the input never opens again.
        deliver(null);
        pending = filePathCallback;
        PickVisualMediaRequest request = new PickVisualMediaRequest.Builder()
            .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE)
            .build();
        if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
            pickMany.launch(request);
        } else {
            pickOne.launch(request);
        }
        return true;
    }

    private void deliver(Uri[] uris) {
        ValueCallback<Uri[]> callback = pending;
        pending = null;
        if (callback != null) callback.onReceiveValue(uris);
    }

    /** Every accepted type is an image: "image/*", "image/png", ... */
    private static boolean imagesOnly(FileChooserParams params) {
        String[] accept = params.getAcceptTypes();
        if (accept == null || accept.length == 0) return false;
        boolean any = false;
        for (String raw : List.of(accept)) {
            for (String type : raw.split(",")) {
                String t = type.trim();
                if (t.isEmpty()) continue;
                if (!t.startsWith("image/")) return false;
                any = true;
            }
        }
        return any;
    }
}
