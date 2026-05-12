/**
 * Brand Messaging Standardization deliverable builders:
 *   - messaging_framework_md   (Step 2-3): one-liner 60/140/250 +
 *     elevator pitch + use cases + competitor angles + target audience
 *   - schema_bundle_jsonld     (Step 6): Organization + the right
 *     vertical schema (LegalService / SoftwareApplication / Dentist /
 *     LocalBusiness) + FAQPage
 *   - messaging_guide_md       (Step 7): internal team doc with all
 *     five SOP sections
 *
 * Plus the third-party-listing ticket factory (Step 4): one ticket per
 * platform in Brand Truth's third_party_listings, in the SOP priority
 * order (Wikipedia → LinkedIn → G2 → ...).
 */

import { put } from '@vercel/blob';
import { getDb, brandTruthVersions, firms } from '@ai-edge/db';
import { eq, desc } from 'drizzle-orm';
import type { BrandTruth } from '@ai-edge/shared';
import { createTicketFromStep } from '../../../actions/sop-actions';

interface BuildArgs {
  firmId: string;
  firmName: string;
  generatedAt: Date;
}

interface MessagingArtifacts {
  framework: { filename: string; blobUrl: string | null; bytes: number };
  schemaBundle: { filename: string; blobUrl: string | null; bytes: number };
  guide: { filename: string; blobUrl: string | null; bytes: number };
}

async function loadBrandTruth(firmId: string): Promise<BrandTruth | null> {
  const db = getDb();
  const [row] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  return (row?.payload ?? null) as BrandTruth | null;
}

/**
 * Trim a long positioning statement into the SOP's three character-count
 * variations. Naive truncation at clause boundaries — operator overrides
 * via the workflow UI on Step 2.
 */
function trimVariations(positioning: string): {
  short60: string;
  standard140: string;
  extended250: string;
} {
  const sentences = positioning.split(/[.!?](?=\s|$)/).map((s) => s.trim()).filter(Boolean);
  const oneLiner = sentences[0] ?? positioning;
  const trimTo = (n: number, src: string): string => {
    if (src.length <= n) return src;
    // Try to cut at the last word boundary before n.
    const cut = src.slice(0, n - 1);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > n * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
  };
  return {
    short60: trimTo(60, oneLiner),
    standard140: trimTo(140, oneLiner),
    extended250: trimTo(250, sentences.slice(0, 2).join('. ') + '.'),
  };
}

function buildMessagingFrameworkMd(bt: BrandTruth, firmName: string): string {
  const positioning =
    (bt as { positioning_statement?: string }).positioning_statement ??
    'No positioning statement set in Brand Truth.';
  const variations = trimVariations(positioning);
  const useCases =
    (bt as { use_cases?: string[]; key_services?: string[] }).use_cases ??
    (bt as { key_services?: string[] }).key_services ??
    [];
  const target =
    (bt as { target_audience?: string }).target_audience ??
    'Target audience not defined in Brand Truth.';

  return `# Messaging Framework — ${firmName}

> Source of truth: Brand Truth v${bt.firm_name ? 'latest' : '?'}. Update this doc only by editing Brand Truth, then re-running Brand Messaging Standardization → Step 3.

## One-Line Definition

**Approved positioning:**

> ${positioning}

### Character-Count Variations

| Length | Use case | Text |
|---|---|---|
| ${variations.short60.length} chars | Twitter bios, button text | ${variations.short60} |
| ${variations.standard140.length} chars | Most directories, meta descriptions | ${variations.standard140} |
| ${variations.extended250.length} chars | LinkedIn, G2, detailed listings | ${variations.extended250} |

## Core Use Cases

${useCases.length > 0 ? useCases.map((u, i) => `${i + 1}. ${u}`).join('\n') : '_No use cases defined in Brand Truth_'}

## Target Audience

${target}

## Do's and Don'ts

**Do use:**
- The approved positioning verbatim across all first-party surfaces (homepage, about, meta description)
- The 60-char version for tight space (button text, footer tagline)
- Parallel structure when listing use cases (all start with verbs)

**Don't use:**
- Superlatives ("best", "leading", "revolutionary") — LLMs filter these as marketing speak
- Buzzword-loaded phrases ("next-generation", "cutting-edge")
- Old terminology (catalogued in the Legacy Content Suppression SOP findings)
`;
}

function buildSchemaBundleJsonLd(bt: BrandTruth, firmName: string): string {
  const positioning =
    (bt as { positioning_statement?: string }).positioning_statement ?? '';
  const primaryUrl =
    (bt as { primary_url?: string }).primary_url ?? '';
  const firmType = bt.firm_type ?? 'law_firm';

  const schemaType = firmType === 'law_firm' ? 'LegalService' : firmType === 'dental_practice' ? 'Dentist' : firmType === 'marketing_agency' ? 'Organization' : 'LocalBusiness';

  const organizationSchema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: firmName,
    url: primaryUrl,
    description: positioning,
    sameAs: ((bt as { third_party_listings?: { url: string }[] }).third_party_listings ?? [])
      .map((t) => t.url)
      .filter(Boolean),
  };

  const verticalSchema = {
    '@context': 'https://schema.org',
    '@type': schemaType,
    name: firmName,
    url: primaryUrl,
    description: positioning,
  };

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: `What is ${firmName}?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: positioning,
        },
      },
    ],
  };

  return `# Schema Bundle — ${firmName}

