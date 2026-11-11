package app.newses.background;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The unread entries the job found that are new to the app's store, as a running total until the
 * app opens: from each `/sync` page, entries above the store's highest id, outside subscriptions
 * added since; entries read or deleted later drop out again. Kept as JSON between runs.
 */
final class NewEntries {

    /** Entries remembered at most, so a long time closed stays small; the count stops there. */
    static final int MAX_PENDING = 5000;

    /** What one notification says. */
    static final class Summary {
        final int count;
        /** Categories (or uncategorised feeds) with new entries, most first. */
        final List<String> places;
        /** The stream a tap opens: one feed, else one category, else All. */
        final String target;

        Summary(int count, List<String> places, String target) {
            this.count = count;
            this.places = places;
            this.target = target;
        }
    }

    private long entryMark;
    private long subscriptionMark;
    /** Subscription id → [category id or null, title]. */
    private final JSONObject subscriptions;
    /** Category id → title. */
    private final JSONObject categories;
    /** Entry id → subscription id, in the order found. */
    private final JSONObject pending;
    /** The count last shown, so an unchanged total does not alert again. */
    private int shown;

    private NewEntries(JSONObject state) {
        entryMark = state.optLong("entryMark");
        subscriptionMark = state.optLong("subscriptionMark");
        subscriptions = objectOr(state.optJSONObject("subscriptions"));
        categories = objectOr(state.optJSONObject("categories"));
        pending = objectOr(state.optJSONObject("pending"));
        shown = state.optInt("shown");
    }

    /** The kept state; empty or unreadable text starts afresh. */
    static NewEntries from(String json) {
        try {
            return new NewEntries(json == null ? new JSONObject() : new JSONObject(json));
        } catch (JSONException e) {
            return new NewEntries(new JSONObject());
        }
    }

    /**
     * What the app handed over (`NewEntriesHandover`): the store's marks, which only move forward,
     * and where subscriptions are. The app is open, so nothing found so far is new to the reader.
     */
    void handOver(JSONObject handover) throws JSONException {
        entryMark = Math.max(entryMark, handover.optLong("entryMark"));
        subscriptionMark = Math.max(subscriptionMark, handover.optLong("subscriptionMark"));
        JSONArray subs = handover.optJSONArray("subscriptions");
        if (subs != null && subs.length() > 0) {
            clear(subscriptions);
            for (int i = 0; i < subs.length(); i++) {
                JSONArray sub = subs.getJSONArray(i);
                subscriptions.put(String.valueOf(sub.getLong(0)), place(sub.opt(1), sub.getString(2)));
            }
        }
        JSONArray cats = handover.optJSONArray("categories");
        if (cats != null && cats.length() > 0) {
            clear(categories);
            for (int i = 0; i < cats.length(); i++) {
                JSONArray cat = cats.getJSONArray(i);
                categories.put(String.valueOf(cat.getLong(0)), cat.getString(1));
            }
        }
        seen();
    }

    /** The reader has seen the app: the running total starts again. */
    void seen() {
        clear(pending);
        shown = 0;
    }

