package app.newses.background;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * What the reader's UnifiedPush distributor tells the app, even while it is closed: a new endpoint
 * goes to the server, and a message from the server (new entries for the user) runs the job.
 */
public class NewsesPushService extends PushService {

    @Override
    public void onNewEndpoint(@NonNull PushEndpoint endpoint, @NonNull String instance) {
        Context context = getApplicationContext();
        SharedPreferences prefs = BackgroundSyncWorker.prefs(context);
        PublicKeySet keys = endpoint.getPubKeySet();
        // The server encrypts every message (RFC 8291), so it needs the keys.
        if (keys == null || !prefs.getBoolean("enabled", false)) {
            PushRegistration.failed(prefs);
            return;
        }
        PushRegistration.endpoint(context, prefs, endpoint.getUrl(), keys.getPubKey(), keys.getAuth());
    }

    @Override
    public void onMessage(@NonNull PushMessage message, @NonNull String instance) {
        // Anyone who knows the endpoint can post to it; only the server's messages decrypt.
        if (!message.getDecrypted()) return;
        Context context = getApplicationContext();
        if (BackgroundSyncWorker.prefs(context).getBoolean("enabled", false)) BackgroundSyncWorker.runSoon(context);
    }

    @Override
    public void onRegistrationFailed(@NonNull FailedReason reason, @NonNull String instance) {
        PushRegistration.failed(BackgroundSyncWorker.prefs(getApplicationContext()));
    }

    @Override
    public void onUnregistered(@NonNull String instance) {
        Context context = getApplicationContext();
        PushRegistration.unregistered(context, BackgroundSyncWorker.prefs(context));
    }
}
