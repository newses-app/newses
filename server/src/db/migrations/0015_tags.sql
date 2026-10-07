CREATE TABLE "entry_tags" (
	"user_entry_id" bigint NOT NULL,
	"user_id" integer NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "entry_tags_user_entry_id_tag_pk" PRIMARY KEY("user_entry_id","tag")
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "categories" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "entry_tags" ADD CONSTRAINT "entry_tags_user_entry_id_user_entries_id_fk" FOREIGN KEY ("user_entry_id") REFERENCES "public"."user_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_tags" ADD CONSTRAINT "entry_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_tags_user_tag_idx" ON "entry_tags" USING btree ("user_id","tag","user_entry_id");