package app.newses;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins register before the bridge starts.
        registerPlugin(ShareTargetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
