export type DirectoryProviderKind = "none" | "okta" | "google_workspace" | "microsoft_entra";

export interface DirectoryUser {
  email: string;
  displayName: string;
  active: boolean;
}

export interface DirectoryProvider {
  readonly kind: DirectoryProviderKind;
  listUsers(): Promise<DirectoryUser[]>;
}

export class NoneDirectoryProvider implements DirectoryProvider {
  public readonly kind = "none" as const;

  public async listUsers(): Promise<DirectoryUser[]> {
    return [];
  }
}

export class TodoDirectoryProvider implements DirectoryProvider {
  public constructor(public readonly kind: Exclude<DirectoryProviderKind, "none">) {}

  public async listUsers(): Promise<DirectoryUser[]> {
    return [];
  }
}
