CREATE TABLE "entry_labels" (
	"user_entry_id" bigint NOT NULL,
	"label_id" integer NOT NULL,
	CONSTRAINT "entry_labels_user_entry_id_label_id_pk" PRIMARY KEY("user_entry_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "labels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"caption" text NOT NULL,
	"fg_color" text NOT NULL,
	"bg_color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_labels" ADD CONSTRAINT "entry_labels_user_entry_id_user_entries_id_fk" FOREIGN KEY ("user_entry_id") REFERENCES "public"."user_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_labels" ADD CONSTRAINT "entry_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_labels_label_idx" ON "entry_labels" USING btree ("label_id","user_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_user_caption_key" ON "labels" USING btree ("user_id",lower("caption"));--> statement-breakpoint
CREATE INDEX "labels_user_updated_idx" ON "labels" USING btree ("user_id","updated_at");