Drop each \`<script>\` block in the page's \`<head>\`. Validate with Google Rich Results Test before pushing to production.

## 1. Organization Schema (homepage)

\`\`\`html
<script type="application/ld+json">
${JSON.stringify(organizationSchema, null, 2)}
</script>
\`\`\`

## 2. ${schemaType} Schema (homepage or services page)

\`\`\`html
<script type="application/ld+json">
${JSON.stringify(verticalSchema, null, 2)}
</script>
\`\`\`

## 3. FAQPage Schema (about / FAQ section)

\`\`\`html
<script type="application/ld+json">
${JSON.stringify(faqSchema, null, 2)}
</script>
\`\`\`

## Validation

- Test each schema block at https://search.google.com/test/rich-results
- Verify "no errors" before committing to production
- Re-validate after every page rebuild
`;
}

function buildMessagingGuideMd(bt: BrandTruth, firmName: string): string {
  const framework = buildMessagingFrameworkMd(bt, firmName);
  const listings = (bt as { third_party_listings?: { name?: string; url: string }[] }).third_party_listings ?? [];

  return `# Brand Messaging Guide — ${firmName}

> The internal source of truth for everyone who writes about ${firmName} — marketing, sales, support, executive comms. Update quarterly. The canonical positioning lives in Brand Truth; this guide is the human-readable expansion.

---

## Section 1 · Core Messaging

${framework}

---

## Section 2 · Platform-Specific Templates

For each third-party platform we control, the approved copy + the admin URL where it gets updated:

${
  listings.length > 0
    ? listings.map((l) => `- **${l.name ?? new URL(l.url).host}**: ${l.url}`).join('\n')
    : '_No third-party listings inventoried yet. Add them to Brand Truth → third_party_listings then re-run this guide._'
}

---

## Section 3 · Boilerplate Text

**Press release boilerplate:**

> ${(bt as { positioning_statement?: string }).positioning_statement ?? '[positioning statement]'}

**Email signature (one-liner):**

> ${(bt as { positioning_statement?: string }).positioning_statement?.split('.')[0] ?? '[positioning]'}

**Slide deck "About Us" slide:**

> ${(bt as { positioning_statement?: string }).positioning_statement ?? '[positioning]'}

---

## Section 4 · Update Schedule

| Cadence | Action | Owner |
|---|---|---|
| Quarterly | Re-run Brand Messaging Standardization SOP | Marketing lead |
| 4-6 weeks | Re-run Brand Visibility Audit to verify LLM uptake | Marketing lead |
| As needed | Update Brand Truth when positioning changes | CMO / founder |

How to request changes: edit Brand Truth in the dashboard. The Brand Messaging Standardization SOP will auto-suggest a re-run when material changes are detected.

---

## Section 5 · Third-Party Platform Log

| Platform | URL | Last verified | Status |
|---|---|---|---|
${listings.length > 0
  ? listings.map((l) => `| ${l.name ?? new URL(l.url).host} | ${l.url} | _verify on next SOP run_ | _pending_ |`).join('\n')
  : '| (no platforms inventoried) | — | — | — |'
}

_Generated by Clixsy Intercept · ${new Date().toISOString()}_
`;
}

async function uploadOrFallback(
  filename: string,
  body: string,
  contentType: string,
): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const blob = await put(`sop-deliverables/${filename}`, body, {
      access: 'public',
      contentType,
    });
    return blob.url;
  } catch (e) {
    console.error('[messaging] blob upload failed:', e);
    return null;
  }
}

export async function buildMessagingArtifacts(args: BuildArgs): Promise<MessagingArtifacts | null> {
  const bt = await loadBrandTruth(args.firmId);
  if (!bt) return null;

  const slug = args.firmName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const datestamp = args.generatedAt.toISOString().slice(0, 10);

  const frameworkMd = buildMessagingFrameworkMd(bt, args.firmName);
  const frameworkFile = `messaging-framework-${slug}-${datestamp}.md`;
  const frameworkUrl = await uploadOrFallback(frameworkFile, frameworkMd, 'text/markdown');

  const schemaMd = buildSchemaBundleJsonLd(bt, args.firmName);
  const schemaFile = `schema-bundle-${slug}-${datestamp}.md`;
  const schemaUrl = await uploadOrFallback(schemaFile, schemaMd, 'text/markdown');

  const guideMd = buildMessagingGuideMd(bt, args.firmName);
  const guideFile = `messaging-guide-${slug}-${datestamp}.md`;
  const guideUrl = await uploadOrFallback(guideFile, guideMd, 'text/markdown');

  return {
    framework: { filename: frameworkFile, blobUrl: frameworkUrl, bytes: frameworkMd.length },
    schemaBundle: { filename: schemaFile, blobUrl: schemaUrl, bytes: schemaMd.length },
    guide: { filename: guideFile, blobUrl: guideUrl, bytes: guideMd.length },
  };
}

