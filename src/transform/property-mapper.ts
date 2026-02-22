import type { NewProperty } from '../db/schema/properties.js';
import type { NewRoom } from '../db/schema/rooms.js';
import type { NewUnitType } from '../db/schema/unit-types.js';
import type { NewMedia } from '../db/schema/media.js';
import { buildR2ObjectKey } from '../storage/r2-client.js';

/**
 * Known MLS-local field prefixes. Any field starting with these + underscore
 * is routed to local_fields JSONB.
 */
const LOCAL_FIELD_PREFIXES = [
  'ACT_', 'CAR_', 'ECR_', 'FHR_', 'GSB_', 'NRA_', 'HMS_', 'HLM_', 'IRE_',
  'LCN_', 'LBR_', 'LSA_', 'MIS_', 'MBR_', 'MFR_', 'MRD_', 'NBR_', 'NOC_',
  'NST_', 'NWM_', 'OKC_', 'KEY_', 'PAR_', 'PWB_', 'PRA_', 'RAN_', 'REC_',
  'RMA_', 'RRA_', 'RTC_', 'SAR_', 'SCK_', 'SOM_', 'SPN_', 'SUN_',
];

function isLocalField(fieldName: string): boolean {
  return LOCAL_FIELD_PREFIXES.some((prefix) => fieldName.startsWith(prefix));
}

/**
 * Strip the MLS prefix from a listing ID for display purposes.
 * E.g., "ACT1475089" → "1475089"
 */
function stripPrefix(value: string | null | undefined): string | null {
  if (!value) return null;
  // Prefixes are 2-3 uppercase letters followed by digits/alphanumeric
  const match = value.match(/^[A-Z]{2,3}(.+)$/);
  return match ? match[1] : value;
}

export interface MlsGridPropertyRecord {
  [key: string]: unknown;
  ListingKey?: string;
  ListingId?: string;
  OriginatingSystemName?: string;
  ListPrice?: number;
  OriginalListPrice?: number;
  PreviousListPrice?: number;
  StandardStatus?: string;
  MlsStatus?: string;
  PropertyType?: string;
  PropertySubType?: string;
  BedroomsTotal?: number;
  BathroomsTotalInteger?: number;
  BathroomsFull?: number;
  BathroomsHalf?: number;
  LivingArea?: number;
  LivingAreaSource?: string;
  LotSizeAcres?: number;
  LotSizeSquareFeet?: number;
  YearBuilt?: number;
  YearBuiltSource?: string;
  Stories?: number;
  GarageSpaces?: number;
  ParkingTotal?: number;
  FireplacesTotal?: number;
  NewConstructionYN?: boolean;
  PoolPrivateYN?: boolean;
  WaterfrontYN?: boolean;
  HorseYN?: boolean;
  AssociationYN?: boolean;
  Latitude?: number;
  Longitude?: number;
  StreetNumber?: string;
  StreetName?: string;
  StreetSuffix?: string;
  UnparsedAddress?: string;
  City?: string;
  StateOrProvince?: string;
  PostalCode?: string;
  CountyOrParish?: string;
  Country?: string;
  Directions?: string;
  SubdivisionName?: string;
  MLSAreaMajor?: string;
  ListAgentKey?: string;
  ListAgentMlsId?: string;
  ListAgentFullName?: string;
  ListAgentEmail?: string;
  ListAgentDirectPhone?: string;
  ListOfficeKey?: string;
  ListOfficeMlsId?: string;
  ListOfficeName?: string;
  ListOfficePhone?: string;
  BuyerOfficeKey?: string;
  ListingContractDate?: string;
  PublicRemarks?: string;
  SyndicationRemarks?: string;
  VirtualTourURLUnbranded?: string;
  InternetEntireListingDisplayYN?: boolean;
  InternetAutomatedValuationDisplayYN?: boolean;
  ElementarySchool?: string;
  MiddleOrJuniorSchool?: string;
  HighSchool?: string;
  TaxAssessedValue?: number;
  TaxYear?: number;
  TaxLegalDescription?: string;
  ParcelNumber?: string;
  BuyerAgencyCompensation?: string;
  BuyerAgencyCompensationType?: string;
  SubAgencyCompensation?: string;
  SubAgencyCompensationType?: string;
  MlgCanView?: boolean;
  MlgCanUse?: string[];
  ModificationTimestamp?: string;
  OriginatingSystemModificationTimestamp?: string;
  PhotosChangeTimestamp?: string;
  PhotosCount?: number;
  MajorChangeTimestamp?: string;
  MajorChangeType?: string;
  OriginalEntryTimestamp?: string;
  // Array fields
  Appliances?: string[];
  ArchitecturalStyle?: string[];
  Basement?: string[];
  ConstructionMaterials?: string[];
  Cooling?: string[];
  Heating?: string[];
  ExteriorFeatures?: string[];
  InteriorFeatures?: string[];
  Flooring?: string[];
  Roof?: string[];
  Sewer?: string[];
  WaterSource?: string[];
  Utilities?: string[];
  LotFeatures?: string[];
  ParkingFeatures?: string[];
  PoolFeatures?: string[];
  Fencing?: string[];
  CommunityFeatures?: string[];
  SecurityFeatures?: string[];
  Levels?: string[];
  View?: string[];
  FoundationDetails?: string[];
  PatioAndPorchFeatures?: string[];
  WaterfrontFeatures?: string[];
  WindowFeatures?: string[];
  GreenEnergyEfficient?: string[];
  HorseAmenities?: string[];
  SpecialListingConditions?: string[];
  Disclosures?: string[];
  PropertyCondition?: string[];
  SyndicateTo?: string[];
  // Expanded sub-resources
  Media?: MlsGridMediaRecord[];
  Rooms?: MlsGridRoomRecord[];
  UnitTypes?: MlsGridUnitTypeRecord[];
}

