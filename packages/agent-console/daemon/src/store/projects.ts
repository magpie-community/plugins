// projects.json CRUD
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeJsonAtomic } from "../util/atomic.js";
import { normPath, validId } from "../util/paths.js";
import { ApiError } from "../ws/methods.js";

export type Project = { id: string; name: string; path: string; createdAt: number };

function newId(): string {
  return "p_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

export class ProjectsStore {
  private file: string;
  private cache: Project[] | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(dataDir: string) {
    this.file = join(dataDir, "projects.json");
  }

  async list(): Promise<Project[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, "utf8")) as Project[];
      if (!Array.isArray(this.cache)) this.cache = [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  async get(id: string): Promise<Project | null> {
    if (!validId(id)) return null;
    return (await this.list()).find((p) => p.id === id) ?? null;
  }

  private async save(list: Project[]): Promise<void> {
    this.cache = list;
    const snap = list;
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snap));
    await this.writing;
  }

  async create(path: string, name?: string): Promise<Project> {
    if (!path || typeof path !== "string") throw new ApiError("bad_params", "路径不能为空");
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new ApiError("bad_path", "目录不存在或不是文件夹");
    }
    const np = normPath(path);
    const list = await this.list();
    const dup = list.find((p) => normPath(p.path) === np);
    if (dup) return dup;
    const proj: Project = {
      id: newId(),
      name: name?.trim() || path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path,
      path,
      createdAt: Date.now(),
    };
    list.push(proj);
    await this.save(list);
    return proj;
  }

  async rename(id: string, name: string): Promise<Project> {
    const list = await this.list();
    const p = list.find((x) => x.id === id);
    if (!p) throw new ApiError("not_found", "项目不存在");
    p.name = name.trim() || p.name;
    await this.save(list);
    return p;
  }

  async remove(id: string): Promise<void> {
    const list = await this.list();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;
    list.splice(idx, 1);
    await this.save(list);
  }
}
