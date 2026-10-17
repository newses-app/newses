package app.newses.background;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One run of the background job: follows `/sync` from where the app's store stood, then fetches
 * the text of unread and starred entries that changed, keeping each response for the app. It never
 * sends changes made in the app; those stay in the app's outbox.
 */
final class BackgroundFetch {

    /** Sends a request; `body` is null for a GET. */
    interface Transport {
        Response send(String method, String url, String token, String body) throws IOException;
    }

    static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    enum Outcome {
        /** Done, or stopped at the staging cap: the app fetches the rest. */
        DONE,
        /** The server could not be reached or failed; WorkManager tries again later. */
        RETRY,
        /** The session ended: the job stops until the app is signed in again. */
        SIGNED_OUT,
    }

    static final class Result {
        final Outcome outcome;
        /** Where the next run carries on from. */
        final String syncToken;

        Result(Outcome outcome, String syncToken) {
            this.outcome = outcome;
            this.syncToken = syncToken;
        }
    }

    /** Pages per run, so one run stays short. */
    static final int MAX_SYNC_PAGES = 20;
    static final int SYNC_LIMIT = 500;
    /** `POST /entries/contents` takes this many ids at most. */
    static final int CONTENTS_IDS = 100;

    private final Transport transport;
    private final StagedPages pages;
    private final String api;
    private final String token;

    BackgroundFetch(Transport transport, StagedPages pages, String serverUrl, String token) {
        this.transport = transport;
        this.pages = pages;
        this.api = serverUrl.replaceAll("/+$", "") + "/api/v1";
        this.token = token;
    }

    Result run(String since) throws IOException {
        String next = since;
        List<Integer> wanted = new ArrayList<>();
        try {
            for (int i = 0; i < MAX_SYNC_PAGES; i++) {
                String url = api + "/sync?limit=" + SYNC_LIMIT + "&since="
                    + URLEncoder.encode(next, StandardCharsets.UTF_8.name());
                Response response = transport.send("GET", url, token, null);
                if (response.status == 401) return new Result(Outcome.SIGNED_OUT, since);
                // 410: the server forgot deletions since; the app loads everything again itself.
                if (response.status == 410) return new Result(Outcome.DONE, next);
                if (response.status != 200) return new Result(Outcome.RETRY, next);
                if (!pages.add("sync", next, response.body)) return new Result(Outcome.DONE, next);
                JSONObject page = new JSONObject(response.body);
                next = page.getString("next");
                JSONArray entries = page.getJSONArray("entries");
                for (int e = 0; e < entries.length(); e++) {
                    JSONObject entry = entries.getJSONObject(e);
                    if (entry.optBoolean("unread") || entry.optBoolean("starred")) {
                        wanted.add(entry.getInt("id"));
                    }
                }
                if (!page.optBoolean("more")) break;
            }
            for (int i = 0; i < wanted.size(); i += CONTENTS_IDS) {
                JSONArray ids = new JSONArray(wanted.subList(i, Math.min(i + CONTENTS_IDS, wanted.size())));
                String body = new JSONObject().put("ids", ids).toString();
                Response response = transport.send("POST", api + "/entries/contents", token, body);
                if (response.status == 401) return new Result(Outcome.SIGNED_OUT, next);
                // Text is a bonus: the changes are kept, and the app downloads what is missing.
                if (response.status != 200) break;
                if (!pages.add("contents", null, response.body)) break;
            }
        } catch (JSONException e) {
            throw new IOException("Unexpected response", e);
        }
        return new Result(Outcome.DONE, next);
    }
}