export interface MlsGridMediaRecord {
  MediaKey?: string;
  MediaURL?: string;
  MediaModificationTimestamp?: string;
  Order?: number;
  MediaCategory?: string;
  [key: string]: unknown;
}

export interface MlsGridRoomRecord {
  RoomKey?: string;
  RoomType?: string;
  RoomDimensions?: string;
  RoomFeatures?: string | string[];
  [key: string]: unknown;
}

export interface MlsGridUnitTypeRecord {
  UnitTypeKey?: string;
  UnitTypeType?: string;
  UnitTypeBedsTotal?: number;
  UnitTypeBathsTotal?: number;
  UnitTypeActualRent?: number;
  [key: string]: unknown;
}

/**
 * Transform an MLS Grid property record into our DB property row.
 */
export function transformProperty(raw: MlsGridPropertyRecord): NewProperty {
  // Extract local fields
  const localFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isLocalField(key)) {
      localFields[key] = value;
    }
  }

  // Build geography point if lat/lng available
  const lat = raw.Latitude;
  const lng = raw.Longitude;
  const geog = lat != null && lng != null ? `SRID=4326;POINT(${lng} ${lat})` : null;

  return {
    listingKey: raw.ListingKey!,
    listingId: raw.ListingId ?? null,
    listingIdDisplay: stripPrefix(raw.ListingId),
    originatingSystem: raw.OriginatingSystemName ?? 'actris',

    listPrice: raw.ListPrice?.toString() ?? null,
    originalListPrice: raw.OriginalListPrice?.toString() ?? null,
    previousListPrice: raw.PreviousListPrice?.toString() ?? null,

    standardStatus: raw.StandardStatus ?? null,
    mlsStatus: raw.MlsStatus ?? null,

    propertyType: raw.PropertyType ?? null,
    propertySubType: raw.PropertySubType ?? null,
    bedroomsTotal: raw.BedroomsTotal?.toString() ?? null,
    bathroomsTotal: raw.BathroomsTotalInteger?.toString() ?? null,
    bathroomsFull: raw.BathroomsFull?.toString() ?? null,
    bathroomsHalf: raw.BathroomsHalf?.toString() ?? null,
    livingArea: raw.LivingArea?.toString() ?? null,
    livingAreaSource: raw.LivingAreaSource ?? null,
    lotSizeAcres: raw.LotSizeAcres?.toString() ?? null,
    lotSizeSqft: raw.LotSizeSquareFeet?.toString() ?? null,
    yearBuilt: raw.YearBuilt ?? null,
    yearBuiltSource: raw.YearBuiltSource ?? null,
    stories: raw.Stories?.toString() ?? null,
    garageSpaces: raw.GarageSpaces?.toString() ?? null,
    parkingTotal: raw.ParkingTotal?.toString() ?? null,
    fireplacesTotal: raw.FireplacesTotal?.toString() ?? null,
    newConstructionYn: raw.NewConstructionYN ?? null,
    poolPrivateYn: raw.PoolPrivateYN ?? null,
    waterfrontYn: raw.WaterfrontYN ?? null,
    horseYn: raw.HorseYN ?? null,
    associationYn: raw.AssociationYN ?? null,

    geog,
    latitude: lat?.toString() ?? null,
    longitude: lng?.toString() ?? null,
    streetNumber: raw.StreetNumber ?? null,
    streetName: raw.StreetName ?? null,
    streetSuffix: raw.StreetSuffix ?? null,
    unparsedAddress: raw.UnparsedAddress ?? null,
    city: raw.City ?? null,
    stateOrProvince: raw.StateOrProvince ?? null,
    postalCode: raw.PostalCode ?? null,
    countyOrParish: raw.CountyOrParish ?? null,
    country: raw.Country ?? null,
    directions: raw.Directions ?? null,
    subdivisionName: raw.SubdivisionName ?? null,
    mlsAreaMajor: raw.MLSAreaMajor ?? null,

    listAgentKey: raw.ListAgentKey ?? null,
    listAgentMlsId: raw.ListAgentMlsId ?? null,
    listAgentFullName: raw.ListAgentFullName ?? null,
    listAgentEmail: raw.ListAgentEmail ?? null,
    listAgentPhone: raw.ListAgentDirectPhone ?? null,
    listOfficeKey: raw.ListOfficeKey ?? null,
    listOfficeMlsId: raw.ListOfficeMlsId ?? null,
    listOfficeName: raw.ListOfficeName ?? null,
    listOfficePhone: raw.ListOfficePhone ?? null,
    buyerOfficeKey: raw.BuyerOfficeKey ?? null,

    listingContractDate: raw.ListingContractDate ?? null,
    publicRemarks: raw.PublicRemarks ?? null,
    syndicationRemarks: raw.SyndicationRemarks ?? null,
    virtualTourUrl: raw.VirtualTourURLUnbranded ?? null,
    internetDisplayYn: raw.InternetEntireListingDisplayYN ?? null,
    internetValuationYn: raw.InternetAutomatedValuationDisplayYN ?? null,

    elementarySchool: raw.ElementarySchool ?? null,
    middleSchool: raw.MiddleOrJuniorSchool ?? null,
    highSchool: raw.HighSchool ?? null,

    taxAssessedValue: raw.TaxAssessedValue?.toString() ?? null,
    taxYear: raw.TaxYear ?? null,
    taxLegalDesc: raw.TaxLegalDescription ?? null,
    parcelNumber: raw.ParcelNumber ?? null,

    buyerAgencyComp: raw.BuyerAgencyCompensation ?? null,
    buyerAgencyCompType: raw.BuyerAgencyCompensationType ?? null,
    subAgencyComp: raw.SubAgencyCompensation ?? null,
    subAgencyCompType: raw.SubAgencyCompensationType ?? null,

    mlgCanView: raw.MlgCanView ?? true,
    mlgCanUse: raw.MlgCanUse ?? null,
    modificationTs: new Date(raw.ModificationTimestamp!),
    originatingModTs: raw.OriginatingSystemModificationTimestamp
      ? new Date(raw.OriginatingSystemModificationTimestamp)
      : null,
    photosChangeTs: raw.PhotosChangeTimestamp ? new Date(raw.PhotosChangeTimestamp) : null,
    photosCount: raw.PhotosCount ?? null,
    majorChangeTs: raw.MajorChangeTimestamp ? new Date(raw.MajorChangeTimestamp) : null,
    majorChangeType: raw.MajorChangeType ?? null,
    originalEntryTs: raw.OriginalEntryTimestamp
      ? new Date(raw.OriginalEntryTimestamp)
      : null,

    appliances: raw.Appliances ?? null,
    architecturalStyle: raw.ArchitecturalStyle ?? null,
    basement: raw.Basement ?? null,
    constructionMaterials: raw.ConstructionMaterials ?? null,
    cooling: raw.Cooling ?? null,
    heating: raw.Heating ?? null,
    exteriorFeatures: raw.ExteriorFeatures ?? null,
    interiorFeatures: raw.InteriorFeatures ?? null,
    flooring: raw.Flooring ?? null,
    roof: raw.Roof ?? null,
    sewer: raw.Sewer ?? null,
    waterSource: raw.WaterSource ?? null,
    utilities: raw.Utilities ?? null,
    lotFeatures: raw.LotFeatures ?? null,
    parkingFeatures: raw.ParkingFeatures ?? null,
    poolFeatures: raw.PoolFeatures ?? null,
    fencing: raw.Fencing ?? null,
    communityFeatures: raw.CommunityFeatures ?? null,
    securityFeatures: raw.SecurityFeatures ?? null,
    levels: raw.Levels ?? null,
    view: raw.View ?? null,
    foundationDetails: raw.FoundationDetails ?? null,
    patioAndPorchFeatures: raw.PatioAndPorchFeatures ?? null,
    waterfrontFeatures: raw.WaterfrontFeatures ?? null,
    windowFeatures: raw.WindowFeatures ?? null,
    greenEnergy: raw.GreenEnergyEfficient ?? null,
    horseAmenities: raw.HorseAmenities ?? null,
    specialConditions: raw.SpecialListingConditions ?? null,
    disclosures: raw.Disclosures ?? null,
    propertyCondition: raw.PropertyCondition ?? null,
    syndicateTo: raw.SyndicateTo ?? null,

    localFields: Object.keys(localFields).length > 0 ? localFields : null,
    updatedAt: new Date(),
  };
}

