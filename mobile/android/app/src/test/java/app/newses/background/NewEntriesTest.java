package app.newses.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class NewEntriesTest {

    /** The store holds entries up to 100 and subscriptions up to 3: Tech (1, 2) and News (3). */
    private static NewEntries handedOver() throws Exception {
        NewEntries found = NewEntries.from(null);
        found.handOver(
            new JSONObject(
                "{\"entryMark\":100,\"subscriptionMark\":3," +
                "\"subscriptions\":[[1,10,\"Feed one\"],[2,10,\"Feed two\"],[3,null,\"News\"]]," +
                "\"categories\":[[10,\"Tech\"]]}"
            )
        );
        return found;
    }

    private static JSONObject page(String entries) throws Exception {
        return new JSONObject("{\"categories\":[],\"subscriptions\":[],\"entries\":[" + entries + "],\"next\":\"T\"}");
    }

    private static String entry(int id, int subscription, boolean unread) {
        return "{\"id\":" + id + ",\"subscriptionId\":" + subscription + ",\"unread\":" + unread + "}";
    }

    @Test
    public void countsUnreadEntriesAboveTheStoresMarkByPlace() throws Exception {
        NewEntries found = handedOver();
        found.read(page(String.join(",", entry(99, 1, true), entry(101, 1, true), entry(102, 3, true), entry(103, 2, true), entry(104, 1, false))));

        NewEntries.Summary summary = found.summary();

        // 99 was in the store already (starred elsewhere, say); 104 is read.
        assertEquals(3, summary.count);
        assertEquals(List.of("Tech", "News"), summary.places);
        assertEquals("/all", summary.target);
    }

    @Test
    public void opensTheOneFeedOrCategory() throws Exception {
        NewEntries feed = handedOver();
        feed.read(page(entry(101, 1, true)));
        assertEquals("/f1", feed.summary().target);

        NewEntries category = handedOver();
        category.read(page(entry(101, 1, true) + "," + entry(102, 2, true)));
        assertEquals("/c10", category.summary().target);

        NewEntries uncategorised = handedOver();
        uncategorised.read(page(entry(101, 3, true)));
        assertEquals("/f3", uncategorised.summary().target);
        assertEquals(List.of("News"), uncategorised.summary().places);
    }

    @Test
    public void leavesOutSubscriptionsAddedSince() throws Exception {
        NewEntries found = handedOver();
        found.read(
            new JSONObject(
                "{\"categories\":[],\"subscriptions\":[{\"id\":4,\"categoryId\":null,\"title\":\"Added\"}]," +
                "\"entries\":[" + entry(101, 4, true) + "," + entry(102, 1, true) + "],\"next\":\"T\"}"
            )
        );
        assertEquals(1, found.summary().count);

        // Once known, its later entries count.
        found.read(page(entry(103, 4, true)));
        assertEquals(2, found.summary().count);
        assertEquals(List.of("Added", "Tech"), found.summary().places);
    }

    @Test
    public void keepsARunningTotalAndDropsEntriesReadOrDeletedSince() throws Exception {
        NewEntries found = NewEntries.from(handedOver().toJson());
        found.read(page(entry(101, 1, true) + "," + entry(102, 1, true) + "," + entry(103, 3, true)));
        found = NewEntries.from(found.toJson());

        // Read on another device, then purged.
        found.read(page(entry(101, 1, false)));
        found.read(
            new JSONObject(
                "{\"entries\":[],\"deleted\":{\"categories\":[],\"subscriptions\":[3],\"labels\":[],\"entries\":[102]},\"next\":\"T\"}"
            )
        );

        assertNull(found.summary());
    }

    @Test
    public void startsAgainOnceTheReaderHasSeenTheApp() throws Exception {
        NewEntries found = handedOver();
        found.read(page(entry(101, 1, true)));
        found.shown(1);

        found.seen();

        assertNull(found.summary());
        assertEquals(0, found.shown());
        // A page read again before the app hands over its store counts nothing twice.
        found.read(page(entry(101, 1, true)));
        assertNull(found.summary());
    }

    @Test
    public void marksOnlyMoveForward() throws Exception {
        NewEntries found = handedOver();
        found.read(page(entry(150, 1, true)));
        found.seen();
        found.handOver(new JSONObject("{\"entryMark\":120,\"subscriptionMark\":0}"));

        found.read(page(entry(140, 1, true) + "," + entry(151, 1, true)));

        assertEquals(1, found.summary().count);
        // Places stay when a hand-over has none.
        assertEquals(List.of("Tech"), found.summary().places);
    }

    @Test
    public void followsRenamedCategories() throws Exception {
        NewEntries found = handedOver();
        found.read(
            new JSONObject(
                "{\"categories\":[{\"id\":10,\"title\":\"Technology\"}],\"subscriptions\":[]," +
                "\"entries\":[" + entry(101, 2, true) + "],\"next\":\"T\"}"
            )
        );
        assertEquals(List.of("Technology"), found.summary().places);
    }
}
