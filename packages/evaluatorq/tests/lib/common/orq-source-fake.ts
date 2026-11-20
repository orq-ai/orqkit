import type { OrqSourceClient } from "../../../src/lib/trace-finder/orq-source.js";

export interface Fixture {
  op: string;
  projects: Record<string, unknown>[];
  pages: Record<string, unknown>[];
  spans: Record<string, Record<string, unknown>[]>;
  details: Record<string, Record<string, unknown>>;
  limit: number;
  facets: unknown;
  numeric: unknown;
  expectedSpanId?: string | null;
  targets?: string[];
  scanForever?: boolean;
  records?: unknown[];
}
export function fake(doc: Fixture) {
  const calls = { projects: 0, query: [] as unknown[], spans: 0, details: 0 },
    spanIndex = new Map<string, number>();
  let queryIndex = 0;
  const failure = (result: Record<string, unknown>) => {
    if (result.error)
      throw Object.assign(new Error(String(result.error)), {
        name: "RuntimeError",
      });
    return result;
  };
  const client = {
    _options: {},
    _baseURL: null,
    projects: {
      list: async () => {
        calls.projects++;
        return doc.projects[0];
      },
    },
    traces: {
      query: async ({
        oql,
        limit,
        pageToken,
      }: {
        oql: string;
        limit: number;
        pageToken?: string;
      }) => {
        calls.query.push({ oql, limit, token: pageToken ?? null });
        if (doc.scanForever) {
          const index = queryIndex++;
          return {
            search: {
              data: Array.from({ length: 200 }, (_, i) => ({
                trace_id: `other-${index}-${i}`,
              })),
              has_more: true,
              next_page_token: String(index + 1),
            },
          };
        }
        return failure(
          doc.pages[Math.min(queryIndex++, doc.pages.length - 1)] as Record<
            string,
            unknown
          >,
        );
      },
      listSpans: async ({ traceId }: { traceId: string }) => {
        calls.spans++;
        const index = spanIndex.get(traceId) ?? 0;
        spanIndex.set(traceId, index + 1);
        const pages = doc.spans[traceId] ?? [{ data: [], has_more: false }];
        return failure(
          pages[Math.min(index, pages.length - 1)] as Record<string, unknown>,
        );
      },
      getSpan: async ({
        traceId,
        spanId,
      }: {
        traceId: string;
        spanId: string;
      }) => {
        calls.details++;
        return failure(
          doc.details[`${traceId}/${spanId}`] ?? {
            span: { summary: { span_id: spanId } },
          },
        );
      },
    },
  } as unknown as OrqSourceClient;
  return { client, calls };
}
