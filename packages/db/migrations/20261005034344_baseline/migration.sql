CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_delivery" (
	"id" text PRIMARY KEY,
	"provider_message_id" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"status" text NOT NULL,
	"status_rank" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_delivery_status_check" CHECK (("status", "status_rank") in (('sent', 1), ('delayed', 2), ('delivered', 3), ('failed', 4), ('bounced', 5), ('complained', 6)))
);
--> statement-breakpoint
CREATE TABLE "email_delivery_event" (
	"provider_event_id" text PRIMARY KEY,
	"provider_message_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_suppression" (
	"recipient_hash" text PRIMARY KEY,
	"reason" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppression_reason_check" CHECK ("reason" in ('bounce', 'complaint'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"seq" bigserial PRIMARY KEY,
	"txid" xid8 DEFAULT pg_current_xact_id() NOT NULL,
	"topic" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	CONSTRAINT "outbox_payload_is_object" CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "seed_versions" (
	"seed_name" text PRIMARY KEY,
	"version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"username" text,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_tombstone_scrubbed" CHECK ("deleted_at" is null or ("email" is null and "username" is null and "image" is null and "name" = '')),
	CONSTRAINT "users_version_positive" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_unique" ON "account" ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credential_id_unique" ON "passkey" ("credential_id");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_created_at_idx" ON "passkey" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" ("expires_at");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expires_at_idx" ON "verification" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_provider_message_unique" ON "email_delivery" ("provider_message_id");--> statement-breakpoint
CREATE INDEX "email_delivery_recipient_idx" ON "email_delivery" ("recipient_hash");--> statement-breakpoint
CREATE INDEX "email_delivery_updated_at_idx" ON "email_delivery" ("updated_at");--> statement-breakpoint
CREATE INDEX "email_delivery_event_received_idx" ON "email_delivery_event" ("received_at");--> statement-breakpoint
CREATE INDEX "email_delivery_event_provider_message_idx" ON "email_delivery_event" ("provider_message_id");--> statement-breakpoint
CREATE INDEX "outbox_txid_seq_idx" ON "outbox" ("txid","seq");--> statement-breakpoint
CREATE INDEX "outbox_topic_idx" ON "outbox" ("topic");--> statement-breakpoint
CREATE INDEX "outbox_created_at_idx" ON "outbox" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_unique" ON "users" (lower("username"));--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Everything below is written by hand and reviewed (ADR 0038): runtime
-- roles and their grants, none of which drizzle-kit generates. Roles are
-- cluster-wide and every local slot shares one cluster, so each is created
-- only if missing. No password is set: production provisions runtime
-- credentials out of band (docs/operations/database.md), and the migration
-- credential needs CREATEROLE.
--
-- offense_demo_web: the web application's runtime role. DML on every table and
-- use of every sequence (a bigserial default calls nextval()), nothing that
-- alters schema: no CREATE on public, no TRUNCATE, REFERENCES or TRIGGER,
-- and no access to the drizzle migrations schema. Default privileges extend
-- the same grants to tables and sequences later migrations create.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'offense_demo_web') THEN
    CREATE ROLE offense_demo_web LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO offense_demo_web;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO offense_demo_web;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO offense_demo_web;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO offense_demo_web;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO offense_demo_web;
--> statement-breakpoint
-- offense_demo_realtime: the realtime service's only credential (ADR 0032 §7).
-- SELECT on the outbox delivery log and on the identity columns of
-- `session` (never `token`, the bearer credential); `users` gets no grant,
-- since session.user_id carries no PII. Explicit grants only: default
-- privileges never reach it, so a new table stays invisible to realtime
-- until a migration grants it (a product's room-membership read model, for
-- one).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'offense_demo_realtime') THEN
    CREATE ROLE offense_demo_realtime LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO offense_demo_realtime;
--> statement-breakpoint
GRANT SELECT ON outbox TO offense_demo_realtime;
--> statement-breakpoint
GRANT SELECT (id, user_id, expires_at) ON session TO offense_demo_realtime;