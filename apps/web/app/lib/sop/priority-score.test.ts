/**
 * Unit tests for computePriority — lock down all 7 classes + the
 * within-class offset formulas. The worked-examples block at the bottom
 * mirrors the spec's table verbatim so a future formula tweak can't
 * silently change what operators see.
 */
import { describe, it, expect } from 'vitest';
import { computePriority } from './priority-score';

describe('computePriority — class assignment', () => {
  describe('factual_error', () => {
    it('classifies audit tickets with factual errors as factual_error', () => {
      const r = computePriority({
        sourceType: 'audit',
        sopKey: 'brand_visibility_audit',
        auditHasFactualErrors: true,
        auditMentioned: true,
        providerCount: 1,
      });
      expect(r.priorityClass).toBe('factual_error');
      expect(r.priorityScore).toBe(700);
    });

    it('scores multi-provider factual errors higher', () => {
      // 3 providers → (3 − 1) × 10 = 20
      const r = computePriority({
        sourceType: 'audit',
        auditHasFactualErrors: true,
        providerCount: 3,
      });
      expect(r.priorityClass).toBe('factual_error');
      expect(r.priorityScore).toBe(720);
    });

    it('caps provider offset at 90 (never crosses class boundary)', () => {
      // 100 providers → 990 raw → clamped 90
      const r = computePriority({
        sourceType: 'audit',
        auditHasFactualErrors: true,
        providerCount: 100,
      });
      expect(r.priorityScore).toBe(790);
    });
  });

  describe('non_mention', () => {
    it('classifies audit tickets where firm not mentioned as non_mention', () => {
      const r = computePriority({
        sourceType: 'audit',
        sopKey: 'brand_visibility_audit',
        auditHasFactualErrors: false,
        auditMentioned: false,
        providerCount: 1,
      });
      expect(r.priorityClass).toBe('non_mention');
      expect(r.priorityScore).toBe(600);
    });
  });

  describe('time_sensitive — suppression actions', () => {
    it('classifies noindex with distance offset', () => {
      const r = computePriority({
        sourceType: 'legacy',
        legacyAction: 'noindex',
        semanticDistance: 0.659,
      });
      expect(r.priorityClass).toBe('time_sensitive');
      // (0.659 − 0.40) / 0.30 × 100 = 86.3 → 86
      expect(r.priorityScore).toBe(586);
    });

    it('classifies redirect as time_sensitive (wipe-from-index)', () => {
      const r = computePriority({
        sourceType: 'legacy',
        legacyAction: 'redirect',
        semanticDistance: 0.60,
      });
      expect(r.priorityClass).toBe('time_sensitive');
    });

    it('classifies delete as time_sensitive (wipe-from-index)', () => {
      const r = computePriority({
        sourceType: 'legacy',
        legacyAction: 'delete',
        semanticDistance: 0.70,
      });
      expect(r.priorityClass).toBe('time_sensitive');
      // (0.70 − 0.40) / 0.30 × 100 = 100 → clamped 99
      expect(r.priorityScore).toBe(599);
    });
  });

  describe('time_sensitive — content freshness', () => {
    it('classifies dormant pages by months-dormant offset (24-month cap)', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'content_freshness_audit',
        monthsDormant: 24,
      });
      expect(r.priorityClass).toBe('time_sensitive');
      // 24 / 24 × 100 = 100 → clamped 99
      expect(r.priorityScore).toBe(599);
    });

    it('scales linearly under the 24-month cap', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'content_freshness_audit',
        monthsDormant: 12,
      });
      expect(r.priorityScore).toBe(550); // 12/24*100 = 50
    });

    it('clamps months-dormant > 24 to max offset', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'content_freshness_audit',
        monthsDormant: 48,
      });
      expect(r.priorityScore).toBe(599); // clamped
    });
  });

  describe('time_sensitive — reddit complaints', () => {
    it('classifies reddit complaints as time_sensitive with fixed offset 50', () => {
      const r = computePriority({
        sourceType: 'reddit',
        redditIsComplaint: true,
      });
      expect(r.priorityClass).toBe('time_sensitive');
      expect(r.priorityScore).toBe(550);
    });

    it('non-complaint reddit mentions fall through to unknown', () => {
      const r = computePriority({
        sourceType: 'reddit',
        redditIsComplaint: false,
      });
      expect(r.priorityClass).toBe('unknown');
    });
  });

  describe('content_drift', () => {
    it('classifies rewrite legacy tickets as content_drift, distance offset when no clicks', () => {
      const r = computePriority({
        sourceType: 'legacy',
        legacyAction: 'rewrite',
        semanticDistance: 0.545,
      });
      expect(r.priorityClass).toBe('content_drift');
      // (0.545 − 0.40) / 0.15 × 100 = 96.67 → 97
      expect(r.priorityScore).toBe(497);
    });

    it('classifies rewrite with low distance correctly', () => {
      const r = computePriority({
        sourceType: 'legacy',
        legacyAction: 'rewrite',
        semanticDistance: 0.411,
      });
      // (0.411 − 0.40) / 0.15 × 100 = 7.33 → 7
      expect(r.priorityScore).toBe(407);
    });

    it('classifies keep_update with click-based offset when GSC connected', () => {
      // C1 bucket: ≥50 clicks/mo → keep_update.
      const r = computePriority({
        sourceType: 'legacy',
        legacyAction: 'keep_update',
        semanticDistance: 0.50,
        clicksPerMonth: 250,
      });
      expect(r.priorityClass).toBe('content_drift');
      // 250 / 10 = 25
      expect(r.priorityScore).toBe(425);
    });

    it('clamps very-high-click pages to offset 99', () => {
      const r = computePriority({
        sourceType: 'legacy',
        legacyAction: 'keep_update',
        clicksPerMonth: 100_000,
      });
      expect(r.priorityScore).toBe(499);
    });

    it('classifies generic-positioning audit tickets as content_drift', () => {
      // mentioned + no factual errors = generic positioning drift
      const r = computePriority({
        sourceType: 'audit',
        auditHasFactualErrors: false,
        auditMentioned: true,
        providerCount: 1,
      });
      expect(r.priorityClass).toBe('content_drift');
      expect(r.priorityScore).toBe(400);
    });
  });

  describe('per_page_quality', () => {
    it('classifies semantic_html with inverted rubric offset', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'semantic_html_optimization',
        rubricScore: 50,
        rubricMax: 100,
      });
      expect(r.priorityClass).toBe('per_page_quality');
      // 100 − 50 = 50
      expect(r.priorityScore).toBe(350);
    });

    it('classifies llm_friendly with 7-point rubric normalized to 100', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'llm_friendly_content_checklist',
        rubricScore: 4,
        rubricMax: 7,
      });
      expect(r.priorityClass).toBe('per_page_quality');
      // 4/7 × 100 = 57.14 → 57. offset = 100 − 57 = 43
      expect(r.priorityScore).toBe(343);
    });

    it('handles schema_markup_deployment + ai_info_page_creation', () => {
      const r1 = computePriority({
        sourceType: 'sop',
        sopKey: 'schema_markup_deployment',
        rubricScore: 20,
        rubricMax: 100,
      });
      expect(r1.priorityClass).toBe('per_page_quality');
      expect(r1.priorityScore).toBe(380);

      const r2 = computePriority({
        sourceType: 'sop',
        sopKey: 'ai_info_page_creation',
        rubricScore: 0,
        rubricMax: 100,
      });
      expect(r2.priorityClass).toBe('per_page_quality');
      expect(r2.priorityScore).toBe(399); // worst possible per-page quality
    });

    it('null rubric defaults to perfect score (offset 0)', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'semantic_html_optimization',
      });
      expect(r.priorityScore).toBe(300);
    });
  });

  describe('entity_gap', () => {
    it('classifies entity source_type with platform-priority offset', () => {
      const r = computePriority({
        sourceType: 'entity',
        entityDivergenceKind: 'schema_add',
      });
      expect(r.priorityClass).toBe('entity_gap');
      expect(r.priorityScore).toBe(240); // 200 + 40
    });

    it('scores wikidata_create higher than schema_add', () => {
      const w = computePriority({
        sourceType: 'entity',
        entityDivergenceKind: 'wikidata_create',
      });
      const s = computePriority({
        sourceType: 'entity',
        entityDivergenceKind: 'schema_add',
      });
      expect(w.priorityScore).toBeGreaterThan(s.priorityScore);
      expect(w.priorityScore).toBe(260);
    });

    it('classifies SOP-emitted entity tickets the same way', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'entity_optimization',
        entityDivergenceKind: 'google_kg_claim',
      });
      expect(r.priorityClass).toBe('entity_gap');
      expect(r.priorityScore).toBe(250); // 200 + 50
    });

    it('unknown divergence kind → offset 0', () => {
      const r = computePriority({
        sourceType: 'entity',
        entityDivergenceKind: 'unrecognized',
      });
      expect(r.priorityScore).toBe(200);
    });
  });

  describe('config_gate', () => {
    it('classifies gsc_setup as config_gate, score 0', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'gsc_setup',
      });
      expect(r.priorityClass).toBe('config_gate');
      expect(r.priorityScore).toBe(0);
    });

    it('classifies ga4_llm_traffic_setup as config_gate', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'ga4_llm_traffic_setup',
      });
      expect(r.priorityClass).toBe('config_gate');
    });

    it('classifies ai_bot_log_file_analysis as config_gate', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'ai_bot_log_file_analysis',
      });
      expect(r.priorityClass).toBe('config_gate');
    });

    it('config_gate score is always exactly 0 — keeps it out of the main sort', () => {
      // No matter what other signals are passed, config_gate stays at 0.
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'gsc_setup',
        rubricScore: 0,
        monthsDormant: 999,
        semanticDistance: 0.99,
      });
      expect(r.priorityScore).toBe(0);
    });
  });

  describe('unknown fallback', () => {
    it('unrecognized source_type → unknown', () => {
      const r = computePriority({ sourceType: 'mystery' });
      expect(r.priorityClass).toBe('unknown');
      expect(r.priorityScore).toBe(100);
    });

    it('SOP source with unrecognized sop_key → unknown', () => {
      const r = computePriority({
        sourceType: 'sop',
        sopKey: 'some_new_scanner_we_havent_classified',
      });
      expect(r.priorityClass).toBe('unknown');
    });

    it('legacy with aligned action → unknown (defensive)', () => {
      const r = computePriority({
        sourceType: 'legacy',
        legacyAction: 'aligned',
        semanticDistance: 0.20,
      });
      expect(r.priorityClass).toBe('unknown');
    });
  });
});

