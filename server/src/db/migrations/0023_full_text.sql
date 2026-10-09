ALTER TABLE "entries" ADD COLUMN "full_content" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "full_content_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "full_content_error" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "full_text" boolean DEFAULT false NOT NULL;