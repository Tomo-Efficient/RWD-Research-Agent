"""
Agent tools — 6 tools with JSON schemas for DeepSeek function calling.
Each tool wraps existing logic from skills.py and llm_utils.py.
"""

import os
from pathlib import Path

from skills import Skill1EDA, SkillCohort, Skill4Stats
from llm_utils import search_papers, generate_report, generate_reproduction_report, _generate_template_ideas

DATA_DIR_DEFAULT = os.environ.get("DATA_DIR", str(Path(__file__).parent / "data"))

# ============================================================
# Tool Schemas
# ============================================================

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "scan_data",
            "description": "扫描数据目录，分析MIMIC-IV脓毒症数据集。返回表结构、变量列表、缺失率、患者数量等EDA信息。必须先调用此工具才能了解可用数据。",
            "parameters": {
                "type": "object",
                "properties": {
                    "data_dir": {"type": "string", "description": "CSV数据目录路径，默认使用平台内置数据"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_ideas",
            "description": "生成候选研究选题。基于EDA数据结果，返回带有PICO框架、变量需求、方法建议和评分的选题列表。",
            "parameters": {
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["ai_assisted", "paper_reproduction"], "description": "ai_assisted=AI生成创新选题，paper_reproduction=搜索可复现论文"},
                    "focus": {"type": "string", "description": "可选，研究方向关键词"},
                },
                "required": ["mode"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_papers",
            "description": "搜索使用MIMIC数据库研究脓毒症的真实论文（2023-2026）。返回论文标题、期刊、核心发现等信息。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "extract_cohort",
            "description": "根据选定idea提取患者队列。关联多张数据表，应用纳排标准，构建分析就绪的数据集。",
            "parameters": {
                "type": "object",
                "properties": {
                    "idea_id": {"type": "string", "description": "要构建队列的idea ID"},
                },
                "required": ["idea_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_statistics",
            "description": "执行统计检验。根据变量类型自动选择方法（Mann-Whitney U、卡方检验、Logistic回归）。返回p值、效应量、显著性判断和临床解读。",
            "parameters": {
                "type": "object",
                "properties": {
                    "idea_id": {"type": "string", "description": "要分析的idea ID"},
                },
                "required": ["idea_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_report",
            "description": "根据统计结果生成完整的中文IMRAD临床研究报告。包含摘要、引言、方法、结果、讨论、参考文献。",
            "parameters": {
                "type": "object",
                "properties": {
                    "idea_id": {"type": "string", "description": "要生成报告的idea ID"},
                    "instructions": {"type": "string", "description": "可选，对报告的特殊要求或修改指示"},
                },
                "required": ["idea_id"],
            },
        },
    },
]

# ============================================================
# Tool Executor
# ============================================================

class ToolExecutor:
    def __init__(self, data_dir: str = DATA_DIR_DEFAULT):
        self.data_dir = data_dir

    def execute(self, tool_name: str, args: dict, project) -> dict:
        method = getattr(self, f"_exec_{tool_name}", None)
        if not method: return {"error": f"Unknown tool: {tool_name}"}
        try:
            return method(args, project)
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"error": str(e), "tool": tool_name}

    def _exec_scan_data(self, args, project) -> dict:
        data_dir = args.get("data_dir") or project.data_dir or self.data_dir
        if not os.path.isdir(data_dir): return {"error": f"数据目录不存在: {data_dir}"}
        skill1 = Skill1EDA(data_dir)
        result = skill1.run()
        return {
            "status": "completed",
            "summary": {
                "data_directory": str(data_dir),
                "tables_found": result.get("tables_found", 0),
                "table_names": result.get("table_names", []),
                "total_patients_estimate": result.get("total_patients_estimate", 0),
                "table_sizes": result.get("table_sizes", {}),
                "relationships": result.get("relationships", [])[:10],
                "quality_summary": result.get("summary", {}),
            },
            "full_result": result,
        }

    def _exec_generate_ideas(self, args, project) -> dict:
        mode = args.get("mode", "ai_assisted")
        if not project.eda_summary:
            data_dir = project.data_dir or self.data_dir
            if os.path.isdir(data_dir):
                result = Skill1EDA(data_dir).run()
                project.eda_summary = result
            else:
                return {"error": "No EDA data. Run scan_data first."}

        if mode == "paper_reproduction":
            result = search_papers(project.eda_summary or {})
            papers = result.get("papers", [])
            return {"status": "completed", "mode": mode, "count": len(papers), "ideas": papers, "total_ideas": len(papers), "_all": papers}

        result = _generate_template_ideas(project.eda_summary or {}, mode)
        ideas = result.get("ideas", [])
        return {"status": "completed", "mode": mode, "count": len(ideas), "ideas": ideas[:10], "total_ideas": len(ideas), "_all": ideas}

    def _exec_search_papers(self, args, project) -> dict:
        if not project.eda_summary:
            data_dir = project.data_dir or self.data_dir
            if os.path.isdir(data_dir):
                project.eda_summary = Skill1EDA(data_dir).run()
        result = search_papers(project.eda_summary or {})
        return {"status": "completed", "count": len(result.get("papers", [])), "papers": result.get("papers", [])}

    def _exec_extract_cohort(self, args, project) -> dict:
        idea_id = args.get("idea_id", "")
        idea = self._find_idea(idea_id, project)
        if not idea: return {"error": f"Idea {idea_id} not found"}
        project.selected_idea = idea
        cohort = SkillCohort(project.data_dir or self.data_dir)
        result = cohort.run(idea, project.eda_summary or {})
        return {
            "status": "completed" if result.get("status") != "error" else "error",
            "idea_id": idea_id,
            "idea_title": idea.get("title") or idea.get("title_cn", ""),
            "final_cohort_size": result.get("final_cohort_size", 0),
            "variables_included": result.get("variables_included", []),
            "variables_not_found": result.get("variables_not_found", []),
            "steps": result.get("steps", []),
            "warnings": result.get("warnings", []),
            "output_file": result.get("output_file", ""),
        }

    def _exec_run_statistics(self, args, project) -> dict:
        idea_id = args.get("idea_id", "")
        idea = self._find_idea(idea_id, project)
        if not idea: return {"error": f"Idea {idea_id} not found"}
        skill4 = Skill4Stats(project.data_dir or self.data_dir)
        result = skill4.run(idea, project.eda_summary or {})
        summary_lines = []
        for r in result.get("results", []):
            sig = "✓" if r.get("significant") else "○"
            line = f"{sig} {r.get('label','?')}: p={r.get('p_value','N/A')}"
            if r.get("odds_ratio"): line += f", OR={r.get('odds_ratio')}"
            summary_lines.append(line)
        return {
            "status": "completed", "idea_id": idea_id,
            "sample_size": result.get("sample_size", 0),
            "significant_count": sum(1 for r in result.get("results", []) if r.get("significant")),
            "results_summary": "\n".join(summary_lines),
            "results": result.get("results", []),
            "interpretation": result.get("interpretation", ""),
            "execution_log": result.get("execution_log", []),
        }

    def _exec_generate_report(self, args, project) -> dict:
        idea_id = args.get("idea_id", "")
        instructions = args.get("instructions", "")
        idea = self._find_idea(idea_id, project)
        if not idea: return {"error": f"Idea {idea_id} not found"}
        if not project.stats_results: return {"error": "No stats results. Run run_statistics first."}

        if project.mode == "paper_reproduction":
            manuscript = generate_reproduction_report(
                eda_report=project.eda_summary or {},
                selected_idea=idea,
                stats_results=project.stats_results,
            )
        else:
            manuscript = generate_report(
                eda_report=project.eda_summary or {},
                ideas={"ideas": [idea]},
                selected_idea=idea,
                stats_results=project.stats_results,
            )
        if instructions:
            manuscript = f"(修改要求: {instructions})\n\n{manuscript}"
        return {"status": "completed", "idea_id": idea_id, "manuscript_length": len(manuscript or ""), "manuscript": manuscript}

    def _find_idea(self, idea_id: str, project) -> dict | None:
        for idea in project.ideas_pool:
            if idea.get("id") == idea_id: return idea
        if project.selected_idea and project.selected_idea.get("id") == idea_id:
            return project.selected_idea
        return None
