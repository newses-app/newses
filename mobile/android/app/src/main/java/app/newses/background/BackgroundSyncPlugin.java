package app.newses.background;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * The background job, for the web app: `configure` starts, changes, or stops it for the active
 * profile, and `take` hands over what it fetched for that profile while the app was closed.
 */
@CapacitorPlugin(name = "BackgroundSync")
public class BackgroundSyncPlugin extends Plugin {

    private static final String WORK = "newses-background-sync";
    /** As often as the server's feeds are fetched by default, and battery friendly. */
    private static final long INTERVAL_MINUTES = 30;

    @PluginMethod
    public void configure(PluginCall call) {
        Context context = getContext();
        SharedPreferences prefs = BackgroundSyncWorker.prefs(context);
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        String serverUrl = call.getString("serverUrl");
        String token = call.getString("token");
        String profileId = call.getString("profileId");
        if (!enabled || serverUrl == null || token == null || profileId == null) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK);
            prefs.edit().clear().apply();
            BackgroundSyncWorker.staged(context, null).clear();
            call.resolve();
            return;
        }
        String syncToken = call.getString("syncToken");
        // Pages from an older token cannot follow the store's newer state, nor another profile's
        // pages its store; the app refetches them.
        if (
            !profileId.equals(prefs.getString("profileId", null)) ||
            (syncToken != null && !syncToken.equals(prefs.getString("syncToken", null)))
        ) {
            BackgroundSyncWorker.staged(context, null).clear();
        }
        try {
            TokenVault.write(prefs, token);
        } catch (GeneralSecurityException e) {
            call.reject("Could not keep the token", e);
            return;
        }
        boolean wifiOnly = Boolean.TRUE.equals(call.getBoolean("wifiOnly", true));
        prefs
            .edit()
            .putBoolean("enabled", true)
            .putString("profileId", profileId)
            .putString("serverUrl", serverUrl)
            .putString("syncToken", syncToken)
            .apply();
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
            BackgroundSyncWorker.class,
            INTERVAL_MINUTES,
            TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, request);
        call.resolve();
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSArray pages = new JSArray();
        try {
            String profileId = call.getString("profileId");
            for (JSONObject page : BackgroundSyncWorker.staged(getContext(), null).take(profileId)) pages.put(page);
        } catch (IOException e) {
            call.reject("Could not read what the background job fetched", e);
            return;
        }
        JSObject result = new JSObject();
        result.put("pages", pages);
        call.resolve(result);
    }
}
