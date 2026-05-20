// Skill ZIP packaging — agentskills.io distribution format.
//
// Layout inside the archive:
//   SKILL.md
//   scripts/…
//   references/…
//   assets/…
//
// We accept either a flat archive (SKILL.md at root) or one wrapped in
// a single top-level directory (most GitHub-style downloads do this).
// Both forms decode to the same in-memory shape.

import JSZip from "jszip";
import { parseSkillMd, serializeSkillMd, type ParsedSkill } from "./skill-format";

export type SkillPackage = ParsedSkill & {
  /** Map of relative path → file contents (text only). */
  files: Record<string, string>;
};

const MAX_FILES = 64;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 2_000_000;

export async function unpackSkillZip(buf: Uint8Array): Promise<SkillPackage> {
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files).filter((f) => !f.dir);

  // Detect single-root-directory wrapping (e.g. `my-skill/SKILL.md`).
  const roots = new Set(entries.map((f) => f.name.split("/")[0]));
  const prefix =
    roots.size === 1 && entries.every((f) => f.name.includes("/"))
      ? entries[0].name.split("/")[0] + "/"
      : "";

  let skillMd: string | null = null;
  const files: Record<string, string> = {};
  let totalBytes = 0;
  let count = 0;

  for (const entry of entries) {
    const rel = prefix && entry.name.startsWith(prefix)
      ? entry.name.slice(prefix.length)
      : entry.name;
    if (!rel) continue;
    if (rel === "SKILL.md") {
      skillMd = await entry.async("text");
      continue;
    }
    // Skip macOS junk + dotfiles outside the spec layout.
    if (rel.startsWith("__MACOSX/") || rel.startsWith(".")) continue;
    if (
      !rel.startsWith("scripts/") &&
      !rel.startsWith("references/") &&
      !rel.startsWith("assets/")
    ) {
      continue;
    }
    if (++count > MAX_FILES) {
      throw new Error(`Too many files in archive (max ${MAX_FILES}).`);
    }
    const content = await entry.async("text");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`File ${rel} exceeds per-file size limit (200KB).`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Archive exceeds total size limit (2MB).`);
    }
    files[rel] = content;
  }

  if (!skillMd) throw new Error("Archive is missing SKILL.md at the root.");
  const parsed = parseSkillMd(skillMd);
  return { ...parsed, files };
}

export async function packSkillZip(skill: {
  name: string;
  description: string | null;
  license: string | null;
  compatibility: string | null;
  body: string;
  files: Record<string, string>;
  metadata: Record<string, unknown>;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  const md = serializeSkillMd({
    name: skill.name,
    description: skill.description,
    license: skill.license,
    compatibility: skill.compatibility,
    body: skill.body,
    metadata: skill.metadata,
  });
  const root = `${skill.name}/`;
  zip.file(`${root}SKILL.md`, md);
  for (const [rel, content] of Object.entries(skill.files)) {
    zip.file(`${root}${rel}`, content);
  }
  return zip.generateAsync({ type: "uint8array" });
}