describe('computePriority — worked examples from the spec', () => {
  // These ten cases are the spec's worked-examples table. They lock the
  // formula against the rubric's stated intent, so a future tweak that
  // changes class assignment or offset math is caught here.
  // Reference: tmp/priority-score-spec.md §"Worked examples".

  it('A1 factual error (openai)', () => {
    const r = computePriority({
      sourceType: 'audit',
      auditHasFactualErrors: true,
      auditMentioned: true,
      providerCount: 1,
    });
    expect(r).toEqual({ priorityClass: 'factual_error', priorityScore: 700 });
  });

  it('A2 non-mention (openai)', () => {
    const r = computePriority({
      sourceType: 'audit',
      auditHasFactualErrors: false,
      auditMentioned: false,
      providerCount: 1,
    });
    expect(r).toEqual({ priorityClass: 'non_mention', priorityScore: 600 });
  });

  it('B noindex (d=0.659)', () => {
    const r = computePriority({
      sourceType: 'legacy',
      legacyAction: 'noindex',
      semanticDistance: 0.659,
    });
    expect(r).toEqual({ priorityClass: 'time_sensitive', priorityScore: 586 });
  });

  it('B freshness dormant (24 months, post-adjustment cap)', () => {
    const r = computePriority({
      sourceType: 'sop',
      sopKey: 'content_freshness_audit',
      monthsDormant: 24,
    });
    // Spec pre-adjustment expected 567 (using 36 cap). Post-adjustment
    // 24/24*100 = 100, clamped to 99 → 599.
    expect(r).toEqual({ priorityClass: 'time_sensitive', priorityScore: 599 });
  });

  it('C rewrite high distance (d=0.545)', () => {
    const r = computePriority({
      sourceType: 'legacy',
      legacyAction: 'rewrite',
      semanticDistance: 0.545,
    });
    // (0.545 − 0.40) / 0.15 × 100 = 96.67 → 97. Score = 400 + 97 = 497.
    expect(r).toEqual({ priorityClass: 'content_drift', priorityScore: 497 });
  });

  it('C rewrite low distance (d=0.411)', () => {
    const r = computePriority({
      sourceType: 'legacy',
      legacyAction: 'rewrite',
      semanticDistance: 0.411,
    });
    expect(r).toEqual({ priorityClass: 'content_drift', priorityScore: 407 });
  });

  it('D semantic-html (50/100)', () => {
    const r = computePriority({
      sourceType: 'sop',
      sopKey: 'semantic_html_optimization',
      rubricScore: 50,
      rubricMax: 100,
    });
    expect(r).toEqual({ priorityClass: 'per_page_quality', priorityScore: 350 });
  });

  it('D llm-friendly (4/7)', () => {
    const r = computePriority({
      sourceType: 'sop',
      sopKey: 'llm_friendly_content_checklist',
      rubricScore: 4,
      rubricMax: 7,
    });
    expect(r).toEqual({ priorityClass: 'per_page_quality', priorityScore: 343 });
  });

  it('E entity schema-add', () => {
    const r = computePriority({
      sourceType: 'entity',
      entityDivergenceKind: 'schema_add',
    });
    expect(r).toEqual({ priorityClass: 'entity_gap', priorityScore: 240 });
  });

  it('F config-gate gsc_setup', () => {
    const r = computePriority({
      sourceType: 'sop',
      sopKey: 'gsc_setup',
    });
    expect(r).toEqual({ priorityClass: 'config_gate', priorityScore: 0 });
  });
});

