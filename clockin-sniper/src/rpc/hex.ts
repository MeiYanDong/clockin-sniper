import type { Hex } from "./types.js";

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

export function assertHex(name: string, value: string, allowEmpty = false): asserts value is Hex {
  if (!HEX_PATTERN.test(value) || value.length % 2 !== 0) {
    throw new TypeError(`${name} must be an even-length 0x-prefixed hex string`);
  }
  if (!allowEmpty && value.length === 2) {
    throw new RangeError(`${name} must not be empty`);
  }
}

export function assertAddress(name: string, value: string): asserts value is Hex {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a 20-byte 0x-prefixed address`);
  }
}

export function quantityToHex(value: bigint): Hex {
  if (value < 0n) {
    throw new RangeError("JSON-RPC quantity must not be negative");
  }
  return `0x${value.toString(16)}`;
}

export function hexToBigInt(name: string, value: string): bigint {
  if (!QUANTITY_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a canonical 0x-prefixed JSON-RPC quantity`);
  }
  return BigInt(value);
}

export function decodeUint256(name: string, value: string): bigint {
  assertHex(name, value);
  const byteLength = (value.length - 2) / 2;
  if (byteLength > 32) {
    throw new RangeError(`${name} exceeds one ABI word`);
  }
  return BigInt(value);
}

export function decodeBool(name: string, value: string): boolean {
  const decoded = decodeUint256(name, value);
  if (decoded === 0n) return false;
  if (decoded === 1n) return true;
  throw new RangeError(`${name} is not an ABI boolean`);
}
