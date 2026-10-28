ALTER TABLE "lti_launches" ADD COLUMN "message_type" text DEFAULT 'LtiResourceLinkRequest' NOT NULL;--> statement-breakpoint
ALTER TABLE "lti_launches" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lti_tools" ADD COLUMN "deep_linking_url" text;