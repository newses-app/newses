CREATE TABLE "entry_image_sets" (
	"entry_id" bigint PRIMARY KEY NOT NULL,
	"version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_images" (
	"entry_id" bigint NOT NULL,
	"key" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "entry_images_entry_id_key_pk" PRIMARY KEY("entry_id","key")
);
--> statement-breakpoint
ALTER TABLE "image_cache" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "entry_image_sets" ADD CONSTRAINT "entry_image_sets_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_images" ADD CONSTRAINT "entry_images_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_images_key_idx" ON "entry_images" USING btree ("key");--> statement-breakpoint
CREATE INDEX "user_entries_kept_entry_idx" ON "user_entries" USING btree ("entry_id") WHERE "user_entries"."starred" OR "user_entries"."published" OR "user_entries"."note" IS NOT NULL OR "user_entries"."share_id" IS NOT NULL;