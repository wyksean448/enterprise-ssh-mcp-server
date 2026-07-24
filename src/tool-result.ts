import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

let compactJson = false;

export class McpToolError extends Error {
  public readonly code: string;
  public readonly details?: object;

  public constructor(code: string, message: string, details?: object) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function setCompactJsonResponse(enabled: boolean): void {
  compactJson = enabled;
}

export function jsonResponse(payload: object): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: stringifyPayload(payload),
      },
    ],
  };
}

export async function toToolResult(task: () => Promise<object>): Promise<CallToolResult> {
  try {
    return jsonResponse(await task());
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: stringifyPayload({ ok: false, error: serializeError(error) }),
        },
      ],
    };
  }
}

export function serializeError(error: Error | McpToolError): object {
  if (error instanceof McpToolError) {
    const payload: { code: string; message: string; details?: object } = {
      code: error.code,
      message: error.message,
    };
    if (error.details !== undefined) {
      payload.details = error.details;
    }
    return payload;
  }

  return {
    code: "internal_error",
    message: error.message,
  };
}

export function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new McpToolError("invalid_argument", `${fieldName} must not be empty`, { fieldName });
  }
}

function stringifyPayload(payload: object): string {
  return compactJson ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
}
