# Projects Root Onboarding Design

## Goal

`wechat-agent-bridge` should optimize for the fastest possible first-time multi-project setup. A user should be able to point the bridge at one local project root directory, bind WeChat, choose an initial default project, and then switch between sibling projects from WeChat without learning the current explicit `projects` config model.

The intended primary workflow is:

- keep local repos under one directory such as `~/.codex/projects`
- run `npm run setup`
- choose that directory once
- use `/project <name>` or `@<name> ...` from WeChat

## Non-Goals

- No support for multiple project root directories in the main model.
- No alias layer separate from directory names.
- No recursive project discovery.
- No README homepage that explains both old and new mental models equally.
- No silent `git init` on behalf of the user.
- No requirement that users understand `defaultCwd`, `allowlistRoots`, or explicit `projects` entries during onboarding.

## Recommended Approach

Replace the user-facing configuration model with a single-root project model:

- one configured `projectsRoot`
- project names come directly from the first-level child directory names under that root
- the active project is remembered across runs
- first-time setup asks the user to choose a default project from discovered children

This keeps the user mental model small:

1. put repositories in one folder
2. pick that folder during setup
3. switch projects by name in WeChat

The existing per-project runtime/session architecture remains useful internally, but the explicit alias registry stops being the primary product surface.

## User-Facing Configuration

The documented config shrinks to:

```json
{
  "projectsRoot": "/Users/you/.codex/projects",
  "defaultProject": "SageTalk",
  "streamIntervalMs": 10000
}
```

Field meanings:

- `projectsRoot`: the single directory whose first-level child directories are treated as projects
- `defaultProject`: the fallback project used on first run or when the remembered last-used project is missing
- `streamIntervalMs`: existing progress throttling interval

`lastProject` is runtime state, not homepage configuration. It should be persisted separately from the main config description.

## Setup Flow

`npm run setup` should become a fixed onboarding flow:

1. verify `codex` is installed
2. verify the current system user is logged into Codex
3. bind WeChat
4. ask for `projectsRoot`, defaulting to `~/.codex/projects`
5. inspect first-level child directories under `projectsRoot`
6. let the user choose a `defaultProject`
7. write the minimal config format
8. print the next-step instructions:
   - `npm run start` or `npm run daemon -- start`
   - `/project`
   - `@ProjectName ...`

If no child directories exist, setup should explain the problem in plain language and let the user pick another root. The main onboarding flow should not teach legacy config fields.

## Project Discovery Rules

Discovery rules are intentionally narrow:

- look only at first-level child directories under `projectsRoot`
- ignore files
- do not recurse
- project name equals directory name
- list both Git and non-Git directories

Project selection behavior:

- if the target directory is already a Git repo root, switch directly
- if the target directory is not a Git repo, ask the user to confirm `git init`
- only run `git init` after explicit confirmation
- do not auto-add files, create a commit, or configure a remote

This preserves the simple "one folder, many sibling projects" model without silently mutating user directories.

## Runtime Project Selection

On startup and during normal use, project resolution works like this:

1. if a remembered `lastProject` still exists under `projectsRoot`, use it
2. otherwise fall back to `defaultProject`
3. if `defaultProject` no longer exists, fail clearly and ask the user to rerun setup

Each project still keeps its own session, history, mode, and model. The simplified onboarding model does not change the internal requirement for isolated per-project runtime state.

## WeChat Command Surface

The command surface should be intentionally layered.

### Core Commands

These are the commands taught on the README homepage and returned by `/help`:

- `/project`
- `/project <name>`
- `/status`
- `/interrupt`
- `/replace <prompt>`
- `/history`
- `@<project> <prompt>`

Core behavior:

- `/project` lists first-level projects under `projectsRoot` and marks the current one
- `/project <name>` switches the current project
- `@<project> <prompt>` routes one prompt to the named project without changing the current project
- plain non-command messages target the current project
- different projects may run concurrently
- the same project rejects a new ordinary prompt while busy
- the user must explicitly use `/interrupt` or `/replace` to take over a busy project

Detailed command syntax still supports explicit project targeting where useful:

- `/interrupt [project]`
- `/replace [project] <prompt>`
- `/status [project]`
- `/history [project] [n]`

### Advanced Commands

These remain available but are not part of the first-time mental model:

- `/mode`
- `/model`

Detailed advanced syntax:

- `/mode [project] [readonly|workspace|yolo]`
- `/model [project] [name]`

### Compatibility Command

`/cwd` remains available only as an advanced compatibility command. It should not be part of the README homepage or the default `/help` output. In the simplified model it is no longer a primary way to understand project switching.

## Help and Documentation Model

Command explanations should come from one shared definition so the product does not drift.

Documentation layers:

1. README homepage
2. full command reference
3. in-chat `/help`

Planned behavior:

- `README.md` homepage teaches only the shortest path to start and switch projects
- a dedicated command reference document describes every command in detail
- `/help` returns only the core command overview
- `/help <command>` returns detailed help for that command

Each detailed command entry should follow one structure:

- purpose
- syntax
- parameter meanings
- whether it changes the current project
- whether it interrupts running work
- examples
- notes and common mistakes

## README Structure

The homepage should be reorganized around first-use clarity:

1. what the project does
2. three-minute setup
3. the three most important WeChat examples
4. project directory rule
5. pointer to more commands and advanced usage

Homepage examples should stay minimal:

```text
/project
/project SageTalk
@SageTalk 帮我看一下测试失败原因
```

The homepage should not lead with:

- explicit `projects` config
- `defaultCwd`
- `allowlistRoots`
- `/cwd`
- MCP details
- architecture explanations

Those belong later in the README or in separate docs.

## Compatibility and Migration

The new root-based model is the only documented path. Runtime compatibility exists only to avoid immediate breakage for existing users.

Migration rules:

- new setup always writes the new root-based config
- runtime may read old config shapes temporarily
- if old config entries can be reduced to one shared parent directory, startup may infer `projectsRoot`
- if old config spans multiple roots, startup should fail clearly and tell the user to rerun `npm run setup`

Accepted incompatibility:

- explicit aliases are no longer preserved in the main model
- project names now come from directory names

This is intentional. Keeping aliases would pull the product back toward the old explicit registry complexity.

## Error Handling

Expected user-facing failures should be plain and actionable:

- `projectsRoot` does not exist: tell the user to rerun setup
- no child directories under `projectsRoot`: tell the user to add projects or choose another root
- unknown `/project <name>` target: list available projects
- unknown `@<project>` target: list available projects
- selected project is not a Git repo: ask whether to run `git init`
- remembered current project disappeared: fall back to a valid project and explain what happened
- a project is busy: tell the user to use `/interrupt` or `/replace`

Replies should avoid internal storage or config terminology when a simpler message is possible.

## Testing

The design requires focused coverage for:

- loading the new root-based config
- compatibility reads for old config
- first-level project discovery
- current project fallback to `lastProject` or `defaultProject`
- `/project` listing and switching
- `@<project> ...` one-off routing
- non-Git project confirmation before `git init`
- `/help` overview and `/help <command>` detail
- README and command reference accuracy where tests or snapshot-style assertions make sense

## Open Boundary

This design intentionally leaves one workflow out of the main path: adding projects after initial setup. In the simplified model, the user adds a new sibling directory under `projectsRoot`, and the bridge discovers it naturally. There is no separate first-class "add project" command in this iteration.
