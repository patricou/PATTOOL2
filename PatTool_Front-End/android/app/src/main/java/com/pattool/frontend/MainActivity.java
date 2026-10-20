package com.pattool.frontend;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import java.util.Locale;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * After Keycloak login, Android follows the redirect to the in-app host
 * (https://pattool.local) as a real network request and fails with
 * ERR_NAME_NOT_RESOLVED. A fresh {@code loadUrl} is served from the files
 * stored in the app.
 */
public class MainActivity extends BridgeActivity {

    private static final String APP_HOST = "pattool.local";

    /** Last URL reloaded locally, so a failed retry does not loop. */
    private String lastLocalReload;

    /** Tells the radio page when the phone network drops or returns, even if the screen is off. */
    private ConnectivityManager.NetworkCallback radioNetworkCallback;

    /** True while radio or YouTube is playing. Set from the page, read on screen off. */
    private volatile boolean radioKeepAlive;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        hideNavigationBar();
        installAuthReturnHandler();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideNavigationBar();
            return;
        }
        if (radioKeepAlive && !isScreenInteractive()) {
            resumeWebViewForRadio();
            notifyRadioScreen(true);
        }
    }

    /**
     * Hides the Android 3-button / gesture bar for the whole app, not only while a map
     * is fullscreen. A swipe from the bottom edge shows it again briefly so Home and Back
     * stay reachable. The status bar stays visible.
     * Some Android 15+ devices ignore {@code InsetsController.hide()} for 3-button
     * navigation; the legacy immersive flags are applied as well.
     */
    @SuppressWarnings("deprecation")
    private void hideNavigationBar() {
        Window window = getWindow();
        if (window == null) {
            return;
        }
        View decor = window.getDecorView();
        applyNavigationBarHidden(window, decor);
        decor.post(() -> {
            if (!isFinishing() && !isDestroyed()) {
                applyNavigationBarHidden(window, decor);
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void applyNavigationBarHidden(Window window, View decor) {
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
        }
        window.setNavigationBarColor(Color.TRANSPARENT);

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.show(WindowInsetsCompat.Type.statusBars());
        controller.hide(WindowInsetsCompat.Type.navigationBars());

        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
    }

    private void installAuthReturnHandler() {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        WebView webView = bridge.getWebView();
        webView.addJavascriptInterface(new RadioNativeBridge(this), "PatRadioNative");
        webView.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request == null ? null : request.getUrl();
                if (isApkDownload(url)) {
                    Intent intent = new Intent(Intent.ACTION_VIEW, url);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                    return true;
                }
                if (isAppHost(request)) {
                    reloadFromAppFiles(view, request.getUrl().toString());
                    return true;
                }
                return super.shouldOverrideUrlLoading(view, request);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (isAppHost(request)) {
                    reloadFromAppFiles(view, request.getUrl().toString());
                    return;
                }
                super.onReceivedError(view, request, error);
            }
        });
    }

    private boolean isApkDownload(Uri url) {
        if (url == null) {
            return false;
        }
        String path = url.getPath();
        return path != null && path.toLowerCase(Locale.ROOT).endsWith(".apk");
    }

    private boolean isAppHost(WebResourceRequest request) {
        if (request == null || !request.isForMainFrame()) {
            return false;
        }
        Uri url = request.getUrl();
        return url != null && APP_HOST.equalsIgnoreCase(url.getHost());
    }

    private void reloadFromAppFiles(WebView view, String url) {
        if (url == null || url.isEmpty() || url.equals(lastLocalReload)) {
            return;
        }
        lastLocalReload = url;
        view.post(() -> view.loadUrl(url));
    }

    @Override
    public void onStart() {
        super.onStart();
        registerRadioNetworkCallback();
    }

    /**
     * Screen off pauses the WebView on some phones. If radio or YouTube is playing,
     * keep the page timers running and tell the page to resume the stream.
     */
    @Override
    public void onPause() {
        boolean screenOff = !isScreenInteractive();
        boolean keepAudio = radioKeepAlive || isMusicActive();
        super.onPause();
        if (screenOff && keepAudio) {
            resumeWebViewForRadio();
        }
        if (screenOff && radioKeepAlive) {
            notifyRadioScreen(true);
        }
    }

    @Override
    public void onStop() {
        boolean screenOff = !isScreenInteractive();
        boolean keepAudio = radioKeepAlive || isMusicActive();
        super.onStop();
        if (screenOff && keepAudio) {
            resumeWebViewForRadio();
        }
        if (screenOff && radioKeepAlive) {
            notifyRadioScreen(true);
        }
    }

    @Override
    public void onResume() {
        notifyRadioScreen(false);
        super.onResume();
        hideNavigationBar();
    }

    @Override
    public void onDestroy() {
        radioKeepAlive = false;
        Intent stopRadio = new Intent(this, RadioKeepAliveService.class);
        stopRadio.setAction(RadioKeepAliveService.ACTION_STOP);
        try {
            startService(stopRadio);
        } catch (RuntimeException ignored) {
            // Service already stopped, or the process is going away.
        }
        unregisterRadioNetworkCallback();
        super.onDestroy();
    }

    private boolean isMusicActive() {
        AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        return audio != null && audio.isMusicActive();
    }

    private boolean isScreenInteractive() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return power == null || power.isInteractive();
    }

    /** Called from the radio page when a station starts or stops. */
    void onRadioPlayingFromPage(boolean playing, String title) {
        radioKeepAlive = playing;
        runOnUiThread(() -> {
            if (!isAppPage()) {
                radioKeepAlive = false;
                return;
            }
            if (playing) {
                applyRadioRendererPriority(true);
                String safe = title == null ? "Radio" : title.trim();
                if (safe.isEmpty()) {
                    safe = "Radio";
                } else if (safe.length() > 80) {
                    safe = safe.substring(0, 80);
                }
                Intent intent = new Intent(this, RadioKeepAliveService.class);
                intent.putExtra(RadioKeepAliveService.EXTRA_TITLE, safe);
                try {
                    ContextCompat.startForegroundService(this, intent);
                } catch (RuntimeException ignored) {
                    // Screen already off and the system refused a new playback service.
                }
                return;
            }
            applyRadioRendererPriority(false);
            Intent intent = new Intent(this, RadioKeepAliveService.class);
            intent.setAction(RadioKeepAliveService.ACTION_STOP);
            try {
                startService(intent);
            } catch (RuntimeException ignored) {
                // Service already stopped.
            }
        });
    }

    private boolean isAppPage() {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            return false;
        }
        String url = bridge.getWebView().getUrl();
        if (url == null || url.isEmpty()) {
            return true;
        }
        Uri uri = Uri.parse(url);
        String host = uri.getHost();
        if (host == null) {
            return url.startsWith("file:");
        }
        return APP_HOST.equalsIgnoreCase(host) || "localhost".equalsIgnoreCase(host);
    }

    private void applyRadioRendererPriority(boolean important) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        bridge.getWebView().setRendererPriorityPolicy(
                important ? WebView.RENDERER_PRIORITY_IMPORTANT : WebView.RENDERER_PRIORITY_BOUND,
                !important);
    }

    private void notifyRadioScreen(boolean off) {
        runRadioScript(
                "window.__patRadioScreenOff=" + (off ? "true" : "false")
                        + ";window.dispatchEvent(new Event('patradioscreen'))");
    }

    private void resumeWebViewForRadio() {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        WebView webView = bridge.getWebView();
        webView.onResume();
        webView.resumeTimers();
    }

    private void registerRadioNetworkCallback() {
        if (radioNetworkCallback != null) {
            return;
        }
        ConnectivityManager connectivity =
                (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) {
            return;
        }
        ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                runRadioScript("window.dispatchEvent(new Event('online'))");
            }

            @Override
            public void onLost(Network network) {
                runRadioScript("window.dispatchEvent(new Event('offline'))");
            }
        };
        try {
            connectivity.registerDefaultNetworkCallback(callback);
            radioNetworkCallback = callback;
        } catch (RuntimeException ignored) {
            // Some devices reject the callback when no network is registered.
        }
    }

    private void unregisterRadioNetworkCallback() {
        ConnectivityManager.NetworkCallback callback = radioNetworkCallback;
        radioNetworkCallback = null;
        if (callback == null) {
            return;
        }
        ConnectivityManager connectivity =
                (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) {
            return;
        }
        try {
            connectivity.unregisterNetworkCallback(callback);
        } catch (RuntimeException ignored) {
            // Already unregistered.
        }
    }

    private void runRadioScript(String script) {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        WebView webView = bridge.getWebView();
        webView.post(() -> {
            try {
                webView.evaluateJavascript(script, null);
            } catch (RuntimeException ignored) {
                // WebView already destroyed.
            }
        });
    }
}

/** Page bridge: the radio player calls this when a station starts or stops. */
class RadioNativeBridge {

    private final MainActivity activity;

    RadioNativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void setPlaying(boolean playing, String title) {
        activity.onRadioPlayingFromPage(playing, title);
    }
}
