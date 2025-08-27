import { afterEach, describe, expect, it } from "bun:test";

import { Container, InjectionToken, inject } from "./tiny-di.js";

describe("Dependency Injection", () => {
  afterEach(async () => {
    await Container.dispose();
  });

  describe("Container", () => {
    it("should get registered dependency", () => {
      const token = new InjectionToken<string>("test-token");
      const value = "test-value";

      Container.register(token, value);
      const result = Container.get(token);

      expect(result).toBe(value);
    });

    it("should throw error when getting unregistered dependency", () => {
      const token = new InjectionToken<string>("unregistered");

      expect(() => Container.get(token)).toThrow(
        "No dependency registered for token unregistered",
      );
    });

    it("should throw error when registering duplicate dependency", () => {
      const token = new InjectionToken<string>("duplicate");
      const value = "value";

      Container.register(token, value);

      expect(() => Container.register(token, value)).toThrow(
        "Dependency already registered for token duplicate",
      );
    });

    it("should check if dependency exists", () => {
      const token = new InjectionToken<string>("exists");
      const value = "value";

      expect(Container.has(token)).toBe(false);

      Container.register(token, value);

      expect(Container.has(token)).toBe(true);
    });

    it("should clear all dependencies", () => {
      const token1 = new InjectionToken<string>("token1");
      const token2 = new InjectionToken<number>("token2");

      Container.register(token1, "value1");
      Container.register(token2, 42);

      expect(Container.size).toBe(2);

      Container.clear();

      expect(Container.size).toBe(0);
      expect(Container.has(token1)).toBe(false);
      expect(Container.has(token2)).toBe(false);
    });

    it("should return correct size", () => {
      expect(Container.size).toBe(0);

      const token1 = new InjectionToken<string>("token1");
      const token2 = new InjectionToken<number>("token2");

      Container.register(token1, "value1");
      expect(Container.size).toBe(1);

      Container.register(token2, 42);
      expect(Container.size).toBe(2);
    });
  });

  describe("InjectionToken with factory", () => {
    it("should create dependency lazily using factory", () => {
      let factoryCalled = false;
      const token = new InjectionToken<string>("lazy", () => {
        factoryCalled = true;
        return "lazy-value";
      });

      expect(factoryCalled).toBe(false);

      const result = Container.get(token);

      expect(factoryCalled).toBe(true);
      expect(result).toBe("lazy-value");
    });

    it("should only call factory once", () => {
      let callCount = 0;
      const token = new InjectionToken<string>("once", () => {
        callCount++;
        return `call-${callCount}`;
      });

      const result1 = Container.get(token);
      const result2 = Container.get(token);

      expect(callCount).toBe(1);
      expect(result1).toBe("call-1");
      expect(result2).toBe("call-1");
    });
  });

  describe("inject function", () => {
    it("should retrieve dependency using inject helper", () => {
      const token = new InjectionToken<string>("helper");
      const value = "helper-value";

      Container.register(token, value);
      const result = inject(token);

      expect(result).toBe(value);
    });
  });

  describe("Symbol support", () => {
    it("should work with Symbol tokens", () => {
      const symbolKey = Symbol("test");
      const token = new InjectionToken<string>(symbolKey);
      const value = "symbol-value";

      Container.register(token, value);
      const result = Container.get(token);

      expect(result).toBe(value);
    });

    it("should work with number tokens", () => {
      const token = new InjectionToken<string>(123);
      const value = "number-value";

      Container.register(token, value);
      const result = Container.get(token);

      expect(result).toBe(value);
    });
  });

  describe("Disposal", () => {
    it("should dispose dependencies with Symbol.dispose", async () => {
      let disposed = false;

      class DisposableService {
        async [Symbol.dispose]() {
          disposed = true;
        }
      }

      const token = new InjectionToken<DisposableService>("disposable");
      const service = new DisposableService();

      Container.register(token, service);

      expect(disposed).toBe(false);

      await Container.dispose();

      expect(disposed).toBe(true);
      expect(() => Container.get(token)).toThrow();
    });

    it("should dispose dependencies in reverse order", async () => {
      const order: number[] = [];

      class DisposableService {
        constructor(private id: number) {}

        async [Symbol.dispose]() {
          order.push(this.id);
        }
      }

      const token1 = new InjectionToken<DisposableService>("service1");
      const token2 = new InjectionToken<DisposableService>("service2");
      const token3 = new InjectionToken<DisposableService>("service3");

      Container.register(token1, new DisposableService(1));
      Container.register(token2, new DisposableService(2));
      Container.register(token3, new DisposableService(3));

      await Container.dispose();

      expect(order).toEqual([3, 2, 1]);
    });

    it("should handle dependencies without Symbol.dispose", async () => {
      const token = new InjectionToken<string>("non-disposable");
      Container.register(token, "value");

      await Container.dispose();

      expect(() => Container.get(token)).toThrow();
    });
  });

  describe("Complex types", () => {
    it("should handle class instances", () => {
      class TestService {
        constructor(public name: string) {}
      }

      const token = new InjectionToken<TestService>("service");
      const service = new TestService("test");

      Container.register(token, service);
      const result = Container.get(token);

      expect(result).toBe(service);
      expect(result.name).toBe("test");
    });

    it("should handle objects", () => {
      interface Config {
        url: string;
        port: number;
      }

      const token = new InjectionToken<Config>("config");
      const config = { url: "localhost", port: 3000 };

      Container.register(token, config);
      const result = Container.get(token);

      expect(result).toEqual(config);
    });

    it("should handle arrays", () => {
      const token = new InjectionToken<string[]>("array");
      const array = ["a", "b", "c"];

      Container.register(token, array);
      const result = Container.get(token);

      expect(result).toEqual(array);
    });
  });
});

describe("Integration scenarios", () => {
  afterEach(async () => {
    await Container.dispose();
  });

  it("should handle complex dependency graph", () => {
    // Database connection
    const dbToken = new InjectionToken<{ host: string }>("db", () => ({
      host: "localhost",
    }));

    // User repository that depends on database
    class UserRepository {
      constructor(public db: { host: string }) {}
    }

    const userRepoToken = new InjectionToken<UserRepository>(
      "userRepo",
      () => new UserRepository(Container.get(dbToken)),
    );

    // User service that depends on repository
    class UserService {
      constructor(public repo: UserRepository) {}
    }

    const userServiceToken = new InjectionToken<UserService>(
      "userService",
      () => new UserService(Container.get(userRepoToken)),
    );

    // Get the service (will trigger the whole chain)
    const service = Container.get(userServiceToken);

    expect(service).toBeInstanceOf(UserService);
    expect(service.repo).toBeInstanceOf(UserRepository);
    expect(service.repo.db.host).toBe("localhost");
  });

  it("should handle singleton pattern", () => {
    let instanceCount = 0;

    class SingletonService {
      public id: number;
      constructor() {
        this.id = ++instanceCount;
      }
    }

    const token = new InjectionToken<SingletonService>(
      "singleton",
      () => new SingletonService(),
    );

    const instance1 = Container.get(token);
    const instance2 = Container.get(token);

    expect(instance1).toBe(instance2);
    expect(instance1.id).toBe(1);
    expect(instanceCount).toBe(1);
  });
});
