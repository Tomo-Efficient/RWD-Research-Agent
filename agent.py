"""
Research Agent — ReAct loop with Tool Calling + Streaming text responses.
Uses non-streaming for tool-call decisions, streaming for final text reply.
"""

import json
from typing import Generator

from llm_client import get_api_key
from project_state import ProjectState, save_project
from tools import ToolExecutor, TOOLS
from memory import build_memory_context, record_completed_run

SYSTEM_PROMPT = """你是临床研究助手，帮助研究者使用 MIMIC-IV 脓毒症 ICU 数据库完成临床研究。

## 你的角色
你是研究执行者，任务是推进研究流程：扫描数据 → 选题 → 队列 → 统计 → 报告。

## 你的工具箱（6个工具，各司其职）
- scan_data: 扫描数据目录。仅当数据未扫描时使用。
- generate_ideas: 生成候选研究选题。仅当尚无选题时使用。
- search_papers: 搜索已发表论文。仅当用户明确要求查找文献、或选择论文复现模式时使用。
- extract_cohort: 提取患者队列。根据选定的idea从数据库中提取患者和变量。
- run_statistics: 执行统计检验。计算p值、OR、显著性等。
- generate_report: 生成中文IMRAD研究报告。仅当统计完成后使用。

## 重要限制
- 你无法计算衍生变量（如比值、变异系数、评分）。如果用户要求计算某个指标，告诉他该指标的数据可能已经存在于实验室指标中，或者在选题时选择包含该变量的idea。
- search_papers 仅用于文献检索，不要用它来处理数据分析请求。

## 工作方式
每次收到用户消息时：
1. 先看「当前项目状态」——它明确告诉你什么已完成、什么还没做
2. 如果用户只是询问信息（如"介绍一下选题"），直接在对话中回答，不要调用工具
3. 如果项目状态显示下一步该做什么，且用户表达了推进意愿，调用对应工具
4. 如果用户的要求无法用现有工具完成，诚实说明限制并建议替代方案

## 核心原则
- 说中文，保持专业简洁
- 讨论结果时引用具体数字（p值、样本量、OR）
- 不要重复已完成的步骤。项目状态里标了✅的事情，绝对不要再做
- 每次只调用1个工具
- 工具之间不要混淆：数据提取用extract_cohort，统计检验用run_statistics，文献用search_papers"""


