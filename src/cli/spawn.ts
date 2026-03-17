#!/usr/bin/env node

import { Logger } from "../logger.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const name = args.filter((a) => a !== "--force")[0];

const logger = new Logger();
logger.log(`[spawn stub] force=${force} worktreeName=${name ?? "(none)"}`);
process.exit(0);
