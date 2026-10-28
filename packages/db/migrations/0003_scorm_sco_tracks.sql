CREATE TABLE "scorm_sco_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"sco_id" text NOT NULL,
	"cmi" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'not attempted' NOT NULL,
	"score_raw" numeric,
	"score_max" numeric,
	"total_time_seconds" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scorm_sco_tracks" ADD CONSTRAINT "scorm_sco_tracks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorm_sco_tracks" ADD CONSTRAINT "scorm_sco_tracks_attempt_id_scorm_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."scorm_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scorm_sco_tracks_uq" ON "scorm_sco_tracks" USING btree ("attempt_id","sco_id");