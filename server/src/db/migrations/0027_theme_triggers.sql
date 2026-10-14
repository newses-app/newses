-- Keep updated_at current; themes are not synced, so deletions leave no tombstones.
CREATE TRIGGER themes_set_updated_at BEFORE UPDATE ON themes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
