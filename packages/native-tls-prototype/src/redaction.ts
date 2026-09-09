import { registerDeclaredSecret } from "@launchfile/docker";

/** Proposed D-56 credential classification, demonstrated without registering a production type. */
export function isCredentialProperty(name: string, vocabulary: readonly string[] = []): boolean {
  if (["password", "secret_key", "access_key", "key_file"].includes(name) || /_key(?:_file)?$/.test(name)) return true;
  if (["host", "port", "name", "user", "url", "bucket", "region"].includes(name)) return false;
  return !vocabulary.includes(name);
}

export function registerBindingProperties(properties: Record<string, string>, vocabulary: readonly string[] = []): void {
  for (const [name, value] of Object.entries(properties)) {
    if (isCredentialProperty(name, vocabulary)) registerDeclaredSecret(value);
  }
}
