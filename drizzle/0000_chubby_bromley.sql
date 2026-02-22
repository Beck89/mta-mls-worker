CREATE TABLE "properties" (
	"listing_key" varchar PRIMARY KEY NOT NULL,
	"listing_id" varchar,
	"listing_id_display" varchar,
	"originating_system" varchar NOT NULL,
	"list_price" numeric,
	"original_list_price" numeric,
	"previous_list_price" numeric,
	"standard_status" varchar,
	"mls_status" varchar,
	"property_type" varchar,
	"property_sub_type" varchar,
	"bedrooms_total" integer,
	"bathrooms_total" integer,
	"bathrooms_full" integer,
	"bathrooms_half" integer,
	"living_area" numeric,
	"living_area_source" varchar,
	"lot_size_acres" numeric,
	"lot_size_sqft" numeric,
	"year_built" integer,
	"year_built_source" varchar,
	"stories" integer,
	"garage_spaces" integer,
	"parking_total" integer,
	"fireplaces_total" integer,
	"new_construction_yn" boolean,
	"pool_private_yn" boolean,
	"waterfront_yn" boolean,
	"horse_yn" boolean,
	"association_yn" boolean,
	"geog" geography(POINT, 4326),
	"latitude" numeric,
	"longitude" numeric,
	"street_number" varchar,
	"street_name" varchar,
	"street_suffix" varchar,
	"unparsed_address" varchar,
	"city" varchar,
	"state_or_province" varchar,
	"postal_code" varchar,
	"county_or_parish" varchar,
	"country" varchar,
	"directions" text,
	"subdivision_name" varchar,
	"mls_area_major" varchar,
	"list_agent_key" varchar,
	"list_agent_mls_id" varchar,
	"list_agent_full_name" varchar,
	"list_agent_email" varchar,
	"list_agent_phone" varchar,
	"list_office_key" varchar,
	"list_office_mls_id" varchar,
	"list_office_name" varchar,
	"list_office_phone" varchar,
	"buyer_office_key" varchar,
	"listing_contract_date" date,
	"public_remarks" text,
	"syndication_remarks" text,
	"virtual_tour_url" varchar,
	"internet_display_yn" boolean,
	"internet_valuation_yn" boolean,
	"elementary_school" varchar,
	"middle_school" varchar,
	"high_school" varchar,
	"tax_assessed_value" numeric,
	"tax_year" integer,
	"tax_legal_desc" text,
	"parcel_number" varchar,
	"buyer_agency_comp" varchar,
	"buyer_agency_comp_type" varchar,
	"sub_agency_comp" varchar,
	"sub_agency_comp_type" varchar,
	"mlg_can_view" boolean DEFAULT true NOT NULL,
	"mlg_can_use" text[],
	"modification_ts" timestamp with time zone NOT NULL,
	"originating_mod_ts" timestamp with time zone,
	"photos_change_ts" timestamp with time zone,
	"photos_count" integer,
	"major_change_ts" timestamp with time zone,
	"major_change_type" varchar,
	"original_entry_ts" timestamp with time zone,
	"appliances" text[],
	"architectural_style" text[],
	"basement" text[],
	"construction_materials" text[],
	"cooling" text[],
	"heating" text[],
	"exterior_features" text[],
	"interior_features" text[],
	"flooring" text[],
	"roof" text[],
	"sewer" text[],
	"water_source" text[],
	"utilities" text[],
	"lot_features" text[],
	"parking_features" text[],
	"pool_features" text[],
	"fencing" text[],
	"community_features" text[],
	"security_features" text[],
	"levels" text[],
	"view" text[],
	"foundation_details" text[],
	"patio_porch_features" text[],
	"waterfront_features" text[],
	"window_features" text[],
	"green_energy" text[],
	"horse_amenities" text[],
	"special_conditions" text[],
	"disclosures" text[],
	"property_condition" text[],
	"syndicate_to" text[],
	"local_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "properties_listing_id_unique" UNIQUE("listing_id")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"media_key" varchar PRIMARY KEY NOT NULL,
	"listing_key" varchar NOT NULL,
	"resource_type" varchar NOT NULL,
	"media_url_source" varchar,
	"r2_object_key" varchar NOT NULL,
	"public_url" varchar,
	"media_mod_ts" timestamp with time zone,
	"media_order" integer,
	"media_category" varchar,
	"file_size_bytes" bigint,
	"content_type" varchar,
	"status" varchar DEFAULT 'pending_download' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"room_key" varchar PRIMARY KEY NOT NULL,
	"listing_key" varchar NOT NULL,
	"room_type" varchar,
	"room_dimensions" varchar,
	"room_features" text[]
);
--> statement-breakpoint
CREATE TABLE "unit_types" (
	"unit_type_key" varchar PRIMARY KEY NOT NULL,
	"listing_key" varchar NOT NULL,
	"unit_type_type" varchar,
	"unit_type_beds" integer,
	"unit_type_baths" numeric,
	"unit_type_rent" numeric
);
--> statement-breakpoint
CREATE TABLE "members" (
	"member_key" varchar PRIMARY KEY NOT NULL,
	"member_mls_id" varchar,
	"originating_system" varchar NOT NULL,
	"member_full_name" varchar,
	"member_email" varchar,
	"member_phone" varchar,
	"office_key" varchar,
	"member_designation" text[],
	"photos_change_ts" timestamp with time zone,
	"mlg_can_view" boolean DEFAULT true NOT NULL,
	"modification_ts" timestamp with time zone NOT NULL,
	"local_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "members_member_mls_id_unique" UNIQUE("member_mls_id")
);
--> statement-breakpoint
CREATE TABLE "offices" (
	"office_key" varchar PRIMARY KEY NOT NULL,
	"office_mls_id" varchar,
	"originating_system" varchar NOT NULL,
	"office_name" varchar,
	"office_phone" varchar,
	"office_email" varchar,
	"office_address" varchar,
	"office_city" varchar,
	"office_state" varchar,
	"office_postal_code" varchar,
	"photos_change_ts" timestamp with time zone,
	"mlg_can_view" boolean DEFAULT true NOT NULL,
	"modification_ts" timestamp with time zone NOT NULL,
	"local_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "offices_office_mls_id_unique" UNIQUE("office_mls_id")
);
--> statement-breakpoint
CREATE TABLE "open_houses" (
	"open_house_key" varchar PRIMARY KEY NOT NULL,
	"listing_id" varchar NOT NULL,
	"originating_system" varchar NOT NULL,
	"open_house_date" date,
	"open_house_start" timestamp with time zone,
	"open_house_end" timestamp with time zone,
	"open_house_remarks" text,
	"showing_agent_key" varchar,
	"mlg_can_view" boolean DEFAULT true NOT NULL,
	"modification_ts" timestamp with time zone NOT NULL,
	"local_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "lookups" (
	"lookup_key" varchar PRIMARY KEY NOT NULL,
	"lookup_name" varchar NOT NULL,
	"lookup_value" varchar NOT NULL,
	"standard_lookup_value" varchar,
	"originating_system" varchar NOT NULL,
	"mlg_can_view" boolean DEFAULT true NOT NULL,
	"modification_ts" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "raw_responses" (
	"listing_key" varchar PRIMARY KEY NOT NULL,
	"raw_data" jsonb NOT NULL,
	"originating_system" varchar NOT NULL,
	"received_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"listing_key" varchar NOT NULL,
	"old_price" numeric,
	"new_price" numeric NOT NULL,
	"change_type" varchar,
	"modification_ts" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "property_change_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"listing_key" varchar NOT NULL,
	"field_name" varchar NOT NULL,
	"old_value" text,
	"new_value" text,
	"modification_ts" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "status_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"listing_key" varchar NOT NULL,
	"old_status" varchar,
	"new_status" varchar NOT NULL,
	"modification_ts" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "media_downloads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint,
	"media_key" varchar NOT NULL,
	"listing_key" varchar NOT NULL,
	"file_size_bytes" bigint,
	"download_time_ms" integer,
	"r2_upload_time_ms" integer,
	"status" varchar NOT NULL,
	"error_message" text,
	"downloaded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replication_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"request_url" text NOT NULL,
	"http_status" integer,
	"response_time_ms" integer,
	"response_bytes" bigint,
	"records_returned" integer,
	"requested_at" timestamp with time zone NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "replication_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"resource_type" varchar NOT NULL,
	"run_mode" varchar NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" varchar NOT NULL,
	"error_message" text,
	"hwm_start" timestamp with time zone,
	"hwm_end" timestamp with time zone,
	"total_records_received" integer DEFAULT 0,
	"records_inserted" integer DEFAULT 0,
	"records_updated" integer DEFAULT 0,
	"records_deleted" integer DEFAULT 0,
	"media_downloaded" integer DEFAULT 0,
	"media_deleted" integer DEFAULT 0,
	"media_bytes_downloaded" bigint DEFAULT 0,
	"api_requests_made" integer DEFAULT 0,
	"api_bytes_downloaded" bigint DEFAULT 0,
	"avg_response_time_ms" integer,
	"http_errors" jsonb
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_listing_key_properties_listing_key_fk" FOREIGN KEY ("listing_key") REFERENCES "public"."properties"("listing_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_listing_key_properties_listing_key_fk" FOREIGN KEY ("listing_key") REFERENCES "public"."properties"("listing_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_types" ADD CONSTRAINT "unit_types_listing_key_properties_listing_key_fk" FOREIGN KEY ("listing_key") REFERENCES "public"."properties"("listing_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_properties_geog" ON "properties" USING gist ("geog");--> statement-breakpoint
CREATE INDEX "idx_properties_standard_status" ON "properties" USING btree ("standard_status");--> statement-breakpoint
CREATE INDEX "idx_properties_property_type" ON "properties" USING btree ("property_type");--> statement-breakpoint
CREATE INDEX "idx_properties_list_price" ON "properties" USING btree ("list_price");--> statement-breakpoint
CREATE INDEX "idx_properties_modification_ts" ON "properties" USING btree ("modification_ts");--> statement-breakpoint
CREATE INDEX "idx_properties_postal_code" ON "properties" USING btree ("postal_code");--> statement-breakpoint
CREATE INDEX "idx_properties_city" ON "properties" USING btree ("city");--> statement-breakpoint
CREATE INDEX "idx_properties_subdivision" ON "properties" USING btree ("subdivision_name");--> statement-breakpoint
CREATE INDEX "idx_properties_status_type_price" ON "properties" USING btree ("standard_status","property_type","list_price");--> statement-breakpoint
CREATE INDEX "idx_properties_mlg_can_use" ON "properties" USING gin ("mlg_can_use");--> statement-breakpoint
CREATE INDEX "idx_media_listing_order" ON "media" USING btree ("listing_key","media_order");--> statement-breakpoint
CREATE INDEX "idx_media_resource_type" ON "media" USING btree ("resource_type");--> statement-breakpoint
CREATE INDEX "idx_media_status" ON "media" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_lookups_system_name" ON "lookups" USING btree ("originating_system","lookup_name");--> statement-breakpoint
CREATE INDEX "idx_price_history_listing" ON "price_history" USING btree ("listing_key");--> statement-breakpoint
CREATE INDEX "idx_price_history_recorded" ON "price_history" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_change_log_listing_field" ON "property_change_log" USING btree ("listing_key","field_name");--> statement-breakpoint
CREATE INDEX "idx_change_log_recorded" ON "property_change_log" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_status_history_listing" ON "status_history" USING btree ("listing_key");--> statement-breakpoint
CREATE INDEX "idx_status_history_recorded" ON "status_history" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_media_downloads_run" ON "media_downloads" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_media_downloads_at" ON "media_downloads" USING btree ("downloaded_at");--> statement-breakpoint
CREATE INDEX "idx_repl_requests_run" ON "replication_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_repl_requests_at" ON "replication_requests" USING btree ("requested_at");