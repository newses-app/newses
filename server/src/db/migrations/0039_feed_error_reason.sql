ALTER TABLE "feed_sources" ADD COLUMN "last_error_reason" text;--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "last_error_params" jsonb;