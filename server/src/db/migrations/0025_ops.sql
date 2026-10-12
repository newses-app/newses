CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"user_id" integer,
	"actor_user_id" integer,
	"ip" text,
	"user_agent" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_fetch_stats_hourly" (
	"hour" timestamp with time zone NOT NULL,
	"host" text NOT NULL,
	"purpose" text NOT NULL,
	"outcome" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "host_fetch_stats_hourly_hour_host_purpose_outcome_pk" PRIMARY KEY("hour","host","purpose","outcome")
);
--> statement-breakpoint
CREATE TABLE "job_stats_hourly" (
	"hour" timestamp with time zone NOT NULL,
	"job" text NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	"max_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "job_stats_hourly_hour_job_pk" PRIMARY KEY("hour","job")
);
--> statement-breakpoint
CREATE TABLE "ops_alerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ops_alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"rule" text NOT NULL,
	"subject" text NOT NULL,
	"severity" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_stats_hourly" (
	"hour" timestamp with time zone NOT NULL,
	"client" text NOT NULL,
	"status_class" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"slow" integer DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	"max_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "request_stats_hourly_hour_client_status_class_pk" PRIMARY KEY("hour","client","status_class")
);
--> statement-breakpoint
CREATE TABLE "user_activity_daily" (
	"user_id" integer NOT NULL,
	"day" date NOT NULL,
	"client" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_activity_daily_user_id_day_client_pk" PRIMARY KEY("user_id","day","client")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_daily" ADD CONSTRAINT "user_activity_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_user_idx" ON "audit_events" USING btree ("user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "host_fetch_stats_hourly_host_idx" ON "host_fetch_stats_hourly" USING btree ("host","hour");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_open_key" ON "ops_alerts" USING btree ("rule","subject") WHERE "ops_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ops_alerts_opened_at_idx" ON "ops_alerts" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "user_activity_daily_day_idx" ON "user_activity_daily" USING btree ("day");