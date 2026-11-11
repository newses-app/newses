package app.newses.background;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.icu.text.PluralRules;
import android.icu.util.ULocale;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import app.newses.MainActivity;
import app.newses.R;
import org.json.JSONObject;

/** The one new-entries notification: shown, replaced with the running total, or removed. */
final class NewEntriesNotifier {

    static final String CHANNEL = "new-entries";
    /** The intent extra with the stream a tap opens. */
    static final String TARGET = "app.newses.TARGET";
    private static final int ID = 1;

    private NewEntriesNotifier() {}

    /** Whether the reader lets the app notify: the permission (Android 13+) and the app's switch. */
    static boolean allowed(Context context) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false;
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    /** Shows `summary`, replacing the last; `alert` false updates it without a sound. */
    @SuppressLint("MissingPermission") // Checked by `allowed`.
    static void show(Context context, JSONObject strings, NewEntries.Summary summary, boolean alert) {
        if (!allowed(context)) return;
        channel(context, strings.optString("channel", "New entries"));
        PluralRules rules = PluralRules.forLocale(ULocale.forLanguageTag(strings.optString("locale", "en")));
        NotificationText text = NotificationText.of(strings, summary, rules::select);
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .putExtra(TARGET, summary.target);
        PendingIntent tap = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(text.title)
            .setNumber(summary.count)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setSilent(!alert);
        if (!text.body.isEmpty()) {
            builder.setContentText(text.body).setStyle(new NotificationCompat.BigTextStyle().bigText(text.body));
        }
        NotificationManagerCompat.from(context).notify(ID, builder.build());
    }

    static void cancel(Context context) {
        NotificationManagerCompat.from(context).cancel(ID);
    }

    /** Created, or renamed in the app's language; the reader's own choices for it stay. */
    private static void channel(Context context, String name) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_DEFAULT));
    }
}
