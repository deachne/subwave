// Durable identity for policy snapshots, fact locks, and later arbiter proofs.
// Ordinary JSON.stringify is not stable: key order is insertion order, and a
// tool object can carry non-JSON values. This module recursively sorts object
// keys, preserves array order, rejects non-JSON values, and serializes with
// no whitespace.

import { createHash } from 'node:crypto';

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical-json: non-finite number');
    return value;
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error('canonical-json: non-JSON value');
  }
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string') throw new Error('canonical-json: symbol key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
        throw new Error('canonical-json: non-JSON array property');
      }
    }
    const keys = Object.keys(value);
    if (
      keys.length !== value.length
      || keys.some((key, index) => key !== String(index))
    ) {
      throw new Error('canonical-json: sparse or non-JSON array');
    }
    return value.map(canonicalize);
  }
  if (t !== 'object' || !isPlainObject(value as object)) {
    throw new Error('canonical-json: non-JSON value');
  }
  const rec = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(rec);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new Error('canonical-json: symbol key');
  }
  const stringKeys = ownKeys as string[];
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(rec, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      throw new Error('canonical-json: non-JSON property');
    }
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of stringKeys.sort()) out[key] = canonicalize(rec[key]);
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
