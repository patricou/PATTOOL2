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
import android.os.Build;
import android.os.IBinder;
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

    private static final String CHANNEL_ID = "pattool_radio";
    private static final int NOTIFICATION_ID = 4701;

    private PowerManager.WakeLock wakeLock;

    /** What a connected Bluetooth device shows for the current track. */
    private MediaSession mediaSession;

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
        String title = clip(intent == null ? null : intent.getStringExtra(EXTRA_TITLE), "Radio");
        String artist = clip(intent == null ? null : intent.getStringExtra(EXTRA_ARTIST), "");
        String album = clip(intent == null ? null : intent.getStringExtra(EXTRA_ALBUM), "");
        publishTrack(title, artist, album);
        startInForeground(title, artist);
        acquireWakeLock();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        releaseMediaSession();
        super.onDestroy();
    }

    private void shutdown() {
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
        MediaSession session = mediaSession;
        if (session != null) {
            builder.setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.getSessionToken()));
        }
        return builder.build();
    }

    @SuppressWarnings("deprecation")
    private void publishTrack(String title, String artist, String album) {
        MediaSession session = mediaSession();
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, artist)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_DESCRIPTION, album)
                .build());
        setPlaybackState(PlaybackState.STATE_PLAYING);
        session.setActive(true);
    }

    private void setPlaybackState(int state) {
        MediaSession session = mediaSession;
        if (session == null) {
            return;
        }
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_STOP)
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

    private static String clip(String value, String fallback) {
        String safe = value == null ? "" : value.trim();
        if (safe.isEmpty()) {
            return fallback;
        }
        return safe.length() > 120 ? safe.substring(0, 120) : safe;
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
