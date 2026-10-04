ALTER TABLE "feed_sources" ADD COLUMN "ttl_seconds" integer;--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "blocked_until" timestamp with time zone;