CREATE TYPE "public"."auth_token_purpose" AS ENUM('password_reset', 'email_verify', 'invite');--> statement-breakpoint
CREATE TYPE "public"."calendar_event_type" AS ENUM('site', 'course', 'user', 'due', 'session');--> statement-breakpoint
CREATE TYPE "public"."context_level" AS ENUM('system', 'category', 'course', 'activity', 'user');--> statement-breakpoint
CREATE TYPE "public"."permission" AS ENUM('allow', 'prevent', 'prohibit');--> statement-breakpoint
CREATE TYPE "public"."storage_provider" AS ENUM('local', 's3', 'minio', 'r2');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'pending');--> statement-breakpoint
CREATE TYPE "public"."activity_type" AS ENUM('page', 'url', 'file', 'assignment', 'quiz', 'forum', 'workshop', 'attendance', 'interactive', 'video', 'certificate');--> statement-breakpoint
CREATE TYPE "public"."completion_rule" AS ENUM('none', 'manual', 'view', 'submit', 'grade', 'pass');--> statement-breakpoint
CREATE TYPE "public"."completion_state" AS ENUM('incomplete', 'complete', 'complete_pass', 'complete_fail');--> statement-breakpoint
CREATE TYPE "public"."enrolment_method" AS ENUM('manual', 'self', 'payment', 'cohort');--> statement-breakpoint
CREATE TYPE "public"."enrolment_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('in_progress', 'finished', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."grade_method" AS ENUM('highest', 'average', 'first', 'last');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('multichoice', 'truefalse', 'shortanswer', 'numerical', 'essay', 'matching');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('draft', 'submitted', 'graded', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('present', 'late', 'excused', 'absent');--> statement-breakpoint
CREATE TYPE "public"."forum_type" AS ENUM('general', 'news', 'qanda', 'single');--> statement-breakpoint
CREATE TYPE "public"."workshop_phase" AS ENUM('setup', 'submission', 'assessment', 'evaluation', 'closed');--> statement-breakpoint
CREATE TYPE "public"."grade_aggregation" AS ENUM('mean', 'weighted_mean', 'sum', 'highest', 'lowest', 'median');--> statement-breakpoint
CREATE TYPE "public"."grade_item_type" AS ENUM('activity', 'manual', 'category', 'course');--> statement-breakpoint
CREATE TYPE "public"."interactive_kind" AS ENUM('h5p', 'embed');--> statement-breakpoint
CREATE TYPE "public"."video_provider" AS ENUM('jitsi', 'zoom', 'bigbluebutton', 'custom');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'paid', 'failed', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('stripe', 'razorpay');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "calendar_event_type" NOT NULL,
	"course_id" uuid,
	"user_id" uuid,
	"activity_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"idnumber" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"level" "context_level" NOT NULL,
	"instance_id" uuid,
	"parent_id" uuid,
	"path" text NOT NULL,
	"depth" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"user_id" uuid,
	"course_id" uuid,
	"activity_id" uuid,
	"related_user_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_id" uuid,
	"context_id" uuid,
	"component" text NOT NULL,
	"area" text NOT NULL,
	"item_id" uuid,
	"storage_key" text NOT NULL,
	"storage_provider" "storage_provider" NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "files_storageKey_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"custom_domain" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_customDomain_unique" UNIQUE("custom_domain")
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"permission" "permission" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"permission" "permission" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"shortname" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archetype" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"assignable_levels" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "storage_provider" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"endpoint" text,
	"region" text,
	"bucket" text NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_access_key_enc" text NOT NULL,
	"public_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"avatar_file_id" uuid,
	"bio" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"type" "activity_type" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"position" integer NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"available_from" timestamp with time zone,
	"available_until" timestamp with time zone,
	"completion_rule" "completion_rule" DEFAULT 'none' NOT NULL,
	"group_mode" text DEFAULT 'none' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "completion_state" DEFAULT 'incomplete' NOT NULL,
	"viewed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"overridden_by" uuid
);
--> statement-breakpoint
CREATE TABLE "content_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"content" text,
	"external_url" text,
	"file_id" uuid,
	CONSTRAINT "content_resources_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "course_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	"context_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"position" integer NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid,
	"context_id" uuid NOT NULL,
	"fullname" text NOT NULL,
	"shortname" text NOT NULL,
	"summary" text,
	"format" text DEFAULT 'topics' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"image_file_id" uuid,
	"enable_completion" boolean DEFAULT true NOT NULL,
	"self_enrol" text DEFAULT 'closed' NOT NULL,
	"enrolment_key_hash" text,
	"price_cents" integer,
	"currency" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrolments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "enrolment_method" NOT NULL,
	"status" "enrolment_status" DEFAULT 'active' NOT NULL,
	"cohort_id" uuid,
	"time_start" timestamp with time zone,
	"time_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"grader_id" uuid NOT NULL,
	"grade" numeric(10, 5),
	"feedback" text,
	"graded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_feedback_submissionId_unique" UNIQUE("submission_id")
);
--> statement-breakpoint
CREATE TABLE "assignment_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "submission_status" DEFAULT 'draft' NOT NULL,
	"text" text,
	"submitted_at" timestamp with time zone,
	"late" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"instructions" text,
	"allow_text" boolean DEFAULT true NOT NULL,
	"allow_files" boolean DEFAULT true NOT NULL,
	"max_files" integer DEFAULT 5 NOT NULL,
	"max_file_bytes" integer DEFAULT 20971520 NOT NULL,
	"accepted_types" text[] DEFAULT '{}' NOT NULL,
	"due_at" timestamp with time zone,
	"cutoff_at" timestamp with time zone,
	"allow_resubmit" boolean DEFAULT true NOT NULL,
	"grade_max" numeric(10, 5) DEFAULT 100 NOT NULL,
	"grade_pass" numeric(10, 5),
	"blind_marking" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignments_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "attempt_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"variant" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response" jsonb,
	"fraction" numeric(8, 7),
	"mark" numeric(10, 5),
	"max_mark" numeric(10, 5) NOT NULL,
	"needs_grading" boolean DEFAULT false NOT NULL,
	"comment" text,
	"graded_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"type" "question_type" NOT NULL,
	"name" text NOT NULL,
	"text" text NOT NULL,
	"default_mark" numeric(10, 5) DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"general_feedback" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" "attempt_status" DEFAULT 'in_progress' NOT NULL,
	"layout" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"sum_marks" numeric(10, 5),
	"grade" numeric(10, 5),
	"needs_grading" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"pinned_version" integer,
	"position" integer NOT NULL,
	"max_mark" numeric(10, 5) DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"intro" text,
	"open_at" timestamp with time zone,
	"close_at" timestamp with time zone,
	"time_limit_seconds" integer,
	"attempts_allowed" integer DEFAULT 0 NOT NULL,
	"grade_method" "grade_method" DEFAULT 'highest' NOT NULL,
	"grade_max" numeric(10, 5) DEFAULT 10 NOT NULL,
	"grade_pass" numeric(10, 5),
	"shuffle_questions" boolean DEFAULT false NOT NULL,
	"shuffle_answers" boolean DEFAULT true NOT NULL,
	"review_options" jsonb DEFAULT '{"marks":true,"correctness":true,"feedback":true,"rightAnswer":false}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quizzes_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "submission_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"file_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "attendance_status" NOT NULL,
	"remarks" text,
	"taken_by" uuid,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"attendance_id" uuid NOT NULL,
	"group_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"description" text,
	"self_mark_code_hash" text,
	"taken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"grade_max" numeric(10, 5) DEFAULT 100 NOT NULL,
	"status_points" jsonb DEFAULT '{"present":2,"late":1,"excused":1,"absent":0}'::jsonb NOT NULL,
	"allow_self_marking" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendances_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "forum_discussions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"forum_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid,
	"title" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"last_post_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forum_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"discussion_id" uuid NOT NULL,
	"parent_id" uuid,
	"user_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "forum_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"forum_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"type" "forum_type" DEFAULT 'general' NOT NULL,
	"intro" text,
	"subscription_mode" text DEFAULT 'optional' NOT NULL,
	"completion_posts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forums_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "workshop_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"scores" jsonb,
	"grade" numeric(10, 5),
	"grading_grade" numeric(10, 5),
	"feedback" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workshop_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workshop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"file_ids" uuid[] DEFAULT '{}' NOT NULL,
	"grade" numeric(10, 5),
	"grade_override" numeric(10, 5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workshops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"instructions" text,
	"assessment_instructions" text,
	"phase" "workshop_phase" DEFAULT 'setup' NOT NULL,
	"submission_end_at" timestamp with time zone,
	"assessment_end_at" timestamp with time zone,
	"submission_grade_max" numeric(10, 5) DEFAULT 80 NOT NULL,
	"assessment_grade_max" numeric(10, 5) DEFAULT 20 NOT NULL,
	"reviews_per_submission" integer DEFAULT 3 NOT NULL,
	"allow_self_assessment" boolean DEFAULT false NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workshops_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "grade_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"aggregation" "grade_aggregation" DEFAULT 'weighted_mean' NOT NULL,
	"drop_lowest" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_grade" numeric(10, 5),
	"final_grade" numeric(10, 5),
	"overridden" boolean DEFAULT false NOT NULL,
	"feedback" text,
	"graded_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"old_grade" numeric(10, 5),
	"new_grade" numeric(10, 5),
	"source" text NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"category_id" uuid,
	"type" "grade_item_type" NOT NULL,
	"activity_id" uuid,
	"name" text NOT NULL,
	"grade_max" numeric(10, 5) DEFAULT 100 NOT NULL,
	"grade_min" numeric(10, 5) DEFAULT 0 NOT NULL,
	"grade_pass" numeric(10, 5),
	"weight" numeric(10, 5) DEFAULT 1 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_items_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "badge_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"badge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"unique_hash" text NOT NULL,
	"issued_by" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "badge_issues_uniqueHash_unique" UNIQUE("unique_hash")
);
--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"course_id" uuid,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"image_file_id" uuid,
	"criteria" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_after_days" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificate_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"require_course_completion" boolean DEFAULT true NOT NULL,
	"min_grade_percent" integer,
	"auto_issue" boolean DEFAULT true NOT NULL,
	"expires_after_days" integer,
	CONSTRAINT "certificate_activities_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "certificate_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"orientation" text DEFAULT 'landscape' NOT NULL,
	"background_file_id" uuid,
	"elements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactive_contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"kind" "interactive_kind" NOT NULL,
	"package_file_id" uuid,
	"embed_url" text,
	"grade_max" numeric(10, 5) DEFAULT 100 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "interactive_contents_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "interactive_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"interactive_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_score" numeric,
	"max_score" numeric,
	"completed" boolean DEFAULT false NOT NULL,
	"statement" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issued_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"certificate_activity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"code" text NOT NULL,
	"file_id" uuid,
	"snapshot" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "issued_certificates_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "video_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"provider" "video_provider" DEFAULT 'jitsi' NOT NULL,
	"room_name" text,
	"join_url" text,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"recording_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_meetings_activityId_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_gateways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"public_key" text NOT NULL,
	"secret_key_enc" text NOT NULL,
	"webhook_secret_enc" text,
	"test_mode" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_payment_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_organizationId_unique" UNIQUE("organization_id"),
	CONSTRAINT "subscriptions_stripeSubscriptionId_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contexts" ADD CONSTRAINT "contexts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contexts" ADD CONSTRAINT "contexts_parent_id_contexts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_overrides" ADD CONSTRAINT "role_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_overrides" ADD CONSTRAINT "role_overrides_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_overrides" ADD CONSTRAINT "role_overrides_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_configs" ADD CONSTRAINT "storage_configs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_section_id_course_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."course_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_completions" ADD CONSTRAINT "activity_completions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_completions" ADD CONSTRAINT "activity_completions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_completions" ADD CONSTRAINT "activity_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_resources" ADD CONSTRAINT "content_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_resources" ADD CONSTRAINT "content_resources_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_resources" ADD CONSTRAINT "content_resources_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_parent_id_course_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."course_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_completions" ADD CONSTRAINT "course_completions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_completions" ADD CONSTRAINT "course_completions_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_completions" ADD CONSTRAINT "course_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_image_file_id_files_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_submission_id_assignment_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."assignment_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_grader_id_users_id_fk" FOREIGN KEY ("grader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attempt_id_quiz_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."quiz_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_slot_id_quiz_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."quiz_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_categories" ADD CONSTRAINT "question_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_categories" ADD CONSTRAINT "question_categories_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_categories" ADD CONSTRAINT "question_categories_parent_id_question_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."question_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_category_id_question_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."question_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_submission_id_assignment_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."assignment_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_attendance_id_attendances_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."attendances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_discussions" ADD CONSTRAINT "forum_discussions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_discussions" ADD CONSTRAINT "forum_discussions_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_discussions" ADD CONSTRAINT "forum_discussions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_discussions" ADD CONSTRAINT "forum_discussions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_discussion_id_forum_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."forum_discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_parent_id_forum_posts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."forum_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_subscriptions" ADD CONSTRAINT "forum_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_subscriptions" ADD CONSTRAINT "forum_subscriptions_forum_id_forums_id_fk" FOREIGN KEY ("forum_id") REFERENCES "public"."forums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_subscriptions" ADD CONSTRAINT "forum_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forums" ADD CONSTRAINT "forums_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forums" ADD CONSTRAINT "forums_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_assessments" ADD CONSTRAINT "workshop_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_assessments" ADD CONSTRAINT "workshop_assessments_submission_id_workshop_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."workshop_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_assessments" ADD CONSTRAINT "workshop_assessments_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD CONSTRAINT "workshop_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD CONSTRAINT "workshop_submissions_workshop_id_workshops_id_fk" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_submissions" ADD CONSTRAINT "workshop_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshops" ADD CONSTRAINT "workshops_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshops" ADD CONSTRAINT "workshops_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_categories" ADD CONSTRAINT "grade_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_categories" ADD CONSTRAINT "grade_categories_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_categories" ADD CONSTRAINT "grade_categories_parent_id_grade_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."grade_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_grades" ADD CONSTRAINT "grade_grades_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_grades" ADD CONSTRAINT "grade_grades_item_id_grade_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."grade_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_grades" ADD CONSTRAINT "grade_grades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_history" ADD CONSTRAINT "grade_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_category_id_grade_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."grade_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_issues" ADD CONSTRAINT "badge_issues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_issues" ADD CONSTRAINT "badge_issues_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_issues" ADD CONSTRAINT "badge_issues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badges" ADD CONSTRAINT "badges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badges" ADD CONSTRAINT "badges_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badges" ADD CONSTRAINT "badges_image_file_id_files_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_activities" ADD CONSTRAINT "certificate_activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_activities" ADD CONSTRAINT "certificate_activities_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_activities" ADD CONSTRAINT "certificate_activities_template_id_certificate_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."certificate_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_background_file_id_files_id_fk" FOREIGN KEY ("background_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_contents" ADD CONSTRAINT "interactive_contents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_contents" ADD CONSTRAINT "interactive_contents_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_contents" ADD CONSTRAINT "interactive_contents_package_file_id_files_id_fk" FOREIGN KEY ("package_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_results" ADD CONSTRAINT "interactive_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_results" ADD CONSTRAINT "interactive_results_interactive_id_interactive_contents_id_fk" FOREIGN KEY ("interactive_id") REFERENCES "public"."interactive_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_results" ADD CONSTRAINT "interactive_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD CONSTRAINT "issued_certificates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD CONSTRAINT "issued_certificates_certificate_activity_id_certificate_activities_id_fk" FOREIGN KEY ("certificate_activity_id") REFERENCES "public"."certificate_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD CONSTRAINT "issued_certificates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD CONSTRAINT "issued_certificates_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD CONSTRAINT "issued_certificates_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_attendance" ADD CONSTRAINT "video_attendance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_attendance" ADD CONSTRAINT "video_attendance_meeting_id_video_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."video_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_attendance" ADD CONSTRAINT "video_attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_meetings" ADD CONSTRAINT "video_meetings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_meetings" ADD CONSTRAINT "video_meetings_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "calendar_events_start_idx" ON "calendar_events" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cohort_members_uq" ON "cohort_members" USING btree ("cohort_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contexts_level_instance_uq" ON "contexts" USING btree ("organization_id","level","instance_id");--> statement-breakpoint
