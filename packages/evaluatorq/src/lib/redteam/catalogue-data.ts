import type {
  DeliveryMethod,
  Vulnerability,
  VulnerabilityDef,
} from "./contracts.js";
export const vulnerabilityDefinitions = {
  goal_hijacking: {
    id: "goal_hijacking",
    name: "Agent Goal Hijacking",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "indirect-injection",
    frameworkMappings: {
      "OWASP-ASI": ["ASI01"],
    },
  },
  tool_misuse: {
    id: "tool_misuse",
    name: "Tool Misuse & Exploitation",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "tool-abuse",
    frameworkMappings: {
      "OWASP-ASI": ["ASI02"],
    },
  },
  identity_privilege_abuse: {
    id: "identity_privilege_abuse",
    name: "Identity & Privilege Abuse",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "privilege-escalation",
    frameworkMappings: {
      "OWASP-ASI": ["ASI03"],
    },
  },
  supply_chain: {
    id: "supply_chain",
    name: "Supply Chain Vulnerabilities",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "supply-chain",
    frameworkMappings: {
      "OWASP-ASI": ["ASI04"],
      "OWASP-LLM": ["LLM03"],
    },
  },
  code_execution: {
    id: "code_execution",
    name: "Unexpected Code Execution",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "rce-exploit",
    frameworkMappings: {
      "OWASP-ASI": ["ASI05"],
    },
  },
  memory_poisoning: {
    id: "memory_poisoning",
    name: "Memory & Context Poisoning",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "context-poisoning",
    frameworkMappings: {
      "OWASP-ASI": ["ASI06"],
    },
  },
  inter_agent_comms: {
    id: "inter_agent_comms",
    name: "Insecure Inter-Agent Communication",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "message-spoofing",
    frameworkMappings: {
      "OWASP-ASI": ["ASI07"],
    },
  },
  cascading_failures: {
    id: "cascading_failures",
    name: "Cascading Failures",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "cascade-trigger",
    frameworkMappings: {
      "OWASP-ASI": ["ASI08"],
    },
  },
  trust_exploitation: {
    id: "trust_exploitation",
    name: "Human-Agent Trust Exploitation",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "social-engineering",
    frameworkMappings: {
      "OWASP-ASI": ["ASI09"],
    },
  },
  rogue_agents: {
    id: "rogue_agents",
    name: "Rogue Agents",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "boundary-violation",
    frameworkMappings: {
      "OWASP-ASI": ["ASI10"],
    },
  },
  prompt_injection: {
    id: "prompt_injection",
    name: "Prompt Injection",
    domain: "model",
    description: "",
    defaultAttackTechnique: "direct-injection",
    frameworkMappings: {
      "OWASP-LLM": ["LLM01"],
    },
  },
  sensitive_info_disclosure: {
    id: "sensitive_info_disclosure",
    name: "Sensitive Information Disclosure",
    domain: "model",
    description: "",
    defaultAttackTechnique: "social-engineering",
    frameworkMappings: {
      "OWASP-LLM": ["LLM02"],
    },
  },
  data_poisoning: {
    id: "data_poisoning",
    name: "Data and Model Poisoning",
    domain: "data",
    description: "",
    defaultAttackTechnique: "context-poisoning",
    frameworkMappings: {
      "OWASP-LLM": ["LLM04"],
    },
  },
  improper_output: {
    id: "improper_output",
    name: "Improper Output Handling",
    domain: "model",
    description: "",
    defaultAttackTechnique: "direct-injection",
    frameworkMappings: {
      "OWASP-LLM": ["LLM05"],
    },
  },
  excessive_agency: {
    id: "excessive_agency",
    name: "Excessive Agency",
    domain: "agent",
    description: "",
    defaultAttackTechnique: "tool-abuse",
    frameworkMappings: {
      "OWASP-LLM": ["LLM06"],
    },
  },
  system_prompt_leakage: {
    id: "system_prompt_leakage",
    name: "System Prompt Leakage",
    domain: "model",
    description: "",
    defaultAttackTechnique: "social-engineering",
    frameworkMappings: {
      "OWASP-LLM": ["LLM07"],
    },
  },
  vector_embedding_weakness: {
    id: "vector_embedding_weakness",
    name: "Vector and Embedding Weaknesses",
    domain: "data",
    description: "",
    defaultAttackTechnique: "context-poisoning",
    frameworkMappings: {
      "OWASP-LLM": ["LLM08"],
    },
  },
  misinformation: {
    id: "misinformation",
    name: "Misinformation",
    domain: "model",
    description: "",
    defaultAttackTechnique: "social-engineering",
    frameworkMappings: {
      "OWASP-LLM": ["LLM09"],
    },
  },
} satisfies Record<Vulnerability, VulnerabilityDef>;
export const deliveryCategories = {
  DAN: "persona",
  "role-play": "persona",
  "skeleton-key": "persona",
  base64: "obfuscation",
  leetspeak: "obfuscation",
  multilingual: "obfuscation",
  "character-spacing": "obfuscation",
  crescendo: "multi-turn",
  "many-shot": "multi-turn",
  "authority-impersonation": "social-engineering",
  "refusal-suppression": "social-engineering",
  "direct-request": "direct",
  "code-elicitation": "direct",
  "code-assistance": "direct",
  "tool-response": "tool-agent",
  "word-substitution": "tool-agent",
} satisfies Record<DeliveryMethod, string>;
export const evaluatorMetadata = {
  goal_hijacking: {
    evaluator_id: "01KFTGH3A3ZEQBY4JH0RHTAQYN",
    evaluator_name: "owasp_asi01_goal_hijacking",
  },
  code_execution: {
    evaluator_id: "01KFTGH3TW3SHBNT0FF8ZC53KA",
    evaluator_name: "owasp_asi05_code_execution",
  },
  memory_poisoning: {
    evaluator_id: "01KFTGH4AHJD0DGMVXEV0QPM21",
    evaluator_name: "owasp_asi06_memory_poisoning",
  },
  prompt_injection: {
    evaluator_id: "01KFX0DEY1S57B1Q19AK10RAYF",
    evaluator_name: "owasp_llm01_prompt_injection",
  },
  sensitive_info_disclosure: {
    evaluator_id: "01KFX0DEY1RWTR466RMS2FT3P7",
    evaluator_name: "owasp_llm02_sensitive_info_disclosure",
  },
  system_prompt_leakage: {
    evaluator_id: "01KFX0DEY1DBEW2ZAQ0M3DN12T",
    evaluator_name: "owasp_llm07_system_prompt_leakage",
  },
};
