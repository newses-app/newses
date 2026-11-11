package app.newses.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class PushRegistrationTest {

    private static final long NOW = 1_000_000_000L;

    private static boolean needs(String key, String distributor, String endpoint, String state, long ago) {
        return PushRegistration.needsRegistering(key, distributor, "key", "io.heckel.ntfy", endpoint, state, NOW - ago, NOW);
    }

    @Test
    public void registersAgainForAnotherKeyOrDistributor() {
        assertFalse(needs("key", "io.heckel.ntfy", "https://ntfy.example/up1", "pushed", 60_000));
        assertTrue(needs("other key", "io.heckel.ntfy", "https://ntfy.example/up1", "pushed", 60_000));
        assertTrue(needs("key", "org.unifiedpush.distributor.sunup", "https://ntfy.example/up1", "pushed", 60_000));
    }

    @Test
    public void triesAgainAfterAFailureOrNoAnswer() {
        assertTrue(needs("key", "io.heckel.ntfy", "https://ntfy.example/up1", "failed", 60_000));
        assertFalse(needs("key", "io.heckel.ntfy", null, "registering", 60_000));
        assertTrue(needs("key", "io.heckel.ntfy", null, "registering", PushRegistration.UNANSWERED_MS + 1));
    }

    @Test
    public void confirmsTheRegistrationDaily() {
        assertTrue(needs("key", "io.heckel.ntfy", "https://ntfy.example/up1", "pushed", PushRegistration.RENEW_MS + 1));
    }

    @Test
    public void sendsTheEndpointAndKeysAsTheApiTakesThem() throws Exception {
        List<String> sent = new ArrayList<>();
        BackgroundFetch.Transport transport = (method, url, token, body) -> {
            sent.add(method + " " + url + " " + token);
            sent.add(body);
            return new BackgroundFetch.Response(204, "");
        };

        PushSubscriptionWorker.put(
            transport,
            "https://reader.example/",
            "t0ken",
            PushSubscriptionWorker.body("https://ntfy.example/up1?up=1", "pub", "auth")
        );
        PushSubscriptionWorker.delete(transport, "https://reader.example", "t0ken");

        assertEquals("PUT https://reader.example/api/v1/push/subscription t0ken", sent.get(0));
        JSONObject body = new JSONObject(sent.get(1));
        assertEquals("https://ntfy.example/up1?up=1", body.getString("endpoint"));
        assertEquals("pub", body.getJSONObject("keys").getString("p256dh"));
        assertEquals("auth", body.getJSONObject("keys").getString("auth"));
        assertEquals("DELETE https://reader.example/api/v1/push/subscription t0ken", sent.get(2));
        assertNull(sent.get(3));
    }
}
