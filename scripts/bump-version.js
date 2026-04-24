#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const kind = process.argv[2] || "patch";
if (!["patch", "minor", "major"].includes(kind)) {
  console.error(`Unknown bump kind "${kind}" — use patch, minor, or major.`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [maj, min, patch] = pkg.version.split(".").map(Number);

const next =
  kind === "major"
    ? `${maj + 1}.0.0`
    : kind === "minor"
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${patch + 1}`;

pkg.version = next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log(next);
