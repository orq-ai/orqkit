"""Red teaming subpackage for evaluatorq.

Provides adaptive red teaming capabilities for testing AI agents against
OWASP security frameworks (ASI and LLM Top 10).

Public API:
    red_team(...)  — Unified entry point for dynamic/static/hybrid red teaming.

Semantic convention throughout this package:
    ``passed=True``  → the agent is RESISTANT (attack failed)
    ``passed=False`` → the agent is VULNERABLE (attack succeeded)
"""

from __future__ import annotations

from typing import Any

from evaluatorq.redteam.contracts import (
    AgentContext,
    TargetConfig,
    AgentInfo,
    AttackEvaluationRow,
    AttackInfo,
    AttackStrategy,
    AttackTechnique,
    CategorySummary,
    DatasetInferenceRow,
    DeliveryMethod,
    DeliveryMethodSummary,
    DynamicAttackResultRow,
    DynamicCategorySummaryRow,
    DynamicErrorAnalysisRow,
    DynamicRunMetadata,
    DynamicSummaryReportRow,
    ErrorTypeDetails,
    EvaluatedRow,
    EvaluatedRowBase,
    EvaluationPayload,
    EvaluationResult,
    ExecutionDetails,
    Framework,
    FrameworkSummary,
    FunctionCall,
    GeneratedPromptRow,
    JobOutputPayload,
    KnowledgeBaseInfo,
    MemoryStoreInfo,
    Message,
    OrchestratorResult,
    Pipeline,
    PipelineLLMConfig,
    RedTeamInput,
    RedTeamReport,
    RedTeamResult,
    ReportSnapshot,
    ReportSummary,
    Scope,
    ScopeSummary,
    Severity,
    SeveritySummary,
    StrategySelectionRow,
    TechniqueSummary,
    TokenUsage,
    ToolCall,
    ToolInfo,
    TurnType,
    TurnTypeSummary,
    UnifiedEvaluationResult,
    Vulnerability,
    VulnerabilityDef,
    VulnerabilityDomain,
    VulnerabilitySummary,
    infer_framework,
    normalize_category,
    normalize_framework,
)

from evaluatorq.redteam.runner import red_team
from evaluatorq.redteam.reports.converters import merge_reports
from evaluatorq.redteam.reports.display import print_report_summary
from evaluatorq.redteam.adaptive.strategy_registry import (
    get_category_info,
    list_available_categories as list_categories,
)
from evaluatorq.redteam.exceptions import BackendError, CancelledError, CredentialError, RedTeamError
from evaluatorq.redteam.hooks import (
    ConfirmPayload,
    DefaultHooks,
    PipelineHooks,
    RichHooks,
)

__all__ = [
    # Entry points
    "red_team",
    "merge_reports",
    "print_report_summary",
    # Category introspection
    "list_categories",
    "get_category_info",
    # Hook system
    "PipelineHooks",
    "DefaultHooks",
    "RichHooks",
    "ConfirmPayload",
    # Core public types
    "RedTeamReport",
    "RedTeamResult",
    "AgentContext",
    "TargetConfig",
    "TokenUsage",
    # Enums
    "TurnType",
    "AttackTechnique",
    "DeliveryMethod",
    "Severity",
    "Scope",
    "Framework",
    "Pipeline",
    # Message models
    "FunctionCall",
    "ToolCall",
    "Message",
    # Input models
    "RedTeamInput",
    # Agent context models
    "ToolInfo",
    "MemoryStoreInfo",
    "KnowledgeBaseInfo",
    # Pipeline config
    "PipelineLLMConfig",
    # Attack models
    "AttackStrategy",
    "AttackInfo",
    # Result models
    "OrchestratorResult",
    "EvaluationResult",
    "UnifiedEvaluationResult",
    "EvaluationPayload",
    "JobOutputPayload",
    "ExecutionDetails",
    "AgentInfo",
    # Vulnerability types
    "Vulnerability",
    "VulnerabilityDef",
    "VulnerabilityDomain",
    "VulnerabilitySummary",
    # Report models
    "CategorySummary",
    "ReportSummary",
    "ReportSnapshot",
    "TechniqueSummary",
    "SeveritySummary",
    "DeliveryMethodSummary",
    "TurnTypeSummary",
    "ScopeSummary",
    "FrameworkSummary",
    # Dynamic pipeline row models
    "EvaluatedRowBase",
    "EvaluatedRow",
    "AttackEvaluationRow",
    "DynamicAttackResultRow",
    "DynamicCategorySummaryRow",
    "ErrorTypeDetails",
    "DynamicErrorAnalysisRow",
    "DynamicRunMetadata",
    "StrategySelectionRow",
    "GeneratedPromptRow",
    "DynamicSummaryReportRow",
    "DatasetInferenceRow",
    # Helper functions
    "normalize_framework",
    "normalize_category",
    "infer_framework",
    # Exceptions
    "RedTeamError",
    "CredentialError",
    "BackendError",
    "CancelledError",
]