/**
 * Transform MLS Grid room records into our DB room rows.
 */
export function transformRooms(
  listingKey: string,
  rawRooms: MlsGridRoomRecord[] | undefined,
): NewRoom[] {
  if (!rawRooms || rawRooms.length === 0) return [];

  return rawRooms.map((room) => ({
    roomKey: room.RoomKey!,
    listingKey,
    roomType: room.RoomType ?? null,
    roomDimensions: room.RoomDimensions ?? null,
    roomFeatures: Array.isArray(room.RoomFeatures)
      ? room.RoomFeatures
      : room.RoomFeatures
        ? [room.RoomFeatures]
        : null,
  }));
}

/**
 * Transform MLS Grid unit type records into our DB unit type rows.
 */
export function transformUnitTypes(
  listingKey: string,
  rawUnitTypes: MlsGridUnitTypeRecord[] | undefined,
): NewUnitType[] {
  if (!rawUnitTypes || rawUnitTypes.length === 0) return [];

  return rawUnitTypes.map((ut) => ({
    unitTypeKey: ut.UnitTypeKey!,
    listingKey,
    unitTypeType: ut.UnitTypeType ?? null,
    unitTypeBeds: ut.UnitTypeBedsTotal ?? null,
    unitTypeBaths: ut.UnitTypeBathsTotal?.toString() ?? null,
    unitTypeRent: ut.UnitTypeActualRent?.toString() ?? null,
  }));
}

