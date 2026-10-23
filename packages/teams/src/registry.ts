/**
 * In-process global name registry maintaining a member-name -> agentId mapping.
 * SendMessage uses it to resolve recipient names provided by the user/LLM into delivery identifiers.
 */
export class NameRegistry {
  private names = new Map<string, string>();

  register(name: string, agentId: string): void {
    this.names.set(name, agentId);
  }

  /**
   * Resolves a name or ID to an agentId: looks up by name first; if the input is already an ID, returns it as-is;
   * returns undefined if neither lookup succeeds.
   */
  resolve(nameOrId: string): string | undefined {
    const byName = this.names.get(nameOrId);
    if (byName !== undefined) {
      return byName;
    }
    for (const id of this.names.values()) {
      if (id === nameOrId) {
        return nameOrId;
      }
    }
    return undefined;
  }

  unregister(name: string): void {
    this.names.delete(name);
  }

  /** Clears all mappings; primarily used for test isolation. */
  clear(): void {
    this.names.clear();
  }
}

let instance: NameRegistry | undefined;

export function getNameRegistry(): NameRegistry {
  instance ??= new NameRegistry();
  return instance;
}
