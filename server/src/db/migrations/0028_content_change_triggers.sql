-- A changed title, link, or content (re-ingest), or newly extracted full text, changes every
-- subscriber's user entry for sync. Row-level, as statement-level triggers cannot name columns;
-- the per-fetch last_seen_at update and failed extractions leave both columns as they were.
CREATE FUNCTION touch_subscriber_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE user_entries SET updated_at = now() WHERE entry_id = NEW.id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entries_touch_subscribers AFTER UPDATE OF content_hash, full_content ON entries FOR EACH ROW WHEN (OLD.content_hash IS DISTINCT FROM NEW.content_hash OR OLD.full_content IS DISTINCT FROM NEW.full_content) EXECUTE FUNCTION touch_subscriber_entries();
