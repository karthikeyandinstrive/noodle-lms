CREATE TABLE "lti_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"grade_item_id" uuid NOT NULL,
	"resource_id" text,
	"tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lti_line_items" ADD CONSTRAINT "lti_line_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_line_items" ADD CONSTRAINT "lti_line_items_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_line_items" ADD CONSTRAINT "lti_line_items_grade_item_id_grade_items_id_fk" FOREIGN KEY ("grade_item_id") REFERENCES "public"."grade_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lti_line_items_activity_idx" ON "lti_line_items" USING btree ("activity_id");