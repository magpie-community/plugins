# magpie-skill-bridge

**magpie 技能库布局体检插件：确认技能实体在 magpie 库里，并看清各 agent 从哪里读到它们。**

**A layout doctor for magpie's skill library: check that skills live in magpie, and see where each agent reads them from.**

[中文](#中文) · [English](#english)

---

## 中文

### 结论先说：不要复制到 `~/.agents/skills`

magpie 的技能库是权威。一旦 `~/.agents/skills` 里出现同名技能实体目录，magpie 会判定「这个技能由 `~/.agents/skills` 管」，把库里的实体搬过去、库里只留链接——所以「magpie 库为主体 + 一份副本」是做不到的，复制会被 magpie 反复抢回去。

正确做法是**让读技能的 agent 直接读 magpie 库**：

| Agent | 怎么指向 magpie 库 |
| --- | --- |
| WorkSpace（OpenCode 内核） | opencode 配置里 `skills.paths = ["/Users/<你>/.config/magpie/library/skills"]`，重启 WorkSpace 生效 |
| DeepSeek Harness | profile 里 `dsh-skill-filesystem` 的 `customSkillDirs` 加上同一个目录 |
| pi / minimax-code / DSH | magpie 自己会写 `~/.pi/agent/skills`、`~/.minimax/skills`、`~/.dsh/skills` 的链接 |

### 这个插件做什么

只读体检，不写入任何文件：

- magpie 库里有几个技能、是不是实体目录；
- `~/.agents/skills` 是否为空（有实体就会让 magpie 抢主体）；
- `~/.dsh/skills`、`~/.pi/agent/skills`、`~/.minimax/skills` 里有多少技能、多少是链接；
- 每个技能勾选了哪些 agent。

### 安装

```bash
magpie plugin add Sonny9527/magpie-skill-bridge
```

工具：`magpie-skill-bridge_doctor`。

### 历史

v0.1.0 做的是「magpie 更新后把技能复制到 `~/.agents/skills`」。实测这条路走不通（magpie 会把复制过去的内容认成主体），v0.2.0 改为只诊断。

---

## English

### Short version: do not copy into `~/.agents/skills`

magpie's skill library is the source of truth. The moment a real skill directory with the same name appears in `~/.agents/skills`, magpie decides that *that* directory owns the skill: it moves the content there and leaves a symlink in the library. So "library owns it, `~/.agents/skills` holds a copy" cannot work — the copy keeps getting adopted.

Point the agents at magpie's library instead:

| Agent | How to point it at the library |
| --- | --- |
| WorkSpace (OpenCode core) | set `skills.paths = ["/Users/<you>/.config/magpie/library/skills"]` in its opencode config, then restart WorkSpace |
| DeepSeek Harness | add the same directory to `customSkillDirs` of `dsh-skill-filesystem` in the profile |
| pi / minimax-code / DSH | magpie writes the links in `~/.pi/agent/skills`, `~/.minimax/skills`, `~/.dsh/skills` itself |

### What this plugin does

Read-only diagnosis, it writes nothing:

- how many skills the magpie library has and whether they are real directories;
- whether `~/.agents/skills` is empty (a real directory there makes magpie take over);
- how many skills and how many links live in `~/.dsh/skills`, `~/.pi/agent/skills`, `~/.minimax/skills`;
- which agents each skill is ticked for.

### Install

```bash
magpie plugin add Sonny9527/magpie-skill-bridge
```

Tool: `magpie-skill-bridge_doctor`.

### History

v0.1.0 copied skills into `~/.agents/skills` after magpie updates. That approach does not hold up (magpie adopts the copies), so v0.2.0 only diagnoses.

---

## License

MIT
