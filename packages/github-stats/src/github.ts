import type { Config } from "./types.js";
export class GitHubError extends Error {
  constructor(
    public status: number,
    public retryAt?: string,
  ) {
    super(
      status === 401
        ? "GitHub 身份验证失败，请更新 Token。"
        : status === 403
          ? "GitHub 拒绝操作：请检查 Contents 写权限、分支保护或限流。"
          : status === 404
            ? "GitHub 仓库、分支不存在或当前账号无权访问。"
            : status === 409 || status === 422
              ? "GitHub 分支冲突或受到保护，请重试或选择其他分支。"
              : `GitHub 请求失败（HTTP ${status}）。`,
    );
  }
}
export class GitHub {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    allow404 = false,
  ): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`https://api.github.com${path}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "magpie-github-stats/0.1.0",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        if (attempt < 2) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new Error("GitHub 网络连接失败；旧卡片已保留，可稍后重试。");
      }
      if (response.status === 404 && allow404) return null;
      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new Error("GitHub 返回了无效响应。");
        }
      }
      const retry = response.headers.get("retry-after"),
        reset = response.headers.get("x-ratelimit-reset");
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (retry || response.headers.get("x-ratelimit-remaining") === "0"));
      if (limited) {
        const ms = retry
          ? /^\d+$/.test(retry)
            ? Date.now() + Number(retry) * 1000
            : Date.parse(retry)
          : reset
            ? Number(reset) * 1000
            : Date.now() + 60000;
        throw new GitHubError(
          response.status,
          new Date(
            Math.max(Date.now() + 60000, Number.isFinite(ms) ? ms : 0),
          ).toISOString(),
        );
      }
      if (response.status >= 500 && attempt < 2) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      throw new GitHubError(response.status);
    }
    throw new Error("GitHub 重试失败。");
  }
  async repository(c: Config) {
    if (!c.repository) throw new Error("请先设置 GitHub 仓库。");
    const repo = await this.request(`/repos/${c.repository}`);
    const branch = c.branch || repo.default_branch;
    if (typeof branch !== "string" || !branch)
      throw new Error("无法确定 GitHub 默认分支。");
    // A selected branch must already exist; an empty repository's default branch can be initialized.
    if (c.branch)
      await this.request(
        `/repos/${c.repository}/branches/${encodeURIComponent(branch)}`,
      );
    return { branch, private: repo.private === true };
  }
  async put(c: Config, branch: string, name: string, svg: string) {
    const path = [c.folder, name]
      .filter(Boolean)
      .join("/")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const endpoint = `/repos/${c.repository}/contents/${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.request(
        `${endpoint}?ref=${encodeURIComponent(branch)}`,
        "GET",
        undefined,
        true,
      );
      if (current) {
        if (
          current.type !== "file" ||
          current.encoding !== "base64" ||
          typeof current.content !== "string"
        )
          throw new Error("目标路径不是可更新的普通 SVG 文件。");
        if (Buffer.from(current.content, "base64").toString("utf8") === svg)
          return false;
      }
      try {
        await this.request(endpoint, "PUT", {
          message: `chore: update Magpie ${name.includes("dark") ? "dark" : "light"} usage card`,
          content: Buffer.from(svg).toString("base64"),
          branch,
          ...(current ? { sha: current.sha } : {}),
        });
        return true;
      } catch (e) {
        if (
          e instanceof GitHubError &&
          [409, 422].includes(e.status) &&
          attempt < 2
        )
          continue;
        throw e;
      }
    }
    throw new Error("GitHub 文件持续冲突，请稍后重试。");
  }
}
