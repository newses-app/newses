-- User entries created in this transaction (fan-out, which copies feed categories as tags) are
-- new to sync anyway, so touching them again would only rewrite every new entry.
CREATE OR REPLACE FUNCTION touch_user_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE user_entries SET updated_at = now()
  WHERE id IN (SELECT DISTINCT user_entry_id FROM changed_rows) AND created_at <> now();
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entry_tags_touch_insert AFTER INSERT ON entry_tags REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION touch_user_entries();
--> statement-breakpoint
CREATE TRIGGER entry_tags_touch_delete AFTER DELETE ON entry_tags REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION touch_user_entries();
