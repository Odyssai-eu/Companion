// SKILL.md format — agentskills.io specification.
// https://agentskills.io/specification
//
// Layout:
//   ---
//   name: my-skill
//   description: When and why to invoke this skill.
//   license: optional
//   compatibility: optional
//   <arbitrary frontmatter keys land in metadata>
//   ---
//   <markdown body>
//
// Supporting files (scripts/, references/, assets/) live in the same
// directory and are zipped together for distribution. The parser here
// handles the single SKILL.md text only — ZIP unpacking is the
// caller's job (server/lib/skill-archive.ts).

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type ParsedSkill = {
  name: string;
  description: string | null;
  license: string | null;
  compatibility: string | null;
  body: string;
  /** Frontmatter keys that aren't promoted to first-class columns. */
  metadata: Record<string, unknown>;
};

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const PROMOTED_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
]);

export class SkillParseError extends Error {}

export function parseSkillMd(text: string): ParsedSkill {
  const trimmed = text.replace(/^﻿/, "");
  const m = FRONTMATTER_RE.exec(trimmed);
  if (!m) {
    throw new SkillParseError(
      "SKILL.md must start with a YAML frontmatter block (--- … ---).",
    );
  }
  const [, yamlText, body] = m;
  let fm: unknown;
  try {
    fm = parseYaml(yamlText);
  } catch (e) {
    throw new SkillParseError(
      `Invalid YAML frontmatter: ${(e as Error).message}`,
    );
  }
  if (!isPlainObject(fm)) {
    throw new SkillParseError("Frontmatter must be a YAML mapping.");
  }

  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  if (!NAME_RE.test(name) || name.length > 64) {
    throw new SkillParseError(
      `Invalid 'name': must be 1-64 chars lowercase a-z/0-9/hyphen (no leading/trailing/consecutive hyphens). Got: ${JSON.stringify(fm.name)}`,
    );
  }

  const description =
    typeof fm.description === "string" ? fm.description.trim() : null;
  if (description !== null && description.length > 1024) {
    throw new SkillParseError("'description' exceeds 1024 chars.");
  }
  const license = typeof fm.license === "string" ? fm.license.trim() : null;
  const compatibility =
    typeof fm.compatibility === "string" ? fm.compatibility.trim() : null;
  if (compatibility !== null && compatibility.length > 500) {
    throw new SkillParseError("'compatibility' exceeds 500 chars.");
  }

  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!PROMOTED_KEYS.has(k)) metadata[k] = v;
  }

  return {
    name,
    description,
    license,
    compatibility,
    body: body.replace(/^\n+/, ""),
    metadata,
  };
}

export function serializeSkillMd(input: {
  name: string;
  description?: string | null;
  license?: string | null;
  compatibility?: string | null;
  body: string;
  metadata?: Record<string, unknown> | null;
}): string {
  const fm: Record<string, unknown> = { name: input.name };
  if (input.description) fm.description = input.description;
  if (input.license) fm.license = input.license;
  if (input.compatibility) fm.compatibility = input.compatibility;
  if (input.metadata) {
    for (const [k, v] of Object.entries(input.metadata)) {
      if (PROMOTED_KEYS.has(k)) continue;
      fm[k] = v;
    }
  }
  const yaml = stringifyYaml(fm).trimEnd();
  const body = input.body.replace(/^\n+/, "").trimEnd();
  return `---\n${yaml}\n---\n\n${body}\n`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
