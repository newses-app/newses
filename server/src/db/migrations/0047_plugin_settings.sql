CREATE TABLE "plugin_settings" (
	"plugin_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_hosts" text[] DEFAULT '{}' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_failure" text,
	"last_failure_at" timestamp with time zone,
	"disabled_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_storage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plugin_storage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plugin_id" text NOT NULL,
	"user_id" integer,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"size" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_storage_key" UNIQUE NULLS NOT DISTINCT("plugin_id","user_id","key")
);
--> statement-breakpoint
CREATE TABLE "plugin_user_settings" (
	"plugin_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_failure" text,
	"last_failure_at" timestamp with time zone,
	"disabled_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_user_settings_plugin_id_user_id_pk" PRIMARY KEY("plugin_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "plugin_storage" ADD CONSTRAINT "plugin_storage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_user_settings" ADD CONSTRAINT "plugin_user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_storage_user_idx" ON "plugin_storage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plugin_storage_expires_at_idx" ON "plugin_storage" USING btree ("expires_at") WHERE "plugin_storage"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "plugin_user_settings_user_idx" ON "plugin_user_settings" USING btree ("user_id");