/**
 * Transform MLS Grid media records into our DB media rows.
 * Sets status to 'pending_download' for the media download pipeline.
 */
export function transformMediaRecords(
  listingKey: string,
  resourceType: string,
  rawMedia: MlsGridMediaRecord[] | undefined,
): NewMedia[] {
  if (!rawMedia || rawMedia.length === 0) return [];

  return rawMedia.map((m, idx) => {
    const mediaKey = m.MediaKey!;
    const contentType = 'image/jpeg'; // Default; actual type determined during download
    const r2ObjectKey = buildR2ObjectKey(resourceType, listingKey, mediaKey, contentType);

    return {
      mediaKey,
      listingKey,
      resourceType,
      mediaUrlSource: m.MediaURL ?? null,
      r2ObjectKey,
      mediaModTs: m.MediaModificationTimestamp
        ? new Date(m.MediaModificationTimestamp)
        : null,
      mediaOrder: m.Order ?? idx,
      mediaCategory: m.MediaCategory ?? null,
      fileSizeBytes: null,
      contentType: null,
      status: 'pending_download',
      retryCount: 0,
    };
  });
}

/**
 * Strip expanded sub-resources from raw JSON for raw_responses storage.
 * We don't store Media/Rooms/UnitTypes in raw_responses because MediaURLs expire.
 */
export function stripExpandedResources(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...raw };
  delete cleaned.Media;
  delete cleaned.Rooms;
  delete cleaned.UnitTypes;
  return cleaned;
}
