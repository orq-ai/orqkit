import type { IExecuteFunctions } from "n8n-workflow";

import type { FilterBy } from "@orq-ai/node/models/operations";

import { ValidationError } from "./errors";
import type { FilterOperatorValue } from "./types";
import { InputValidator } from "./validators";

interface FilterCondition {
  field: string;
  operator: string;
  value: unknown;
}

interface FilterParams {
  condition?: FilterCondition[];
}

export class FilterBuilder {
  private constructor() {}

  static buildFilter(
    context: IExecuteFunctions,
    metadataFilterType: string,
    itemIndex: number,
  ): FilterBy | undefined {
    if (metadataFilterType === "none" || !metadataFilterType) {
      return undefined;
    }

    if (metadataFilterType === "and") {
      return FilterBuilder.buildLogicalFilter(context, itemIndex, "and");
    } else if (metadataFilterType === "or") {
      return FilterBuilder.buildLogicalFilter(context, itemIndex, "or");
    } else if (metadataFilterType === "custom") {
      return FilterBuilder.buildCustomFilter(context, itemIndex);
    } else {
      return undefined;
    }
  }

  private static buildLogicalFilter(
    context: IExecuteFunctions,
    itemIndex: number,
    type: "and" | "or",
  ): FilterBy | undefined {
    const paramName = type === "and" ? "andFilters" : "orFilters";
    const filters = context.getNodeParameter(
      paramName,
      itemIndex,
      {},
    ) as FilterParams;

    if (!filters.condition || filters.condition.length === 0) {
      return undefined;
    }

    const conditions: Array<{
      [k: string]: FilterOperatorValue | string | number | boolean;
    }> = [];

    for (const conditionItem of filters.condition) {
      if (!conditionItem.field || conditionItem.value === "") continue;

      const operator = conditionItem.operator || "eq";
      const field = conditionItem.field;
      const value = conditionItem.value;

      conditions.push({
        [field]: FilterBuilder.createFilterValue(operator, value),
      });
    }

    if (conditions.length === 0) return undefined;

    return type === "and"
      ? ({ and: conditions } as FilterBy)
      : ({ or: conditions } as FilterBy);
  }

  private static buildCustomFilter(
    context: IExecuteFunctions,
    itemIndex: number,
  ): FilterBy | undefined {
    const customFilter = context.getNodeParameter(
      "customFilter",
      itemIndex,
      "{}",
    ) as string;

    try {
      const parsed = JSON.parse(customFilter);
      return Object.keys(parsed).length > 0 ? (parsed as FilterBy) : undefined;
    } catch {
      throw new ValidationError(
        context.getNode(),
        "Invalid JSON in custom filter. Please provide valid JSON.",
        "customFilter",
      );
    }
  }

  private static createFilterValue(
    operator: string,
    value: unknown,
  ): FilterOperatorValue | string | number | boolean {
    const validOperators = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"];
    if (!validOperators.includes(operator)) {
      throw new Error(
        `Invalid filter operator: ${operator}. Must be one of: ${validOperators.join(", ")}`,
      );
    }

    if (operator === "in" || operator === "nin") {
      const arrayValues = InputValidator.parseArrayValue(String(value));
      return operator === "in" ? { in: arrayValues } : { nin: arrayValues };
    }

    if (
      operator === "gt" ||
      operator === "gte" ||
      operator === "lt" ||
      operator === "lte"
    ) {
      const stringValue = String(value).trim();
      if (stringValue === "") {
        throw new Error(`Value for ${operator} operator cannot be empty`);
      }
      const numValue = Number(stringValue);
      if (!Number.isFinite(numValue)) {
        throw new Error(
          `Value for ${operator} operator must be a valid number, got: ${value}`,
        );
      }

      switch (operator) {
        case "gt":
          return { gt: numValue };
        case "gte":
          return { gte: numValue };
        case "lt":
          return { lt: numValue };
        case "lte":
          return { lte: numValue };
        default:
          throw new Error(`Unreachable: ${operator}`);
      }
    }

    const parsedValue = InputValidator.parseValue(value);
    return operator === "ne" ? { ne: parsedValue } : { eq: parsedValue };
  }
}
