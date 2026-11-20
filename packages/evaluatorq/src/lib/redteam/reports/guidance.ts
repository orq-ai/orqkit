export const REMEDIATION_GUIDANCE: Readonly<Record<string, string>> = {
  ASI01:
    "Implement strict input sanitization for all external data sources ingested by the agent. Enforce a separation between data-plane and instruction-plane signals. Use a prompt firewall or system-prompt anchoring to resist goal hijacking attempts.",
  ASI02:
    "Apply the principle of least privilege to every tool: scope permissions to the minimum required. Validate tool inputs against a strict schema before execution. Add rate limits, audit logging, and human-in-the-loop gates for high-impact tool calls.",
  ASI05:
    "Disable or sandbox code execution capabilities unless explicitly required. Execute generated code in isolated, resource-constrained containers with no network access. Validate and lint generated code statically before runtime.",
  ASI06:
    "Treat agent memory as untrusted input: validate and sanitize all retrieved memory entries before injecting them into context. Implement memory TTL policies and access controls. Log and monitor memory read/write patterns for anomalous sequences.",
  ASI09:
    "Apply skepticism to all authority claims within the conversation context. Verify identity assertions through out-of-band mechanisms rather than conversational cues. Train agents to recognize social-engineering patterns and escalate ambiguous authority requests.",
  LLM01:
    "Treat all user-supplied content as untrusted. Use structured prompting with clear delimiters between system instructions and user input. Validate model outputs before acting on them. Implement prompt injection detection as a pre-processing step.",
  LLM02:
    "Audit system prompts and context windows for PII and sensitive data. Implement output filtering to prevent leakage of credentials, keys, and personal information. Apply data minimization - only include information necessary for the task.",
  LLM04:
    "Monitor training and fine-tuning pipelines for data integrity. Validate datasets from third parties before use. Use adversarial testing to detect behavioral anomalies introduced by poisoned data.",
  LLM05:
    "Sanitize and validate all model outputs before passing them to downstream systems or users. Avoid executing raw model output as code or SQL without validation. Use output encoding appropriate to the rendering context (HTML, JSON, shell, etc.).",
  LLM06:
    "Restrict the scope of actions the model can take autonomously. Require explicit human approval for irreversible or high-impact operations. Implement action logging and anomaly detection for unexpected tool usage patterns.",
  LLM07:
    "Treat the system prompt as sensitive data. Do not include credentials, PII, or business logic secrets in the system prompt. Instruct the model to refuse requests to reveal its system prompt content.",
  LLM08:
    "Validate and sanitize all documents ingested into vector stores. Monitor embedding retrieval for adversarial content that could manipulate downstream behavior. Implement access controls on knowledge bases to prevent unauthorized data injection.",
  LLM09:
    "Implement fact-checking and retrieval-augmented generation (RAG) with authoritative sources. Add uncertainty signals to model outputs and instruct models to decline when confidence is low. Log and review cases where the model makes high-stakes factual claims.",
};
