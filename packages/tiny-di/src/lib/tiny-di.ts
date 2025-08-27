/**
 * A token representing a dependency in the injection system.
 * Can optionally include a factory function for lazy initialization.
 */
/** biome-ignore-all lint/complexity/noStaticOnlyClass: it feels better as a static class, open to other suggestions */

export class InjectionToken<const TYPE = unknown> {
  constructor(
    readonly name: string | symbol | number,
    readonly factory?: () => TYPE,
  ) {}
}

/**
 * Main dependency injection container.
 * Manages registration, retrieval, and disposal of dependencies.
 */
export abstract class Container {
  static #registry = new Map();

  /**
   * Retrieves a dependency from the container.
   * If the dependency doesn't exist but has a factory, it will be created lazily.
   */
  static get<T>(token: InjectionToken<T>): T {
    const tokenExists = Container.#registry.has(token.name);

    if (!tokenExists && token.factory === undefined) {
      throw new Error(
        `No dependency registered for token ${token.name.toString()}`,
      );
    }

    if (!tokenExists && token.factory !== undefined) {
      Container.#registry.set(token.name, token.factory());
    }

    return Container.#registry.get(token.name) as T;
  }

  /**
   * Registers a dependency in the container.
   * Throws if a dependency with the same token is already registered.
   */
  static register<T>(token: InjectionToken<T>, value: T): void {
    if (Container.#registry.has(token.name)) {
      throw new Error(
        `Dependency already registered for token ${String(token.name)}`,
      );
    }

    Container.#registry.set(token.name, value);
  }

  /**
   * Checks if a dependency is registered in the container.
   */
  static has<T>(token: InjectionToken<T>): boolean {
    return Container.#registry.has(token.name);
  }

  /**
   * Disposes all registered dependencies that implement Symbol.dispose.
   * Dependencies are disposed in reverse order of registration.
   */
  static async dispose(): Promise<void> {
    for (const dependency of Array.from(
      Container.#registry.values(),
    ).reverse()) {
      if (typeof dependency?.[Symbol.dispose] === "function") {
        await dependency[Symbol.dispose]();
      }
    }

    Container.#registry.clear();
  }

  /**
   * Clears all registered dependencies without disposal.
   * Use with caution - prefer dispose() for proper cleanup.
   */
  static clear(): void {
    Container.#registry.clear();
  }

  /**
   * Returns the number of registered dependencies.
   */
  static get size(): number {
    return Container.#registry.size;
  }
}

/**
 * Helper function to retrieve a dependency from the container.
 * Provides a more convenient syntax than Container.get().
 */
export function inject<T>(token: InjectionToken<T>): T {
  return Container.get(token);
}
