// Generated from the Python pydantic models by tests/lib/fixtures/python_cli_schemas.py: the JSON schemas `schema` commands print.
export const PYTHON_CLI_SCHEMAS: Readonly<Record<string, unknown>> = {
  RedTeamCliConfig: {
    $defs: {
      AgentResponse: {
        description:
          'Structured response from a target agent as an ordered list of output messages.\n\nEach item in ``output`` is a `TextOutputItem`, `ToolCallOutputItem`,\nor `ReasoningOutputItem`, preserving the order in which they were produced.\nItem ``type`` discriminators align with the OpenResponses intermediate data format\n(``output_text``, ``function_call``, ``reasoning``).\n\nAccessors:\n    ``.text``       \u2014 all ``TextOutputItem`` contents concatenated, or ``""`` if none\n    ``.tool_calls`` \u2014 list of `ToolCallOutputItem` filtered from\n    `output` in order\n    ``.refusal``    \u2014 the first provider refusal, when the response contains one',
        properties: {
          output: {
            items: {
              discriminator: {
                mapping: {
                  function_call:
                    "#/$defs/evaluatorq__openresponses__convert_models__FunctionCall",
                  output_text: "#/$defs/OutputTextContent",
                  reasoning: "#/$defs/ReasoningOutputItem",
                },
                propertyName: "type",
              },
              oneOf: [
                {
                  $ref: "#/$defs/OutputTextContent",
                },
                {
                  $ref: "#/$defs/evaluatorq__openresponses__convert_models__FunctionCall",
                },
                {
                  $ref: "#/$defs/ReasoningOutputItem",
                },
              ],
            },
            title: "Output",
            type: "array",
          },
          usage: {
            anyOf: [
              {
                $ref: "#/$defs/Usage",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          model: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Model",
          },
          response_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Response Id",
          },
          trace_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Trace Id",
          },
          span_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Span Id",
          },
          finish_reason: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Finish Reason",
          },
          refusal: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Refusal",
          },
          error: {
            anyOf: [
              {
                $ref: "#/$defs/AgentResponseError",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
        },
        title: "AgentResponse",
        type: "object",
      },
      AgentResponseError: {
        description:
          'A per-response error marker on `AgentResponse`.\n\nSet when a target (or simulation agent) failed to produce a real response,\ne.g. a timeout or backend exception. The orchestrator uses its presence to\nexclude the turn from the transcript replayed to the target. ``message`` is\nthe same human text surfaced in ``AgentResponse.text``; ``code`` is an\noptional provider/mapped code.\n\n``error_type`` is a coarse, open-vocabulary string \u2014 consumers key off the\nerror\'s *presence*, not its value, so the field is intentionally not an\nenum. The orchestrator sets ``"timeout"`` on the timeout path and otherwise\nclassifies the failure via\n`evaluatorq.common.target_call.classify_error_type`, which yields one\nof ``content_filter``, ``rate_limit``, ``timeout``, ``network_error``,\n``server_error``, ``client_error``, or ``target_error`` (fallback for an\nunmatched error). Other producers may set their own values.\n\nThis is the leaf, per-response error. The whole-run rollup is\n`evaluatorq.redteam.contracts.RunError`.',
        properties: {
          message: {
            title: "Message",
            type: "string",
          },
          error_type: {
            title: "Error Type",
            type: "string",
          },
          code: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Code",
          },
        },
        required: ["message", "error_type"],
        title: "AgentResponseError",
        type: "object",
      },
      AttackTechnique: {
        description:
          "Known attack techniques used in red teaming attacks.\n\nThis enum tracks *known* techniques for internal validation and reporting.\nExternal datasets may contain additional values \u2014 use\n`is_known_attack_technique` to check membership without failing.",
        enum: [
          "indirect-injection",
          "direct-injection",
          "DAN",
          "autodan",
          "developer-mode",
          "credential-caching",
          "privilege-escalation",
          "confused-deputy",
          "excessive-agency",
          "plugin-abuse",
          "rce-exploit",
          "supply-chain",
          "resource-exhaustion",
          "message-spoofing",
          "social-engineering",
          "emotional-manipulation",
          "payload-splitting",
          "alternative-encoding",
          "unicode-obfuscation",
          "model-extraction",
          "pii-extraction",
          "pii-input",
          "system-prompt-extraction",
          "tool-abuse",
          "context-poisoning",
          "cascade-trigger",
          "boundary-violation",
        ],
        title: "AttackTechnique",
        type: "string",
      },
      DataPoint: {
        description:
          'A data point for evaluation.\n\nArgs:\n    inputs: The inputs to pass to the job.\n    expected_output: The expected output of the data point.\n                    Used for evaluation and comparing the output of the job.\n\nExample:\n    ```python\n    from evaluatorq import DataPoint\n\n    DataPoint(inputs={"text": "Hello world"}, expected_output="HELLO WORLD")\n    ```',
        properties: {
          inputs: {
            additionalProperties: true,
            title: "Inputs",
            type: "object",
          },
          expected_output: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "integer",
              },
              {
                type: "number",
              },
              {
                type: "boolean",
              },
              {
                additionalProperties: true,
                type: "object",
              },
              {
                items: {
                  $ref: "#/$defs/Message",
                },
                type: "array",
              },
              {
                $ref: "#/$defs/AgentResponse",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Expected Output",
          },
        },
        required: ["inputs"],
        title: "DataPoint",
        type: "object",
      },
      DeliveryMethod: {
        description:
          "Known jailbreak and delivery techniques.\n\nSee `AttackTechnique` \u2014 the same open-set policy applies.",
        enum: [
          "DAN",
          "role-play",
          "skeleton-key",
          "base64",
          "leetspeak",
          "multilingual",
          "character-spacing",
          "crescendo",
          "many-shot",
          "authority-impersonation",
          "refusal-suppression",
          "direct-request",
          "code-elicitation",
          "code-assistance",
          "tool-response",
          "word-substitution",
        ],
        title: "DeliveryMethod",
        type: "string",
      },
      EvaluatorConfig: {
        additionalProperties: false,
        description:
          "LLM evaluator-role configuration, including the optional judge panel.\n\n``model=\"x\"`` is accepted as shorthand for ``judges=[\"x\"]``. Decode/client\nfields are shared across every judge in the panel.\n\nIt subclasses `LLMCallConfig` instead of re-listing its fields, so a field\nadded there (e.g. ``reasoning_effort``) is accepted here automatically \u2014\nhand-listing them is what let this class and ``as_call_config()`` desync\nfrom `LLMCallConfig` and reject the sugar conversion in\n``_accept_model_sugar`` with ``extra_kwargs cannot...``.\n\nInherited verbatim: ``temperature``, ``max_tokens``, ``timeout_ms``,\n``extra_kwargs``, ``extra_body``, ``reasoning_effort`` and ``client``.\nThree fields are declared again below, on purpose:\n\n- ``model`` \u2014 nullable and ``exclude=True`` here. It is judge shorthand that\n  ``_accept_model_sugar`` folds into ``judges[0]``, not the required model id\n  the parent declares.\n- ``api`` \u2014 defaults to ``'responses'`` rather than the parent's\n  ``'chat_completions'``, so judge calls go to the endpoint the Orq router\n  prices.\n- ``retry_count`` \u2014 identical type, default and bounds; only the description\n  differs, to name this as the judge-side budget rather than the target one.\n\n``_assert_call_config_fields_agree`` below pins exactly that split at import\ntime: any *other* override of an inherited field, and any allowlist entry\nwhose divergence has since disappeared, is a hard failure.",
        properties: {
          model: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Primary judge model shorthand; normalized to judges[0].",
            title: "Model",
          },
          api: {
            default: "responses",
            description:
              "Endpoint judges call. Defaults to responses: it is the endpoint the Orq router prices, so judge calls record cost like target calls do. Set to chat_completions to opt out; a model the router cannot resolve on responses falls back to chat completions on its own.",
            enum: ["chat_completions", "responses"],
            title: "Api",
            type: "string",
          },
          temperature: {
            anyOf: [
              {
                maximum: 2.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Sampling temperature. Unset by default: when None the parameter is omitted from the request entirely, so the provider default applies and reasoning-class models that reject ``temperature`` (gpt-5 and the o-series answer 400) keep working. Set it only when you actually want to pin sampling.",
            title: "Temperature",
          },
          max_tokens: {
            default: 10000,
            exclusiveMinimum: 0,
            title: "Max Tokens",
            type: "integer",
          },
          timeout_ms: {
            default: 90000,
            exclusiveMinimum: 0,
            title: "Timeout Ms",
            type: "integer",
          },
          extra_kwargs: {
            additionalProperties: true,
            title: "Extra Kwargs",
            type: "object",
          },
          extra_body: {
            additionalProperties: true,
            description:
              "Extra fields for the request BODY, for router/provider options the SDK has no named parameter for. Distinct from ``extra_kwargs``, which sets top-level SDK call arguments. This one **merges into** the body the call site builds (the Orq router retry policy, thread and memory ids) rather than replacing it: your keys win per key, and the call site keeps the keys you did not set. Replacing the whole body is what silently dropped retry hints, which is why ``extra_body`` is rejected inside ``extra_kwargs``.",
            title: "Extra Body",
            type: "object",
          },
          reasoning_effort: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Reasoning effort. Rendered per endpoint by ``request_params``: flat ``reasoning_effort=`` on chat completions, ``reasoning={'effort': ...}`` on the Responses API. Not validated here: accepted values differ per model, so the provider is the only authority \u2014 an unsupported value comes back as a provider 400, which the `common.llm_call` executors turn into a drop-and-retry-once.",
            title: "Reasoning Effort",
          },
          client: {
            default: null,
            title: "Client",
          },
          retry_count: {
            default: 1,
            description:
              "Retries per judge call (after the initial call) on rate limits, 5xx and transport failures. Same semantics as LLMConfig.retry_count, but this is the judge-side budget, distinct from that target-side one. 0 disables retry \u2014 a failing judge then falls to the panel machinery (replacement_judges / min_successful_judges) immediately.",
            minimum: 0,
            title: "Retry Count",
            type: "integer",
          },
          judges: {
            description:
              "Judge model IDs. judges[0] is the primary evaluator model.",
            items: {
              type: "string",
            },
            minItems: 1,
            title: "Judges",
            type: "array",
          },
          repetitions: {
            default: 1,
            minimum: 1,
            title: "Repetitions",
            type: "integer",
          },
          replacement_judges: {
            items: {
              type: "string",
            },
            title: "Replacement Judges",
            type: "array",
          },
          min_successful_judges: {
            default: 1,
            minimum: 1,
            title: "Min Successful Judges",
            type: "integer",
          },
          min_evaluation_coverage: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: 0.8,
            description:
              "Fraction of attacks that must produce a verdict for the run to be trusted. Distinct from min_successful_judges, which is a per-attack quorum and is what *creates* unevaluated attacks; this is the run-level floor on how many of them are tolerable. The CLI exits non-zero below it. None disables the gate (warning only); zero coverage always fails regardless \u2014 see ReportSummary.no_verdict.",
            title: "Min Evaluation Coverage",
          },
          strict_panel: {
            default: false,
            title: "Strict Panel",
            type: "boolean",
          },
        },
        title: "EvaluatorConfig",
        type: "object",
      },
      FunctionCallStatus: {
        description: "Status for function calls and function call outputs.",
        enum: ["in_progress", "completed", "incomplete"],
        title: "FunctionCallStatus",
        type: "string",
      },
      InputFileContent: {
        properties: {
          type: {
            const: "input_file",
            description: "The type of the input item. Always `input_file`.",
            title: "Type",
            type: "string",
          },
          file_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The ID of an uploaded file.",
            title: "File Id",
          },
          file_data: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The base64-encoded contents of the file.",
            title: "File Data",
          },
          file_url: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The URL of the file.",
            title: "File Url",
          },
          filename: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The name of the file.",
            title: "Filename",
          },
          mime_type: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The MIME type of the file.",
            title: "Mime Type",
          },
        },
        required: ["type"],
        title: "InputFileContent",
        type: "object",
      },
      InputImageContent: {
        properties: {
          type: {
            const: "input_image",
            description: "The type of the input item. Always `input_image`.",
            title: "Type",
            type: "string",
          },
          image_url: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The URL of the image (https or data: URI).",
            title: "Image Url",
          },
          file_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The ID of an uploaded file to use as the image.",
            title: "File Id",
          },
          detail: {
            default: "auto",
            description:
              "The detail level the model uses to process the image.",
            enum: ["auto", "low", "high"],
            title: "Detail",
            type: "string",
          },
        },
        required: ["type"],
        title: "InputImageContent",
        type: "object",
      },
      InputTextContent: {
        properties: {
          type: {
            const: "input_text",
            description: "The type of the input item. Always `input_text`.",
            title: "Type",
            type: "string",
          },
          text: {
            description: "The text input to the model.",
            title: "Text",
            type: "string",
          },
        },
        required: ["type", "text"],
        title: "InputTextContent",
        type: "object",
      },
      LLMCallConfig: {
        description:
          "Per-role LLM call configuration.\n\nOne instance per pipeline role (attacker, evaluator). Controls model\nselection, API type, temperature, token limits, timeout, extra kwargs, and\noptionally an explicit pre-configured client.",
        properties: {
          model: {
            default: "openai/gpt-6-luna",
            title: "Model",
            type: "string",
          },
          api: {
            default: "chat_completions",
            enum: ["chat_completions", "responses"],
            title: "Api",
            type: "string",
          },
          temperature: {
            anyOf: [
              {
                maximum: 2.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Sampling temperature. Unset by default: when None the parameter is omitted from the request entirely, so the provider default applies and reasoning-class models that reject ``temperature`` (gpt-5 and the o-series answer 400) keep working. Set it only when you actually want to pin sampling.",
            title: "Temperature",
          },
          max_tokens: {
            default: 10000,
            exclusiveMinimum: 0,
            title: "Max Tokens",
            type: "integer",
          },
          timeout_ms: {
            default: 90000,
            exclusiveMinimum: 0,
            title: "Timeout Ms",
            type: "integer",
          },
          extra_kwargs: {
            additionalProperties: true,
            title: "Extra Kwargs",
            type: "object",
          },
          extra_body: {
            additionalProperties: true,
            description:
              "Extra fields for the request BODY, for router/provider options the SDK has no named parameter for. Distinct from ``extra_kwargs``, which sets top-level SDK call arguments. This one **merges into** the body the call site builds (the Orq router retry policy, thread and memory ids) rather than replacing it: your keys win per key, and the call site keeps the keys you did not set. Replacing the whole body is what silently dropped retry hints, which is why ``extra_body`` is rejected inside ``extra_kwargs``.",
            title: "Extra Body",
            type: "object",
          },
          reasoning_effort: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Reasoning effort. Rendered per endpoint by ``request_params``: flat ``reasoning_effort=`` on chat completions, ``reasoning={'effort': ...}`` on the Responses API. Not validated here: accepted values differ per model, so the provider is the only authority \u2014 an unsupported value comes back as a provider 400, which the `common.llm_call` executors turn into a drop-and-retry-once.",
            title: "Reasoning Effort",
          },
          client: {
            default: null,
            title: "Client",
          },
          retry_count: {
            default: 1,
            description:
              "Retries after the initial call, for callers that own retry via with_retry \u2014 currently the judge. Same semantics as LLMConfig.retry_count: 0 disables retry. The owning caller disarms the client's own retry budget for the duration (see run_judge) so the two cannot multiply.",
            minimum: 0,
            title: "Retry Count",
            type: "integer",
          },
        },
        title: "LLMCallConfig",
        type: "object",
      },
      LLMConfig: {
        additionalProperties: false,
        description:
          'Unified LLM configuration for the red teaming pipeline.\n\nConfigure per-role LLM behaviour via ``attacker`` and ``evaluator``.\nPass an instance as ``llm_config=LLMConfig(...)`` to `red_team`.\n\nExample:\n\n```python\nconfig = LLMConfig(\n    attacker=LLMCallConfig(model="anthropic/claude-3-5-sonnet", temperature=0.9),\n    evaluator=EvaluatorConfig(model="openai/gpt-5.6-luna", temperature=0.0),\n)\n```',
        properties: {
          attacker: {
            $ref: "#/$defs/LLMCallConfig",
          },
          evaluator: {
            $ref: "#/$defs/EvaluatorConfig",
          },
          retry_count: {
            default: 3,
            maximum: 10,
            minimum: 0,
            title: "Retry Count",
            type: "integer",
          },
          retry_on_codes: {
            default: [429, 500, 502, 503, 504],
            items: {
              type: "integer",
            },
            title: "Retry On Codes",
            type: "array",
          },
          max_content_filter_retries: {
            default: 2,
            maximum: 10,
            minimum: 0,
            title: "Max Content Filter Retries",
            type: "integer",
          },
          max_consecutive_adversarial_timeouts: {
            default: 2,
            maximum: 10,
            minimum: 1,
            title: "Max Consecutive Adversarial Timeouts",
            type: "integer",
          },
          max_objectives_per_llm_call: {
            default: 8,
            minimum: 1,
            title: "Max Objectives Per Llm Call",
            type: "integer",
          },
          max_probe_turns: {
            default: 8,
            minimum: 1,
            title: "Max Probe Turns",
            type: "integer",
          },
          max_backtracks: {
            default: 0,
            maximum: 10,
            minimum: 0,
            title: "Max Backtracks",
            type: "integer",
          },
          cleanup_timeout_ms: {
            default: 60000,
            title: "Cleanup Timeout Ms",
            type: "integer",
          },
          target_agent_timeout_ms: {
            default: 240000,
            title: "Target Agent Timeout Ms",
            type: "integer",
          },
          max_target_retries: {
            default: 2,
            maximum: 10,
            minimum: 0,
            title: "Max Target Retries",
            type: "integer",
          },
          target_reasoning_effort: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Target Reasoning Effort",
          },
          max_tool_continuations: {
            default: 5,
            description:
              "Max client-driven tool-result continuation rounds for ORQ agents that emit pending_tool_calls.",
            title: "Max Tool Continuations",
            type: "integer",
          },
        },
        title: "LLMConfig",
        type: "object",
      },
      LogProb: {
        properties: {
          token: {
            title: "Token",
            type: "string",
          },
          logprob: {
            title: "Logprob",
            type: "number",
          },
          bytes: {
            items: {
              type: "integer",
            },
            title: "Bytes",
            type: "array",
          },
          top_logprobs: {
            items: {
              $ref: "#/$defs/TopLogProb",
            },
            title: "Top Logprobs",
            type: "array",
          },
        },
        required: ["token", "logprob", "bytes", "top_logprobs"],
        title: "LogProb",
        type: "object",
      },
      Message: {
        description:
          'Single message in conversation history (OpenAI format with tool support).\n\nSupports both simple messages and tool calls:\n- Simple: ``{"role": "user", "content": "Hello"}``\n- Tool call: ``{"role": "assistant", "tool_calls": [...]}``\n- Tool response: ``{"role": "tool", "tool_call_id": "...", "name": "...", "content": "..."}``',
        properties: {
          role: {
            enum: ["user", "assistant", "tool", "system", "developer"],
            title: "Role",
            type: "string",
          },
          content: {
            anyOf: [
              {
                type: "string",
              },
              {
                items: {
                  discriminator: {
                    mapping: {
                      input_file: "#/$defs/InputFileContent",
                      input_image: "#/$defs/InputImageContent",
                      input_text: "#/$defs/InputTextContent",
                    },
                    propertyName: "type",
                  },
                  oneOf: [
                    {
                      $ref: "#/$defs/InputTextContent",
                    },
                    {
                      $ref: "#/$defs/InputImageContent",
                    },
                    {
                      $ref: "#/$defs/InputFileContent",
                    },
                  ],
                },
                type: "array",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Message content. A plain string, or a list of multi-modal content parts (text/image/file). Required for user/system, optional for assistant with tool_calls.",
            title: "Content",
          },
          tool_calls: {
            anyOf: [
              {
                items: {
                  $ref: "#/$defs/StrategyToolCall",
                },
                type: "array",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Tool calls made by assistant",
            title: "Tool Calls",
          },
          tool_call_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "ID linking tool response to call (for role=tool)",
            title: "Tool Call Id",
          },
          name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Function name (for role=tool)",
            title: "Name",
          },
        },
        required: ["role"],
        title: "Message",
        type: "object",
      },
      OutputTextContent: {
        properties: {
          type: {
            const: "output_text",
            default: "output_text",
            description: "The type of the output text. Always `output_text`.",
            title: "Type",
            type: "string",
          },
          text: {
            description: "The text output from the model.",
            title: "Text",
            type: "string",
          },
          annotations: {
            description: "The annotations of the text output.",
            items: {
              $ref: "#/$defs/UrlCitationBody",
            },
            title: "Annotations",
            type: "array",
          },
          logprobs: {
            items: {
              $ref: "#/$defs/LogProb",
            },
            title: "Logprobs",
            type: "array",
          },
        },
        required: ["text"],
        title: "OutputTextContent",
        type: "object",
      },
      Pipeline: {
        description: "Supported unified report pipeline identifiers.",
        enum: ["static", "dynamic", "hybrid"],
        title: "Pipeline",
        type: "string",
      },
      ReasoningOutputItem: {
        description:
          "A reasoning / thinking step in the agent output message list.\n\nCaptures chain-of-thought or intermediate reasoning produced by the model\n(e.g. OpenAI o-series extended thinking, or agent intermediate steps).\nAligns with the OpenResponses ``reasoning`` item type.",
        properties: {
          type: {
            const: "reasoning",
            default: "reasoning",
            title: "Type",
            type: "string",
          },
          text: {
            title: "Text",
            type: "string",
          },
          id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Id",
          },
        },
        required: ["text"],
        title: "ReasoningOutputItem",
        type: "object",
      },
      RedTeamRecommendationConfig: {
        additionalProperties: false,
        description:
          "Tunable limits for focus-area recommendation generation.\n\nPass an instance as ``recommendations=RedTeamRecommendationConfig(...)`` to\n``red_team``; ``recommendations=True`` uses these defaults and ``False`` skips the\nLLM call entirely. ``SimulationRecommendationConfig`` is the agent-simulation twin \u2014\nboth inherit the shared caps from ``RecommendationConfigBase``.",
        properties: {
          max_suggestions: {
            default: 5,
            minimum: 1,
            title: "Max Suggestions",
            type: "integer",
          },
          max_tokens: {
            default: 1500,
            minimum: 1,
            title: "Max Tokens",
            type: "integer",
          },
          max_areas: {
            default: 5,
            minimum: 1,
            title: "Max Areas",
            type: "integer",
          },
          max_attacks: {
            default: 10,
            minimum: 1,
            title: "Max Attacks",
            type: "integer",
          },
          max_attack_chars: {
            default: 200000,
            minimum: 100,
            title: "Max Attack Chars",
            type: "integer",
          },
          max_explanation_chars: {
            default: 300,
            minimum: 50,
            title: "Max Explanation Chars",
            type: "integer",
          },
          condense_above_chars: {
            default: 1000,
            minimum: 100,
            title: "Condense Above Chars",
            type: "integer",
          },
          condense_max_tokens: {
            default: 10000,
            minimum: 1,
            title: "Condense Max Tokens",
            type: "integer",
          },
          max_area_prompt_chars: {
            default: 400000,
            minimum: 1000,
            title: "Max Area Prompt Chars",
            type: "integer",
          },
        },
        title: "RedTeamRecommendationConfig",
        type: "object",
      },
      SaveMode: {
        description:
          "Controls what gets persisted to disk after a red team run.",
        enum: ["none", "final", "detail"],
        title: "SaveMode",
        type: "string",
      },
      StrategyToolCall: {
        description: "Tool call in assistant message (OpenAI format).",
        properties: {
          id: {
            description: "Unique tool call ID (e.g., call_abc123)",
            title: "Id",
            type: "string",
          },
          type: {
            const: "function",
            default: "function",
            description: "Tool type",
            title: "Type",
            type: "string",
          },
          function: {
            $ref: "#/$defs/evaluatorq__contracts__FunctionCall",
            description: "Function call details",
          },
          item_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Responses-API function_call item id (fc_*)",
            title: "Item Id",
          },
          incomplete: {
            default: false,
            description:
              "The recorded fact that this call has no result. Judge text and exports mark it from this flag; provider replay does not trust it and pairs by position instead (`common.messages.pair_tool_rows`).",
            title: "Incomplete",
            type: "boolean",
          },
        },
        required: ["id", "function"],
        title: "StrategyToolCall",
        type: "object",
      },
      TargetConfig: {
        description:
          "Backend-agnostic target configuration.\n\nPassed opaquely through the runner to backends/factories.",
        properties: {
          system_prompt: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "System prompt for the target model/agent",
            title: "System Prompt",
          },
        },
        title: "TargetConfig",
        type: "object",
      },
      TopLogProb: {
        properties: {
          token: {
            title: "Token",
            type: "string",
          },
          logprob: {
            title: "Logprob",
            type: "number",
          },
          bytes: {
            items: {
              type: "integer",
            },
            title: "Bytes",
            type: "array",
          },
        },
        required: ["token", "logprob", "bytes"],
        title: "TopLogProb",
        type: "object",
      },
      UrlCitationBody: {
        properties: {
          type: {
            const: "url_citation",
            description: "The type of the URL citation. Always `url_citation`.",
            title: "Type",
            type: "string",
          },
          url: {
            description: "The URL of the web resource.",
            title: "Url",
            type: "string",
          },
          start_index: {
            description:
              "The index of the first character of the URL citation in the message.",
            title: "Start Index",
            type: "integer",
          },
          end_index: {
            description:
              "The index of the last character of the URL citation in the message.",
            title: "End Index",
            type: "integer",
          },
          title: {
            description: "The title of the web resource.",
            title: "Title",
            type: "string",
          },
        },
        required: ["type", "url", "start_index", "end_index", "title"],
        title: "UrlCitationBody",
        type: "object",
      },
      Usage: {
        description:
          "Token usage and cost for an LLM call or aggregation of calls.\n\nField naming follows the OpenTelemetry GenAI semconv / OpenResponses standard\n(``input_tokens``/``output_tokens`` rather than ``prompt``/``completion``).\n``cached_tokens`` is a subset of ``input_tokens`` and ``reasoning_tokens`` a\nsubset of ``output_tokens``, so the reconciliation invariant is\n``total_tokens == input_tokens + output_tokens`` (with cached \u2264 input,\nreasoning \u2264 output). ``total_tokens`` is stored as provided by the upstream\nprovider and never overridden.\n\nCost fields mirror the Orq Responses v3 usage shape (``input_cost``/\n``output_cost``/``total_cost``, USD). ``None`` means the provider did not\nreport that component \u2014 never fabricated as 0.\n\nBack-compat: the legacy ``prompt_tokens``/``completion_tokens``/``cost_usd``\nnames are accepted on construction and exposed as read-only properties so\ncall sites that have not migrated keep working. ``TokenUsage`` remains as a\ndeprecated alias for this class.",
        properties: {
          input_tokens: {
            default: 0,
            description: "Input/prompt tokens (includes cached_tokens)",
            minimum: 0,
            title: "Input Tokens",
            type: "integer",
          },
          output_tokens: {
            default: 0,
            description: "Output/completion tokens (includes reasoning_tokens)",
            minimum: 0,
            title: "Output Tokens",
            type: "integer",
          },
          total_tokens: {
            default: 0,
            description: "Total tokens as reported by the provider",
            minimum: 0,
            title: "Total Tokens",
            type: "integer",
          },
          cached_tokens: {
            default: 0,
            description: "Cached input tokens (subset of input_tokens)",
            minimum: 0,
            title: "Cached Tokens",
            type: "integer",
          },
          cache_creation_tokens: {
            default: 0,
            description:
              "Cache-write input tokens (subset of input_tokens for OpenAI-shaped payloads; reported separately by Anthropic)",
            minimum: 0,
            title: "Cache Creation Tokens",
            type: "integer",
          },
          cache_creation_1h_tokens: {
            default: 0,
            description:
              "Cache-write tokens at the 1h TTL tier (subset of cache_creation_tokens)",
            minimum: 0,
            title: "Cache Creation 1H Tokens",
            type: "integer",
          },
          cache_creation_5m_tokens: {
            default: 0,
            description:
              "Cache-write tokens at the 5m TTL tier (subset of cache_creation_tokens)",
            minimum: 0,
            title: "Cache Creation 5M Tokens",
            type: "integer",
          },
          reasoning_tokens: {
            default: 0,
            description: "Reasoning output tokens (subset of output_tokens)",
            minimum: 0,
            title: "Reasoning Tokens",
            type: "integer",
          },
          input_cost: {
            anyOf: [
              {
                minimum: 0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Input cost in USD when the provider reports it, else None",
            title: "Input Cost",
          },
          output_cost: {
            anyOf: [
              {
                minimum: 0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Output cost in USD when the provider reports it, else None",
            title: "Output Cost",
          },
          total_cost: {
            anyOf: [
              {
                minimum: 0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Total cost in USD when the provider reports it, else None",
            title: "Total Cost",
          },
          calls: {
            default: 0,
            description: "Number of LLM API calls",
            minimum: 0,
            title: "Calls",
            type: "integer",
          },
          priced_calls: {
            default: 0,
            description:
              "How many of `calls` reported a cost. Below `calls` means the cost fields are a lower bound.",
            minimum: 0,
            title: "Priced Calls",
            type: "integer",
          },
        },
        title: "Usage",
        type: "object",
      },
      evaluatorq__contracts__FunctionCall: {
        description: "Function call details in OpenAI tool call format.",
        properties: {
          name: {
            description: "Function name to call",
            title: "Name",
            type: "string",
          },
          arguments: {
            description: "JSON string of function arguments",
            title: "Arguments",
            type: "string",
          },
        },
        required: ["name", "arguments"],
        title: "FunctionCall",
        type: "object",
      },
      evaluatorq__openresponses__convert_models__FunctionCall: {
        description:
          "OpenResponses wire-format function call (Responses API spec) \u2014 distinct from contracts.FunctionCall (internal canonical, chat-completions shape: name/args only).",
        properties: {
          type: {
            const: "function_call",
            default: "function_call",
            description: "The type of the item. Always `function_call`.",
            title: "Type",
            type: "string",
          },
          id: {
            description: "The unique ID of the function call item.",
            title: "Id",
            type: "string",
          },
          call_id: {
            description:
              "The unique ID of the function tool call that was generated.",
            title: "Call Id",
            type: "string",
          },
          name: {
            description: "The name of the function that was called.",
            title: "Name",
            type: "string",
          },
          arguments: {
            description: "The arguments JSON string that was generated.",
            title: "Arguments",
            type: "string",
          },
          status: {
            $ref: "#/$defs/FunctionCallStatus",
            default: "completed",
          },
          result: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The result returned by the tool call, if available.",
            title: "Result",
          },
        },
        required: ["name", "arguments"],
        title: "FunctionCall",
        type: "object",
      },
    },
    additionalProperties: false,
    description:
      "What ``eq redteam run --config`` accepts, with the CLI's defaults.\n\nOne differs from `red_team`: ``verbosity`` is 1, a summary progress bar, because a terminal user is\nwatching. ``-v`` raises it, ``-q`` sets it to 0.",
    properties: {
      target: {
        anyOf: [
          {
            type: "string",
          },
          {
            items: {
              type: "string",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Target",
      },
      llm_config: {
        anyOf: [
          {
            $ref: "#/$defs/LLMConfig",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      mode: {
        anyOf: [
          {
            $ref: "#/$defs/Pipeline",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      categories: {
        anyOf: [
          {
            items: {
              type: "string",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Categories",
      },
      vulnerabilities: {
        anyOf: [
          {
            items: {
              type: "string",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Vulnerabilities",
      },
      strategies: {
        anyOf: [
          {
            items: {
              type: "string",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Strategies",
      },
      datapoints: {
        anyOf: [
          {
            items: {
              $ref: "#/$defs/DataPoint",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Datapoints",
      },
      attack_techniques: {
        anyOf: [
          {
            items: {
              anyOf: [
                {
                  $ref: "#/$defs/AttackTechnique",
                },
                {
                  type: "string",
                },
              ],
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Attack Techniques",
      },
      delivery_methods: {
        anyOf: [
          {
            items: {
              anyOf: [
                {
                  $ref: "#/$defs/DeliveryMethod",
                },
                {
                  type: "string",
                },
              ],
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Delivery Methods",
      },
      max_turns: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Max Turns",
      },
      max_per_category: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Max Per Category",
      },
      datapoint_parallelism: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Datapoint Parallelism",
      },
      parallelism: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Parallelism",
      },
      llm_parallelism: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Llm Parallelism",
      },
      generate_strategies: {
        default: true,
        title: "Generate Strategies",
        type: "boolean",
      },
      generated_strategy_count: {
        default: 2,
        title: "Generated Strategy Count",
        type: "integer",
      },
      max_dynamic_datapoints: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Max Dynamic Datapoints",
      },
      max_static_datapoints: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Max Static Datapoints",
      },
      cleanup_memory: {
        default: true,
        title: "Cleanup Memory",
        type: "boolean",
      },
      name: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Name",
      },
      description: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Description",
      },
      dataset: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Dataset",
      },
      previous_run: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Previous Run",
      },
      artifacts_dir: {
        anyOf: [
          {
            format: "path",
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Artifacts Dir",
      },
      target_config: {
        anyOf: [
          {
            $ref: "#/$defs/TargetConfig",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      recommendations: {
        anyOf: [
          {
            type: "boolean",
          },
          {
            $ref: "#/$defs/RedTeamRecommendationConfig",
          },
        ],
        default: true,
        title: "Recommendations",
      },
      generate_executive_summary: {
        default: true,
        title: "Generate Executive Summary",
        type: "boolean",
      },
      attacker_instructions: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Attacker Instructions",
      },
      verbosity: {
        default: 1,
        title: "Verbosity",
        type: "integer",
      },
      save: {
        $ref: "#/$defs/SaveMode",
        default: "final",
      },
    },
    title: "RedTeamCliConfig",
    type: "object",
  },
  RedTeamReport: {
    $defs: {
      AgentContext: {
        description:
          "Extended agent information for context-aware attacks.\n\nDescribes the target agent's configuration and capabilities.\n\nText fields carry one of three gates, applied by ``_normalize_text_fields``:\n\n* ``key`` \u2014 strict. Never coerced: it identifies *which* agent is under\n  attack, so a bad value must fail loudly rather than resolve to something\n  plausible.\n* ``system_prompt`` / ``instructions`` \u2014 always a ``str``, empty when not\n  supplied. These two are *mutually exclusive*: agents carry\n  ``instructions``, deployments carry ``system_prompt``, and a given target\n  fills one and leaves the other empty. Neither is ever ``None``, so\n  consumers can read them without a ``None`` guard; the empty one simply\n  falls through an ``instructions or system_prompt`` chain. Both empty is\n  also valid \u2014 a bring-your-own target we cannot introspect.\n* everything else \u2014 ``str | None``. Genuinely absent for some target kinds:\n  a direct/OpenAI target has no orq ``id`` or ``workspace_id``, a\n  bring-your-own ``AgentTarget`` has no ``display_name``/``description``/\n  ``model`` we can introspect.",
        properties: {
          key: {
            description: "Agent identifier key",
            title: "Key",
            type: "string",
          },
          id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Entity UUID (orq agent/deployment id), for deep-linking",
            title: "Id",
          },
          workspace_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Orq workspace id, for deep-linking",
            title: "Workspace Id",
          },
          target_kind: {
            anyOf: [
              {
                enum: ["agent", "deployment", "direct", "openai"],
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Target kind: 'agent' | 'deployment' | 'direct' | 'openai'. Gates the Studio deep-link.",
            title: "Target Kind",
          },
          display_name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Agent display name",
            title: "Display Name",
          },
          description: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Agent description",
            title: "Description",
          },
          system_prompt: {
            default: "",
            description:
              "Deployment system prompt; empty when not supplied. Exclusive with 'instructions'.",
            title: "System Prompt",
            type: "string",
          },
          instructions: {
            default: "",
            description:
              "Agent behavioral instructions; empty when not supplied. Exclusive with 'system_prompt'.",
            title: "Instructions",
            type: "string",
          },
          tools: {
            description: "Available tools",
            items: {
              $ref: "#/$defs/ToolInfo",
            },
            title: "Tools",
            type: "array",
          },
          memory_stores: {
            description: "Memory stores",
            items: {
              $ref: "#/$defs/MemoryStoreInfo",
            },
            title: "Memory Stores",
            type: "array",
          },
          knowledge_bases: {
            description: "Knowledge bases",
            items: {
              $ref: "#/$defs/KnowledgeBaseInfo",
            },
            title: "Knowledge Bases",
            type: "array",
          },
          model: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Primary model",
            title: "Model",
          },
          version: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Target configuration version at scan time, for reproducibility: results only describe the config that was attacked. None when the provider does not expose one.",
            title: "Version",
          },
          skills: {
            description:
              "Skill keys attached to the agent \u2014 a capability surface alongside tools",
            items: {
              type: "string",
            },
            title: "Skills",
            type: "array",
          },
          agent_type: {
            anyOf: [
              {
                enum: ["internal", "a2a"],
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Provider-declared agent type: 'a2a' agents delegate to other agents. Distinct from 'target_kind', which records how *we* reach the target. None when not exposed.",
            title: "Agent Type",
          },
          engine: {
            anyOf: [
              {
                enum: ["text", "jinja", "mustache"],
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Prompt template engine; a templated agent has a different injection surface than plain text",
            title: "Engine",
          },
          is_multi_agent: {
            default: false,
            description:
              "Whether the target orchestrates, delegates to, or hands off to other agents (a multi-agent system). Inferred during capability classification. Gates multi-agent-only attack categories (ASI07 Inter-Agent Communication, ASI08 Cascading Failures), which are skipped for single-agent targets. Defaults to False (conservative: do not run multi-agent attacks unless confirmed).",
            title: "Is Multi Agent",
            type: "boolean",
          },
        },
        required: ["key"],
        title: "AgentContext",
        type: "object",
      },
      AgentInfo: {
        description: "Target agent metadata.",
        properties: {
          key: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Key",
          },
          model: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Model",
          },
          display_name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Display Name",
          },
        },
        title: "AgentInfo",
        type: "object",
      },
      AgentResponse: {
        description:
          'Structured response from a target agent as an ordered list of output messages.\n\nEach item in ``output`` is a `TextOutputItem`, `ToolCallOutputItem`,\nor `ReasoningOutputItem`, preserving the order in which they were produced.\nItem ``type`` discriminators align with the OpenResponses intermediate data format\n(``output_text``, ``function_call``, ``reasoning``).\n\nAccessors:\n    ``.text``       \u2014 all ``TextOutputItem`` contents concatenated, or ``""`` if none\n    ``.tool_calls`` \u2014 list of `ToolCallOutputItem` filtered from\n    `output` in order\n    ``.refusal``    \u2014 the first provider refusal, when the response contains one',
        properties: {
          output: {
            items: {
              discriminator: {
                mapping: {
                  function_call:
                    "#/$defs/evaluatorq__openresponses__convert_models__FunctionCall",
                  output_text: "#/$defs/OutputTextContent",
                  reasoning: "#/$defs/ReasoningOutputItem",
                },
                propertyName: "type",
              },
              oneOf: [
                {
                  $ref: "#/$defs/OutputTextContent",
                },
                {
                  $ref: "#/$defs/evaluatorq__openresponses__convert_models__FunctionCall",
                },
                {
                  $ref: "#/$defs/ReasoningOutputItem",
                },
              ],
            },
            title: "Output",
            type: "array",
          },
          usage: {
            anyOf: [
              {
                $ref: "#/$defs/Usage",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          model: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Model",
          },
          response_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Response Id",
          },
          trace_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Trace Id",
          },
          span_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Span Id",
          },
          finish_reason: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Finish Reason",
          },
          refusal: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Refusal",
          },
          error: {
            anyOf: [
              {
                $ref: "#/$defs/AgentResponseError",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
        },
        title: "AgentResponse",
        type: "object",
      },
      AgentResponseError: {
        description:
          'A per-response error marker on `AgentResponse`.\n\nSet when a target (or simulation agent) failed to produce a real response,\ne.g. a timeout or backend exception. The orchestrator uses its presence to\nexclude the turn from the transcript replayed to the target. ``message`` is\nthe same human text surfaced in ``AgentResponse.text``; ``code`` is an\noptional provider/mapped code.\n\n``error_type`` is a coarse, open-vocabulary string \u2014 consumers key off the\nerror\'s *presence*, not its value, so the field is intentionally not an\nenum. The orchestrator sets ``"timeout"`` on the timeout path and otherwise\nclassifies the failure via\n`evaluatorq.common.target_call.classify_error_type`, which yields one\nof ``content_filter``, ``rate_limit``, ``timeout``, ``network_error``,\n``server_error``, ``client_error``, or ``target_error`` (fallback for an\nunmatched error). Other producers may set their own values.\n\nThis is the leaf, per-response error. The whole-run rollup is\n`evaluatorq.redteam.contracts.RunError`.',
        properties: {
          message: {
            title: "Message",
            type: "string",
          },
          error_type: {
            title: "Error Type",
            type: "string",
          },
          code: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Code",
          },
        },
        required: ["message", "error_type"],
        title: "AgentResponseError",
        type: "object",
      },
      AttackInfo: {
        description:
          "Unified attack metadata.\n\nSuperset of static RedTeamInput and dynamic AttackStrategy fields.",
        properties: {
          id: {
            description:
              "Unique identifier (e.g., 'OWASP-ASI01-0153' or 'ASI01-role_confusion-001')",
            title: "Id",
            type: "string",
          },
          vulnerability: {
            default: "",
            description: "Vulnerability identifier (primary key in new format)",
            title: "Vulnerability",
            type: "string",
          },
          category: {
            description:
              "Short-form category code (e.g., 'ASI01', 'LLM01') \u2014 kept for backwards compat",
            title: "Category",
            type: "string",
          },
          framework: {
            $ref: "#/$defs/Framework",
            description: "OWASP framework ('OWASP-ASI' or 'OWASP-LLM')",
          },
          attack_technique: {
            $ref: "#/$defs/AttackTechnique",
          },
          delivery_methods: {
            description:
              "Delivery methods (always a list). Open set: known values are DeliveryMethod members, custom dataset values are kept as raw strings.",
            items: {
              anyOf: [
                {
                  $ref: "#/$defs/DeliveryMethod",
                },
                {
                  type: "string",
                },
              ],
            },
            title: "Delivery Methods",
            type: "array",
          },
          turn_type: {
            $ref: "#/$defs/TurnType",
          },
          severity: {
            $ref: "#/$defs/Severity",
          },
          vulnerability_domain: {
            anyOf: [
              {
                $ref: "#/$defs/VulnerabilityDomain",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Vulnerability domain (null for dynamic attacks without a fixed domain)",
          },
          source: {
            description:
              "Origin: 'AgentDojo', 'orq_generated', 'orq_dataset', 'template_dynamic', 'generated_dynamic'",
            title: "Source",
            type: "string",
          },
          strategy_name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Dynamic strategy name (e.g., 'tool_output_hijack')",
            title: "Strategy Name",
          },
          objective: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Filled objective template (dynamic only)",
            title: "Objective",
          },
          evaluator_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Evaluator Id",
          },
          evaluator_name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Evaluator Name",
          },
          additional_metadata: {
            anyOf: [
              {
                additionalProperties: true,
                type: "object",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Additional Metadata",
          },
        },
        required: [
          "id",
          "category",
          "framework",
          "attack_technique",
          "delivery_methods",
          "turn_type",
          "severity",
          "source",
        ],
        title: "AttackInfo",
        type: "object",
      },
      AttackTechnique: {
        description:
          "Known attack techniques used in red teaming attacks.\n\nThis enum tracks *known* techniques for internal validation and reporting.\nExternal datasets may contain additional values \u2014 use\n`is_known_attack_technique` to check membership without failing.",
        enum: [
          "indirect-injection",
          "direct-injection",
          "DAN",
          "autodan",
          "developer-mode",
          "credential-caching",
          "privilege-escalation",
          "confused-deputy",
          "excessive-agency",
          "plugin-abuse",
          "rce-exploit",
          "supply-chain",
          "resource-exhaustion",
          "message-spoofing",
          "social-engineering",
          "emotional-manipulation",
          "payload-splitting",
          "alternative-encoding",
          "unicode-obfuscation",
          "model-extraction",
          "pii-extraction",
          "pii-input",
          "system-prompt-extraction",
          "tool-abuse",
          "context-poisoning",
          "cascade-trigger",
          "boundary-violation",
        ],
        title: "AttackTechnique",
        type: "string",
      },
      CategorySummary: {
        description: "Per-category summary statistics.",
        properties: {
          category: {
            title: "Category",
            type: "string",
          },
          category_name: {
            title: "Category Name",
            type: "string",
          },
          total_attacks: {
            title: "Total Attacks",
            type: "integer",
          },
          evaluated_attacks: {
            default: 0,
            title: "Evaluated Attacks",
            type: "integer",
          },
          unevaluated_attacks: {
            default: 0,
            title: "Unevaluated Attacks",
            type: "integer",
          },
          evaluation_coverage: {
            default: 0.0,
            maximum: 1.0,
            minimum: 0.0,
            title: "Evaluation Coverage",
            type: "number",
          },
          total_conversations: {
            default: 0,
            title: "Total Conversations",
            type: "integer",
          },
          total_turns: {
            default: 0,
            title: "Total Turns",
            type: "integer",
          },
          vulnerabilities_found: {
            title: "Vulnerabilities Found",
            type: "integer",
          },
          vulnerability_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Vulnerability Rate",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          total_errors: {
            default: 0,
            title: "Total Errors",
            type: "integer",
          },
          strategies_used: {
            items: {
              type: "string",
            },
            title: "Strategies Used",
            type: "array",
          },
        },
        required: [
          "category",
          "category_name",
          "total_attacks",
          "vulnerabilities_found",
        ],
        title: "CategorySummary",
        type: "object",
      },
      DeliveryMethod: {
        description:
          "Known jailbreak and delivery techniques.\n\nSee `AttackTechnique` \u2014 the same open-set policy applies.",
        enum: [
          "DAN",
          "role-play",
          "skeleton-key",
          "base64",
          "leetspeak",
          "multilingual",
          "character-spacing",
          "crescendo",
          "many-shot",
          "authority-impersonation",
          "refusal-suppression",
          "direct-request",
          "code-elicitation",
          "code-assistance",
          "tool-response",
          "word-substitution",
        ],
        title: "DeliveryMethod",
        type: "string",
      },
      DeliveryMethodSummary: {
        description: "Per-delivery-method summary statistics.",
        properties: {
          total_attacks: {
            default: 0,
            title: "Total Attacks",
            type: "integer",
          },
          vulnerabilities_found: {
            default: 0,
            title: "Vulnerabilities Found",
            type: "integer",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          vulnerability_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Vulnerability Rate",
          },
        },
        title: "DeliveryMethodSummary",
        type: "object",
      },
      DomainSummary: {
        description: "Per-domain (agent / model / data) summary statistics.",
        properties: {
          total_attacks: {
            default: 0,
            title: "Total Attacks",
            type: "integer",
          },
          vulnerabilities_found: {
            default: 0,
            title: "Vulnerabilities Found",
            type: "integer",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          vulnerability_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Vulnerability Rate",
          },
        },
        title: "DomainSummary",
        type: "object",
      },
      ExecutionDetails: {
        description: "Execution metadata (dynamic pipeline only).",
        properties: {
          turns: {
            default: 1,
            title: "Turns",
            type: "integer",
          },
          max_turns: {
            anyOf: [
              {
                type: "integer",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Max Turns",
          },
          duration_seconds: {
            anyOf: [
              {
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Duration Seconds",
          },
          objective_achieved: {
            anyOf: [
              {
                type: "boolean",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Adversarial LLM self-report (multi-turn)",
            title: "Objective Achieved",
          },
          objective_rationale: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Attacker's self-reported reason (multi-turn); signal only, never scored",
            title: "Objective Rationale",
          },
          token_usage: {
            anyOf: [
              {
                $ref: "#/$defs/Usage",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          token_usage_bootstrap: {
            anyOf: [
              {
                $ref: "#/$defs/Usage",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          seed_context: {
            items: {
              $ref: "#/$defs/Message",
            },
            title: "Seed Context",
            type: "array",
          },
          backtracked_turns: {
            description:
              "Refused exchanges erased from the target conversation; never part of the judged transcript",
            items: {
              $ref: "#/$defs/Turn",
            },
            title: "Backtracked Turns",
            type: "array",
          },
          refusal_judge_failures: {
            default: 0,
            description:
              "Turns the refusal judge could not label; they were kept without knowing whether they were refused",
            title: "Refusal Judge Failures",
            type: "integer",
          },
        },
        title: "ExecutionDetails",
        type: "object",
      },
      FocusAreaRecommendation: {
        description:
          "LLM-generated actionable recommendation for a focus area.",
        properties: {
          category: {
            description: "OWASP category code (e.g. ASI01, LLM07)",
            title: "Category",
            type: "string",
          },
          category_name: {
            description: "Human-readable category name",
            title: "Category Name",
            type: "string",
          },
          risk_score: {
            description: "Risk score used for ranking",
            title: "Risk Score",
            type: "number",
          },
          traces_analyzed: {
            description: "Number of failed traces analyzed",
            title: "Traces Analyzed",
            type: "integer",
          },
          recommendations: {
            description: "Actionable bullet-point recommendations",
            items: {
              type: "string",
            },
            title: "Recommendations",
            type: "array",
          },
          patterns_observed: {
            description: "Brief summary of patterns the LLM spotted in traces",
            title: "Patterns Observed",
            type: "string",
          },
        },
        required: [
          "category",
          "category_name",
          "risk_score",
          "traces_analyzed",
          "recommendations",
          "patterns_observed",
        ],
        title: "FocusAreaRecommendation",
        type: "object",
      },
      Framework: {
        description:
          "Supported framework identifiers for datasets and reports.",
        enum: [
          "OWASP-LLM",
          "OWASP-ASI",
          "OWASP-AGENTIC",
          "CONTENT",
          "LIABILITY",
          "FAIRNESS",
          "GDPR",
          "AI-ACT",
        ],
        title: "Framework",
        type: "string",
      },
      FrameworkSummary: {
        description:
          "Per-framework summary statistics (useful for mixed reports).",
        properties: {
          total_attacks: {
            default: 0,
            title: "Total Attacks",
            type: "integer",
          },
          vulnerabilities_found: {
            default: 0,
            title: "Vulnerabilities Found",
            type: "integer",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          vulnerability_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Vulnerability Rate",
          },
        },
        title: "FrameworkSummary",
        type: "object",
      },
      FunctionCallStatus: {
        description: "Status for function calls and function call outputs.",
        enum: ["in_progress", "completed", "incomplete"],
        title: "FunctionCallStatus",
        type: "string",
      },
      InputFileContent: {
        additionalProperties: true,
        type: "object",
      },
      InputImageContent: {
        additionalProperties: true,
        type: "object",
      },
      InputTextContent: {
        properties: {
          type: {
            const: "input_text",
            description: "The type of the input item. Always `input_text`.",
            title: "Type",
            type: "string",
          },
          text: {
            description: "The text input to the model.",
            title: "Text",
            type: "string",
          },
        },
        required: ["type", "text"],
        title: "InputTextContent",
        type: "object",
      },
      JuryHealth: {
        description:
          "Run-level panel-of-judges operational health across multi-judge samples (RES-1649).\n\nComplements ``JuryReliability`` (how much the judges agreed) with how well the\npanel actually ran: how often a configured judge failed, a replacement stood in,\nthe decisive votes tied, the panel went inconclusive, a judge's repetitions\nproduced no usable verdict, or a judge cleanly abstained. Counts are over samples\nthat carried a multi-judge jury (``judges_configured >= 2``). ``None`` for\nsingle-judge runs, so the field stays absent on the common path.",
        properties: {
          samples: {
            description: "Multi-judge samples considered",
            minimum: 0,
            title: "Samples",
            type: "integer",
          },
          samples_with_judge_failure: {
            default: 0,
            description:
              "Samples where at least one configured judge failed mechanically",
            minimum: 0,
            title: "Samples With Judge Failure",
            type: "integer",
          },
          replacements_used: {
            default: 0,
            description: "Total replacement judges invoked across samples",
            minimum: 0,
            title: "Replacements Used",
            type: "integer",
          },
          ties: {
            default: 0,
            description: "Samples where the decisive votes tied",
            minimum: 0,
            title: "Ties",
            type: "integer",
          },
          inconclusive: {
            default: 0,
            description: "Samples with too few decisive judges to conclude",
            minimum: 0,
            title: "Inconclusive",
            type: "integer",
          },
          samples_with_repetition_failure: {
            default: 0,
            description:
              "Samples where at least one judge had a repetition fail to produce a usable verdict",
            minimum: 0,
            title: "Samples With Repetition Failure",
            type: "integer",
          },
          samples_with_abstention: {
            default: 0,
            description: "Samples where at least one judge cleanly abstained",
            minimum: 0,
            title: "Samples With Abstention",
            type: "integer",
          },
          judge_failure_reasons: {
            description:
              "Complete, scrubbed, distinct JuryVote.error strings behind failed configured or replacement judges. Sorted and deduplicated after secret scrubbing; display limits apply only in issue_summary().",
            items: {
              type: "string",
            },
            title: "Judge Failure Reasons",
            type: "array",
          },
        },
        required: ["samples"],
        title: "JuryHealth",
        type: "object",
      },
      JuryReliability: {
        description:
          "Run-level inter-judge reliability for panel-of-judges runs (RES-739).\n\nUnlike per-sample ``raw_agreement`` (which cannot tell real consensus from\nchance), this is a chance-corrected statistic across all multi-judge samples:\nKrippendorff's alpha on the nominal RESISTANT/VULNERABLE verdicts. Alpha\ntolerates judges that failed on *some* samples (variable ratings per unit), so\na sample where only some of the panel responded still contributes \u2014 provided\nat least two verdicts remain. Samples that drop below two verdicts form no\nrateable pair and are excluded (the ``samples`` count reflects what actually\ncontributed). 1.0 = perfect agreement, ~0 = chance-level, < 0 = systematic\ndisagreement. ``None`` when undefined (every verdict identical, or fewer than\ntwo multi-judge samples).",
        properties: {
          krippendorff_alpha: {
            anyOf: [
              {
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Chance-corrected inter-judge agreement (nominal Krippendorff alpha); None if undefined",
            title: "Krippendorff Alpha",
          },
          samples: {
            default: 0,
            description: "Multi-judge samples (>=2 verdicts) that contributed",
            minimum: 0,
            title: "Samples",
            type: "integer",
          },
          method: {
            $ref: "#/$defs/ReliabilityMethod",
            default: "krippendorff_alpha_nominal",
            description: "Reliability coefficient used",
          },
        },
        title: "JuryReliability",
        type: "object",
      },
      JuryRepetition: {
        description:
          "One raw pass of one judge, before that judge's passes collapse into a vote.\n\n``value`` is ``None`` for a pass that produced no usable verdict \u2014 a genuine\nabstention, an error, or an off-contract value; ``JuryVote.repetitions_failed``\nsays how many of those were failures rather than clean abstentions.\n``explanation`` is that pass's own reasoning, ``None`` when it produced no text.",
        properties: {
          value: {
            anyOf: [
              {
                type: "boolean",
              },
              {
                type: "number",
              },
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Verdict for this pass; None = abstained or failed",
            title: "Value",
          },
          explanation: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "This pass's own reasoning; None when it produced no text",
            title: "Explanation",
          },
          raw_output: {
            anyOf: [
              {
                additionalProperties: true,
                type: "object",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Validated structured judge output for this pass; None when the judge exposes no structured detail.",
            title: "Raw Output",
          },
        },
        title: "JuryRepetition",
        type: "object",
      },
      JuryResult: {
        description: "Aggregated panel-of-judges result.",
        properties: {
          judges_configured: {
            description: "Number of configured non-replacement judges",
            minimum: 0,
            title: "Judges Configured",
            type: "integer",
          },
          judges_succeeded: {
            description:
              "Number of judges that produced a decisive non-abstain verdict",
            minimum: 0,
            title: "Judges Succeeded",
            type: "integer",
          },
          judges_failed: {
            description:
              "Number of configured judges that failed mechanically. Replacement-vote outcomes are stored in votes.",
            minimum: 0,
            title: "Judges Failed",
            type: "integer",
          },
          replacements_used: {
            default: 0,
            description: "Number of replacement judges invoked",
            minimum: 0,
            title: "Replacements Used",
            type: "integer",
          },
          tie: {
            default: false,
            description:
              "True when decisive votes tied and a caller tie policy was applied",
            title: "Tie",
            type: "boolean",
          },
          inconclusive: {
            default: false,
            description:
              "True when too few decisive judges produced a verdict; stats/raw_agreement are None",
            title: "Inconclusive",
            type: "boolean",
          },
          votes: {
            description: "Per-judge votes",
            items: {
              $ref: "#/$defs/JuryVote",
            },
            title: "Votes",
            type: "array",
          },
          stats: {
            anyOf: [
              {
                $ref: "#/$defs/JuryStats",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Verdict distribution; None when inconclusive",
          },
          raw_agreement: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Raw fraction of decisive judges in the largest verdict bloc; None when inconclusive",
            title: "Raw Agreement",
          },
        },
        required: ["judges_configured", "judges_succeeded", "judges_failed"],
        title: "JuryResult",
        type: "object",
      },
      JuryStats: {
        description: "Distribution statistics for judge verdicts.",
        properties: {
          mean: {
            description: "Mean judge verdict value",
            title: "Mean",
            type: "number",
          },
          std: {
            description:
              "Population standard deviation of judge verdict values",
            minimum: 0.0,
            title: "Std",
            type: "number",
          },
        },
        required: ["mean", "std"],
        title: "JuryStats",
        type: "object",
      },
      JuryVote: {
        description:
          "A single judge's aggregate vote within a jury.\n\n``abstained`` is a first-class successful non-verdict: the judge returned\ncleanly but declined to choose a label. It is distinct from ``success=False``\nfailures and is excluded from decisive tallies.",
        properties: {
          model: {
            description: "Judge model ID",
            title: "Model",
            type: "string",
          },
          replacement: {
            default: false,
            description:
              "True if this judge stood in for a failed configured judge",
            title: "Replacement",
            type: "boolean",
          },
          success: {
            description:
              "True if the judge completed without a mechanical failure",
            title: "Success",
            type: "boolean",
          },
          abstained: {
            default: false,
            description:
              "True when the judge explicitly declined to choose a verdict",
            title: "Abstained",
            type: "boolean",
          },
          value: {
            anyOf: [
              {
                type: "boolean",
              },
              {
                type: "number",
              },
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Judge verdict",
            title: "Value",
          },
          explanation: {
            default: "",
            description: "Explanation from a representative pass",
            title: "Explanation",
            type: "string",
          },
          error: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Failure reason when success is False",
            title: "Error",
          },
          repetitions: {
            description:
              "Raw per-repetition passes in call order, each carrying that pass's own verdict and reasoning. Empty on a vote built without per-repetition capture.",
            items: {
              $ref: "#/$defs/JuryRepetition",
            },
            title: "Repetitions",
            type: "array",
          },
          repetitions_failed: {
            default: 0,
            description:
              "Count of repetitions that failed to produce a usable verdict: an error or a non-decisive, non-abstained pass (RES-1251). A clean abstention is not counted. Independent of the aggregate success/abstained.",
            minimum: 0,
            title: "Repetitions Failed",
            type: "integer",
          },
        },
        required: ["model", "success"],
        title: "JuryVote",
        type: "object",
      },
      KnowledgeBaseInfo: {
        description: "Information about an agent's knowledge base.",
        properties: {
          id: {
            description: "Knowledge base ID",
            title: "Id",
            type: "string",
          },
          key: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Knowledge base key/slug",
            title: "Key",
          },
          name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Knowledge base name",
            title: "Name",
          },
          description: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Knowledge base description",
            title: "Description",
          },
        },
        required: ["id"],
        title: "KnowledgeBaseInfo",
        type: "object",
      },
      LogProb: {
        properties: {
          token: {
            title: "Token",
            type: "string",
          },
          logprob: {
            title: "Logprob",
            type: "number",
          },
          bytes: {
            items: {
              type: "integer",
            },
            title: "Bytes",
            type: "array",
          },
          top_logprobs: {
            items: {
              $ref: "#/$defs/TopLogProb",
            },
            title: "Top Logprobs",
            type: "array",
          },
        },
        required: ["token", "logprob", "bytes", "top_logprobs"],
        title: "LogProb",
        type: "object",
      },
      MemoryStoreInfo: {
        description: "Information about an agent's memory store.",
        properties: {
          id: {
            description: "Memory store ID",
            title: "Id",
            type: "string",
          },
          key: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Memory store key/slug",
            title: "Key",
          },
          description: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Memory store description",
            title: "Description",
          },
        },
        required: ["id"],
        title: "MemoryStoreInfo",
        type: "object",
      },
      Message: {
        description:
          'Single message in conversation history (OpenAI format with tool support).\n\nSupports both simple messages and tool calls:\n- Simple: ``{"role": "user", "content": "Hello"}``\n- Tool call: ``{"role": "assistant", "tool_calls": [...]}``\n- Tool response: ``{"role": "tool", "tool_call_id": "...", "name": "...", "content": "..."}``',
        properties: {
          role: {
            enum: ["user", "assistant", "tool", "system", "developer"],
            title: "Role",
            type: "string",
          },
          content: {
            anyOf: [
              {
                type: "string",
              },
              {
                items: {
                  discriminator: {
                    mapping: {
                      input_file: "#/$defs/InputFileContent",
                      input_image: "#/$defs/InputImageContent",
                      input_text: "#/$defs/InputTextContent",
                    },
                    propertyName: "type",
                  },
                  oneOf: [
                    {
                      $ref: "#/$defs/InputTextContent",
                    },
                    {
                      $ref: "#/$defs/InputImageContent",
                    },
                    {
                      $ref: "#/$defs/InputFileContent",
                    },
                  ],
                },
                type: "array",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Message content. A plain string, or a list of multi-modal content parts (text/image/file). Required for user/system, optional for assistant with tool_calls.",
            title: "Content",
          },
          tool_calls: {
            anyOf: [
              {
                items: {
                  $ref: "#/$defs/StrategyToolCall",
                },
                type: "array",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Tool calls made by assistant",
            title: "Tool Calls",
          },
          tool_call_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "ID linking tool response to call (for role=tool)",
            title: "Tool Call Id",
          },
          name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Function name (for role=tool)",
            title: "Name",
          },
        },
        required: ["role"],
        title: "Message",
        type: "object",
      },
      OutputTextContent: {
        properties: {
          type: {
            const: "output_text",
            default: "output_text",
            description: "The type of the output text. Always `output_text`.",
            title: "Type",
            type: "string",
          },
          text: {
            description: "The text output from the model.",
            title: "Text",
            type: "string",
          },
          annotations: {
            description: "The annotations of the text output.",
            items: {
              $ref: "#/$defs/UrlCitationBody",
            },
            title: "Annotations",
            type: "array",
          },
          logprobs: {
            items: {
              $ref: "#/$defs/LogProb",
            },
            title: "Logprobs",
            type: "array",
          },
        },
        required: ["text"],
        title: "OutputTextContent",
        type: "object",
      },
      Pipeline: {
        description: "Supported unified report pipeline identifiers.",
        enum: ["static", "dynamic", "hybrid"],
        title: "Pipeline",
        type: "string",
      },
      ReasoningOutputItem: {
        description:
          "A reasoning / thinking step in the agent output message list.\n\nCaptures chain-of-thought or intermediate reasoning produced by the model\n(e.g. OpenAI o-series extended thinking, or agent intermediate steps).\nAligns with the OpenResponses ``reasoning`` item type.",
        properties: {
          type: {
            const: "reasoning",
            default: "reasoning",
            title: "Type",
            type: "string",
          },
          text: {
            title: "Text",
            type: "string",
          },
          id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Id",
          },
        },
        required: ["text"],
        title: "ReasoningOutputItem",
        type: "object",
      },
      RedTeamResult: {
        description: "Single unified result item from either pipeline.",
        properties: {
          attack: {
            $ref: "#/$defs/AttackInfo",
          },
          agent: {
            $ref: "#/$defs/AgentInfo",
          },
          messages: {
            description: "OpenAI-format conversation",
            items: {
              $ref: "#/$defs/Message",
            },
            title: "Messages",
            type: "array",
          },
          response: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Response",
          },
          evaluation: {
            anyOf: [
              {
                $ref: "#/$defs/UnifiedEvaluationResult",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          vulnerable: {
            anyOf: [
              {
                type: "boolean",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'True if the attack succeeded, False if the target resisted, None if the attack could not be evaluated (target or judge call failed). None is not "resistant" \u2014 never treat it as a passing result.',
            title: "Vulnerable",
          },
          execution: {
            anyOf: [
              {
                $ref: "#/$defs/ExecutionDetails",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Null for static pipeline",
          },
          token_usage_bootstrap: {
            anyOf: [
              {
                $ref: "#/$defs/Usage",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          seed_context: {
            items: {
              $ref: "#/$defs/Message",
            },
            title: "Seed Context",
            type: "array",
          },
          evaluation_error: {
            anyOf: [
              {
                $ref: "#/$defs/RunError",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Why the judge could not return a verdict, when it could not. Deliberately separate from ``error``, which means the attack itself failed to run: here the attack ran and the transcript exists, so collapsing the two would make an unscored result look like an execution failure. Always accompanies vulnerable=None.",
          },
          error: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Error",
          },
          error_type: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Error Type",
          },
          error_stage: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Error Stage",
          },
          error_code: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Error Code",
          },
          error_details: {
            anyOf: [
              {
                additionalProperties: true,
                type: "object",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Error Details",
          },
          thread_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Orq observability thread id ({run_id}:{agent_key}:{index}); None for older reports.",
            title: "Thread Id",
          },
          response_traces: {
            description:
              "Per-turn Orq trace/span handles for each successful target-agent response in this attack (excludes attacker/generator and judge calls), in turn order. Empty for non-Orq targets, the static pipeline, and older reports.",
            items: {
              $ref: "#/$defs/ResponseTrace",
            },
            title: "Response Traces",
            type: "array",
          },
        },
        required: ["attack", "agent", "messages"],
        title: "RedTeamResult",
        type: "object",
      },
      ReliabilityMethod: {
        description:
          "Closed set of supported inter-judge reliability coefficient methods.",
        enum: ["krippendorff_alpha_nominal"],
        title: "ReliabilityMethod",
        type: "string",
      },
      ReportSummary: {
        description: "Aggregate summary statistics for a report.",
        properties: {
          total_attacks: {
            default: 0,
            title: "Total Attacks",
            type: "integer",
          },
          evaluated_attacks: {
            default: 0,
            title: "Evaluated Attacks",
            type: "integer",
          },
          unevaluated_attacks: {
            default: 0,
            title: "Unevaluated Attacks",
            type: "integer",
          },
          evaluation_coverage: {
            default: 0.0,
            maximum: 1.0,
            minimum: 0.0,
            title: "Evaluation Coverage",
            type: "number",
          },
          total_conversations: {
            default: 0,
            title: "Total Conversations",
            type: "integer",
          },
          total_turns: {
            default: 0,
            title: "Total Turns",
            type: "integer",
          },
          average_turns_per_attack: {
            default: 0.0,
            title: "Average Turns Per Attack",
            type: "number",
          },
          vulnerabilities_found: {
            default: 0,
            title: "Vulnerabilities Found",
            type: "integer",
          },
          vulnerability_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Vulnerability Rate",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          total_errors: {
            default: 0,
            title: "Total Errors",
            type: "integer",
          },
          pre_execution_errors: {
            default: 0,
            description: "Rows that failed before an attack job could execute",
            title: "Pre Execution Errors",
            type: "integer",
          },
          errors_by_type: {
            additionalProperties: {
              type: "integer",
            },
            description: "Error counts grouped by type",
            title: "Errors By Type",
            type: "object",
          },
          token_usage_total: {
            anyOf: [
              {
                $ref: "#/$defs/Usage",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Aggregated token usage across all attack results plus post_processing_token_usage (recommendation generation and the executive-summary narrative), when either ran and billed usage.",
          },
          token_usage_by_source: {
            additionalProperties: {
              $ref: "#/$defs/Usage",
            },
            description:
              "Token usage grouped by datapoint source (static/template_dynamic/generated_dynamic); sums to the attack-result portion of token_usage_total, i.e. token_usage_total minus post_processing_token_usage.",
            title: "Token Usage By Source",
            type: "object",
          },
          post_processing_token_usage: {
            anyOf: [
              {
                $ref: "#/$defs/Usage",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Token usage billed after attack execution: the focus-area recommendation phase (condense + per-area calls) and the executive-summary narrative. None if neither ran or neither billed usage. Already folded into token_usage_total.",
          },
          by_vulnerability: {
            additionalProperties: {
              $ref: "#/$defs/VulnerabilitySummary",
            },
            title: "By Vulnerability",
            type: "object",
          },
          by_category: {
            additionalProperties: {
              $ref: "#/$defs/CategorySummary",
            },
            title: "By Category",
            type: "object",
          },
          by_technique: {
            additionalProperties: {
              $ref: "#/$defs/TechniqueSummary",
            },
            title: "By Technique",
            type: "object",
          },
          by_severity: {
            additionalProperties: {
              $ref: "#/$defs/SeveritySummary",
            },
            title: "By Severity",
            type: "object",
          },
          by_delivery_method: {
            additionalProperties: {
              $ref: "#/$defs/DeliveryMethodSummary",
            },
            title: "By Delivery Method",
            type: "object",
          },
          by_turn_type: {
            additionalProperties: {
              $ref: "#/$defs/TurnTypeSummary",
            },
            title: "By Turn Type",
            type: "object",
          },
          by_domain: {
            additionalProperties: {
              $ref: "#/$defs/DomainSummary",
            },
            title: "By Domain",
            type: "object",
          },
          by_framework: {
            additionalProperties: {
              $ref: "#/$defs/FrameworkSummary",
            },
            title: "By Framework",
            type: "object",
          },
          jury_reliability: {
            anyOf: [
              {
                $ref: "#/$defs/JuryReliability",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Chance-corrected inter-judge reliability across panel-of-judges samples (RES-739). None for single-judge runs.",
          },
          jury_health: {
            anyOf: [
              {
                $ref: "#/$defs/JuryHealth",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Panel-of-judges operational health across multi-judge samples (RES-1649): judge failures, replacements, ties, inconclusive panels, repetition failures, abstentions. None for single-judge runs.",
          },
          datapoint_breakdown: {
            anyOf: [
              {
                additionalProperties: {
                  type: "integer",
                },
                type: "object",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Datapoint counts by source: static, template_dynamic, generated_dynamic (hybrid runs only)",
            title: "Datapoint Breakdown",
          },
          min_evaluation_coverage: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "The coverage floor that was in effect for this run, copied from EvaluatorConfig so the report is self-describing \u2014 a saved run records the policy it was judged against. None when no gate was configured.",
            title: "Min Evaluation Coverage",
          },
        },
        title: "ReportSummary",
        type: "object",
      },
      ResponseTrace: {
        description:
          "Orq observability handles for one target-agent response.\n\nPersisted per successful response so a conversation/attack retains the exact\ntrace (and span) of every target turn; the dashboard links to the last one.\nEither field may be None when the target isn't routed through Orq.",
        properties: {
          trace_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Trace Id",
          },
          span_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Span Id",
          },
        },
        title: "ResponseTrace",
        type: "object",
      },
      RunError: {
        description:
          "Structured whole-run error for an attack/evaluation result (the rollup; per-response errors use `evaluatorq.contracts.AgentResponseError`).",
        properties: {
          message: {
            title: "Message",
            type: "string",
          },
          error_type: {
            title: "Error Type",
            type: "string",
          },
          stage: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Stage",
          },
          code: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Code",
          },
          details: {
            anyOf: [
              {
                additionalProperties: true,
                type: "object",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Details",
          },
          turn: {
            anyOf: [
              {
                type: "integer",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Turn",
          },
        },
        required: ["message", "error_type"],
        title: "RunError",
        type: "object",
      },
      Severity: {
        description: "Attack severity levels.",
        enum: ["low", "medium", "high", "critical"],
        title: "Severity",
        type: "string",
      },
      SeveritySummary: {
        description: "Per-severity summary statistics.",
        properties: {
          total_attacks: {
            default: 0,
            title: "Total Attacks",
            type: "integer",
          },
          vulnerabilities_found: {
            default: 0,
            title: "Vulnerabilities Found",
            type: "integer",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          vulnerability_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Vulnerability Rate",
          },
        },
        title: "SeveritySummary",
        type: "object",
      },
      StrategyToolCall: {
        description: "Tool call in assistant message (OpenAI format).",
        properties: {
          id: {
            description: "Unique tool call ID (e.g., call_abc123)",
            title: "Id",
            type: "string",
          },
          type: {
            const: "function",
            default: "function",
            description: "Tool type",
            title: "Type",
            type: "string",
          },
          function: {
            $ref: "#/$defs/evaluatorq__contracts__FunctionCall",
            description: "Function call details",
          },
          item_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Responses-API function_call item id (fc_*)",
            title: "Item Id",
          },
          incomplete: {
            default: false,
            description:
              "The recorded fact that this call has no result. Judge text and exports mark it from this flag; provider replay does not trust it and pairs by position instead (`common.messages.pair_tool_rows`).",
            title: "Incomplete",
            type: "boolean",
          },
        },
        required: ["id", "function"],
        title: "StrategyToolCall",
        type: "object",
      },
      TechniqueSummary: {
        description: "Per-technique summary statistics.",
        properties: {
          total_attacks: {
            default: 0,
            title: "Total Attacks",
            type: "integer",
          },
          vulnerabilities_found: {
            default: 0,
            title: "Vulnerabilities Found",
            type: "integer",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          vulnerability_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Vulnerability Rate",
          },
        },
        title: "TechniqueSummary",
        type: "object",
      },
      ToolInfo: {
        description: "Information about an agent's tool.",
        properties: {
          name: {
            description: "Tool name/identifier",
            title: "Name",
            type: "string",
          },
          description: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Tool description",
            title: "Description",
          },
          parameters: {
            anyOf: [
              {
                additionalProperties: true,
                type: "object",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Tool parameter schema",
            title: "Parameters",
          },
          action_type: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Tool action type (e.g. function, http, mcp)",
            title: "Action Type",
          },
        },
        required: ["name"],
        title: "ToolInfo",
        type: "object",
      },
      TopLogProb: {
        properties: {
          token: {
            title: "Token",
            type: "string",
          },
          logprob: {
            title: "Logprob",
            type: "number",
          },
          bytes: {
            items: {
              type: "integer",
            },
            title: "Bytes",
            type: "array",
          },
        },
        required: ["token", "logprob", "bytes"],
        title: "TopLogProb",
        type: "object",
      },
      Turn: {
        description:
          "One attacker\u2192target exchange in a multi-turn attack.\n\nBoth sides are `evaluatorq.contracts.AgentResponse` (RES-883). The\nattacker's prompt is ``attacker.text``; ``attacker.finish_reason == 'length'``\nmeans the adversarial LLM was truncated.",
        properties: {
          attacker: {
            $ref: "#/$defs/AgentResponse",
          },
          target: {
            $ref: "#/$defs/AgentResponse",
          },
        },
        required: ["attacker", "target"],
        title: "Turn",
        type: "object",
      },
      TurnType: {
        description: "Conversation turn type.",
        enum: ["single", "multi"],
        title: "TurnType",
        type: "string",
      },
      TurnTypeSummary: {
        description: "Per-turn-type (single vs multi) summary statistics.",
        properties: {
          total_attacks: {
            default: 0,
            title: "Total Attacks",
            type: "integer",
          },
          vulnerabilities_found: {
            default: 0,
            title: "Vulnerabilities Found",
            type: "integer",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          vulnerability_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Vulnerability Rate",
          },
          average_turns: {
            default: 0.0,
            title: "Average Turns",
            type: "number",
          },
        },
        title: "TurnTypeSummary",
        type: "object",
      },
      UnifiedEvaluationResult: {
        description:
          "Typed evaluation result (replaces dict[str, Any]).\n\nSemantic convention:\n    passed=True  \u2192 RESISTANT (attack failed)\n    passed=False \u2192 VULNERABLE (attack succeeded)\n    passed=None  \u2192 error/unevaluated",
        properties: {
          value: {
            default: null,
            title: "Value",
          },
          passed: {
            anyOf: [
              {
                type: "boolean",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "True=RESISTANT, False=VULNERABLE, None=error/unevaluated",
            title: "Passed",
          },
          explanation: {
            default: "",
            title: "Explanation",
            type: "string",
          },
          evaluator_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Evaluator Id",
          },
          evaluator_name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Evaluator Name",
          },
          token_usage: {
            anyOf: [
              {
                $ref: "#/$defs/Usage",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          raw_output: {
            anyOf: [
              {
                additionalProperties: true,
                type: "object",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Verbatim model output for inspection: {'raw_content': <str>} on success, {'error': <str>, ...} on failure. Display/debug only (serialized into the local report JSON, not uploaded) \u2014 consumers must read the parsed verdict from passed/explanation, not from here.",
            title: "Raw Output",
          },
          jury: {
            anyOf: [
              {
                $ref: "#/$defs/JuryResult",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Panel-of-judges breakdown when a jury ran (RES-739). None for single-judge runs. Carries per-judge votes, disagreement stats and raw agreement through to the report layer.",
          },
        },
        title: "UnifiedEvaluationResult",
        type: "object",
      },
      UrlCitationBody: {
        properties: {
          type: {
            const: "url_citation",
            description: "The type of the URL citation. Always `url_citation`.",
            title: "Type",
            type: "string",
          },
          url: {
            description: "The URL of the web resource.",
            title: "Url",
            type: "string",
          },
          start_index: {
            description:
              "The index of the first character of the URL citation in the message.",
            title: "Start Index",
            type: "integer",
          },
          end_index: {
            description:
              "The index of the last character of the URL citation in the message.",
            title: "End Index",
            type: "integer",
          },
          title: {
            description: "The title of the web resource.",
            title: "Title",
            type: "string",
          },
        },
        required: ["type", "url", "start_index", "end_index", "title"],
        title: "UrlCitationBody",
        type: "object",
      },
      Usage: {
        additionalProperties: true,
        type: "object",
      },
      VulnerabilityDomain: {
        description:
          "Where in the stack the vulnerability fix belongs.\n\n- AGENT: orchestration layer (tools, memory, workflows, permissions)\n- MODEL: LLM inference layer (prompts, guardrails, output filters)\n- DATA: data/retrieval layer (training data, embeddings, RAG)",
        enum: ["agent", "model", "data"],
        title: "VulnerabilityDomain",
        type: "string",
      },
      VulnerabilitySummary: {
        description: "Per-vulnerability summary statistics.",
        properties: {
          vulnerability: {
            title: "Vulnerability",
            type: "string",
          },
          vulnerability_name: {
            title: "Vulnerability Name",
            type: "string",
          },
          domain: {
            title: "Domain",
            type: "string",
          },
          total_attacks: {
            title: "Total Attacks",
            type: "integer",
          },
          evaluated_attacks: {
            default: 0,
            description:
              'Attacks that produced a verdict. Without this, a "passed" count can only be derived as total - found, which reports every unevaluated attack as resisted.',
            title: "Evaluated Attacks",
            type: "integer",
          },
          vulnerabilities_found: {
            title: "Vulnerabilities Found",
            type: "integer",
          },
          resistance_rate: {
            anyOf: [
              {
                maximum: 1.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Fraction over *evaluated* attacks only. None when nothing in this slice could be evaluated \u2014 a 0.0 resistance rate reads as "fully compromised" and a 0.0 vulnerability rate reads as "fully safe", and neither is true when no verdict exists. Never render None as a number.',
            title: "Resistance Rate",
          },
          strategies_used: {
            items: {
              type: "string",
            },
            title: "Strategies Used",
            type: "array",
          },
          framework_categories: {
            additionalProperties: {
              items: {
                type: "string",
              },
              type: "array",
            },
            description:
              "Framework -> category codes this vulnerability maps to",
            title: "Framework Categories",
            type: "object",
          },
        },
        required: [
          "vulnerability",
          "vulnerability_name",
          "domain",
          "total_attacks",
          "vulnerabilities_found",
        ],
        title: "VulnerabilitySummary",
        type: "object",
      },
      evaluatorq__contracts__FunctionCall: {
        description: "Function call details in OpenAI tool call format.",
        properties: {
          name: {
            description: "Function name to call",
            title: "Name",
            type: "string",
          },
          arguments: {
            description: "JSON string of function arguments",
            title: "Arguments",
            type: "string",
          },
        },
        required: ["name", "arguments"],
        title: "FunctionCall",
        type: "object",
      },
      evaluatorq__openresponses__convert_models__FunctionCall: {
        description:
          "OpenResponses wire-format function call (Responses API spec) \u2014 distinct from contracts.FunctionCall (internal canonical, chat-completions shape: name/args only).",
        properties: {
          type: {
            const: "function_call",
            default: "function_call",
            description: "The type of the item. Always `function_call`.",
            title: "Type",
            type: "string",
          },
          id: {
            description: "The unique ID of the function call item.",
            title: "Id",
            type: "string",
          },
          call_id: {
            description:
              "The unique ID of the function tool call that was generated.",
            title: "Call Id",
            type: "string",
          },
          name: {
            description: "The name of the function that was called.",
            title: "Name",
            type: "string",
          },
          arguments: {
            description: "The arguments JSON string that was generated.",
            title: "Arguments",
            type: "string",
          },
          status: {
            $ref: "#/$defs/FunctionCallStatus",
            default: "completed",
          },
          result: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The result returned by the tool call, if available.",
            title: "Result",
          },
        },
        required: ["name", "arguments"],
        title: "FunctionCall",
        type: "object",
      },
    },
    description:
      'Top-level unified report wrapping all results.\n\nUsage:\n\n```python\nreport = await red_team(target="agent:YOUR_AGENT_KEY", mode="dynamic")\n\nrate = report.summary.resistance_rate\nprint(f"Resistance rate: {rate:.0%}" if rate is not None else "no verdict")\nfor result in report.results:\n    if result.vulnerable:\n        print(f"VULNERABLE [{result.attack.category}]: {result.attack.vulnerability}")\n```',
    properties: {
      version: {
        default: "2.0.0",
        title: "Version",
        type: "string",
      },
      created_at: {
        format: "date-time",
        title: "Created At",
        type: "string",
      },
      description: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Description",
      },
      pipeline: {
        $ref: "#/$defs/Pipeline",
        description: "'static', 'dynamic', or 'hybrid'",
      },
      framework: {
        anyOf: [
          {
            $ref: "#/$defs/Framework",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      categories_tested: {
        items: {
          type: "string",
        },
        title: "Categories Tested",
        type: "array",
      },
      tested_agents: {
        description: "Names/keys of tested agents in this report",
        items: {
          type: "string",
        },
        title: "Tested Agents",
        type: "array",
      },
      total_results: {
        title: "Total Results",
        type: "integer",
      },
      errors: {
        description:
          "Run-level errors for datapoints that never became attack results",
        items: {
          $ref: "#/$defs/RunError",
        },
        title: "Errors",
        type: "array",
      },
      agent_contexts: {
        additionalProperties: {
          $ref: "#/$defs/AgentContext",
        },
        description: "Per-agent context keyed by agent key",
        title: "Agent Contexts",
        type: "object",
      },
      results: {
        items: {
          $ref: "#/$defs/RedTeamResult",
        },
        title: "Results",
        type: "array",
      },
      summary: {
        $ref: "#/$defs/ReportSummary",
      },
      focus_area_recommendations: {
        anyOf: [
          {
            items: {
              $ref: "#/$defs/FocusAreaRecommendation",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        description:
          "LLM-generated actionable recommendations for top risk areas (populated when recommendations is enabled)",
        title: "Focus Area Recommendations",
      },
      applied_recommendations: {
        description:
          "Recommendation strings already applied to the agent via reports.apply. Written back onto the report so the dashboard renders them differently and a later apply skips them instead of re-applying the same fix.",
        items: {
          type: "string",
        },
        title: "Applied Recommendations",
        type: "array",
      },
      executive_summary: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        description:
          "LLM-generated narrative executive summary (populated when generate_executive_summary=True)",
        title: "Executive Summary",
      },
      token_usage_summary: {
        anyOf: [
          {
            $ref: "#/$defs/Usage",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      duration_seconds: {
        anyOf: [
          {
            type: "number",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Duration Seconds",
      },
      pipeline_warnings: {
        items: {
          type: "string",
        },
        title: "Pipeline Warnings",
        type: "array",
      },
      orq_base_url: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        description:
          "The Orq host that served this run (ORQ_BASE_URL or the prod default), recorded so a saved run remembers which deployment (prod / staging / on-prem) it ran against. None when no Orq agent/deployment target was used (OpenAI-model / custom targets) and for older reports.",
        title: "Orq Base Url",
      },
      experiment_url: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Experiment Url",
      },
      run_id: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        description:
          'Client-minted run-grouping id (uuid hex, not an Orq-side run/experiment id) shared by every attack\'s thread_id; powers the dashboard "View all run traces" deep-link. None for older reports.',
        title: "Run Id",
      },
      uploaded_count: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        description:
          "Cleaned result rows sent to the Orq platform. None when the upload was skipped (no API key) or the report predates this field; 0 when every row was stripped in cleaning.",
        title: "Uploaded Count",
      },
      rows_created: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        description:
          'Rows the Orq platform actually registered; a value below uploaded_count explains a smaller Explorer sample count. None when the upload failed or was skipped (uploaded_count then records the attempt) or the report predates this field \u2014 None with a set uploaded_count means "not confirmed".',
        title: "Rows Created",
      },
    },
    required: [
      "created_at",
      "pipeline",
      "categories_tested",
      "total_results",
      "results",
      "summary",
    ],
    title: "RedTeamReport",
    type: "object",
  },
  SimulateCliConfig: {
    $defs: {
      CommunicationStyle: {
        enum: ["formal", "casual", "terse", "verbose"],
        title: "CommunicationStyle",
        type: "string",
      },
      ConversationStrategy: {
        enum: [
          "cooperative",
          "topic_switching",
          "contradictory",
          "multi_intent",
          "evasive",
          "repetitive",
          "ambiguous",
        ],
        title: "ConversationStrategy",
        type: "string",
      },
      Criterion: {
        description:
          'A pass/fail check attached to a `Scenario`, scored by the ``criteria_met`` evaluator.\n\nUsage:\n\n```python\nfrom evaluatorq.simulation import Criterion\n\ncriteria = [\n    Criterion(description="Agent asks for order details", type="must_happen"),\n    Criterion(description="Agent blames the customer", type="must_not_happen"),\n]\n```\n\n`MustHappenCriterion` and `MustNotHappenCriterion` fix the type for you.',
        properties: {
          description: {
            title: "Description",
            type: "string",
          },
          type: {
            enum: ["must_happen", "must_not_happen"],
            title: "Type",
            type: "string",
          },
          evaluator: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Evaluator",
          },
        },
        required: ["description", "type"],
        title: "Criterion",
        type: "object",
      },
      CulturalContext: {
        enum: [
          "neutral",
          "direct",
          "indirect",
          "high_context",
          "low_context",
          "hierarchical",
        ],
        title: "CulturalContext",
        type: "string",
      },
      EmotionalArc: {
        enum: [
          "stable",
          "escalating",
          "de_escalating",
          "volatile",
          "manipulative",
          "hostile",
        ],
        title: "EmotionalArc",
        type: "string",
      },
      InputFormat: {
        enum: [
          "plain_text",
          "with_url",
          "with_attachment",
          "form_data",
          "code_block",
          "mixed_media",
        ],
        title: "InputFormat",
        type: "string",
      },
      LLMCallConfig: {
        description:
          "Per-role LLM call configuration.\n\nOne instance per pipeline role (attacker, evaluator). Controls model\nselection, API type, temperature, token limits, timeout, extra kwargs, and\noptionally an explicit pre-configured client.",
        properties: {
          model: {
            default: "openai/gpt-6-luna",
            title: "Model",
            type: "string",
          },
          api: {
            default: "chat_completions",
            enum: ["chat_completions", "responses"],
            title: "Api",
            type: "string",
          },
          temperature: {
            anyOf: [
              {
                maximum: 2.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Sampling temperature. Unset by default: when None the parameter is omitted from the request entirely, so the provider default applies and reasoning-class models that reject ``temperature`` (gpt-5 and the o-series answer 400) keep working. Set it only when you actually want to pin sampling.",
            title: "Temperature",
          },
          max_tokens: {
            default: 10000,
            exclusiveMinimum: 0,
            title: "Max Tokens",
            type: "integer",
          },
          timeout_ms: {
            default: 90000,
            exclusiveMinimum: 0,
            title: "Timeout Ms",
            type: "integer",
          },
          extra_kwargs: {
            additionalProperties: true,
            title: "Extra Kwargs",
            type: "object",
          },
          extra_body: {
            additionalProperties: true,
            description:
              "Extra fields for the request BODY, for router/provider options the SDK has no named parameter for. Distinct from ``extra_kwargs``, which sets top-level SDK call arguments. This one **merges into** the body the call site builds (the Orq router retry policy, thread and memory ids) rather than replacing it: your keys win per key, and the call site keeps the keys you did not set. Replacing the whole body is what silently dropped retry hints, which is why ``extra_body`` is rejected inside ``extra_kwargs``.",
            title: "Extra Body",
            type: "object",
          },
          reasoning_effort: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Reasoning effort. Rendered per endpoint by ``request_params``: flat ``reasoning_effort=`` on chat completions, ``reasoning={'effort': ...}`` on the Responses API. Not validated here: accepted values differ per model, so the provider is the only authority \u2014 an unsupported value comes back as a provider 400, which the `common.llm_call` executors turn into a drop-and-retry-once.",
            title: "Reasoning Effort",
          },
          client: {
            default: null,
            title: "Client",
          },
          retry_count: {
            default: 1,
            description:
              "Retries after the initial call, for callers that own retry via with_retry \u2014 currently the judge. Same semantics as LLMConfig.retry_count: 0 disables retry. The owning caller disarms the client's own retry budget for the duration (see run_judge) so the two cannot multiply.",
            minimum: 0,
            title: "Retry Count",
            type: "integer",
          },
        },
        title: "LLMCallConfig",
        type: "object",
      },
      Persona: {
        description:
          'A simulated user profile driving one side of a conversation.\n\nUsage:\n\n```python\nfrom evaluatorq.simulation import CommunicationStyle, EmotionalArc, Persona\n\npersona = Persona(\n    name="Impatient Customer",\n    patience=0.2,\n    assertiveness=0.8,\n    politeness=0.4,\n    technical_level=0.3,\n    communication_style=CommunicationStyle.terse,\n    background="Received the wrong item and wants a refund urgently",\n    emotional_arc=EmotionalArc.escalating,  # optional: tone escalates each turn\n)\n```\n\nSee `Scenario` for the matching goal/criteria half of a simulation datapoint.',
        properties: {
          name: {
            title: "Name",
            type: "string",
          },
          patience: {
            title: "Patience",
            type: "number",
          },
          assertiveness: {
            title: "Assertiveness",
            type: "number",
          },
          politeness: {
            title: "Politeness",
            type: "number",
          },
          technical_level: {
            title: "Technical Level",
            type: "number",
          },
          communication_style: {
            $ref: "#/$defs/CommunicationStyle",
          },
          background: {
            title: "Background",
            type: "string",
          },
          emotional_arc: {
            anyOf: [
              {
                $ref: "#/$defs/EmotionalArc",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          cultural_context: {
            anyOf: [
              {
                $ref: "#/$defs/CulturalContext",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
        },
        required: [
          "name",
          "patience",
          "assertiveness",
          "politeness",
          "technical_level",
          "communication_style",
          "background",
        ],
        title: "Persona",
        type: "object",
      },
      Scenario: {
        description:
          'The goal and success criteria a `Persona` pursues in one simulated conversation.\n\nUsage:\n\n```python\nfrom evaluatorq.simulation import Criterion, Scenario, StartingEmotion\n\nscenario = Scenario(\n    name="Wrong Item Refund",\n    goal="Get a full refund for the wrong item received",\n    context="Customer ordered headphones but received a phone case instead",\n    starting_emotion=StartingEmotion.frustrated,\n    criteria=[Criterion(description="Agent asks for order details", type="must_happen")],\n)\n```',
        properties: {
          name: {
            title: "Name",
            type: "string",
          },
          goal: {
            title: "Goal",
            type: "string",
          },
          context: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Context",
          },
          starting_emotion: {
            anyOf: [
              {
                $ref: "#/$defs/StartingEmotion",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          criteria: {
            anyOf: [
              {
                items: {
                  $ref: "#/$defs/Criterion",
                },
                type: "array",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Criteria",
          },
          is_edge_case: {
            anyOf: [
              {
                type: "boolean",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Is Edge Case",
          },
          conversation_strategy: {
            anyOf: [
              {
                $ref: "#/$defs/ConversationStrategy",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          ground_truth: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Ground Truth",
          },
          input_format: {
            anyOf: [
              {
                $ref: "#/$defs/InputFormat",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
        },
        required: ["name", "goal"],
        title: "Scenario",
        type: "object",
      },
      SimulationDatapoint: {
        properties: {
          id: {
            title: "Id",
            type: "string",
          },
          persona: {
            $ref: "#/$defs/Persona",
          },
          scenario: {
            $ref: "#/$defs/Scenario",
          },
          user_system_prompt: {
            title: "User System Prompt",
            type: "string",
          },
          first_message: {
            title: "First Message",
            type: "string",
          },
        },
        required: [
          "id",
          "persona",
          "scenario",
          "user_system_prompt",
          "first_message",
        ],
        title: "SimulationDatapoint",
        type: "object",
      },
      SimulationRecommendationConfig: {
        additionalProperties: false,
        description:
          "Tunable limits for simulation recommendation generation.\n\nThresholds are on the judge's 0-1 scales: a conversation-average beyond one of them marks the\nresult as remediable. Defaults preserve prior behaviour; pass an instance to\n``generate_recommendations``/``find_triggers`` to tune. ``RedTeamRecommendationConfig`` is the\nred-teaming twin \u2014 both inherit the shared caps from ``RecommendationConfigBase``.",
        properties: {
          max_suggestions: {
            default: 3,
            minimum: 1,
            title: "Max Suggestions",
            type: "integer",
          },
          max_tokens: {
            default: 800,
            minimum: 1,
            title: "Max Tokens",
            type: "integer",
          },
          factual_accuracy_below: {
            default: 0.5,
            maximum: 1.0,
            minimum: 0.0,
            title: "Factual Accuracy Below",
            type: "number",
          },
          hallucination_risk_above: {
            default: 0.5,
            maximum: 1.0,
            minimum: 0.0,
            title: "Hallucination Risk Above",
            type: "number",
          },
          tone_appropriateness_below: {
            default: 0.5,
            maximum: 1.0,
            minimum: 0.0,
            title: "Tone Appropriateness Below",
            type: "number",
          },
          max_results: {
            default: 10,
            minimum: 1,
            title: "Max Results",
            type: "integer",
          },
          max_transcript_chars: {
            default: 3000,
            minimum: 100,
            title: "Max Transcript Chars",
            type: "integer",
          },
          max_message_chars: {
            default: 400,
            minimum: 50,
            title: "Max Message Chars",
            type: "integer",
          },
          max_verdict_chars: {
            default: 300,
            minimum: 50,
            title: "Max Verdict Chars",
            type: "integer",
          },
        },
        title: "SimulationRecommendationConfig",
        type: "object",
      },
      SimulationScoringConfig: {
        additionalProperties: false,
        description:
          "Tunables for the two built-in scorers that encode a *policy*, not a fact.\n\n``goal_achieved`` and ``criteria_met`` read the judge's verdicts and have nothing to\ntune. The other two make judgement calls this class exposes, mirroring\n``SimulationRecommendationConfig``: bounded fields, ``extra='forbid'``, and defaults\nthat carry over the previously hardcoded cliffs verbatim. The one deliberate\ndifference is the tail past the last cliff, which now decays from that cliff's score\ninstead of restarting from ``1.0`` \u2014 the old curve scored 7 turns higher than 6, so a\nrun past the last cliff scores lower than it used to. See ``CHANGELOG.md``. Pass an\ninstance as ``simulate(scoring=...)`` /\n``generate_and_simulate(scoring=...)``, or to ``get_evaluator`` /\n``get_all_evaluators`` when driving the scorers directly.\n\n**What `turn_efficiency` measures.** It is a *cost* proxy, not a quality one: given\nthat the goal was reached, how many conversational turns did it take? The assumption\nis that a user who got what they came for in two turns had a better experience \u2014 and\ncost less to serve \u2014 than one who needed twelve, because the extra turns are usually\nthe agent asking for something it could have inferred, re-asking, or wandering. A run\nthat did **not** reach the goal scores ``0.0`` outright: efficiency at failing is not\na virtue worth crediting.\n\n**Where that assumption breaks.** A task that legitimately needs many turns \u2014 a long\nintake form, a multi-step troubleshooting tree, a negotiation \u2014 is penalised by this\nmetric for doing its job properly. If your scenarios look like that, either move the\ncliffs out (``turn_efficiency_cliffs=((6, 1.0), (10, 0.9), (16, 0.7))``) so the curve\nmatches a realistic conversation length, or leave ``turn_efficiency`` out of\n``evaluator_names`` and ignore the score. It is not in\n``DEFAULT_EVALUATOR_NAMES`` precisely because it is not universally meaningful.\n\nWorked example \u2014 a 4-turn conversation that reached its goal and met 1 of 2 criteria,\nscored with the defaults:\n\n```python\nfrom evaluatorq.simulation.evaluators import SimulationScoringConfig, conversation_quality_scorer\n\n# goal_achieved   = 1.0    (the judge set goal_achieved)\n# criteria_met    = 0.5    (1 of 2 criteria met)\n# turn_efficiency = 0.9    (4 turns: past the <=2 cliff, inside the <=4 one)\n#\n# conversation_quality = 1.0 * 0.4 + 0.5 * 0.3 + 0.9 * 0.3\n#                      = 0.4 + 0.15 + 0.27 = 0.82\nconversation_quality_scorer(result)  # 0.82\n\n# Same conversation, scored as if only the goal mattered:\ngoal_only = SimulationScoringConfig(\n    goal_achieved_weight=1.0, criteria_met_weight=0.0, turn_efficiency_weight=0.0\n)\nconversation_quality_scorer(result, goal_only)  # 1.0\n```",
        properties: {
          turn_efficiency_cliffs: {
            default: [
              [2, 1.0],
              [4, 0.9],
              [6, 0.7],
            ],
            items: {
              maxItems: 2,
              minItems: 2,
              prefixItems: [
                {
                  type: "integer",
                },
                {
                  type: "number",
                },
              ],
              type: "array",
            },
            title: "Turn Efficiency Cliffs",
            type: "array",
          },
          turn_efficiency_decay_per_turn: {
            default: 0.1,
            maximum: 1.0,
            minimum: 0.0,
            title: "Turn Efficiency Decay Per Turn",
            type: "number",
          },
          turn_efficiency_floor: {
            default: 0.3,
            maximum: 1.0,
            minimum: 0.0,
            title: "Turn Efficiency Floor",
            type: "number",
          },
          goal_achieved_weight: {
            default: 0.4,
            maximum: 1.0,
            minimum: 0.0,
            title: "Goal Achieved Weight",
            type: "number",
          },
          criteria_met_weight: {
            default: 0.3,
            maximum: 1.0,
            minimum: 0.0,
            title: "Criteria Met Weight",
            type: "number",
          },
          turn_efficiency_weight: {
            default: 0.3,
            maximum: 1.0,
            minimum: 0.0,
            title: "Turn Efficiency Weight",
            type: "number",
          },
        },
        title: "SimulationScoringConfig",
        type: "object",
      },
      StartingEmotion: {
        enum: ["neutral", "frustrated", "confused", "happy", "urgent"],
        title: "StartingEmotion",
        type: "string",
      },
    },
    additionalProperties: false,
    description:
      "What ``eq sim simulate --config`` accepts, with the CLI's defaults: it saves the run unless told not to.",
    properties: {
      run_name: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Run Name",
      },
      evaluation_name: {
        default: "",
        title: "Evaluation Name",
        type: "string",
      },
      target: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Target",
      },
      memory_entity_id: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Memory Entity Id",
      },
      max_turns: {
        anyOf: [
          {
            minimum: 1,
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Max Turns",
      },
      llm_config: {
        anyOf: [
          {
            $ref: "#/$defs/LLMCallConfig",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      evaluator_names: {
        anyOf: [
          {
            items: {
              type: "string",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Evaluator Names",
      },
      scoring: {
        anyOf: [
          {
            $ref: "#/$defs/SimulationScoringConfig",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      datapoint_parallelism: {
        anyOf: [
          {
            minimum: 1,
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Datapoint Parallelism",
      },
      parallelism: {
        anyOf: [
          {
            minimum: 1,
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Parallelism",
      },
      llm_parallelism: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Llm Parallelism",
      },
      target_agent_timeout_ms: {
        default: 240000,
        exclusiveMinimum: 0,
        title: "Target Agent Timeout Ms",
        type: "integer",
      },
      max_target_retries: {
        default: 2,
        minimum: 0,
        title: "Max Target Retries",
        type: "integer",
      },
      target_reasoning_effort: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Target Reasoning Effort",
      },
      max_tool_result_chars: {
        default: 500,
        exclusiveMinimum: 0,
        title: "Max Tool Result Chars",
        type: "integer",
      },
      per_simulation_timeout_s: {
        anyOf: [
          {
            exclusiveMinimum: 0,
            type: "number",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Per Simulation Timeout S",
      },
      upload_results: {
        default: true,
        title: "Upload Results",
        type: "boolean",
      },
      experiment_description: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Experiment Description",
      },
      evaluation_description: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Evaluation Description",
      },
      orq_folder_path: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Orq Folder Path",
      },
      orq_results_path: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Orq Results Path",
      },
      raise_on_execution_failure: {
        anyOf: [
          {
            type: "boolean",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Raise On Execution Failure",
      },
      exit_on_failure: {
        anyOf: [
          {
            type: "boolean",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Exit On Failure",
      },
      save: {
        default: true,
        title: "Save",
        type: "boolean",
      },
      report_path: {
        anyOf: [
          {
            format: "path",
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Report Path",
      },
      report: {
        anyOf: [
          {
            format: "path",
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Report",
      },
      executive_summary: {
        default: true,
        title: "Executive Summary",
        type: "boolean",
      },
      recommendations: {
        anyOf: [
          {
            type: "boolean",
          },
          {
            $ref: "#/$defs/SimulationRecommendationConfig",
          },
        ],
        default: true,
        title: "Recommendations",
      },
      personas: {
        anyOf: [
          {
            items: {
              $ref: "#/$defs/Persona",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Personas",
      },
      scenarios: {
        anyOf: [
          {
            items: {
              $ref: "#/$defs/Scenario",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Scenarios",
      },
      datapoints: {
        anyOf: [
          {
            items: {
              $ref: "#/$defs/SimulationDatapoint",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Datapoints",
      },
      dataset_id: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Dataset Id",
      },
      experiment_id: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Experiment Id",
      },
      experiment_run_id: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Experiment Run Id",
      },
      previous_run: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Previous Run",
      },
    },
    title: "SimulateCliConfig",
    type: "object",
  },
  GenerateAndSimulateCliConfig: {
    $defs: {
      LLMCallConfig: {
        description:
          "Per-role LLM call configuration.\n\nOne instance per pipeline role (attacker, evaluator). Controls model\nselection, API type, temperature, token limits, timeout, extra kwargs, and\noptionally an explicit pre-configured client.",
        properties: {
          model: {
            default: "openai/gpt-6-luna",
            title: "Model",
            type: "string",
          },
          api: {
            default: "chat_completions",
            enum: ["chat_completions", "responses"],
            title: "Api",
            type: "string",
          },
          temperature: {
            anyOf: [
              {
                maximum: 2.0,
                minimum: 0.0,
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Sampling temperature. Unset by default: when None the parameter is omitted from the request entirely, so the provider default applies and reasoning-class models that reject ``temperature`` (gpt-5 and the o-series answer 400) keep working. Set it only when you actually want to pin sampling.",
            title: "Temperature",
          },
          max_tokens: {
            default: 10000,
            exclusiveMinimum: 0,
            title: "Max Tokens",
            type: "integer",
          },
          timeout_ms: {
            default: 90000,
            exclusiveMinimum: 0,
            title: "Timeout Ms",
            type: "integer",
          },
          extra_kwargs: {
            additionalProperties: true,
            title: "Extra Kwargs",
            type: "object",
          },
          extra_body: {
            additionalProperties: true,
            description:
              "Extra fields for the request BODY, for router/provider options the SDK has no named parameter for. Distinct from ``extra_kwargs``, which sets top-level SDK call arguments. This one **merges into** the body the call site builds (the Orq router retry policy, thread and memory ids) rather than replacing it: your keys win per key, and the call site keeps the keys you did not set. Replacing the whole body is what silently dropped retry hints, which is why ``extra_body`` is rejected inside ``extra_kwargs``.",
            title: "Extra Body",
            type: "object",
          },
          reasoning_effort: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Reasoning effort. Rendered per endpoint by ``request_params``: flat ``reasoning_effort=`` on chat completions, ``reasoning={'effort': ...}`` on the Responses API. Not validated here: accepted values differ per model, so the provider is the only authority \u2014 an unsupported value comes back as a provider 400, which the `common.llm_call` executors turn into a drop-and-retry-once.",
            title: "Reasoning Effort",
          },
          client: {
            default: null,
            title: "Client",
          },
          retry_count: {
            default: 1,
            description:
              "Retries after the initial call, for callers that own retry via with_retry \u2014 currently the judge. Same semantics as LLMConfig.retry_count: 0 disables retry. The owning caller disarms the client's own retry budget for the duration (see run_judge) so the two cannot multiply.",
            minimum: 0,
            title: "Retry Count",
            type: "integer",
          },
        },
        title: "LLMCallConfig",
        type: "object",
      },
      SimulationRecommendationConfig: {
        additionalProperties: false,
        description:
          "Tunable limits for simulation recommendation generation.\n\nThresholds are on the judge's 0-1 scales: a conversation-average beyond one of them marks the\nresult as remediable. Defaults preserve prior behaviour; pass an instance to\n``generate_recommendations``/``find_triggers`` to tune. ``RedTeamRecommendationConfig`` is the\nred-teaming twin \u2014 both inherit the shared caps from ``RecommendationConfigBase``.",
        properties: {
          max_suggestions: {
            default: 3,
            minimum: 1,
            title: "Max Suggestions",
            type: "integer",
          },
          max_tokens: {
            default: 800,
            minimum: 1,
            title: "Max Tokens",
            type: "integer",
          },
          factual_accuracy_below: {
            default: 0.5,
            maximum: 1.0,
            minimum: 0.0,
            title: "Factual Accuracy Below",
            type: "number",
          },
          hallucination_risk_above: {
            default: 0.5,
            maximum: 1.0,
            minimum: 0.0,
            title: "Hallucination Risk Above",
            type: "number",
          },
          tone_appropriateness_below: {
            default: 0.5,
            maximum: 1.0,
            minimum: 0.0,
            title: "Tone Appropriateness Below",
            type: "number",
          },
          max_results: {
            default: 10,
            minimum: 1,
            title: "Max Results",
            type: "integer",
          },
          max_transcript_chars: {
            default: 3000,
            minimum: 100,
            title: "Max Transcript Chars",
            type: "integer",
          },
          max_message_chars: {
            default: 400,
            minimum: 50,
            title: "Max Message Chars",
            type: "integer",
          },
          max_verdict_chars: {
            default: 300,
            minimum: 50,
            title: "Max Verdict Chars",
            type: "integer",
          },
        },
        title: "SimulationRecommendationConfig",
        type: "object",
      },
      SimulationScoringConfig: {
        additionalProperties: false,
        description:
          "Tunables for the two built-in scorers that encode a *policy*, not a fact.\n\n``goal_achieved`` and ``criteria_met`` read the judge's verdicts and have nothing to\ntune. The other two make judgement calls this class exposes, mirroring\n``SimulationRecommendationConfig``: bounded fields, ``extra='forbid'``, and defaults\nthat carry over the previously hardcoded cliffs verbatim. The one deliberate\ndifference is the tail past the last cliff, which now decays from that cliff's score\ninstead of restarting from ``1.0`` \u2014 the old curve scored 7 turns higher than 6, so a\nrun past the last cliff scores lower than it used to. See ``CHANGELOG.md``. Pass an\ninstance as ``simulate(scoring=...)`` /\n``generate_and_simulate(scoring=...)``, or to ``get_evaluator`` /\n``get_all_evaluators`` when driving the scorers directly.\n\n**What `turn_efficiency` measures.** It is a *cost* proxy, not a quality one: given\nthat the goal was reached, how many conversational turns did it take? The assumption\nis that a user who got what they came for in two turns had a better experience \u2014 and\ncost less to serve \u2014 than one who needed twelve, because the extra turns are usually\nthe agent asking for something it could have inferred, re-asking, or wandering. A run\nthat did **not** reach the goal scores ``0.0`` outright: efficiency at failing is not\na virtue worth crediting.\n\n**Where that assumption breaks.** A task that legitimately needs many turns \u2014 a long\nintake form, a multi-step troubleshooting tree, a negotiation \u2014 is penalised by this\nmetric for doing its job properly. If your scenarios look like that, either move the\ncliffs out (``turn_efficiency_cliffs=((6, 1.0), (10, 0.9), (16, 0.7))``) so the curve\nmatches a realistic conversation length, or leave ``turn_efficiency`` out of\n``evaluator_names`` and ignore the score. It is not in\n``DEFAULT_EVALUATOR_NAMES`` precisely because it is not universally meaningful.\n\nWorked example \u2014 a 4-turn conversation that reached its goal and met 1 of 2 criteria,\nscored with the defaults:\n\n```python\nfrom evaluatorq.simulation.evaluators import SimulationScoringConfig, conversation_quality_scorer\n\n# goal_achieved   = 1.0    (the judge set goal_achieved)\n# criteria_met    = 0.5    (1 of 2 criteria met)\n# turn_efficiency = 0.9    (4 turns: past the <=2 cliff, inside the <=4 one)\n#\n# conversation_quality = 1.0 * 0.4 + 0.5 * 0.3 + 0.9 * 0.3\n#                      = 0.4 + 0.15 + 0.27 = 0.82\nconversation_quality_scorer(result)  # 0.82\n\n# Same conversation, scored as if only the goal mattered:\ngoal_only = SimulationScoringConfig(\n    goal_achieved_weight=1.0, criteria_met_weight=0.0, turn_efficiency_weight=0.0\n)\nconversation_quality_scorer(result, goal_only)  # 1.0\n```",
        properties: {
          turn_efficiency_cliffs: {
            default: [
              [2, 1.0],
              [4, 0.9],
              [6, 0.7],
            ],
            items: {
              maxItems: 2,
              minItems: 2,
              prefixItems: [
                {
                  type: "integer",
                },
                {
                  type: "number",
                },
              ],
              type: "array",
            },
            title: "Turn Efficiency Cliffs",
            type: "array",
          },
          turn_efficiency_decay_per_turn: {
            default: 0.1,
            maximum: 1.0,
            minimum: 0.0,
            title: "Turn Efficiency Decay Per Turn",
            type: "number",
          },
          turn_efficiency_floor: {
            default: 0.3,
            maximum: 1.0,
            minimum: 0.0,
            title: "Turn Efficiency Floor",
            type: "number",
          },
          goal_achieved_weight: {
            default: 0.4,
            maximum: 1.0,
            minimum: 0.0,
            title: "Goal Achieved Weight",
            type: "number",
          },
          criteria_met_weight: {
            default: 0.3,
            maximum: 1.0,
            minimum: 0.0,
            title: "Criteria Met Weight",
            type: "number",
          },
          turn_efficiency_weight: {
            default: 0.3,
            maximum: 1.0,
            minimum: 0.0,
            title: "Turn Efficiency Weight",
            type: "number",
          },
        },
        title: "SimulationScoringConfig",
        type: "object",
      },
    },
    additionalProperties: false,
    description:
      "What ``eq sim run --config`` accepts, with the CLI's defaults: it saves the run unless told not to.",
    properties: {
      run_name: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Run Name",
      },
      evaluation_name: {
        default: "",
        title: "Evaluation Name",
        type: "string",
      },
      target: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Target",
      },
      memory_entity_id: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Memory Entity Id",
      },
      max_turns: {
        anyOf: [
          {
            minimum: 1,
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Max Turns",
      },
      llm_config: {
        anyOf: [
          {
            $ref: "#/$defs/LLMCallConfig",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      evaluator_names: {
        anyOf: [
          {
            items: {
              type: "string",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Evaluator Names",
      },
      scoring: {
        anyOf: [
          {
            $ref: "#/$defs/SimulationScoringConfig",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      datapoint_parallelism: {
        anyOf: [
          {
            minimum: 1,
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Datapoint Parallelism",
      },
      parallelism: {
        anyOf: [
          {
            minimum: 1,
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Parallelism",
      },
      llm_parallelism: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Llm Parallelism",
      },
      target_agent_timeout_ms: {
        default: 240000,
        exclusiveMinimum: 0,
        title: "Target Agent Timeout Ms",
        type: "integer",
      },
      max_target_retries: {
        default: 2,
        minimum: 0,
        title: "Max Target Retries",
        type: "integer",
      },
      target_reasoning_effort: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Target Reasoning Effort",
      },
      max_tool_result_chars: {
        default: 500,
        exclusiveMinimum: 0,
        title: "Max Tool Result Chars",
        type: "integer",
      },
      per_simulation_timeout_s: {
        anyOf: [
          {
            exclusiveMinimum: 0,
            type: "number",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Per Simulation Timeout S",
      },
      upload_results: {
        default: true,
        title: "Upload Results",
        type: "boolean",
      },
      experiment_description: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Experiment Description",
      },
      evaluation_description: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Evaluation Description",
      },
      orq_folder_path: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Orq Folder Path",
      },
      orq_results_path: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Orq Results Path",
      },
      raise_on_execution_failure: {
        anyOf: [
          {
            type: "boolean",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Raise On Execution Failure",
      },
      exit_on_failure: {
        anyOf: [
          {
            type: "boolean",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Exit On Failure",
      },
      save: {
        default: true,
        title: "Save",
        type: "boolean",
      },
      report_path: {
        anyOf: [
          {
            format: "path",
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Report Path",
      },
      report: {
        anyOf: [
          {
            format: "path",
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Report",
      },
      executive_summary: {
        default: true,
        title: "Executive Summary",
        type: "boolean",
      },
      recommendations: {
        anyOf: [
          {
            type: "boolean",
          },
          {
            $ref: "#/$defs/SimulationRecommendationConfig",
          },
        ],
        default: true,
        title: "Recommendations",
      },
      agent_description: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Agent Description",
      },
      num_personas: {
        default: 5,
        minimum: 1,
        title: "Num Personas",
        type: "integer",
      },
      num_scenarios: {
        default: 5,
        minimum: 1,
        title: "Num Scenarios",
        type: "integer",
      },
      edge_case_percentage: {
        anyOf: [
          {
            type: "number",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Edge Case Percentage",
      },
      persona_seeds: {
        anyOf: [
          {
            items: {
              type: "string",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Persona Seeds",
      },
      scenario_seeds: {
        anyOf: [
          {
            items: {
              type: "string",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Scenario Seeds",
      },
      generation_instructions: {
        default: "",
        title: "Generation Instructions",
        type: "string",
      },
    },
    title: "GenerateAndSimulateCliConfig",
    type: "object",
  },
  SimulationRun: {
    $defs: {
      AgentInfoSnapshot: {
        description:
          "Best-effort snapshot of an ORQ agent's configuration, as fetched by\n``fetch_agent_info`` and stored on ``SimulationRun.agent_info``.\n\nDeliberately excludes the agent's system prompt / instructions.",
        properties: {
          key: {
            title: "Key",
            type: "string",
          },
          id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Id",
          },
          role: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Role",
          },
          description: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Description",
          },
          model: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Model",
          },
          tools: {
            items: {
              type: "string",
            },
            title: "Tools",
            type: "array",
          },
          skills: {
            items: {
              type: "string",
            },
            title: "Skills",
            type: "array",
          },
          knowledge_bases: {
            items: {
              type: "string",
            },
            title: "Knowledge Bases",
            type: "array",
          },
          memory_stores: {
            items: {
              type: "string",
            },
            title: "Memory Stores",
            type: "array",
          },
          sub_agents: {
            items: {
              type: "string",
            },
            title: "Sub Agents",
            type: "array",
          },
          version: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Version",
          },
          agent_type: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Agent Type",
          },
          engine: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Engine",
          },
          workspace_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Workspace Id",
          },
          workspace_key: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Workspace Key",
          },
          base_url: {
            title: "Base Url",
            type: "string",
          },
          url: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            title: "Url",
          },
        },
        title: "AgentInfoSnapshot",
        type: "object",
      },
      CommunicationStyle: {
        enum: ["formal", "casual", "terse", "verbose"],
        title: "CommunicationStyle",
        type: "string",
      },
      ConversationStrategy: {
        enum: [
          "cooperative",
          "topic_switching",
          "contradictory",
          "multi_intent",
          "evasive",
          "repetitive",
          "ambiguous",
        ],
        title: "ConversationStrategy",
        type: "string",
      },
      Criterion: {
        description:
          'A pass/fail check attached to a `Scenario`, scored by the ``criteria_met`` evaluator.\n\nUsage:\n\n```python\nfrom evaluatorq.simulation import Criterion\n\ncriteria = [\n    Criterion(description="Agent asks for order details", type="must_happen"),\n    Criterion(description="Agent blames the customer", type="must_not_happen"),\n]\n```\n\n`MustHappenCriterion` and `MustNotHappenCriterion` fix the type for you.',
        properties: {
          description: {
            title: "Description",
            type: "string",
          },
          type: {
            enum: ["must_happen", "must_not_happen"],
            title: "Type",
            type: "string",
          },
          evaluator: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Evaluator",
          },
        },
        required: ["description", "type"],
        title: "Criterion",
        type: "object",
      },
      CulturalContext: {
        enum: [
          "neutral",
          "direct",
          "indirect",
          "high_context",
          "low_context",
          "hierarchical",
        ],
        title: "CulturalContext",
        type: "string",
      },
      EmotionalArc: {
        enum: [
          "stable",
          "escalating",
          "de_escalating",
          "volatile",
          "manipulative",
          "hostile",
        ],
        title: "EmotionalArc",
        type: "string",
      },
      FunctionCall: {
        description: "Function call details in OpenAI tool call format.",
        properties: {
          name: {
            description: "Function name to call",
            title: "Name",
            type: "string",
          },
          arguments: {
            description: "JSON string of function arguments",
            title: "Arguments",
            type: "string",
          },
        },
        required: ["name", "arguments"],
        title: "FunctionCall",
        type: "object",
      },
      InputFileContent: {
        additionalProperties: true,
        type: "object",
      },
      InputFormat: {
        enum: [
          "plain_text",
          "with_url",
          "with_attachment",
          "form_data",
          "code_block",
          "mixed_media",
        ],
        title: "InputFormat",
        type: "string",
      },
      InputImageContent: {
        additionalProperties: true,
        type: "object",
      },
      InputTextContent: {
        properties: {
          type: {
            const: "input_text",
            description: "The type of the input item. Always `input_text`.",
            title: "Type",
            type: "string",
          },
          text: {
            description: "The text input to the model.",
            title: "Text",
            type: "string",
          },
        },
        required: ["type", "text"],
        title: "InputTextContent",
        type: "object",
      },
      Message: {
        description:
          'Single message in conversation history (OpenAI format with tool support).\n\nSupports both simple messages and tool calls:\n- Simple: ``{"role": "user", "content": "Hello"}``\n- Tool call: ``{"role": "assistant", "tool_calls": [...]}``\n- Tool response: ``{"role": "tool", "tool_call_id": "...", "name": "...", "content": "..."}``',
        properties: {
          role: {
            enum: ["user", "assistant", "tool", "system", "developer"],
            title: "Role",
            type: "string",
          },
          content: {
            anyOf: [
              {
                type: "string",
              },
              {
                items: {
                  discriminator: {
                    mapping: {
                      input_file: "#/$defs/InputFileContent",
                      input_image: "#/$defs/InputImageContent",
                      input_text: "#/$defs/InputTextContent",
                    },
                    propertyName: "type",
                  },
                  oneOf: [
                    {
                      $ref: "#/$defs/InputTextContent",
                    },
                    {
                      $ref: "#/$defs/InputImageContent",
                    },
                    {
                      $ref: "#/$defs/InputFileContent",
                    },
                  ],
                },
                type: "array",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Message content. A plain string, or a list of multi-modal content parts (text/image/file). Required for user/system, optional for assistant with tool_calls.",
            title: "Content",
          },
          tool_calls: {
            anyOf: [
              {
                items: {
                  $ref: "#/$defs/StrategyToolCall",
                },
                type: "array",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Tool calls made by assistant",
            title: "Tool Calls",
          },
          tool_call_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "ID linking tool response to call (for role=tool)",
            title: "Tool Call Id",
          },
          name: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Function name (for role=tool)",
            title: "Name",
          },
        },
        required: ["role"],
        title: "Message",
        type: "object",
      },
      Persona: {
        description:
          'A simulated user profile driving one side of a conversation.\n\nUsage:\n\n```python\nfrom evaluatorq.simulation import CommunicationStyle, EmotionalArc, Persona\n\npersona = Persona(\n    name="Impatient Customer",\n    patience=0.2,\n    assertiveness=0.8,\n    politeness=0.4,\n    technical_level=0.3,\n    communication_style=CommunicationStyle.terse,\n    background="Received the wrong item and wants a refund urgently",\n    emotional_arc=EmotionalArc.escalating,  # optional: tone escalates each turn\n)\n```\n\nSee `Scenario` for the matching goal/criteria half of a simulation datapoint.',
        properties: {
          name: {
            title: "Name",
            type: "string",
          },
          patience: {
            title: "Patience",
            type: "number",
          },
          assertiveness: {
            title: "Assertiveness",
            type: "number",
          },
          politeness: {
            title: "Politeness",
            type: "number",
          },
          technical_level: {
            title: "Technical Level",
            type: "number",
          },
          communication_style: {
            $ref: "#/$defs/CommunicationStyle",
          },
          background: {
            title: "Background",
            type: "string",
          },
          emotional_arc: {
            anyOf: [
              {
                $ref: "#/$defs/EmotionalArc",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          cultural_context: {
            anyOf: [
              {
                $ref: "#/$defs/CulturalContext",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
        },
        required: [
          "name",
          "patience",
          "assertiveness",
          "politeness",
          "technical_level",
          "communication_style",
          "background",
        ],
        title: "Persona",
        type: "object",
      },
      ResponseTrace: {
        description:
          "Orq observability handles for one target-agent response.\n\nPersisted per successful response so a conversation/attack retains the exact\ntrace (and span) of every target turn; the dashboard links to the last one.\nEither field may be None when the target isn't routed through Orq.",
        properties: {
          trace_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Trace Id",
          },
          span_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Span Id",
          },
        },
        title: "ResponseTrace",
        type: "object",
      },
      Scenario: {
        description:
          'The goal and success criteria a `Persona` pursues in one simulated conversation.\n\nUsage:\n\n```python\nfrom evaluatorq.simulation import Criterion, Scenario, StartingEmotion\n\nscenario = Scenario(\n    name="Wrong Item Refund",\n    goal="Get a full refund for the wrong item received",\n    context="Customer ordered headphones but received a phone case instead",\n    starting_emotion=StartingEmotion.frustrated,\n    criteria=[Criterion(description="Agent asks for order details", type="must_happen")],\n)\n```',
        properties: {
          name: {
            title: "Name",
            type: "string",
          },
          goal: {
            title: "Goal",
            type: "string",
          },
          context: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Context",
          },
          starting_emotion: {
            anyOf: [
              {
                $ref: "#/$defs/StartingEmotion",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          criteria: {
            anyOf: [
              {
                items: {
                  $ref: "#/$defs/Criterion",
                },
                type: "array",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Criteria",
          },
          is_edge_case: {
            anyOf: [
              {
                type: "boolean",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Is Edge Case",
          },
          conversation_strategy: {
            anyOf: [
              {
                $ref: "#/$defs/ConversationStrategy",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
          ground_truth: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Ground Truth",
          },
          input_format: {
            anyOf: [
              {
                $ref: "#/$defs/InputFormat",
              },
              {
                type: "null",
              },
            ],
            default: null,
          },
        },
        required: ["name", "goal"],
        title: "Scenario",
        type: "object",
      },
      SimulationDatapoint: {
        properties: {
          id: {
            title: "Id",
            type: "string",
          },
          persona: {
            $ref: "#/$defs/Persona",
          },
          scenario: {
            $ref: "#/$defs/Scenario",
          },
          user_system_prompt: {
            title: "User System Prompt",
            type: "string",
          },
          first_message: {
            title: "First Message",
            type: "string",
          },
        },
        required: [
          "id",
          "persona",
          "scenario",
          "user_system_prompt",
          "first_message",
        ],
        title: "SimulationDatapoint",
        type: "object",
      },
      SimulationRecommendation: {
        description:
          "LLM-generated remediation suggestion for one failed simulation result.\n\n``result_index`` is the position in ``SimulationRun.results`` /\nthe exporter's results list; ``datapoint_id`` is carried from result\nmetadata when available.",
        properties: {
          result_index: {
            title: "Result Index",
            type: "integer",
          },
          datapoint_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            title: "Datapoint Id",
          },
          persona: {
            title: "Persona",
            type: "string",
          },
          scenario: {
            title: "Scenario",
            type: "string",
          },
          triggers: {
            items: {
              type: "string",
            },
            title: "Triggers",
            type: "array",
          },
          suggestions: {
            items: {
              type: "string",
            },
            title: "Suggestions",
            type: "array",
          },
        },
        required: [
          "result_index",
          "persona",
          "scenario",
          "triggers",
          "suggestions",
        ],
        title: "SimulationRecommendation",
        type: "object",
      },
      SimulationResult: {
        properties: {
          messages: {
            description:
              "The conversation transcript in order: simulated-user turns, target replies (with tool_calls), and a role='tool' row for each tool result.",
            items: {
              $ref: "#/$defs/Message",
            },
            title: "Messages",
            type: "array",
          },
          terminated_by: {
            $ref: "#/$defs/TerminatedBy",
            description:
              "Why the conversation stopped: judge, max_turns, timeout or error.",
          },
          reason: {
            description: "Human-readable explanation of the termination.",
            title: "Reason",
            type: "string",
          },
          goal_achieved: {
            description: "Whether the judge found the scenario's goal reached.",
            title: "Goal Achieved",
            type: "boolean",
          },
          goal_completion_score: {
            description:
              "Judge estimate 0-1 of how much of the goal was reached.",
            title: "Goal Completion Score",
            type: "number",
          },
          rules_broken: {
            description:
              'Ids (criteria_<n>) of the scenario criteria that failed, when criteria_verified is True; otherwise the free-text list from the judge, passed through. See metadata["criteria_meta"] for detail.',
            items: {
              type: "string",
            },
            title: "Rules Broken",
            type: "array",
          },
          turn_count: {
            description: "Target replies in the transcript.",
            title: "Turn Count",
            type: "integer",
          },
          token_usage: {
            $ref: "#/$defs/Usage",
            description:
              "Tokens spent on this conversation, summed over every call.",
          },
          token_usage_known: {
            default: true,
            description:
              "Whether token usage was fully collected. False means the result contains partial usage and must be treated as unknown rather than as a zero-cost run.",
            title: "Token Usage Known",
            type: "boolean",
          },
          turn_metrics: {
            description: "Per-turn judge scores and token usage.",
            items: {
              $ref: "#/$defs/TurnMetrics",
            },
            title: "Turn Metrics",
            type: "array",
          },
          metadata: {
            additionalProperties: true,
            description:
              "Persona, scenario and criteria detail, evaluator scores, and error/error_type on failed results. A convention, not a schema: keys may be absent. The output reference guide lists every key.",
            title: "Metadata",
            type: "object",
          },
          criteria_results: {
            anyOf: [
              {
                additionalProperties: {
                  type: "boolean",
                },
                type: "object",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Criterion description to pass/fail. Two criteria with the same description share a key; read metadata["criteria_meta"] for the id-keyed form.',
            title: "Criteria Results",
          },
          criteria_verified: {
            anyOf: [
              {
                type: "boolean",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Whether criteria_results rests on the judge per-criterion occurrence audit. False means the audit never arrived (a custom judge that does not report it, or a judge that malfunctioned and terminated for safety), so the verdicts fell back to the free-text rules_broken list, which cannot fail a must_happen criterion \u2014 treat them as unknown, not met. None for runs saved before this field existed.",
            title: "Criteria Verified",
          },
          evaluator_details: {
            additionalProperties: {
              additionalProperties: true,
              type: "object",
            },
            description:
              "Structured raw output from evaluators that provide detail, keyed by evaluator name. Built-in criteria_met carries per-criterion audit records and conversation_quality carries its component scores and weights; custom evaluator raw output is retained too. The field is included in saved SimulationRun and JSONL result exports. Empty when no evaluator provided structured output.",
            title: "Evaluator Details",
            type: "object",
          },
          total_turns: {
            anyOf: [
              {
                type: "integer",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Legacy field not populated by simulation runs; read turn_count.",
            title: "Total Turns",
          },
          thread_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              'Orq observability thread id for this conversation (deterministic: f"{run_id}:{index}"). None for runs saved before thread grouping existed.',
            title: "Thread Id",
          },
          response_traces: {
            description:
              "Per-turn Orq trace/span handles for each successful target-agent response (excludes user-simulator and judge calls), in turn order. Empty for non-Orq targets and for runs saved before this field existed.",
            items: {
              $ref: "#/$defs/ResponseTrace",
            },
            title: "Response Traces",
            type: "array",
          },
        },
        required: [
          "messages",
          "terminated_by",
          "reason",
          "goal_achieved",
          "goal_completion_score",
          "rules_broken",
          "turn_count",
          "token_usage",
          "turn_metrics",
        ],
        title: "SimulationResult",
        type: "object",
      },
      StartingEmotion: {
        enum: ["neutral", "frustrated", "confused", "happy", "urgent"],
        title: "StartingEmotion",
        type: "string",
      },
      StrategyToolCall: {
        description: "Tool call in assistant message (OpenAI format).",
        properties: {
          id: {
            description: "Unique tool call ID (e.g., call_abc123)",
            title: "Id",
            type: "string",
          },
          type: {
            const: "function",
            default: "function",
            description: "Tool type",
            title: "Type",
            type: "string",
          },
          function: {
            $ref: "#/$defs/FunctionCall",
            description: "Function call details",
          },
          item_id: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Responses-API function_call item id (fc_*)",
            title: "Item Id",
          },
          incomplete: {
            default: false,
            description:
              "The recorded fact that this call has no result. Judge text and exports mark it from this flag; provider replay does not trust it and pairs by position instead (`common.messages.pair_tool_rows`).",
            title: "Incomplete",
            type: "boolean",
          },
        },
        required: ["id", "function"],
        title: "StrategyToolCall",
        type: "object",
      },
      TerminatedBy: {
        enum: ["judge", "max_turns", "error", "timeout"],
        title: "TerminatedBy",
        type: "string",
      },
      TurnMetrics: {
        properties: {
          turn_number: {
            description: "1-based turn this entry scores.",
            title: "Turn Number",
            type: "integer",
          },
          token_usage: {
            $ref: "#/$defs/Usage",
            description:
              "Tokens spent during this turn: user simulator, target and judge.",
          },
          response_quality: {
            anyOf: [
              {
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Judge score 0-1; None when not scored.",
            title: "Response Quality",
          },
          hallucination_risk: {
            anyOf: [
              {
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description:
              "Judge score 0-1, higher is riskier; None when not scored.",
            title: "Hallucination Risk",
          },
          tone_appropriateness: {
            anyOf: [
              {
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Judge score 0-1; None when not scored.",
            title: "Tone Appropriateness",
          },
          factual_accuracy: {
            anyOf: [
              {
                type: "number",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "Judge score 0-1; None when not scored.",
            title: "Factual Accuracy",
          },
          judge_reason: {
            description: "The judge's reasoning for this turn.",
            title: "Judge Reason",
            type: "string",
          },
        },
        required: ["turn_number", "token_usage", "judge_reason"],
        title: "TurnMetrics",
        type: "object",
      },
      Usage: {
        additionalProperties: true,
        type: "object",
      },
    },
    properties: {
      run_name: {
        title: "Run Name",
        type: "string",
      },
      created_at: {
        format: "date-time",
        title: "Created At",
        type: "string",
      },
      mode: {
        enum: ["run", "simulate", "generate"],
        title: "Mode",
        type: "string",
      },
      target_kind: {
        enum: [
          "orq_agent",
          "orq_deployment",
          "vercel",
          "openai_model",
          "callback",
        ],
        title: "Target Kind",
        type: "string",
      },
      target: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Target",
      },
      target_model: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Target Model",
      },
      max_turns: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Max Turns",
      },
      agent_info: {
        anyOf: [
          {
            $ref: "#/$defs/AgentInfoSnapshot",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      orq_base_url: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Orq Base Url",
      },
      evaluator_names: {
        items: {
          type: "string",
        },
        title: "Evaluator Names",
        type: "array",
      },
      total_results: {
        title: "Total Results",
        type: "integer",
      },
      scorer_averages: {
        additionalProperties: {
          type: "number",
        },
        title: "Scorer Averages",
        type: "object",
      },
      results: {
        items: {
          $ref: "#/$defs/SimulationResult",
        },
        title: "Results",
        type: "array",
      },
      datapoints: {
        anyOf: [
          {
            items: {
              $ref: "#/$defs/SimulationDatapoint",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Datapoints",
      },
      replay_version: {
        anyOf: [
          {
            type: "integer",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Replay Version",
      },
      executive_summary: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Executive Summary",
      },
      token_usage_total: {
        anyOf: [
          {
            $ref: "#/$defs/Usage",
          },
          {
            type: "null",
          },
        ],
        default: null,
      },
      run_id: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Run Id",
      },
      experiment_url: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Experiment Url",
      },
      recommendations: {
        anyOf: [
          {
            items: {
              $ref: "#/$defs/SimulationRecommendation",
            },
            type: "array",
          },
          {
            type: "null",
          },
        ],
        default: null,
        title: "Recommendations",
      },
      applied_suggestions: {
        items: {
          type: "string",
        },
        title: "Applied Suggestions",
        type: "array",
      },
    },
    required: [
      "run_name",
      "created_at",
      "mode",
      "target_kind",
      "evaluator_names",
      "total_results",
      "scorer_averages",
      "results",
    ],
    title: "SimulationRun",
    type: "object",
  },
};
