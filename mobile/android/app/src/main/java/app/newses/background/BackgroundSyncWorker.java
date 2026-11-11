package app.newses.background;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * WorkManager's periodic job: one `BackgroundFetch` run while the app is closed, then, when the
 * reader asked for it, the new-entries notification.
 */
public class BackgroundSyncWorker extends Worker {

    /** Guards the new-entries state, which the app's hand-overs change too. */
    static final Object NEW_ENTRIES = new Object();

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
