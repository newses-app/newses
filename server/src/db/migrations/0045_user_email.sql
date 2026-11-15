ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_token_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_token_hash_key" ON "users" USING btree ("email_token_hash");