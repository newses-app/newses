package app.newses.background;

import java.text.NumberFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.LongFunction;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A new-entries notification's title and text from the messages the app handed over
 * (`NotificationStrings`), as the desktop words it: "12 new entries", then up to three places, and
 * how many more.
 */
final class NotificationText {

    /** Places named before "and N more". */
    static final int PLACES = 3;

    final String title;
    final String body;

    private NotificationText(String title, String body) {
        this.title = title;
        this.body = body;
    }

    /** `plural` gives a count's CLDR plural category in the strings' language. */
    static NotificationText of(JSONObject strings, NewEntries.Summary summary, LongFunction<String> plural) {
        Locale locale = Locale.forLanguageTag(strings.optString("locale", "en"));
        NumberFormat numbers = NumberFormat.getIntegerInstance(locale);
        JSONObject titles = strings.optJSONObject("title");
        String category = plural.apply(summary.count);
        String title = titles == null ? "{n}" : titles.optString(category, titles.optString("other", "{n}"));

        List<String> places = summary.places;
        int named = Math.min(places.size(), PLACES);
        String list = "";
        JSONArray lists = strings.optJSONArray("lists");
        if (named > 0 && lists != null && lists.length() >= named) {
            Map<String, String> values = new HashMap<>();
            for (int i = 0; i < named; i++) values.put(String.valueOf(i), places.get(i));
            list = fill(lists.optString(named - 1), values);
        }
        String body = list;
        int more = places.size() - named;
        if (more > 0) {
            Map<String, String> values = new HashMap<>();
            values.put("places", list);
            values.put("n", numbers.format(more));
            body = fill(strings.optString("more", "{places}"), values);
        }
        Map<String, String> count = new HashMap<>();
        count.put("n", numbers.format(summary.count));
        return new NotificationText(fill(title, count), body);
    }

    /**
     * Replaces `{name}` placeholders in one pass, so text put in (a feed's title) is never read as
     * one; unknown ones stay as they are.
     */
    static String fill(String template, Map<String, String> values) {
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < template.length()) {
            int open = template.indexOf('{', i);
            int close = open < 0 ? -1 : template.indexOf('}', open);
            if (close < 0) {
                out.append(template, i, template.length());
                break;
            }
            String value = values.get(template.substring(open + 1, close));
            out.append(template, i, open).append(value == null ? template.substring(open, close + 1) : value);
            i = close + 1;
        }
        return out.toString();
    }
}
