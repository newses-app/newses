ALTER TABLE "entries" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "entries_last_seen_idx" ON "entries" USING btree ("last_seen_at");