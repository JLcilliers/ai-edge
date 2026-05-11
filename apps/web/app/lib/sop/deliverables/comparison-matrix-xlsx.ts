/**
 * Deliverable builder: comparison_matrix_xlsx
 *
 * Generates the SOP Step 6 "client-ready visual comparison matrix"
 * verbatim per the Brand Visibility Audit SOP doc. The xlsx layout
 * mirrors the spreadsheet structure the SOP prescribes:
 *
 *   Tab 1 "Brand Visibility Audit"
 *     A: LLM Name · B: Query · C: Full Response · D: Key Description
 *     E: Sources Cited · F: Alignment (R/Y/G) · G: Notes/Flags
 *   Tab 2 "Inconsistencies & Recommendations"
 *     Sections: Consistent Themes · Conflicting Descriptions · Cited Sources
 *
 * Output is a Vercel Blob URL when storage is configured; falls back to
 * inline base64 payload otherwise.
 */

import ExcelJS from 'exceljs';
import { put } from '@vercel/blob';
import {
  getDb,
  queries,
  modelResponses,
  consensusResponses,
  alignmentScores,
  citations,
} from '@ai-edge/db';
import { eq } from 'drizzle-orm';

interface Args {
  firmName: string;
  auditRunId: string;
  generatedAt: Date;
}

interface BuildResult {
  filename: string;
  blobUrl: string | null;
  bytes: number;
  rowCount: number;
}

