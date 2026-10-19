package app.newses.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

public class BackgroundFetchTest {

    private File dir;
    private final List<String> asked = new ArrayList<>();

    @Before
    public void setUp() throws IOException {
        dir = Files.createTempDirectory("staged").toFile();
        asked.clear();
    }

    private BackgroundFetch.Transport server(Function<String, BackgroundFetch.Response> answer) {
        return (method, url, token, body) -> {
            String request = method + " " + url.replace("https://r.example/api/v1", "") + (body == null ? "" : " " + body);
            asked.add(request);
            assertEquals("t0k", token);
            return answer.apply(request);
        };
    }

    private static BackgroundFetch.Response ok(String body) {
        return new BackgroundFetch.Response(200, body);
    }

    @Test
    public void followsSyncFromTheStoresTokenAndStagesPagesInOrder() throws Exception {
        StagedPages pages = new StagedPages(dir, StagedPages.MAX_BYTES, "p1");
        BackgroundFetch.Transport transport = server((request) -> {
            if (request.contains("since=T1")) {
                return ok("{\"entries\":[{\"id\":1,\"unread\":true},{\"id\":2,\"unread\":false}],\"next\":\"T2\",\"more\":true}");
            }
            if (request.contains("since=T2")) {
                return ok("{\"entries\":[{\"id\":3,\"unread\":false,\"starred\":true}],\"next\":\"T3\",\"more\":false}");
            }
            return ok("{\"entries\":[],\"missing\":[],\"deferred\":[]}");
        });

        BackgroundFetch.Result result = new BackgroundFetch(transport, pages, "https://r.example/", "t0k").run("T1");

        assertEquals(BackgroundFetch.Outcome.DONE, result.outcome);
        assertEquals("T3", result.syncToken);
        assertEquals(
            List.of(
                "GET /sync?limit=500&since=T1",
                "GET /sync?limit=500&since=T2",
                "POST /entries/contents {\"ids\":[1,3]}"
            ),
            asked
        );
        List<JSONObject> staged = pages.take("p1");
        assertEquals(3, staged.size());
        assertEquals("sync", staged.get(0).getString("kind"));
        assertEquals("T1", staged.get(0).getString("since"));
        assertEquals("T2", staged.get(1).getString("since"));
        assertEquals("contents", staged.get(2).getString("kind"));
        assertTrue(staged.get(2).isNull("since"));
        // Taken once.
        assertEquals(0, pages.take("p1").size());
    }

    @Test
    public void stopsWhenSignedOutAndRetriesWhenTheServerFails() throws Exception {
        StagedPages pages = new StagedPages(dir, StagedPages.MAX_BYTES, "p1");
        BackgroundFetch.Result out = new BackgroundFetch(
            server((request) -> new BackgroundFetch.Response(401, "")),
            pages,
            "https://r.example",
            "t0k"
        ).run("T1");
        assertEquals(BackgroundFetch.Outcome.SIGNED_OUT, out.outcome);
        assertEquals("T1", out.syncToken);

        BackgroundFetch.Result failed = new BackgroundFetch(
            server((request) -> new BackgroundFetch.Response(503, "")),
            pages,
            "https://r.example",
            "t0k"
        ).run("T1");
        assertEquals(BackgroundFetch.Outcome.RETRY, failed.outcome);
        assertEquals(0, pages.take("p1").size());
    }

    @Test
    public void stopsAtTheStagingCapAndCarriesOnFromThere() throws Exception {
        // Room for one page only.
        StagedPages pages = new StagedPages(dir, 120, "p1");
        BackgroundFetch.Transport transport = server((request) ->
            ok("{\"entries\":[],\"next\":\"" + (request.contains("since=T1") ? "T2" : "T3") + "\",\"more\":true}")
        );
        BackgroundFetch.Result result = new BackgroundFetch(transport, pages, "https://r.example", "t0k").run("T1");
        assertEquals(BackgroundFetch.Outcome.DONE, result.outcome);
        // The second page was not kept, so the next run asks for it again.
        assertEquals("T2", result.syncToken);
        assertEquals(1, pages.take("p1").size());
    }

    @Test
    public void handsPagesOnlyToTheProfileTheyWereFetchedFor() throws Exception {
        new StagedPages(dir, StagedPages.MAX_BYTES, "p1").add("sync", "T1", "{}");
        new StagedPages(dir, StagedPages.MAX_BYTES, "p2").add("sync", "T2", "{}");
        StagedPages taker = new StagedPages(dir, StagedPages.MAX_BYTES, null);

        List<JSONObject> taken = taker.take("p2");

        assertEquals(1, taken.size());
        assertEquals("T2", taken.get(0).getString("since"));
        assertTrue(taken.get(0).isNull("profile"));
        // The other profile's page is gone too: its store cannot take it after a switch.
        assertEquals(0, taker.take("p1").size());
    }

    @Test
    public void handsNothingToAnUnnamedProfile() throws Exception {
        new StagedPages(dir, StagedPages.MAX_BYTES, null).add("sync", "T1", "{}");
        assertEquals(0, new StagedPages(dir, StagedPages.MAX_BYTES, null).take(null).size());
    }
}
