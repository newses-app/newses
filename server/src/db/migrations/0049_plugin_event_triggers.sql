-- The plugins listening to an event hook for a user: on for the instance, implementing the hook,
-- and, with user scope, on for the user.
CREATE FUNCTION plugin_listeners(event text, for_user integer) RETURNS SETOF text LANGUAGE sql STABLE AS $$
  SELECT p.plugin_id FROM plugin_settings p
  WHERE p.enabled AND event = ANY(p.hooks)
    AND (
      NOT p.user_scope
      OR EXISTS (
        SELECT 1 FROM plugin_user_settings u
        WHERE u.plugin_id = p.plugin_id AND u.user_id = for_user AND u.enabled
      )
    )
$$;
--> statement-breakpoint
-- Whether any plugin listens to the hook at all, so statements on user entries skip the rest.
CREATE FUNCTION plugin_hook_listened(event text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM plugin_settings WHERE enabled AND event = ANY(hooks))
$$;
--> statement-breakpoint
-- Every change to a user's published feed, by whatever path, becomes a published.changed event
-- in the same transaction. Statement-level, so bulk changes cost one pass.
CREATE FUNCTION record_published_inserts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT plugin_hook_listened('published.changed') THEN RETURN NULL; END IF;
  INSERT INTO plugin_events (plugin_id, user_id, hook, user_entry_id, published)
  SELECT l.plugin_id, n.user_id, 'published.changed', n.id, true
  FROM new_rows n CROSS JOIN LATERAL plugin_listeners('published.changed', n.user_id) AS l(plugin_id)
  WHERE n.published;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION record_published_updates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT plugin_hook_listened('published.changed') THEN RETURN NULL; END IF;
  INSERT INTO plugin_events (plugin_id, user_id, hook, user_entry_id, published)
  SELECT l.plugin_id, n.user_id, 'published.changed', n.id, n.published
  FROM new_rows n
  JOIN old_rows o ON o.id = n.id
  CROSS JOIN LATERAL plugin_listeners('published.changed', n.user_id) AS l(plugin_id)
  WHERE n.published IS DISTINCT FROM o.published;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- A deleted published entry leaves the feed; not when its user is being deleted with it.
CREATE FUNCTION record_published_deletes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT plugin_hook_listened('published.changed') THEN RETURN NULL; END IF;
  INSERT INTO plugin_events (plugin_id, user_id, hook, user_entry_id, published)
  SELECT l.plugin_id, o.user_id, 'published.changed', o.id, false
  FROM old_rows o
  JOIN users u ON u.id = o.user_id
  CROSS JOIN LATERAL plugin_listeners('published.changed', o.user_id) AS l(plugin_id)
  WHERE o.published;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_entries_published_insert AFTER INSERT ON user_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION record_published_inserts();
--> statement-breakpoint
CREATE TRIGGER user_entries_published_update AFTER UPDATE ON user_entries REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION record_published_updates();
--> statement-breakpoint
CREATE TRIGGER user_entries_published_delete AFTER DELETE ON user_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION record_published_deletes();