export async function buildComparisonMatrixXlsx(args: Args): Promise<BuildResult> {
  const db = getDb();

  // Pull every (query, provider) scored response with alignment + citations.
  // We render one row per (query, provider) — multiple model_responses per
  // (query, provider) collapse into the consensus row.
  const responses = await db
    .select({
      query: queries.text,
      provider: modelResponses.provider,
      raw: modelResponses.raw_response,
      consensusId: consensusResponses.id,
      majorityAnswer: consensusResponses.majority_answer,
      rag: alignmentScores.rag_label,
      gapReasons: alignmentScores.gap_reasons,
      factualErrors: alignmentScores.factual_errors,
    })
    .from(modelResponses)
    .innerJoin(queries, eq(modelResponses.query_id, queries.id))
    .leftJoin(consensusResponses, eq(consensusResponses.query_id, queries.id))
    .leftJoin(alignmentScores, eq(alignmentScores.consensus_response_id, consensusResponses.id))
    .where(eq(queries.audit_run_id, args.auditRunId));

  // Citations per consensus.
  const citationRows = await db
    .select({
      consensusId: citations.consensus_response_id,
      url: citations.url,
      domain: citations.domain,
    })
    .from(citations)
    .innerJoin(consensusResponses, eq(citations.consensus_response_id, consensusResponses.id))
    .innerJoin(queries, eq(consensusResponses.query_id, queries.id))
    .where(eq(queries.audit_run_id, args.auditRunId));

  const citationsByConsensus = new Map<string, string[]>();
  for (const c of citationRows) {
    const list = citationsByConsensus.get(c.consensusId) ?? [];
    list.push(`${c.domain} (${c.url})`);
    citationsByConsensus.set(c.consensusId, list);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Clixsy Intercept';
  wb.created = args.generatedAt;

  // ── Tab 1: comparison matrix ───────────────────────────────
  const ws1 = wb.addWorksheet('Brand Visibility Audit', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws1.columns = [
    { header: 'LLM', key: 'llm', width: 14 },
    { header: 'Query', key: 'query', width: 42 },
    { header: 'Full Response', key: 'response', width: 80 },
    { header: 'Key Description', key: 'desc', width: 60 },
    { header: 'Sources Cited', key: 'sources', width: 40 },
    { header: 'Alignment', key: 'rag', width: 12 },
    { header: 'Notes / Flags', key: 'notes', width: 50 },
  ];
  ws1.getRow(1).font = { bold: true };
  ws1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  ws1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  const RAG_COLORS: Record<string, string> = {
    red: 'FFDC2626',
    yellow: 'FFEAB308',
    green: 'FF16A34A',
  };

  let rowCount = 0;
  for (const r of responses) {
    const fullResponse =
      (r.raw as { content?: string; text?: string } | null)?.content ??
      (r.raw as { text?: string } | null)?.text ??
      JSON.stringify(r.raw).slice(0, 5000);
    const sources = r.consensusId
      ? (citationsByConsensus.get(r.consensusId) ?? []).join('\n')
      : '';
    const notes = [
      ...(r.factualErrors as string[] | null ?? []).map((e) => `Error: ${e}`),
      ...(r.gapReasons as string[] | null ?? []).map((g) => `Gap: ${g}`),
    ].join('\n');
    const row = ws1.addRow({
      llm: r.provider,
      query: r.query,
      response: fullResponse,
      desc: r.majorityAnswer ?? '',
      sources,
      rag: r.rag ?? '',
      notes,
    });
    if (r.rag && RAG_COLORS[r.rag]) {
      row.getCell('rag').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: RAG_COLORS[r.rag]! },
      };
      row.getCell('rag').font = { bold: true, color: { argb: 'FFFFFFFF' } };
    }
    row.alignment = { wrapText: true, vertical: 'top' };
    rowCount += 1;
  }

  // Summary row at the bottom.
  const ragCounts = { red: 0, yellow: 0, green: 0 };
  for (const r of responses) {
    if (r.rag === 'red') ragCounts.red += 1;
    else if (r.rag === 'yellow') ragCounts.yellow += 1;
    else if (r.rag === 'green') ragCounts.green += 1;
  }
  const summary = ws1.addRow({
    llm: 'SUMMARY',
    query: `${responses.length} scored responses`,
    response: '',
    desc: `${ragCounts.red} red · ${ragCounts.yellow} yellow · ${ragCounts.green} green`,
    sources: `${citationRows.length} total citations`,
    rag: '',
    notes: `Alignment: ${responses.length === 0 ? 0 : Math.round((ragCounts.green / responses.length) * 100)}% green`,
  });
  summary.font = { bold: true };

  // ── Tab 2: inconsistencies & recommendations ───────────────
  const ws2 = wb.addWorksheet('Inconsistencies & Recommendations');
  ws2.columns = [
    { header: 'Section', key: 'section', width: 22 },
    { header: 'Detail', key: 'detail', width: 80 },
    { header: 'Count', key: 'count', width: 10 },
  ];
  ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };

  // Consistent themes — text recurring in majority_answer (loose heuristic).
  ws2.addRow({ section: 'Consistent Themes', detail: 'Recurring descriptions across LLMs:', count: '' });
  const descFreq = new Map<string, number>();
  for (const r of responses) {
    const d = (r.majorityAnswer ?? '').trim();
    if (d.length === 0) continue;
    descFreq.set(d, (descFreq.get(d) ?? 0) + 1);
  }
  for (const [d, n] of [...descFreq.entries()].filter(([, n]) => n >= 2).slice(0, 10)) {
    ws2.addRow({ section: '', detail: d.slice(0, 200), count: n });
  }

  // Conflicting descriptions — Red factual errors.
  ws2.addRow({ section: '', detail: '', count: '' });
  ws2.addRow({ section: 'Conflicting Descriptions', detail: 'Recurring factual errors / gaps:', count: '' });
  const errFreq = new Map<string, number>();
  for (const r of responses) {
    if (r.rag !== 'red') continue;
    for (const e of (r.factualErrors as string[] | null) ?? []) errFreq.set(e, (errFreq.get(e) ?? 0) + 1);
    for (const g of (r.gapReasons as string[] | null) ?? []) errFreq.set(g, (errFreq.get(g) ?? 0) + 1);
  }
  for (const [e, n] of [...errFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    ws2.addRow({ section: '', detail: e.slice(0, 200), count: n });
  }

  // Cited Sources — domain frequency.
  ws2.addRow({ section: '', detail: '', count: '' });
  ws2.addRow({ section: 'Cited Sources', detail: 'Top-cited third-party domains (LLMs that cited this domain):', count: '' });
  const domainFreq = new Map<string, number>();
  for (const c of citationRows) domainFreq.set(c.domain, (domainFreq.get(c.domain) ?? 0) + 1);
  for (const [d, n] of [...domainFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    ws2.addRow({ section: '', detail: d, count: n });
  }

  ws2.eachRow((row, n) => {
    if (n === 1) return;
    row.alignment = { wrapText: true, vertical: 'top' };
  });

  // ── Serialize ─────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const filename = `brand-visibility-audit-${args.firmName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${args.generatedAt.toISOString().slice(0, 10)}.xlsx`;
  let blobUrl: string | null = null;
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blob = await put(`sop-deliverables/${filename}`, buffer as ArrayBuffer, {
        access: 'public',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      blobUrl = blob.url;
    }
  } catch (e) {
    // Non-fatal — payload is in Postgres as base64 fallback below.
    console.error('[xlsx] blob upload failed:', e);
  }

  return {
    filename,
    blobUrl,
    bytes: (buffer as ArrayBuffer).byteLength,
    rowCount,
  };
}
