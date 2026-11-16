<div align="center">
<a name="readme-top"></a>

<img src="page/kago-icon.png" alt="Kago basket icon" width="160" height="160">

# Kago

Agent skills, tailored to each project.

Kago is a Magpie plugin that selects skills from shared sources and deploys each project's set from one Git-tracked manifest.

**English** · [简体中文](README-zh.md)

<br/>

<a href="https://github.com/ffy6511/Kago/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ffy6511/Kago?style=for-the-badge&logo=github&color=E3B341&labelColor=20242D"></a>
<a href="https://github.com/ffy6511/Kago/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/ffy6511/Kago?style=for-the-badge&logo=git&color=1B54E8&labelColor=20242D"></a>
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/ffy6511/Kago?style=for-the-badge&logo=opensourceinitiative&logoColor=white&color=34D399&labelColor=20242D"></a>
<a href="https://nodejs.org"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=20242D"></a>
<a href="docs/integration.md"><img alt="Tested with Magpie 0.1.3037" src="https://img.shields.io/badge/Magpie-0.1.3037-8B5CF6?style=for-the-badge&labelColor=20242D"></a>

</div>

<details>
<summary><kbd>Table of contents</kbd></summary>

- [Features](#features)
- [Install](#install)
- [Walkthrough](#walkthrough)
- [Update and remove skills](#manage-skills)
- [Manifest](#manifest)
- [File safety](#file-safety)
- [CLI](#cli)
- [Development](#development)
- [Docs](#docs)
- [License](#license)

<br/>

</details>

<a name="features"></a>

## Features

- **Single source of truth** — one `skills.manifest.yaml` per repository defines the sources, agents and deployment method.
- **Per-project precision** — every project gets exactly the skills it needs; shared agent directories are deduplicated automatically.
- **Link or copy** — relative links by default; copy for restricted agents or repositories that need self-contained files.
- **Ownership safeguards** — fingerprints protect deployed outputs, an exact replacement is adopted, and local edits block cleanup.
- **Linked-folder repair** — replace a whole-folder `.agents/skills` symlink with a real folder after an explicit confirmation.
- **GUI and CLI, one engine** — preview in Magpie, automate from the CLI; the same planner, locking and recovery logic.

<a name="install"></a>

## Install

Install the published plugin directly:

```sh
magpie plugin add @jhzhuo/kago
```

Open **Magpie → Plugins → Kago**. The local service starts automatically; its default port is `3498` (configurable in the plugin options). Remove the package with `magpie plugin rm @jhzhuo/kago`.

### Install from source

```sh
git clone https://github.com/ffy6511/Kago.git
cd Kago
bun install --frozen-lockfile
```

Install the local plugin:

```sh
magpie plugin add /absolute/path/to/Kago
```

A source-path install uses this checkout, so reload the plugin after code changes. Remove it with `magpie plugin rm /absolute/path/to/Kago`.

<a name="walkthrough"></a>

## Walkthrough

This example equips a `paper-notes` Git project with two skills from a shared `team-skills` folder. Each skill is a folder containing a `SKILL.md` whose frontmatter includes a matching `name` and a nonempty `description`.

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <a href="docs/images/select-en.png"><img src="docs/images/select-en.png" alt="1. Select skills: Choose project defaults and per-skill agent overrides." width="550" height="350"></a><br>
      <strong>1. Select skills</strong><br>
      <sub>Choose project defaults and per-skill agent overrides.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <a href="docs/images/preview-en.png"><img src="docs/images/preview-en.png" alt="2. Preview the paths: Review the exact changes before Sync writes anything." width="550" height="350"></a><br>
      <strong>2. Preview the paths</strong><br>
      <sub>Review the exact changes before Sync writes anything.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <a href="docs/images/existing-en.png"><img src="docs/images/existing-en.png" alt="3. Inspect the deployment: Verify the actual links, agent folders and source targets." width="550" height="350"></a><br>
      <strong>3. Inspect the deployment</strong><br>
      <sub>Verify the actual links, agent folders and source targets.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <a href="docs/images/reader-en.png"><img src="docs/images/reader-en.png" alt="4. Read and edit: Open SKILL.md; only an explicit Save writes the file." width="550" height="350"></a><br>
      <strong>4. Read and edit</strong><br>
      <sub>Open SKILL.md; only an explicit Save writes the file.</sub>
    </td>
  </tr>
</table>

```text
workspace/
├── team-skills/
│   ├── dev/code-review/SKILL.md
│   ├── research/citation-check/SKILL.md
│   ├── research/paper-md-ingest/SKILL.md
│   └── writing/writing-style/SKILL.md
└── paper-notes/
    └── .git/
```

### 1. Register a source and a project

Open **Kago** in Magpie's sidebar. In the **…** menu, choose **Add source** and enter the absolute path to `team-skills`. Register the root containing the category folders; Kago scans them recursively. **Read Magpie Library** adds Magpie's existing skill Library as a source.

Click **+** beside the project selector and enter the absolute path to `paper-notes`. It must be a Git repository. Leave the optional manifest path blank to use `skills.manifest.yaml` in its root. Click **Sync** to deploy the selected skills.

### 2. Select skills and target agents

1. Select **paper-notes** at the top and **team-skills** as the source. Categories and search narrow the list.
2. Enable **Cursor** and **Codex** in the top agent row. These defaults apply to skills without an override.
3. Check **paper-md-ingest** and **writing-style**. Clicking a row toggles selection; clicking its name opens the document.
4. In the `writing-style` row, turn off Cursor and Codex, then enable **Claude Code**. The reset control restores the project defaults.

Choose **Link** for relative symlinks back to the source. Choose **Copy** when the agent needs files inside the workspace, such as in a restricted or remote environment. Copied files receive later source changes on the next sync. An explicit empty agent selection deploys that skill nowhere.

Selections remain in the draft until Sync. **Cancel changes** restores the baseline captured when the project was opened or last synced, without writing project files.

### 3. Preview the exact paths

Click **Preview** to open **Changes**. Here, `paper-md-ingest` creates one `.agents/skills` entry shared by Cursor and Codex; `writing-style` creates one `.claude/skills` entry. Preview leaves the manifest and deployment files untouched.

Review **Create**, **Update**, **Remove** and **Conflict** rows before continuing. A conflict names the path that needs attention. The **Manifest** tab shows the YAML behind the current selection; you can also edit it there.

### 4. Sync and inspect the result

Click **Sync**. Kago validates the current draft, plans the filesystem changes, writes `skills.manifest.yaml` and deploys the selected skills. The header then shows **Synced**. Open **Existing** to inspect the actual links or folders in the project:

```text
paper-notes/
├── skills.manifest.yaml
├── .agents/skills/
│   └── paper-md-ingest → ../../../team-skills/research/paper-md-ingest
└── .claude/skills/
    └── writing-style → ../../../team-skills/writing/writing-style
```

Commit the manifest to your project. Kago adds its generated deployment paths to its own managed `.gitignore` block. Previewing the same configuration again shows **Unchanged** entries.

### 5. Read or edit a skill

Click a skill name in **Skills** or **Existing** to open its document. The header's file picker switches between files within that skill. **Edit → Save** writes the selected file; canceling or closing protects unsaved edits.

Editing a source skill or a deployed link changes the source file. Editing a deployed real folder changes that folder. A deployed copy receives source edits only after another sync, and local edits to that copy block replacement until resolved.

<a name="manage-skills"></a>

## Update and remove skills

- **Add or change a selection:** check the skills, adjust agents, then **Preview → Sync**. Use **… → Sync all projects** to apply the saved manifests of all registered projects.
- **Remove a managed deployment:** uncheck a skill and preview its removal, then Sync. Cleanup removes only unchanged outputs owned by Kago. Local modifications and unmanaged files are protected.
- **Understand badges:** **Exists** means a matching source link or intact owned copy is present. Unchecking an existing skill changes its badge to **Will remove**. An unmanaged link may be detected as existing; detection does not grant Kago ownership or permit automatic deletion.
- **Delete a specific workspace entry:** the trash action in **Existing** confirms the exact path. Deleting a link preserves its target; deleting a real folder removes that folder and its contents. This does not update the manifest, so a selected skill is recreated by a later sync.
- **Stop managing a project:** **… → Unregister** keeps deployed files and relinquishes Kago's ownership.

If Preview reports a whole-folder `.agents/skills` symlink, use **Fix** only after reviewing the named link and target. It replaces that link with a real folder and preserves the target. Review the new plan before syncing. For other ownership and recovery cases, see [CLI and recovery](docs/cli.md).

<a name="manifest"></a>

## Manifest

```yaml
version: 1
ssot: ../team-skills
defaults:
  agents: [cursor, codex]
deploy:
  method: link
skills:
  - name: paper-md-ingest
    path: research/paper-md-ingest
  - name: writing-style
    path: writing/writing-style
    agents: [claude]
```

`ssot` is relative to the manifest or absolute. Each skill's folder and YAML frontmatter must have the same name. An omitted `path` resolves a unique scanned name. Unknown fields, duplicate names, unsafe paths and unsupported agent IDs fail validation. An explicit empty agent list deploys nowhere.

Cursor, Codex, OpenCode and Gemini CLI share `.agents/skills`; Claude Code uses `.claude/skills`. Multiple agents sharing a destination generate one output. The manifest belongs in Git; generated outputs are excluded by the plugin's own managed `.gitignore` block.

<a name="file-safety"></a>

## File safety

- Preview never writes project files. Sync rechecks every destination, refuses unmanaged collisions and only writes the manifest after planning succeeds.
- Ownership fingerprints protect deployed outputs; an exact replacement is adopted, while local edits block cleanup.
- Each replacement is journaled, and cross-process locking serializes CLI and page writes. Writes assume cooperative local processes.
- A symlinked `.agents/skills` blocks sync. The page can replace that link with a real folder after a confirmation that names the target; the target itself is never touched. Higher-level links stay manual.
- Relative links can point outside the repository; choose **copy** for restricted agents. Nested symlinks inside a source skill are refused.
- Magpie Library skills can be sources, including its top-level folder links. `library.json` and global agent switches are never edited; existing Magpie Projects outputs are unmanaged collisions.

<a name="cli"></a>

## CLI

The CLI reads the same manifest as the page. Register a source and project, create `skills.manifest.yaml` using the example above or the page, then plan and apply:

```sh
node cli.mjs source add /path/to/team-skills
node cli.mjs project add /path/to/paper-notes
node cli.mjs plan /path/to/paper-notes
node cli.mjs apply /path/to/paper-notes
```

Use these commands to inspect registration and sync every project's saved manifest:

```sh
node cli.mjs status
node cli.mjs sync
```

Node 22 or newer, with dependencies installed (`bun install`). For CLI-only use, install `npm install --global @jhzhuo/kago` and run `kago` in place of `node cli.mjs`. `--config-dir` isolates state; `--magpie-dir` selects the Library config root.

<a name="development"></a>

## Development

```sh
bun install --frozen-lockfile
bun run test
bun run check
bun run format:check
```

Pushes and pull requests run these checks on Ubuntu and macOS with Node 22 and 24. To release, update the package version and add bilingual notes under `docs/releases/`, merge to `main`, then push a matching `vMAJOR.MINOR.PATCH` tag. The release workflow publishes npm and creates the GitHub Release. See [release setup](docs/distribution.md#automated-releases) for the one-time npm authorization.

<a name="docs"></a>

## Docs

| Document                                         | Contents                                          |
| ------------------------------------------------ | ------------------------------------------------- |
| [CLI and recovery](docs/cli.md)                  | Commands, ownership, interrupted work             |
| [UI workflow](docs/ui.md)                        | Page controls, conflict repair, source editing    |
| [Integration contract](docs/integration.md)      | Magpie host, local service and package boundaries |
| [Verification](docs/verification.md)             | Historical acceptance record                      |
| [Marketplace distribution](docs/distribution.md) | Packaging and distribution boundaries             |
| [Spec](docs/spec.md)                             | Scope, behavior contracts and acceptance          |

<a name="license"></a>

## License

[MIT](LICENSE)

<div align="right">

[Back to top ↑](#readme-top)

</div>
