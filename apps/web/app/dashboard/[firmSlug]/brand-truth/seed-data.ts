import type { BrandTruth } from '@ai-edge/shared';
import { DEFAULT_COMPLIANCE_JURISDICTIONS } from '@ai-edge/shared';
import type { FirmType } from '../../../actions/firm-actions';

/**
 * Build an empty Brand Truth payload for a newly-created client.
 * Uses sensible defaults per firm_type so the editor can render immediately;
 * required-min-1 arrays (practice_areas, service_offerings, etc.) are left
 * empty so Zod will force the user to populate them before the first save.
 */
export function emptySeed(firm: { name: string; firm_type: FirmType }): BrandTruth {
  const base = {
    firm_name: firm.name,
    name_variants: [],
    common_misspellings: [],
    unique_differentiators: [],
    required_positioning_phrases: [],
    banned_claims: [],
    awards: [],
    brand_values: [],
    compliance_jurisdictions:
      DEFAULT_COMPLIANCE_JURISDICTIONS[firm.firm_type] ?? [],
    seed_query_intents: [],
    competitors_for_llm_monitoring: [],
    known_press_and_media: [],
  };

  switch (firm.firm_type) {
    case 'law_firm':
      return {
        ...base,
        firm_type: 'law_firm',
        practice_areas: [],
        geographies_served: [],
        attorney_bios: [],
        notable_cases: [],
      } as unknown as BrandTruth;
    case 'dental_practice':
      return {
        ...base,
        firm_type: 'dental_practice',
        practice_areas: [],
        geographies_served: [],
        provider_bios: [],
      } as unknown as BrandTruth;
    case 'marketing_agency':
      return {
        ...base,
        firm_type: 'marketing_agency',
        service_offerings: [],
        service_areas: [],
        team_members: [],
        key_clients_public: [],
      } as unknown as BrandTruth;
    case 'other':
      return {
        ...base,
        firm_type: 'other',
        service_offerings: [],
        service_areas: [],
        custom_fields: {},
      } as unknown as BrandTruth;
  }
}
