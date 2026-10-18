CREATE TABLE "fetch_host_rules" (
	"host" text PRIMARY KEY NOT NULL,
	"min_interval_seconds" integer NOT NULL,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "fetch_interval_reason" text DEFAULT 'subscribers' NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "hint_seconds" integer;--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "slowdown_seconds" integer;--> statement-breakpoint
ALTER TABLE "feed_sources" ADD COLUMN "slowdown_ok_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "hide_from_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fetch_host_rules" ADD CONSTRAINT "fetch_host_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;