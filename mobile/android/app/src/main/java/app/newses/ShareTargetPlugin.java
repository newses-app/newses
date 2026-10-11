package app.newses;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Text shared to the app (ACTION_SEND, text/plain) as a "share" event. Capacitor passes the launch
 * intent here too, and the event is kept until the web app listens, so a share that starts the app
 * is not lost.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        if (!"text/plain".equals(intent.getType())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        // Handled once: a recreated activity must not share it again.
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        if (text == null || text.isEmpty()) return;
        JSObject data = new JSObject();
        data.put("text", text.length() > 8192 ? text.substring(0, 8192) : text);
        notifyListeners("share", data, true);
    }
}
