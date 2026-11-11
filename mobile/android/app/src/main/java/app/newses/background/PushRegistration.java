package app.newses.background;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import java.io.IOException;
import java.util.List;
import java.util.function.Consumer;
import kotlin.Unit;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.data.ResolvedDistributor;

/**
 * The job's UnifiedPush registration: with the reader's distributor (such as ntfy), the server's
 * pushes run the job (`NewsesPushService`), and the timer falls back to every 4 hours. Kept in
 * the job's preferences: the server's key, the distributor, the endpoint and its keys, which
 * profile's session has it, and the state.
 */
final class PushRegistration {

    static final String INSTANCE = "default";
    private static final String UPLOAD = "newses-push-subscription";
    /** Registering again this often confirms the distributor still delivers. */
    static final long RENEW_MS = 24 * 60 * 60 * 1000L;
    /** A registration the distributor has not answered in this long is tried again. */
    static final long UNANSWERED_MS = 10 * 60 * 1000L;

    private PushRegistration() {}

    /**
     * Whether to ask the distributor (again): another key or distributor, no endpoint once the
     * last request went unanswered, a failure, or a day since the last request.
     */
    static boolean needsRegistering(
        String key,
        String distributor,
        String registeredKey,
        String registeredDistributor,
        String endpoint,
        String state,
        long registeredAt,
        long now
    ) {
        if (!key.equals(registeredKey) || !distributor.equals(registeredDistributor)) return true;
        if ("failed".equals(state)) return true;
        if (endpoint == null && now - registeredAt > UNANSWERED_MS) return true;
        return now - registeredAt > RENEW_MS;
    }

    /** The distributor to use: the one chosen (and answering), else the only one installed. */
    private static String distributor(Context context) {
        String chosen = UnifiedPush.getAckDistributor(context);
        if (chosen == null) chosen = UnifiedPush.getSavedDistributor(context);
        if (chosen != null) return chosen;
        ResolvedDistributor resolved = UnifiedPush.resolveDefaultDistributor(context);
        if (!(resolved instanceof ResolvedDistributor.Found)) return null;
        String found = ((ResolvedDistributor.Found) resolved).getPackageName();
        UnifiedPush.saveDistributor(context, found);
        return found;
    }

    /**
     * After `configure` (background sync on): registers with the server's key where needed, and
     * hands the profile's session the endpoint it does not have yet. Without a key, stops.
     */
    static void update(Context context, SharedPreferences prefs, String key, String profileId) {
        if (key == null) {
            stop(context, prefs);
            return;
        }
        String distributor = distributor(context);
        if (distributor == null) return;
        String endpoint = prefs.getString("pushEndpoint", null);
        if (
            needsRegistering(
                key,
                distributor,
                prefs.getString("pushKey", null),
                prefs.getString("pushDistributor", null),
                endpoint,
                prefs.getString("pushState", null),
                prefs.getLong("pushRegisteredAt", 0),
                System.currentTimeMillis()
            )
        ) {
            register(context, prefs, key, distributor);
        } else if (endpoint != null && !profileId.equals(prefs.getString("pushProfile", null))) {
            upload(context, prefs);
        }
    }

    private static void register(Context context, SharedPreferences prefs, String key, String distributor) {
        SharedPreferences.Editor edit = prefs
            .edit()
            .putString("pushKey", key)
            .putString("pushDistributor", distributor)
            .putString("pushState", "registering")
            .putLong("pushRegisteredAt", System.currentTimeMillis());
        // A new key needs a subscription made for it.
        if (!key.equals(prefs.getString("pushKey", null))) edit.remove("pushEndpoint");
        edit.apply();
        try {
            UnifiedPush.register(context, INSTANCE, "Newses", key);
        } catch (RuntimeException e) {
            prefs.edit().putString("pushState", "failed").apply();
        }
    }

    /** The distributor's endpoint, for the active profile's session to get (`NewsesPushService`). */
    static void endpoint(Context context, SharedPreferences prefs, String url, String p256dh, String auth) {
        prefs
            .edit()
            .putString("pushEndpoint", url)
            .putString("pushP256dh", p256dh)
            .putString("pushAuth", auth)
            .putString("pushState", "pushed")
            .apply();
        upload(context, prefs);
        BackgroundSyncWorker.schedule(context, prefs);
    }

    /** Sends the endpoint to the server with the job's token, once there is a network. */
    private static void upload(Context context, SharedPreferences prefs) {
        prefs.edit().putString("pushProfile", prefs.getString("profileId", null)).apply();
        Data input = new Data.Builder()
            .putString("endpoint", prefs.getString("pushEndpoint", null))
            .putString("p256dh", prefs.getString("pushP256dh", null))
            .putString("auth", prefs.getString("pushAuth", null))
            .build();
        enqueue(context, prefs, input);
    }