describe('computePriority — sort ordering invariants', () => {
  it('produces a strict cross-class ordering', () => {
    // All same provider_count / distance / etc. — just class differs.
    const tickets = [
      computePriority({ sourceType: 'audit', auditHasFactualErrors: true, providerCount: 1 }),
      computePriority({ sourceType: 'audit', auditMentioned: false, providerCount: 1 }),
      computePriority({ sourceType: 'legacy', legacyAction: 'noindex', semanticDistance: 0.40 }), // floor of time_sensitive
      computePriority({ sourceType: 'legacy', legacyAction: 'rewrite', semanticDistance: 0.40 }), // floor of content_drift
      computePriority({ sourceType: 'sop', sopKey: 'semantic_html_optimization', rubricScore: 100, rubricMax: 100 }), // floor of per_page_quality
      computePriority({ sourceType: 'entity', entityDivergenceKind: 'badge_unverified' }), // bottom of entity_gap
      computePriority({ sourceType: 'mystery' }), // unknown
      computePriority({ sourceType: 'sop', sopKey: 'gsc_setup' }),
    ];
    const scores = tickets.map((t) => t.priorityScore);
    // Each class floor must outrank the next class's ceiling — the 100-point
    // window guarantees no overlap.
    expect(scores).toEqual([700, 600, 500, 400, 300, 220, 100, 0]);
    // Strictly descending
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1]!);
    }
  });
});
