import { getAuditDetail } from '../../../../actions/audit-actions';

export const dynamic = 'force-dynamic';

/**
 * CSV export for a single audit run — shareable HTTP endpoint so the
 * output can be linked to, piped through `curl`, or embedded in a
 * third-party report builder.
 *
 * Column set aligned with the AI Edge Technical Framework §5.1
 * Phase 1 deliverable: Keyword, Model, Mention (Y/N), Score, Citations.
 * We also include Provider, RAG label, Gap reasons, and Factual errors
 * because the internal dashboard already stores them and it costs
 * nothing to surface them alongside the required columns.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ auditRunId: string }> },
) {
  const { auditRunId } = await params;
  const startedAt = Date.now();

  let detail;
  try {
    detail = await getAuditDetail(auditRunId);
  } catch (err) {
    console.error(
      `[api:audit-csv] error auditRunId=${auditRunId}:`,
      err,
    );
    return Response.json(
      { error: `Audit run not found: ${String(err)}` },
      { status: 404 },
    );
  }

  const header = [
    'Keyword',
    'Provider',
    'Model',
    'Mention',
    'Score',
    'RAG',
    // k = self-consistency sample count (1 for standard, 3 for top-priority).
    // variance = fraction of samples disagreeing with the majority vote,
    // surfaced as a percentage so '0.0' means unanimous.
    'k',
    'Variance %',
    'Citations',
    'Gap Reasons',
    'Factual Errors',
  ];

  // Standards-compliant CSV escape: wrap in quotes, double any embedded
  // quotes, preserve newlines inside quoted fields.
  const escape = (s: unknown): string => {
    const str = s == null ? '' : String(s);
    return `"${str.replace(/"/g, '""')}"`;
  };

  const lines = [header.map(escape).join(',')];
  for (const r of detail.results) {
    lines.push(
      [
        escape(r.queryText),
        escape(r.provider),
        escape(r.model),
        r.mentioned ? 'Y' : 'N',
        r.toneScore != null ? r.toneScore.toFixed(1) : '',
        r.ragLabel,
        r.k.toString(),
        (r.variance * 100).toFixed(1),
        escape(r.citationUrls.join(' | ')),
        escape(r.gapReasons.join(' | ')),
        escape(r.factualErrors.join(' | ')),
      ].join(','),
    );
  }

  // \r\n line endings — Excel-friendly and what RFC 4180 specifies.
  const csv = lines.join('\r\n');

  const startDate = detail.run.startedAt
    ? new Date(detail.run.startedAt).toISOString().slice(0, 10)
    : 'unknown';
  const filename = `audit-${auditRunId.slice(0, 8)}-${startDate}.csv`;

  const durationMs = Date.now() - startedAt;
  console.log(
    `[api:audit-csv] ok auditRunId=${auditRunId} rows=${detail.results.length} bytes=${csv.length} durationMs=${durationMs}`,
  );

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
