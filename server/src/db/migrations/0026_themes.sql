CREATE TABLE "themes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "themes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_id" integer NOT NULL,
	"name" text NOT NULL,
	"base" text NOT NULL,
	"tokens" jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "themes_owner_name_key" ON "themes" USING btree ("owner_id",lower("name"));--> statement-breakpoint
CREATE INDEX "themes_shared_idx" ON "themes" USING btree ("id") WHERE "themes"."shared";