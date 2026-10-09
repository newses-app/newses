CREATE TABLE "import_map" (
	"source_table" text NOT NULL,
	"source_id" bigint NOT NULL,
	"target_id" bigint NOT NULL,
	"user_id" integer,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_map_source_table_source_id_pk" PRIMARY KEY("source_table","source_id")
);
--> statement-breakpoint
ALTER TABLE "import_map" ADD CONSTRAINT "import_map_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_map_user_idx" ON "import_map" USING btree ("user_id");