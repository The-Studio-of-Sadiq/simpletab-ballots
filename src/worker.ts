import type { Clock, Env } from "./env";
import { runArchiveTick } from "./lib/archive";
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
import { handlePublicHeads } from "./routes/heads";
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
    if (method === "GET" && pathname.startsWith("/v1/heads/")) {
      return await handlePublicHeads(env, url, now);
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

    if ((method === "GET" || method === "HEAD") && env.ASSETS) {
      if (pathname === "/t" || pathname.startsWith("/t/")) {
        const indexUrl = new URL("/index.html", url.origin);
        return await env.ASSETS.fetch(new Request(indexUrl.toString(), request));
      }
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }
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
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const work = runArchiveTick(env, controller.scheduledTime).then(() => undefined);
    ctx.waitUntil(work);
    await work;
  },
} satisfies ExportedHandler<Env>;
