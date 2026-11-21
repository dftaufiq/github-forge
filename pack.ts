// The git wire formats: pkt-lines, packfiles (read and write, including
// delta resolution), and the fetch send-set computation.
//
// Pack writing never emits deltas: every object is stored whole. That keeps
// the writer simple and deterministic (objects sorted by id), and the
// reader side of the suite only verifies that packs resolve, not that they
// are small. Pack reading, on the other hand, must handle OFS_DELTA and
// REF_DELTA, because real git clients send them.

import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex, ZERO_OID } from './util.ts';
import { hashObject, type ObjectType, type Repo } from './store.ts';

// -------------------------------------------------------------------------------------------
// Pkt-lines
// -------------------------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** One pkt-line framing `payload` (a string or raw bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  // Pkt-line lengths fit in 4 hex digits (max frame 65520); fall back to the
  // general path for anything larger so the output stays well-formed.
  if (length > 0xffff) {
    const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
    return Buffer.concat([header, body]);
  }
  const out = Buffer.allocUnsafe(length);
  out.write(length.toString(16).padStart(4, '0'), 0, 'ascii');
  body.copy(out, 4);
  return out;
}

/** True when the four bytes at `offset` are a pkt-line length of 0000 (flush). */
export function isFlush(buffer: Buffer, offset: number): boolean {
  return buffer.subarray(offset, offset + 4).toString('ascii') === '0000';
}

export type PktLine =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' }
  | { kind: 'data'; payload: Buffer };

/**
 * Parse a buffer of pkt-lines into lines. Stops at the first malformed
 * length or when the buffer runs out mid-line, and reports how many bytes
 * were consumed (the rest is a pack body, for receive-pack).
 */
export function parsePktLines(buffer: Buffer): { lines: PktLine[]; consumed: number } {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lengthText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) break;
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      lines.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      lines.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    lines.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { lines, consumed: offset };
}

// -------------------------------------------------------------------------------------------
// Pack writing
// -------------------------------------------------------------------------------------------

const PACK_TYPE_NUMBER: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

