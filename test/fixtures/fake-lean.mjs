#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const file = process.argv.at(-1);
if (!file) process.exit(2);

const source = await readFile(file, "utf8");
if (source.includes("-- HANG")) {
  setTimeout(() => process.exit(0), 5_000);
} else if (source.includes("by trivial")) {
  process.stdout.write("Lean proof verified\n");
  process.exit(0);
} else {
  process.stderr.write(`${file}:2:3: error: tactic failed\n⊢ False\n`);
  process.exit(1);
}
