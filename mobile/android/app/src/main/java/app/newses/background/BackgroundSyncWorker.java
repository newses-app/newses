package app.newses.background;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * WorkManager's job: one `BackgroundFetch` run while the app is closed, then, when the reader asked
 * for it, the new-entries notification. It runs on a timer, and when the server pushes.
 */
public class BackgroundSyncWorker extends Worker {

    /** Guards the new-entries state, which the app's hand-overs change too. */
    static final Object NEW_ENTRIES = new Object();

    static final String WORK = "newses-background-sync";
    private static final String PUSHED_WORK = "newses-pushed-sync";
    /** As often as the server's feeds are fetched by default, and battery friendly. */
    private static final long INTERVAL_MINUTES = 30;
    /** While the server's pushes reach the job, the timer only catches what they missed. */
    private static final long PUSHED_INTERVAL_MINUTES = 4 * 60;

    public BackgroundSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("newses-background-sync", Context.MODE_PRIVATE);
    }

    /** Pages fetched for `profile` (null when only taking or clearing them). */
    static StagedPages staged(Context context, String profile) {
        return new StagedPages(new File(context.getFilesDir(), "background-sync"), StagedPages.MAX_BYTES, profile);
    }

    /** Wi-Fi only when the reader asked for it; for the timer, not on a low battery either. */
    static Constraints constraints(SharedPreferences prefs, boolean batteryNotLow) {
        return new Constraints.Builder()
            .setRequiredNetworkType(prefs.getBoolean("wifiOnly", true) ? NetworkType.UNMETERED : NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(batteryNotLow)
            .build();
    }

    /** Starts or changes the timer: every 30 minutes, or every 4 hours while pushes arrive. */
    static void schedule(Context context, SharedPreferences prefs) {
        long minutes = prefs.getString("pushEndpoint", null) != null ? PUSHED_INTERVAL_MINUTES : INTERVAL_MINUTES;
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(BackgroundSyncWorker.class, minutes, TimeUnit.MINUTES)
            .setConstraints(constraints(prefs, true))
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    static void cancel(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK);
        WorkManager.getInstance(context).cancelUniqueWork(PUSHED_WORK);
    }

    /** A run as soon as the network allows, after any in progress (the server pushed). */
    static void runSoon(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(BackgroundSyncWorker.class)
            .setConstraints(constraints(prefs(context), false))
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(PUSHED_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = prefs(context);
        String serverUrl = prefs.getString("serverUrl", null);
        String syncToken = prefs.getString("syncToken", null);
        String token = TokenVault.read(prefs);
        // Not set up, or the store has not synced yet: the app's first sync loads everything.
        if (!prefs.getBoolean("enabled", false) || serverUrl == null || syncToken == null || token == null) {
            return Result.success();
        }
        List<JSONObject> syncPages = new ArrayList<>();
        try {
            BackgroundFetch.Result result =
                new BackgroundFetch(
                    new HttpTransport(),
                    staged(context, prefs.getString("profileId", null)),
                    serverUrl,
                    token,
                    syncPages::add
                ).run(syncToken);
            prefs.edit().putString("syncToken", result.syncToken).apply();
            if (result.outcome != BackgroundFetch.Outcome.SIGNED_OUT) notifyNew(context, prefs, syncPages);
            switch (result.outcome) {
                case RETRY:
                    return Result.retry();
                case SIGNED_OUT:
                    // Until the app signs in again and hands over a new token; what was fetched
                    // for the ended session goes with it.
                    TokenVault.clear(prefs);
                    staged(context, null).clear();
                    forgetNew(context, prefs);
                    return Result.success();
                default:
                    return Result.success();
            }
        } catch (IOException e) {
            return Result.retry();
        }
    }

    /**
     * Counts what the pages bring that is new, and shows the running total: alerting when it grew,
     * quietly when entries were read elsewhere, and removed once none are left. Nothing while the
     * app is open, which shows them itself.
     */
    private static void notifyNew(Context context, SharedPreferences prefs, List<JSONObject> syncPages) {
        if (!prefs.getBoolean("notify", false) || BackgroundSyncPlugin.inForeground()) return;
        synchronized (NEW_ENTRIES) {
            try {
                NewEntries found = NewEntries.from(prefs.getString("newEntries", null));
                for (JSONObject page : syncPages) found.read(page);
                NewEntries.Summary summary = found.summary();
                int count = summary == null ? 0 : summary.count;
                if (count == 0) NewEntriesNotifier.cancel(context);
                else if (count != found.shown()) {
                    String strings = prefs.getString("strings", null);
                    if (strings != null) {
                        NewEntriesNotifier.show(context, new JSONObject(strings), summary, count > found.shown());
                    }
                }
                found.shown(count);
                prefs.edit().putString("newEntries", found.toJson()).apply();
            } catch (JSONException e) {
                // A page the counting cannot read: no notification this time; the pages are kept.
            }
        }
    }

    static void forgetNew(Context context, SharedPreferences prefs) {
        synchronized (NEW_ENTRIES) {
            NewEntriesNotifier.cancel(context);
            prefs.edit().remove("newEntries").apply();
        }
    }
}
