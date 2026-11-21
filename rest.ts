// REST v3: repositories, branches, refs, commits, contents, labels,
// issues, comments and pull requests.
//
// The shape of every response follows what the suite's client reads:
// extra fields are tolerated, missing ones are not. Errors are JSON
// {"message": ...} with the status GitHub uses for the same failure:
// 401 without a token, 404 for an absent resource, 409 for a stale sha,
// 422 for a validation failure, 405 for a conflicted merge.

import {
  TRIAL_EPOCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  b64decode,
  b64encode,
  isAuthorized,
  parsePositiveInt,
  sendEmpty,
  sendError,
  sendJson,
  sendJsonBuffer,
  type Ctx,
} from './util.ts';
import {
  createCommit,
  diffTrees,
  EMPTY_TREE_OID,
  listDirectory,
  lookupPath,
  threeWayMerge,
  treeWithFile,
  treeWithoutFile,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// Serializers
// -------------------------------------------------------------------------------------------

function hostOf(ctx: Ctx): string {
  return ctx.req.headers.host ?? '127.0.0.1';
}

function repoJson(repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    html_url: `http://${host}/${repo.fullName}`,
    url: `http://${host}/api/v3/repos/${repo.fullName}`,
    clone_url: `http://${host}/${repo.fullName}.git`,
    git_url: `git://${host}/${repo.fullName}.git`,
    ssh_url: `git@${host}:${repo.fullName}.git`,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? '000000', description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    comments: issue.comments.length,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

/** A cached serialized single-issue body (the read workload's hot path). */
function issueBodyBuffer(repo: Repo, issue: Issue): Buffer {
  const cached = repo.issueBodyCache.get(issue.number);
  if (cached !== undefined) return cached;
  const body = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  repo.issueBodyCache.set(issue.number, body);
  return body;
}

function pullJson(_repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}

// -------------------------------------------------------------------------------------------
// Request helpers
// -------------------------------------------------------------------------------------------

/** Parse the JSON body; null when it is malformed (the caller sends the 400). */
function jsonBody(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      out.push((item as { name: string }).name);
    }
  }
  return out;
}

/**
 * Slice `items` to the requested page and build the Link header for the
 * next/last pages. The client follows `next` until it is absent.
 */
function paginate<T>(
  ctx: Ctx,
  items: readonly T[],
): { page: T[]; link: string | null } {
  const perPage = parsePositiveInt(ctx.url.searchParams.get('per_page'), 30, 100);
  const page = parsePositiveInt(ctx.url.searchParams.get('page'), 1, 100000);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page >= totalPages) return { page: slice, link: null };
  const host = hostOf(ctx);
  const base = `http://${host}${ctx.url.pathname}`;
  const params = new URLSearchParams(ctx.url.searchParams);
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  const next = `<${base}?${params.toString()}>; rel="next"`;
  params.set('page', String(totalPages));
  const last = `<${base}?${params.toString()}>; rel="last"`;
  return { page: slice, link: `${next}, ${last}` };
}

// -------------------------------------------------------------------------------------------
// Top-level routes
// -------------------------------------------------------------------------------------------

function handleRoot(ctx: Ctx): void {
  sendJson(ctx, 200, { current_user_url: `http://${hostOf(ctx)}/api/v3/user` }, {
    'X-OAuth-Scopes': 'repo, read:org',
  });
}

function handleMeta(ctx: Ctx): void {
  sendJson(ctx, 200, { installed_version: '1.0.0' });
}

function handleRateLimit(ctx: Ctx): void {
  sendJson(ctx, 200, {
    resources: {
      core: { limit: 5000, remaining: 4999, reset: TRIAL_EPOCH + 3600, used: 1 },
    },
    rate: { limit: 5000, remaining: 4999, reset: TRIAL_EPOCH + 3600, used: 1 },
  });
}

function handleUser(ctx: Ctx): void {
  sendJson(ctx, 200, {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
  });
}

// -------------------------------------------------------------------------------------------
// Repositories
// -------------------------------------------------------------------------------------------

