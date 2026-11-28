#!/usr/bin/env python3
"""真实 MCP 客户端端到端测试：stdio 拉起 mcp_server.py，走 MCP 协议调用工具。
验证：initialize/instructions、20工具/4资源/1提示、euler 结构化输出、aos 拒绝路径。"""
import asyncio
import colorsys
import json
import sys
import tempfile
from pathlib import Path

from PIL import Image
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SCRIPTS = Path(__file__).resolve().parent
SERVER = SCRIPTS / "mcp_server.py"


def make_hue_sample(path):
    """合成一张主色相约105°的彩色图，供 euler_hue 便携测试（不依赖外部素材）。"""
    img = Image.new("RGB", (160, 160))
    px = img.load()
    for y in range(160):
        for x in range(160):
            h = (105 + (x % 20) - 10) / 360
            r, g, b = colorsys.hsv_to_rgb(h, 0.6, 0.8)
            px[x, y] = (int(r * 255), int(g * 255), int(b * 255))
    img.save(path)

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def tool_json(result):
    """从 MCP call_tool 结果取结构化 dict（structuredContent 或 content text）。"""
    sc = getattr(result, "structuredContent", None)
    if sc:
        return sc
    for block in result.content:
        txt = getattr(block, "text", None)
        if txt:
            try:
                return json.loads(txt)
            except Exception:
                return {"_text": txt}
    return {}


async def main():
    params = StdioServerParameters(command=sys.executable, args=[str(SERVER)])
    tmp = tempfile.mkdtemp(prefix="aos_mcp_test_")
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            instr = getattr(init, "instructions", "") or ""
            check("initialize 成功", True)
            check("instructions 含 KERNEL 红线", "红线" in instr or "拒绝" in instr, f"len={len(instr)}")

            tools = await session.list_tools()
            names = [t.name for t in tools.tools]
            check("工具数=21", len(names) == 21, f"got {len(names)}: {names}")
            check("含 aos_verdict/euler_hue/aos_delivery_gate",
                  "aos_verdict" in names and "euler_hue" in names and "aos_delivery_gate" in names)

            resources = await session.list_resources()
            check("资源数=4", len(resources.resources) == 4, f"got {len(resources.resources)}")
            prompts = await session.list_prompts()
            check("提示含 aesthetic_loop", any(p.name == "aesthetic_loop" for p in prompts.prompts))

            # euler 结构化输出
            sample = Path(tmp) / "hue_sample.png"
            make_hue_sample(sample)
            r = tool_json(await session.call_tool("euler_hue", {"image": str(sample)}))
            check("euler_hue 结构化(彩色且R∈[0,1])", r.get("chromatic") is True and 0 <= r.get("R", -1) <= 1, f"R={r.get('R')}")
            pal = tool_json(await session.call_tool("euler_palette", {"base_hue": 210, "scheme": "triadic"}))
            colors = pal.get("colors", [])
            check("euler_palette triadic 3色", isinstance(colors, list) and len(colors) == 3, f"{pal}")

            # aos 闭环 + 拒绝路径
            r = tool_json(await session.call_tool("aos_init", {"project": tmp}))
            check("aos_init ok", r.get("ok") is True, r.get("stderr", ""))
            r = tool_json(await session.call_tool("aos_status", {"project": tmp}))
            check("aos_status ok", r.get("ok") is True)
            # 空项目直接签 pass → 必须拒绝
            r = tool_json(await session.call_tool("aos_verdict",
                          {"project": tmp, "tech": "pass", "aesthetic": "pass", "reason": "看起来不错想直接通过"}))
            refused_text = r.get("stdout", "") + r.get("stderr", "")
            check("空项目 verdict 被拒绝", r.get("ok") is False and "拒绝" in refused_text,
                  f"ok={r.get('ok')} text={refused_text[:60]}")
            # 合模板命题 → ok
            r = tool_json(await session.call_tool("aos_propose",
                          {"project": tmp, "text": "面向财务负责人完成月度对账呈现可托付的克制通过精确数字的层级差"}))
            check("合模板 propose ok", r.get("ok") is True, r.get("stdout", "")[:80])
            # 交付门禁：未过项目必须 passed=false
            r = tool_json(await session.call_tool("aos_delivery_gate", {"project": tmp}))
            check("交付门禁拦截未完成项目", r.get("passed") is False and len(r.get("blockers", [])) > 0,
                  f"passed={r.get('passed')}")

    print(f"\n=== MCP 端到端：{PASS} 通过 / {FAIL} 失败 ===")
    return FAIL


if __name__ == "__main__":
    try:
        fail = asyncio.run(asyncio.wait_for(main(), timeout=120))
    except Exception as e:
        print("FATAL:", repr(e))
        fail = 1
    sys.exit(fail)