ALTER TABLE "fetch_hosts" ALTER COLUMN "blocked_until" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fetch_hosts" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "fetch_hosts" ADD COLUMN "leased_until" timestamp with time zone;