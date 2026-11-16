CREATE TABLE "digest_state" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"watermark" bigint NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "digest_state" ADD CONSTRAINT "digest_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_state_next_due_at_idx" ON "digest_state" USING btree ("next_due_at");