/** Encode a pack object's type+size header (the git varint form). */
function packObjectHeader(type: ObjectType, size: number): Buffer {
  const typeNumber = PACK_TYPE_NUMBER[type];
  let remaining = size;
  const first = ((typeNumber & 0x07) << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  const bytes: number[] = [];
  if (remaining === 0) {
    bytes.push(first);
  } else {
    bytes.push(first | 0x80);
    while (remaining > 0) {
      const next = remaining & 0x7f;
      remaining >>>= 7;
      bytes.push(remaining > 0 ? next | 0x80 : next);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Build a version-2 packfile holding the given objects whole (no deltas),
 * sorted by object id for determinism. A 0-object pack is the 12-byte
 * header plus the 20-byte trailer.
 */
export function buildPack(objects: readonly { oid: string; type: ObjectType; data: Buffer }[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const object of sorted) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------
// Pack reading (with delta resolution)
// -------------------------------------------------------------------------------------------

export interface UnpackedObject {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

const PACK_TYPE_NAME: Record<number, ObjectType | null> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: null, // OFS_DELTA
  7: null, // REF_DELTA
};

/** Read the pack-object type+size varint at `offset`. */
function readObjectHeader(buffer: Buffer, offset: number): { typeNumber: number; size: number; next: number } {
  let byte = buffer[offset];
  const typeNumber = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let cursor = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[cursor];
    cursor += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeNumber, size, next: cursor };
}

/** Read an OFS_DELTA's negative-offset varint. */
function readOfsDeltaOffset(buffer: Buffer, offset: number): { offset: number; next: number } {
  let byte = buffer[offset];
  let value = byte & 0x7f;
  let cursor = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[cursor];
    cursor += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { offset: value, next: cursor };
}

/** Read a delta's size varint (7 bits per byte, little-endian groups). */
function readDeltaSize(buffer: Buffer, offset: number): { size: number; next: number } {
  let size = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = buffer[cursor];
    cursor += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { size, next: cursor };
}

/** Apply a git delta to a base object, producing the target object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaSize(delta, 0);
  if (source.size !== base.length) throw new Error('delta source size does not match the base');
  const target = readDeltaSize(delta, source.next);
  const out = Buffer.alloc(target.size);
  let write = 0;
  let cursor = target.next;
  while (cursor < delta.length) {
    const opcode = delta[cursor];
    cursor += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          copyOffset |= delta[cursor] << (bit * 8);
          cursor += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          copySize |= delta[cursor] << (bit * 8);
          cursor += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || write + copySize > target.size) {
        throw new Error('delta copy runs past its buffer');
      }
      base.copy(out, write, copyOffset, copyOffset + copySize);
      write += copySize;
    } else if (opcode !== 0) {
      if (cursor + opcode > delta.length || write + opcode > target.size) {
        throw new Error('delta insert runs past its buffer');
      }
      delta.copy(out, write, cursor, cursor + opcode);
      cursor += opcode;
      write += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (write !== target.size) throw new Error('delta did not produce the declared size');
  return out;
}

interface PackEntry {
  start: number;
  typeNumber: number;
  size: number;
  /** For full objects: the inflated bytes. For deltas: the inflated delta. */
  payload: Buffer;
  /** OFS_DELTA: the start offset of the base entry. REF_DELTA: the base oid. */
  baseOffset: number | null;
  baseOid: string | null;
  /** The resolved object, once computed. */
  resolved: UnpackedObject | null;
}

/**
 * Parse a packfile, resolving deltas. REF_DELTA bases may come from the
 * pack itself or from `repo` (thin packs). The trailer checksum is
 * verified; any structural error throws.
 */
export function parsePack(buffer: Buffer, repo: Repo): UnpackedObject[] {
  if (buffer.length < 32) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const expectedTrailer = buffer.subarray(buffer.length - 20).toString('hex');
  if (sha1Hex(buffer.subarray(0, buffer.length - 20)) !== expectedTrailer) {
    throw new Error('pack trailer checksum mismatch');
  }

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const header = readObjectHeader(buffer, offset);
    offset = header.next;
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (header.typeNumber === 6) {
      const decoded = readOfsDeltaOffset(buffer, offset);
      baseOffset = start - decoded.offset;
      offset = decoded.next;
    } else if (header.typeNumber === 7) {
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (PACK_TYPE_NAME[header.typeNumber] === undefined) {
      throw new Error(`unknown pack object type ${header.typeNumber}`);
    }
    // With info:true, inflateSync returns {buffer, engine}; the engine's
    // bytesWritten is the number of input bytes the zlib stream consumed,
    // which is how the next object's offset is found.
    const inflated = inflateSync(buffer.subarray(offset, buffer.length - 20), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const payload = inflated.buffer;
    const consumed = inflated.engine.bytesWritten;
    if (!Number.isFinite(consumed) || consumed <= 0) throw new Error('cannot determine the zlib stream length');
    offset += consumed;
    const entry: PackEntry = {
      start,
      typeNumber: header.typeNumber,
      size: header.size,
      payload,
      baseOffset,
      baseOid,
      resolved: null,
    };
    entries.push(entry);
    byOffset.set(start, entry);
  }

  // Fast path: a pack with no deltas (the common case for small pushes)
  // needs no resolution machinery — each entry is a whole object. This
  // produces exactly what resolve() would for such a pack: the same size
  // check, the same hash, the same order.
  let hasDeltas = false;
  for (const entry of entries) {
    if (entry.typeNumber === 6 || entry.typeNumber === 7) {
      hasDeltas = true;
      break;
    }
  }
  if (!hasDeltas) {
    const objects: UnpackedObject[] = [];
    for (const entry of entries) {
      if (entry.payload.length !== entry.size) throw new Error('object size does not match its header');
      const type = PACK_TYPE_NAME[entry.typeNumber] as ObjectType;
      objects.push({ oid: hashObject(type, entry.payload), type, data: entry.payload });
    }
    return objects;
  }

  // Resolve entries, memoizing by entry. REF_DELTA bases are found by
  // resolving pack entries until one matches the base id, then by falling
  // back to the repository store (thin packs).
  const byOid = new Map<string, PackEntry>();
  const resolve = (entry: PackEntry, chain: Set<PackEntry>): UnpackedObject => {
    if (entry.resolved !== null) return entry.resolved;
    if (chain.has(entry)) throw new Error('delta cycle in pack');
    chain.add(entry);
    let resolved: UnpackedObject;
    if (entry.typeNumber === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('OFS_DELTA base is outside the pack');
      const base = resolve(baseEntry, chain);
      resolved = { oid: '', type: base.type, data: applyDelta(base.data, entry.payload) };
    } else if (entry.typeNumber === 7) {
      const baseOid = entry.baseOid as string;
      let base: UnpackedObject | undefined;
      const known = byOid.get(baseOid);
      if (known !== undefined) {
        base = resolve(known, chain);
      } else {
        for (const candidate of entries) {
          if (candidate.resolved === null && candidate !== entry) {
            try {
              resolve(candidate, new Set(chain));
            } catch {
              // This candidate depends on the entry being resolved, or is
              // itself broken; it is not the base we need.
            }
          }
          if (candidate.resolved !== null && candidate.resolved.oid === baseOid) {
            base = candidate.resolved;
            break;
          }
        }
      }
      if (base === undefined) {
        const stored = repo.getObject(baseOid);
        if (stored === undefined) throw new Error('REF_DELTA base is not in the pack or the store');
        base = { oid: baseOid, type: stored.type, data: stored.data };
      }
      resolved = { oid: '', type: base.type, data: applyDelta(base.data, entry.payload) };
    } else {
      resolved = { oid: '', type: PACK_TYPE_NAME[entry.typeNumber] as ObjectType, data: entry.payload };
    }
    chain.delete(entry);
    // For a whole object the header size is the object's size; for a delta
    // it is the size of the delta data itself (the target size lives inside
    // the delta and applyDelta already checked it).
    if (entry.typeNumber === 6 || entry.typeNumber === 7) {
      if (entry.payload.length !== entry.size) throw new Error('delta size does not match its header');
    } else if (resolved.data.length !== entry.size) {
      throw new Error('object size does not match its header');
    }
    resolved.oid = hashObject(resolved.type, resolved.data);
    entry.resolved = resolved;
    byOid.set(resolved.oid, entry);
    return resolved;
  };

  const objects: UnpackedObject[] = [];
  for (const entry of entries) {
    objects.push(resolve(entry, new Set<PackEntry>()));
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// Fetch send sets
// -------------------------------------------------------------------------------------------

export interface SendSet {
  /** Object ids to pack, in traversal order (the pack writer sorts them). */
  objects: string[];
  /** Commits at the depth boundary: their parents were not traversed. */
  shallow: string[];
  /** Client shallow boundaries whose parents are now included. */
  unshallow: string[];
}

/**
 * Collect every object reachable from `tips`, stopping at `stopAt` commits
 * (their trees are included, their parents are not) and at `depth`
 * generations (a want is generation 1; a commit at generation == depth is
 * a boundary). Returns the object set, the boundary commits, and the
 * generation each commit was first reached at.
 */
function collectReachable(
  repo: Repo,
  tips: readonly string[],
  stopAt: ReadonlySet<string>,
  depth: number | null,
): { objects: Set<string>; boundaries: Set<string>; generations: Map<string, number> } {
  const objects = new Set<string>();
  const boundaries = new Set<string>();
  const generations = new Map<string, number>();
  const visitedTrees = new Set<string>();

  const addTree = (treeOid: string): void => {
    if (visitedTrees.has(treeOid)) return;
    visitedTrees.add(treeOid);
    const entries = repo.parseTreeCached(treeOid);
    if (entries === null) return;
    objects.add(treeOid);
    for (const entry of entries) {
      if (entry.mode === '40000') addTree(entry.oid);
      else objects.add(entry.oid);
    }
  };

  const queue: { oid: string; generation: number }[] = [];
  for (const tip of tips) {
    if (tip === ZERO_OID) continue;
    const object = repo.getObject(tip);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      queue.push({ oid: tip, generation: 1 });
    } else if (object.type === 'tag') {
      objects.add(tip);
      const target = repo.peel(tip);
      const peeled = repo.getObject(target);
      if (peeled !== undefined && peeled.type === 'commit') queue.push({ oid: target, generation: 1 });
      else if (peeled !== undefined && peeled.type === 'tree') addTree(target);
      else if (peeled !== undefined) objects.add(target);
    } else if (object.type === 'tree') {
      addTree(tip);
    } else {
      objects.add(tip);
    }
  }

  while (queue.length > 0) {
    const { oid, generation } = queue.shift() as { oid: string; generation: number };
    const previous = generations.get(oid);
    if (previous !== undefined && previous <= generation) continue;
    generations.set(oid, generation);
    const view = repo.parseCommitCached(oid);
    if (view === null) continue;
    objects.add(oid);
    addTree(view.tree);
    if (stopAt.has(oid)) continue;
    if (depth !== null && generation >= depth) {
      boundaries.add(oid);
      continue;
    }
    for (const parent of view.parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  return { objects, boundaries, generations };
}

/**
 * The objects a fetch must send: everything reachable from `wants` within
 * `depth`, minus everything reachable from `haves` (whose traversal stops
 * at the client's shallow boundaries). Unshallow lines cover client
 * shallow boundaries now reached above the depth limit.
 */
export function computeSendSet(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): SendSet {
  const clientShallowSet = new Set(clientShallow);
  const wantSet = collectReachable(repo, wants, new Set<string>(), depth);
  const haveSet =
    haves.length === 0
      ? { objects: new Set<string>(), boundaries: new Set<string>(), generations: new Map<string, number>() }
      : collectReachable(repo, haves, clientShallowSet, null);

  const objects: string[] = [];
  for (const oid of wantSet.objects) {
    if (!haveSet.objects.has(oid)) objects.push(oid);
  }
  const shallow: string[] = [];
  for (const oid of wantSet.boundaries) {
    if (!haveSet.objects.has(oid)) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const generation = wantSet.generations.get(oid);
    if (generation !== undefined && (depth === null || generation < depth)) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

/** The cache key for a fetch pack: the request's send-set inputs. */
export function packCacheKey(
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): string {
  const sort = (values: readonly string[]): string => [...values].sort().join(',');
  return `${sort(wants)}|${sort(haves)}|${sort(clientShallow)}|${depth === null ? '' : depth}`;
}
