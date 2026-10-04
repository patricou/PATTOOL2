package com.pattool.frontend;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import java.util.Locale;
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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        installAuthReturnHandler();
    }

    private void installAuthReturnHandler() {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        WebView webView = bridge.getWebView();
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
     * Screen off pauses the WebView on some phones. If a radio is already audible,
     * keep the page timers running so the stream can continue and reconnect.
     */
    @Override
    public void onPause() {
        boolean keepAudio = isMusicActive();
        super.onPause();
        if (keepAudio) {
            resumeWebViewForRadio();
        }
    }

    @Override
    public void onDestroy() {
        unregisterRadioNetworkCallback();
        super.onDestroy();
    }

    private boolean isMusicActive() {
        AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        return audio != null && audio.isMusicActive();
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