function handleCreateRepo(forge: Forge, ctx: Ctx): void {
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const name = asString(body.name);
  if (name === undefined || name === '') {
    sendError(ctx, 422, 'name is required');
    return;
  }
  const description = asString(body.description) ?? '';
  const isPrivate = body.private === true;
  const repo = forge.createRepo(VIEWER_LOGIN, name, description, isPrivate);
  if (repo === null) {
    sendError(ctx, 422, 'name already exists on this account');
    return;
  }
  sendJson(ctx, 201, repoJson(repo, hostOf(ctx)));
}

function handleListUserRepos(forge: Forge, ctx: Ctx): void {
  const repos = forge.listRepos(VIEWER_LOGIN);
  const { page, link } = paginate(ctx, repos);
  const extra = link === null ? undefined : { Link: link };
  sendJson(ctx, 200, page.map((repo) => repoJson(repo, hostOf(ctx))), extra);
}

function handleGetRepo(repo: Repo, ctx: Ctx): void {
  sendJson(ctx, 200, repoJson(repo, hostOf(ctx)));
}

function handlePatchRepo(repo: Repo, ctx: Ctx): void {
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const description = asString(body.description);
  if (description !== undefined) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  sendJson(ctx, 200, repoJson(repo, hostOf(ctx)));
}

function handleDeleteRepo(forge: Forge, repo: Repo, ctx: Ctx): void {
  forge.deleteRepo(repo.owner, repo.name);
  sendEmpty(ctx, 204);
}

// -------------------------------------------------------------------------------------------
// Branches, refs, commits
// -------------------------------------------------------------------------------------------

import { isoOfEpoch } from './util.ts';

function handleListBranches(repo: Repo, ctx: Ctx): void {
  const branches = repo.branchNames().map((name) => ({
    name,
    commit: { sha: repo.refTip(`refs/heads/${name}`) },
    protected: false,
  }));
  sendJson(ctx, 200, branches);
}

function handleGetBranch(repo: Repo, ctx: Ctx, branch: string): void {
  const tip = repo.refTip(`refs/heads/${branch}`);
  if (tip === undefined) {
    sendError(ctx, 404, 'Branch not found');
    return;
  }
  sendJson(ctx, 200, { name: branch, commit: { sha: tip }, protected: false });
}

function handleCreateRef(forge: Forge, repo: Repo, ctx: Ctx): void {
  void forge;
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (ref === undefined || !ref.startsWith('refs/') || sha === undefined) {
    sendError(ctx, 422, 'ref and sha are required');
    return;
  }
  if (repo.refTip(ref) !== undefined) {
    sendError(ctx, 422, 'Reference already exists');
    return;
  }
  if (repo.getObject(sha) === undefined) {
    sendError(ctx, 422, 'Object does not exist');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx, 201, { ref, object: { sha, type: 'commit' } });
}

function handleGetRef(repo: Repo, ctx: Ctx, ref: string): void {
  const tip = repo.refTip(ref);
  if (tip === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, { ref, object: { sha: tip, type: 'commit' } });
}