    private static void enqueue(Context context, SharedPreferences prefs, Data input) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(PushSubscriptionWorker.class)
            .setInputData(input)
            .setConstraints(BackgroundSyncWorker.constraints(prefs, false))
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(UPLOAD, ExistingWorkPolicy.REPLACE, request);
    }

    /** The distributor gave up on the registration: the timer runs every 30 minutes again. */
    static void unregistered(Context context, SharedPreferences prefs) {
        boolean had = prefs.getString("pushEndpoint", null) != null;
        forget(prefs);
        if (had) enqueue(context, prefs, Data.EMPTY);
        BackgroundSyncWorker.schedule(context, prefs);
    }

    /**
     * Leaving the profile's session (another profile, or the app's own sign-out): the server
     * stops pushing to it. Runs on the plugin's thread, so it may wait for the server.
     */
    static void leave(SharedPreferences prefs, String serverUrl, String token) {
        if (prefs.getString("pushEndpoint", null) == null || serverUrl == null || token == null) return;
        try {
            PushSubscriptionWorker.delete(new HttpTransport(), serverUrl, token);
        } catch (IOException e) {
            // Unreachable: the subscription goes when the session ends, or when the push fails.
        }
        prefs.edit().remove("pushProfile").apply();
    }

    /** Background sync off or no key: unregisters and forgets it all. */
    static void stop(Context context, SharedPreferences prefs) {
        if (prefs.getString("pushKey", null) == null && prefs.getString("pushDistributor", null) == null) return;
        leave(prefs, prefs.getString("serverUrl", null), TokenVault.read(prefs));
        UnifiedPush.unregister(context, INSTANCE);
        forget(prefs);
        prefs.edit().remove("pushKey").remove("pushDistributor").apply();
    }

    private static void forget(SharedPreferences prefs) {
        prefs
            .edit()
            .remove("pushEndpoint")
            .remove("pushP256dh")
            .remove("pushAuth")
            .remove("pushProfile")
            .remove("pushState")
            .remove("pushRegisteredAt")
            .apply();
    }

    static void failed(SharedPreferences prefs) {
        prefs.edit().putString("pushState", "failed").apply();
    }

    /** `PushServiceStatus` for the web app. */
    static JSObject status(Context context, SharedPreferences prefs) {
        JSObject result = new JSObject();
        if (!prefs.getBoolean("enabled", false) || prefs.getString("pushKey", null) == null) {
            result.put("state", "off");
            return result;
        }
        String chosen = UnifiedPush.getAckDistributor(context);
        if (chosen == null) chosen = UnifiedPush.getSavedDistributor(context);
        if (chosen == null) {
            ResolvedDistributor resolved = UnifiedPush.resolveDefaultDistributor(context);
            result.put("state", resolved instanceof ResolvedDistributor.NoneAvailable ? "none" : "choose");
            return result;
        }
        result.put("distributor", label(context, chosen));
        String state = prefs.getString("pushState", null);
        if ("failed".equals(state)) result.put("state", "failed");
        else result.put("state", prefs.getString("pushEndpoint", null) != null ? "pushed" : "registering");
        return result;
    }

    private static String label(Context context, String packageName) {
        PackageManager packages = context.getPackageManager();
        try {
            return packages.getApplicationLabel(packages.getApplicationInfo(packageName, 0)).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }

    /**
     * Asks the reader which distributor to use (the system's picker, else a list of those
     * installed), then registers with it; `done` runs once that is settled.
     */
    static void choose(Activity activity, SharedPreferences prefs, Runnable done) {
        Consumer<String> chosen = (distributor) -> {
            String key = prefs.getString("pushKey", null);
            if (distributor != null && key != null) register(activity, prefs, key, distributor);
            done.run();
        };
        UnifiedPush.tryPickDistributor(activity, (success) -> {
            if (success) chosen.accept(UnifiedPush.getSavedDistributor(activity));
            else pickFromList(activity, chosen);
            return Unit.INSTANCE;
        });
    }

    private static void pickFromList(Activity activity, Consumer<String> chosen) {
        List<String> distributors = UnifiedPush.getDistributors(activity);
        if (distributors.isEmpty()) {
            chosen.accept(null);
            return;
        }
        String[] labels = distributors.stream().map((d) -> label(activity, d)).toArray(String[]::new);
        activity.runOnUiThread(() ->
            new AlertDialog.Builder(activity)
                .setItems(labels, (dialog, which) -> {
                    String distributor = distributors.get(which);
                    UnifiedPush.saveDistributor(activity, distributor);
                    chosen.accept(distributor);
                })
                .setOnCancelListener((dialog) -> chosen.accept(null))
                .show()
        );
    }
}
