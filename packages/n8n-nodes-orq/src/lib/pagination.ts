import type { IExecuteFunctions, ILoadOptionsFunctions } from "n8n-workflow";

export interface PaginatedResponse<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES = 50;

function getItemId(item: Record<string, unknown>): string | undefined {
  if (typeof item._id === "string") return item._id;
  if (typeof item.id === "string") return item.id;
  return undefined;
}

export async function fetchAllPages<T>(
  context: ILoadOptionsFunctions | IExecuteFunctions,
  baseUrl: string,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const url = cursor
      ? `${baseUrl}?limit=${pageSize}&starting_after=${cursor}`
      : `${baseUrl}?limit=${pageSize}`;

    const response = (await context.helpers.requestWithAuthentication.call(
      context,
      "orqApi",
      { method: "GET", url, json: true },
    )) as PaginatedResponse<T>;

    const page = response?.data ?? [];
    results.push(...page);

    pages++;

    const lastItem = page.length > 0 ? page[page.length - 1] : undefined;
    cursor =
      response?.has_more && lastItem && pages < MAX_PAGES
        ? getItemId(lastItem as Record<string, unknown>)
        : undefined;
  } while (cursor);

  return results;
}
