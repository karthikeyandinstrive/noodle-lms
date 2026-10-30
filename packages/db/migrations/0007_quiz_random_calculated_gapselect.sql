ALTER TYPE "public"."question_type" ADD VALUE 'calculated';--> statement-breakpoint
ALTER TYPE "public"."question_type" ADD VALUE 'gapselect';--> statement-breakpoint
ALTER TABLE "quiz_slots" ALTER COLUMN "question_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD COLUMN "random_category_id" uuid;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD COLUMN "random_include_subcategories" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_random_category_id_question_categories_id_fk" FOREIGN KEY ("random_category_id") REFERENCES "public"."question_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_question_or_random" CHECK (("quiz_slots"."question_id" is not null) <> ("quiz_slots"."random_category_id" is not null));