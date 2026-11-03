#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { materializeWorkspace } from "../../src/workspace/materialize.js";

const root = resolve(import.meta.dirname, "..", "..");
const target =
  process.argv[2] ?? (await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "self-improve-")));
const out = await materializeWorkspace({ root, target });
process.stdout.write(`${out}\n`);
