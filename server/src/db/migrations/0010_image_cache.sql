CREATE TABLE "image_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"failed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "image_cache_fetched_at_idx" ON "image_cache" USING btree ("fetched_at");