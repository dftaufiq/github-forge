// Git smart HTTP: info/refs advertisements (v0 and v2), protocol v2
// ls-refs and fetch, and receive-pack (v0).
//
// The wire contract follows git's http-protocol and protocol-v2 documents
// as the suite's client exercises them: v2 for every fetch the suite
// performs, v0 for every receive-pack. The v0 upload-pack advertisement
// exists for real git clients that ask for it and for the header checks.

import { isAuthorized, isOid, sendBytes, sendError, ZERO_OID, type Ctx } from './util.ts';
import { type Forge, type Repo } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  buildPack,
  computeSendSet,
  packCacheKey,
  parsePack,
  parsePktLines,
  pktLine,
} from './pack.ts';

const UPLOAD_AD_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CONTENT_TYPE = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CONTENT_TYPE = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CONTENT_TYPE = 'application/x-git-receive-pack-result';

/** Capabilities advertised on the first line of a v0 upload-pack advertisement. */
const UPLOAD_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not ' +
  'deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want ' +
  'allow-reachable-sha1-in-want symref=HEAD:refs/heads/main object-format=sha1 agent=github-forge/1.0.0';

/** Capabilities advertised on the first line of a v0 receive-pack advertisement. */
const RECEIVE_V0_CAPS =
  'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main object-format=sha1 agent=github-forge/1.0.0';

/** One ref line for an advertisement: oid, name, and (for annotated tags) the peeled commit. */
interface RefLine {
  oid: string;
  name: string;
  peeled: string | null;
}

/** Every ref of the repository, sorted by name, with peeled targets for annotated tags. */
function listRefs(repo: Repo): RefLine[] {
  const names = [...repo.refs.keys()].sort();
  const lines: RefLine[] = [];
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    let peeled: string | null = null;
    const object = repo.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      try {
        const target = repo.peel(oid);
        if (target !== oid) peeled = target;
      } catch {
        peeled = null;
      }
    }
    lines.push({ oid, name, peeled });
  }
  return lines;
}

/** The HEAD line's target: the default branch tip, or the zero id when unborn. */
function headOid(repo: Repo): string {
  return repo.defaultTip() ?? ZERO_OID;
}

/** A v0 advertisement: service preamble, flush, then ref lines (HEAD first, capabilities on the first line), then a closing flush. */
function advertiseV0(service: string, caps: string, repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(pktLine(`${head} HEAD\0${caps}\n`));
  for (const ref of refs) {
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    if (ref.peeled !== null) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A protocol v2 advertisement: service preamble, flush, version line, capabilities, flush. */
function advertiseV2(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('fetch=shallow\n'),
    pktLine('ls-refs\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

/** Handle GET /{owner}/{repo}.git/info/refs. */
function handleInfoRefs(forge: Forge, ctx: Ctx, owner: string, repoName: string): void {
  const service = ctx.url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx, 400, 'unknown service');
    return;
  }
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(ctx, 200, RECEIVE_AD_CONTENT_TYPE, advertiseV0('git-receive-pack', RECEIVE_V0_CAPS, repo));
    return;
  }
  const protocol = ctx.req.headers['git-protocol'];
  if (protocol !== undefined && String(protocol).includes('version=2')) {
    sendBytes(ctx, 200, UPLOAD_AD_CONTENT_TYPE, advertiseV2(repo));
    return;
  }
  sendBytes(ctx, 200, UPLOAD_AD_CONTENT_TYPE, advertiseV0('git-upload-pack', UPLOAD_V0_CAPS, repo));
}

// -------------------------------------------------------------------------------------------
// Protocol v2: ls-refs and fetch
// -------------------------------------------------------------------------------------------

/** Split a v2 request body into its command and argument lines (without trailing newlines). */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { lines } = parsePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const line of lines) {
    if (line.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim && text.startsWith('command=')) {
      command = text.slice('command='.length);
    } else if (seenDelim) {
      args.push(text);
    }
  }
  return { command, args };
}

