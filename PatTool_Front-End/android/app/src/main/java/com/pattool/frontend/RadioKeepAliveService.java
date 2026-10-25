package com.pattool.frontend;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * Keeps the CPU and the process awake while a radio station is playing,
 * including after the screen turns off. Without this, Android freezes the
 * WebView and the stream goes silent.
 */
public class RadioKeepAliveService extends Service {

    public static final String ACTION_STOP = "com.pattool.frontend.action.STOP_RADIO";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";
    public static final String EXTRA_ALBUM = "album";
    /** True when the track is a radio station, so the signal bars follow the station name. */
    public static final String EXTRA_RADIO = "radio";

    private static final String CHANNEL_ID = "pattool_radio";
    private static final int NOTIFICATION_ID = 4701;
    /** Same cap as the page (station, artist and song on one Bluetooth line). */
    private static final int METADATA_LIMIT = 512;

    private PowerManager.WakeLock wakeLock;

    /** What a connected Bluetooth device shows for the current track. */
    private MediaSession mediaSession;

    private String trackTitle = "";
    private String trackArtist = "";
    private String trackAlbum = "";
    private boolean trackIsRadio;
    /** Last parentheses text sent to Bluetooth, such as {@code Orange 3/4}. */
    private String publishedMark;

    private ConnectivityManager.NetworkCallback receptionCallback;
    private final Handler receptionHandler = new Handler(Looper.getMainLooper());
    private boolean receptionRefreshQueued;
    private final Runnable receptionRefresh = () -> {
        receptionRefreshQueued = false;
        refreshReception();
    };
    private final Runnable receptionPoll = new Runnable() {
        @Override
        public void run() {
            refreshReception();
            if (trackIsRadio) {
                receptionHandler.postDelayed(this, 8000);
            }
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            shutdown();
            return START_NOT_STICKY;
        }
        trackTitle = clip(withoutAppPrefix(intent == null ? null : intent.getStringExtra(EXTRA_TITLE)), "Radio");
        trackArtist = clip(withoutAppPrefix(intent == null ? null : intent.getStringExtra(EXTRA_ARTIST)), "");
        trackAlbum = clip(withoutAppPrefix(intent == null ? null : intent.getStringExtra(EXTRA_ALBUM)), "");
        trackIsRadio = intent != null && intent.getBooleanExtra(EXTRA_RADIO, false);
        publishCurrentTrack();
        String notice = !trackArtist.isEmpty() ? trackArtist : trackAlbum;
        startInForeground(trackTitle, notice);
        acquireWakeLock();
        if (trackIsRadio) {
            ensureReceptionWatch();
        } else {
            stopReceptionWatch();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        trackIsRadio = false;
        stopReceptionWatch();
        releaseWakeLock();
        releaseMediaSession();
        super.onDestroy();
    }

    private void shutdown() {
        trackIsRadio = false;
        stopReceptionWatch();
        releaseWakeLock();
        releaseMediaSession();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void startInForeground(String title, String artist) {
        Notification notification = buildNotification(title, artist);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification(String title, String artist) {
        ensureChannel();
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                this,
                0,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String text = artist.isEmpty() ? getString(R.string.radio_keepalive_text) : artist;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_radio_play)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW);
        Notification notification = builder.build();
        MediaSession session = mediaSession;
        if (session != null) {
            notification.extras.putParcelable(Notification.EXTRA_MEDIA_SESSION, session.getSessionToken());
        }
        return notification;
    }

    @SuppressWarnings("deprecation")
    private void publishCurrentTrack() {
        String mark = trackIsRadio ? MobileReception.mark(this) : "";
        applyMetadata(mediaSession(), mark);
    }

    /** Rewrites the station line when the network name or the bars change. */
    private void refreshReception() {
        if (!trackIsRadio) {
            return;
        }
        MediaSession session = mediaSession;
        if (session == null) {
            return;
        }
        String mark = MobileReception.mark(this);
        if (publishedMark != null && publishedMark.equals(mark)) {
            return;
        }
        applyMetadata(session, mark);
    }

    private void applyMetadata(MediaSession session, String mark) {
        String title = trackTitle;
        String album = trackAlbum;
        if (trackIsRadio) {
            if (!album.trim().isEmpty()) {
                album = MobileReception.decorate(album, mark);
            } else {
                title = MobileReception.decorate(title, mark);
            }
        }
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, trackArtist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST, trackArtist)
                .putString(MediaMetadata.METADATA_KEY_AUTHOR, trackArtist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, trackArtist)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_DESCRIPTION, album)
                .build());
        setPlaybackState(PlaybackState.STATE_PLAYING);
        session.setActive(true);
        boolean changed = publishedMark == null || !publishedMark.equals(mark);
        publishedMark = mark;
        if (trackIsRadio && changed) {
            MainActivity.dispatchRadioReception(mark);
        }
    }

    private void ensureReceptionWatch() {
        ConnectivityManager connectivity =
                (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (connectivity != null && receptionCallback == null) {
            ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    receptionHandler.post(RadioKeepAliveService.this::refreshReception);
                }

                @Override
                public void onLost(Network network) {
                    receptionHandler.post(RadioKeepAliveService.this::refreshReception);
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                    queueReceptionRefresh();
                }
            };
            try {
                connectivity.registerDefaultNetworkCallback(callback);
                receptionCallback = callback;
            } catch (RuntimeException ignored) {
                // Some devices reject the callback when no network is registered.
            }
        }
        receptionHandler.removeCallbacks(receptionPoll);
        receptionHandler.postDelayed(receptionPoll, 8000);
    }

    private void queueReceptionRefresh() {
        if (!trackIsRadio || receptionRefreshQueued) {
            return;
        }
        receptionRefreshQueued = true;
        receptionHandler.postDelayed(receptionRefresh, 3000);
    }

    private void stopReceptionWatch() {
        receptionHandler.removeCallbacks(receptionPoll);
        receptionHandler.removeCallbacks(receptionRefresh);
        receptionRefreshQueued = false;
        publishedMark = null;
        ConnectivityManager.NetworkCallback callback = receptionCallback;
        receptionCallback = null;
        if (callback == null) {
            return;
        }
        ConnectivityManager connectivity =
                (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (connectivity == null) {
            return;
        }
        try {
            connectivity.unregisterNetworkCallback(callback);
        } catch (RuntimeException ignored) {
            // Already unregistered.
        }
    }

    private void setPlaybackState(int state) {
        MediaSession session = mediaSession;
        if (session == null) {
            return;
        }
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(
                        PlaybackState.ACTION_PLAY
                                | PlaybackState.ACTION_PAUSE
                                | PlaybackState.ACTION_STOP
                                | PlaybackState.ACTION_SKIP_TO_NEXT
                                | PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, state == PlaybackState.STATE_PLAYING ? 1f : 0f)
                .build());
    }

    @SuppressWarnings("deprecation")
    private MediaSession mediaSession() {
        if (mediaSession != null) {
            return mediaSession;
        }
        MediaSession session = new MediaSession(this, "pattool-radio");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setPlaybackToLocal(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build());
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                setPlaybackState(PlaybackState.STATE_PLAYING);
                MainActivity.dispatchRadioTransport("play");
            }

            @Override
            public void onPause() {
                setPlaybackState(PlaybackState.STATE_PAUSED);
                MainActivity.dispatchRadioTransport("pause");
            }

            @Override
            public void onStop() {
                setPlaybackState(PlaybackState.STATE_PAUSED);
                MainActivity.dispatchRadioTransport("pause");
            }

            @Override
            public void onSkipToNext() {
                MainActivity.dispatchRadioTransport("next");
            }

            @Override
            public void onSkipToPrevious() {
                MainActivity.dispatchRadioTransport("previous");
            }
        });
        mediaSession = session;
        return session;
    }

    private void releaseMediaSession() {
        MediaSession session = mediaSession;
        mediaSession = null;
        if (session == null) {
            return;
        }
        try {
            session.setActive(false);
            session.release();
        } catch (RuntimeException ignored) {
            // Already released.
        }
    }

    /**
     * Title, artist and album stay in their own Bluetooth fields.
     * A leftover "PATTOOL - " prefix is dropped so the car screen can show the track.
     */
    static String withoutAppPrefix(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String safe = value;
        if (safe.regionMatches(true, 0, "PATTOOL - ", 0, 10)) {
            safe = safe.substring(10);
        } else if (safe.regionMatches(true, 0, "PATTOOL-", 0, 8)) {
            safe = safe.substring(8);
        }
        String trimmed = safe.trim();
        if (trimmed.isEmpty()
                || trimmed.equalsIgnoreCase("PATTOOL")
                || trimmed.equalsIgnoreCase("PatTool Radio")
                || trimmed.equalsIgnoreCase("PATTOOL YouTube")) {
            return "";
        }
        return safe;
    }

    private static String clip(String value, String fallback) {
        String safe = value == null ? "" : value.replace('\u00a0', ' ');
        int start = 0;
        while (start < safe.length() && safe.charAt(start) == ' ') {
            start++;
        }
        if (start > 0) {
            safe = safe.substring(start);
        }
        boolean trailing = !safe.isEmpty() && safe.charAt(safe.length() - 1) == ' ';
        if (safe.length() > METADATA_LIMIT) {
            safe = safe.substring(0, trailing ? METADATA_LIMIT - 1 : METADATA_LIMIT);
        }
        safe = oneTrailingSpace(safe);
        return safe.trim().isEmpty() ? fallback : safe;
    }

    /** Several trailing spaces, or a blank " -" tail, become a single space. */
    private static String oneTrailingSpace(String value) {
        int end = value.length();
        int i = end;
        while (i > 0 && value.charAt(i - 1) == ' ') {
            i--;
        }
        if (i > 0 && value.charAt(i - 1) == '-') {
            int j = i - 1;
            while (j > 0 && value.charAt(j - 1) == ' ') {
                j--;
            }
            if (j > 0 && j < i - 1) {
                return value.substring(0, j) + " ";
            }
        }
        if (i == end || i == 0) {
            return i == 0 ? "" : value;
        }
        return value.substring(0, i) + " ";
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.radio_keepalive_channel),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.radio_keepalive_channel_desc));
        channel.setShowBadge(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power == null) {
            return;
        }
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pattool:radio");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        PowerManager.WakeLock lock = wakeLock;
        wakeLock = null;
        if (lock == null) {
            return;
        }
        try {
            if (lock.isHeld()) {
                lock.release();
            }
        } catch (RuntimeException ignored) {
            // Already released.
        }
    }
}
