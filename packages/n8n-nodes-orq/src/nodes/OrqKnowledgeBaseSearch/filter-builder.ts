import type { IExecuteFunctions } from "n8n-workflow";

import { ValidationError } from "./errors";
import type {
  AndFilter,
  OrFilter,
  SearchFilter,
  SearchFilterRecord,
} from "./types";
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
  ): SearchFilter | undefined {
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
  ): AndFilter | OrFilter | undefined {
    const paramName = type === "and" ? "andFilters" : "orFilters";
    const filters = context.getNodeParameter(
      paramName,
      itemIndex,
      {},
    ) as FilterParams;

    if (!filters.condition || filters.condition.length === 0) {
      return undefined;
    }

    const conditions: SearchFilterRecord[] = [];

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

    return type === "and" ? { and: conditions } : { or: conditions };
  }

  private static buildCustomFilter(
    context: IExecuteFunctions,
    itemIndex: number,
  ): SearchFilter | undefined {
    const customFilter = context.getNodeParameter(
      "customFilter",
      itemIndex,
      "{}",
    ) as string;

    try {
      const parsed = JSON.parse(customFilter);
      return Object.keys(parsed).length > 0 ? parsed : undefined;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    if (operator === "in" || operator === "nin") {
      const arrayValues = InputValidator.parseArrayValue(String(value));
      return { [operator]: arrayValues };
    } else if (
      operator === "gt" ||
      operator === "gte" ||
      operator === "lt" ||
      operator === "lte"
    ) {
      const numValue = typeof value === "string" ? parseFloat(value) : value;
      if (Number.isNaN(numValue)) {
        throw new Error(
          `Value for ${operator} operator must be a number, got: ${value}`,
        );
      }
      return { [operator]: numValue };
    } else {
      const parsedValue = InputValidator.parseValue(value);
      return { [operator]: parsedValue };
    }
  }
}
