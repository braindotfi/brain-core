export interface ServiceHealth {
  ok?: unknown;
  service?: unknown;
  commit?: unknown;
}

export function assertServiceHealth(
  value: unknown,
  expectedService: string,
  expectedCommit: string,
): void {
  if (typeof value !== "object" || value === null) throw new Error("health_not_object");
  const health = value as ServiceHealth;
  if (health.ok !== true) throw new Error("health_not_ok");
  if (health.service !== expectedService) throw new Error("health_wrong_service");
  if (health.commit !== expectedCommit) throw new Error("health_wrong_commit");
}

export function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`missing_env:${name}`);
  return value;
}

export function assertMountedSecrets(
  namesCsv: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const names = [
    ...new Set(
      namesCsv
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) throw new Error("mounted_secret_list_empty");
  for (const name of names) {
    const value = requiredEnv(name, env);
    if (value.includes("PLACEHOLDER-SET-OUT-OF-BAND")) {
      throw new Error(`placeholder_secret:${name}`);
    }
  }
  return names.length;
}

export function parseRoleEnvMap(value: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("db_role_map_not_object");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("db_role_map_empty");
  for (const [role, envName] of entries) {
    if (role === "" || typeof envName !== "string" || envName === "") {
      throw new Error("db_role_map_invalid");
    }
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

export function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_:.-]+$/i.test(error.message)) return error.message;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (/^[a-z0-9_.-]+$/i.test(code)) return code;
  }
  return "validation_failed";
}
