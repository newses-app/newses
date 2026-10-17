-- Icons move to keys named by their content: re-checking every source stores them so, and
-- deletes the icons stored under source ids.
UPDATE "feed_sources" SET "favicon_checked_at" = NULL WHERE "favicon_key" IS NOT NULL;
