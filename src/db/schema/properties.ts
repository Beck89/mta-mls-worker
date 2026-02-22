import {
  pgTable,
  varchar,
  numeric,
  integer,
  boolean,
  text,
  timestamp,
  date,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Custom geography column type for PostGIS GEOGRAPHY(POINT, 4326).
 * Drizzle doesn't have built-in PostGIS support, so we use a custom column.
 */
import { customType } from 'drizzle-orm/pg-core';

const geography = customType<{
  data: string;
  driverParam: string;
}>({
  dataType() {
    return 'geography(POINT, 4326)';
  },
  toDriver(value: string): string {
    return value;
  },
});

/**
 * TEXT[] array column helper.
 */
const textArray = customType<{
  data: string[];
  driverParam: string;
}>({
  dataType() {
    return 'text[]';
  },
  toDriver(value: string[]): string {
    return `{${value.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(',')}}`;
  },
});

// ─── Properties Table ────────────────────────────────────────────────────────

export const properties = pgTable(
  'properties',
  {
    // Primary identifiers
    listingKey: varchar('listing_key').primaryKey(),
    listingId: varchar('listing_id').unique(),
    listingIdDisplay: varchar('listing_id_display'),
    originatingSystem: varchar('originating_system').notNull(),

    // Pricing
    listPrice: numeric('list_price'),
    originalListPrice: numeric('original_list_price'),
    previousListPrice: numeric('previous_list_price'),

    // Status
    standardStatus: varchar('standard_status'),
    mlsStatus: varchar('mls_status'),

    // Property Attributes
    propertyType: varchar('property_type'),
    propertySubType: varchar('property_sub_type'),
    bedroomsTotal: integer('bedrooms_total'),
    bathroomsTotal: integer('bathrooms_total'),
    bathroomsFull: integer('bathrooms_full'),
    bathroomsHalf: integer('bathrooms_half'),
    livingArea: numeric('living_area'),
    livingAreaSource: varchar('living_area_source'),
    lotSizeAcres: numeric('lot_size_acres'),
    lotSizeSqft: numeric('lot_size_sqft'),
    yearBuilt: integer('year_built'),
    yearBuiltSource: varchar('year_built_source'),
    stories: integer('stories'),
    garageSpaces: integer('garage_spaces'),
    parkingTotal: integer('parking_total'),
    fireplacesTotal: integer('fireplaces_total'),
    newConstructionYn: boolean('new_construction_yn'),
    poolPrivateYn: boolean('pool_private_yn'),
    waterfrontYn: boolean('waterfront_yn'),
    horseYn: boolean('horse_yn'),
    associationYn: boolean('association_yn'),

    // Location / Geo
    geog: geography('geog'),
    latitude: numeric('latitude'),
    longitude: numeric('longitude'),
    streetNumber: varchar('street_number'),
    streetName: varchar('street_name'),
    streetSuffix: varchar('street_suffix'),
    unparsedAddress: varchar('unparsed_address'),
    city: varchar('city'),
    stateOrProvince: varchar('state_or_province'),
    postalCode: varchar('postal_code'),
    countyOrParish: varchar('county_or_parish'),
    country: varchar('country'),
    directions: text('directions'),
    subdivisionName: varchar('subdivision_name'),
    mlsAreaMajor: varchar('mls_area_major'),

    // Agent / Office References
    listAgentKey: varchar('list_agent_key'),
    listAgentMlsId: varchar('list_agent_mls_id'),
    listAgentFullName: varchar('list_agent_full_name'),
    listAgentEmail: varchar('list_agent_email'),
    listAgentPhone: varchar('list_agent_phone'),
    listOfficeKey: varchar('list_office_key'),
    listOfficeMlsId: varchar('list_office_mls_id'),
    listOfficeName: varchar('list_office_name'),
    listOfficePhone: varchar('list_office_phone'),
    buyerOfficeKey: varchar('buyer_office_key'),

    // Listing Metadata
    listingContractDate: date('listing_contract_date'),
    publicRemarks: text('public_remarks'),
    syndicationRemarks: text('syndication_remarks'),
    virtualTourUrl: varchar('virtual_tour_url'),
    internetDisplayYn: boolean('internet_display_yn'),
    internetValuationYn: boolean('internet_valuation_yn'),

    // Schools
    elementarySchool: varchar('elementary_school'),
    middleSchool: varchar('middle_school'),
    highSchool: varchar('high_school'),

    // Tax
    taxAssessedValue: numeric('tax_assessed_value'),
    taxYear: integer('tax_year'),
    taxLegalDesc: text('tax_legal_desc'),
    parcelNumber: varchar('parcel_number'),

    // Compensation
    buyerAgencyComp: varchar('buyer_agency_comp'),
    buyerAgencyCompType: varchar('buyer_agency_comp_type'),
    subAgencyComp: varchar('sub_agency_comp'),
    subAgencyCompType: varchar('sub_agency_comp_type'),

    // MLS Grid System Fields
    mlgCanView: boolean('mlg_can_view').notNull().default(true),
    mlgCanUse: textArray('mlg_can_use'),
    modificationTs: timestamp('modification_ts', { withTimezone: true }).notNull(),
    originatingModTs: timestamp('originating_mod_ts', { withTimezone: true }),
    photosChangeTs: timestamp('photos_change_ts', { withTimezone: true }),
    photosCount: integer('photos_count'),
    majorChangeTs: timestamp('major_change_ts', { withTimezone: true }),
    majorChangeType: varchar('major_change_type'),
    originalEntryTs: timestamp('original_entry_ts', { withTimezone: true }),

    // Array/Feature Fields
    appliances: textArray('appliances'),
    architecturalStyle: textArray('architectural_style'),
    basement: textArray('basement'),
    constructionMaterials: textArray('construction_materials'),
    cooling: textArray('cooling'),
    heating: textArray('heating'),
    exteriorFeatures: textArray('exterior_features'),
    interiorFeatures: textArray('interior_features'),
    flooring: textArray('flooring'),
    roof: textArray('roof'),
    sewer: textArray('sewer'),
    waterSource: textArray('water_source'),
    utilities: textArray('utilities'),
    lotFeatures: textArray('lot_features'),
    parkingFeatures: textArray('parking_features'),
    poolFeatures: textArray('pool_features'),
    fencing: textArray('fencing'),
    communityFeatures: textArray('community_features'),
    securityFeatures: textArray('security_features'),
    levels: textArray('levels'),
    view: textArray('view'),
    foundationDetails: textArray('foundation_details'),
    patioAndPorchFeatures: textArray('patio_porch_features'),
    waterfrontFeatures: textArray('waterfront_features'),
    windowFeatures: textArray('window_features'),
    greenEnergy: textArray('green_energy'),
    horseAmenities: textArray('horse_amenities'),
    specialConditions: textArray('special_conditions'),
    disclosures: textArray('disclosures'),
    propertyCondition: textArray('property_condition'),
    syndicateTo: textArray('syndicate_to'),

    // Local (MLS-specific) Fields
    localFields: jsonb('local_fields'),

    // Internal Tracking
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // GiST index on geog — map boundary queries
    index('idx_properties_geog').using('gist', table.geog),
    // B-tree indexes for common filters
    index('idx_properties_standard_status').on(table.standardStatus),
    index('idx_properties_property_type').on(table.propertyType),
    index('idx_properties_list_price').on(table.listPrice),
    index('idx_properties_modification_ts').on(table.modificationTs),
    index('idx_properties_postal_code').on(table.postalCode),
    index('idx_properties_city').on(table.city),
    index('idx_properties_subdivision').on(table.subdivisionName),
    // Composite index for common filter combo
    index('idx_properties_status_type_price').on(
      table.standardStatus,
      table.propertyType,
      table.listPrice,
    ),
    // GIN index on mlg_can_use for array containment queries
    index('idx_properties_mlg_can_use').using('gin', table.mlgCanUse),
  ],
);

export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;
