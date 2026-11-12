ALTER TABLE "feed_sources" DROP CONSTRAINT "feed_sources_url_unique";--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "auth_login" text;--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "auth_password" text;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_sources_url_key" ON "feed_sources" USING btree ("url") WHERE "feed_sources"."auth_login" IS NULL;