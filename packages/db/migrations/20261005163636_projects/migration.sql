CREATE TABLE "projects" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_status_check" CHECK ("status" in ('active', 'archived')),
	CONSTRAINT "projects_version_positive" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE INDEX "projects_owner_user_id_idx" ON "projects" ("owner_user_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE;