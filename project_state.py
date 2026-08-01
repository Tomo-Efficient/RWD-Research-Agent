"""
Project state — persistent research project management.
Stores project artifacts, conversation history, and agent status.
Uses db.py Redis/SQLite backend for cross-restart persistence.
"""

import json
import datetime
import uuid
from dataclasses import dataclass, field, asdict
from db import _cache_get, _cache_set, _cache_delete


@dataclass
class ProjectState:
    project_id: str = ""
    title: str = ""
    data_dir: str = ""
    data_source: str = ""  # "platform" | "upload"
    uploaded_files: list = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    status: str = "new"  # new|exploring|ideating|analyzing|writing|discussing
    mode: str = "ai_assisted"  # ai_assisted | paper_reproduction

    completed_actions: list = field(default_factory=list)
    conversation: list = field(default_factory=list)

    # Artifacts
    eda_summary: dict | None = None
    ideas_pool: list = field(default_factory=list)
    selected_idea: dict | None = None
    cohort_summary: dict | None = None
    stats_results: dict | None = None
    report: str | None = None

    def __post_init__(self):
        now = datetime.datetime.now().isoformat()
        if not self.created_at: self.created_at = now
        if not self.updated_at: self.updated_at = now
        if not self.project_id: self.project_id = uuid.uuid4().hex[:12]

    def to_dict(self) -> dict:
        return {
            "project_id": self.project_id, "title": self.title,
            "data_dir": self.data_dir, "data_source": self.data_source,
            "uploaded_files": self.uploaded_files,
            "created_at": self.created_at, "updated_at": self.updated_at,
            "status": self.status, "mode": self.mode,
            "completed_actions": self.completed_actions,
            "conversation": self.conversation,
            "eda_summary": self.eda_summary, "ideas_pool": self.ideas_pool,
            "selected_idea": self.selected_idea, "cohort_summary": self.cohort_summary,
            "stats_results": self.stats_results, "report": self.report,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ProjectState":
        return cls(
            project_id=d.get("project_id", ""), title=d.get("title", ""),
            data_dir=d.get("data_dir", ""), data_source=d.get("data_source", ""),
            uploaded_files=d.get("uploaded_files", []),
            created_at=d.get("created_at", ""), updated_at=d.get("updated_at", ""),
            status=d.get("status", "new"), mode=d.get("mode", "ai_assisted"),
            completed_actions=d.get("completed_actions", []),
            conversation=d.get("conversation", []),
            eda_summary=d.get("eda_summary"), ideas_pool=d.get("ideas_pool", []),
            selected_idea=d.get("selected_idea"), cohort_summary=d.get("cohort_summary"),
            stats_results=d.get("stats_results"), report=d.get("report"),
        )

    def add_action(self, tool: str, summary: str):
        self.completed_actions.append({
            "tool": tool, "summary": summary,
            "timestamp": datetime.datetime.now().isoformat(),
        })
        self.touch()

    def add_message(self, role: str, content: str):
        self.conversation.append({
            "role": role, "content": content,
            "timestamp": datetime.datetime.now().isoformat(),
        })
        self.touch()

    def touch(self):
        self.updated_at = datetime.datetime.now().isoformat()

    def context_for_llm(self) -> str:
        """Build a detailed state summary so the agent knows exactly what's done and what's next."""
        lines = []

        # ---- Data ----
        if self.eda_summary:
            s = self.eda_summary
            tables = s.get("table_names", [])
            lines.append(f"## 数据状态: ✅ 已扫描")
            lines.append(f"- 数据表: {len(tables)}张 ({', '.join(tables[:6])})")
            lines.append(f"- 患者数: ≈{s.get('total_patients_estimate','?')}")
            # Key variables
            kv = (s.get("summary", {}) or {}).get("key_clinical_variables", [])
            if kv:
                var_names = [v.get("variable", "") for v in kv[:8] if v.get("variable")]
                lines.append(f"- 关键变量: {', '.join(var_names)}")
        else:
            lines.append(f"## 数据状态: ❌ 未扫描（需要 scan_data）")

        # ---- Ideas ----
        if self.ideas_pool:
            lines.append(f"\n## 选题状态: ✅ 已生成 {len(self.ideas_pool)} 个候选")
            # List top ideas for context
            sorted_ideas = sorted(self.ideas_pool, key=lambda x: x.get("total_score", 0), reverse=True)
            for idea in sorted_ideas[:5]:
                title = idea.get("title") or idea.get("title_cn", "")
                lines.append(f"- {idea.get('id','?')} [评分{idea.get('total_score',0)}] {title[:60]}")
        else:
            lines.append(f"\n## 选题状态: ❌ 未生成（需要 generate_ideas）")

        # ---- Selected Idea (full details) ----
        if self.selected_idea:
            i = self.selected_idea
            lines.append(f"\n## 当前选题: ✅ {i.get('id','')}")
            lines.append(f"- 标题: {i.get('title','') or i.get('title_cn','')}")
            hyp = i.get("hypothesis") or i.get("hypothesis_cn", "")
            if hyp: lines.append(f"- 假设: {hyp}")
            rq = i.get("research_question") or i.get("research_question_cn", "")
            if rq: lines.append(f"- 研究问题: {rq}")
            pico = i.get("pico", {})
            if isinstance(pico, dict) and pico:
                lines.append(f"- PICO: P={pico.get('P','?')} | I={pico.get('I','?')} | C={pico.get('C','?')} | O={pico.get('O','?')}")
            dv = i.get("data_variables", [])
            if dv: lines.append(f"- 所需变量: {', '.join(dv[:8])}")
            method = i.get("suggested_method", "")
            if method: lines.append(f"- 建议方法: {method}")
        elif self.ideas_pool:
            lines.append(f"\n## 当前选题: ❌ 未选择（请用户从 {len(self.ideas_pool)} 个候选中选择）")

        # ---- Cohort ----
        if self.cohort_summary:
            c = self.cohort_summary
            lines.append(f"\n## 队列状态: ✅ 已提取")
            lines.append(f"- 队列规模: {c.get('final_cohort_size',0)} 名患者")
            inc = c.get("variables_included", [])
            if inc: lines.append(f"- 包含变量: {', '.join(inc[:10])}")
            nf = c.get("variables_not_found", [])
            if nf: lines.append(f"- 未找到: {', '.join(nf[:5])}")
            wrn = c.get("warnings", [])
            if wrn: lines.append(f"- 警告: {'; '.join(wrn)}")

        # ---- Stats ----
        if self.stats_results:
            sr = self.stats_results
            lines.append(f"\n## 统计状态: ✅ 已完成")
            lines.append(f"- 样本量: N={sr.get('sample_size','?')}")
            results = sr.get("results", [])[:6]
            for r in results:
                sig = "✓显著" if r.get("significant") else "○不显著"
                label = r.get("label", r.get("test_id", "?"))
                line = f"- {sig} {label}: p={r.get('p_value','N/A')}"
                if r.get("odds_ratio"): line += f", OR={r.get('odds_ratio')}"
                lines.append(line)

        # ---- Report ----
        if self.report:
            lines.append(f"\n## 报告状态: ✅ 已生成 ({len(self.report)}字符)")

        # ---- Next Step ----
        lines.append(f"\n## 下一步建议")
        lines.append(self._next_step())

        return "\n".join(lines)

    def _next_step(self) -> str:
        """Determine the logical next step based on current state."""
        if not self.eda_summary:
            return "数据未扫描 → 调用 scan_data"
        if not self.ideas_pool:
            return "数据已就绪 → 调用 generate_ideas 生成选题"
        if not self.selected_idea:
            return f"选题已生成({len(self.ideas_pool)}个) → 请用户选择一个选题"
        if not self.cohort_summary:
            return f"选题已选定({self.selected_idea.get('id','')}) → 调用 extract_cohort 提取队列"
        if not self.stats_results:
            return "队列已就绪 → 调用 run_statistics 执行统计检验"
        if not self.report:
            return "统计已完成 → 调用 generate_report 生成报告"
        return "全部完成。可回答用户关于报告的问题，或根据反馈修改。"


# ---- Persistence ----

def save_project(p: ProjectState):
    key = f"project:{p.project_id}"
    _cache_set(key, json.dumps(p.to_dict(), ensure_ascii=False, default=str))
    # Update index
    raw = _cache_get("projects_index")
    idx = json.loads(raw) if raw else []
    if p.project_id not in idx:
        idx.insert(0, p.project_id)
        idx = idx[:50]
    _cache_set("projects_index", json.dumps(idx))


def load_project(pid: str) -> ProjectState | None:
    val = _cache_get(f"project:{pid}")
    if val:
        try:
            return ProjectState.from_dict(json.loads(val))
        except (json.JSONDecodeError, TypeError):
            pass
    return None


def delete_project(pid: str):
    _cache_delete(f"project:{pid}")
    raw = _cache_get("projects_index")
    if raw:
        try:
            idx = json.loads(raw)
            idx = [x for x in idx if x != pid]
            _cache_set("projects_index", json.dumps(idx))
        except (json.JSONDecodeError, TypeError):
            pass


def list_projects() -> list[dict]:
    raw = _cache_get("projects_index")
    if not raw: return []
    try:
        ids = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    projects = []
    for pid in ids[:30]:
        p = load_project(pid)
        if p:
            projects.append({
                "project_id": p.project_id, "title": p.title or f"项目{pid[:8]}",
                "status": p.status, "mode": p.mode,
                "created_at": p.created_at, "updated_at": p.updated_at,
            })
    return projects
