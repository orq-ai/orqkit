# orq-ai-sdk-provider

Vercel AI SDK provider for Orq.ai - integrate AI models with just a few lines of code.

## Quick Start

```bash
npm install @orq-ai-sdk-provider/orq-ai-sdk-provider
```

```typescript
import { createOrqAiProvider } from '@orq-ai-sdk-provider/orq-ai-sdk-provider';
import { generateText } from 'ai';

// Initialize
const orq = createOrqAiProvider({
  apiKey: 'your-orq-ai-api-key'
});

// Generate text
const { text } = await generateText({
  model: orq('gpt-4'),
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## Common Use Cases

### 💬 Chat

```typescript
const { text } = await generateText({
  model: orq('gpt-4'),
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is 2+2?' }
  ]
});
```

### 🔄 Streaming

```typescript
const { textStream } = await streamText({
  model: orq('gpt-4'),
  messages: [{ role: 'user', content: 'Tell me a joke' }]
});

for await (const chunk of textStream) {
  process.stdout.write(chunk);
}
```

### 📊 Embeddings

```typescript
import { embed } from 'ai';

const { embedding } = await embed({
  model: orq.textEmbeddingModel('text-embedding-ada-002'),
  value: 'Hello world'
});
```

### 🎨 Images

```typescript
const result = await orq.imageModel('dall-e-3').generate({
  prompt: 'A cat wearing sunglasses',
  size: '1024x1024'
});

console.log(result.images[0].url);
```

## Configuration Options

```typescript
const orq = createOrqAiProvider({
  apiKey: 'your-api-key',                     // Required
  baseURL: 'https://api.orq.ai/v2/proxy',    // Optional
  headers: { 'X-Custom': 'value' }           // Optional
});
```

## Available Models

- **Chat**: `orq('model-name')` or `orq.chatModel('model-name')`
- **Completion**: `orq.completionModel('model-name')`
- **Embedding**: `orq.textEmbeddingModel('model-name')`
- **Image**: `orq.imageModel('model-name')`

## Development

This library was generated with [Nx](https://nx.dev).

### Building

Run `nx build orq-ai-sdk-provider` to build the library.

### Running unit tests

Run `nx test orq-ai-sdk-provider` to execute the unit tests via [Vitest](https://vitest.dev/).

## License

[Your License Here]

## Contributing

[Your Contributing Guidelines Here]
