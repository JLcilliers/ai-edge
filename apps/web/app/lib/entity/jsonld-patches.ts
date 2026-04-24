import type {
  BrandTruth,
  FirmType,
  LawFirmBrandTruth,
  DentalBrandTruth,
  MarketingAgencyBrandTruth,
  ProviderBio,
  Address,
} from '@ai-edge/shared';

/**
 * JSON-LD patch generator (PLAN §5.6 item 4).
 *
 * Produces copy-pasteable `<script type="application/ld+json">` blocks
 * tailored to the firm's type + Brand Truth. Only emits blocks for types
 * the home-page scan *didn't* already find — patches are additive, not
 * replacements.
 *
 * Design notes:
 *   - Every block is self-contained. We don't try to link Person nodes to
 *     the Organization via @id references — CMSes and page builders often
 *     truncate whitespace or wrap scripts differently, and dangling @id
 *     references are worse than a flat block. A second pass could wire up
 *     @id graphs once we know where blocks are deployed.
 *   - We keep JSON-LD *conservative*. Don't emit fields we're not confident
 *     are correct (e.g. opening hours, price range) because wrong schema is
 *     worse than missing schema — it teaches Google incorrect facts.
 *   - All blocks include `@context` so they're valid standalone.
 */

export interface JsonLdPatch {
  type: string; // Schema.org @type
  reason: string; // short operator-facing explainer
  // Pretty-printed JSON-LD, ready to paste inside <script type="application/ld+json">
  jsonLd: string;
}

function jsonLdBlock(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function address(a: Address | undefined) {
  if (!a) return undefined;
  return {
    '@type': 'PostalAddress',
    streetAddress: a.street,
    addressLocality: a.city,
    addressRegion: a.region,
    postalCode: a.postal_code,
    addressCountry: a.country,
  };
}

/**
 * Map an attorney/dentist/team-member bio to a schema.org Person. Credentials
 * become `hasCredential` strings; bar / license numbers become `identifier`
 * under a `PropertyValue` so search engines can disambiguate two lawyers
 * with the same name.
 */
function personBlock(bio: ProviderBio, orgName: string): Record<string, unknown> {
  const credentials = bio.credentials?.length
    ? bio.credentials.map((c) => ({
        '@type': 'EducationalOccupationalCredential',
        name: c,
      }))
    : undefined;

  const identifiers: Array<Record<string, unknown>> = [];
  if (bio.bar_number) {
    identifiers.push({
      '@type': 'PropertyValue',
      propertyID: 'barNumber',
      value: bio.bar_number,
    });
  }
  if (bio.license_number) {
    identifiers.push({
      '@type': 'PropertyValue',
      propertyID: 'licenseNumber',
      value: bio.license_number,
    });
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: bio.name,
    jobTitle: bio.role,
    description: bio.bio,
    image: bio.photo_url,
    worksFor: { '@type': 'Organization', name: orgName },
    hasCredential: credentials,
    identifier: identifiers.length ? identifiers : undefined,
  };
}

/**
 * Core Organization / LegalService / Dentist block — this is the one that
 * feeds Google's Knowledge Panel + gets cited by LLMs as "according to
 * $firm.com".
 */
function orgBlock(firm: BrandTruth, siteUrl: string | null): Record<string, unknown> {
  const type =
    firm.firm_type === 'law_firm'
      ? 'LegalService'
      : firm.firm_type === 'dental_practice'
        ? 'Dentist'
        : firm.firm_type === 'marketing_agency'
          ? 'ProfessionalService'
          : 'Organization';

  const awards =
    firm.awards && firm.awards.length > 0
      ? firm.awards.map((a) => `${a.name}${a.year ? ' ' + a.year : ''}`)
      : undefined;

  return {
    '@context': 'https://schema.org',
    '@type': type,
    name: firm.firm_name,
    alternateName: firm.name_variants?.length ? firm.name_variants : undefined,
    legalName: firm.legal_entity,
    url: siteUrl ?? undefined,
    address: address(firm.headquarters),
    telephone: firm.headquarters?.phone,
    email: firm.headquarters?.email,
    award: awards,
    description: firm.tone_guidelines?.voice,
    knowsAbout:
      firm.firm_type === 'law_firm' || firm.firm_type === 'dental_practice'
        ? (firm as LawFirmBrandTruth | DentalBrandTruth).practice_areas
        : firm.firm_type === 'marketing_agency'
          ? (firm as MarketingAgencyBrandTruth).service_offerings.map((s) => s.name)
          : undefined,
  };
}

/**
 * Generate patches for the types the home-page scan found *missing*. The
 * caller passes the diff result from `schema-scan.ts`; we skip any type
 * the site already has.
 */
export function generateJsonLdPatches(args: {
  brandTruth: BrandTruth;
  firmType: FirmType;
  siteUrl: string | null;
  missingTypes: string[]; // subset of EXPECTED_TYPES_BY_FIRM[firm_type]
}): JsonLdPatch[] {
  const { brandTruth, firmType, siteUrl, missingTypes } = args;
  const patches: JsonLdPatch[] = [];
  const missing = new Set(missingTypes);

  // Organization / LegalService / Dentist / ProfessionalService share one
  // emission path — emit if *any* of them is missing, since they're roughly
  // alternatives (Google treats LegalService as a subtype of Organization).
  const orgTypes = ['Organization', 'LegalService', 'Dentist', 'MedicalBusiness', 'ProfessionalService'];
  const needsOrg = orgTypes.some((t) => missing.has(t));
  if (needsOrg) {
    patches.push({
      type: orgTypes.find((t) => missing.has(t)) ?? 'Organization',
      reason:
        'Primary entity block — this is what Google Knowledge Panel and LLM attribution key off.',
      jsonLd: jsonLdBlock(orgBlock(brandTruth, siteUrl)),
    });
  }

  // Person blocks per attorney / provider / team member. Only emit if the
  // site has no Person schema at all — otherwise the operator likely has
  // hand-crafted bios we shouldn't duplicate.
  if (missing.has('Person')) {
    const bios: ProviderBio[] =
      firmType === 'law_firm'
        ? (brandTruth as LawFirmBrandTruth).attorney_bios ?? []
        : firmType === 'dental_practice'
          ? (brandTruth as DentalBrandTruth).provider_bios ?? []
          : firmType === 'marketing_agency'
            ? (brandTruth as MarketingAgencyBrandTruth).team_members ?? []
            : [];

    // Cap at 5 in the patch preview — more than that and the copy-paste gets
    // unwieldy; the operator can extrapolate the pattern.
    for (const bio of bios.slice(0, 5)) {
      patches.push({
        type: 'Person',
        reason: `Schema for ${bio.name} — ties their name to the firm so LLMs attribute quotes correctly.`,
        jsonLd: jsonLdBlock(personBlock(bio, brandTruth.firm_name)),
      });
    }
  }

  // Address as a standalone block is rare — usually it lives inside the
  // Organization. Only emit when the org block is NOT being emitted (i.e.
  // site already has Organization but not PostalAddress inside it).
  if (missing.has('PostalAddress') && !needsOrg && brandTruth.headquarters) {
    patches.push({
      type: 'PostalAddress',
      reason:
        'NAP (name/address/phone) consistency check — standalone address block to pair with existing Organization.',
      jsonLd: jsonLdBlock({
        '@context': 'https://schema.org',
        ...address(brandTruth.headquarters),
      }),
    });
  }

  return patches;
}
