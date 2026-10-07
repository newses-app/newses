-- Labels are synced: keep updated_at current and record deletions.
CREATE TRIGGER labels_set_updated_at BEFORE UPDATE ON labels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER labels_tombstones AFTER DELETE ON labels REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION record_tombstones('label');
--> statement-breakpoint
-- Assigning or removing a label (or tag) changes the user entry for sync, including removals by
-- cascade when a label is deleted. Statement-level, so bulk changes touch each entry once.
CREATE FUNCTION touch_user_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE user_entries SET updated_at = now()
  WHERE id IN (SELECT DISTINCT user_entry_id FROM changed_rows);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entry_labels_touch_insert AFTER INSERT ON entry_labels REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION touch_user_entries();
--> statement-breakpoint
CREATE TRIGGER entry_labels_touch_delete AFTER DELETE ON entry_labels REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION touch_user_entries();
