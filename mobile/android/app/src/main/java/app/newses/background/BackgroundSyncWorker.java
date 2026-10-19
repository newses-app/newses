package app.newses.background;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.File;
import java.io.IOException;

/** WorkManager's periodic job: one `BackgroundFetch` run while the app is closed. */
public class BackgroundSyncWorker extends Worker {

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
        try {
            BackgroundFetch.Result result =
                new BackgroundFetch(
                    new HttpTransport(),
                    staged(context, prefs.getString("profileId", null)),
                    serverUrl,
                    token
                ).run(syncToken);
            prefs.edit().putString("syncToken", result.syncToken).apply();
            switch (result.outcome) {
                case RETRY:
                    return Result.retry();
                case SIGNED_OUT:
                    // Until the app signs in again and hands over a new token.
                    TokenVault.clear(prefs);
                    return Result.success();
                default:
                    return Result.success();
            }
        } catch (IOException e) {
            return Result.retry();
        }
    }
}
