import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { github } from "../src/github/gh.js";

const key = "readiness:verified-result";
const timestamp = "2026-08-28T13:00:00.000Z";
const suffix = createHash("sha256").update(key).digest("hex").slice(0, 16);
const target = { name: `20260828T130000Z-${suffix}.md`, path: `journal/20260828T130000Z-${suffix}.md` };
const unrelated = Array.from({ length: 1000 }, (_, i) => ({
  name: `20260827T120000Z-${i.toString(16).padStart(16, "0")}.md`,
  path: `journal/20260827T120000Z-${i.toString(16).padStart(16, "0")}.md`,
}));
const content = `---\nidempotency_key: "${key}"\nconfirmed_at: "${timestamp}"\n---`;
function mockFile(read: (path: string) => string | Promise<string>) {
  return vi.spyOn(github, "getFileContent").mockImplementation(async (_repo, path) => ({ content: await read(path), blobSha: "a".repeat(40) }));
}
afterEach(() => vi.restoreAllMocks());

describe("audit confirmation indexed by canonical filename", () => {
  it("confirms a present event with one content read despite a large journal", async () => {
    vi.spyOn(github, "listDirectoryMarkdownFiles").mockResolvedValue([...unrelated, target]);
    const read = mockFile(() => content);
    expect(await github.confirmAuditEventInJournal("acme/repo", "journal", key, "main", 3, 0)).toBe(timestamp);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("acme/repo", target.path, "main");
  });
  it("polls for delayed delivery without repeatedly downloading unrelated files", async () => {
    const list = vi.spyOn(github, "listDirectoryMarkdownFiles").mockResolvedValueOnce(unrelated).mockResolvedValue([...unrelated, target]);
    const read = mockFile(() => content);
    expect(await github.confirmAuditEventInJournal("acme/repo", "journal", key, "main", 3, 0)).toBe(timestamp);
    expect(list).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("still confirms historical legacy names", async () => {
    vi.spyOn(github, "listDirectoryMarkdownFiles").mockResolvedValue([{ name: "legacy.md", path: "journal/legacy.md" }]);
    mockFile(() => content);
    expect(await github.confirmAuditEventInJournal("acme/repo", "journal", key, "main", 2, 0)).toBe(timestamp);
  });
  it("falls back once for a renamed historical canonical file", async () => {
    const list = vi.spyOn(github, "listDirectoryMarkdownFiles").mockResolvedValue([unrelated[0]!]);
    const read = mockFile(() => content);
    expect(await github.confirmAuditEventInJournal("acme/repo", "journal", key, "main", 3, 0)).toBe(timestamp);
    expect(list).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not accept a hash collision without a matching full key", async () => {
    vi.spyOn(github, "listDirectoryMarkdownFiles").mockResolvedValue([target]);
    mockFile(() => 'idempotency_key: "another-key"');
    await expect(github.confirmAuditEventInJournal("acme/repo", "journal", key, "main", 1, 0)).rejects.toThrow("not found");
  });
  it("fails closed on malformed confirmation", async () => {
    vi.spyOn(github, "listDirectoryMarkdownFiles").mockResolvedValue([target]);
    mockFile(() => `idempotency_key: "${key}"`);
    await expect(github.confirmAuditEventInJournal("acme/repo", "journal", key, "main", 1, 0)).rejects.toThrow("confirmed_at");
  });
  it("propagates target read errors rather than fabricating confirmation", async () => {
    vi.spyOn(github, "listDirectoryMarkdownFiles").mockResolvedValue([target]);
    mockFile(() => { throw new Error("HTTP 403"); });
    await expect(github.confirmAuditEventInJournal("acme/repo", "journal", key, "main", 2, 0)).rejects.toThrow("HTTP 403");
  });
});