    /** One `/sync` page the job fetched. */
    void read(JSONObject page) throws JSONException {
        JSONArray cats = page.optJSONArray("categories");
        for (int i = 0; cats != null && i < cats.length(); i++) {
            JSONObject cat = cats.getJSONObject(i);
            categories.put(String.valueOf(cat.getLong("id")), cat.getString("title"));
        }
        Set<Long> added = new HashSet<>();
        long highestSubscription = subscriptionMark;
        JSONArray subs = page.optJSONArray("subscriptions");
        for (int i = 0; subs != null && i < subs.length(); i++) {
            JSONObject sub = subs.getJSONObject(i);
            long id = sub.getLong("id");
            if (id > subscriptionMark) added.add(id);
            highestSubscription = Math.max(highestSubscription, id);
            subscriptions.put(String.valueOf(id), place(sub.opt("categoryId"), sub.getString("title")));
        }
        JSONObject deleted = page.optJSONObject("deleted");
        if (deleted != null) {
            for (long id : longs(deleted.optJSONArray("categories"))) categories.remove(String.valueOf(id));
            Set<Long> gone = new HashSet<>(longs(deleted.optJSONArray("subscriptions")));
            for (long id : gone) subscriptions.remove(String.valueOf(id));
            for (long id : longs(deleted.optJSONArray("entries"))) pending.remove(String.valueOf(id));
            if (!gone.isEmpty()) {
                for (Iterator<String> keys = pending.keys(); keys.hasNext(); ) {
                    if (gone.contains(pending.getLong(keys.next()))) keys.remove();
                }
            }
        }
        long highestEntry = entryMark;
        JSONArray entries = page.optJSONArray("entries");
        for (int i = 0; entries != null && i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            long id = entry.getLong("id");
            highestEntry = Math.max(highestEntry, id);
            String key = String.valueOf(id);
            boolean unread = entry.optBoolean("unread");
            Object subscription = entry.opt("subscriptionId");
            boolean subscribed = subscription instanceof Number;
            if (pending.has(key)) {
                if (!unread || !subscribed) pending.remove(key);
            } else if (
                unread &&
                subscribed &&
                id > entryMark &&
                !added.contains(((Number) subscription).longValue()) &&
                pending.length() < MAX_PENDING
            ) {
                pending.put(key, ((Number) subscription).longValue());
            }
        }
        entryMark = highestEntry;
        subscriptionMark = highestSubscription;
    }

    /** What to show now; null when nothing new is unread. */
    Summary summary() throws JSONException {
        Map<String, Integer> places = new LinkedHashMap<>();
        Set<Long> feeds = new HashSet<>();
        Set<Long> groups = new HashSet<>();
        int count = 0;
        for (Iterator<String> keys = pending.keys(); keys.hasNext(); ) {
            long subscription = pending.getLong(keys.next());
            count++;
            feeds.add(subscription);
            JSONArray place = subscriptions.optJSONArray(String.valueOf(subscription));
            Long category = place == null || place.isNull(0) ? null : place.getLong(0);
            // `c0`: uncategorised.
            groups.add(category == null ? 0L : category);
            String title = place == null ? null : place.getString(1);
            if (category != null) title = categories.optString(String.valueOf(category), title);
            if (title != null) places.merge(title, 1, Integer::sum);
        }
        if (count == 0) return null;
        List<Map.Entry<String, Integer>> sorted = new ArrayList<>(places.entrySet());
        // Places with as many by name, as JSON keeps no order on every platform.
        sorted.sort((a, b) ->
            !a.getValue().equals(b.getValue()) ? b.getValue() - a.getValue() : a.getKey().compareTo(b.getKey())
        );
        List<String> names = new ArrayList<>();
        for (Map.Entry<String, Integer> place : sorted) names.add(place.getKey());
        String target = "/all";
        if (feeds.size() == 1) target = "/f" + feeds.iterator().next();
        else if (groups.size() == 1) target = "/c" + groups.iterator().next();
        return new Summary(count, names, target);
    }

    int shown() {
        return shown;
    }

    void shown(int count) {
        shown = count;
    }

    String toJson() throws JSONException {
        return new JSONObject()
            .put("entryMark", entryMark)
            .put("subscriptionMark", subscriptionMark)
            .put("subscriptions", subscriptions)
            .put("categories", categories)
            .put("pending", pending)
            .put("shown", shown)
            .toString();
    }

    private static JSONArray place(Object categoryId, String title) {
        JSONArray place = new JSONArray();
        place.put(categoryId instanceof Number ? categoryId : JSONObject.NULL);
        place.put(title);
        return place;
    }

    private static JSONObject objectOr(JSONObject object) {
        return object == null ? new JSONObject() : object;
    }

    private static void clear(JSONObject object) {
        for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
            keys.next();
            keys.remove();
        }
    }

    private static List<Long> longs(JSONArray array) throws JSONException {
        List<Long> values = new ArrayList<>();
        for (int i = 0; array != null && i < array.length(); i++) values.add(array.getLong(i));
        return values;
    }
}
