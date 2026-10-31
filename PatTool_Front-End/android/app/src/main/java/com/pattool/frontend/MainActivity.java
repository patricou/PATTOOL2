package com.pattool.frontend;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import java.lang.ref.WeakReference;
import java.util.Locale;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapacitorWebView;

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

    /** True after the default network has validated internet. Avoids repeating online events. */
    private boolean radioNetworkValidated;

    private final Handler radioNetworkHandler = new Handler(Looper.getMainLooper());

    private Runnable pendingRadioOffline;

    /** True while radio or YouTube is playing. Set from the page, read on screen off. */
    private volatile boolean radioKeepAlive;

    private static WeakReference<MainActivity> radioActivity;

    private BroadcastReceiver musicVolumeReceiver;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        radioActivity = new WeakReference<>(this);
        hideNavigationBar();
        installAuthReturnHandler();
        registerMusicVolumeReceiver();
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
     * Screen off pauses the WebView on some phones. If radio, Deezer or YouTube is
     * playing, keep the page timers running and tell Chromium the window is still
     * visible, so a YouTube iframe is not suspended with the display.
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
        CapacitorWebView.setKeepVisible(false);
        WeakReference<MainActivity> current = radioActivity;
        if (current != null && current.get() == this) {
            radioActivity = null;
        }
        Intent stopRadio = new Intent(this, RadioKeepAliveService.class);
        stopRadio.setAction(RadioKeepAliveService.ACTION_STOP);
        try {
            startService(stopRadio);
        } catch (RuntimeException ignored) {
            // Service already stopped, or the process is going away.
        }
        if (pendingRadioOffline != null) {
            radioNetworkHandler.removeCallbacks(pendingRadioOffline);
            pendingRadioOffline = null;
        }
        unregisterRadioNetworkCallback();
        unregisterMusicVolumeReceiver();
        super.onDestroy();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (radioKeepAlive && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audio != null) {
                audio.adjustStreamVolume(
                        AudioManager.STREAM_MUSIC,
                        keyCode == KeyEvent.KEYCODE_VOLUME_UP ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER,
                        AudioManager.FLAG_SHOW_UI);
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    private boolean isMusicActive() {
        AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        return audio != null && audio.isMusicActive();
    }

    private boolean isScreenInteractive() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return power == null || power.isInteractive();
    }

    /** Asks the page to refresh the radio Bluetooth line after the network name or the bars move. */
    static void dispatchRadioReception(String mark) {
        WeakReference<MainActivity> current = radioActivity;
        MainActivity activity = current == null ? null : current.get();
        if (activity == null) {
            return;
        }
        activity.runRadioScript(
                "window.dispatchEvent(new CustomEvent('patradioreception',{detail:" + jsQuote(mark) + "}))");
    }

    /** A JavaScript string literal. Network names can contain quotes. */
    private static String jsQuote(String value) {
        String safe = value == null ? "" : value;
        StringBuilder out = new StringBuilder(safe.length() + 2);
        out.append('"');
        for (int i = 0; i < safe.length(); i++) {
            char c = safe.charAt(i);
            if (c == '\\' || c == '"') {
                out.append('\\').append(c);
            } else if (c < 0x20 || c == '\u2028' || c == '\u2029') {
                out.append(' ');
            } else {
                out.append(c);
            }
        }
        out.append('"');
        return out.toString();
    }

    /** Headset play, pause, and station skip, forwarded to the radio page. */
    static void dispatchRadioTransport(String action) {
        if (!"play".equals(action) && !"pause".equals(action) && !"next".equals(action) && !"previous".equals(action)) {
            return;
        }
        WeakReference<MainActivity> current = radioActivity;
        MainActivity activity = current == null ? null : current.get();
        if (activity == null) {
            return;
        }
        if ("next".equals(action) || "previous".equals(action)) {
            activity.runRadioScript(
                    "window.dispatchEvent(new CustomEvent('patradiotransport',{detail:'" + action + "'}))");
            return;
        }
        activity.runRadioScript(
                "(function(){var nodes=document.querySelectorAll('audio[data-pat-radio=\"1\"]');"
                        + "var el=null;for(var i=0;i<nodes.length;i++){if(!nodes[i].paused){el=nodes[i];break;}}"
                        + "if(!el&&nodes.length){el=nodes[nodes.length-1];}if(!el)return;"
                        + "if('" + action + "'==='play'){var p=el.play();if(p&&p.catch){p.catch(function(){});}}"
                        + "else{el.pause();}})()");
    }

    /** Called from the radio page when a station starts or stops. */
    void onRadioPlayingFromPage(boolean playing, String title, String artist, String album, boolean radio) {
        radioKeepAlive = playing;
        // Set before the display turns off. The visibility callback reads this flag.
        CapacitorWebView.setKeepVisible(playing);
        runOnUiThread(() -> {
            if (!playing) {
                releaseWebViewVisibilityHold();
            }
            if (!isAppPage()) {
                radioKeepAlive = false;
                CapacitorWebView.setKeepVisible(false);
                releaseWebViewVisibilityHold();
                return;
            }
            if (playing) {
                applyRadioRendererPriority(true);
                setVolumeControlStream(AudioManager.STREAM_MUSIC);
                publishMusicVolume();
                Intent intent = new Intent(this, RadioKeepAliveService.class);
                intent.putExtra(RadioKeepAliveService.EXTRA_TITLE, title);
                intent.putExtra(RadioKeepAliveService.EXTRA_ARTIST, artist);
                intent.putExtra(RadioKeepAliveService.EXTRA_ALBUM, album);
                intent.putExtra(RadioKeepAliveService.EXTRA_RADIO, radio);
                try {
                    ContextCompat.startForegroundService(this, intent);
                } catch (RuntimeException ignored) {
                    // Screen already off and the system refused a new playback service.
                }
                return;
            }
            applyRadioRendererPriority(false);
            setVolumeControlStream(AudioManager.USE_DEFAULT_STREAM_TYPE);
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
        if (webView instanceof CapacitorWebView) {
            ((CapacitorWebView) webView).reassertVisible();
        }
        webView.onResume();
        webView.resumeTimers();
    }

    private void releaseWebViewVisibilityHold() {
        Bridge bridge = getBridge();
        if (bridge == null || !(bridge.getWebView() instanceof CapacitorWebView)) {
            return;
        }
        ((CapacitorWebView) bridge.getWebView()).releaseVisibilityHold();
    }

    /** Internet is usable. Wake the page timers and tell the radio to reopen the stream. */
    private void publishRadioOnlineIfValidated(Network network) {
        ConnectivityManager connectivity =
                (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) {
            return;
        }
        NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
        boolean validated = caps != null
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        if (!validated) {
            if (radioNetworkValidated) {
                scheduleRadioOffline();
            }
            return;
        }
        if (pendingRadioOffline != null) {
            radioNetworkHandler.removeCallbacks(pendingRadioOffline);
            pendingRadioOffline = null;
        }
        if (radioNetworkValidated) {
            return;
        }
        radioNetworkValidated = true;
        // A long outage stops the audible stream and can clear the keepalive
        // flag. Timers stay paused until the WebView is resumed, so the page
        // would receive "online" and then never reopen the station.
        resumeWebViewForRadio();
        runRadioScript("window.dispatchEvent(new Event('online'))");
    }

    /** Short delay so a Wi-Fi to mobile handover does not cut a stream that is still playing. */
    private void scheduleRadioOffline() {
        if (pendingRadioOffline != null) {
            return;
        }
        pendingRadioOffline = () -> {
            pendingRadioOffline = null;
            radioNetworkValidated = false;
            runRadioScript("window.dispatchEvent(new Event('offline'))");
        };
        radioNetworkHandler.postDelayed(pendingRadioOffline, 1200);
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
                radioNetworkHandler.post(() -> publishRadioOnlineIfValidated(network));
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                radioNetworkHandler.post(() -> publishRadioOnlineIfValidated(network));
            }

            @Override
            public void onLost(Network network) {
                radioNetworkHandler.post(() -> scheduleRadioOffline());
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

    private void registerMusicVolumeReceiver() {
        if (musicVolumeReceiver != null) {
            return;
        }
        musicVolumeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null) {
                    return;
                }
                int stream = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1);
                if (stream != AudioManager.STREAM_MUSIC) {
                    return;
                }
                publishMusicVolume();
            }
        };
        IntentFilter filter = new IntentFilter("android.media.VOLUME_CHANGED_ACTION");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(musicVolumeReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(musicVolumeReceiver, filter);
        }
    }

    private void unregisterMusicVolumeReceiver() {
        BroadcastReceiver receiver = musicVolumeReceiver;
        musicVolumeReceiver = null;
        if (receiver == null) {
            return;
        }
        try {
            unregisterReceiver(receiver);
        } catch (RuntimeException ignored) {
            // Already unregistered.
        }
    }

    void setMusicVolumePercent(int percent) {
        AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) {
            return;
        }
        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        if (max <= 0) {
            return;
        }
        int level = Math.max(0, Math.min(100, percent));
        int value = Math.round(level / 100f * max);
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, value, 0);
    }

    private void publishMusicVolume() {
        AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) {
            return;
        }
        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        if (max <= 0) {
            return;
        }
        int percent = Math.round(audio.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max);
        runRadioScript("window.dispatchEvent(new CustomEvent('patmediavolume',{detail:" + percent + "}))");
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
        activity.onRadioPlayingFromPage(playing, title, "", "", false);
    }

    @JavascriptInterface
    public void setNowPlaying(boolean playing, String title, String artist, String album) {
        activity.onRadioPlayingFromPage(playing, title, artist, album, false);
    }

    /** Radio only: the service appends the phone network bars after the station. */
    @JavascriptInterface
    public void setRadioNowPlaying(boolean playing, String title, String artist, String album) {
        activity.onRadioPlayingFromPage(playing, title, artist, album, true);
    }

    /** Network name and bars inside the parentheses, such as {@code Orange 3/4}. Empty if unknown. */
    @JavascriptInterface
    public String receptionMark() {
        try {
            return MobileReception.mark(activity);
        } catch (RuntimeException ex) {
            return "";
        }
    }

    @JavascriptInterface
    public void setMediaVolume(int percent) {
        activity.runOnUiThread(() -> activity.setMusicVolumePercent(percent));
    }
}
