export interface RawKnowledgeBase {
  _id: string;
  key?: string;
  id?: string;
  description?: string;
}

export interface IOrqKnowledgeBase {
  id: string;
  name: string;
  description?: string;
}

export type FilterOperatorValue =
  | { eq: string | number | boolean }
  | { ne: string | number | boolean }
  | { gt: number }
  | { gte: number }
  | { lt: number }
  | { lte: number }
  | { in: (string | number | boolean)[] }
  | { nin: (string | number | boolean)[] };
