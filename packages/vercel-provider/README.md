# @orq-ai/vercel-provider

A Vercel AI SDK provider for Orq AI platform that enables seamless integration of AI models with the Vercel AI SDK ecosystem.

## 🎯 Features

- **Full Vercel AI SDK Compatibility**: Works with all Vercel AI SDK functions (generateText, streamText, embed, etc.)
- **Multiple Model Types**: Support for chat, completion, embedding, and image generation models
- **Streaming Support**: Real-time streaming responses for better user experience
- **Type-safe**: Fully written in TypeScript with comprehensive type definitions
- **Orq Platform Integration**: Direct access to Orq AI's model routing and optimization

## 📥 Installation

```bash
npm install @orq-ai/vercel-provider ai
# or
yarn add @orq-ai/vercel-provider ai
# or
bun add @orq-ai/vercel-provider ai
```

### Peer Dependencies

This package requires the Vercel AI SDK:

```bash
npm install ai
```

## 🚀 Quick Start

### Importing the Provider
```typescript
import { createOrqAiProvider } from "@orq-ai/vercel-provider";

const orq = createOrqAiProvider({
  apiKey: "your-api-key", // Replace with your Orq API key
});
```

### Basic Usage

```typescript
import { generateText } from "ai";

const { text } = await generateText({
    model: orq("openai/gpt-4o"),
    prompt: "Hello world",
});
```
#### Or use the provider directly:
```typescript
const { content } = await orq("openai/gpt-4o").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello world" }] }],
});
```

### Chat Conversations

```typescript
import { generateText } from "ai";

const { text } = await generateText({
    model: orq("openai/gpt-4o"),
    system: "You are a helpful assistant that translates English to French.",
    prompt: "Hello world",
});
```
#### Or use the provider directly:
```typescript
const { content } = await orq("openai/gpt-4o").doGenerate({
    prompt: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
    ],
});
```

### Completion Models

```typescript
const { content } = await orq
    .completionModel("openai/gpt-3.5-turbo-instruct")
    .doGenerate({
        prompt: [
            {
                role: "user",
                content: [{ type: "text", text: "If you want to make a cake" }],
            },
        ],
    });
```

### Advanced Features

#### Streaming Responses

Stream responses for real-time interaction:

```typescript
import { streamText } from "ai";

const result = streamText({
    model: orq("openai/gpt-4o"),
    prompt: "Invent a new holiday and describe its traditions.",
});

// example: use textStream as an async iterable
for await (const textPart of result.textStream) {
    console.log(textPart);
}
```
#### Or use the provider directly:
```typescript
const result2 = await orq("openai/gpt-4o").doStream({
    prompt: [
        { role: "user", content: [{ type: "text", text: "Tell me a story" }] },
    ],
});

for await (const textPart of result2.stream) {
    console.log(textPart);
}
```

#### Text Embeddings

Generate embeddings for semantic search and similarity:

```typescript
import { embed } from "ai";

// 'embedding' is a single embedding object (number[])
const { embedding } = await embed({
    model: orq.textEmbeddingModel("openai/text-embedding-ada-002"),
    value: "sunny day at the beach",
});
```
#### Or use the provider directly:
```typescript
const { embedding } = await orq
    .textEmbeddingModel("openai/text-embedding-ada-002")
    .doEmbed({
        values: ["Hello world", "Bonjour le monde"],
    });
```

#### Image Generation

Create images using AI models:

```typescript
import { experimental_generateImage as generateImage } from "ai";

const { image } = await generateImage({
    model: orq.imageModel("openai/dall-e-3"),
    prompt: "Santa Claus driving a Cadillac",
});
```
#### Or use the provider directly:
```typescript
const { images } = await orq.imageModel("openai/dall-e-3").doGenerate({
    prompt: "A futuristic city at sunset",
    size: "1024x1024",
    n: 1,
    seed: 1,
    aspectRatio: "1:1",
    providerOptions: {
        openai: {
            style: "vivid",
        },
    },
});
```

## 🔧 Configuration

### Provider Options

```typescript
const orq = createOrqAiProvider({
  apiKey: "your-api-key",                    // Required: Orq API key
  baseURL: "https://api.orq.ai/v2/proxy",   // Optional: Custom API endpoint
  headers: {                                 // Optional: Additional headers
    "X-Custom-Header": "value",
  },
});
```

## 📚 API Reference

### `createOrqAiProvider(options)`

Creates an Orq AI provider instance.

#### Parameters:

- `options`: Configuration object with:
  - `apiKey`: String (required) - Your Orq API key
  - `baseURL`: String (optional) - Custom API base URL
  - `headers`: Object (optional) - Additional HTTP headers

#### Returns:

Provider instance with model access methods.

### Model Access Methods

- `orq(modelName)`: Returns a chat model (shorthand)
- `orq.chatModel(modelName)`: Returns a chat model
- `orq.completionModel(modelName)`: Returns a completion model
- `orq.textEmbeddingModel(modelName)`: Returns an embedding model
- `orq.imageModel(modelName)`: Returns an image generation model

### Types

```typescript
interface OrqAiProviderOptions {
  apiKey: string;
  baseURL?: string;
  headers?: Record<string, string>;
}
```

## 🛠️ Development

```bash
# Build the package
bunx nx build vercel-provider
```
