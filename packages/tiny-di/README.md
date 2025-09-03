# @orq-ai/tiny-di

A minimal, zero-dependency TypeScript dependency injection container with support for lazy initialization and automatic disposal.

## 🎯 Features

- **Zero dependencies** - No external packages required
- **TypeScript first** - Full type safety and IntelliSense support
- **Lazy initialization** - Dependencies can be created on-demand via factory functions
- **Automatic disposal** - Built-in support for resource cleanup via Symbol.dispose
- **Minimal API** - Simple and intuitive API with only the essentials

## 📥 Installation

```bash
npm install @orq-ai/tiny-di
# or
yarn add @orq-ai/tiny-di
# or
bun add @orq-ai/tiny-di
```

## 🚀 Quick Start

```typescript
import { Container, InjectionToken, inject } from "@orq-ai/tiny-di";

// Define a token for your dependency
const DATABASE_TOKEN = new InjectionToken<Database>("database");

// Register a dependency
Container.register(DATABASE_TOKEN, new Database());

// Retrieve the dependency
const db = Container.get(DATABASE_TOKEN);
// or use the helper function
const db2 = inject(DATABASE_TOKEN);
```

## 📚 API Reference

### `InjectionToken<T>`

Creates a token for identifying dependencies in the container.

```typescript
const token = new InjectionToken<MyService>("myService");

// With factory for lazy initialization
const token = new InjectionToken<MyService>("myService", () => new MyService());
```

### `Container`

The main dependency injection container.

#### Methods

- `register(token, value)` - Register a dependency
- `get(token)` - Retrieve a dependency
- `has(token)` - Check if a dependency exists
- `dispose()` - Dispose all dependencies (calls Symbol.dispose if available)
- `clear()` - Clear all dependencies without disposal
- `size` - Get the number of registered dependencies

### `inject(token)`

Helper function to retrieve dependencies.

```typescript
const service = inject(SERVICE_TOKEN);
```

## 💡 Examples

### Basic Usage

```typescript
import { Container, InjectionToken } from "@orq-ai/tiny-di";

// Define tokens
const API_TOKEN = new InjectionToken<ApiClient>("api");
const LOGGER_TOKEN = new InjectionToken<Logger>("logger");

// Register dependencies
Container.register(API_TOKEN, new ApiClient());
Container.register(LOGGER_TOKEN, new ConsoleLogger());

// Use dependencies
const api = Container.get(API_TOKEN);
const logger = Container.get(LOGGER_TOKEN);
```

### Lazy Initialization

```typescript
const CONFIG_TOKEN = new InjectionToken<Config>("config", () => {
  // This factory function is only called when the dependency is first requested
  return loadConfigFromFile("./config.json");
});

// Config is loaded only when accessed
const config = Container.get(CONFIG_TOKEN);
```

### Automatic Disposal

```typescript
class DatabaseConnection {
  async [Symbol.dispose]() {
    await this.close();
    console.log("Database connection closed");
  }
}

const DB_TOKEN = new InjectionToken<DatabaseConnection>("db");
Container.register(DB_TOKEN, new DatabaseConnection());

// Later, when shutting down
await Container.dispose(); // Automatically calls Symbol.dispose on all dependencies
```

### Dependency Graph

```typescript
// Tokens with factories can depend on other tokens
const DB_TOKEN = new InjectionToken<Database>("db", 
  () => new Database()
);

const USER_REPO_TOKEN = new InjectionToken<UserRepository>("userRepo", 
  () => new UserRepository(Container.get(DB_TOKEN))
);

const USER_SERVICE_TOKEN = new InjectionToken<UserService>("userService",
  () => new UserService(Container.get(USER_REPO_TOKEN))
);

// Getting the service automatically creates the entire dependency chain
const userService = Container.get(USER_SERVICE_TOKEN);
```

## 🧪 Testing

```bash
bun test
```

## 📝 License

MIT

---

Part of the [OrqKit](https://github.com/orq-ai/orqkit) monorepo by [Orq AI](https://orq.ai).