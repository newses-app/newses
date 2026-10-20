ALTER TABLE "users" ADD COLUMN "password_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "password_expires_at" = now() + interval '7 days' WHERE "password_change_required";