/** Resolve a ref-ish (branch name, tag name, or object id) to a commit id. */
function resolveRefToCommit(repo: Repo, ref: string): string | null {
  const branchTip = repo.refTip(`refs/heads/${ref}`);
  if (branchTip !== undefined) return repo.peel(branchTip);
  const tagTip = repo.refTip(`refs/tags/${ref}`);
  if (tagTip !== undefined) return repo.peel(tagTip);
  const object = repo.getObject(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  if (object !== undefined && object.type === 'tag') return repo.peel(ref);
  return null;
}

/** Parse a commit identity line ("Name <email> ts +0000") for the commits list. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1], email: match[2], date: isoOfEpoch(Number(match[3])) };
}

function handleListCommits(repo: Repo, ctx: Ctx): void {
  const shaParam = ctx.url.searchParams.get('sha');
  let tip: string | null = null;
  if (shaParam === null || shaParam === '') {
    tip = repo.defaultTip() ?? null;
  } else {
    tip = resolveRefToCommit(repo, shaParam);
    if (tip === null) {
      sendError(ctx, 404, 'No commit found for SHA');
      return;
    }
  }
  if (tip === null) {
    sendJson(ctx, 200, []);
    return;
  }
  const out: Record<string, unknown>[] = [];
  for (const oid of repo.commitHistory(tip)) {
    const view = repo.parseCommitCached(oid);
    if (view === null) continue;
    const author = parseIdentity(view.author);
    const committer = parseIdentity(view.committer);
    out.push({
      sha: oid,
      commit: {
        message: view.message,
        author,
        committer,
        tree: { sha: view.tree },
      },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID },
      parents: view.parents.map((parent) => ({ sha: parent })),
    });
  }
  sendJson(ctx, 200, out);
}

// -------------------------------------------------------------------------------------------
// Contents
// -------------------------------------------------------------------------------------------

/** The branch a contents write targets, creating it from the default tip when it is new. */
function resolveWriteBranch(repo: Repo, branch: string | undefined): string {
  const target = branch ?? repo.defaultBranch;
  if (repo.refTip(`refs/heads/${target}`) === undefined) {
    const defaultTip = repo.defaultTip();
    if (defaultTip !== undefined && target !== repo.defaultBranch) {
      repo.refs.set(`refs/heads/${target}`, defaultTip);
    }
  }
  return target;
}

function handlePutContents(forge: Forge, repo: Repo, ctx: Ctx, path: string): void {
  void forge;
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const message = asString(body.message) ?? '';
  const contentB64 = asString(body.content);
  if (contentB64 === undefined) {
    sendError(ctx, 422, 'content is required');
    return;
  }
  const branch = resolveWriteBranch(repo, asString(body.branch));
  const tip = repo.refTip(`refs/heads/${branch}`);
  const baseTree = tip === undefined ? EMPTY_TREE_OID : (repo.parseCommitCached(tip)?.tree ?? EMPTY_TREE_OID);
  const existing = tip === undefined ? null : lookupPath(repo, baseTree, path);
  const givenSha = asString(body.sha);
  if (existing !== null) {
    if (givenSha === undefined) {
      sendError(ctx, 422, 'sha is required to update a file');
      return;
    }
    if (givenSha !== existing.oid) {
      sendError(ctx, 409, 'sha does not match the current file');
      return;
    }
  }
  const blobBytes = b64decode(contentB64);
  const blobOid = repo.putObject('blob', blobBytes);
  const newTree = treeWithFile(repo, tip === undefined ? null : baseTree, path, blobOid);
  const commitOid = createCommit(repo, newTree, tip === undefined ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  const name = path.split('/').pop() ?? path;
  sendJson(ctx, existing !== null ? 200 : 201, {
    content: { name, path, sha: blobOid, size: blobBytes.length, encoding: 'base64', type: 'file' },
    commit: { sha: commitOid, message },
  });
}

function handleGetContents(repo: Repo, ctx: Ctx, path: string): void {
  const refParam = ctx.url.searchParams.get('ref');
  let tip: string | null = null;
  if (refParam === null || refParam === '') {
    tip = repo.defaultTip() ?? null;
  } else {
    tip = resolveRefToCommit(repo, refParam);
  }
  if (tip === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const view = repo.parseCommitCached(tip);
  if (view === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const file = lookupPath(repo, view.tree, path);
  if (file !== null) {
    const blob = repo.getObject(file.oid);
    if (blob === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const name = path.split('/').pop() ?? path;
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name,
      path,
      sha: file.oid,
      content: b64encode(blob.data),
    });
    return;
  }
  const entries = listDirectory(repo, view.tree, path);
  if (entries === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const out = entries.map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.getObject(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      size: blob === undefined ? 0 : blob.data.length,
    };
  });
  sendJson(ctx, 200, out);
}

function handleDeleteContents(repo: Repo, ctx: Ctx, path: string): void {
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const message = asString(body.message) ?? '';
  const givenSha = asString(body.sha);
  const branch = resolveWriteBranch(repo, asString(body.branch));
  const tip = repo.refTip(`refs/heads/${branch}`);
  if (tip === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const view = repo.parseCommitCached(tip);
  if (view === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const existing = lookupPath(repo, view.tree, path);
  if (existing === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (givenSha === undefined || givenSha !== existing.oid) {
    sendError(ctx, 409, 'sha does not match the current file');
    return;
  }
  const newTree = treeWithoutFile(repo, view.tree, path);
  if (newTree === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const commitOid = createCommit(repo, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(ctx, 200, { commit: { sha: commitOid, message } });
}

// -------------------------------------------------------------------------------------------
// Labels
// -------------------------------------------------------------------------------------------

function handleCreateLabel(forge: Forge, repo: Repo, ctx: Ctx): void {
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const name = asString(body.name);
  if (name === undefined || name === '') {
    sendError(ctx, 422, 'name is required');
    return;
  }
  if (repo.labels.has(name)) {
    sendError(ctx, 422, 'Label already exists');
    return;
  }
  const color = asString(body.color) ?? '000000';
  const label = { id: forge.nextId(), name, color };
  repo.labels.set(name, label);
  sendJson(ctx, 201, { id: label.id, name, color, description: '' });
}

function handleListLabels(repo: Repo, ctx: Ctx): void {
  const labels = [...repo.labels.values()].map((label) => ({
    id: label.id,
    name: label.name,
    color: label.color,
    description: '',
  }));
  sendJson(ctx, 200, labels);
}

// -------------------------------------------------------------------------------------------
// Issues and comments
// -------------------------------------------------------------------------------------------

function handleCreateIssue(forge: Forge, repo: Repo, ctx: Ctx): void {
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const title = asString(body.title);
  if (title === undefined || title === '') {
    sendError(ctx, 422, 'title is required');
    return;
  }
  const labelNames = asStringArray(body.labels) ?? [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) {
      sendError(ctx, 422, `Label '${name}' does not exist`);
      return;
    }
  }
  const seq = forge.nextSeq();
  const issue: Issue = {
    id: forge.nextId(),
    number: repo.nextNumber,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    labels: labelNames,
    comments: [],
    createdAt: '',
    updatedAt: '',
    seq,
    updateSeq: seq,
  };
  issue.createdAt = repo.createdAt;
  issue.updatedAt = repo.createdAt;
  repo.nextNumber += 1;
  repo.issues.push(issue);
  repo.issuesByNumber.set(issue.number, issue);
  sendJson(ctx, 201, issueJson(repo, issue));
}

function handleListIssues(repo: Repo, ctx: Ctx): void {
  const stateParam = ctx.url.searchParams.get('state') ?? 'open';
  const sortParam = ctx.url.searchParams.get('sort') ?? 'created';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let filtered = repo.issues;
  if (stateParam === 'open') filtered = filtered.filter((issue) => issue.state === 'open');
  else if (stateParam === 'closed') filtered = filtered.filter((issue) => issue.state === 'closed');
  const sorted = [...filtered];
  const keyOf = (issue: Issue): number => {
    if (sortParam === 'updated') return issue.updateSeq;
    if (sortParam === 'comments') return issue.comments.length;
    return issue.seq;
  };
  sorted.sort((a, b) => {
    const keyDiff = keyOf(a) - keyOf(b);
    const cmp = keyDiff !== 0 ? keyDiff : a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  const { page, link } = paginate(ctx, sorted);
  const extra = link === null ? undefined : { Link: link };
  sendJson(ctx, 200, page.map((issue) => issueJson(repo, issue)), extra);
}

function handleGetIssue(repo: Repo, ctx: Ctx, number: number): void {
  const issue = repo.issuesByNumber.get(number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJsonBuffer(ctx, 200, issueBodyBuffer(repo, issue));
}

function handlePatchIssue(forge: Forge, repo: Repo, ctx: Ctx, number: number): void {
  const issue = repo.issuesByNumber.get(number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const title = asString(body.title);
  if (title !== undefined) issue.title = title;
  const text = asString(body.body);
  if (text !== undefined) issue.body = text;
  const state = asString(body.state);
  if (state !== undefined) {
    if (state !== 'open' && state !== 'closed') {
      sendError(ctx, 422, 'state must be open or closed');
      return;
    }
    issue.state = state;
  }
  const labelNames = asStringArray(body.labels);
  if (labelNames !== undefined) {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) {
        sendError(ctx, 422, `Label '${name}' does not exist`);
        return;
      }
    }
    issue.labels = labelNames;
  }
  issue.updateSeq = forge.nextSeq();
  repo.invalidateIssue(number);
  sendJson(ctx, 200, issueJson(repo, issue));
}

function handleCreateComment(forge: Forge, repo: Repo, ctx: Ctx, number: number): void {
  const issue = repo.issuesByNumber.get(number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const text = asString(body.body);
  if (text === undefined) {
    sendError(ctx, 422, 'body is required');
    return;
  }
  const comment = {
    id: forge.nextId(),
    body: text,
    createdAt: repo.createdAt,
    updatedAt: repo.createdAt,
  };
  issue.comments.push(comment);
  issue.updateSeq = forge.nextSeq();
  repo.invalidateIssue(number);
  sendJson(ctx, 201, {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  });
}

function handleListComments(repo: Repo, ctx: Ctx, number: number): void {
  const issue = repo.issuesByNumber.get(number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, issue.comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  })));
}

// -------------------------------------------------------------------------------------------
// Pull requests
// -------------------------------------------------------------------------------------------

import { TRIAL_NOW_ISO } from './util.ts';

function handleCreatePull(forge: Forge, repo: Repo, ctx: Ctx): void {
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const title = asString(body.title);
  const headRef = asString(body.head);
  const baseRef = asString(body.base);
  if (title === undefined || title === '' || headRef === undefined || baseRef === undefined) {
    sendError(ctx, 422, 'title, head and base are required');
    return;
  }
  const headSha = repo.refTip(`refs/heads/${headRef}`);
  const baseSha = repo.refTip(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) {
    sendError(ctx, 422, 'head or base branch does not exist');
    return;
  }
  for (const existing of repo.pulls) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      sendError(ctx, 422, 'A pull request already exists for these branches');
      return;
    }
  }
  const pull: Pull = {
    id: forge.nextId(),
    number: repo.nextNumber,
    title,
    body: asString(body.body) ?? '',
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
  sendJson(ctx, 201, pullJson(repo, pull));
}

function handleListPulls(repo: Repo, ctx: Ctx): void {
  const stateParam = ctx.url.searchParams.get('state') ?? 'open';
  let filtered = repo.pulls;
  if (stateParam === 'open') filtered = filtered.filter((pull) => pull.state === 'open');
  else if (stateParam === 'closed') filtered = filtered.filter((pull) => pull.state === 'closed');
  const { page, link } = paginate(ctx, filtered);
  const extra = link === null ? undefined : { Link: link };
  sendJson(ctx, 200, page.map((pull) => pullJson(repo, pull)), extra);
}

function handleGetPull(repo: Repo, ctx: Ctx, number: number): void {
  const pull = repo.pullsByNumber.get(number);
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, pullJson(repo, pull));
}

function handlePullFiles(repo: Repo, ctx: Ctx, number: number): void {
  const pull = repo.pullsByNumber.get(number);
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const baseTree = repo.parseCommitCached(pull.baseSha)?.tree ?? EMPTY_TREE_OID;
  const headTree = repo.parseCommitCached(pull.headSha)?.tree ?? EMPTY_TREE_OID;
  const changes = diffTrees(repo, baseTree, headTree);
  sendJson(ctx, 200, changes.map((change) => ({
    filename: change.filename,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.changes,
  })));
}

function handleMergePull(forge: Forge, repo: Repo, ctx: Ctx, number: number): void {
  void forge;
  const pull = repo.pullsByNumber.get(number);
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = jsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  if (pull.merged || pull.state !== 'open') {
    sendError(ctx, 405, 'Pull request is already merged or closed');
    return;
  }
  const baseTip = repo.refTip(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refTip(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseView = repo.parseCommitCached(baseTip);
  const headView = repo.parseCommitCached(headTip);
  if (baseView === null || headView === null) {
    sendError(ctx, 405, 'Head or base commit is missing');
    return;
  }
  const ancestor = repo.mergeBase(baseTip, headTip);
  const ancestorTree = ancestor === null ? EMPTY_TREE_OID : (repo.parseCommitCached(ancestor)?.tree ?? EMPTY_TREE_OID);
  const merged = threeWayMerge(repo, baseView.tree, headView.tree, ancestorTree);
  if (!merged.ok) {
    sendError(ctx, 405, `Merge conflict in ${merged.conflict}`);
    return;
  }
  const commitOid = createCommit(repo, merged.treeOid, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = commitOid;
  sendJson(ctx, 200, { sha: commitOid, merged: true, message: 'Pull Request successfully merged' });
}

// -------------------------------------------------------------------------------------------
// Dispatcher
// -------------------------------------------------------------------------------------------

/** Parse a positive integer path segment, or null. */
function pathNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  return Number(segment);
}

/**
 * Handle a REST v3 request. Returns true when the path is under /api/v3
 * (even when it errored), false when it is not a REST route.
 */
export function handleRest(forge: Forge, ctx: Ctx): boolean {
  const segments = ctx.segments;
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);

  // The API root and meta are public; everything else needs the token.
  if (rest.length === 0) {
    if (ctx.method === 'GET') handleRoot(ctx);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (ctx.method === 'GET') handleMeta(ctx);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!isAuthorized(ctx.req.headers.authorization)) {
    sendError(ctx, 401, 'Bad credentials');
    return true;
  }

  if (rest.length === 1 && rest[0] === 'rate_limit') {
    if (ctx.method === 'GET') handleRateLimit(ctx);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (rest.length === 1 && rest[0] === 'user') {
    if (ctx.method === 'GET') handleUser(ctx);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (ctx.method === 'POST') handleCreateRepo(forge, ctx);
    else if (ctx.method === 'GET') handleListUserRepos(forge, ctx);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }

  if (rest[0] !== 'repos' || rest.length < 3) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const repo = forge.getRepo(rest[1], rest[2]);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const tail = rest.slice(3);
  if (tail.length === 0) {
    if (ctx.method === 'GET') handleGetRepo(repo, ctx);
    else if (ctx.method === 'PATCH') handlePatchRepo(repo, ctx);
    else if (ctx.method === 'DELETE') handleDeleteRepo(forge, repo, ctx);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }

  const head = tail[0];
  if (head === 'branches') {
    if (tail.length === 1 && ctx.method === 'GET') handleListBranches(repo, ctx);
    else if (tail.length >= 2 && ctx.method === 'GET') handleGetBranch(repo, ctx, tail.slice(1).join('/'));
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (head === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && ctx.method === 'POST') handleCreateRef(forge, repo, ctx);
    else if (tail.length >= 3 && ctx.method === 'GET') handleGetRef(repo, ctx, `refs/${tail.slice(2).join('/')}`);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (head === 'commits') {
    if (tail.length === 1 && ctx.method === 'GET') handleListCommits(repo, ctx);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    if (ctx.method === 'PUT') handlePutContents(forge, repo, ctx, path);
    else if (ctx.method === 'GET') handleGetContents(repo, ctx, path);
    else if (ctx.method === 'DELETE') handleDeleteContents(repo, ctx, path);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (head === 'labels') {
    if (tail.length === 1 && ctx.method === 'POST') handleCreateLabel(forge, repo, ctx);
    else if (tail.length === 1 && ctx.method === 'GET') handleListLabels(repo, ctx);
    else sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (head === 'issues') {
    if (tail.length === 1) {
      if (ctx.method === 'POST') handleCreateIssue(forge, repo, ctx);
      else if (ctx.method === 'GET') handleListIssues(repo, ctx);
      else sendError(ctx, 404, 'Not Found');
      return true;
    }
    const number = pathNumber(tail[1]);
    if (number === null) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (tail.length === 2) {
      if (ctx.method === 'GET') handleGetIssue(repo, ctx, number);
      else if (ctx.method === 'PATCH') handlePatchIssue(forge, repo, ctx, number);
      else sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (ctx.method === 'POST') handleCreateComment(forge, repo, ctx, number);
      else if (ctx.method === 'GET') handleListComments(repo, ctx, number);
      else sendError(ctx, 404, 'Not Found');
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (ctx.method === 'POST') handleCreatePull(forge, repo, ctx);
      else if (ctx.method === 'GET') handleListPulls(repo, ctx);
      else sendError(ctx, 404, 'Not Found');
      return true;
    }
    const number = pathNumber(tail[1]);
    if (number === null) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (tail.length === 2 && ctx.method === 'GET') {
      handleGetPull(repo, ctx, number);
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files' && ctx.method === 'GET') {
      handlePullFiles(repo, ctx, number);
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge' && ctx.method === 'PUT') {
      handleMergePull(forge, repo, ctx, number);
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}
