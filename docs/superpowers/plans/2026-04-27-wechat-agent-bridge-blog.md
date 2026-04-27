# wechat-agent-bridge Blog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write a Zhihu-style retrospective and project-introduction article as `blog.md` in the repo root, based on the approved spec and the current `projectsRoot`-based product shape.

**Architecture:** The article will be written as a problem-driven narrative rather than a changelog. The first half will explain the real onboarding and product-design problems we hit, and the second half will show the simplified current usage path so readers can try the project immediately. The piece should read like an honest engineering retrospective with a natural invitation to contribute and star the repo.

**Tech Stack:** Markdown, current repository docs, recent commit history, approved spec at `docs/superpowers/specs/2026-04-27-wechat-agent-bridge-blog-design.md`

---

## File Structure

- Create: `blog.md` — the final Zhihu-style article in Chinese
- Reference: `README.md` — current product model, onboarding path, command examples
- Reference: `docs/commands.md` — command semantics and examples
- Reference: `docs/superpowers/specs/2026-04-27-wechat-agent-bridge-blog-design.md` — approved writing spec

### Task 1: Lock Article Facts And Narrative Anchors

**Files:**
- Create: `blog.md`
- Reference: `README.md`
- Reference: `docs/commands.md`
- Reference: `docs/superpowers/specs/2026-04-27-wechat-agent-bridge-blog-design.md`

- [ ] **Step 1: Pull the factual anchors that must appear in the article**

Use these facts as non-negotiable anchors:

- project name: `wechat-agent-bridge`
- primary value: connect personal WeChat private chat to local Codex
- current simplified onboarding:
  - `npm install`
  - `npm run setup`
  - `npm run start`
- current primary WeChat usage:
  - `/project`
  - `/project SageTalk`
  - `@SageTalk 帮我看一下测试失败原因`
- current simplification choices:
  - use `projectsRoot` as the main model
  - use `/project` and `@项目名 ...` as primary interaction
  - keep `/cwd` only as a compatibility command

- [ ] **Step 2: Lock the article arc before drafting**

Use this final narrative sequence:

1. Why I wanted to talk to local Codex from WeChat
2. Why the first working version created false confidence
3. Why the real problem was not “technology” but “letting others understand and use it”
4. How the project was simplified into `projectsRoot`, `setup`, `/project`, and `@项目名 ...`
5. What the project looks like now and how to try it
6. What is still imperfect
7. Invitation to try, contribute, and star

- [ ] **Step 3: Decide what to exclude**

Do not let the article turn into any of these:

- a commit-by-commit log
- a source-code deep dive
- a long architecture document
- a pure installation manual
- a generic “I made a project, please star it” post

### Task 2: Draft `blog.md`

**Files:**
- Create: `blog.md`

- [ ] **Step 1: Write the title and opening**

Use this exact title:

`# 我把本机 Codex 接进了微信，但真正难的不是技术，而是让别人也能用`

The opening should:

- start from the concrete scene of wanting to talk to local Codex from WeChat
- explain why WeChat matters as an entry point
- quickly establish that the technical bridge itself was not the hardest part

- [ ] **Step 2: Write the retrospective middle section**

Cover these points in natural prose:

- the first version was runnable and therefore deceptively satisfying
- once multi-project support appeared, config shape, command semantics, and README complexity started to pile up
- the key lesson: “能用”不等于“别人会用”
- the real work became product simplification rather than raw feature addition

- [ ] **Step 3: Write the simplification section**

Explain these design decisions clearly:

- why explicit project config was too heavy as the main path
- why a single `projectsRoot` was easier to teach
- why `/project` became the primary switch mechanism
- why `@项目名 ...` is the right one-off routing mechanism
- why `/cwd` should no longer be the main mental model
- why setup should absorb complexity instead of pushing it into README

- [ ] **Step 4: Write the “how to use it now” section**

Include this exact startup block:

```bash
npm install
npm run setup
npm run start
```

Include a short WeChat usage block like:

```text
/project
/project SageTalk
@SageTalk 帮我看一下测试失败原因
```

The explanation should stay concise and invitation-oriented, not tutorial-heavy.

- [ ] **Step 5: Write the limitations and CTA ending**

The ending must:

- acknowledge that the project still has boundaries and rough edges
- invite readers to try it
- invite issues and PRs
- invite GitHub stars naturally, without sounding like a forced call for traffic

### Task 3: Revise For Zhihu Readability

**Files:**
- Modify: `blog.md`

- [ ] **Step 1: Tighten the voice**

Make sure the prose is:

- first-person
- honest
- concrete
- engineering-oriented
- readable without prior context

Remove:

- repetitive wording
- README-like bullet overload
- over-explaining technical internals

- [ ] **Step 2: Check article balance**

Verify the article roughly stays within this balance:

- about 60% retrospective and problem framing
- about 25% explanation of the final simplified model
- about 15% usage examples and invitation

If a section reads too much like documentation, compress it.

- [ ] **Step 3: Final verification**

Read `blog.md` top to bottom and confirm:

- the title matches the approved spec
- the structure matches the approved sequence
- the usage examples are consistent with current README
- the tone feels like a real retrospective, not a release note
- the ending clearly invites readers to use, improve, and star the project

---

## Self-Review Checklist

- Spec coverage:
  - title locked to the approved version
  - retrospective + introduction hybrid shape preserved
  - `projectsRoot`, `setup`, `/project`, `@项目名 ...` all included
  - contribution and star invitation included
- Placeholder scan:
  - no `TODO`, `TBD`, or vague “later” language in the plan
- Scope check:
  - single-file writing task, no unnecessary decomposition
- Consistency:
  - article facts align with current `README.md` and `docs/commands.md`
