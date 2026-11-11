package app.newses.background;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The background job, for the web app: `configure` starts, changes, or stops it for the active
 * profile, with its UnifiedPush registration, and `take` hands over what it fetched for that
 * profile while the app was closed. It also asks for the notification permission, says how pushes
 * arrive (and has the reader choose a distributor), and passes on the stream a tapped
 * notification opens as a "navigate" event, kept until the web app listens.
 */
@CapacitorPlugin(
    name = "BackgroundSync",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class BackgroundSyncPlugin extends Plugin {

    /** The streams a notification opens (`NewEntries.Summary.target`). */
    private static final Pattern TARGET = Pattern.compile("/(all|[fc]\\d+)");

    private static volatile boolean foreground;

    /** Whether the app is on screen, where it shows new entries itself. */
    static boolean inForeground() {
        return foreground;
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        foreground = true;
        // The reader is back: what the notification counted is in front of them.
        Context context = getContext();
        SharedPreferences prefs = BackgroundSyncWorker.prefs(context);
        synchronized (BackgroundSyncWorker.NEW_ENTRIES) {
            NewEntriesNotifier.cancel(context);
            NewEntries found = NewEntries.from(prefs.getString("newEntries", null));
            found.seen();
            try {
                prefs.edit().putString("newEntries", found.toJson()).apply();
            } catch (JSONException e) {
                prefs.edit().remove("newEntries").apply();
            }
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        foreground = false;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String target = intent == null ? null : intent.getStringExtra(NewEntriesNotifier.TARGET);
        if (target == null || !TARGET.matcher(target).matches()) return;
        // Handled once: a recreated activity must not open it again.
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        JSObject data = new JSObject();
        data.put("target", target);
        notifyListeners("navigate", data, true);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        Context context = getContext();
        SharedPreferences prefs = BackgroundSyncWorker.prefs(context);
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        String serverUrl = call.getString("serverUrl");
        String token = call.getString("token");
        String profileId = call.getString("profileId");
        if (!enabled || serverUrl == null || token == null || profileId == null) {
            BackgroundSyncWorker.cancel(context);
            PushRegistration.stop(context, prefs);
            BackgroundSyncWorker.forgetNew(context, prefs);
            prefs.edit().clear().apply();
            BackgroundSyncWorker.staged(context, null).clear();
            call.resolve();
            return;
        }
        String syncToken = call.getString("syncToken");
        boolean otherProfile = !profileId.equals(prefs.getString("profileId", null));
        // Pages from an older token cannot follow the store's newer state, nor another profile's
        // pages its store; the app refetches them.
        if (otherProfile || (syncToken != null && !syncToken.equals(prefs.getString("syncToken", null)))) {
            BackgroundSyncWorker.staged(context, null).clear();
            BackgroundSyncWorker.forgetNew(context, prefs);
        }
        // The profile left stops getting pushes; the endpoint goes to the new one's session.
        if (otherProfile) PushRegistration.leave(prefs, prefs.getString("serverUrl", null), TokenVault.read(prefs));
        try {
            TokenVault.write(prefs, token);
        } catch (GeneralSecurityException e) {
            call.reject("Could not keep the token", e);
            return;
        }
        try {
            handOverNew(context, prefs, call.getObject("notify"));
        } catch (JSONException e) {
            call.reject("Could not read the notification settings", e);
            return;
        }
        boolean wifiOnly = Boolean.TRUE.equals(call.getBoolean("wifiOnly", true));
        prefs
            .edit()
            .putBoolean("enabled", true)
            .putBoolean("wifiOnly", wifiOnly)
            .putString("profileId", profileId)
            .putString("serverUrl", serverUrl)
            .putString("syncToken", syncToken)
            .apply();
        PushRegistration.update(context, prefs, call.getString("pushKey"), profileId);
        BackgroundSyncWorker.schedule(context, prefs);
        call.resolve();
    }

    @PluginMethod
    public void pushStatus(PluginCall call) {
        call.resolve(PushRegistration.status(getContext(), BackgroundSyncWorker.prefs(getContext())));
    }

    @PluginMethod
    public void choosePushService(PluginCall call) {
        Context context = getContext();
        SharedPreferences prefs = BackgroundSyncWorker.prefs(context);
        if (getActivity() == null || prefs.getString("pushKey", null) == null) {
            call.resolve(PushRegistration.status(context, prefs));
            return;
        }
        PushRegistration.choose(getActivity(), prefs, () -> call.resolve(PushRegistration.status(context, prefs)));
    }

    /** Notifications on with what the job needs to count and word them (`NewEntriesHandover`), or off. */
    private static void handOverNew(Context context, SharedPreferences prefs, JSONObject notify) throws JSONException {
        if (notify == null || notify.optJSONObject("strings") == null) {
            BackgroundSyncWorker.forgetNew(context, prefs);
            prefs.edit().putBoolean("notify", false).remove("strings").apply();
            return;
        }
        synchronized (BackgroundSyncWorker.NEW_ENTRIES) {
            NewEntries found = NewEntries.from(prefs.getString("newEntries", null));
            found.handOver(notify);
            NewEntriesNotifier.cancel(context);
            prefs
                .edit()
                .putBoolean("notify", true)
                .putString("strings", notify.getJSONObject("strings").toString())
                .putString("newEntries", found.toJson())
                .apply();
        }
    }

    /** `granted`, `denied`, or `prompt` until asked (Android 13+; earlier ones need no asking). */
    @PluginMethod
    public void notificationAccess(PluginCall call) {
        boolean ask = Boolean.TRUE.equals(call.getBoolean("ask", false));
        if (ask && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationAnswered");
            return;
        }
        resolveAccess(call);
    }

    @PermissionCallback
    private void notificationAnswered(PluginCall call) {
        resolveAccess(call);
    }

    private void resolveAccess(PluginCall call) {
        String state;
        if (NewEntriesNotifier.allowed(getContext())) state = "granted";
        else if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED &&
            getPermissionState("notifications") != PermissionState.DENIED
        ) state = "prompt";
        else state = "denied";
        JSObject result = new JSObject();
        result.put("state", state);
        call.resolve(result);
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
