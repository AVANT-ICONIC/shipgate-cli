import type { PolicyModule } from "./types.js";

export class PolicyRegistry {
  readonly #modules = new Map<string, PolicyModule>();

  constructor(modules: PolicyModule[] = []) {
    for (const module of modules) this.register(module);
  }

  register(module: PolicyModule): void {
    const id = module.id.trim();
    if (!id) throw new Error("Policy module id must not be empty.");
    if (this.#modules.has(id)) throw new Error(`Policy module already registered: ${id}`);
    this.#modules.set(id, module);
  }

  get(id: string): PolicyModule {
    const module = this.#modules.get(id);
    if (!module) throw new Error(`Unknown policy: ${id}`);
    return module;
  }

  has(id: string): boolean {
    return this.#modules.has(id);
  }

  ids(): string[] {
    return [...this.#modules.keys()].sort();
  }
}

export const builtInPolicies = new PolicyRegistry();
