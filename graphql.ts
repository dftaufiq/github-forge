// GraphQL v4: a small parser and executor for exactly the documents the
// suite sends, plus the introspection surface those documents probe.
//
// The parser is a tokenizer plus a recursive-descent parser for the
// query language subset the suite uses: operations, variables, aliases,
// inline fragments, fragment spreads, input objects, lists and enums.
// The executor validates field names against a small schema table first
// (an unknown field fails the whole operation with data null, as the
// suite expects), then resolves against the same store the REST API uses,
// so mutations made here are visible there and vice versa.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  b64decode,
  b64encode,
  b64urlDecode,
  b64urlEncode,
  isAuthorized,
  sendError,
  sendJson,
  TRIAL_NOW_ISO,
  type Ctx,
} from './util.ts';
import {
  createCommit,
  diffTrees,
  EMPTY_TREE_OID,
  threeWayMerge,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// Tokenizer
// -------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'number' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const NAME_START = /[_A-Za-z]/;
const NAME_PART = /[_0-9A-Za-z]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = source.length;
  while (i < length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < length) {
        const c = source[j];
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\n') throw new Error('unterminated string');
        if (c === '\\') {
          const escape = source[j + 1];
          if (escape === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          const simple: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          value += simple[escape] ?? escape;
          j += 2;
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        j += 1;
        while (j < length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (/[0-9]/.test(source[k] ?? '')) {
          j = k;
          while (j < length && /[0-9]/.test(source[j])) j += 1;
        }
      }
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < length && NAME_PART.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in query`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// AST and parser
// -------------------------------------------------------------------------------------------

export type GValue =
  | string
  | number
  | boolean
  | null
  | GValue[]
  | { [key: string]: GValue }
  | { __var: string }
  | { __enum: string };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, GValue>;
  selections: Selection[] | null;
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

export type Selection = FieldNode | SpreadNode | InlineFragmentNode;

export interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: Selection[];
}

export interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private readonly tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.position];
  }

  private next(): Token {
    const token = this.tokens[this.position];
    if (this.position < this.tokens.length - 1) this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}", found ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, found ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
        continue;
      }
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('document has no operation');
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: Operation['kind'] = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      kind = token.value;
      this.next();
      if (this.peek().kind === 'name') name = this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
      this.skipDirectives();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseFragment(): FragmentDef {
    this.expectName(); // 'fragment'
    const name = this.expectName();
    const on = this.expectName();
    if (on !== 'on') throw new Error('fragment must have "on Type"');
    const typeCondition = this.expectName();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { name, typeCondition, selections };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, GValue> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, GValue> {
    const args: Record<string, GValue> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { __var: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: GValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return values;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: { [key: string]: GValue } = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        object[name] = this.parseValue();
      }
      this.next();
      return object;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// -------------------------------------------------------------------------------------------
// Schema table, global ids, nodes
// -------------------------------------------------------------------------------------------

/** An error the executor turns into a GraphQL errors entry with data null. */
export class GraphQLError extends Error {}

export interface GNode {
  __type: string;
  [key: string]: unknown;
}

/** The fields each object type carries, for validation and introspection. */
const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'description', 'issue', 'issues',
    'pullRequest', 'pullRequests',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'labels', 'comments', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName',
    'mergeable', 'merged', 'mergedAt', 'files', 'createdAt', 'updatedAt', 'author',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFilesConnection: ['nodes', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  ChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'];

/** An opaque global id: base64url of "Kind:part:part". */
function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64urlEncode([kind, ...parts].join(':'));
}

/** Decode a global id into its kind and parts, or null. */
function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  const decoded = b64urlDecode(id);
  if (decoded === null) return null;
  const segments = decoded.split(':');
  if (segments.length < 2) return null;
  return { kind: segments[0], parts: segments.slice(1) };
}

function userNode(login: string, id: number): GNode {
  return { __type: 'User', login, id };
}

function repoNode(repo: Repo): GNode {
  return { __type: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): GNode {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): GNode {
  return { __type: 'PullRequest', repo, pull };
}

function pageInfoNode(hasNextPage: boolean, hasPreviousPage: boolean, startCursor: string | null, endCursor: string | null): GNode {
  return { __type: 'PageInfo', hasNextPage, hasPreviousPage, startCursor, endCursor };
}

/** A cursor over a numbered item: base64 of the number. */
function cursorOf(number: number): string {
  return b64encode(Buffer.from(String(number), 'utf8'));
}

/** Decode a cursor back to its number, or null. */
function numberOfCursor(cursor: string): number | null {
  try {
    const text = b64decode(cursor).toString('utf8');
    if (!/^\d+$/.test(text)) return null;
    return Number(text);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Connections
// -------------------------------------------------------------------------------------------

interface PageArgs {
  first: number;
  after: number | null;
}

/** Read first:/after: from resolved arguments. */
function pageArgs(args: Record<string, unknown>): PageArgs {
  const firstRaw = args.first;
  const first = typeof firstRaw === 'number' && Number.isFinite(firstRaw) ? Math.trunc(firstRaw) : 30;
  const afterRaw = args.after;
  const after = typeof afterRaw === 'string' ? numberOfCursor(afterRaw) : null;
  return { first: Math.min(Math.max(first, 1), 100), after };
}

/**
 * Slice already-sorted numbered items into a connection page. `descending`
 * says whether the list runs newest-first (the cursor then filters to
 * smaller numbers).
 */
function connectionPage<T extends { number: number }>(
  type: string,
  items: readonly T[],
  args: Record<string, unknown>,
  descending: boolean,
): GNode {
  const { first, after } = pageArgs(args);
  let remaining = items;
  if (after !== null) {
    remaining = remaining.filter((item) => (descending ? item.number < after : item.number > after));
  }
  const page = remaining.slice(0, first);
  const hasNextPage = remaining.length > page.length;
  const startCursor = page.length > 0 ? cursorOf(page[0].number) : null;
  const endCursor = page.length > 0 ? cursorOf(page[page.length - 1].number) : null;
  return {
    __type: type,
    nodes: page,
    totalCount: items.length,
    pageInfo: pageInfoNode(hasNextPage, after !== null, startCursor, endCursor),
  };
}

// -------------------------------------------------------------------------------------------
// Resolvers
// -------------------------------------------------------------------------------------------

type Resolver = (node: GNode, args: Record<string, unknown>, forge: Forge) => unknown;

function repositoryIssues(repo: Repo, args: Record<string, unknown>): GNode {
  const states = args.states;
  let filtered = repo.issues;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    filtered = filtered.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: unknown; direction?: unknown } | undefined;
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'ASC';
  const descending = direction === 'DESC';
  const keyOf = (issue: Issue): number => {
    if (field === 'UPDATED_AT') return issue.updateSeq;
    if (field === 'COMMENTS') return issue.comments.length;
    return issue.seq;
  };
  const sorted = [...filtered].sort((a, b) => {
    const keyDiff = keyOf(a) - keyOf(b);
    const cmp = keyDiff !== 0 ? keyDiff : a.number - b.number;
    return descending ? -cmp : cmp;
  });
  const connection = connectionPage('IssueConnection', sorted, args, descending);
  connection.nodes = (connection.nodes as Issue[]).map((issue) => issueNode(repo, issue));
  return connection;
}

function repositoryPullRequests(repo: Repo, args: Record<string, unknown>): GNode {
  const states = args.states;
  let filtered = repo.pulls;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    filtered = filtered.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(state);
    });
  }
  const connection = connectionPage('PullRequestConnection', [...filtered], args, false);
  connection.nodes = (connection.nodes as Pull[]).map((pull) => pullNode(repo, pull));
  return connection;
}

/** MERGEABLE / CONFLICTING / UNKNOWN, computed from a three-way merge of the current tips. */
function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refTip(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refTip(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseView = repo.parseCommitCached(baseTip);
  const headView = repo.parseCommitCached(headTip);
  if (baseView === null || headView === null) return 'UNKNOWN';
  const ancestor = repo.mergeBase(baseTip, headTip);
  const ancestorTree = ancestor === null ? EMPTY_TREE_OID : (repo.parseCommitCached(ancestor)?.tree ?? EMPTY_TREE_OID);
  const merged = threeWayMerge(repo, baseView.tree, headView.tree, ancestorTree);
  return merged.ok ? 'MERGEABLE' : 'CONFLICTING';
}

function pullFiles(repo: Repo, pull: Pull, args: Record<string, unknown>): GNode {
  const baseTree = repo.parseCommitCached(pull.baseSha)?.tree ?? EMPTY_TREE_OID;
  const headTree = repo.parseCommitCached(pull.headSha)?.tree ?? EMPTY_TREE_OID;
  const changes = diffTrees(repo, baseTree, headTree);
  const { first } = pageArgs(args);
  const page = changes.slice(0, first);
  const nodes: GNode[] = page.map((change) => ({
    __type: 'ChangedFile',
    path: change.filename,
    additions: change.additions,
    deletions: change.deletions,
    changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
  }));
  return {
    __type: 'PullRequestChangedFilesConnection',
    nodes,
    totalCount: changes.length,
    pageInfo: pageInfoNode(changes.length > page.length, false, null, null),
  };
}

/** Look a repository up by its global id, throwing when it is not one. */
function repoFromGlobalId(forge: Forge, id: unknown): Repo {
  if (typeof id !== 'string') throw new GraphQLError('repositoryId must be a string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') throw new GraphQLError('repositoryId is not a Repository id');
  const repo = forge.getRepoById(Number(decoded.parts[0]));
  if (repo === undefined) throw new GraphQLError('Repository not found');
  return repo;
}

/** Look an issue up by its global id. */
function issueFromGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } {
  if (typeof id !== 'string') throw new GraphQLError('issueId must be a string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') throw new GraphQLError('issueId is not an Issue id');
  const repo = forge.getRepoById(Number(decoded.parts[0]));
  const issue = repo?.issuesByNumber.get(Number(decoded.parts[1]));
  if (repo === undefined || issue === undefined) throw new GraphQLError('Issue not found');
  return { repo, issue };
}

/** Look a pull request up by its global id. */
function pullFromGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: Pull } {
  if (typeof id !== 'string') throw new GraphQLError('pullRequestId must be a string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') throw new GraphQLError('pullRequestId is not a PullRequest id');
  const repo = forge.getRepoById(Number(decoded.parts[0]));
  const pull = repo?.pullsByNumber.get(Number(decoded.parts[1]));
  if (repo === undefined || pull === undefined) throw new GraphQLError('Pull request not found');
  return { repo, pull };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(VIEWER_LOGIN, VIEWER_ID),
    repository: (_node, args, forge) => {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoNode(repo);
    },
    node: (_node, args, forge) => {
      if (typeof args.id !== 'string') return null;
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = forge.getRepoById(Number(decoded.parts[0]));
        return repo === undefined ? null : repoNode(repo);
      }
      if (decoded.kind === 'Issue') {
        const repo = forge.getRepoById(Number(decoded.parts[0]));
        const issue = repo?.issuesByNumber.get(Number(decoded.parts[1]));
        return repo === undefined || issue === undefined ? null : issueNode(repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = forge.getRepoById(Number(decoded.parts[0]));
        const pull = repo?.pullsByNumber.get(Number(decoded.parts[1]));
        return repo === undefined || pull === undefined ? null : pullNode(repo, pull);
      }
      return null;
    },
    __type: (_node, args) => {
      const name = String(args.name ?? '');
      if (SCHEMA[name] === undefined && name !== 'SearchType') return null;
      return { __type: '__Type', name };
    },
  },
  Mutation: {
    createIssue: (_node, args, forge) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new GraphQLError('input is required');
      const repo = repoFromGlobalId(forge, input.repositoryId);
      const title = input.title;
      if (typeof title !== 'string' || title === '') throw new GraphQLError('title is required');
      const seq = forge.nextSeq();
      const issue: Issue = {
        id: forge.nextId(),
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
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
      return { __type: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (_node, args, forge) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new GraphQLError('input is required');
      const { repo, issue } = issueFromGlobalId(forge, input.issueId);
      issue.state = 'closed';
      issue.updateSeq = forge.nextSeq();
      repo.invalidateIssue(issue.number);
      return { __type: 'CloseIssuePayload', issue: issueNode(repo, issue) };
    },
    createPullRequest: (_node, args, forge) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new GraphQLError('input is required');
      const repo = repoFromGlobalId(forge, input.repositoryId);
      const title = input.title;
      const headRef = input.headRefName;
      const baseRef = input.baseRefName;
      if (typeof title !== 'string' || title === '') throw new GraphQLError('title is required');
      if (typeof headRef !== 'string' || typeof baseRef !== 'string') {
        throw new GraphQLError('headRefName and baseRefName are required');
      }
      const headSha = repo.refTip(`refs/heads/${headRef}`);
      const baseSha = repo.refTip(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        throw new GraphQLError('head or base branch does not exist');
      }
      for (const existing of repo.pulls) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          throw new GraphQLError('A pull request already exists for these branches');
        }
      }
      const pull: Pull = {
        id: forge.nextId(),
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
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
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    mergePullRequest: (_node, args, _forge) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new GraphQLError('input is required');
      const { repo, pull } = pullFromGlobalId(_forge, input.pullRequestId);
      if (pull.merged || pull.state !== 'open') throw new GraphQLError('Pull request is already merged or closed');
      const baseTip = repo.refTip(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const headTip = repo.refTip(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const baseView = repo.parseCommitCached(baseTip);
      const headView = repo.parseCommitCached(headTip);
      if (baseView === null || headView === null) throw new GraphQLError('Head or base commit is missing');
      const ancestor = repo.mergeBase(baseTip, headTip);
      const ancestorTree = ancestor === null ? EMPTY_TREE_OID : (repo.parseCommitCached(ancestor)?.tree ?? EMPTY_TREE_OID);
      const merged = threeWayMerge(repo, baseView.tree, headView.tree, ancestorTree);
      if (!merged.ok) throw new GraphQLError(`Merge conflict in ${merged.conflict}`);
      const commitOid = createCommit(repo, merged.treeOid, [baseTip], `${pull.title} (#${pull.number})`);
      repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = TRIAL_NOW_ISO;
      pull.mergeCommitSha = commitOid;
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    addComment: (_node, args, forge) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined) throw new GraphQLError('input is required');
      const { repo, issue } = issueFromGlobalId(forge, input.subjectId);
      const text = input.body;
      if (typeof text !== 'string') throw new GraphQLError('body is required');
      const comment = {
        id: forge.nextId(),
        body: text,
        createdAt: repo.createdAt,
        updatedAt: repo.createdAt,
      };
      issue.comments.push(comment);
      issue.updateSeq = forge.nextSeq();
      repo.invalidateIssue(issue.number);
      const node: GNode = { __type: 'IssueComment', repo, issue, comment };
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'IssueCommentEdge', node, cursor: cursorOf(comment.id) },
      };
    },
  },
  User: {
    id: (node) => globalId('User', node.id as number),
    login: (node) => node.login as string,
    name: (node) => ((node.login as string) === VIEWER_LOGIN ? VIEWER_NAME : (node.login as string)),
    email: (node) => ((node.login as string) === VIEWER_LOGIN ? VIEWER_EMAIL : ''),
  },
  Repository: {
    id: (node) => globalId('Repository', (node.repo as Repo).id),
    databaseId: (node) => (node.repo as Repo).id,
    name: (node) => (node.repo as Repo).name,
    nameWithOwner: (node) => (node.repo as Repo).fullName,
    description: (node) => (node.repo as Repo).description,
    owner: (node) => {
      const repo = node.repo as Repo;
      return userNode(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0);
    },
    defaultBranchRef: (node) => {
      const repo = node.repo as Repo;
      if (repo.defaultTip() === undefined) return null;
      return { __type: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (node, args) => {
      const repo = node.repo as Repo;
      const issue = repo.issuesByNumber.get(Number(args.number));
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (node, args) => repositoryIssues(node.repo as Repo, args),
    pullRequest: (node, args) => {
      const repo = node.repo as Repo;
      const pull = repo.pullsByNumber.get(Number(args.number));
      return pull === undefined ? null : pullNode(repo, pull);
    },
    pullRequests: (node, args) => repositoryPullRequests(node.repo as Repo, args),
  },
  Issue: {
    id: (node) => globalId('Issue', (node.repo as Repo).id, (node.issue as Issue).number),
    number: (node) => (node.issue as Issue).number,
    title: (node) => (node.issue as Issue).title,
    body: (node) => (node.issue as Issue).body,
    state: (node) => ((node.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (node) => (node.issue as Issue).createdAt,
    updatedAt: (node) => (node.issue as Issue).updatedAt,
    closedAt: (node) => {
      const issue = node.issue as Issue;
      return issue.state === 'closed' ? issue.updatedAt : null;
    },
    author: () => userNode(VIEWER_LOGIN, VIEWER_ID),
    labels: (node) => {
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      const nodes: GNode[] = issue.labels.map((name) => ({ __type: 'Label', repo, name }));
      return {
        __type: 'LabelConnection',
        nodes,
        totalCount: nodes.length,
        pageInfo: pageInfoNode(false, false, null, null),
      };
    },
    comments: (node) => {
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      const nodes: GNode[] = issue.comments.map((comment) => ({ __type: 'IssueComment', repo, issue, comment }));
      return {
        __type: 'IssueCommentConnection',
        nodes,
        totalCount: nodes.length,
        pageInfo: pageInfoNode(false, false, null, null),
      };
    },
    url: (node) => `/${(node.repo as Repo).fullName}/issues/${(node.issue as Issue).number}`,
  },
  PullRequest: {
    id: (node) => globalId('PullRequest', (node.repo as Repo).id, (node.pull as Pull).number),
    number: (node) => (node.pull as Pull).number,
    title: (node) => (node.pull as Pull).title,
    body: (node) => (node.pull as Pull).body,
    state: (node) => {
      const pull = node.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    headRefName: (node) => (node.pull as Pull).headRef,
    baseRefName: (node) => (node.pull as Pull).baseRef,
    mergeable: (node) => pullMergeable(node.repo as Repo, node.pull as Pull),
    merged: (node) => (node.pull as Pull).merged,
    mergedAt: (node) => (node.pull as Pull).mergedAt,
    files: (node, args) => pullFiles(node.repo as Repo, node.pull as Pull, args),
    createdAt: (node) => (node.pull as Pull).createdAt,
    updatedAt: (node) => (node.pull as Pull).updatedAt,
    author: () => userNode(VIEWER_LOGIN, VIEWER_ID),
  },
  IssueConnection: {
    nodes: (node) => node.nodes as unknown[],
    edges: (node) => (node.nodes as GNode[]).map((child) => ({
      __type: 'IssueEdge',
      node: child,
      cursor: cursorOf((child.issue as Issue).number),
    })),
    pageInfo: (node) => node.pageInfo as GNode,
    totalCount: (node) => node.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (node) => node.nodes as unknown[],
    edges: (node) => (node.nodes as GNode[]).map((child) => ({
      __type: 'PullRequestEdge',
      node: child,
      cursor: cursorOf((child.pull as Pull).number),
    })),
    pageInfo: (node) => node.pageInfo as GNode,
    totalCount: (node) => node.totalCount as number,
  },
  IssueCommentConnection: {
    nodes: (node) => node.nodes as unknown[],
    edges: (node) => (node.nodes as GNode[]).map((child) => ({
      __type: 'IssueCommentEdge',
      node: child,
      cursor: cursorOf((child.comment as { id: number }).id),
    })),
    pageInfo: (node) => node.pageInfo as GNode,
    totalCount: (node) => node.totalCount as number,
  },
  PullRequestChangedFilesConnection: {
    nodes: (node) => node.nodes as unknown[],
    pageInfo: (node) => node.pageInfo as GNode,
    totalCount: (node) => node.totalCount as number,
  },
  LabelConnection: {
    nodes: (node) => node.nodes as unknown[],
    pageInfo: (node) => node.pageInfo as GNode,
    totalCount: (node) => node.totalCount as number,
  },
  PageInfo: {
    hasNextPage: (node) => node.hasNextPage as boolean,
    hasPreviousPage: (node) => node.hasPreviousPage as boolean,
    startCursor: (node) => node.startCursor as string | null,
    endCursor: (node) => node.endCursor as string | null,
  },
  Ref: {
    name: (node) => node.name as string,
    target: () => null,
  },
  Label: {
    id: (node) => globalId('Label', (node.repo as Repo).id, node.name as string),
    name: (node) => node.name as string,
    color: (node) => (node.repo as Repo).labels.get(node.name as string)?.color ?? '000000',
  },
  IssueComment: {
    id: (node) => globalId('IssueComment', (node.repo as Repo).id, (node.comment as { id: number }).id),
    body: (node) => (node.comment as { body: string }).body,
    author: () => userNode(VIEWER_LOGIN, VIEWER_ID),
    createdAt: (node) => (node.comment as { createdAt: string }).createdAt,
    updatedAt: (node) => (node.comment as { updatedAt: string }).updatedAt,
  },
  IssueCommentEdge: {
    node: (node) => node.node as GNode,
    cursor: (node) => node.cursor as string,
  },
  IssueEdge: {
    node: (node) => node.node as GNode,
    cursor: (node) => node.cursor as string,
  },
  PullRequestEdge: {
    node: (node) => node.node as GNode,
    cursor: (node) => node.cursor as string,
  },
  ChangedFile: {
    path: (node) => node.path as string,
    additions: (node) => node.additions as number,
    deletions: (node) => node.deletions as number,
    changeType: (node) => node.changeType as string,
  },
  CreateIssuePayload: {
    issue: (node) => node.issue as GNode,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (node) => node.issue as GNode,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (node) => node.pullRequest as GNode,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (node) => node.pullRequest as GNode,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (node) => node.commentEdge as GNode,
    clientMutationId: () => null,
  },
  __Type: {
    name: (node) => node.name as string,
    kind: (node) => ((node.name as string) === 'SearchType' ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (node) => {
      const fields = SCHEMA[node.name as string];
      if (fields === undefined) return null;
      return fields.map((name) => ({ __type: '__Field', name }));
    },
    enumValues: (node) => {
      if ((node.name as string) !== 'SearchType') return null;
      return SEARCH_TYPE_VALUES.map((name) => ({ __type: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (node) => node.name as string,
    description: () => null,
    type: () => null,
  },
  __EnumValue: {
    name: (node) => node.name as string,
    description: () => null,
  },
};

// -------------------------------------------------------------------------------------------
// Argument resolution
// -------------------------------------------------------------------------------------------

/** Resolve a parsed argument value against the operation's variables. */
function resolveValue(value: GValue, variables: Record<string, unknown>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  const record = value as Record<string, GValue>;
  if (typeof record.__var === 'string') {
    const resolved = variables[record.__var];
    return resolved === undefined ? null : resolved;
  }
  if (typeof record.__enum === 'string') return record.__enum;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) out[key] = resolveValue(item, variables);
  return out;
}

function resolveArgs(args: Record<string, GValue>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------------------------

/** The object type a field's value has, for validating nested selections (null for scalars). */
const CHILD_TYPE: Record<string, Record<string, string | null>> = {
  Query: { viewer: 'User', repository: 'Repository', node: null, __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
  },
  Issue: { author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection' },
  PullRequest: { author: 'User', files: 'PullRequestChangedFilesConnection' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFilesConnection: { nodes: 'ChangedFile', pageInfo: 'PageInfo' },
  LabelConnection: { nodes: 'Label', pageInfo: 'PageInfo' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueEdge: { node: 'Issue' },
  PullRequestEdge: { node: 'PullRequest' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

/** Walk selections against the schema, collecting unknown-field errors. */
function validateSelections(
  selections: readonly Selection[],
  typeName: string | null,
  doc: Document,
  errors: string[],
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (typeName !== null && selection.name !== '__typename') {
        const fields = SCHEMA[typeName];
        if (fields === undefined || !fields.includes(selection.name)) {
          errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
          continue;
        }
      }
      if (selection.selections !== null) {
        const child = typeName === null ? null : (CHILD_TYPE[typeName]?.[selection.name] ?? null);
        validateSelections(selection.selections, child, doc, errors);
      }
    } else if (selection.kind === 'inline') {
      validateSelections(selection.selections, selection.typeCondition ?? typeName, doc, errors);
    } else {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(`Unknown fragment "${selection.name}".`);
        continue;
      }
      validateSelections(fragment.selections, fragment.typeCondition, doc, errors);
    }
  }
}

// -------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------

function executeSelections(
  selections: readonly Selection[],
  node: GNode,
  forge: Forge,
  variables: Record<string, unknown>,
  doc: Document,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = node.__type;
        continue;
      }
      const resolver = RESOLVERS[node.__type]?.[selection.name];
      if (resolver === undefined) {
        throw new GraphQLError(`Cannot query field "${selection.name}" on type "${node.__type}".`);
      }
      const args = resolveArgs(selection.args, variables);
      const value = resolver(node, args, forge);
      out[key] = executeValue(value, selection.selections, forge, variables, doc);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== node.__type) continue;
      Object.assign(out, executeSelections(selection.selections, node, forge, variables, doc));
    } else {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}"`);
      if (fragment.typeCondition !== node.__type) continue;
      Object.assign(out, executeSelections(fragment.selections, node, forge, variables, doc));
    }
  }
  return out;
}

function executeValue(
  value: unknown,
  selections: Selection[] | null,
  forge: Forge,
  variables: Record<string, unknown>,
  doc: Document,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => executeValue(item, selections, forge, variables, doc));
  }
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    return executeSelections(selections, value as GNode, forge, variables, doc);
  }
  return value;
}

interface GraphQLResult {
  data: unknown;
  errors?: { message: string }[];
}

/** Run one operation (parse, validate, execute), never throwing. */
function executeOperation(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): GraphQLResult {
  let doc: Document;
  try {
    doc = new Parser(query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] };
  }
  let operation = doc.operations[0];
  if (operationName !== null) {
    operation = doc.operations.find((candidate) => candidate.name === operationName) ?? operation;
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(operation.selections, rootType, doc, errors);
  if (errors.length > 0) return { data: null, errors: errors.map((message) => ({ message })) };
  try {
    const root: GNode = { __type: rootType };
    const data = executeSelections(operation.selections, root, forge, variables, doc);
    return { data };
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'execution failed' }] };
  }
}

function runOne(forge: Forge, item: unknown): GraphQLResult {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { data: null, errors: [{ message: 'request must be an object' }] };
  }
  const record = item as Record<string, unknown>;
  if (typeof record.query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  return executeOperation(forge, record.query, variables, operationName);
}

// -------------------------------------------------------------------------------------------
// HTTP handler
// -------------------------------------------------------------------------------------------

/**
 * Handle a GraphQL request. Returns true when the path is /api/graphql
 * (even when it errored), false when it is not a GraphQL route.
 */
export function handleGraphql(forge: Forge, ctx: Ctx): boolean {
  if (ctx.segments.length !== 2 || ctx.segments[0] !== 'api' || ctx.segments[1] !== 'graphql') return false;
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!isAuthorized(ctx.req.headers.authorization)) {
    sendError(ctx, 401, 'Bad credentials');
    return true;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  if (Array.isArray(payload)) {
    sendJson(ctx, 200, payload.map((item) => runOne(forge, item)));
    return true;
  }
  sendJson(ctx, 200, runOne(forge, payload));
  return true;
}
