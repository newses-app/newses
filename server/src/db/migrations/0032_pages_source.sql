-- Pages from outside any feed live in one hidden source: never fetched, subscribed to, or purged.
INSERT INTO "feed_sources" ("url", "title", "disabled_at") VALUES ('newses:pages', 'Web pages', now())
ON CONFLICT ("url") DO NOTHING;
--> statement-breakpoint
-- The importer kept articles that belong to no feed under a source for their site
-- (`https://host/`), where whoever subscribed to that address received them. Each holder's copy
-- moves to the pages source as their own entry. Sources of imported feeds are left alone.
CREATE TEMP TABLE "moved_pages" ON COMMIT DROP AS
SELECT ue."id" AS "user_entry_id", ue."user_id", ue."subscription_id", e."id" AS "entry_id",
  regexp_replace(e."link", '#.*$', '') AS "url",
  (ue."starred" OR ue."published" OR ue."note" IS NOT NULL OR ue."share_id" IS NOT NULL
    OR EXISTS (SELECT 1 FROM "entry_labels" el WHERE el."user_entry_id" = ue."id")) AS "kept",
  NULL::text AS "guid", NULL::bigint AS "new_entry_id"
FROM "user_entries" ue
JOIN "entries" e ON e."id" = ue."entry_id"
JOIN "feed_sources" fs ON fs."id" = e."feed_source_id"
WHERE e."guid" LIKE 'ttrss:%'
  AND fs."url" ~ '^https?://[^/?#@]+/$'
  AND lower(substring(e."link" FROM '^[a-zA-Z]+://[^/?#@]+')) || '/' = fs."url"
  AND EXISTS (SELECT 1 FROM "user_entries" o WHERE o."entry_id" = e."id" AND o."subscription_id" IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "import_map" m JOIN "subscriptions" s ON s."id" = m."target_id"
    WHERE m."source_table" = 'ttrss_feeds' AND s."feed_source_id" = fs."id");
--> statement-breakpoint
-- Copies others received by subscribing to the site's address go, unless they kept them.
DELETE FROM "user_entries" ue USING "moved_pages" m
WHERE ue."id" = m."user_entry_id" AND m."subscription_id" IS NOT NULL AND NOT m."kept";
--> statement-breakpoint
DELETE FROM "moved_pages" WHERE "subscription_id" IS NOT NULL AND NOT "kept";
--> statement-breakpoint
-- The GUID the app gives a user's page (`pageGuid`); a user's further copies of one link get
-- their own.
UPDATE "moved_pages" m SET "guid" = 'page:' || encode(sha256(convert_to(
    m."user_id"::text || E'\n' || m."url" || CASE WHEN r."n" = 1 THEN '' ELSE E'\n' || m."entry_id"::text END,
    'UTF8')), 'hex')
FROM (
  SELECT "user_entry_id", row_number() OVER (PARTITION BY "user_id", "url" ORDER BY "user_entry_id") AS "n"
  FROM "moved_pages") r
WHERE r."user_entry_id" = m."user_entry_id";
--> statement-breakpoint
INSERT INTO "entries" ("feed_source_id", "guid", "link", "title", "author", "content", "content_hash",
  "categories", "lang", "full_content", "full_content_at", "full_content_error", "published_at",
  "source_updated_at", "fetched_at")
SELECT p."id", m."guid", e."link", e."title", e."author", e."content", e."content_hash",
  e."categories", e."lang", e."full_content", e."full_content_at", e."full_content_error",
  e."published_at", e."source_updated_at", e."fetched_at"
FROM "moved_pages" m
JOIN "entries" e ON e."id" = m."entry_id"
CROSS JOIN (SELECT "id" FROM "feed_sources" WHERE "url" = 'newses:pages') p
ON CONFLICT ("feed_source_id", "guid") DO NOTHING;
--> statement-breakpoint
UPDATE "moved_pages" m SET "new_entry_id" = n."id"
FROM "entries" n JOIN "feed_sources" p ON p."id" = n."feed_source_id" AND p."url" = 'newses:pages'
WHERE n."guid" = m."guid";
--> statement-breakpoint
INSERT INTO "enclosures" ("entry_id", "url", "mime_type", "length", "width", "height", "duration_seconds")
SELECT m."new_entry_id", x."url", x."mime_type", x."length", x."width", x."height", x."duration_seconds"
FROM "moved_pages" m JOIN "enclosures" x ON x."entry_id" = m."entry_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Labels, tags, notes, and share links belong to the user entry, so they move with it.
UPDATE "user_entries" ue SET "entry_id" = m."new_entry_id", "subscription_id" = NULL
FROM "moved_pages" m
WHERE ue."id" = m."user_entry_id";
--> statement-breakpoint
-- Deleted here rather than by purge, which would archive them under the site's address.
DELETE FROM "entries" e
WHERE e."id" IN (SELECT "entry_id" FROM "moved_pages")
  AND NOT EXISTS (SELECT 1 FROM "user_entries" ue WHERE ue."entry_id" = e."id");