/** Handle a v2 ls-refs request. */
function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  if (matches('HEAD')) {
    const attrs = symrefs ? ' symref-target:refs/heads/main' : '';
    parts.push(pktLine(`${headOid(repo)} HEAD${attrs}\n`));
  }
  for (const ref of listRefs(repo)) {
    if (!matches(ref.name)) continue;
    let attrs = '';
    if (peel && ref.peeled !== null) attrs += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${ref.oid} ${ref.name}${attrs}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Wrap bytes in sideband band-1 packets (each pkt-line holds at most 65515 data bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = 65515;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(offset + chunkSize, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return parts;
}

/** Handle a v2 fetch request. The whole response is cached: it is a pure function of its inputs. */
function handleFetch(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
    }
  }

  const cacheKey = `fetch:${packCacheKey(wants, haves, clientShallow, depth)}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const sendSet = computeSendSet(repo, wants, haves, clientShallow, depth);
  const objects: { oid: string; type: import('./store.ts').ObjectType; data: Buffer }[] = [];
  for (const oid of sendSet.objects) {
    const object = repo.getObject(oid);
    if (object !== undefined) objects.push({ oid, type: object.type, data: object.data });
  }
  const pack = buildPack(objects);

  const parts: Buffer[] = [];
  // Acknowledgments: only when the client sent haves. Each section opens
  // with its name line, carries its content lines, and ends with a
  // delimiter (the packfile section ends with the response flush instead).
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let acknowledged = false;
    for (const have of haves) {
      if (repo.getObject(have) !== undefined) {
        parts.push(pktLine(`ACK ${have}\n`));
        acknowledged = true;
      }
    }
    if (!acknowledged) parts.push(pktLine('NAK\n'));
    parts.push(PKT_DELIM);
  }
  // Shallow-info, only when there is something to say.
  if (sendSet.shallow.length > 0 || sendSet.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of sendSet.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of sendSet.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  // Packfile section, then the response-ending flush.
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const response = Buffer.concat(parts);
  repo.packCache.set(cacheKey, response);
  return response;
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack (protocol v2). */
function handleUploadPack(repo: Repo, ctx: Ctx): void {
  const { command, args } = parseV2Request(ctx.body);
  if (command === 'ls-refs') {
    sendBytes(ctx, 200, UPLOAD_RESULT_CONTENT_TYPE, handleLsRefs(repo, args));
    return;
  }
  if (command === 'fetch') {
    sendBytes(ctx, 200, UPLOAD_RESULT_CONTENT_TYPE, handleFetch(repo, args));
    return;
  }
  // An unknown command: answer with a v2 error line rather than failing the request.
  sendBytes(ctx, 200, UPLOAD_RESULT_CONTENT_TYPE, Buffer.concat([pktLine(`ERR unknown command ${command}\n`), PKT_FLUSH]));
}

// -------------------------------------------------------------------------------------------
// Receive-pack (v0)
// -------------------------------------------------------------------------------------------

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command lines at the head of a receive-pack body. */
function parseRefCommands(lines: readonly { kind: string; payload?: Buffer }[]): { commands: RefCommand[]; sideband: boolean } {
  const commands: RefCommand[] = [];
  let sideband = false;
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind !== 'data' || line.payload === undefined) continue;
    let text = line.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts;
    if (!isOid(oldOid) || !isOid(newOid) || ref === '') continue;
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, sideband };
}

/** Apply one ref command; returns null on success or the ng reason on refusal. */
function applyRefCommand(repo: Repo, command: RefCommand): string | null {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);

  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return oldOid === ZERO_OID ? null : 'old oid does not match';
    if (oldOid !== ZERO_OID && oldOid !== current) return 'old oid does not match';
    repo.refs.delete(ref);
    return null;
  }
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'already exists';
    if (repo.getObject(newOid) === undefined) return 'object not found';
    repo.refs.set(ref, newOid);
    return null;
  }
  // Update.
  if (current === undefined) return 'old oid does not match';
  if (oldOid !== current) return 'old oid does not match';
  if (newOid === oldOid) return null;
  const newObject = repo.getObject(newOid);
  if (newObject === undefined) return 'object not found';
  if (newObject.type === 'commit' && repo.getObject(oldOid)?.type === 'commit') {
    if (!repo.isAncestor(oldOid, newOid)) return 'non-fast-forward';
  }
  repo.refs.set(ref, newOid);
  return null;
}

/** Handle POST /{owner}/{repo}.git/git-receive-pack. */
function handleReceivePack(repo: Repo, ctx: Ctx): void {
  const { lines, consumed } = parsePktLines(ctx.body);
  const { commands, sideband } = parseRefCommands(lines);
  const packBytes = ctx.body.subarray(consumed);

  const report: Buffer[] = [];
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, repo);
      for (const object of objects) repo.putObjectAt(object.oid, object.type, object.data);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  if (unpackError !== null) {
    report.push(pktLine(`unpack ${unpackError}\n`));
    for (const command of commands) report.push(pktLine(`ng ${command.ref} unpack failed\n`));
  } else {
    report.push(pktLine('unpack ok\n'));
    for (const command of commands) {
      const refusal = applyRefCommand(repo, command);
      if (refusal === null) report.push(pktLine(`ok ${command.ref}\n`));
      else report.push(pktLine(`ng ${command.ref} ${refusal}\n`));
    }
  }
  report.push(PKT_FLUSH);

  if (sideband) {
    const stream = Buffer.concat(report);
    const parts = sidebandPack(stream);
    parts.push(PKT_FLUSH);
    sendBytes(ctx, 200, RECEIVE_RESULT_CONTENT_TYPE, Buffer.concat(parts));
  } else {
    sendBytes(ctx, 200, RECEIVE_RESULT_CONTENT_TYPE, Buffer.concat(report));
  }
}

// -------------------------------------------------------------------------------------------
// Dispatcher
// -------------------------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns true when the path was a git
 * route (even when it errored), false when it is not one.
 */
export function handleGit(forge: Forge, ctx: Ctx): boolean {
  const [owner, repoGit, ...rest] = ctx.segments;
  if (owner === undefined || repoGit === undefined || !repoGit.endsWith('.git')) return false;
  const repoName = repoGit.slice(0, -'.git'.length);
  if (repoName === '') return false;

  if (!isAuthorized(ctx.req.headers.authorization)) {
    sendError(ctx, 401, 'Bad credentials');
    return true;
  }

  if (ctx.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    handleInfoRefs(forge, ctx, owner, repoName);
    return true;
  }
  if (ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    handleUploadPack(repo, ctx);
    return true;
  }
  if (ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    handleReceivePack(repo, ctx);
    return true;
  }
  return false;
}
