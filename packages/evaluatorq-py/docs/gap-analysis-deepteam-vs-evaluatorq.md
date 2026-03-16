# Gap Analysis: DeepTeam vs evaluatorq Red Teaming

## Context

This is a feature-level gap analysis comparing [DeepTeam](https://www.trydeepteam.com/) (by Confident AI) — an open-source LLM red teaming framework — against our `evaluatorq.redteam` package. The goal is to identify where we lead, where we lag, and where there's feature parity, to inform the roadmap.

---

## 1. Vulnerability Coverage

### DeepTeam: ~40+ vulnerability types across 6 domains

| Domain | Vulnerabilities |
|--------|----------------|
| **Responsible AI** | Bias (race, gender, religion, politics), Toxicity (profanity, insults, threats), Child Protection, Ethics, Fairness |
| **Data Privacy** | PII Leakage (direct, API, session), Prompt Leakage (secrets, credentials, permissions) |
| **Security** | BFLA, BOLA, RBAC, Debug Access, Shell Injection, SQL Injection, SSRF, Tool Metadata Poisoning, Cross-Context Retrieval, System Reconnaissance |
| **Safety** | Illegal Activity (drugs, weapons, child exploitation), Graphic Content, Personal Safety (bullying, self-harm), Unexpected Code Execution |
| **Business** | Misinformation, Intellectual Property, Competition (competitor mention, discreditation) |
| **Agentic** | Goal Theft, Recursive Hijacking, Excessive Agency, Robustness, Indirect Instruction, Tool Orchestration Abuse, Agent Identity & Trust Abuse, Inter-Agent Communication Compromise, Autonomous Agent Drift, Exploit Tool Agent, External System Abuse |

### evaluatorq: 20 categories across OWASP ASI + LLM Top 10

| Framework | Categories with Evaluators |
|-----------|--------------------------|
| **OWASP ASI** (agentic) | ASI01 Goal Hijacking, ASI02 Tool Misuse, ASI05 Code Execution, ASI06 Memory Poisoning, ASI09 Trust Exploitation |
| **OWASP ASI** (no evaluator) | ASI03 Identity/Privilege, ASI04 Supply Chain, ASI07 Inter-Agent Comms, ASI08 Cascading Failures, ASI10 Rogue Agents |
| **OWASP LLM Top 10** | LLM01 Prompt Injection, LLM02 Sensitive Info Disclosure, LLM04 Data Poisoning, LLM05 Improper Output, LLM06 Excessive Agency, LLM07 System Prompt Leakage, LLM08 Vector/Embedding, LLM09 Misinformation, LLM10 Unbounded Consumption |

### Gap Assessment

| Area | evaluatorq | DeepTeam | Gap |
|------|-----------|----------|-----|
| OWASP LLM Top 10 | 9/10 (missing LLM03) | Full mapping | **Parity** (LLM03 is infra-level) |
| OWASP ASI (agentic) | 10/10 defined, 5 with evaluators | 11 agentic vulnerabilities | **Parity** on coverage, gap on evaluator depth |
| Responsible AI (Bias, Toxicity, Fairness) | Not covered | 5 vulnerabilities with sub-types | **Major gap** |
| Data Privacy (PII Leakage) | Via LLM02 only | Dedicated PII + Prompt Leakage | **Minor gap** |
| Safety (Illegal, Graphic, Personal) | Not covered | 4 vulnerability classes | **Major gap** |
| Business (IP, Competition) | Not covered | 3 vulnerability classes | **Moderate gap** |
| Security (SQLi, Shell, SSRF, BOLA, BFLA, RBAC) | Not covered directly | 10 dedicated security vulns | **Moderate gap** (some overlap with ASI02/ASI05) |
| Custom vulnerability types | Not supported | Supported | **Gap** |

**Bottom line**: evaluatorq is deeply focused on OWASP frameworks. DeepTeam has significantly broader vulnerability coverage outside OWASP, especially in Responsible AI, Safety, and Business domains.

---

## 2. Attack Strategies & Techniques

### DeepTeam: 19 attack methods

**Single-turn (14):**
- Encoding: Base64, ROT-13, Leetspeak
- LLM-enhanced: AdversarialPoetry, GrayBox, MathProblem, Multilingual, PromptInjection, Roleplay, ContextPoisoning, GoalRedirection, InputBypass, PermissionEscalation, LinguisticConfusion, SystemOverride

**Multi-turn (5):**
- Bad LikertJudge, CrescendoJailbreaking, LinearJailbreaking, SequentialBreak, TreeJailbreaking

### evaluatorq: 14 attack techniques + 17 delivery methods

**Attack techniques** (from `AttackTechnique` enum):
- indirect-injection, direct-injection, DAN, credential-caching, privilege-escalation, confused-deputy, rce-exploit, message-spoofing, social-engineering, tool-abuse, supply-chain, context-poisoning, cascade-trigger, boundary-violation

**Delivery methods** (from `DeliveryMethod` enum):
- DAN, role-play, skeleton-key, base64, leetspeak, multilingual, character-spacing, crescendo, many-shot, authority-impersonation, refusal-suppression, direct-request, code-elicitation, code-assistance, tool-response

**Dynamic strategy generation**: LLM generates novel strategies tailored to agent capabilities at runtime

### Gap Assessment

| Area | evaluatorq | DeepTeam | Gap |
|------|-----------|----------|-----|
| Encoding attacks | base64, leetspeak, multilingual, character-spacing | Base64, ROT-13, Leetspeak | **evaluatorq leads** (more methods) |
| Jailbreaking | DAN, skeleton-key, role-play, crescendo, many-shot | DAN (via Roleplay), Crescendo, Linear, Sequential, Tree | **DeepTeam leads** (tree/sequential jailbreaking) |
| Social engineering | authority-impersonation, refusal-suppression, social-engineering | Roleplay, GrayBox | **evaluatorq leads** |
| Agent-specific attacks | tool-abuse, confused-deputy, supply-chain, tool-response, context-poisoning | ContextPoisoning, GoalRedirection, PermissionEscalation | **evaluatorq leads significantly** (agent-context-aware) |
| LLM-generated strategies | Yes (runtime generation based on agent context) | No | **evaluatorq leads significantly** |
| Tree-based jailbreaking | No | TreeJailbreaking (parallel branching) | **Gap** |
| Sequential/Linear jailbreaking | No (only crescendo + many-shot for multi-turn) | LinearJailbreaking, SequentialBreak | **Minor gap** |
| ROT-13 encoding | No | Yes | **Minor gap** |
| Math problem embedding | No | MathProblem | **Minor gap** |
| Adversarial poetry | No | AdversarialPoetry | **Minor gap** |

**Bottom line**: evaluatorq has significantly stronger agent-context-aware attack generation (LLM-generated strategies, tool-specific attacks). DeepTeam has more diverse single-shot encoding/obfuscation techniques and tree-based jailbreaking.

---

## 3. Architecture & Pipeline

| Feature | evaluatorq | DeepTeam |
|---------|-----------|----------|
| **Pipeline modes** | 3 modes: static, dynamic, hybrid | Single scan mode |
| **Agent context awareness** | Deep: fetches tools, memory, KB, system prompt; LLM classifies capabilities; strategies adapt | Minimal: callback receives input + optional conversation history |
| **Capability classification** | LLM-based semantic tagging (code_execution, shell_access, database, web_request, etc.) | None |
| **Strategy selection** | Context-filtered: skips strategies where agent lacks required capabilities | Random selection with configurable weights |
| **Multi-target runs** | Built-in: pass list of targets, results merged | Not built-in |
| **Hybrid static+dynamic** | Yes, with routing metadata | No |
| **Parallelism** | Configurable concurrent jobs | Configurable concurrent operations |
| **Staged artifact saving** | Yes (numbered JSON files per stage) | Not documented |

**Bottom line**: evaluatorq has a significantly more sophisticated pipeline architecture with agent-context-awareness, hybrid modes, and staged output. DeepTeam is simpler but more accessible.

---

## 4. Evaluation & Scoring

| Feature | evaluatorq | DeepTeam |
|---------|-----------|----------|
| **Evaluation method** | LLM-as-judge with category-specific evaluator prompts | LLM-as-judge with vulnerability-specific metrics |
| **Scoring** | Boolean (passed=True -> RESISTANT, passed=False -> VULNERABLE) + explanation | Binary 0/1 + score reasoning |
| **Evaluator registry** | 14 category-specific evaluators (5 ASI + 9 LLM) | 40+ vulnerability-specific metrics |
| **Custom evaluators** | Not currently supported | Custom vulnerability types with custom metrics |
| **Confidence scoring** | No | Not documented |
| **Token usage tracking** | Granular: per-call, per-source (adversarial vs target vs evaluator) | Not documented |

**Bottom line**: Similar approach (LLM-as-judge, binary scoring). evaluatorq has better token tracking. DeepTeam has broader metric coverage matching its larger vulnerability set.

---

## 5. Target Interaction

| Feature | evaluatorq | DeepTeam |
|---------|-----------|----------|
| **Backend protocol** | Pluggable: `AgentTarget` protocol with `send_prompt()` / `reset_conversation()` | Callback function `(input, turns?) -> str or RTTurn` |
| **Built-in backends** | ORQ agents, OpenAI models, deployment keys | Any LLM via DeepEvalBaseLLM |
| **Agent features** | Full ORQ SDK integration: tools, memory stores, knowledge bases, deployments | Model-agnostic callback |
| **Memory cleanup** | Automatic cleanup of injected memory entities after runs | No |
| **Conversation history** | OpenAI message format with tool calls | Simple turn-based history |
| **Tool call support** | Full OpenAI-format tool_calls in message schema | RTTurn with retrieval context + tool calls |
| **Multi-agent targets** | Via multi-target run (sequential, merged report) | Not documented |

**Bottom line**: evaluatorq has deeper platform integration (ORQ-native). DeepTeam is more provider-agnostic with simpler callback interface.

---

## 6. Compliance Framework Support

| Framework | evaluatorq | DeepTeam |
|-----------|-----------|----------|
| **OWASP LLM Top 10** | Native (9/10 categories) | Mapped |
| **OWASP ASI** | Native (10/10 categories) | Partial (via agentic vulnerabilities) |
| **NIST AI RMF** | Not supported | Mapped |
| **MITRE ATLAS** | Not supported | Mapped with attack lifecycle phases |
| **EU AI Act** | Framework enum exists but no implementation | Not documented |
| **GDPR** | Framework enum exists but no implementation | Not documented |

**Bottom line**: DeepTeam supports more compliance frameworks (NIST, MITRE ATLAS). evaluatorq has deeper OWASP coverage but defined-but-unimplemented framework enums for EU AI Act and GDPR.

---

## 7. CLI & Configuration

| Feature | evaluatorq | DeepTeam |
|---------|-----------|----------|
| **CLI** | Typer-based CLI with `run` command | CLI with YAML configuration |
| **Programmatic API** | `red_team()` async function | `RedTeamer` class with `scan()` |
| **YAML config** | Not supported | Supported |
| **Attack caching/reuse** | Not supported | Supported (reuse previously simulated attacks) |
| **Confirm callback** | Supported (pre-execution summary + cancel) | Not documented |

---

## 8. Observability & Reporting

| Feature | evaluatorq | DeepTeam |
|---------|-----------|----------|
| **OpenTelemetry tracing** | Full OTel GenAI semantic conventions for all LLM calls | Not documented |
| **Rich CLI output** | Rich progress bars, summary tables | Not documented |
| **Report format** | Structured `RedTeamReport` with summary, per-category, per-technique breakdowns | Scan results with scores |
| **Report merging** | Built-in multi-report merge | Not documented |
| **Token usage summary** | Granular by source (adversarial, target, evaluator) | Not documented |
| **Error analysis** | Typed error classification (content_filter, llm_error, target_error) | Not documented |
| **Staged artifacts** | Numbered JSON files per pipeline stage | Not documented |

**Bottom line**: evaluatorq has significantly better observability with OTel tracing, granular token tracking, and structured error analysis.

---

## 9. Summary: Key Gaps to Address

### Where DeepTeam leads (potential roadmap items for evaluatorq)

| Priority | Gap | Impact | Effort |
|----------|-----|--------|--------|
| **High** | Responsible AI vulnerabilities (Bias, Toxicity, Fairness) | Large market need for responsible AI testing | Medium -- new evaluator prompts + vulnerability definitions |
| **High** | Safety vulnerabilities (Illegal Activity, Graphic Content, Personal Safety) | Content safety is a core LLM concern | Medium -- similar to above |
| **Medium** | Custom/user-defined vulnerability types | Flexibility for domain-specific testing | Medium -- extensible evaluator registry |
| **Medium** | NIST AI RMF + MITRE ATLAS framework mappings | Compliance documentation/reporting | Low -- mapping layer on top of existing categories |
| **Medium** | Business vulnerabilities (IP, Competition) | Important for enterprise customers | Low-Medium -- new evaluator prompts |
| **Low** | Tree-based jailbreaking (parallel branch exploration) | More effective jailbreak discovery | Medium -- new orchestrator mode |
| **Low** | Additional encoding attacks (ROT-13, MathProblem, AdversarialPoetry) | Incremental attack diversity | Low -- add to DeliveryMethod enum + templates |
| **Low** | Attack caching/reuse across runs | Efficiency for repeated testing | Low -- serialization of attack payloads |
| **Low** | YAML configuration file support | UX convenience | Low |

### Where evaluatorq leads (competitive advantages to protect)

| Advantage | Description |
|-----------|-------------|
| **Agent-context-aware attacks** | LLM classifies capabilities, strategies filter by requirements, tool/memory-specific attacks |
| **Dynamic strategy generation** | Runtime LLM-generated novel attack strategies tailored to target agent |
| **Hybrid pipeline** | Combined static dataset + dynamic generation in single run |
| **ORQ platform integration** | Deep integration with ORQ agents, deployments, memory stores, knowledge bases |
| **OpenTelemetry tracing** | Full GenAI semantic conventions for all LLM calls |
| **Granular token tracking** | Per-source (adversarial, target, evaluator) usage and cost tracking |
| **Structured error analysis** | Typed error classification with stage tracking |
| **Multi-target runs** | Built-in sequential multi-target with merged reporting |
| **Memory cleanup** | Automatic cleanup of injected memory entities |
| **Staged artifact saving** | Full pipeline reproducibility via numbered stage outputs |

---

## Sources

- [DeepTeam Documentation](https://www.trydeepteam.com/docs/getting-started)
- [DeepTeam Vulnerabilities](https://www.trydeepteam.com/docs/red-teaming-vulnerabilities)
- [DeepTeam Attacks](https://www.trydeepteam.com/docs/red-teaming-adversarial-attacks)
- [DeepTeam GitHub](https://github.com/confident-ai/deepteam)
- [DeepTeam OWASP](https://www.trydeepteam.com/docs/frameworks-owasp-top-10-for-llms)
- [DeepTeam MITRE ATLAS](https://www.trydeepteam.com/docs/frameworks-mitre-atlas)
