import { stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

import { expandHome } from "./security.js";

export async function findGitRoot(inputPath: string): Promise<string | undefined> {
  let current = await realpathPath(inputPath);
  while (true) {
    if (await pathExists(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function assertGitRepo(inputPath: string): Promise<string> {
  const root = await findGitRoot(inputPath);
  if (!root) {
    throw new Error(`目录不是 Git repo，也不在 Git repo 内: ${inputPath}`);
  }
  return root;
}

export async function resolveAllowedRepoRoot(inputPath: string, allowlistRoots: string[]): Promise<string> {
  if (!inputPath.trim()) throw new Error("Path is required");
  if (allowlistRoots.length === 0) throw new Error("No allowlist repo roots configured");

  const candidate = await realpathPath(inputPath);
  const roots = await Promise.all(allowlistRoots.map((root) => realpathPath(root)));
  const matched = roots.find((root) => candidate === root);
  if (!matched) {
    throw new Error(`路径不是允许的 allowlist repo root: ${candidate}`);
  }
  await assertGitRepo(candidate);
  return matched;
}

export async function assertCwdPreflight(inputPath: string, allowlistRoots: string[]): Promise<string> {
  const cwd = await resolveAllowedRepoRoot(inputPath, allowlistRoots);
  await assertGitRepo(cwd);
  return cwd;
}

async function realpathPath(inputPath: string): Promise<string> {
  const expanded = expandHome(inputPath.trim());
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(process.cwd(), expanded);
  return realpath(absolute);
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await stat(inputPath);
    return true;
  } catch {
    return false;
  }
}

export function isSubpath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
