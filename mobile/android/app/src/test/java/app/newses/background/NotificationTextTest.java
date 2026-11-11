package app.newses.background;

import static org.junit.Assert.assertEquals;

import java.util.List;
import java.util.Map;
import org.json.JSONObject;
import org.junit.Test;

public class NotificationTextTest {

    private static final JSONObject EN = json(
        "{\"locale\":\"en\",\"title\":{\"one\":\"{n} new entry\",\"other\":\"{n} new entries\"}," +
        "\"lists\":[\"{0}\",\"{0}, {1}\",\"{0}, {1}, {2}\"],\"more\":\"{places} and {n} more\",\"channel\":\"New entries\"}"
    );

    private static JSONObject json(String text) {
        try {
            return new JSONObject(text);
        } catch (Exception e) {
            throw new IllegalArgumentException(e);
        }
    }

    private static String english(long n) {
        return n == 1 ? "one" : "other";
    }

    @Test
    public void wordsTheCountAndUpToThreePlaces() {
        NotificationText one = NotificationText.of(
            EN,
            new NewEntries.Summary(1, List.of("Tech"), "/f1"),
            NotificationTextTest::english
        );
        assertEquals("1 new entry", one.title);
        assertEquals("Tech", one.body);

        NotificationText many = NotificationText.of(
            EN,
            new NewEntries.Summary(1234, List.of("Tech", "News", "Sport", "Music", "Art"), "/all"),
            NotificationTextTest::english
        );
        assertEquals("1,234 new entries", many.title);
        assertEquals("Tech, News, Sport and 2 more", many.body);
    }

    @Test
    public void usesTheLanguagesNumbersAndOtherForAMissingForm() {
        JSONObject de = json("{\"locale\":\"de\",\"title\":{\"other\":\"{n} neue Artikel\"},\"lists\":[\"{0}\"],\"more\":\"{places} und {n} weitere\"}");
        NotificationText text = NotificationText.of(de, new NewEntries.Summary(1500, List.of("Technik"), "/f1"), (n) -> "one");
        assertEquals("1.500 neue Artikel", text.title);
    }

    @Test
    public void neverReadsPlaceholdersInTitles() {
        assertEquals("{1} and {n}", NotificationText.fill("{0} and {n}", Map.of("0", "{1}")));
        assertEquals("a {open", NotificationText.fill("a {open", Map.of()));
    }
}
