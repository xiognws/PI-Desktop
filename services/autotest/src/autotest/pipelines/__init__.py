"""Stage output rules and the model-call ledger.

The stage state machine that used to live here is gone: the agent plans the
order and records its own progress in `workflow_runs` / `workflow_steps`. What
stays is what other layers actually need — the validators that define a usable
stage output, and the audit ledger that records every model call.
"""

from autotest.pipelines.ledger import (
    ensure_agent_call_table,
    hash_text,
    record_agent_call,
)
from autotest.pipelines.validation import (
    MAX_CASES,
    MAX_FUNCTION_POINTS,
    MAX_SCRIPTS,
    PipelineRuleError,
    TARGET_HEADER,
    VALIDATORS,
    VERDICTS,
    validate_analyze,
    validate_author,
    validate_design,
    validate_execute,
    validate_gate,
    validate_judge,
    validate_repair,
    validate_report,
)

__all__ = [
    "MAX_CASES",
    "MAX_FUNCTION_POINTS",
    "MAX_SCRIPTS",
    "PipelineRuleError",
    "TARGET_HEADER",
    "VALIDATORS",
    "VERDICTS",
    "ensure_agent_call_table",
    "hash_text",
    "record_agent_call",
    "validate_analyze",
    "validate_author",
    "validate_design",
    "validate_execute",
    "validate_gate",
    "validate_judge",
    "validate_repair",
    "validate_report",
]
