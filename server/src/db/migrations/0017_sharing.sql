CREATE TABLE "access_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "access_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"purpose" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_keys_key_unique" UNIQUE("key"),
	CONSTRAINT "access_keys_user_purpose_key" UNIQUE("user_id","purpose")
);
--> statement-breakpoint
ALTER TABLE "user_entries" ADD COLUMN "share_id" uuid;--> statement-breakpoint
ALTER TABLE "access_keys" ADD CONSTRAINT "access_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_entries" ADD CONSTRAINT "user_entries_share_id_unique" UNIQUE("share_id");