class ResearchAgent:
    def __init__(self):
        self.executor = ToolExecutor()

    def _client(self):
        key = get_api_key()
        if not key: return None
        from openai import OpenAI
        return OpenAI(api_key=key, base_url="https://api.deepseek.com")

    def _available_tools(self, project: ProjectState) -> list[dict]:
        done = set()
        if project.eda_summary: done.add("scan_data")
        if project.ideas_pool: done.add("generate_ideas")
        if project.cohort_summary: done.add("extract_cohort")
        if project.stats_results: done.add("run_statistics")
        if project.report: done.add("generate_report")

        needs_cohort = {"run_statistics", "generate_report"}
        needs_ideas = {"extract_cohort"}
        needs_eda = {"generate_ideas", "search_papers"}

        available = []
        for tool in TOOLS:
            name = tool["function"]["name"]
            if name in done and name != "generate_report": continue
            if name in needs_eda and not project.eda_summary: continue
            if name in needs_ideas and not project.selected_idea: continue
            if name in needs_cohort and not project.cohort_summary: continue
            if name == "generate_report" and not project.stats_results: continue
            available.append(tool)

        return available if available else TOOLS

    VAGUE_COMMANDS = {"继续", "下一步", "go on", "next", "继续吧", "然后呢", "接下来", "好的", "ok", "嗯", "开始", "帮我做", "go", "继续分析", "继续做"}

    def _is_vague_continue(self, msg: str) -> bool:
        return msg.strip().lower() in self.VAGUE_COMMANDS or msg.strip() in self.VAGUE_COMMANDS

    def _auto_next_tool(self, project: ProjectState) -> tuple[str, dict] | None:
        """If project state clearly indicates the next step, return (tool_name, args).
        This bypasses LLM uncertainty for linear workflow progression."""
        if not project.eda_summary:
            return ("scan_data", {})
        if not project.ideas_pool:
            return ("generate_ideas", {"mode": "ai_assisted"})
        if not project.selected_idea:
            return None  # Need user to pick an idea, can't auto-proceed
        if not project.cohort_summary:
            return ("extract_cohort", {"idea_id": project.selected_idea.get("id", "")})
        if not project.stats_results:
            return ("run_statistics", {"idea_id": project.selected_idea.get("id", "")})
        if not project.report:
            return ("generate_report", {"idea_id": project.selected_idea.get("id", "")})
        return None  # All done

    def _augment_message(self, project: ProjectState, user_message: str) -> str:
        if self._is_vague_continue(user_message):
            next_step = project._next_step() if hasattr(project, '_next_step') else ""
            return f"{user_message}\n\n[系统提示: 当前项目状态下，下一步应该是: {next_step}。请直接调用对应工具。]"
        return user_message

    def chat(self, project: ProjectState, user_message: str) -> Generator[dict, None, None]:
        client = self._client()
        if not client:
            yield {"event": "error", "message": "LLM API key not configured"}
            return

        augmented = self._augment_message(project, user_message)
        project.add_message("user", user_message)

        messages = self._build_messages(project)
        for i in range(len(messages) - 1, -1, -1):
            if messages[i]["role"] == "user":
                messages[i]["content"] = augmented
                break

        tools = self._available_tools(project)

        # Fast path: if user says "继续" and next step is clear, skip LLM and execute directly
        if self._is_vague_continue(user_message):
            auto = self._auto_next_tool(project)
            if auto:
                tool_name, tool_args = auto
                yield {"event": "tool_call", "tool": tool_name, "args": tool_args}
                result = self.executor.execute(tool_name, tool_args, project)
                self._update_project(project, tool_name, result)
                project.add_action(tool_name, self._action_summary(tool_name, result))
                yield {"event": "tool_result", "tool": tool_name, "result": result}
                save_project(project)

                # Add tool execution to message context
                summary = self._summarize(tool_name, result)
                messages.append({
                    "role": "assistant", "content": f"调用 {tool_name}",
                    "tool_calls": [{"id": "auto", "type": "function",
                                    "function": {"name": tool_name, "arguments": json.dumps(tool_args)}}],
                })
                messages.append({"role": "tool", "tool_call_id": "auto",
                                 "content": json.dumps(summary, ensure_ascii=False, default=str)})
                tools = self._available_tools(project)

        # Phase 1: Decision loop (non-streaming — need full response to parse tool_calls)
        for iteration in range(8):
            try:
                response = client.chat.completions.create(
                    model="deepseek-chat", messages=messages,
                    tools=tools, temperature=0.3, max_tokens=4096,
                )
            except Exception as e:
                yield {"event": "error", "message": f"LLM调用失败: {e}"}
                return

            choice = response.choices[0]
            msg = choice.message

            # Tool calls → execute and loop
            if msg.tool_calls:
                tool_msgs = []
                for tc in msg.tool_calls:
                    tool_name = tc.function.name
                    try:
                        tool_args = json.loads(tc.function.arguments)
                    except json.JSONDecodeError:
                        tool_args = {}

                    yield {"event": "tool_call", "tool": tool_name, "args": tool_args}

                    result = self.executor.execute(tool_name, tool_args, project)
                    self._update_project(project, tool_name, result)

                    summary = self._summarize(tool_name, result)
                    tool_msgs.append({"tool_call_id": tc.id, "content": json.dumps(summary, ensure_ascii=False, default=str)})

                    project.add_action(tool_name, self._action_summary(tool_name, result))
                    yield {"event": "tool_result", "tool": tool_name, "result": result}

                save_project(project)

                messages.append({
                    "role": "assistant", "content": msg.content or "",
                    "tool_calls": [
                        {"id": tc.id, "type": "function",
                         "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                        for tc in msg.tool_calls
                    ],
                })
                for tm in tool_msgs:
                    messages.append({"role": "tool", "tool_call_id": tm["tool_call_id"], "content": tm["content"]})

                tools = self._available_tools(project)
                continue

            # Text response (no tool calls) → re-call with streaming to get token-by-token output
            if msg.content:
                yield from self._stream_response(client, messages, project)
            break

        if iteration >= 7:
            yield {"event": "warning", "message": "达到最大工具调用次数，请发送新消息继续"}

    def _stream_response(self, client, messages: list, project: ProjectState) -> Generator[dict, None, None]:
        """Re-call the LLM with stream=True to get token-by-token output."""
        try:
            stream = client.chat.completions.create(
                model="deepseek-chat", messages=messages,
                temperature=0.3, max_tokens=4096, stream=True,
            )
        except Exception as e:
            yield {"event": "error", "message": f"Stream error: {e}"}
            return

        full_text = ""
        for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                full_text += delta.content
                yield {"event": "token", "text": delta.content}

        if full_text:
            project.add_message("assistant", full_text)
            save_project(project)

    def _build_messages(self, project: ProjectState) -> list:
        msgs = [{"role": "system", "content": SYSTEM_PROMPT}]

        # Inject cross-project memory context
        mem_ctx = build_memory_context(project.title)
        if mem_ctx:
            msgs.append({"role": "system", "content": mem_ctx})

        ctx = project.context_for_llm()
        if ctx:
            msgs.append({"role": "system", "content": f"## 当前项目状态（请仔细阅读，不要重复已完成步骤）\n\n{ctx}"})
        for m in project.conversation[-30:]:
            role = m.get("role", "user")
            if role == "tool": continue
            if role == "assistant" and m.get("tool_calls"): continue
            msgs.append({"role": role, "content": m.get("content", "")})
        return msgs

    def _update_project(self, project: ProjectState, tool_name: str, result: dict):
        if result.get("status") == "error" or "error" in result: return
        if tool_name == "scan_data":
            project.eda_summary = result.get("full_result") or result.get("summary", {})
            project.status = "exploring"
        elif tool_name in ("generate_ideas", "search_papers"):
            all_items = result.get("_all", result.get("ideas", result.get("papers", [])))
            if all_items: project.ideas_pool = all_items
            project.mode = result.get("mode", project.mode)
            project.status = "ideating"
        elif tool_name == "extract_cohort":
            project.cohort_summary = result; project.status = "analyzing"
        elif tool_name == "run_statistics":
            project.stats_results = result; project.status = "analyzing"
            record_completed_run(project)
        elif tool_name == "generate_report":
            project.report = result.get("manuscript", ""); project.status = "writing"
            record_completed_run(project)

    def _summarize(self, tool_name: str, result: dict) -> dict:
        if "error" in result: return result
        if tool_name == "scan_data":
            return result.get("summary", result)
        if tool_name in ("generate_ideas", "search_papers"):
            items = result.get("ideas", result.get("papers", []))
            return {"status": "completed", "count": len(items),
                    "items": [{k: v for k, v in i.items()
                               if k in ("id", "title", "title_cn", "hypothesis", "hypothesis_cn",
                                        "total_score", "suggested_method", "pico")}
                              for i in items[:10]]}
        if tool_name == "extract_cohort":
            return {"status": result.get("status"), "final_cohort_size": result.get("final_cohort_size"),
                    "variables_included": result.get("variables_included", []),
                    "warnings": result.get("warnings", [])}
        if tool_name == "run_statistics":
            return {"status": "completed", "sample_size": result.get("sample_size"),
                    "significant_count": result.get("significant_count"),
                    "results_summary": result.get("results_summary"),
                    "results": (result.get("results") or [])[:10],
                    "interpretation": (result.get("interpretation") or "")[:1200]}
        if tool_name == "generate_report":
            return {"status": "completed", "manuscript_length": result.get("manuscript_length"),
                    "preview": (result.get("manuscript") or "")[:1500]}
        return result

    def _action_summary(self, tool_name: str, result: dict) -> str:
        if result.get("error"): return f"失败: {result['error']}"
        m = {
            "scan_data": lambda r: f"扫描完成: {r.get('summary',{}).get('tables_found','?')}张表, ≈{r.get('summary',{}).get('total_patients_estimate','?')}患者",
            "generate_ideas": lambda r: f"生成{r.get('count',0)}个选题",
            "search_papers": lambda r: f"找到{r.get('count',0)}篇论文",
            "extract_cohort": lambda r: f"队列: {r.get('final_cohort_size',0)}患者",
            "run_statistics": lambda r: f"统计: N={r.get('sample_size','?')}, {r.get('significant_count',0)}项显著",
            "generate_report": lambda r: f"报告: {r.get('manuscript_length',0)}字符",
        }
        fn = m.get(tool_name)
        return fn(result) if fn else f"{tool_name}完成"


agent = ResearchAgent()
