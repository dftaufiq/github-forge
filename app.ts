// The HTTP server: one process, one Forge, five surfaces (the health probe
// the env's boot check calls, git smart HTTP, REST v3, GraphQL v4, MCP)
// behind a single router.
//
// The router tries each surface in turn; a surface returns true when the
// path belongs to it (even when it answers with an error), so an unknown
// path falls through to a JSON 404. A request that throws anywhere is
// answered with a 500 rather than taking the server down: the suite's
// "repository survives errors" checks depend on that.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { nextRequestId, sendError, sendJson, type Ctx } from './util.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** The largest request body accepted (packs are the big ones; the suite's are small). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read the request body fully, or reject when it exceeds the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });
  });
}

/** Split a pathname into decoded segments, tolerating a bad escape. */
function pathSegments(pathname: string): string[] {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      segments.push(raw);
    }
  }
  return segments;
}

/** Send a bare JSON error when no context object exists yet (bad URL, oversized body). */
function sendBareError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // The socket is already gone; nothing left to do.
    }
    return;
  }
  const body = Buffer.from(JSON.stringify({ message }), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextRequestId(),
    Connection: 'keep-alive',
  });
  res.end(body);
}

// -------------------------------------------------------------------------------------------
// Request handling and server construction
// -------------------------------------------------------------------------------------------

/** Answer one request, routing it to the surface that owns its path. */
async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  } catch {
    sendBareError(res, 400, 'Bad request URL');
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendBareError(res, 413, 'Request body too large');
    return;
  }
  const ctx: Ctx = { req, res, method: req.method ?? 'GET', url, body, segments: pathSegments(url.pathname) };
  try {
    // The env's boot check: 200 {"ok":true}, no auth.
    if ((req.method ?? 'GET') === 'GET' && url.pathname === '/healthz') {
      sendJson(ctx, 200, { ok: true });
      return;
    }
    if (handleGit(forge, ctx)) return;
    if (handleRest(forge, ctx)) return;
    if (handleGraphql(forge, ctx)) return;
    if (handleMcp(forge, ctx)) return;
    sendError(ctx, 404, 'Not Found');
  } catch {
    // A handler threw: answer 500 and keep serving. The suite posts
    // malformed bodies on purpose; the server must survive them.
    if (!res.headersSent) {
      try {
        sendError(ctx, 500, 'Internal Server Error');
      } catch {
        try {
          res.end();
        } catch {
          // Nothing left to do.
        }
      }
    } else {
      try {
        res.end();
      } catch {
        // Nothing left to do.
      }
    }
  }
}

export interface App {
  forge: Forge;
  server: Server;
}

/** Build the server. It binds nothing until the caller listens on an ephemeral port. */
export function createApp(): App {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(forge, req, res);
  });
  server.on('clientError', (_error, socket) => {
    // A malformed HTTP request: drop the socket without crashing.
    socket.destroy();
  });
  return { forge, server };
}
