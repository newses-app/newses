ALTER TYPE "public"."session_kind" ADD VALUE 'api';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "app_password_id" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_app_password_id_app_passwords_id_fk" FOREIGN KEY ("app_password_id") REFERENCES "public"."app_passwords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_app_password_idx" ON "sessions" USING btree ("app_password_id");