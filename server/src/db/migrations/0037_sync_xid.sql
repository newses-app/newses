DROP INDEX "labels_user_updated_idx";--> statement-breakpoint
DROP INDEX "tombstones_user_deleted_idx";--> statement-breakpoint
-- Existing rows get 0 (a constant default, so no table is rewritten); sync serves them to tokens
-- from before this migration by updated_at. New rows get the writing transaction's id.
ALTER TABLE "categories" ADD COLUMN "sync_xid" "xid8" DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "sync_xid" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "sync_xid" "xid8" DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_sources" ALTER COLUMN "sync_xid" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "sync_xid" "xid8" DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "sync_xid" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "sync_xid" "xid8" DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "sync_xid" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
ALTER TABLE "tombstones" ADD COLUMN "sync_xid" "xid8" DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "tombstones" ALTER COLUMN "sync_xid" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
ALTER TABLE "user_entries" ADD COLUMN "sync_xid" "xid8" DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_entries" ALTER COLUMN "sync_xid" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
CREATE INDEX "labels_user_sync_idx" ON "labels" USING btree ("user_id","sync_xid");--> statement-breakpoint
CREATE INDEX "tombstones_user_sync_idx" ON "tombstones" USING btree ("user_id","sync_xid");--> statement-breakpoint
CREATE INDEX "user_entries_user_sync_idx" ON "user_entries" USING btree ("user_id","sync_xid","id");
