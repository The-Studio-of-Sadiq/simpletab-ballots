import { HTTP_STATUS, type ErrorBody, type ErrorCode } from "@simpletab/core/wire";

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  extra?: Partial<Omit<ErrorBody, "code" | "message">>,
): Response {
  const body: ErrorBody = {
    code,
    message,
    ...extra,
  };
  const headers: Record<string, string> = {};
  if (code === "RATE_LIMITED" || code === "QUOTA_EXHAUSTED") {
    const retryAfter = Math.max(1, Math.ceil(extra?.retryAfterSeconds ?? 60));
    body.retryAfterSeconds = retryAfter;
    headers["Retry-After"] = String(retryAfter);
  }
  return jsonResponse(body, HTTP_STATUS[code], headers);
}

export function wireParseErrorResponse(errors: readonly string[]): Response {
  const isUnsupported = errors.some((entry) => entry.includes("SCHEMA_UNSUPPORTED"));
  const code: ErrorCode = isUnsupported ? "SCHEMA_UNSUPPORTED" : "SCHEMA_INVALID";
  return errorResponse(code, errors.join("; "));
}

export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    const value: unknown = await request.json();
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      response: errorResponse("SCHEMA_INVALID", "Request body must be valid JSON"),
    };
  }
}
