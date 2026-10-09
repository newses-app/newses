CREATE TABLE "filter_actions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "filter_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"filter_id" integer NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"label_id" integer,
	"tag" text,
	"score" integer
);
--> statement-breakpoint
CREATE TABLE "filter_rules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "filter_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"filter_id" integer NOT NULL,
	"position" integer NOT NULL,
	"field" text NOT NULL,
	"pattern" text NOT NULL,
	"inverse" boolean DEFAULT false NOT NULL,
	"subscription_ids" integer[] DEFAULT '{}' NOT NULL,
	"category_ids" integer[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filters" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "filters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match_any" boolean DEFAULT false NOT NULL,
	"inverse" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "filter_actions" ADD CONSTRAINT "filter_actions_filter_id_filters_id_fk" FOREIGN KEY ("filter_id") REFERENCES "public"."filters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_actions" ADD CONSTRAINT "filter_actions_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_rules" ADD CONSTRAINT "filter_rules_filter_id_filters_id_fk" FOREIGN KEY ("filter_id") REFERENCES "public"."filters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filters" ADD CONSTRAINT "filters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "filter_actions_filter_idx" ON "filter_actions" USING btree ("filter_id","position");--> statement-breakpoint
CREATE INDEX "filter_rules_filter_idx" ON "filter_rules" USING btree ("filter_id","position");--> statement-breakpoint
CREATE INDEX "filters_user_idx" ON "filters" USING btree ("user_id","sort_order");