-- Records deletions of synced rows for incremental sync. Statement-level with a transition table,
-- so bulk deletes (purge, unsubscribe) insert tombstones in one statement. Rows of a user being
-- deleted get none: the user is already gone and their tombstones would cascade away anyway.
CREATE FUNCTION record_tombstones() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tombstones (user_id, entity, entity_id)
  SELECT o.user_id, TG_ARGV[0], o.id FROM old_rows o
  WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = o.user_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER categories_tombstones AFTER DELETE ON categories REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION record_tombstones('category');
--> statement-breakpoint
CREATE TRIGGER subscriptions_tombstones AFTER DELETE ON subscriptions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION record_tombstones('subscription');
--> statement-breakpoint
CREATE TRIGGER user_entries_tombstones AFTER DELETE ON user_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION record_tombstones('entry');
