// MCP: JSON-RPC 2.0 over streamable HTTP at /mcp, in both eras the
// suite's client speaks (the modern server/discover handshake and the
// legacy initialize handshake). Plain JSON responses suffice; the client
// accepts JSON or SSE.
//
// Six tools, all backed by the same store the REST API uses, so a tool
// call's effect is visible over REST immediately (the rest-parity check)
// and vice versa.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  isAuthorized,
  sendEmpty,
  sendJson,
  TRIAL_NOW_ISO,
  type Ctx,
} from './util.ts';
import {
  createCommit,
  EMPTY_TREE_OID,
  threeWayMerge,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

// -------------------------------------------------------------------------------------------
// Tool definitions (a static constant: tools/list must be byte-identical across calls)
// -------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner (ignored; repositories belong to the token owner).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// -------------------------------------------------------------------------------------------
// Tool execution
// -------------------------------------------------------------------------------------------

type ToolOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 },
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullObject(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Run one tool by name; `missing` reports a required argument that was absent. */
function runTool(
  forge: Forge,
  name: string,
  args: Record<string, unknown>,
): ToolOutcome | { missing: string } {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { ok: false, message: `unknown tool ${name}` };
  for (const required of def.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') return { missing: required };
  }

  if (name === 'create_repo') {
    const repoName = stringArg(args, 'name') as string;
    const description = stringArg(args, 'description') ?? '';
    const isPrivate = args.private === true;
    const repo = forge.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
    if (repo === null) return { ok: false, message: 'name already exists on this account' };
    return { ok: true, value: repoObject(repo) };
  }

  const owner = stringArg(args, 'owner') as string;
  const repoName = stringArg(args, 'repo') as string;
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return { ok: false, message: 'Not Found' };

  if (name === 'get_repo') {
    return { ok: true, value: repoObject(repo) };
  }
  if (name === 'create_issue') {
    const title = stringArg(args, 'title') as string;
    const seq = forge.nextSeq();
    const issue: Issue = {
      id: forge.nextId(),
      number: repo.nextNumber,
      title,
      body: stringArg(args, 'body') ?? '',
      state: 'open',
      labels: [],
      comments: [],
      createdAt: repo.createdAt,
      updatedAt: repo.createdAt,
      seq,
      updateSeq: seq,
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return { ok: true, value: issueObject(repo, issue) };
  }
  if (name === 'list_issues') {
    const state = stringArg(args, 'state') ?? 'open';
    let filtered = repo.issues;
    if (state === 'open') filtered = filtered.filter((issue) => issue.state === 'open');
    else if (state === 'closed') filtered = filtered.filter((issue) => issue.state === 'closed');
    return { ok: true, value: { issues: filtered.map((issue) => issueObject(repo, issue)) } };
  }
  if (name === 'create_pull_request') {
    const title = stringArg(args, 'title') as string;
    const headRef = stringArg(args, 'head') as string;
    const baseRef = stringArg(args, 'base') as string;
    const headSha = repo.refTip(`refs/heads/${headRef}`);
    const baseSha = repo.refTip(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      return { ok: false, message: 'head or base branch does not exist' };
    }
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
        return { ok: false, message: 'A pull request already exists for these branches' };
      }
    }
    const pull: Pull = {
      id: forge.nextId(),
      number: repo.nextNumber,
      title,
      body: stringArg(args, 'body') ?? '',
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: repo.createdAt,
      updatedAt: repo.createdAt,
      seq: forge.nextSeq(),
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    repo.pullsByNumber.set(pull.number, pull);
    return { ok: true, value: pullObject(pull) };
  }
  if (name === 'merge_pull_request') {
    const pullNumber = numberArg(args, 'pull_number');
    if (pullNumber === undefined) return { missing: 'pull_number' };
    const pull = repo.pullsByNumber.get(pullNumber);
    if (pull === undefined) return { ok: false, message: 'Not Found' };
    if (pull.merged || pull.state !== 'open') {
      return { ok: false, message: 'Pull request is already merged or closed' };
    }
    const baseTip = repo.refTip(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headTip = repo.refTip(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseView = repo.parseCommitCached(baseTip);
    const headView = repo.parseCommitCached(headTip);
    if (baseView === null || headView === null) return { ok: false, message: 'Head or base commit is missing' };
    const ancestor = repo.mergeBase(baseTip, headTip);
    const ancestorTree = ancestor === null ? EMPTY_TREE_OID : (repo.parseCommitCached(ancestor)?.tree ?? EMPTY_TREE_OID);
    const merged = threeWayMerge(repo, baseView.tree, headView.tree, ancestorTree);
    if (!merged.ok) return { ok: false, message: `Merge conflict in ${merged.conflict}` };
    const commitOid = createCommit(repo, merged.treeOid, [baseTip], `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = TRIAL_NOW_ISO;
    pull.mergeCommitSha = commitOid;
    return { ok: true, value: { merged: true, sha: commitOid, number: pull.number, ...pullObject(pull) } };
  }
  return { ok: false, message: `unknown tool ${name}` };
}

// -------------------------------------------------------------------------------------------
// JSON-RPC dispatcher
// -------------------------------------------------------------------------------------------

type RpcId = string | number | null;

interface RpcRequest {
  jsonrpc?: unknown;
  id?: RpcId;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one JSON-RPC request object. Returns the response object, or null
 * for a notification (which gets no response).
 */
function handleRpc(forge: Forge, request: RpcRequest): Record<string, unknown> | null {
  const id: RpcId = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined;
  const method = request.method;

  if (typeof method !== 'string') {
    if (isNotification) return null;
    return rpcError(id, -32600, 'Invalid Request');
  }

  if (method === 'server/discover') {
    if (isNotification) return null;
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }

  if (method === 'initialize') {
    if (isNotification) return null;
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    if (isNotification) return null;
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    if (isNotification) return null;
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    if (isNotification) return null;
    const params = request.params as Record<string, unknown> | undefined;
    const toolName = typeof params?.name === 'string' ? params.name : undefined;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    if (toolName === undefined) return rpcError(id, -32602, 'tool name is required');
    const def = TOOLS.find((tool) => tool.name === toolName);
    if (def === undefined) return rpcError(id, -32602, `unknown tool ${toolName}`);
    const outcome = runTool(forge, toolName, args);
    if ('missing' in outcome) {
      return rpcError(id, -32602, `missing required argument ${outcome.missing}`);
    }
    if (!outcome.ok) {
      return rpcResult(id, {
        content: [{ type: 'text', text: outcome.message }],
        isError: true,
      });
    }
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      structuredContent: outcome.value,
    });
  }

  // Notifications of any other kind (e.g. notifications/initialized) get no reply.
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

// -------------------------------------------------------------------------------------------
// HTTP handler
// -------------------------------------------------------------------------------------------

/**
 * Handle an MCP request. Returns true when the path is /mcp (even when it
 * errored), false when it is not an MCP route.
 */
export function handleMcp(forge: Forge, ctx: Ctx): boolean {
  if (ctx.segments.length !== 1 || ctx.segments[0] !== 'mcp') return false;

  if (!isAuthorized(ctx.req.headers.authorization)) {
    sendJson(ctx, 401, rpcError(null, -32001, 'Unauthorized'));
    return true;
  }
  if (ctx.method === 'GET' || ctx.method === 'DELETE') {
    sendEmpty(ctx, 405);
    return true;
  }
  if (ctx.method !== 'POST') {
    sendEmpty(ctx, 405);
    return true;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }

  if (Array.isArray(payload)) {
    const responses: Record<string, unknown>[] = [];
    for (const item of payload) {
      const response = handleRpc(forge, item as RpcRequest);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      sendEmpty(ctx, 202);
      return true;
    }
    sendJson(ctx, 200, responses);
    return true;
  }

  const response = handleRpc(forge, payload as RpcRequest);
  if (response === null) {
    sendEmpty(ctx, 202);
    return true;
  }
  sendJson(ctx, 200, response);
  return true;
}
