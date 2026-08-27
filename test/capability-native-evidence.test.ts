import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Execute the actual workflow-embedded parser, not a separate test implementation.
const workflow = readFileSync(".github/workflows/capability-smoke.yml", "utf8").replaceAll("\r\n", "\n");
const script = workflow.split("<<'NODE'\n")[1]?.split("\n          NODE")[0]?.replace(/^ {10}/gm, "");
if (!script) throw new Error("Missing embedded native evidence verifier");

function verify(raw: string, tool = "Bash"): number | null {
  const dir = mkdtempSync(join(tmpdir(), "capability-native-"));
  try {
    const file = join(dir, "execution.json");
    writeFileSync(file, raw);
    return spawnSync(process.execPath, ["-e", script!, "-", file, tool]).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const call = (name = "Bash", id = "call-1", session = "session-1") => ({
  type: "assistant", session_id: session,
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
});
const result = (id = "call-1", session = "session-1", error?: unknown) => ({
  type: "user", session_id: session,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "synthetic success", ...(error === undefined ? {} : { is_error: error }) }] },
});

describe("actual workflow native Claude evidence parser", () => {
  for (const tool of ["Bash", "Write", "Edit"]) {
    it(`accepts correlated ${tool} JSON events`, () => {
      expect(verify(JSON.stringify([call(tool), result()]), tool)).toBe(0);
    });
  }
  it("accepts NDJSON and explicit false error flag", () => {
    expect(verify([call(), result("call-1", "session-1", false)].map(x => JSON.stringify(x)).join("\n"))).toBe(0);
  });
  for (const [name, events] of Object.entries({
    missing: [call()],
    orphan: [result()],
    errored: [call(), result("call-1", "session-1", true)],
    malformedError: [call(), result("call-1", "session-1", "false")],
    wrongId: [call(), result("other")],
    wrongSession: [call(), result("call-1", "other")],
    reversed: [result(), call()],
    duplicateCall: [call(), call(), result()],
    duplicateResult: [call(), result(), result()],
    textOnly: [{ type: "assistant", session_id: "session-1", message: { content: [{ type: "text", text: '{"tool":"Bash","success":true}' }] } }],
    syntheticLegacy: [{ tool: "Bash", success: true }],
    wrongTool: [call("Write"), result()],
  })) {
    it(`fails closed for ${name}`, () => {
      expect(verify(JSON.stringify(events))).toBe(1);
    });
  }
  it("fails closed for malformed JSON and empty input", () => {
    expect(verify("not json")).toBe(1);
    expect(verify("")).toBe(1);
  });
});
