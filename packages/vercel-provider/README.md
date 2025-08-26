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

### Basic Usage

```typescript
import { createOrqAiProvider } from "@orq-ai/vercel-provider";
import { generateText } from "ai";

const orq = createOrqAiProvider({
  apiKey: process.env.ORQ_API_KEY,
});

const { text } = await generateText({
  model: orq("gpt-4"),
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Chat Conversations

```typescript
const { text } = await generateText({
  model: orq("gpt-4"),
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is 2+2?" },
  ],
});
```

### Advanced Features

#### Streaming Responses

Stream responses for real-time interaction:

```typescript
import { streamText } from "ai";

const { textStream } = await streamText({
  model: orq("gpt-4"),
  messages: [{ role: "user", content: "Tell me a story" }],
});

for await (const chunk of textStream) {
  process.stdout.write(chunk);
}
```

#### Text Embeddings

Generate embeddings for semantic search and similarity:

```typescript
import { embed } from "ai";

const { embedding } = await embed({
  model: orq.textEmbeddingModel("text-embedding-ada-002"),
  value: "Hello world",
});
```

#### Image Generation

Create images using AI models:

```typescript
const result = await orq.imageModel("dall-e-3").generate({
  prompt: "A futuristic city at sunset",
  size: "1024x1024",
  quality: "hd",
});

console.log(result.images[0].url);
```

#### Tool Calling

Integrate function calling capabilities:

```typescript
const { text } = await generateText({
  model: orq("gpt-4"),
  messages: [{ role: "user", content: "What's the weather in San Francisco?" }],
  tools: {
    getWeather: {
      description: "Get the current weather for a location",
      parameters: z.object({
        location: z.string().describe("The city and state"),
      }),
      execute: async ({ location }) => {
        return `The weather in ${location} is 72°F and sunny.`;
      },
    },
  },
});
```

## 🔧 Configuration

### Environment Variables

- `ORQ_API_KEY`: API key for Orq platform authentication

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

type OrqAiProvider = {
  (modelName: string): LanguageModel;
  chatModel: (modelName: string) => LanguageModel;
  completionModel: (modelName: string) => LanguageModel;
  textEmbeddingModel: (modelName: string) => EmbeddingModel<string>;
  imageModel: (modelName: string) => ImageModel;
};
```

## 🛠️ Development

```bash
# Build the package
bunx nx build vercel-provider
```
