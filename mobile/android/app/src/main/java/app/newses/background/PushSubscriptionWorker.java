package app.newses.background;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.work.Data;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.IOException;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Hands the server this device's push endpoint (`PUT /push/subscription`), with the job's token so
 * it works with the app closed; without an endpoint in its input, removes it (`DELETE`).
 */
public class PushSubscriptionWorker extends Worker {

    public PushSubscriptionWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** The request body for an endpoint and its keys (RFC 8291). */
    static String body(String endpoint, String p256dh, String auth) throws JSONException {
        return new JSONObject()
            .put("endpoint", endpoint)
            .put("keys", new JSONObject().put("p256dh", p256dh).put("auth", auth))
            .toString();
    }

    static BackgroundFetch.Response put(BackgroundFetch.Transport transport, String serverUrl, String token, String body)
        throws IOException {
        return transport.send("PUT", url(serverUrl), token, body);
    }

    static BackgroundFetch.Response delete(BackgroundFetch.Transport transport, String serverUrl, String token)
        throws IOException {
        return transport.send("DELETE", url(serverUrl), token, null);
    }

    private static String url(String serverUrl) {
        return serverUrl.replaceAll("/+$", "") + "/api/v1/push/subscription";
    }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences prefs = BackgroundSyncWorker.prefs(getApplicationContext());
        String serverUrl = prefs.getString("serverUrl", null);
        String token = TokenVault.read(prefs);
        if (serverUrl == null || token == null) return Result.success();
        Data input = getInputData();
        String endpoint = input.getString("endpoint");
        try {
            BackgroundFetch.Response response = endpoint == null
                ? delete(new HttpTransport(), serverUrl, token)
                : put(new HttpTransport(), serverUrl, token, body(endpoint, input.getString("p256dh"), input.getString("auth")));
            // Signed out: the app hands over a new token after signing in.
            if (response.status == 401) return Result.success();
            // Refused (an endpoint that is not https, a server without push): the timer carries on.
            if (response.status >= 400 && response.status < 500 && response.status != 429) {
                if (endpoint != null) PushRegistration.failed(prefs);
                return Result.success();
            }
            return response.status < 300 ? Result.success() : Result.retry();
        } catch (IOException | JSONException e) {
            return Result.retry();
        }
    }
}
