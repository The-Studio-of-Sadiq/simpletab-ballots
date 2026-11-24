import {
  DERIVED_KEY_BYTE_LENGTH,
  base64UrlDecode,
  constantTimeEqualStrings,
  verifier,
  verifyProof,
} from "@simpletab/core/crypto";
import { parseSubmission, type PermitForm } from "@simpletab/core/wire";
import type { Clock, Env } from "../env";
import type { TournamentRow } from "../lib/auth";
import { errorResponse, jsonResponse, readJsonBody, wireParseErrorResponse } from "../lib/errors";
import { loadRoundPermit } from "../lib/permits";
import {
  checkRateLimit,
  getEffectiveUsage,
  maybeFlushUsage,
  recordUsage,
  secondsUntilUtcMidnight,
  utcDay,
} from "../lib/usage";

function getClientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function applyFailureIpLimit(
  request: Request,
  env: Env,
  response: Response,
): Promise<Response> {
  const allowed = await checkRateLimit(env.RL_IP, `submit-fail:${getClientIp(request)}`);
  if (!allowed) {
    return errorResponse("RATE_LIMITED", "Too many failed submission attempts", {
      retryAfterSeconds: 60,
    });
  }
  return response;
}

export async function handleSubmit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Clock,
): Promise<Response> {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return applyFailureIpLimit(request, env, bodyResult.response);
  }

  const parsed = parseSubmission(bodyResult.value);
  if (!parsed.ok) {
    return applyFailureIpLimit(request, env, wireParseErrorResponse(parsed.errors));
  }

  const submission = parsed.value;

  const linkAllowed = await checkRateLimit(
    env.RL_LINK,
    `submit:${submission.slug}:${submission.lookupId}`,
  );
  if (!linkAllowed) {
    return errorResponse("RATE_LIMITED", "Rate limit exceeded for this link", {
      retryAfterSeconds: 60,
    });
  }

  const tournament = await env.DB.prepare(
    `SELECT slug, key_hash, host_number, host_id, host_rank, status,
            share_requests, share_writes, cdn_origin, acked_through,
            reg_open, reg_close, reg_cap, created_at
     FROM tournaments
     WHERE slug = ?`,
  )
    .bind(submission.slug)
    .first<TournamentRow>();

  if (!tournament || tournament.status === "pending") {
    return applyFailureIpLimit(
      request,
      env,
      errorResponse("NOT_FOUND", "Tournament not found"),
    );
  }

  if (tournament.status === "revoked") {
    return errorResponse("KEY_REVOKED", "Tournament key has been revoked");
  }

  if (tournament.status === "paused") {
    return errorResponse("QUOTA_EXHAUSTED", "Tournament portal is paused", {
      retryAfterSeconds: 300,
    });
  }

  if (tournament.status === "closed" || tournament.status === "archived") {
    return errorResponse("ROUND_CLOSED", "Tournament is closed");
  }

  const nowMs = now();
  const day = utcDay(nowMs);
  const effectiveUsage = await getEffectiveUsage(env.DB, submission.slug, day);
  if (
    effectiveUsage.requests + 1 > tournament.share_requests ||
    effectiveUsage.writes + 2 > tournament.share_writes
  ) {
    return errorResponse("QUOTA_EXHAUSTED", "Tournament daily share has been exhausted", {
      retryAfterSeconds: secondsUntilUtcMidnight(nowMs),
    });
  }

  const loadedPermit = await loadRoundPermit(
    env.DB,
    submission.slug,
    submission.roundId,
  );
  if (!loadedPermit) {
    return applyFailureIpLimit(
      request,
      env,
      errorResponse("NOT_FOUND", "Round permit not found"),
    );
  }

  const entry = loadedPermit.entriesByLookupId.get(submission.lookupId);
  if (!entry) {
    return applyFailureIpLimit(
      request,
      env,
      errorResponse("AUTH_INVALID", "Unknown lookupId for this round"),
    );
  }

  const authKeyBytes = base64UrlDecode(submission.authKey);
  if (!authKeyBytes || authKeyBytes.byteLength !== DERIVED_KEY_BYTE_LENGTH) {
    return applyFailureIpLimit(
      request,
      env,
      errorResponse("AUTH_INVALID", "Invalid authKey"),
    );
  }

  const computedVerifier = await verifier(authKeyBytes);
  if (!constantTimeEqualStrings(computedVerifier, entry.verifier)) {
    return applyFailureIpLimit(
      request,
      env,
      errorResponse("AUTH_INVALID", "authKey does not match permit verifier"),
    );
  }

  let proofOk = false;
  try {
    proofOk = await verifyProof(
      authKeyBytes,
      submission.submissionId,
      submission.payload,
      submission.proof,
    );
  } catch {
    proofOk = false;
  }
  if (!proofOk) {
    return applyFailureIpLimit(
      request,
      env,
      errorResponse("AUTH_INVALID", "Invalid submission proof"),
    );
  }

  if (!entry.forms.includes(submission.type as PermitForm)) {
    return errorResponse(
      "FORM_NOT_ALLOWED",
      `Form "${submission.type}" is not allowed for this link in round "${submission.roundId}"`,
    );
  }

  if (!loadedPermit.permit.open) {
    return errorResponse("ROUND_CLOSED", "Round is closed for online submissions");
  }

  if (
    submission.type === "ballot" &&
    loadedPermit.permit.ballotDeadline !== undefined &&
    nowMs >= Date.parse(loadedPermit.permit.ballotDeadline)
  ) {
    return errorResponse(
      "DEADLINE_PASSED",
      `Ballot submission for round ${submission.roundId} closed at ${loadedPermit.permit.ballotDeadline}`,
      {
        deadline: loadedPermit.permit.ballotDeadline,
        timeZone: loadedPermit.permit.timeZone,
      },
    );
  }

  if (
    submission.type === "feedback" &&
    loadedPermit.permit.feedbackDeadline !== undefined &&
    nowMs >= Date.parse(loadedPermit.permit.feedbackDeadline)
  ) {
    return errorResponse(
      "DEADLINE_PASSED",
      `Feedback submission for round ${submission.roundId} closed at ${loadedPermit.permit.feedbackDeadline}`,
      {
        deadline: loadedPermit.permit.feedbackDeadline,
        timeZone: loadedPermit.permit.timeZone,
      },
    );
  }

  const receivedAt = new Date(nowMs).toISOString();
  const payloadJson = JSON.stringify(submission.payload);

  const insertResult = await env.DB.prepare(
    `INSERT INTO submissions (submission_id, slug, round_id, lookup_id, type, payload, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(submission_id) DO NOTHING`,
  )
    .bind(
      submission.submissionId,
      submission.slug,
      submission.roundId,
      submission.lookupId,
      submission.type,
      payloadJson,
      receivedAt,
    )
    .run();

  const inserted = (insertResult.meta?.changes ?? 0) > 0;
  recordUsage(
    submission.slug,
    day,
    { requests: 1, writes: inserted ? 2 : 0 },
    nowMs,
  );
  maybeFlushUsage(env.DB, submission.slug, day, nowMs, ctx);

  if (!inserted) {
    return jsonResponse({ status: "already_received" }, 200);
  }

  return jsonResponse(
    {
      status: "received",
      submissionId: submission.submissionId,
      receivedAt,
    },
    200,
  );
}
