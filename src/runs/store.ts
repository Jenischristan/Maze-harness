import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DiscoveryTree,
  PolicyVersionRecord,
  ReplayReport
} from "../types.js";
import { writeFileAtomic } from "../util/atomic.js";

export interface RunStoreConfig {
  rootDir: string;
  runId: string;
}

export class RunStore {
  readonly rootDir: string;
  readonly runId: string;
  readonly dir: string;

  constructor(cfg: RunStoreConfig) {
    this.rootDir = cfg.rootDir;
    this.runId = cfg.runId;
    this.dir = join(cfg.rootDir, cfg.runId);
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, "trees"), { recursive: true });
    await mkdir(join(this.dir, "policies"), { recursive: true });
    await mkdir(join(this.dir, "reports"), { recursive: true });
  }

  async saveTree(tree: DiscoveryTree): Promise<void> {
    await this.init();
    const path = join(this.dir, "trees", `tree-${String(tree.treeIndex).padStart(4, "0")}.json`);
    await writeFileAtomic(path, `${JSON.stringify(tree, null, 2)}\n`);
  }

  async loadTrees(): Promise<DiscoveryTree[]> {
    const dir = join(this.dir, "trees");
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    const out: DiscoveryTree[] = [];
    for (const f of files) {
      out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as DiscoveryTree);
    }
    return out.sort((a, b) => a.treeIndex - b.treeIndex);
  }

  async savePolicyVersion(round: number, record: PolicyVersionRecord): Promise<void> {
    await this.init();
    const base = join(
      this.dir,
      "policies",
      `t${String(round).padStart(4, "0")}-${record.policyId}`
    );
    await writeFileAtomic(`${base}.ts`, record.source);
    await writeFileAtomic(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);
  }

  async saveReplayReports(round: number, policyId: string, reports: ReplayReport[]): Promise<void> {
    await this.init();
    const path = join(
      this.dir,
      "reports",
      `t${String(round).padStart(4, "0")}-${policyId}.json`
    );
    await writeFileAtomic(path, `${JSON.stringify(reports, null, 2)}\n`);
  }

  async saveState(state: unknown): Promise<void> {
    await this.init();
    await writeFileAtomic(join(this.dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  async loadState<T>(): Promise<T | null> {
    const path = join(this.dir, "state.json");
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, "utf8")) as T;
  }
}
