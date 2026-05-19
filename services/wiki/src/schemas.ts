/**
 * Wiki schema registry and validator. Loads the JSON Schemas from
 * `schemas/entity/*.schema.json` and `schemas/relation/*.schema.json` and
 * exposes a validate() function for the /wiki/annotate write path and
 * extraction pipeline.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { brainError } from "@brain/shared";
import { ENTITY_KINDS, RELATION_KINDS, type EntityKind, type RelationKind } from "@brain/schemas";

export interface SchemaRegistry {
  entity: Record<EntityKind, Record<string, unknown>>;
  relation: Record<RelationKind, Record<string, unknown>>;
  validateEntity(kind: EntityKind, attributes: Record<string, unknown>): void;
  validateRelation(kind: RelationKind, attributes: Record<string, unknown>): void;
}

function loadSchemaDir(dir: string): Record<string, Record<string, unknown>> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
  const out: Record<string, Record<string, unknown>> = {};
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    const schema = JSON.parse(raw) as Record<string, unknown>;
    const kind = file.replace(/\.schema\.json$/, "");
    out[kind] = schema;
  }
  return out;
}

export function loadRegistry(repoRoot?: string): SchemaRegistry {
  const root = repoRoot ?? findRepoRoot();
  const entityDir = join(root, "schemas", "entity");
  const relationDir = join(root, "schemas", "relation");

  const entityRaw = loadSchemaDir(entityDir);
  const relationRaw = loadSchemaDir(relationDir);

  const entity: Record<EntityKind, Record<string, unknown>> = {} as Record<
    EntityKind,
    Record<string, unknown>
  >;
  for (const k of ENTITY_KINDS) {
    const s = entityRaw[k];
    if (s === undefined) throw new Error(`missing JSON schema for entity kind '${k}'`);
    entity[k] = s;
  }
  const relation: Record<RelationKind, Record<string, unknown>> = {} as Record<
    RelationKind,
    Record<string, unknown>
  >;
  for (const k of RELATION_KINDS) {
    const s = relationRaw[k];
    if (s === undefined) throw new Error(`missing JSON schema for relation kind '${k}'`);
    relation[k] = s;
  }

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as unknown as (a: InstanceType<typeof Ajv2020>) => void)(ajv);
  const entityValidators: Record<EntityKind, ValidateFunction> = {} as Record<
    EntityKind,
    ValidateFunction
  >;
  const relationValidators: Record<RelationKind, ValidateFunction> = {} as Record<
    RelationKind,
    ValidateFunction
  >;
  for (const k of ENTITY_KINDS) entityValidators[k] = ajv.compile(entity[k]);
  for (const k of RELATION_KINDS) relationValidators[k] = ajv.compile(relation[k]);

  function validateEntity(kind: EntityKind, attributes: Record<string, unknown>): void {
    const v = entityValidators[kind];
    const ok = v(attributes);
    if (!ok) {
      throw brainError("wiki_schema_validation_failed", `entity ${kind} validation failed`, {
        details: { errors: v.errors ?? [] },
      });
    }
  }
  function validateRelation(kind: RelationKind, attributes: Record<string, unknown>): void {
    const v = relationValidators[kind];
    const ok = v(attributes);
    if (!ok) {
      throw brainError("wiki_schema_validation_failed", `relation ${kind} validation failed`, {
        details: { errors: v.errors ?? [] },
      });
    }
  }

  return { entity, relation, validateEntity, validateRelation };
}

function findRepoRoot(): string {
  // src/schemas.ts → services/wiki/src/ → repo root is 3 levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
}
