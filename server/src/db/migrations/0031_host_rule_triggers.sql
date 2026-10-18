-- Keep updated_at current; host rules are not synced, so deletions leave no tombstones.
CREATE TRIGGER fetch_host_rules_set_updated_at BEFORE UPDATE ON fetch_host_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
