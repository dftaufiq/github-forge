// The forge's in-memory store: repositories, git objects, issues, pull
// requests, labels and comments, plus the git object model (hashing, tree /
// commit / tag parsing and building) and the tree operations the contents,
// diff and merge paths need.
//
// Everything lives in memory: a trial is one process, and the suite never
// asks the entry to survive a restart. Objects are immutable once stored,
// so parsed views and flattened trees are cached forever by object id.

import { sha1Hex, isOid, nextCommitEpoch, TRIAL_NOW_ISO, VIEWER_NAME, VIEWER_EMAIL } from './util.ts';

// -------------------------------------------------------------------------------------------
// Git objects
// -------------------------------------------------------------------------------------------

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(header, data);
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  const text = `${lines.join('\n')}\n${fields.message}`;
  return Buffer.from(text, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** The identity line every commit the server mints carries. */
export function serverIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
}

// -------------------------------------------------------------------------------------------
// Issues, pull requests, labels, comments
// -------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  /** Creation order, for sort=created. */
  seq: number;
  /** Last mutation order, for sort=updated. */
  updateSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

// -------------------------------------------------------------------------------------------
// One repository
// -------------------------------------------------------------------------------------------

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;

  /** Object id -> object. Objects are never mutated once stored. */
  readonly objects = new Map<string, GitObject>();
  /** Full ref name -> object id. */
  readonly refs = new Map<string, string>();
  /** Label name -> label. */
  readonly labels = new Map<string, Label>();
  /** Issues in creation order. */
  readonly issues: Issue[] = [];
  readonly issuesByNumber = new Map<number, Issue>();
  /** Pull requests in creation order. */
  readonly pulls: Pull[] = [];
  readonly pullsByNumber = new Map<number, Pull>();
  /** Issues and pull requests share one number space, as on GitHub. */
  nextNumber = 1;

  // Caches. Everything keyed by object id is valid forever (objects are
  // immutable); the issue body cache is invalidated on mutation.
  private readonly commitCache = new Map<string, CommitView>();
  private readonly treeCache = new Map<string, TreeEntry[]>();
  private readonly flatTreeCache = new Map<string, Map<string, { oid: string; mode: string }>>();
  /** Fetch pack cache: send-set key -> pack bytes. */
  readonly packCache = new Map<string, Buffer>();
  /** Serialized single-issue JSON bodies, for the read workload. */
  readonly issueBodyCache = new Map<number, Buffer>();

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.fullName = `${owner}/${name}`;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = 'main';
    this.createdAt = TRIAL_NOW_ISO;
    this.updatedAt = TRIAL_NOW_ISO;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store an object, returning its id (computed from its bytes). */
  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object under a known id (used by the pack unpacker, which already verified it). */
  putObjectAt(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  /** A commit's parsed view, cached. Null when the object is absent or not a commit. */
  parseCommitCached(oid: string): CommitView | null {
    const cached = this.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    try {
      const view = parseCommit(object.data);
      if (!isOid(view.tree)) return null;
      this.commitCache.set(oid, view);
      return view;
    } catch {
      return null;
    }
  }

  /** A tree's entries, cached. Null when the object is absent or not a tree. */
  parseTreeCached(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return null;
    try {
      const entries = parseTree(object.data);
      this.treeCache.set(oid, entries);
      return entries;
    } catch {
      return null;
    }
  }

  /**
   * A tree flattened to path -> {oid, mode} for every file below it,
   * cached. Null when the tree is absent.
   */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> | null {
    const cached = this.flatTreeCache.get(treeOid);
    if (cached !== undefined) return cached;
    const entries = this.parseTreeCached(treeOid);
    if (entries === null) return null;
    const flat = new Map<string, { oid: string; mode: string }>();
    const walk = (tree: string, prefix: string): boolean => {
      const list = this.parseTreeCached(tree);
      if (list === null) return false;
      for (const entry of list) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') {
          if (!walk(entry.oid, path)) return false;
        } else {
          flat.set(path, { oid: entry.oid, mode: entry.mode });
        }
      }
      return true;
    };
    if (!walk(treeOid, '')) return null;
    this.flatTreeCache.set(treeOid, flat);
    return flat;
  }

  /** The object id a ref points at, or undefined. */
  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  /** The default branch's tip, or undefined when the repository is unborn. */
  defaultTip(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  /** All branch names, sorted. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    names.sort();
    return names;
  }

  /** First-parent history from a tip, newest first. */
  commitHistory(tipOid: string): string[] {
    const out: string[] = [];
    let current: string | undefined = tipOid;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const view = this.parseCommitCached(current);
      if (view === null) break;
      out.push(current);
      current = view.parents[0];
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` (following all parents). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.parseCommitCached(oid);
      if (view === null) continue;
      for (const parent of view.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /**
   * The merge base of two commits: the first common ancestor found walking
   * from `b` through the ancestor set of `a`. Null when they share none.
   */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const view = this.parseCommitCached(oid);
      if (view !== null) for (const parent of view.parents) queueA.push(parent);
    }
    const seenB = new Set<string>();
    const queueB: string[] = [b];
    while (queueB.length > 0) {
      const oid = queueB.shift() as string;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const view = this.parseCommitCached(oid);
      if (view !== null) for (const parent of view.parents) queueB.push(parent);
    }
    return null;
  }

  /** Follow tag objects to the commit (or other object) they point at. */
  peel(oid: string): string {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag' || seen.has(current)) return current;
      seen.add(current);
      try {
        current = parseTag(object.data).object;
      } catch {
        return current;
      }
    }
  }

  /** Drop a cached serialized issue body (call on any mutation of the issue). */
  invalidateIssue(number: number): void {
    this.issueBodyCache.delete(number);
  }
}

// -------------------------------------------------------------------------------------------
// The whole forge
// -------------------------------------------------------------------------------------------

export class Forge {
  private readonly repos = new Map<string, Repo>();
  private readonly repoList: Repo[] = [];
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private mutationSeq = 0;

  /** A fresh global numeric id (issue / pull / comment / label ids). */
  nextId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }

  /** A fresh mutation sequence number, for sort=updated ordering. */
  nextSeq(): number {
    this.mutationSeq += 1;
    return this.mutationSeq;
  }

  /** Create a repository under `owner`; null when the name is already taken there. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    this.repoList.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    const index = this.repoList.indexOf(repo);
    if (index >= 0) this.repoList.splice(index, 1);
    return true;
  }

  /** Every repository owned by `owner`, in creation order. */
  listRepos(owner: string): Repo[] {
    return this.repoList.filter((repo) => repo.owner === owner);
  }

  /** A repository by its numeric database id, or undefined. */
  getRepoById(id: number): Repo | undefined {
    return this.repoList.find((repo) => repo.id === id);
  }
}

// -------------------------------------------------------------------------------------------
// Commits, tree edits, diffs and merges
// -------------------------------------------------------------------------------------------

/** The object id of the empty tree (computed, not hardcoded). */
export const EMPTY_TREE_OID: string = hashObject('tree', Buffer.alloc(0));

/** Mint a commit object (as the viewer, at the next logical timestamp) and store it. */
export function createCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const identity = serverIdentity();
  const bytes = buildCommit({
    tree: treeOid,
    parents,
    message,
    author: identity,
    committer: identity,
    timestamp: nextCommitEpoch(),
  });
  return repo.putObject('commit', bytes);
}

/**
 * The tree that results from setting `path` to `blobOid` (mode 100644) in
 * `baseTreeOid`, building the new directory chain. Null base tree means the
 * repository is unborn and the tree is built from scratch.
 */
export function treeWithFile(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const build = (treeOid: string | null, depth: number): string => {
    const entries = treeOid === null ? [] : (repo.parseTreeCached(treeOid) ?? []);
    const next = [...entries];
    const name = segments[depth];
    const existing = next.findIndex((entry) => entry.name === name);
    if (depth === segments.length - 1) {
      const fileEntry: TreeEntry = { mode: '100644', name, oid: blobOid };
      if (existing >= 0) next[existing] = fileEntry;
      else next.push(fileEntry);
    } else {
      const childTree = existing >= 0 && next[existing].mode === '40000' ? next[existing].oid : null;
      const rebuilt = build(childTree, depth + 1);
      const dirEntry: TreeEntry = { mode: '40000', name, oid: rebuilt };
      if (existing >= 0) next[existing] = dirEntry;
      else next.push(dirEntry);
    }
    return repo.putObject('tree', buildTree(next));
  };
  return build(baseTreeOid, 0);
}

/**
 * The tree that results from removing `path` from `treeOid`, or null when
 * the path is not a file in the tree. Directories left empty are pruned.
 */
export function treeWithoutFile(repo: Repo, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  const build = (tree: string, depth: number): string | null => {
    const entries = repo.parseTreeCached(tree);
    if (entries === null) return null;
    const name = segments[depth];
    const index = entries.findIndex((entry) => entry.name === name);
    if (index < 0) return null;
    const next = [...entries];
    if (depth === segments.length - 1) {
      if (next[index].mode === '40000') return null;
      next.splice(index, 1);
    } else {
      if (next[index].mode !== '40000') return null;
      const rebuilt = build(next[index].oid, depth + 1);
      if (rebuilt === null) return null;
      if (rebuilt === EMPTY_TREE_OID) next.splice(index, 1);
      else next[index] = { mode: '40000', name, oid: rebuilt };
    }
    return repo.putObject('tree', buildTree(next));
  };
  return build(treeOid, 0);
}

/** Look up one file in a tree: its blob id and mode, or null. */
export function lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  const flat = repo.flattenTree(treeOid);
  if (flat === null) return null;
  return flat.get(path) ?? null;
}

/**
 * List one directory of a tree: the entries directly inside `path`
 * ('' for the root), or null when the path is not a directory.
 */
export function listDirectory(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
  let current = treeOid;
  if (path !== '') {
    for (const segment of path.split('/')) {
      const entries = repo.parseTreeCached(current);
      if (entries === null) return null;
      const child = entries.find((entry) => entry.name === segment && entry.mode === '40000');
      if (child === undefined) return null;
      current = child.oid;
    }
  }
  return repo.parseTreeCached(current);
}

// -------------------------------------------------------------------------------------------
// Diffs
// -------------------------------------------------------------------------------------------

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Split content into lines the way a diff counts them (no trailing empty line). */
function contentLines(data: Uint8Array): string[] {
  const text = Buffer.from(data).toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line diff: added and removed line counts between two files. */
function lineDiff(oldData: Uint8Array, newData: Uint8Array): { additions: number; deletions: number } {
  const oldLines = contentLines(oldData);
  const newLines = contentLines(newData);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of counts.values()) deletions += remaining;
  return { additions, deletions };
}

/**
 * The file-level diff between two trees: added, removed and modified files,
 * each with line counts. Sorted by filename.
 */
export function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
  const baseFlat = repo.flattenTree(baseTreeOid) ?? new Map<string, { oid: string; mode: string }>();
  const headFlat = repo.flattenTree(headTreeOid) ?? new Map<string, { oid: string; mode: string }>();
  const changes: FileChange[] = [];
  const names = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const name of names) {
    const base = baseFlat.get(name);
    const head = headFlat.get(name);
    if (base === undefined && head !== undefined) {
      const blob = repo.getObject(head.oid);
      const additions = blob === undefined ? 1 : Math.max(1, contentLines(blob.data).length);
      changes.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base !== undefined && head === undefined) {
      const blob = repo.getObject(base.oid);
      const deletions = blob === undefined ? 1 : Math.max(1, contentLines(blob.data).length);
      changes.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const oldBlob = repo.getObject(base.oid);
      const newBlob = repo.getObject(head.oid);
      const { additions, deletions } = lineDiff(
        oldBlob === undefined ? Buffer.alloc(0) : oldBlob.data,
        newBlob === undefined ? Buffer.alloc(0) : newBlob.data,
      );
      changes.push({
        filename: name,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
  }
  changes.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return changes;
}

// -------------------------------------------------------------------------------------------
// Three-way merge (squash)
// -------------------------------------------------------------------------------------------

export type MergeResult =
  | { ok: true; treeOid: string }
  | { ok: false; conflict: string };

/**
 * Merge `headTree` into `baseTree` against `ancestorTree` (the merge base).
 * A path is conflicted when it changed on both sides to different content
 * (including add/add and delete/modify). Returns the merged tree's id, or
 * the first conflicting path.
 */
export function threeWayMerge(
  repo: Repo,
  baseTreeOid: string,
  headTreeOid: string,
  ancestorTreeOid: string,
): MergeResult {
  const baseFlat = repo.flattenTree(baseTreeOid) ?? new Map<string, { oid: string; mode: string }>();
  const headFlat = repo.flattenTree(headTreeOid) ?? new Map<string, { oid: string; mode: string }>();
  const ancestorFlat = repo.flattenTree(ancestorTreeOid) ?? new Map<string, { oid: string; mode: string }>();
  const merged = new Map<string, { oid: string; mode: string }>(baseFlat);
  const names = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...ancestorFlat.keys()]);
  for (const name of names) {
    const base = baseFlat.get(name);
    const head = headFlat.get(name);
    const ancestor = ancestorFlat.get(name);
    const baseOid = base?.oid;
    const headOid = head?.oid;
    const ancestorOid = ancestor?.oid;
    const baseChanged = baseOid !== ancestorOid;
    const headChanged = headOid !== ancestorOid;
    if (!headChanged) continue;
    if (!baseChanged) {
      if (head === undefined) merged.delete(name);
      else merged.set(name, head);
      continue;
    }
    // Both sides changed the path.
    if (baseOid === headOid) continue;
    return { ok: false, conflict: name };
  }
  // Rebuild a tree from the merged flat map, bottom-up.
  const treeFromFlat = (prefix: string): string => {
    const direct = new Map<string, { oid: string; mode: string }>();
    const subdirs = new Set<string>();
    for (const [path, entry] of merged) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) direct.set(rest, entry);
      else subdirs.add(rest.slice(0, slash));
    }
    const entries: TreeEntry[] = [];
    for (const [name, entry] of direct) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const dir of subdirs) {
      const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: treeFromFlat(childPrefix) });
    }
    return repo.putObject('tree', buildTree(entries));
  };
  return { ok: true, treeOid: treeFromFlat('') };
}
