/**
 * EIP-712 typed-data signing payload generator for Brain policies.
 *
 * §3 Layer 3: "EIP-712 typed-data signatures. Enterprise tier gets
 * on-chain policy registration (see smart contracts below). SMB tier gets
 * off-chain signed policies stored in Postgres. Same primitive, different
 * durability surface."
 *
 * The on-chain contract is BrainPolicyRegistry (§4 of MVP architecture):
 *   function registerPolicy(
 *     bytes32 tenantId,
 *     uint256 version,
 *     bytes32 policyHash,
 *     address[] calldata signers,
 *     bytes[] calldata signatures
 *   )
 *
 * EIP-712 typed data we sign:
 *   domain:      { name: "Brain Policy", version: "1", chainId, verifyingContract }
 *   primaryType: "PolicyRegistration"
 *   types:       { PolicyRegistration: [tenantId bytes32, version uint256, policyHash bytes32] }
 *   message:     { tenantId, version, policyHash }
 *
 * This module returns the typed-data object and the EIP-712 digest
 * (keccak256 of the encoded payload). Actual signature verification lives
 * in the /policy/:tenant_id/sign endpoint and uses viem.
 */

import { keccak_256 } from "@noble/hashes/sha3";

export interface PolicyTypedData {
  domain: {
    name: "Brain Policy";
    version: "1";
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  primaryType: "PolicyRegistration";
  types: {
    EIP712Domain: Array<{ name: string; type: string }>;
    PolicyRegistration: Array<{ name: string; type: string }>;
  };
  message: {
    tenantId: `0x${string}`;
    version: bigint;
    policyHash: `0x${string}`;
  };
}

export interface BuildPayloadInput {
  tenantId: string; // tnt_ULID — hashed to bytes32
  version: number;
  policyHashHex: string; // 32-byte hex (no 0x prefix OK either)
  chainId: number;
  verifyingContract: `0x${string}`;
}

export function buildTypedData(input: BuildPayloadInput): PolicyTypedData {
  return {
    domain: {
      name: "Brain Policy",
      version: "1",
      chainId: input.chainId,
      verifyingContract: input.verifyingContract,
    },
    primaryType: "PolicyRegistration",
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PolicyRegistration: [
        { name: "tenantId", type: "bytes32" },
        { name: "version", type: "uint256" },
        { name: "policyHash", type: "bytes32" },
      ],
    },
    message: {
      tenantId: tenantIdToBytes32(input.tenantId),
      version: BigInt(input.version),
      policyHash: toHexPrefixed(input.policyHashHex),
    },
  };
}

/**
 * Keccak-256 digest of the EIP-712 encoding. Matches the digest that
 * `ecrecover(...)` would validate against a produced signature.
 */
export function computeDigest(typed: PolicyTypedData): Uint8Array {
  const domainSeparator = hashStruct(
    typed.types,
    "EIP712Domain",
    typed.domain as unknown as Record<string, unknown>,
  );
  const messageHash = hashStruct(
    typed.types,
    typed.primaryType,
    typed.message as unknown as Record<string, unknown>,
  );
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator, messageHash));
}

export function digestHex(typed: PolicyTypedData): string {
  return bytesToHex(computeDigest(typed));
}

/**
 * Convert a Brain tenant id (tnt_<ulid>) to a bytes32 hash. Use
 * keccak256 of the full id string — deterministic, irreversible, stable.
 * Matches `keccak256(abi.encodePacked(tenantId))` on-chain.
 */
export function tenantIdToBytes32(tenantId: string): `0x${string}` {
  return `0x${bytesToHex(keccak_256(tenantId))}`;
}

// ---------------------------------------------------------------------------
// EIP-712 struct hashing
// ---------------------------------------------------------------------------

function hashStruct(
  types: PolicyTypedData["types"],
  primaryType: string,
  data: Record<string, unknown>,
): Uint8Array {
  const typeHash = hashType(types, primaryType);
  const encoded = encodeData(types, primaryType, data);
  return keccak_256(concatBytes(typeHash, encoded));
}

function hashType(types: PolicyTypedData["types"], primaryType: string): Uint8Array {
  const deps = sortDependencies(types, primaryType);
  const full = [primaryType, ...deps]
    .map((name) => {
      const fields = (types as unknown as Record<string, Array<{ name: string; type: string }>>)[
        name
      ];
      if (fields === undefined) return "";
      return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    })
    .join("");
  return keccak_256(full);
}

function sortDependencies(types: PolicyTypedData["types"], primaryType: string): string[] {
  const deps = new Set<string>();
  const typesMap = types as unknown as Record<string, Array<{ name: string; type: string }>>;
  function visit(name: string): void {
    const fields = typesMap[name];
    if (fields === undefined) return;
    for (const f of fields) {
      if (typesMap[f.type] !== undefined && f.type !== primaryType && !deps.has(f.type)) {
        deps.add(f.type);
        visit(f.type);
      }
    }
  }
  visit(primaryType);
  return Array.from(deps).sort();
}

function encodeData(
  types: PolicyTypedData["types"],
  primaryType: string,
  data: Record<string, unknown>,
): Uint8Array {
  const fields = (types as unknown as Record<string, Array<{ name: string; type: string }>>)[
    primaryType
  ];
  if (fields === undefined) throw new Error(`unknown type: ${primaryType}`);
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    parts.push(encodeField(types, f.type, data[f.name]));
  }
  return concatBytes(...parts);
}

function encodeField(types: PolicyTypedData["types"], type: string, value: unknown): Uint8Array {
  if (type === "bytes32") return hexToBytes(value as string);
  if (type === "address") return padLeft(hexToBytes((value as string).toLowerCase()), 32);
  if (type === "string") return keccak_256(value as string);
  if (type.startsWith("uint"))
    return padLeft(bigIntToBytes(BigInt(value as bigint | number | string)), 32);
  // Nested struct
  return hashStruct(types, type, value as Record<string, unknown>);
}

function padLeft(bytes: Uint8Array, size: number): Uint8Array {
  if (bytes.length >= size) return bytes.slice(-size);
  const out = new Uint8Array(size);
  out.set(bytes, size - bytes.length);
  return out;
}

function bigIntToBytes(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("negative uint unsupported");
  let hex = v.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return hexToBytes(hex);
}

function hexToBytes(h: string): Uint8Array {
  const clean = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s;
}

function concatBytes(...arrays: ReadonlyArray<Uint8Array>): Uint8Array {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function toHexPrefixed(hex: string): `0x${string}` {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${clean}` as `0x${string}`;
}
