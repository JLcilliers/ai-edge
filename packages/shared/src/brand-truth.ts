import { z } from 'zod';

/**
 * Brand Truth — declarative firm identity that audit runs score against.
 * Discriminated on `firm_type` so the editor renders only the fields that
 * match the tenant's category and so compliance rulebooks load correctly.
 * Every edit creates a new `brand_truth_version` row (ADR-0007).
 */

// ── Primitives ─────────────────────────────────────────────
export const firmTypeSchema = z.enum([
  'law_firm',
  'dental_practice',
  'marketing_agency',
  'other',
]);
export type FirmType = z.infer<typeof firmTypeSchema>;

export const addressSchema = z.object({
  street: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().length(2).default('US'),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});
export type Address = z.infer<typeof addressSchema>;

export const geographySchema = z.object({
  city: z.string().min(1),
  state: z.string().min(2).max(3),
  country: z.string().length(2).default('US'),
  radius_mi: z.number().int().positive().max(500),
});
export type Geography = z.infer<typeof geographySchema>;

export const bannedClaimSchema = z.object({
  claim: z.string().min(1),
  reason: z.string().min(1),
  source_rule: z.string().optional(), // 'FTC 16 CFR 255', 'TX Bar Rule 7.02', 'TSBDE 108.54', 'GDC 1.3.1'
});
export type BannedClaim = z.infer<typeof bannedClaimSchema>;

export const awardSchema = z.object({
  name: z.string(),
  year: z.number().int().min(1900).max(2100).optional(),
  source_url: z.string().url().optional(),
  source_required: z.boolean().default(true),
  verification_status: z
    .enum(['verified', 'unverified_at_ingestion', 'pending'])
    .default('unverified_at_ingestion'),
  notes: z.string().optional(),
});
export type Award = z.infer<typeof awardSchema>;

export const providerBioSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  credentials: z.array(z.string()).default([]),
  bio: z.string().optional(),
  photo_url: z.string().url().optional(),
  bar_number: z.string().optional(),     // law_firm
  license_number: z.string().optional(), // dental / medical
});
export type ProviderBio = z.infer<typeof providerBioSchema>;

export const notableCaseSchema = z.object({
  summary: z.string(),
  outcome: z.string().optional(),
  jurisdiction: z.string().optional(),
  source_url: z.string().url().optional(),
});
export type NotableCase = z.infer<typeof notableCaseSchema>;

export const serviceOfferingSchema = z.object({
  name: z.string(),
  scope: z.string(),
});
export type ServiceOffering = z.infer<typeof serviceOfferingSchema>;

export const targetAudienceSchema = z.object({
  primary_verticals: z.array(z.string()).default([]),
  secondary_verticals: z.array(z.string()).default([]),
  firmographic: z.string().optional(),
  persona: z.string().optional(),
});
export type TargetAudience = z.infer<typeof targetAudienceSchema>;

export const toneGuidelinesSchema = z.object({
  voice: z.string(),
  register: z.string().optional(),
  avoid: z.array(z.string()).default([]),
});
export type ToneGuidelines = z.infer<typeof toneGuidelinesSchema>;

export const publicClientSchema = z.object({
  name: z.string(),
  vertical: z.string().optional(),
  location: z.string().optional(),
  testimonial_quote: z.string().optional(),
  attribution: z.string().optional(),
  source_url: z.string().url().optional(),
  // FTC 16 CFR 255: material connections must be disclosed on testimonials
  // from anyone with a current business relationship with the firm.
  ftc_material_connection_disclosed: z.boolean().default(false),
});
export type PublicClient = z.infer<typeof publicClientSchema>;

export const pressItemSchema = z.object({
  outlet: z.string(),
  title: z.string(),
  url: z.string().url(),
  date: z.string().optional(),
});
export type PressItem = z.infer<typeof pressItemSchema>;

// ── Shared base fields (all firm types) ────────────────────
const baseFields = {
  firm_name: z.string().min(1),
  name_variants: z.array(z.string()).default([]),
  common_misspellings: z.array(z.string()).default([]),
  legal_entity: z.string().optional(),
  headquarters: addressSchema.optional(),
  unique_differentiators: z.array(z.string()).default([]),
  required_positioning_phrases: z.array(z.string()).default([]),
  banned_claims: z.array(bannedClaimSchema).default([]),
  awards: z.array(awardSchema).default([]),
  tone_guidelines: toneGuidelinesSchema.optional(),
  target_audience: targetAudienceSchema.optional(),
  brand_values: z.array(z.string()).default([]),
  compliance_jurisdictions: z.array(z.string()).default([]),
  seed_query_intents: z.array(z.string()).default([]),
  competitors_for_llm_monitoring: z.array(z.string()).default([]),
  known_press_and_media: z.array(pressItemSchema).default([]),
} as const;

// ── Law firm ───────────────────────────────────────────────
export const lawFirmBrandTruth = z.object({
  ...baseFields,
  firm_type: z.literal('law_firm'),
  practice_areas: z.array(z.string()).min(1),
  geographies_served: z.array(geographySchema).min(1),
  attorney_bios: z.array(providerBioSchema).default([]),
  notable_cases: z.array(notableCaseSchema).default([]),
});

// ── Dental practice ────────────────────────────────────────
export const dentalBrandTruth = z.object({
  ...baseFields,
  firm_type: z.literal('dental_practice'),
  practice_areas: z.array(z.string()).min(1),
  geographies_served: z.array(geographySchema).min(1),
  provider_bios: z.array(providerBioSchema).default([]),
});

// ── Marketing agency ───────────────────────────────────────
export const marketingAgencyBrandTruth = z.object({
  ...baseFields,
  firm_type: z.literal('marketing_agency'),
  service_offerings: z.array(serviceOfferingSchema).min(1),
  service_areas: z.array(z.string()).min(1),
  team_members: z.array(providerBioSchema).default([]),
  key_clients_public: z.array(publicClientSchema).default([]),
});

// ── Other (escape hatch) ───────────────────────────────────
export const otherBrandTruth = z.object({
  ...baseFields,
  firm_type: z.literal('other'),
  service_offerings: z.array(serviceOfferingSchema).default([]),
  service_areas: z.array(z.string()).default([]),
  custom_fields: z.record(z.string(), z.unknown()).default({}),
});

// ── Discriminated union ────────────────────────────────────
export const brandTruthSchema = z.discriminatedUnion('firm_type', [
  lawFirmBrandTruth,
  dentalBrandTruth,
  marketingAgencyBrandTruth,
  otherBrandTruth,
]);

export type BrandTruth = z.infer<typeof brandTruthSchema>;
export type LawFirmBrandTruth = z.infer<typeof lawFirmBrandTruth>;
export type DentalBrandTruth = z.infer<typeof dentalBrandTruth>;
export type MarketingAgencyBrandTruth = z.infer<typeof marketingAgencyBrandTruth>;
export type OtherBrandTruth = z.infer<typeof otherBrandTruth>;

// ── Compliance jurisdiction defaults by firm_type ──────────
export const DEFAULT_COMPLIANCE_JURISDICTIONS: Record<FirmType, string[]> = {
  law_firm: [],                      // populated per-state from geographies_served
  dental_practice: [],               // populated per-state + 'UK-GDC' when country=GB
  marketing_agency: ['US-FTC-AGENCY'],
  other: [],
};
