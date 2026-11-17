CREATE TABLE "plugin_deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plugin_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plugin_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"hook" text NOT NULL,
	"events" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plugin_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plugin_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"hook" text NOT NULL,
	"user_entry_id" bigint NOT NULL,
	"published" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_settings" ADD COLUMN "hooks" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_settings" ADD COLUMN "user_scope" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_deliveries" ADD CONSTRAINT "plugin_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_events" ADD CONSTRAINT "plugin_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_deliveries_due_at_idx" ON "plugin_deliveries" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "plugin_deliveries_user_idx" ON "plugin_deliveries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plugin_events_group_idx" ON "plugin_events" USING btree ("plugin_id","user_id","hook","id");--> statement-breakpoint
CREATE INDEX "plugin_events_user_idx" ON "plugin_events" USING btree ("user_id");