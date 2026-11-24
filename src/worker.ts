import type { Clock, Env } from "./env";
import { errorResponse } from "./lib/errors";
import { handleAdmin } from "./routes/admin";
import {
  handleHostAck,
  handleHostClose,
  handleHostHead,
  handleHostInbox,
  handleHostKeyRequest,
  handleHostPermits,
} from "./routes/host";
import { handleStatus } from "./routes/status";
import { handleSubmit } from "./routes/submit";

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Clock = Date.now,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname.startsWith("/admin/")) {
      return await handleAdmin(request, env, url, now);
    }

    if (method === "POST" && pathname === "/v1/host/key-request") {
      return await handleHostKeyRequest(request, env, now);
    }
    if (method === "POST" && pathname === "/v1/host/permits") {
      return await handleHostPermits(request, env, ctx, now);
    }
    if (method === "GET" && pathname === "/v1/host/inbox") {
      return await handleHostInbox(request, env, ctx, url, now);
    }
    if (method === "POST" && pathname === "/v1/host/ack") {
      return await handleHostAck(request, env, ctx, now);
    }
    if (method === "POST" && pathname === "/v1/host/head") {
      return await handleHostHead(request, env, ctx, now);
    }
    if (method === "POST" && pathname === "/v1/host/close") {
      return await handleHostClose(request, env, ctx, now);
    }
    if (method === "POST" && pathname === "/v1/submit") {
      return await handleSubmit(request, env, ctx, now);
    }
    if (method === "GET" && pathname === "/v1/status") {
      return await handleStatus(request, env, url, now);
    }
    if (
      pathname === "/v1/register" ||
      pathname === "/v1/host/registration"
    ) {
      return errorResponse("NOT_FOUND", "Registration is planned for M10");
    }

    return errorResponse("NOT_FOUND", `Route not found: ${method} ${pathname}`);
  } catch {
    return errorResponse("INTERNAL", "Internal server error");
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // TODO(M3 step d): Archive closed tournaments from D1 to R2
    // (closed -> archiving -> archived, verify counts + SHA-256, delete D1 rows in 500-row batches).
  },
} satisfies ExportedHandler<Env>;