CREATE INDEX "contexts_path_idx" ON "contexts" USING btree ("path");--> statement-breakpoint
CREATE INDEX "event_log_course_idx" ON "event_log" USING btree ("course_id","created_at");--> statement-breakpoint
CREATE INDEX "event_log_user_idx" ON "event_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "files_item_idx" ON "files" USING btree ("component","area","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_prefs_uq" ON "notification_preferences" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_uq" ON "role_assignments" USING btree ("user_id","role_id","context_id");--> statement-breakpoint
CREATE INDEX "role_assignments_ctx_idx" ON "role_assignments" USING btree ("context_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_caps_uq" ON "role_capabilities" USING btree ("role_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "role_overrides_uq" ON "role_overrides" USING btree ("role_id","context_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_shortname_uq" ON "roles" USING btree ("organization_id","shortname");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_configs_org_uq" ON "storage_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_uq" ON "users" USING btree ("organization_id",lower("email"));--> statement-breakpoint
CREATE INDEX "activities_course_idx" ON "activities" USING btree ("course_id","section_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_completions_uq" ON "activity_completions" USING btree ("activity_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "course_completions_uq" ON "course_completions" USING btree ("course_id","user_id");--> statement-breakpoint
CREATE INDEX "course_sections_course_idx" ON "course_sections" USING btree ("course_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "courses_org_shortname_uq" ON "courses" USING btree ("organization_id","shortname");--> statement-breakpoint
CREATE UNIQUE INDEX "enrolments_course_user_uq" ON "enrolments" USING btree ("course_id","user_id");--> statement-breakpoint
CREATE INDEX "enrolments_user_idx" ON "enrolments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_uq" ON "group_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_submissions_uq" ON "assignment_submissions" USING btree ("assignment_id","user_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_answers_uq" ON "attempt_answers" USING btree ("attempt_id","slot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_uq" ON "question_versions" USING btree ("question_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_attempts_uq" ON "quiz_attempts" USING btree ("quiz_id","user_id","attempt");--> statement-breakpoint
CREATE INDEX "quiz_slots_quiz_idx" ON "quiz_slots" USING btree ("quiz_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_files_uq" ON "submission_files" USING btree ("submission_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_uq" ON "attendance_records" USING btree ("session_id","user_id");--> statement-breakpoint
CREATE INDEX "attendance_sessions_idx" ON "attendance_sessions" USING btree ("attendance_id","starts_at");--> statement-breakpoint
CREATE INDEX "forum_discussions_forum_idx" ON "forum_discussions" USING btree ("forum_id","last_post_at");--> statement-breakpoint
CREATE INDEX "forum_posts_discussion_idx" ON "forum_posts" USING btree ("discussion_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forum_subscriptions_uq" ON "forum_subscriptions" USING btree ("forum_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_assessments_uq" ON "workshop_assessments" USING btree ("submission_id","reviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_submissions_uq" ON "workshop_submissions" USING btree ("workshop_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grade_grades_uq" ON "grade_grades" USING btree ("item_id","user_id");--> statement-breakpoint
CREATE INDEX "grade_items_course_idx" ON "grade_items" USING btree ("course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "badge_issues_uq" ON "badge_issues" USING btree ("badge_id","user_id");--> statement-breakpoint
CREATE INDEX "interactive_results_idx" ON "interactive_results" USING btree ("interactive_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issued_certificates_uq" ON "issued_certificates" USING btree ("certificate_activity_id","user_id");--> statement-breakpoint
CREATE INDEX "video_attendance_idx" ON "video_attendance" USING btree ("meeting_id","user_id");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_provider_ref_uq" ON "orders" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_gateways_uq" ON "payment_gateways" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_uq" ON "webhook_events" USING btree ("provider","event_id");