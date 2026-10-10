"""「/」菜单的命令清单。

GET /api/commands → {"items": [{kind, name, label, desc, keys}]}
  kind=skill   精选的 Claude skill（白名单）
  kind=command 伴读项目自己的 .claude/commands/*.md
伴读自己的功能动作（导读、导图……）不在这里：它们由前端 registry.js 登记，菜单合并时同名的以动作为准。
"""
from pathlib import Path

SKILLS_DIR = Path.home() / ".claude" / "skills"

# 白名单：读书时真有用，并且在伴读的只读权限（Read / Grep / Glob / WebSearch / WebFetch）下实测能正常工作的。
# 需要写文件、跑命令、起子 agent、用 AskUserQuestion 或碰外置盘的 skill 在伴读里会失败，不放
# （hv-analysis 要出 PDF 并派子 agent，fairy 要写外置盘上的 vault，tutor 要 StudyVault，都不行）。
# keys 是额外的搜索词，让「考我」「分析」「quiz」这类说法也能找到。
SKILLS = [
    {"name": "learn", "label": "讲懂再考你", "desc": "先讲清一个概念，再出题检验你是不是真懂",
     "keys": ["学习", "考我", "测验", "出题", "quiz", "study", "teach"]},
    {"name": "deep-reading-analyst", "label": "深度拆解", "desc": "拆这段的论证结构，找漏洞和没说出口的前提",
     "keys": ["分析", "论证", "批判", "精读", "analyze", "critical"]},
    {"name": "grill-me", "label": "追问我", "desc": "你先说自己的理解，Claude 一条条追问，查出漏洞",
     "keys": ["复述", "质疑", "考我", "追问", "苏格拉底", "grill"]},
]


def _frontmatter_desc(text):
    """取 .md 开头 --- 之间的 description；没有就取正文第一行有字的话"""
    lines = text.splitlines()
    body = lines
    if lines and lines[0].strip() == "---":
        end = next((i for i, ln in enumerate(lines[1:], 1) if ln.strip() == "---"), None)
        if end:
            for ln in lines[1:end]:
                if ln.startswith("description:"):
                    return ln.split(":", 1)[1].strip().strip("\"'")
            body = lines[end + 1:]
    for ln in body:
        ln = ln.strip().lstrip("#").strip()
        if ln:
            return ln
    return ""


def _project_commands(root):
    out = []
    for f in sorted((root / ".claude" / "commands").glob("*.md")):
        if len(f.stem.split()) != 1:
            continue  # 带空格的名字在输入框里分不出命令和参数
        try:
            desc = _frontmatter_desc(f.read_text("utf-8"))
        except OSError:
            continue
        out.append({"kind": "command", "name": f.stem, "label": f.stem, "desc": desc[:40], "keys": []})
    return out


def register(routes, ctx):
    def handle(h, params):
        commands = _project_commands(ctx.ROOT)
        taken = {c["name"] for c in commands}  # 同名时项目命令优先，Claude 也是这么认的
        skills = [{"kind": "skill", **s} for s in SKILLS
                  if s["name"] not in taken and (SKILLS_DIR / s["name"] / "SKILL.md").is_file()]
        return h._send_json({"items": skills + commands})

    routes[("GET", "/api/commands")] = handle
