-- Keeps sync_xid at the id of the transaction that last wrote a synced row, on every UPDATE,
-- including raw SQL and the triggers that touch user entries. Inserts get it from the default.
CREATE FUNCTION set_sync_xid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_xid = pg_current_xact_id();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER categories_set_sync_xid BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_sync_xid();
--> statement-breakpoint
CREATE TRIGGER feed_sources_set_sync_xid BEFORE UPDATE ON feed_sources FOR EACH ROW EXECUTE FUNCTION set_sync_xid();
--> statement-breakpoint
CREATE TRIGGER subscriptions_set_sync_xid BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_sync_xid();
--> statement-breakpoint
CREATE TRIGGER labels_set_sync_xid BEFORE UPDATE ON labels FOR EACH ROW EXECUTE FUNCTION set_sync_xid();
--> statement-breakpoint
CREATE TRIGGER user_entries_set_sync_xid BEFORE UPDATE ON user_entries FOR EACH ROW EXECUTE FUNCTION set_sync_xid();
--> statement-breakpoint
-- Native sync's watermark: every transaction of this database with a lower id has ended, so the
-- synced rows below it are final. It is the oldest transaction id still in progress here, else
-- the snapshot's xmax. The snapshot is taken before the activity is read, so a transaction that
-- gets an id in between is at or above xmax; other databases' transactions don't hold it back.
CREATE FUNCTION sync_watermark() RETURNS xid8 LANGUAGE plpgsql AS $$
DECLARE
  snapshot pg_snapshot := pg_current_snapshot();
BEGIN
  PERFORM pg_stat_clear_snapshot();
  RETURN coalesce(
    (SELECT min(x) FROM pg_snapshot_xip(snapshot) x
     WHERE x::xid IN (
       SELECT backend_xid FROM pg_stat_activity
       WHERE datname = current_database() AND backend_xid IS NOT NULL)),
    pg_snapshot_xmax(snapshot));
END;
$$;
