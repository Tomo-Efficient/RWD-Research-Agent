"""
Memory system for the Research Agent.
Three tiers: working → episodic → semantic.
Uses existing db.py Redis/SQLite backend for persistence.
"""

import json
import datetime
from db import _cache_get, _cache_set, _cache_delete


# ============================================================
# Tier 1: Working Memory (per-project, already in project_state.py)
# ============================================================
# - Current conversation history
# - Project artifacts (EDA, ideas, cohort, stats, report)
# Managed by project_state.py, NOT duplicated here.


# ============================================================
# Tier 2: Episodic Memory (user-level, cross-project)
# ============================================================

def save_project_summary(project_state) -> dict:
    """After a project reaches a milestone, save a structured summary
    that can be recalled in future sessions."""
    summary = {
        "project_id": project_state.project_id,
        "title": project_state.title,
        "status": project_state.status,
        "mode": project_state.mode,
        "updated_at": project_state.updated_at,
        "findings": _extract_findings(project_state),
    }

    # Store in a persistent list
    key = "memory:project_summaries"
    raw = _cache_get(key)
    summaries = json.loads(raw) if raw else []

    # Update or append
    existing = [s for s in summaries if s.get("project_id") == summary["project_id"]]
    if existing:
        summaries = [s if s.get("project_id") != summary["project_id"] else summary for s in summaries]
    else:
        summaries.insert(0, summary)

    summaries = summaries[:30]  # Keep last 30
    _cache_set(key, json.dumps(summaries, ensure_ascii=False, default=str))
    return summary


def get_past_projects(limit: int = 10) -> list[dict]:
    """Retrieve summaries of past projects for context injection."""
    raw = _cache_get("memory:project_summaries")
    if not raw: return []
    try:
        return json.loads(raw)[:limit]
    except (json.JSONDecodeError, TypeError):
        return []


def _extract_findings(project_state) -> dict:
    """Extract key findings from project state for memory storage."""
    findings = {}
    if project_state.stats_results:
        sig_results = [r for r in project_state.stats_results.get("results", []) if r.get("significant")]
        findings["significant_count"] = len(sig_results)
        findings["key_results"] = [
            {"label": r.get("label", ""), "p_value": r.get("p_value"),
             "odds_ratio": r.get("odds_ratio")}
            for r in sig_results[:5]
        ]
        findings["sample_size"] = project_state.stats_results.get("sample_size")

    if project_state.selected_idea:
        idea = project_state.selected_idea
        findings["research_topic"] = idea.get("title") or idea.get("title_cn", "")
        pico = idea.get("pico", {})
        if isinstance(pico, dict):
            findings["pico"] = {k: str(v)[:80] for k, v in pico.items() if v}

    if project_state.cohort_summary:
        findings["cohort_size"] = project_state.cohort_summary.get("final_cohort_size")

    return findings


# ============================================================
# Tier 3: Semantic Memory (agent-level, accumulated knowledge)
# ============================================================

def save_user_preference(key: str, value):
    """Save a user preference (e.g. preferred language, common methods)."""
    raw = _cache_get("memory:user_prefs")
    prefs = json.loads(raw) if raw else {}
    prefs[key] = value
    _cache_set("memory:user_prefs", json.dumps(prefs, ensure_ascii=False))


def get_user_preferences() -> dict:
    raw = _cache_get("memory:user_prefs")
    return json.loads(raw) if raw else {}


def save_research_pattern(pattern: dict):
    """Record a research pattern for future reference.
    e.g. {'type': 'frequent_variable', 'variable': 'lab_lactate', 'count': 5}"""
    key = "memory:research_patterns"
    raw = _cache_get(key)
    patterns = json.loads(raw) if raw else []
    patterns.append({**pattern, "timestamp": datetime.datetime.now().isoformat()})
    patterns = patterns[-50:]
    _cache_set(key, json.dumps(patterns, ensure_ascii=False, default=str))


def get_research_patterns() -> list[dict]:
    raw = _cache_get("memory:research_patterns")
    return json.loads(raw) if raw else []


def record_completed_run(project_state):
    """Called when a project reaches 'writing' or 'discussing' status.
    Records patterns for future agent context."""
    findings = _extract_findings(project_state) if hasattr(project_state, 'stats_results') else {}

    # Track frequently used variables
    if project_state.selected_idea:
        for var in project_state.selected_idea.get("data_variables", [])[:5]:
            if var.startswith("lab_"):
                save_research_pattern({"type": "used_variable", "variable": var})

    # Track methods
    method = project_state.selected_idea.get("suggested_method", "") if project_state.selected_idea else ""
    if method:
        save_research_pattern({"type": "used_method", "method": method})

    # Save project summary
    save_project_summary(project_state)


# ============================================================
# Memory Context Builder (for agent system prompt injection)
# ============================================================

def build_memory_context(project_title: str = "") -> str:
    """Build a concise memory summary to inject into the agent's system prompt.
    Gives the agent awareness of past projects and user preferences."""
    lines = ["## 记忆（跨项目上下文）"]

    # Past projects
    past = get_past_projects(5)
    if past:
        lines.append("\n### 历史项目")
        for p in past:
            f = p.get("findings", {})
            topic = f.get("research_topic", p.get("title", "未命名"))[:50]
            sig = f.get("significant_count", "?")
            lines.append(f"- {topic}: {sig}项显著, N={f.get('sample_size','?')}")

    # User preferences
    prefs = get_user_preferences()
    if prefs:
        lines.append("\n### 用户偏好")
        for k, v in prefs.items():
            lines.append(f"- {k}: {v}")

    # Research patterns
    patterns = get_research_patterns()
    if patterns:
        vars_used = [p["variable"] for p in patterns if p.get("type") == "used_variable"]
        if vars_used:
            # Count frequencies
            from collections import Counter
            top_vars = Counter(vars_used).most_common(5)
            lines.append("\n### 常用变量")
            lines.append(", ".join([f"{v}({c}次)" for v, c in top_vars]))

    return "\n".join(lines) if len(lines) > 1 else ""
