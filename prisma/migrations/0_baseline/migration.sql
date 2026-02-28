-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "alert_framework_alerttemplate" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "text" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "shock_type_id" BIGINT,
    "detector_type" VARCHAR(255) NOT NULL,
    "footer" VARCHAR(500) NOT NULL,

    CONSTRAINT "alert_framework_alerttemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_framework_detection" (
    "id" BIGSERIAL NOT NULL,
    "detection_timestamp" TIMESTAMPTZ(6) NOT NULL,
    "confidence_score" DOUBLE PRECISION,
    "detection_data" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "processed_at" TIMESTAMPTZ(6),
    "alert_id" BIGINT,
    "duplicate_of_id" BIGINT,
    "shock_type_id" BIGINT,
    "detector_id" BIGINT NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "source_variabledata_id" BIGINT,

    CONSTRAINT "alert_framework_detection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_framework_detection_locations" (
    "id" BIGSERIAL NOT NULL,
    "detection_id" BIGINT NOT NULL,
    "location_id" BIGINT NOT NULL,

    CONSTRAINT "alert_framework_detection_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_framework_detector" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "class_name" VARCHAR(255) NOT NULL,
    "active" BOOLEAN NOT NULL,
    "configuration" JSONB NOT NULL,
    "last_run" TIMESTAMPTZ(6),
    "run_count" INTEGER NOT NULL,
    "detection_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "schedule_id" INTEGER,

    CONSTRAINT "alert_framework_detector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_framework_publishedalert" (
    "id" BIGSERIAL NOT NULL,
    "api_name" VARCHAR(100) NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "language" VARCHAR(10) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "last_updated" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_reason" TEXT NOT NULL,
    "publication_metadata" JSONB NOT NULL,
    "error_message" TEXT NOT NULL,
    "retry_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "detection_id" BIGINT NOT NULL,
    "template_id" BIGINT NOT NULL,

    CONSTRAINT "alert_framework_publishedalert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_alert" (
    "id" BIGSERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "title_en" VARCHAR(255),
    "title_ar" VARCHAR(255),
    "text" TEXT NOT NULL,
    "text_en" TEXT,
    "text_ar" TEXT,
    "shock_date" DATE NOT NULL,
    "go_no_go" BOOLEAN NOT NULL,
    "go_no_go_date" TIMESTAMPTZ(6),
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6) NOT NULL,
    "severity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "data_source_id" BIGINT NOT NULL,
    "shock_type_id" BIGINT NOT NULL,
    "event_descriptions" JSONB NOT NULL,
    "source_detection_id" BIGINT,
    "source_variabledata_id" BIGINT,

    CONSTRAINT "alerts_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_alert_locations" (
    "id" BIGSERIAL NOT NULL,
    "alert_id" BIGINT NOT NULL,
    "location_id" BIGINT NOT NULL,

    CONSTRAINT "alerts_alert_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_alertembedding" (
    "id" BIGSERIAL NOT NULL,
    "embedding" JSONB NOT NULL,
    "similarity_text" TEXT NOT NULL,
    "model_name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "alert_id" BIGINT NOT NULL,

    CONSTRAINT "alerts_alertembedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_alertsimilarity" (
    "id" BIGSERIAL NOT NULL,
    "semantic_score" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "alert_a_id" BIGINT NOT NULL,
    "alert_b_id" BIGINT NOT NULL,

    CONSTRAINT "alerts_alertsimilarity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_emailtemplate" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" TEXT NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "subject_en" VARCHAR(255),
    "subject_ar" VARCHAR(255),
    "html_header" TEXT NOT NULL,
    "html_header_en" TEXT,
    "html_header_ar" TEXT,
    "html_footer" TEXT NOT NULL,
    "html_footer_en" TEXT,
    "html_footer_ar" TEXT,
    "html_wrapper" TEXT NOT NULL,
    "html_wrapper_en" TEXT,
    "html_wrapper_ar" TEXT,
    "text_header" TEXT NOT NULL,
    "text_header_en" TEXT,
    "text_header_ar" TEXT,
    "text_footer" TEXT NOT NULL,
    "text_footer_en" TEXT,
    "text_footer_ar" TEXT,
    "text_wrapper" TEXT NOT NULL,
    "text_wrapper_en" TEXT,
    "text_wrapper_ar" TEXT,
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alerts_emailtemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_shocktype" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_en" VARCHAR(100),
    "name_ar" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "color" VARCHAR(7) NOT NULL,
    "css_class" VARCHAR(50) NOT NULL,
    "icon" VARCHAR(10) NOT NULL,

    CONSTRAINT "alerts_shocktype_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_subscription" (
    "id" BIGSERIAL NOT NULL,
    "active" BOOLEAN NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "frequency" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "alerts_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_subscription_locations" (
    "id" BIGSERIAL NOT NULL,
    "subscription_id" BIGINT NOT NULL,
    "location_id" BIGINT NOT NULL,

    CONSTRAINT "alerts_subscription_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_subscription_shock_types" (
    "id" BIGSERIAL NOT NULL,
    "subscription_id" BIGINT NOT NULL,
    "shocktype_id" BIGINT NOT NULL,

    CONSTRAINT "alerts_subscription_shock_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts_useralert" (
    "id" BIGSERIAL NOT NULL,
    "received_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "flag_false" BOOLEAN NOT NULL,
    "flag_incomplete" BOOLEAN NOT NULL,
    "comment" TEXT NOT NULL,
    "bookmarked" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "alert_id" BIGINT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "rating_accuracy" INTEGER,
    "rating_accuracy_at" TIMESTAMPTZ(6),
    "rating_relevance" INTEGER,
    "rating_relevance_at" TIMESTAMPTZ(6),
    "rating_timeliness" INTEGER,
    "rating_timeliness_at" TIMESTAMPTZ(6),

    CONSTRAINT "alerts_useralert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_group" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(150) NOT NULL,

    CONSTRAINT "auth_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_group_permissions" (
    "id" BIGSERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,

    CONSTRAINT "auth_group_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_permission" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "content_type_id" INTEGER NOT NULL,
    "codename" VARCHAR(100) NOT NULL,

    CONSTRAINT "auth_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_user" (
    "id" SERIAL NOT NULL,
    "password" VARCHAR(128) NOT NULL,
    "last_login" TIMESTAMPTZ(6),
    "is_superuser" BOOLEAN NOT NULL,
    "username" VARCHAR(150) NOT NULL,
    "first_name" VARCHAR(150) NOT NULL,
    "last_name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "is_staff" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "date_joined" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_user_groups" (
    "id" BIGSERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "group_id" INTEGER NOT NULL,

    CONSTRAINT "auth_user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_user_user_permissions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,

    CONSTRAINT "auth_user_user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_colormap" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "named_colormap" VARCHAR(50),
    "color_start" VARCHAR(7),
    "color_end" VARCHAR(7),
    "is_active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "colorbar_image" VARCHAR(100),

    CONSTRAINT "dashboard_colormap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_layer" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "layer_type" VARCHAR(20) NOT NULL,
    "url" VARCHAR(500),
    "wms_layers" VARCHAR(255),
    "vector_style" JSONB,
    "opacity" DOUBLE PRECISION NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "cog_colormap_id" BIGINT,
    "retrieval_date" DATE,
    "source" VARCHAR(255) NOT NULL,

    CONSTRAINT "dashboard_layer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_theme" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "icon" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "is_combined" BOOLEAN NOT NULL,
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "colormap_id" BIGINT NOT NULL,

    CONSTRAINT "dashboard_theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_theme_shock_types" (
    "id" BIGSERIAL NOT NULL,
    "theme_id" BIGINT NOT NULL,
    "shocktype_id" BIGINT NOT NULL,

    CONSTRAINT "dashboard_theme_shock_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_themelayer" (
    "id" BIGSERIAL NOT NULL,
    "order" INTEGER NOT NULL,
    "is_visible_by_default" BOOLEAN NOT NULL,
    "min_value" DOUBLE PRECISION,
    "max_value" DOUBLE PRECISION,
    "layer_id" BIGINT NOT NULL,
    "theme_id" BIGINT NOT NULL,

    CONSTRAINT "dashboard_themelayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_themevariable" (
    "id" BIGSERIAL NOT NULL,
    "order" INTEGER NOT NULL,
    "min_value" DOUBLE PRECISION,
    "max_value" DOUBLE PRECISION,
    "opacity" DOUBLE PRECISION NOT NULL,
    "theme_id" BIGINT NOT NULL,
    "variable_id" BIGINT NOT NULL,

    CONSTRAINT "dashboard_themevariable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_pipeline_source" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "name_en" VARCHAR(255),
    "name_ar" VARCHAR(255),
    "description" TEXT NOT NULL,
    "description_en" TEXT,
    "description_ar" TEXT,
    "type" VARCHAR(20) NOT NULL,
    "info_url" VARCHAR(200) NOT NULL,
    "base_url" VARCHAR(200) NOT NULL,
    "class_name" VARCHAR(255) NOT NULL,
    "comment" TEXT NOT NULL,
    "comment_en" TEXT,
    "comment_ar" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL,
    "data_frequency" VARCHAR(20) NOT NULL,

    CONSTRAINT "data_pipeline_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_pipeline_sourceauthtoken" (
    "id" BIGSERIAL NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "token_type" VARCHAR(50) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "refresh_expires_at" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "source_id" BIGINT NOT NULL,

    CONSTRAINT "data_pipeline_sourceauthtoken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_pipeline_taskstatistics" (
    "id" BIGSERIAL NOT NULL,
    "date" DATE NOT NULL,
    "check_updates_count" INTEGER NOT NULL,
    "download_data_count" INTEGER NOT NULL,
    "process_data_count" INTEGER NOT NULL,
    "full_pipeline_count" INTEGER NOT NULL,
    "reprocess_data_count" INTEGER NOT NULL,
    "success_count" INTEGER NOT NULL,
    "failure_count" INTEGER NOT NULL,
    "retry_count" INTEGER NOT NULL,
    "avg_duration_seconds" DOUBLE PRECISION,
    "max_duration_seconds" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "data_pipeline_taskstatistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_pipeline_variable" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "name_en" VARCHAR(255),
    "name_ar" VARCHAR(255),
    "code" VARCHAR(100) NOT NULL,
    "period" VARCHAR(20) NOT NULL,
    "adm_level" INTEGER NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "text" TEXT NOT NULL,
    "text_en" TEXT,
    "text_ar" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "source_id" BIGINT NOT NULL,
    "unit" VARCHAR(50) NOT NULL,
    "retrieval_date" DATE,

    CONSTRAINT "data_pipeline_variable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_pipeline_variabledata" (
    "id" BIGSERIAL NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "period" VARCHAR(20) NOT NULL,
    "value" DOUBLE PRECISION,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "adm_level_id" BIGINT NOT NULL,
    "gid_id" BIGINT,
    "variable_id" BIGINT NOT NULL,
    "original_location_text" TEXT NOT NULL,
    "parent_id" BIGINT,
    "unmatched_location_id" BIGINT,
    "raw_data" JSONB,
    "source_record_id" VARCHAR(255),

    CONSTRAINT "data_pipeline_variabledata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_admin_log" (
    "id" SERIAL NOT NULL,
    "action_time" TIMESTAMPTZ(6) NOT NULL,
    "object_id" TEXT,
    "object_repr" VARCHAR(200) NOT NULL,
    "action_flag" SMALLINT NOT NULL,
    "change_message" TEXT NOT NULL,
    "content_type_id" INTEGER,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "django_admin_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_celery_beat_clockedschedule" (
    "id" SERIAL NOT NULL,
    "clocked_time" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "django_celery_beat_clockedschedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_celery_beat_crontabschedule" (
    "id" SERIAL NOT NULL,
    "minute" VARCHAR(240) NOT NULL,
    "hour" VARCHAR(96) NOT NULL,
    "day_of_week" VARCHAR(64) NOT NULL,
    "day_of_month" VARCHAR(124) NOT NULL,
    "month_of_year" VARCHAR(64) NOT NULL,
    "timezone" VARCHAR(63) NOT NULL,

    CONSTRAINT "django_celery_beat_crontabschedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_celery_beat_intervalschedule" (
    "id" SERIAL NOT NULL,
    "every" INTEGER NOT NULL,
    "period" VARCHAR(24) NOT NULL,

    CONSTRAINT "django_celery_beat_intervalschedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_celery_beat_periodictask" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "task" VARCHAR(200) NOT NULL,
    "args" TEXT NOT NULL,
    "kwargs" TEXT NOT NULL,
    "queue" VARCHAR(200),
    "exchange" VARCHAR(200),
    "routing_key" VARCHAR(200),
    "expires" TIMESTAMPTZ(6),
    "enabled" BOOLEAN NOT NULL,
    "last_run_at" TIMESTAMPTZ(6),
    "total_run_count" INTEGER NOT NULL,
    "date_changed" TIMESTAMPTZ(6) NOT NULL,
    "description" TEXT NOT NULL,
    "crontab_id" INTEGER,
    "interval_id" INTEGER,
    "solar_id" INTEGER,
    "one_off" BOOLEAN NOT NULL,
    "start_time" TIMESTAMPTZ(6),
    "priority" INTEGER,
    "headers" TEXT NOT NULL,
    "clocked_id" INTEGER,
    "expire_seconds" INTEGER,

    CONSTRAINT "django_celery_beat_periodictask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_celery_beat_periodictasks" (
    "ident" SMALLINT NOT NULL,
    "last_update" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "django_celery_beat_periodictasks_pkey" PRIMARY KEY ("ident")
);

-- CreateTable
CREATE TABLE "django_celery_beat_solarschedule" (
    "id" SERIAL NOT NULL,
    "event" VARCHAR(24) NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,

    CONSTRAINT "django_celery_beat_solarschedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_celery_results_chordcounter" (
    "id" SERIAL NOT NULL,
    "group_id" VARCHAR(255) NOT NULL,
    "sub_tasks" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "django_celery_results_chordcounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_celery_results_groupresult" (
    "id" SERIAL NOT NULL,
    "group_id" VARCHAR(255) NOT NULL,
    "date_created" TIMESTAMPTZ(6) NOT NULL,
    "date_done" TIMESTAMPTZ(6) NOT NULL,
    "content_type" VARCHAR(128) NOT NULL,
    "content_encoding" VARCHAR(64) NOT NULL,
    "result" TEXT,

    CONSTRAINT "django_celery_results_groupresult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_celery_results_taskresult" (
    "id" SERIAL NOT NULL,
    "task_id" VARCHAR(255) NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "content_type" VARCHAR(128) NOT NULL,
    "content_encoding" VARCHAR(64) NOT NULL,
    "result" TEXT,
    "date_done" TIMESTAMPTZ(6) NOT NULL,
    "traceback" TEXT,
    "meta" TEXT,
    "task_args" TEXT,
    "task_kwargs" TEXT,
    "task_name" VARCHAR(255),
    "worker" VARCHAR(100),
    "date_created" TIMESTAMPTZ(6) NOT NULL,
    "periodic_task_name" VARCHAR(255),
    "date_started" TIMESTAMPTZ(6),

    CONSTRAINT "django_celery_results_taskresult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_content_type" (
    "id" SERIAL NOT NULL,
    "app_label" VARCHAR(100) NOT NULL,
    "model" VARCHAR(100) NOT NULL,

    CONSTRAINT "django_content_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_migrations" (
    "id" BIGSERIAL NOT NULL,
    "app" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "applied" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "django_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "django_session" (
    "session_key" VARCHAR(40) NOT NULL,
    "session_data" TEXT NOT NULL,
    "expire_date" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "django_session_pkey" PRIMARY KEY ("session_key")
);

-- CreateTable
CREATE TABLE "llm_service_cachedresponse" (
    "id" BIGSERIAL NOT NULL,
    "cache_key" VARCHAR(64) NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "response_text" TEXT NOT NULL,
    "response_metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "hit_count" INTEGER NOT NULL,
    "last_accessed" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "llm_service_cachedresponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_service_providerconfig" (
    "id" BIGSERIAL NOT NULL,
    "provider_name" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "priority" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "rate_limit" INTEGER,
    "token_limit" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "llm_service_providerconfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_service_querylog" (
    "id" BIGSERIAL NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "prompt_hash" VARCHAR(64) NOT NULL,
    "prompt_text" TEXT,
    "response_text" TEXT,
    "tokens_input" INTEGER NOT NULL,
    "tokens_output" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "response_time_ms" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error_message" TEXT,
    "cost_estimate" DECIMAL(10,6),
    "application" VARCHAR(100) NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "user_id" INTEGER,

    CONSTRAINT "llm_service_querylog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_admlevel" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_en" VARCHAR(100),
    "name_ar" VARCHAR(100),

    CONSTRAINT "location_admlevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_gazetteer" (
    "id" BIGSERIAL NOT NULL,
    "source" VARCHAR(100) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "location_id" BIGINT NOT NULL,

    CONSTRAINT "location_gazetteer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_location" (
    "id" BIGSERIAL NOT NULL,
    "geo_id" VARCHAR(50) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "name_en" VARCHAR(255),
    "name_ar" VARCHAR(255),
    "boundary" geometry,
    "point" geometry,
    "comment" TEXT,
    "comment_en" TEXT,
    "comment_ar" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "admin_level_id" BIGINT NOT NULL,
    "parent_id" BIGINT,
    "point_type" VARCHAR(10),

    CONSTRAINT "location_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_unmatchedlocation" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "admin_level" VARCHAR(50) NOT NULL,
    "source" VARCHAR(100) NOT NULL,
    "context" TEXT NOT NULL,
    "occurrence_count" INTEGER NOT NULL,
    "first_seen" TIMESTAMPTZ(6) NOT NULL,
    "last_seen" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "matched_at" TIMESTAMPTZ(6),
    "is_matched" BOOLEAN NOT NULL,
    "potential_matches" JSONB NOT NULL,
    "potential_matches_computed_at" TIMESTAMPTZ(6),
    "notes" TEXT NOT NULL,
    "matched_by_id" INTEGER,
    "resolved_location_id" BIGINT,

    CONSTRAINT "location_unmatchedlocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications_internalnotification" (
    "id" BIGSERIAL NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "priority" VARCHAR(10) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "action_url" VARCHAR(500) NOT NULL,
    "action_text" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "alert_id" BIGINT,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "notifications_internalnotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications_notificationpreference" (
    "id" BIGSERIAL NOT NULL,
    "internal_enabled" BOOLEAN NOT NULL,
    "alert_notifications" BOOLEAN NOT NULL,
    "system_notifications" BOOLEAN NOT NULL,
    "update_notifications" BOOLEAN NOT NULL,
    "feedback_notifications" BOOLEAN NOT NULL,
    "show_desktop_notifications" BOOLEAN NOT NULL,
    "play_sound" BOOLEAN NOT NULL,
    "quiet_hours_enabled" BOOLEAN NOT NULL,
    "quiet_hours_start" TIME(6),
    "quiet_hours_end" TIME(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "notifications_notificationpreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_monitoring_taskexecution" (
    "id" BIGSERIAL NOT NULL,
    "task_id" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "result" JSONB,
    "error_message" TEXT NOT NULL,
    "retry_count" INTEGER NOT NULL,
    "max_retries" INTEGER NOT NULL,
    "arg1" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "source_id" BIGINT,
    "variable_id" BIGINT,
    "task_type_id" BIGINT NOT NULL,

    CONSTRAINT "task_monitoring_taskexecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_monitoring_tasklog" (
    "id" BIGSERIAL NOT NULL,
    "task_id" VARCHAR(255) NOT NULL,
    "level" INTEGER NOT NULL,
    "level_name" VARCHAR(10) NOT NULL,
    "message" TEXT NOT NULL,
    "module" VARCHAR(255) NOT NULL,
    "function_name" VARCHAR(255) NOT NULL,
    "line_number" INTEGER,
    "thread" VARCHAR(100) NOT NULL,
    "process" VARCHAR(100) NOT NULL,
    "extra_data" JSONB,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_monitoring_tasklog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_monitoring_tasktype" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "name_en" VARCHAR(255),
    "name_ar" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_monitoring_tasktype_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_translationstring" (
    "id" BIGSERIAL NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "value" TEXT NOT NULL,
    "value_en" TEXT,
    "value_ar" TEXT,
    "description" VARCHAR(200) NOT NULL,
    "description_en" VARCHAR(200),
    "description_ar" VARCHAR(200),
    "is_active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "translation_translationstring_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users_userprofile" (
    "id" BIGSERIAL NOT NULL,
    "email_notifications_enabled" BOOLEAN NOT NULL,
    "email_verified" BOOLEAN NOT NULL,
    "email_verification_token" VARCHAR(100) NOT NULL,
    "email_verification_sent_at" TIMESTAMPTZ(6),
    "preferred_language" VARCHAR(5) NOT NULL,
    "timezone" VARCHAR(50) NOT NULL,
    "last_login_ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "mobile_number" VARCHAR(20) NOT NULL,
    "sms_notifications_enabled" BOOLEAN NOT NULL,

    CONSTRAINT "users_userprofile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_framework_alerttemplate_name_key" ON "alert_framework_alerttemplate"("name");

-- CreateIndex
CREATE INDEX "alert_frame_active_85e637_idx" ON "alert_framework_alerttemplate"("active", "shock_type_id");

-- CreateIndex
CREATE INDEX "alert_frame_detecto_1ee189_idx" ON "alert_framework_alerttemplate"("detector_type");

-- CreateIndex
CREATE INDEX "alert_frame_name_942ea5_idx" ON "alert_framework_alerttemplate"("name");

-- CreateIndex
CREATE INDEX "alert_frame_shock_t_e802e2_idx" ON "alert_framework_alerttemplate"("shock_type_id", "active");

-- CreateIndex
CREATE INDEX "alert_framework_alerttemplate_name_2053666b_like" ON "alert_framework_alerttemplate"("name");

-- CreateIndex
CREATE INDEX "alert_framework_alerttemplate_shock_type_id_b076bce1" ON "alert_framework_alerttemplate"("shock_type_id");

-- CreateIndex
CREATE INDEX "alert_frame_confide_f8ba2b_idx" ON "alert_framework_detection"("confidence_score");

-- CreateIndex
CREATE INDEX "alert_frame_detecti_d3dfdb_idx" ON "alert_framework_detection"("detection_timestamp");

-- CreateIndex
CREATE INDEX "alert_frame_detecto_227bcd_idx" ON "alert_framework_detection"("detector_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "alert_frame_detecto_cdab00_idx" ON "alert_framework_detection"("detector_id", "detection_timestamp");

-- CreateIndex
CREATE INDEX "alert_frame_duplica_8d1d08_idx" ON "alert_framework_detection"("duplicate_of_id");

-- CreateIndex
CREATE INDEX "alert_frame_process_fcb531_idx" ON "alert_framework_detection"("processed_at");

-- CreateIndex
CREATE INDEX "alert_frame_shock_t_652b38_idx" ON "alert_framework_detection"("shock_type_id");

-- CreateIndex
CREATE INDEX "alert_frame_source__b93c84_idx" ON "alert_framework_detection"("source_variabledata_id");

-- CreateIndex
CREATE INDEX "alert_frame_status_6ee8e5_idx" ON "alert_framework_detection"("status", "created_at");

-- CreateIndex
CREATE INDEX "alert_frame_status_d14756_idx" ON "alert_framework_detection"("status", "detection_timestamp");

-- CreateIndex
CREATE INDEX "alert_frame_title_af39df_idx" ON "alert_framework_detection"("title");

-- CreateIndex
CREATE INDEX "alert_framework_detection_alert_id_ab957e38" ON "alert_framework_detection"("alert_id");

-- CreateIndex
CREATE INDEX "alert_framework_detection_detector_id_163660b9" ON "alert_framework_detection"("detector_id");

-- CreateIndex
CREATE INDEX "alert_framework_detection_duplicate_of_id_0310e85b" ON "alert_framework_detection"("duplicate_of_id");

-- CreateIndex
CREATE INDEX "alert_framework_detection_shock_type_id_428980ab" ON "alert_framework_detection"("shock_type_id");

-- CreateIndex
CREATE INDEX "alert_framework_detection_source_variabledata_id_3d5ea251" ON "alert_framework_detection"("source_variabledata_id");

-- CreateIndex
CREATE UNIQUE INDEX "unique_detector_timestamp_title_alert_framework" ON "alert_framework_detection"("detector_id", "detection_timestamp", "title") WHERE (duplicate_of_id IS NULL);

-- CreateIndex
CREATE INDEX "alert_framework_detection_locations_detection_id_fc3de953" ON "alert_framework_detection_locations"("detection_id");

-- CreateIndex
CREATE INDEX "alert_framework_detection_locations_location_id_ba2f0274" ON "alert_framework_detection_locations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_framework_detectio_detection_id_location_id_fa28c454_uniq" ON "alert_framework_detection_locations"("detection_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_framework_detector_name_key" ON "alert_framework_detector"("name");

-- CreateIndex
CREATE INDEX "alert_frame_active_47d132_idx" ON "alert_framework_detector"("active", "last_run");

-- CreateIndex
CREATE INDEX "alert_frame_active_bfec12_idx" ON "alert_framework_detector"("active", "name");

-- CreateIndex
CREATE INDEX "alert_frame_class_n_6975fe_idx" ON "alert_framework_detector"("class_name");

-- CreateIndex
CREATE INDEX "alert_frame_last_ru_f64e71_idx" ON "alert_framework_detector"("last_run");

-- CreateIndex
CREATE INDEX "alert_frame_name_985425_idx" ON "alert_framework_detector"("name");

-- CreateIndex
CREATE INDEX "alert_framework_detector_name_7d1512b0_like" ON "alert_framework_detector"("name");

-- CreateIndex
CREATE INDEX "alert_framework_detector_schedule_id_2b8ec13c" ON "alert_framework_detector"("schedule_id");

-- CreateIndex
CREATE INDEX "alert_frame_api_nam_3dee13_idx" ON "alert_framework_publishedalert"("api_name", "status");

-- CreateIndex
CREATE INDEX "alert_frame_detecti_dea4a3_idx" ON "alert_framework_publishedalert"("detection_id", "api_name");

-- CreateIndex
CREATE INDEX "alert_frame_externa_d3bba7_idx" ON "alert_framework_publishedalert"("external_id");

-- CreateIndex
CREATE INDEX "alert_frame_retry_c_8eb172_idx" ON "alert_framework_publishedalert"("retry_count");

-- CreateIndex
CREATE INDEX "alert_frame_status_4162ae_idx" ON "alert_framework_publishedalert"("status", "created_at");

-- CreateIndex
CREATE INDEX "alert_frame_status_865ee2_idx" ON "alert_framework_publishedalert"("status", "published_at");

-- CreateIndex
CREATE INDEX "alert_framework_publishedalert_detection_id_3609a887" ON "alert_framework_publishedalert"("detection_id");

-- CreateIndex
CREATE INDEX "alert_framework_publishedalert_template_id_07e88b9b" ON "alert_framework_publishedalert"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_framework_publishe_detection_id_api_name_la_0d8a37e3_uniq" ON "alert_framework_publishedalert"("detection_id", "api_name", "language");

-- CreateIndex
CREATE INDEX "alerts_aler_created_e71838_idx" ON "alerts_alert"("created_at", "go_no_go");

-- CreateIndex
CREATE INDEX "alerts_aler_go_no_g_3f5c75_idx" ON "alerts_alert"("go_no_go", "valid_from", "valid_until");

-- CreateIndex
CREATE INDEX "alerts_aler_go_no_g_5302df_idx" ON "alerts_alert"("go_no_go", "shock_date", "created_at");

-- CreateIndex
CREATE INDEX "alerts_aler_go_no_g_dd4066_idx" ON "alerts_alert"("go_no_go", "severity");

-- CreateIndex
CREATE INDEX "alerts_aler_shock_d_6c3e4c_idx" ON "alerts_alert"("shock_date", "go_no_go");

-- CreateIndex
CREATE INDEX "alerts_aler_shock_t_29cf6f_idx" ON "alerts_alert"("shock_type_id", "severity");

-- CreateIndex
CREATE INDEX "alerts_aler_shock_t_cb55c6_idx" ON "alerts_alert"("shock_type_id", "go_no_go", "severity");

-- CreateIndex
CREATE INDEX "alerts_aler_source__6ffc15_idx" ON "alerts_alert"("source_variabledata_id");

-- CreateIndex
CREATE INDEX "alerts_aler_source__d8dd1c_idx" ON "alerts_alert"("source_detection_id");

-- CreateIndex
CREATE INDEX "alerts_aler_valid_f_0473c3_idx" ON "alerts_alert"("valid_from", "valid_until");

-- CreateIndex
CREATE INDEX "alerts_alert_data_source_id_1e751e6f" ON "alerts_alert"("data_source_id");

-- CreateIndex
CREATE INDEX "alerts_alert_shock_type_id_93852cdc" ON "alerts_alert"("shock_type_id");

-- CreateIndex
CREATE INDEX "alerts_alert_source_detection_id_9d5a3e9f" ON "alerts_alert"("source_detection_id");

-- CreateIndex
CREATE INDEX "alerts_alert_source_variabledata_id_7e4c5785" ON "alerts_alert"("source_variabledata_id");

-- CreateIndex
CREATE INDEX "alerts_alert_locations_alert_id_0106e742" ON "alerts_alert_locations"("alert_id");

-- CreateIndex
CREATE INDEX "alerts_alert_locations_location_id_02e9cf44" ON "alerts_alert_locations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_alert_locations_alert_id_location_id_b00491e1_uniq" ON "alerts_alert_locations"("alert_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_alertembedding_alert_id_key" ON "alerts_alertembedding"("alert_id");

-- CreateIndex
CREATE INDEX "alerts_aler_model_n_170805_idx" ON "alerts_alertembedding"("model_name");

-- CreateIndex
CREATE INDEX "alerts_aler_alert_a_22b3f0_idx" ON "alerts_alertsimilarity"("alert_a_id", "semantic_score" DESC);

-- CreateIndex
CREATE INDEX "alerts_aler_alert_b_65a801_idx" ON "alerts_alertsimilarity"("alert_b_id", "semantic_score" DESC);

-- CreateIndex
CREATE INDEX "alerts_alertsimilarity_alert_a_id_30aabc7a" ON "alerts_alertsimilarity"("alert_a_id");

-- CreateIndex
CREATE INDEX "alerts_alertsimilarity_alert_b_id_2bb86724" ON "alerts_alertsimilarity"("alert_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_alertsimilarity_alert_a_id_alert_b_id_64f7f2e1_uniq" ON "alerts_alertsimilarity"("alert_a_id", "alert_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_emailtemplate_name_key" ON "alerts_emailtemplate"("name");

-- CreateIndex
CREATE INDEX "alerts_emailtemplate_name_165d595b_like" ON "alerts_emailtemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_shocktype_name_key" ON "alerts_shocktype"("name");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_shocktype_name_en_key" ON "alerts_shocktype"("name_en");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_shocktype_name_ar_key" ON "alerts_shocktype"("name_ar");

-- CreateIndex
CREATE INDEX "alerts_shoc_name_467a5b_idx" ON "alerts_shocktype"("name");

-- CreateIndex
CREATE INDEX "alerts_shocktype_name_17eac0b7_like" ON "alerts_shocktype"("name");

-- CreateIndex
CREATE INDEX "alerts_shocktype_name_ar_967b40a3_like" ON "alerts_shocktype"("name_ar");

-- CreateIndex
CREATE INDEX "alerts_shocktype_name_en_b71e9f4c_like" ON "alerts_shocktype"("name_en");

-- CreateIndex
CREATE INDEX "alerts_subs_active_2911a4_idx" ON "alerts_subscription"("active", "frequency");

-- CreateIndex
CREATE INDEX "alerts_subs_user_id_a11961_idx" ON "alerts_subscription"("user_id", "active");

-- CreateIndex
CREATE INDEX "alerts_subscription_user_id_38b321ac" ON "alerts_subscription"("user_id");

-- CreateIndex
CREATE INDEX "alerts_subscription_locations_location_id_47f2a5b5" ON "alerts_subscription_locations"("location_id");

-- CreateIndex
CREATE INDEX "alerts_subscription_locations_subscription_id_2e0b7a09" ON "alerts_subscription_locations"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_subscription_loca_subscription_id_location_fceb0fec_uniq" ON "alerts_subscription_locations"("subscription_id", "location_id");

-- CreateIndex
CREATE INDEX "alerts_subscription_shock_types_shocktype_id_88eda0eb" ON "alerts_subscription_shock_types"("shocktype_id");

-- CreateIndex
CREATE INDEX "alerts_subscription_shock_types_subscription_id_77d1b30a" ON "alerts_subscription_shock_types"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_subscription_shoc_subscription_id_shocktyp_5a9b5a13_uniq" ON "alerts_subscription_shock_types"("subscription_id", "shocktype_id");

-- CreateIndex
CREATE INDEX "alerts_user_alert_i_172ca2_idx" ON "alerts_useralert"("alert_id", "rating_timeliness");

-- CreateIndex
CREATE INDEX "alerts_user_alert_i_78051a_idx" ON "alerts_useralert"("alert_id", "rating_accuracy");

-- CreateIndex
CREATE INDEX "alerts_user_alert_i_98e622_idx" ON "alerts_useralert"("alert_id", "rating_relevance");

-- CreateIndex
CREATE INDEX "alerts_user_flag_fa_e4e834_idx" ON "alerts_useralert"("flag_false", "flag_incomplete");

-- CreateIndex
CREATE INDEX "alerts_user_rating__3bccf7_idx" ON "alerts_useralert"("rating_relevance", "created_at");

-- CreateIndex
CREATE INDEX "alerts_user_user_id_0eb48b_idx" ON "alerts_useralert"("user_id", "alert_id", "bookmarked");

-- CreateIndex
CREATE INDEX "alerts_user_user_id_254826_idx" ON "alerts_useralert"("user_id", "bookmarked");

-- CreateIndex
CREATE INDEX "alerts_user_user_id_347684_idx" ON "alerts_useralert"("user_id", "rating_timeliness", "rating_timeliness_at");

-- CreateIndex
CREATE INDEX "alerts_user_user_id_5e1c3e_idx" ON "alerts_useralert"("user_id", "rating_relevance", "rating_relevance_at");

-- CreateIndex
CREATE INDEX "alerts_user_user_id_b2a95f_idx" ON "alerts_useralert"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "alerts_user_user_id_bf98e8_idx" ON "alerts_useralert"("user_id", "rating_accuracy", "rating_accuracy_at");

-- CreateIndex
CREATE INDEX "alerts_useralert_alert_id_6166682c" ON "alerts_useralert"("alert_id");

-- CreateIndex
CREATE INDEX "alerts_useralert_user_id_9af6e1b9" ON "alerts_useralert"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_useralert_user_id_alert_id_b968a87a_uniq" ON "alerts_useralert"("user_id", "alert_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_group_name_key" ON "auth_group"("name");

-- CreateIndex
CREATE INDEX "auth_group_name_a6ea08ec_like" ON "auth_group"("name");

-- CreateIndex
CREATE INDEX "auth_group_permissions_group_id_b120cbf9" ON "auth_group_permissions"("group_id");

-- CreateIndex
CREATE INDEX "auth_group_permissions_permission_id_84c5c92e" ON "auth_group_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_group_permissions_group_id_permission_id_0cd325b0_uniq" ON "auth_group_permissions"("group_id", "permission_id");

-- CreateIndex
CREATE INDEX "auth_permission_content_type_id_2f476e4b" ON "auth_permission"("content_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_permission_content_type_id_codename_01ab375a_uniq" ON "auth_permission"("content_type_id", "codename");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_username_key" ON "auth_user"("username");

-- CreateIndex
CREATE INDEX "auth_user_username_6821ab7c_like" ON "auth_user"("username");

-- CreateIndex
CREATE INDEX "auth_user_groups_group_id_97559544" ON "auth_user_groups"("group_id");

-- CreateIndex
CREATE INDEX "auth_user_groups_user_id_6a12ed8b" ON "auth_user_groups"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_groups_user_id_group_id_94350c0c_uniq" ON "auth_user_groups"("user_id", "group_id");

-- CreateIndex
CREATE INDEX "auth_user_user_permissions_permission_id_1fbb5f2c" ON "auth_user_user_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "auth_user_user_permissions_user_id_a95ead1b" ON "auth_user_user_permissions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_user_permissions_user_id_permission_id_14a6b632_uniq" ON "auth_user_user_permissions"("user_id", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_colormap_name_key" ON "dashboard_colormap"("name");

-- CreateIndex
CREATE INDEX "dashboard_colormap_name_76e2608b_like" ON "dashboard_colormap"("name");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_layer_code_key" ON "dashboard_layer"("code");

-- CreateIndex
CREATE INDEX "dashboard_layer_code_1478e5b4_like" ON "dashboard_layer"("code");

-- CreateIndex
CREATE INDEX "dashboard_layer_cog_colormap_id_19cc42f0" ON "dashboard_layer"("cog_colormap_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_theme_code_key" ON "dashboard_theme"("code");

-- CreateIndex
CREATE INDEX "dashboard_theme_code_91e70964_like" ON "dashboard_theme"("code");

-- CreateIndex
CREATE INDEX "dashboard_theme_colormap_id_e77843e1" ON "dashboard_theme"("colormap_id");

-- CreateIndex
CREATE INDEX "dashboard_theme_shock_types_shocktype_id_de70192a" ON "dashboard_theme_shock_types"("shocktype_id");

-- CreateIndex
CREATE INDEX "dashboard_theme_shock_types_theme_id_560934f5" ON "dashboard_theme_shock_types"("theme_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_theme_shock_types_theme_id_shocktype_id_f4fd35af_uniq" ON "dashboard_theme_shock_types"("theme_id", "shocktype_id");

-- CreateIndex
CREATE INDEX "dashboard_themelayer_layer_id_36db88ca" ON "dashboard_themelayer"("layer_id");

-- CreateIndex
CREATE INDEX "dashboard_themelayer_theme_id_fd693035" ON "dashboard_themelayer"("theme_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_themelayer_theme_id_layer_id_5e860b7d_uniq" ON "dashboard_themelayer"("theme_id", "layer_id");

-- CreateIndex
CREATE INDEX "dashboard_themevariable_theme_id_60d266b3" ON "dashboard_themevariable"("theme_id");

-- CreateIndex
CREATE INDEX "dashboard_themevariable_variable_id_64205790" ON "dashboard_themevariable"("variable_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_themevariable_theme_id_variable_id_c36a71f2_uniq" ON "dashboard_themevariable"("theme_id", "variable_id");

-- CreateIndex
CREATE INDEX "data_pipeli_name_907609_idx" ON "data_pipeline_source"("name");

-- CreateIndex
CREATE INDEX "data_pipeli_type_6fea6b_idx" ON "data_pipeline_source"("type");

-- CreateIndex
CREATE UNIQUE INDEX "data_pipeline_sourceauthtoken_source_id_key" ON "data_pipeline_sourceauthtoken"("source_id");

-- CreateIndex
CREATE INDEX "data_pipeli_source__82391c_idx" ON "data_pipeline_sourceauthtoken"("source_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "data_pipeline_taskstatistics_date_key" ON "data_pipeline_taskstatistics"("date");

-- CreateIndex
CREATE INDEX "data_pipeli_date_84ee66_idx" ON "data_pipeline_taskstatistics"("date");

-- CreateIndex
CREATE INDEX "data_pipeli_period_3475f2_idx" ON "data_pipeline_variable"("period", "adm_level");

-- CreateIndex
CREATE INDEX "data_pipeli_source__32461b_idx" ON "data_pipeline_variable"("source_id", "code");

-- CreateIndex
CREATE INDEX "data_pipeli_type_df82e7_idx" ON "data_pipeline_variable"("type");

-- CreateIndex
CREATE INDEX "data_pipeline_variable_source_id_903e6993" ON "data_pipeline_variable"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_pipeline_variable_source_id_code_a1ba78c6_uniq" ON "data_pipeline_variable"("source_id", "code");

-- CreateIndex
CREATE INDEX "data_pipeli_adm_lev_310bce_idx" ON "data_pipeline_variabledata"("adm_level_id", "period");

-- CreateIndex
CREATE INDEX "data_pipeli_end_dat_d47fbd_idx" ON "data_pipeline_variabledata"("end_date");

-- CreateIndex
CREATE INDEX "data_pipeli_gid_id_14af07_idx" ON "data_pipeline_variabledata"("gid_id", "variable_id");

-- CreateIndex
CREATE INDEX "data_pipeli_parent__c36565_idx" ON "data_pipeline_variabledata"("parent_id");

-- CreateIndex
CREATE INDEX "data_pipeli_variabl_a821b0_idx" ON "data_pipeline_variabledata"("variable_id", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "data_pipeline_variabledata_adm_level_id_67b64f71" ON "data_pipeline_variabledata"("adm_level_id");

-- CreateIndex
CREATE INDEX "data_pipeline_variabledata_gid_id_db3c5e6f" ON "data_pipeline_variabledata"("gid_id");

-- CreateIndex
CREATE INDEX "data_pipeline_variabledata_parent_id_33b7259a" ON "data_pipeline_variabledata"("parent_id");

-- CreateIndex
CREATE INDEX "data_pipeline_variabledata_source_record_id_ac805590" ON "data_pipeline_variabledata"("source_record_id");

-- CreateIndex
CREATE INDEX "data_pipeline_variabledata_source_record_id_ac805590_like" ON "data_pipeline_variabledata"("source_record_id");

-- CreateIndex
CREATE INDEX "data_pipeline_variabledata_unmatched_location_id_7435db0c" ON "data_pipeline_variabledata"("unmatched_location_id");

-- CreateIndex
CREATE INDEX "data_pipeline_variabledata_variable_id_41a27bf5" ON "data_pipeline_variabledata"("variable_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_pipeline_variableda_variable_id_start_date_e_501d6c00_uniq" ON "data_pipeline_variabledata"("variable_id", "start_date", "end_date", "gid_id");

-- CreateIndex
CREATE INDEX "django_admin_log_content_type_id_c4bce8eb" ON "django_admin_log"("content_type_id");

-- CreateIndex
CREATE INDEX "django_admin_log_user_id_c564eba6" ON "django_admin_log"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "django_celery_beat_periodictask_name_key" ON "django_celery_beat_periodictask"("name");

-- CreateIndex
CREATE INDEX "django_celery_beat_periodictask_clocked_id_47a69f82" ON "django_celery_beat_periodictask"("clocked_id");

-- CreateIndex
CREATE INDEX "django_celery_beat_periodictask_crontab_id_d3cba168" ON "django_celery_beat_periodictask"("crontab_id");

-- CreateIndex
CREATE INDEX "django_celery_beat_periodictask_interval_id_a8ca27da" ON "django_celery_beat_periodictask"("interval_id");

-- CreateIndex
CREATE INDEX "django_celery_beat_periodictask_name_265a36b7_like" ON "django_celery_beat_periodictask"("name");

-- CreateIndex
CREATE INDEX "django_celery_beat_periodictask_solar_id_a87ce72c" ON "django_celery_beat_periodictask"("solar_id");

-- CreateIndex
CREATE UNIQUE INDEX "django_celery_beat_solar_event_latitude_longitude_ba64999a_uniq" ON "django_celery_beat_solarschedule"("event", "latitude", "longitude");

-- CreateIndex
CREATE UNIQUE INDEX "django_celery_results_chordcounter_group_id_key" ON "django_celery_results_chordcounter"("group_id");

-- CreateIndex
CREATE INDEX "django_celery_results_chordcounter_group_id_1f70858c_like" ON "django_celery_results_chordcounter"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "django_celery_results_groupresult_group_id_key" ON "django_celery_results_groupresult"("group_id");

-- CreateIndex
CREATE INDEX "django_cele_date_cr_bd6c1d_idx" ON "django_celery_results_groupresult"("date_created");

-- CreateIndex
CREATE INDEX "django_cele_date_do_caae0e_idx" ON "django_celery_results_groupresult"("date_done");

-- CreateIndex
CREATE INDEX "django_celery_results_groupresult_group_id_a085f1a9_like" ON "django_celery_results_groupresult"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "django_celery_results_taskresult_task_id_key" ON "django_celery_results_taskresult"("task_id");

-- CreateIndex
CREATE INDEX "django_cele_date_cr_f04a50_idx" ON "django_celery_results_taskresult"("date_created");

-- CreateIndex
CREATE INDEX "django_cele_date_do_f59aad_idx" ON "django_celery_results_taskresult"("date_done");

-- CreateIndex
CREATE INDEX "django_cele_periodi_1993cf_idx" ON "django_celery_results_taskresult"("periodic_task_name");

-- CreateIndex
CREATE INDEX "django_cele_status_9b6201_idx" ON "django_celery_results_taskresult"("status");

-- CreateIndex
CREATE INDEX "django_cele_task_na_08aec9_idx" ON "django_celery_results_taskresult"("task_name");

-- CreateIndex
CREATE INDEX "django_cele_worker_d54dd8_idx" ON "django_celery_results_taskresult"("worker");

-- CreateIndex
CREATE INDEX "django_celery_results_taskresult_task_id_de0d95bf_like" ON "django_celery_results_taskresult"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "django_content_type_app_label_model_76bd3d3b_uniq" ON "django_content_type"("app_label", "model");

-- CreateIndex
CREATE INDEX "django_session_expire_date_a5c62663" ON "django_session"("expire_date");

-- CreateIndex
CREATE INDEX "django_session_session_key_c0390e0f_like" ON "django_session"("session_key");

-- CreateIndex
CREATE UNIQUE INDEX "llm_service_cachedresponse_cache_key_key" ON "llm_service_cachedresponse"("cache_key");

-- CreateIndex
CREATE INDEX "llm_service_cachedresponse_cache_key_f0f68110_like" ON "llm_service_cachedresponse"("cache_key");

-- CreateIndex
CREATE INDEX "llm_service_cachedresponse_expires_at_51450af2" ON "llm_service_cachedresponse"("expires_at");

-- CreateIndex
CREATE INDEX "llm_service_provide_dc8e46_idx" ON "llm_service_cachedresponse"("provider", "model", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "llm_service_providerconfig_provider_name_key" ON "llm_service_providerconfig"("provider_name");

-- CreateIndex
CREATE INDEX "llm_service_providerconfig_provider_name_be553903_like" ON "llm_service_providerconfig"("provider_name");

-- CreateIndex
CREATE INDEX "llm_service_applica_095561_idx" ON "llm_service_querylog"("application", "created_at");

-- CreateIndex
CREATE INDEX "llm_service_provide_084a13_idx" ON "llm_service_querylog"("provider", "created_at");

-- CreateIndex
CREATE INDEX "llm_service_querylog_application_80a29da2" ON "llm_service_querylog"("application");

-- CreateIndex
CREATE INDEX "llm_service_querylog_application_80a29da2_like" ON "llm_service_querylog"("application");

-- CreateIndex
CREATE INDEX "llm_service_querylog_created_at_aae2dd3e" ON "llm_service_querylog"("created_at");

-- CreateIndex
CREATE INDEX "llm_service_querylog_prompt_hash_c74e61fa" ON "llm_service_querylog"("prompt_hash");

-- CreateIndex
CREATE INDEX "llm_service_querylog_prompt_hash_c74e61fa_like" ON "llm_service_querylog"("prompt_hash");

-- CreateIndex
CREATE INDEX "llm_service_querylog_provider_164c2552" ON "llm_service_querylog"("provider");

-- CreateIndex
CREATE INDEX "llm_service_querylog_provider_164c2552_like" ON "llm_service_querylog"("provider");

-- CreateIndex
CREATE INDEX "llm_service_querylog_user_id_b4874da2" ON "llm_service_querylog"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "location_admlevel_code_key" ON "location_admlevel"("code");

-- CreateIndex
CREATE INDEX "location_admlevel_code_5fea79d5_like" ON "location_admlevel"("code");

-- CreateIndex
CREATE INDEX "location_ga_code_3ea8ed_idx" ON "location_gazetteer"("code");

-- CreateIndex
CREATE INDEX "location_ga_name_57efa3_idx" ON "location_gazetteer"("name");

-- CreateIndex
CREATE INDEX "location_ga_source_79ef4d_idx" ON "location_gazetteer"("source");

-- CreateIndex
CREATE INDEX "location_gazetteer_location_id_83ac793c" ON "location_gazetteer"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "location_gazetteer_location_id_source_code_4eea9bfc_uniq" ON "location_gazetteer"("location_id", "source", "code");

-- CreateIndex
CREATE UNIQUE INDEX "location_gazetteer_location_id_source_name_92c21936_uniq" ON "location_gazetteer"("location_id", "source", "name");

-- CreateIndex
CREATE UNIQUE INDEX "location_location_geo_id_key" ON "location_location"("geo_id");

-- CreateIndex
CREATE INDEX "location_lo_admin_l_bd4483_idx" ON "location_location"("admin_level_id");

-- CreateIndex
CREATE INDEX "location_lo_geo_id_ebfb0f_idx" ON "location_location"("geo_id");

-- CreateIndex
CREATE INDEX "location_lo_parent__a571f7_idx" ON "location_location"("parent_id");

-- CreateIndex
CREATE INDEX "location_location_admin_level_id_a284d68e" ON "location_location"("admin_level_id");

-- CreateIndex
CREATE INDEX "location_location_boundary_4e277753_id" ON "location_location" USING GIST ("boundary");

-- CreateIndex
CREATE INDEX "location_location_geo_id_1074dc65_like" ON "location_location"("geo_id");

-- CreateIndex
CREATE INDEX "location_location_parent_id_47fe0a9a" ON "location_location"("parent_id");

-- CreateIndex
CREATE INDEX "location_location_point_9c4c6db5_id" ON "location_location" USING GIST ("point");

-- CreateIndex
CREATE INDEX "location_un_last_se_255913_idx" ON "location_unmatchedlocation"("last_seen" DESC);

-- CreateIndex
CREATE INDEX "location_un_occurre_8f24c0_idx" ON "location_unmatchedlocation"("occurrence_count" DESC);

-- CreateIndex
CREATE INDEX "location_un_source_ddf515_idx" ON "location_unmatchedlocation"("source");

-- CreateIndex
CREATE INDEX "location_un_status_5adfb6_idx" ON "location_unmatchedlocation"("status");

-- CreateIndex
CREATE INDEX "location_unmatchedlocation_matched_by_id_28d9898c" ON "location_unmatchedlocation"("matched_by_id");

-- CreateIndex
CREATE INDEX "location_unmatchedlocation_resolved_location_id_f2624b22" ON "location_unmatchedlocation"("resolved_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "location_unmatchedlocation_name_source_87f9dc79_uniq" ON "location_unmatchedlocation"("name", "source");

-- CreateIndex
CREATE INDEX "notificatio_type_288904_idx" ON "notifications_internalnotification"("type", "priority");

-- CreateIndex
CREATE INDEX "notificatio_user_id_7307ab_idx" ON "notifications_internalnotification"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notificatio_user_id_fe4948_idx" ON "notifications_internalnotification"("user_id", "read");

-- CreateIndex
CREATE INDEX "notifications_internalnotification_alert_id_594d9ecb" ON "notifications_internalnotification"("alert_id");

-- CreateIndex
CREATE INDEX "notifications_internalnotification_user_id_0bf4236f" ON "notifications_internalnotification"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_notificationpreference_user_id_key" ON "notifications_notificationpreference"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_monitoring_taskexecution_task_id_key" ON "task_monitoring_taskexecution"("task_id");

-- CreateIndex
CREATE INDEX "task_monito_source__f32c5b_idx" ON "task_monitoring_taskexecution"("source_id", "task_type_id");

-- CreateIndex
CREATE INDEX "task_monito_status_b85dfe_idx" ON "task_monitoring_taskexecution"("status", "created_at");

-- CreateIndex
CREATE INDEX "task_monito_task_id_e555a5_idx" ON "task_monitoring_taskexecution"("task_id");

-- CreateIndex
CREATE INDEX "task_monito_task_ty_56d1d5_idx" ON "task_monitoring_taskexecution"("task_type_id", "status");

-- CreateIndex
CREATE INDEX "task_monito_variabl_10134b_idx" ON "task_monitoring_taskexecution"("variable_id", "task_type_id");

-- CreateIndex
CREATE INDEX "task_monitoring_taskexecution_source_id_9cdbdc2f" ON "task_monitoring_taskexecution"("source_id");

-- CreateIndex
CREATE INDEX "task_monitoring_taskexecution_task_id_c3964738_like" ON "task_monitoring_taskexecution"("task_id");

-- CreateIndex
CREATE INDEX "task_monitoring_taskexecution_task_type_id_d8e158a7" ON "task_monitoring_taskexecution"("task_type_id");

-- CreateIndex
CREATE INDEX "task_monitoring_taskexecution_variable_id_1c8e4528" ON "task_monitoring_taskexecution"("variable_id");

-- CreateIndex
CREATE INDEX "task_monito_level_42e0e0_idx" ON "task_monitoring_tasklog"("level", "timestamp");

-- CreateIndex
CREATE INDEX "task_monito_task_id_04e42f_idx" ON "task_monitoring_tasklog"("task_id", "level");

-- CreateIndex
CREATE INDEX "task_monito_task_id_f39410_idx" ON "task_monitoring_tasklog"("task_id", "timestamp");

-- CreateIndex
CREATE INDEX "task_monito_timesta_22c8b7_idx" ON "task_monitoring_tasklog"("timestamp");

-- CreateIndex
CREATE INDEX "task_monitoring_tasklog_task_id_9970e41c" ON "task_monitoring_tasklog"("task_id");

-- CreateIndex
CREATE INDEX "task_monitoring_tasklog_task_id_9970e41c_like" ON "task_monitoring_tasklog"("task_id");

-- CreateIndex
CREATE INDEX "task_monitoring_tasklog_timestamp_f77a811c" ON "task_monitoring_tasklog"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "task_monitoring_tasktype_name_key" ON "task_monitoring_tasktype"("name");

-- CreateIndex
CREATE UNIQUE INDEX "task_monitoring_tasktype_name_en_key" ON "task_monitoring_tasktype"("name_en");

-- CreateIndex
CREATE UNIQUE INDEX "task_monitoring_tasktype_name_ar_key" ON "task_monitoring_tasktype"("name_ar");

-- CreateIndex
CREATE INDEX "task_monitoring_tasktype_name_ar_40e16bdb_like" ON "task_monitoring_tasktype"("name_ar");

-- CreateIndex
CREATE INDEX "task_monitoring_tasktype_name_en_911388f8_like" ON "task_monitoring_tasktype"("name_en");

-- CreateIndex
CREATE INDEX "task_monitoring_tasktype_name_f0747f74_like" ON "task_monitoring_tasktype"("name");

-- CreateIndex
CREATE UNIQUE INDEX "translation_translationstring_label_key" ON "translation_translationstring"("label");

-- CreateIndex
CREATE INDEX "translation_translationstring_label_4743026f_like" ON "translation_translationstring"("label");

-- CreateIndex
CREATE UNIQUE INDEX "users_userprofile_user_id_key" ON "users_userprofile"("user_id");

-- AddForeignKey
ALTER TABLE "alert_framework_alerttemplate" ADD CONSTRAINT "alert_framework_aler_shock_type_id_b076bce1_fk_alerts_sh" FOREIGN KEY ("shock_type_id") REFERENCES "alerts_shocktype"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_detection" ADD CONSTRAINT "alert_framework_dete_detector_id_163660b9_fk_alert_fra" FOREIGN KEY ("detector_id") REFERENCES "alert_framework_detector"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_detection" ADD CONSTRAINT "alert_framework_dete_duplicate_of_id_0310e85b_fk_alert_fra" FOREIGN KEY ("duplicate_of_id") REFERENCES "alert_framework_detection"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_detection" ADD CONSTRAINT "alert_framework_dete_shock_type_id_428980ab_fk_alerts_sh" FOREIGN KEY ("shock_type_id") REFERENCES "alerts_shocktype"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_detection" ADD CONSTRAINT "alert_framework_dete_source_variabledata__3d5ea251_fk_data_pipe" FOREIGN KEY ("source_variabledata_id") REFERENCES "data_pipeline_variabledata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_detection" ADD CONSTRAINT "alert_framework_detection_alert_id_ab957e38_fk_alerts_alert_id" FOREIGN KEY ("alert_id") REFERENCES "alerts_alert"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_detection_locations" ADD CONSTRAINT "alert_framework_dete_detection_id_fc3de953_fk_alert_fra" FOREIGN KEY ("detection_id") REFERENCES "alert_framework_detection"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_detection_locations" ADD CONSTRAINT "alert_framework_dete_location_id_ba2f0274_fk_location_" FOREIGN KEY ("location_id") REFERENCES "location_location"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_detector" ADD CONSTRAINT "alert_framework_dete_schedule_id_2b8ec13c_fk_django_ce" FOREIGN KEY ("schedule_id") REFERENCES "django_celery_beat_periodictask"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_publishedalert" ADD CONSTRAINT "alert_framework_publ_detection_id_3609a887_fk_alert_fra" FOREIGN KEY ("detection_id") REFERENCES "alert_framework_detection"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alert_framework_publishedalert" ADD CONSTRAINT "alert_framework_publ_template_id_07e88b9b_fk_alert_fra" FOREIGN KEY ("template_id") REFERENCES "alert_framework_alerttemplate"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alert" ADD CONSTRAINT "alerts_alert_data_source_id_1e751e6f_fk_data_pipeline_source_id" FOREIGN KEY ("data_source_id") REFERENCES "data_pipeline_source"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alert" ADD CONSTRAINT "alerts_alert_shock_type_id_93852cdc_fk_alerts_shocktype_id" FOREIGN KEY ("shock_type_id") REFERENCES "alerts_shocktype"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alert" ADD CONSTRAINT "alerts_alert_source_detection_id_9d5a3e9f_fk_alert_fra" FOREIGN KEY ("source_detection_id") REFERENCES "alert_framework_detection"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alert" ADD CONSTRAINT "alerts_alert_source_variabledata__7e4c5785_fk_data_pipe" FOREIGN KEY ("source_variabledata_id") REFERENCES "data_pipeline_variabledata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alert_locations" ADD CONSTRAINT "alerts_alert_locatio_location_id_02e9cf44_fk_location_" FOREIGN KEY ("location_id") REFERENCES "location_location"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alert_locations" ADD CONSTRAINT "alerts_alert_locations_alert_id_0106e742_fk_alerts_alert_id" FOREIGN KEY ("alert_id") REFERENCES "alerts_alert"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alertembedding" ADD CONSTRAINT "alerts_alertembedding_alert_id_09406786_fk_alerts_alert_id" FOREIGN KEY ("alert_id") REFERENCES "alerts_alert"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alertsimilarity" ADD CONSTRAINT "alerts_alertsimilarity_alert_a_id_30aabc7a_fk_alerts_alert_id" FOREIGN KEY ("alert_a_id") REFERENCES "alerts_alert"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_alertsimilarity" ADD CONSTRAINT "alerts_alertsimilarity_alert_b_id_2bb86724_fk_alerts_alert_id" FOREIGN KEY ("alert_b_id") REFERENCES "alerts_alert"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_subscription" ADD CONSTRAINT "alerts_subscription_user_id_38b321ac_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_subscription_locations" ADD CONSTRAINT "alerts_subscription__location_id_47f2a5b5_fk_location_" FOREIGN KEY ("location_id") REFERENCES "location_location"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_subscription_locations" ADD CONSTRAINT "alerts_subscription__subscription_id_2e0b7a09_fk_alerts_su" FOREIGN KEY ("subscription_id") REFERENCES "alerts_subscription"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_subscription_shock_types" ADD CONSTRAINT "alerts_subscription__shocktype_id_88eda0eb_fk_alerts_sh" FOREIGN KEY ("shocktype_id") REFERENCES "alerts_shocktype"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_subscription_shock_types" ADD CONSTRAINT "alerts_subscription__subscription_id_77d1b30a_fk_alerts_su" FOREIGN KEY ("subscription_id") REFERENCES "alerts_subscription"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_useralert" ADD CONSTRAINT "alerts_useralert_alert_id_6166682c_fk_alerts_alert_id" FOREIGN KEY ("alert_id") REFERENCES "alerts_alert"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alerts_useralert" ADD CONSTRAINT "alerts_useralert_user_id_9af6e1b9_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_group_permissions" ADD CONSTRAINT "auth_group_permissio_permission_id_84c5c92e_fk_auth_perm" FOREIGN KEY ("permission_id") REFERENCES "auth_permission"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_group_permissions" ADD CONSTRAINT "auth_group_permissions_group_id_b120cbf9_fk_auth_group_id" FOREIGN KEY ("group_id") REFERENCES "auth_group"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_permission" ADD CONSTRAINT "auth_permission_content_type_id_2f476e4b_fk_django_co" FOREIGN KEY ("content_type_id") REFERENCES "django_content_type"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_user_groups" ADD CONSTRAINT "auth_user_groups_group_id_97559544_fk_auth_group_id" FOREIGN KEY ("group_id") REFERENCES "auth_group"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_user_groups" ADD CONSTRAINT "auth_user_groups_user_id_6a12ed8b_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_user_user_permissions" ADD CONSTRAINT "auth_user_user_permi_permission_id_1fbb5f2c_fk_auth_perm" FOREIGN KEY ("permission_id") REFERENCES "auth_permission"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_user_user_permissions" ADD CONSTRAINT "auth_user_user_permissions_user_id_a95ead1b_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dashboard_layer" ADD CONSTRAINT "dashboard_layer_cog_colormap_id_19cc42f0_fk_dashboard" FOREIGN KEY ("cog_colormap_id") REFERENCES "dashboard_colormap"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dashboard_theme" ADD CONSTRAINT "dashboard_theme_colormap_id_e77843e1_fk_dashboard_colormap_id" FOREIGN KEY ("colormap_id") REFERENCES "dashboard_colormap"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dashboard_theme_shock_types" ADD CONSTRAINT "dashboard_theme_shoc_shocktype_id_de70192a_fk_alerts_sh" FOREIGN KEY ("shocktype_id") REFERENCES "alerts_shocktype"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dashboard_theme_shock_types" ADD CONSTRAINT "dashboard_theme_shoc_theme_id_560934f5_fk_dashboard" FOREIGN KEY ("theme_id") REFERENCES "dashboard_theme"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dashboard_themelayer" ADD CONSTRAINT "dashboard_themelayer_layer_id_36db88ca_fk_dashboard_layer_id" FOREIGN KEY ("layer_id") REFERENCES "dashboard_layer"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dashboard_themelayer" ADD CONSTRAINT "dashboard_themelayer_theme_id_fd693035_fk_dashboard_theme_id" FOREIGN KEY ("theme_id") REFERENCES "dashboard_theme"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dashboard_themevariable" ADD CONSTRAINT "dashboard_themevaria_variable_id_64205790_fk_data_pipe" FOREIGN KEY ("variable_id") REFERENCES "data_pipeline_variable"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dashboard_themevariable" ADD CONSTRAINT "dashboard_themevariable_theme_id_60d266b3_fk_dashboard_theme_id" FOREIGN KEY ("theme_id") REFERENCES "dashboard_theme"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "data_pipeline_sourceauthtoken" ADD CONSTRAINT "data_pipeline_source_source_id_4f19be73_fk_data_pipe" FOREIGN KEY ("source_id") REFERENCES "data_pipeline_source"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "data_pipeline_variable" ADD CONSTRAINT "data_pipeline_variab_source_id_903e6993_fk_data_pipe" FOREIGN KEY ("source_id") REFERENCES "data_pipeline_source"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "data_pipeline_variabledata" ADD CONSTRAINT "data_pipeline_variab_adm_level_id_67b64f71_fk_location_" FOREIGN KEY ("adm_level_id") REFERENCES "location_admlevel"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "data_pipeline_variabledata" ADD CONSTRAINT "data_pipeline_variab_gid_id_db3c5e6f_fk_location_" FOREIGN KEY ("gid_id") REFERENCES "location_location"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "data_pipeline_variabledata" ADD CONSTRAINT "data_pipeline_variab_parent_id_33b7259a_fk_data_pipe" FOREIGN KEY ("parent_id") REFERENCES "data_pipeline_variabledata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "data_pipeline_variabledata" ADD CONSTRAINT "data_pipeline_variab_unmatched_location_i_7435db0c_fk_location_" FOREIGN KEY ("unmatched_location_id") REFERENCES "location_unmatchedlocation"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "data_pipeline_variabledata" ADD CONSTRAINT "data_pipeline_variab_variable_id_41a27bf5_fk_data_pipe" FOREIGN KEY ("variable_id") REFERENCES "data_pipeline_variable"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "django_admin_log" ADD CONSTRAINT "django_admin_log_content_type_id_c4bce8eb_fk_django_co" FOREIGN KEY ("content_type_id") REFERENCES "django_content_type"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "django_admin_log" ADD CONSTRAINT "django_admin_log_user_id_c564eba6_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "django_celery_beat_periodictask" ADD CONSTRAINT "django_celery_beat_p_clocked_id_47a69f82_fk_django_ce" FOREIGN KEY ("clocked_id") REFERENCES "django_celery_beat_clockedschedule"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "django_celery_beat_periodictask" ADD CONSTRAINT "django_celery_beat_p_crontab_id_d3cba168_fk_django_ce" FOREIGN KEY ("crontab_id") REFERENCES "django_celery_beat_crontabschedule"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "django_celery_beat_periodictask" ADD CONSTRAINT "django_celery_beat_p_interval_id_a8ca27da_fk_django_ce" FOREIGN KEY ("interval_id") REFERENCES "django_celery_beat_intervalschedule"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "django_celery_beat_periodictask" ADD CONSTRAINT "django_celery_beat_p_solar_id_a87ce72c_fk_django_ce" FOREIGN KEY ("solar_id") REFERENCES "django_celery_beat_solarschedule"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "llm_service_querylog" ADD CONSTRAINT "llm_service_querylog_user_id_b4874da2_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "location_gazetteer" ADD CONSTRAINT "location_gazetteer_location_id_83ac793c_fk_location_location_id" FOREIGN KEY ("location_id") REFERENCES "location_location"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "location_location" ADD CONSTRAINT "location_location_admin_level_id_a284d68e_fk_location_" FOREIGN KEY ("admin_level_id") REFERENCES "location_admlevel"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "location_location" ADD CONSTRAINT "location_location_parent_id_47fe0a9a_fk_location_location_id" FOREIGN KEY ("parent_id") REFERENCES "location_location"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "location_unmatchedlocation" ADD CONSTRAINT "location_unmatchedlo_matched_by_id_28d9898c_fk_auth_user" FOREIGN KEY ("matched_by_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "location_unmatchedlocation" ADD CONSTRAINT "location_unmatchedlo_resolved_location_id_f2624b22_fk_location_" FOREIGN KEY ("resolved_location_id") REFERENCES "location_location"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications_internalnotification" ADD CONSTRAINT "notifications_intern_alert_id_594d9ecb_fk_alerts_al" FOREIGN KEY ("alert_id") REFERENCES "alerts_alert"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications_internalnotification" ADD CONSTRAINT "notifications_intern_user_id_0bf4236f_fk_auth_user" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications_notificationpreference" ADD CONSTRAINT "notifications_notifi_user_id_7cfb3d3a_fk_auth_user" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "task_monitoring_taskexecution" ADD CONSTRAINT "task_monitoring_task_source_id_9cdbdc2f_fk_data_pipe" FOREIGN KEY ("source_id") REFERENCES "data_pipeline_source"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "task_monitoring_taskexecution" ADD CONSTRAINT "task_monitoring_task_task_type_id_d8e158a7_fk_task_moni" FOREIGN KEY ("task_type_id") REFERENCES "task_monitoring_tasktype"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "task_monitoring_taskexecution" ADD CONSTRAINT "task_monitoring_task_variable_id_1c8e4528_fk_data_pipe" FOREIGN KEY ("variable_id") REFERENCES "data_pipeline_variable"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "users_userprofile" ADD CONSTRAINT "users_userprofile_user_id_87251ef1_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

