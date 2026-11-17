package com.kyranashi.bridgetv;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.tv.TvContract;
import android.net.Uri;
import android.os.Build;

/**
 * «Продолжить» (Watch Next) на главном экране Android TV (1.4.0).
 *
 * Последний канал, который заиграл, кладётся в системный ряд «Продолжить просмотр»; нажатие открывает
 * приложение ссылкой bridgetv://play/<id> (MainActivity.onNewIntent / Bridge.startCh) — канал включается сразу.
 * Только Android 8+ на телевизорах (FEATURE_LEANBACK); на телефонах и при любой ошибке — тихо ничего не делает.
 * Пишется только своя строка (TvProvider даёт приложению менять лишь свои записи); новой библиотеки не нужно.
 * Имена полей — строками из TvContract.WatchNextPrograms (так не зависим от версии SDK-заглушек).
 */
final class WatchNext {
    private static final int TYPE_CHANNEL = 6;              // TvContract.WatchNextPrograms.TYPE_CHANNEL
    private static final int WATCH_NEXT_TYPE_CONTINUE = 0;  // WATCH_NEXT_TYPE_CONTINUE
    private static final int ASPECT_RATIO_1_1 = 3;          // ASPECT_RATIO_1_1

    private WatchNext() { }

    static void publish(Context ctx, String id, String title, String img) {
        if (Build.VERSION.SDK_INT < 26 || !validId(id)) return;
        try {
            if (!ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)) return;
            Uri table = TvContract.WatchNextPrograms.CONTENT_URI;
            ctx.getContentResolver().delete(table, null, null);      // одна строка — последний канал
            ContentValues v = new ContentValues();
            v.put("type", TYPE_CHANNEL);
            v.put("watch_next_type", WATCH_NEXT_TYPE_CONTINUE);
            v.put("last_engagement_time_utc_millis", System.currentTimeMillis());
            v.put("title", title == null || title.length() == 0 ? "BridgeTV" : (title.length() > 80 ? title.substring(0, 80) : title));
            v.put("live", 1);
            v.put("internal_provider_id", id);
            v.put("intent_uri", new Intent(Intent.ACTION_VIEW, Uri.parse("bridgetv://play/" + Uri.encode(id)))
                    .setPackage(ctx.getPackageName()).toUri(Intent.URI_INTENT_SCHEME));
            if (img != null && Bridge.isWeb(img)) {
                v.put("poster_art_uri", img);
                v.put("poster_art_aspect_ratio", ASPECT_RATIO_1_1);
            }
            ctx.getContentResolver().insert(table, v);
        } catch (Throwable ignored) { }   // нет TvProvider / запрещено производителем — просто без ряда
    }

    /** id канала из bridgetv://play/<id> или null */
    static String channelFrom(Intent i) {
        Uri u = i != null ? i.getData() : null;
        if (u == null || !"bridgetv".equals(u.getScheme()) || !"play".equals(u.getHost())) return null;
        String id = u.getLastPathSegment();
        return validId(id) ? id : null;
    }

    private static boolean validId(String id) {
        return id != null && id.length() > 0 && id.length() <= 120 && id.matches("[\\w.@+-]+");
    }
}
