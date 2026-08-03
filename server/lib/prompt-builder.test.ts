// α1 non-regression tests — v2.0 agent socle in buildSystemPrompt.
// Guards two invariants from PLAN.md:
//   1. The agent socle is ALWAYS the first segment when present, and its
//      addition doesn't reorder or reformat the existing segments.
//   2. Composition is deterministic (byte-stable): same inputs, same
//      bytes — the property the upstream KV prefix cache depends on.

import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt-builder";

const SEP = "\n\n---\n\n";

describe("buildSystemPrompt — agent socle", () => {
  it("puts agentSystemPrompt first, before userSystemPrompt", () => {
    const out = buildSystemPrompt({
      agentSystemPrompt: "SOCLE",
      userSystemPrompt: "USER",
      identity: "IDENTITY",
      skillsIndex: "SKILLS",
      projectMemory: "MEMORY",
      globalMemory: null,
    });
    expect(out).toBe(
      ["SOCLE", "USER", "IDENTITY", "SKILLS", "MEMORY"].join(SEP),
    );
  });

  it("keeps pre-v2 composition byte-identical when socle is absent", () => {
    const legacy = buildSystemPrompt({
      userSystemPrompt: "USER",
      identity: "IDENTITY",
      skillsIndex: "SKILLS",
      projectMemory: "MEMORY",
      globalMemory: null,
    });
    const withNull = buildSystemPrompt({
      agentSystemPrompt: null,
      userSystemPrompt: "USER",
      identity: "IDENTITY",
      skillsIndex: "SKILLS",
      projectMemory: "MEMORY",
      globalMemory: null,
    });
    expect(withNull).toBe(legacy);
    expect(legacy).toBe(["USER", "IDENTITY", "SKILLS", "MEMORY"].join(SEP));
  });

  it("socle alone composes to just the socle (no stray separators)", () => {
    expect(buildSystemPrompt({ agentSystemPrompt: "SOCLE" })).toBe("SOCLE");
  });

  it("empty / whitespace socle is skipped like any other segment", () => {
    expect(
      buildSystemPrompt({ agentSystemPrompt: "  \n ", userSystemPrompt: "U" }),
    ).toBe("U");
  });

  it("is deterministic — same inputs, same bytes", () => {
    const opts = {
      agentSystemPrompt: "SOCLE",
      userSystemPrompt: "USER",
      identity: "ID",
      skillsIndex: "SK",
      projectMemory: "PM",
      globalMemory: "GM",
    };
    expect(buildSystemPrompt(opts)).toBe(buildSystemPrompt(opts));
  });
});
