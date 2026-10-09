export interface Verdict {
  affectedCount: number;
  totalCount: number;
}

// Counts per-check report lines directly ("<job>: AFFECTED - ..." / "<job>: OK")
// rather than parsing the summary sentence, so a slightly different phrasing there
// doesn't break parsing — the per-check lines are the part the prompt pins exactly.
const LINE_PATTERN = /^-\s+.+:\s+(AFFECTED|OK)\b/gim;

export function parseVerdict(report: string): Verdict {
  let affectedCount = 0;
  let totalCount = 0;
  for (const match of report.matchAll(LINE_PATTERN)) {
    totalCount++;
    if (match[1]?.toUpperCase() === "AFFECTED") affectedCount++;
  }
  return { affectedCount, totalCount };
}
