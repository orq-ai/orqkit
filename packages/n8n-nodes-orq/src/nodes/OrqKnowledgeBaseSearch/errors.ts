import type { INode } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

export enum ErrorCode {
  UNAUTHORIZED = "UNAUTHORIZED",
  NOT_FOUND = "NOT_FOUND",
  BAD_REQUEST = "BAD_REQUEST",
  SERVER_ERROR = "SERVER_ERROR",
  INVALID_INPUT = "INVALID_INPUT",
  NETWORK_ERROR = "NETWORK_ERROR",
}

export class OrqError extends NodeOperationError {
  constructor(
    node: INode,
    message: string,
    public code: ErrorCode,
    public statusCode?: number,
    public details?: unknown,
  ) {
    super(node, message);
    this.name = "OrqError";
  }
}

export class ValidationError extends OrqError {
  constructor(node: INode, message: string, field?: string) {
    super(node, message, ErrorCode.INVALID_INPUT);
    this.details = { field };
  }
}

export class ApiError extends OrqError {
  constructor(
    node: INode,
    message: string,
    statusCode: number,
    responseBody?: unknown,
  ) {
    const code = ApiError.getErrorCode(statusCode);
    super(node, message, code, statusCode, responseBody);
  }

  private static getErrorCode(statusCode: number): ErrorCode {
    if (statusCode === 401) return ErrorCode.UNAUTHORIZED;
    if (statusCode === 404) return ErrorCode.NOT_FOUND;
    if (statusCode === 400) return ErrorCode.BAD_REQUEST;
    if (statusCode >= 500) return ErrorCode.SERVER_ERROR;
    return ErrorCode.NETWORK_ERROR;
  }
}
