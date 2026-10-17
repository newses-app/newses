package app.newses.background;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Responses the background job fetched, as files in app storage, in the order fetched, until the
 * web app takes them. Text only, and capped, so a long time closed cannot fill the device.
 */
final class StagedPages {

    /** The most kept at once; the job stops fetching past it, and the app fetches the rest. */
    static final long MAX_BYTES = 8L * 1024 * 1024;

    private static final Object LOCK = new Object();

    private final File dir;
    private final long maxBytes;

    StagedPages(File dir, long maxBytes) {
        this.dir = dir;
        this.maxBytes = maxBytes;
    }

    /** Keeps a page; false (and nothing kept) when it would pass the cap. */
    boolean add(String kind, String since, String body) throws IOException {
        synchronized (LOCK) {
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No staging directory");
            File[] files = sorted();
            long used = 0;
            for (File file : files) used += file.length();
            byte[] data;
            try {
                data = new JSONObject()
                    .put("kind", kind)
                    .put("since", since == null ? JSONObject.NULL : since)
                    .put("body", body)
                    .toString()
                    .getBytes(StandardCharsets.UTF_8);
            } catch (JSONException e) {
                throw new IOException(e);
            }
            if (used + data.length > maxBytes) return false;
            int next = files.length == 0 ? 1 : number(files[files.length - 1]) + 1;
            File tmp = new File(dir, String.format("page-%06d.tmp", next));
            try (OutputStream out = new FileOutputStream(tmp)) {
                out.write(data);
            }
            // Renamed once written, so a page is never taken half written.
            if (!tmp.renameTo(new File(dir, String.format("page-%06d.json", next)))) {
                throw new IOException("Could not keep a page");
            }
            return true;
        }
    }

    /** The pages kept, oldest first, removed as they are taken. */
    List<JSONObject> take() throws IOException {
        synchronized (LOCK) {
            List<JSONObject> pages = new ArrayList<>();
            for (File file : sorted()) {
                String text = read(file);
                try {
                    pages.add(new JSONObject(text));
                } catch (JSONException e) {
                    // A damaged page is dropped; the app fetches what it held again.
                }
                if (!file.delete()) throw new IOException("Could not remove a page");
            }
            return pages;
        }
    }

    void clear() {
        synchronized (LOCK) {
            File[] files = dir.listFiles();
            if (files == null) return;
            for (File file : files) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    private File[] sorted() {
        File[] files = dir.listFiles((d, name) -> name.startsWith("page-") && name.endsWith(".json"));
        if (files == null) return new File[0];
        Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
        return files;
    }

    private static String read(File file) throws IOException {
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static int number(File file) {
        String name = file.getName();
        return Integer.parseInt(name.substring("page-".length(), name.length() - ".json".length()));
    }
}
