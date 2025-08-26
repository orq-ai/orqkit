# Add Orq AI Provider to Community Providers Documentation

## Description

This PR adds documentation for the **Orq AI Provider** (`@orq-ai/vercel-provider`) to the Vercel AI SDK community providers section. 

Orq AI is a unified platform for AI model deployment and routing that provides access to multiple AI models through a single API endpoint, with automatic routing, optimization, and monitoring capabilities.

## Provider Details

- **NPM Package**: [@orq-ai/vercel-provider](https://www.npmjs.com/package/@orq-ai/vercel-provider)
- **GitHub Repository**: [orqkit/packages/vercel-provider](https://github.com/orq-ai/orqkit/tree/main/packages/vercel-provider)
- **Documentation**: [Orq AI Platform](https://orq.ai)
- **License**: Unlicense (Public Domain)

## Features

The Orq AI provider offers:

✅ **Full Vercel AI SDK Compatibility** - Works with all AI SDK functions (generateText, streamText, generateObject, embed, etc.)
✅ **Multiple Model Types** - Support for chat, completion, embedding, and image generation models
✅ **Streaming Support** - Real-time streaming responses
✅ **Type Safety** - Fully written in TypeScript with comprehensive type definitions
✅ **Platform Integration** - Direct access to Orq AI's model routing and optimization features

### Supported Capabilities

- ✅ Language Models (Chat & Completion)
- ✅ Text Embeddings
- ✅ Image Generation
- ✅ Tool/Function Calling
- ✅ Structured Output (JSON Schema)
- ✅ Streaming Responses
- ✅ Multi-modal Inputs

### Model Support

The provider gives access to models from:
- OpenAI (GPT-4, GPT-3.5, etc.)
- Anthropic (Claude)
- Google (Gemini)
- Meta (Llama)
- And many more through Orq AI's unified platform

## Implementation

The provider is built on top of the `@ai-sdk/openai-compatible` package and implements:
- `LanguageModelV2` specification
- `EmbeddingModelV2` specification  
- `ImageModelV2` specification

## Usage Example

```typescript
import { generateText } from 'ai';
import { createOrqAiProvider } from '@orq-ai/vercel-provider';

const orq = createOrqAiProvider({
  apiKey: process.env.ORQ_API_KEY,
});

const { text } = await generateText({
  model: orq('gpt-4o'),
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Testing

The provider has been tested with:
- All major AI SDK functions
- Various model types and providers
- Streaming and non-streaming modes
- Tool calling and structured outputs

## Documentation Added

This PR adds:
- [ ] Provider documentation page at `/content/providers/03-community-providers/orq-ai.mdx`
- [ ] Comprehensive usage examples
- [ ] Configuration guide
- [ ] Feature overview

## Checklist

- [x] Provider is published on NPM
- [x] Provider follows Vercel AI SDK specifications
- [x] Documentation includes setup instructions
- [x] Documentation includes usage examples
- [x] Provider is actively maintained
- [x] TypeScript support included

## Related Links

- [Orq AI Platform](https://orq.ai)
- [NPM Package](https://www.npmjs.com/package/@orq-ai/vercel-provider)
- [Provider Source Code](https://github.com/orq-ai/orqkit/tree/main/packages/vercel-provider)

## Community Impact

Adding the Orq AI provider to the community providers list will benefit developers by:
1. Providing a unified interface to multiple AI models
2. Offering automatic model routing and optimization
3. Simplifying AI model integration with built-in monitoring and fallback handling
4. Reducing costs through intelligent model selection

Thank you for considering this addition to the Vercel AI SDK community providers!