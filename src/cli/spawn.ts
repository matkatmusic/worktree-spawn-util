#!/usr/bin/env node

const args = process.argv.slice(2);
const force = args.includes("--force");
const name = args.filter((a) => a !== "--force")[0];

console.log("[spawn stub]", { force, worktreeName: name ?? "(none)" });
process.exit(0);