// ─── Ticket factory: third_party_listing_updates ──────────────────────

interface FactoryArgs {
  firmSlug: string;
  firmId: string;
  firmName: string;
  sopKey: 'brand_messaging_standardization';
  runId: string;
  stepNumber: number;
}

// Priority order per the SOP doc.
const PLATFORM_PRIORITY: Record<string, number> = {
  'en.wikipedia.org': 1,
  'wikidata.org': 1,
  'linkedin.com': 2,
  'g2.com': 3,
  'capterra.com': 3,
  'trustradius.com': 3,
  'crunchbase.com': 4,
  'producthunt.com': 5,
};

function priorityForUrl(url: string): number {
  try {
    const host = new URL(url).host.replace(/^www\./, '');
    return PLATFORM_PRIORITY[host] ?? 10;
  } catch {
    return 10;
  }
}

export async function generateThirdPartyListingTickets(args: FactoryArgs): Promise<{
  created: Array<{ id: string; title: string; priorityRank: number }>;
}> {
  const bt = await loadBrandTruth(args.firmId);
  if (!bt) return { created: [] };
  const listings = (bt as { third_party_listings?: { name?: string; url: string }[] }).third_party_listings ?? [];
  if (listings.length === 0) return { created: [] };
  const positioning = (bt as { positioning_statement?: string }).positioning_statement ?? '';

  const sorted = [...listings].sort((a, b) => priorityForUrl(a.url) - priorityForUrl(b.url));
  const created: Array<{ id: string; title: string; priorityRank: number }> = [];

  // Automation tier per platform — same matrix as the priority-actions
  // factory keeps in sync with the late-2025 / 2026 write-API research.
  //   auto    → Wikidata, Google Business Profile (when on Brand Truth)
  //   assist  → G2, Capterra, TrustRadius, LinkedIn, Crunchbase,
  //             Product Hunt — no public write API, paste-via-admin-UI
  //   manual  → Wikipedia (COI policy enforced by reverts + ToU)
  function classifyPlatform(host: string): {
    tier: 'auto' | 'assist' | 'manual';
    manualReason?: string;
  } {
    if (host === 'wikidata.org') return { tier: 'auto' };
    if (host === 'google.com' || host.endsWith('business.google.com')) return { tier: 'auto' };
    if (host === 'en.wikipedia.org' || host.endsWith('.wikipedia.org')) {
      return {
        tier: 'manual',
        manualReason:
          "Wikipedia's COI / Paid-contribution policy (binding under WMF Terms of Use) forbids the subject from editing their own article. Compliant paths: Talk-page {{edit request}} or specialist editor (Beutler Ink, ReputationX). Direct API edits get reverted and the account banned.",
      };
    }
    return { tier: 'assist' };
  }

  for (let i = 0; i < sorted.length; i++) {
    const l = sorted[i]!;
    const host = new URL(l.url).host.replace(/^www\./, '');
    const platformName = l.name ?? host;
    const cls = classifyPlatform(host);
    const title = `Update ${platformName} description`;
    const description = `Replace the current description on ${platformName} with the approved positioning. Screenshot before/after for the change log.`;
    const remediation = positioning
      ? `**New description (copy-paste):**\n\n${positioning}\n\n**Admin URL:** ${l.url}`
      : `**Admin URL:** ${l.url}\n\nNo approved positioning in Brand Truth yet — author Step 2 first.`;
    const validation =
      cls.tier === 'manual'
        ? [
            { description: 'Post {{edit request}} on the article Talk page with proposed wording + 2-3 supporting sources' },
            { description: 'Or engage a third-party Wikipedia editor (Beutler Ink, ReputationX) to apply the edit on your behalf' },
            { description: 'Monitor edit retention for 30 days; volunteer reviewers may decline insufficiently sourced changes' },
          ]
        : [
            { description: `Screenshot the existing description` },
            { description: `Paste the new description and save` },
            { description: `Screenshot the live result` },
            { description: `Log the change date in the messaging guide platform log` },
          ];

    const r = await createTicketFromStep({
      firmSlug: args.firmSlug,
      sopKey: args.sopKey,
      runId: args.runId,
      stepNumber: args.stepNumber,
      title,
      description,
      priorityRank: i + 1,
      remediationCopy: remediation,
      validationSteps: validation,
      evidenceLinks: [{ kind: 'third_party_listing', url: l.url, description: platformName }],
      automationTier: cls.tier,
      executeUrl: l.url,
      executeLabel:
        cls.tier === 'auto'
          ? `Update ${platformName} via API`
          : cls.tier === 'assist'
            ? `Open ${platformName}`
            : undefined,
      manualReason: cls.manualReason,
    });
    created.push({ id: r.id, title, priorityRank: i + 1 });
  }

  return { created };
}

// Re-export firms so callers don't have to import schema directly.
export { firms };
