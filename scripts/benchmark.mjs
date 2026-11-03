#!/usr/bin/env node
// Matched, interleaved offline benchmark. Both arms use the baseline's exact fake CLIs and identical workloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS = ["codex", "gemini", "grok"];
const FAKES = { codex: ["COUNCIL_CODEX_BIN", "fake-codex.mjs"], gemini: ["COUNCIL_AGY_BIN", "fake-agy.mjs"], grok: ["COUNCIL_GROK_BIN", "fake-grok.mjs"] };
const bytes = (value) => Buffer.byteLength(value, "utf8");
const git = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trimEnd();
};
export function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
export function summarize(rows) {
  const result = [];
  for (const arm of ["baseline", "candidate"]) for (const provider of PROVIDERS) for (const workload of ["ask", "reply", "review", "discussion"]) {
    const selected = rows.filter((row) => row.arm === arm && row.provider === provider && row.workload === workload);
    if (!selected.length) continue;
    result.push({ arm, provider, workload, samples: selected.length, medianMs: quantile(selected.map((row) => row.elapsedMs), 0.5), p95Ms: quantile(selected.map((row) => row.elapsedMs), 0.95),
      medianFramingBytes: quantile(selected.map((row) => row.framingBytes), 0.5), medianProviderInputBytes: quantile(selected.map((row) => row.providerInputBytes), 0.5),
      medianFirstHandleMs: quantile(selected.map((row) => row.firstHandleMs).filter((value) => value !== null), 0.5), medianFsyncs: quantile(selected.map((row) => row.fsyncs), 0.5), medianProcessQueries: quantile(selected.map((row) => row.processQueries), 0.5),
      medianInventoryReads: quantile(selected.map((row) => row.inventoryReads), 0.5), medianMetadataReads: quantile(selected.map((row) => row.metadataReads), 0.5), medianPreflightCacheWrites: quantile(selected.map((row) => row.preflightCacheWrites), 0.5),
      medianProcessQueryMs: quantile(selected.map((row) => row.processQueryMs), 0.5), medianChildStarts: quantile(selected.map((row) => row.childStarts), 0.5) });
  }
  return result;
}
function sourceInfo(root) {
  const files = [];
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(file); } };
  walk(path.join(root, "plugins", "council"));
  const runtime = files.filter((file) => /\.(mjs|cjs|js|ps1)$/.test(file)).map((file) => {
    const text = fs.readFileSync(file, "utf8"), lines = text ? text.replace(/\n$/, "").split("\n") : [];
    return { file: path.relative(root, file).replaceAll("\\", "/"), bytes: bytes(text), lines: lines.length, longLines: lines.filter((line) => [...line].length > 120).length };
  });
  const hash = createHash("sha256");
  for (const file of files.sort()) { hash.update(path.relative(root, file).replaceAll("\\", "/")); hash.update(fs.readFileSync(file)); }
  const skill = fs.readFileSync(path.join(root, "plugins/council/skills/council/SKILL.md"), "utf8");
  return { head: git(root, ["rev-parse", "HEAD"]), dirty: Boolean(git(root, ["status", "--porcelain"])), pluginSha256: hash.digest("hex"),
    version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, runtimeFiles: runtime.length, runtimeLines: runtime.reduce((sum, row) => sum + row.lines, 0),
    longLines: runtime.reduce((sum, row) => sum + row.longLines, 0), largestFile: runtime.toSorted((a, b) => b.lines - a.lines)[0],
    entryLines: runtime.find((row) => row.file === "plugins/council/scripts/council.mjs").lines, skillBytes: bytes(skill), descriptionBytes: bytes(/^description: (.+)$/m.exec(skill)[1]) };
}
export async function benchmark({ baseline, candidate, samples = 10, history = 100, output }) {
  for (const root of [baseline, candidate]) if (!fs.existsSync(path.join(root, "plugins/council/scripts/council.mjs"))) throw new Error(`missing plugin: ${root}`);
  const fakeEnv = Object.fromEntries(Object.values(FAKES).map(([name, file]) => {
    const target = path.join(baseline, "tests", "fixtures", file);
    if (!fs.existsSync(target)) throw new Error(`missing pinned fake: ${target}`);
    return [name, target];
  }));
  const sources = { baseline: sourceInfo(baseline), candidate: sourceInfo(candidate) };
  const tempParent = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(tempParent, "council-matched-bench-"));
  const workspace = path.join(scratch, "work");
  fs.mkdirSync(workspace);
  git(workspace, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(workspace, "calc.js"), "export const sum = (items) => {\n  let total = 0;\n  for (let i = 0; i < items.length; i++) total += items[i];\n  return total;\n};\n", "utf8");
  git(workspace, ["add", "."]);
  git(workspace, ["-c", "user.email=benchmark@example.invalid", "-c", "user.name=Benchmark", "-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
  fs.writeFileSync(path.join(workspace, "calc.js"), fs.readFileSync(path.join(workspace, "calc.js"), "utf8").replace("i < items.length", "i <= items.length"), "utf8");
  fs.mkdirSync(path.join(scratch, ".grok"));
  fs.writeFileSync(path.join(scratch, ".grok", "auth.json"), "{}", "utf8");
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|GROK|AGY|COUNCIL|ANTHROPIC|NODE_OPTIONS)/i.test(key)));
  const rows = [];
  const run = async (arm, provider, sample, workload, thread) => {
    const state = path.join(scratch, `${arm}-${provider}-${sample}`);
    if (!fs.existsSync(state)) {
      for (let index = 0; index < history; index++) {
        const id = `history${String(index).padStart(9, "0")}`, directory = path.join(state, "jobs", id);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ id, provider, verb: "ask", status: "done", outcome: "ok", code: 0, admitted: true, cwd: workspace, session: "historical", cleanupPending: false, spawnedAt: new Date(946684800000 + index * 1000).toISOString() }), "utf8");
        fs.writeFileSync(path.join(directory, "done"), "", "utf8");
      }
    }
    const trace = path.join(scratch, `${arm}-${provider}-${sample}-${workload}.ndjson`);
    const log = `${trace}.requests`;
    fs.writeFileSync(trace, "", "utf8");
    fs.writeFileSync(log, "", "utf8");
    const verb = workload === "discussion" ? "reply" : workload;
    const args = [path.join(arm === "baseline" ? baseline : candidate, "plugins/council/scripts/council.mjs"), verb];
    if (thread) args.push("--thread", thread); else args.push("--to", provider, "--tier", "consult");
    args.push("--session", "matched-benchmark", "--request-id", `bench-${sample}-${workload}`);
    if (workload === "review") args.push("--uncommitted"); else args.push("--", workload === "discussion" ? "F1 AGREE" : "Reply with pong");
    const env = { ...baseEnv, HOME: scratch, USERPROFILE: scratch, HTTPS_PROXY: "http://127.0.0.1:9", COUNCIL_HOME: state, ...fakeEnv,
      COUNCIL_FAKE_JOB_DIR: path.join(state, "jobs"), COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: workload === "review" ? "calc.js" : workload === "discussion" ? "F1 AGREE" : "Reply with pong",
      COUNCIL_FAKE_EXPECT_CONTRACT: workload === "review" ? "" : provider === "grok" ? fs.readFileSync(path.join(arm === "baseline" ? baseline : candidate, "plugins/council/contract.md"), "utf8").trim().replace(/\s*\r?\n\s*/g, " ") : fs.readFileSync(path.join(arm === "baseline" ? baseline : candidate, "plugins/council/contract.md"), "utf8").trim(),
      COUNCIL_FAKE_SCENARIO: workload === "review" ? "review-findings" : thread ? "resume" : "ok", COUNCIL_BENCH_TRACE: trace, COUNCIL_FAKE_LOG: log,
      NODE_OPTIONS: `--require="${path.join(HERE, "benchmark-trace.cjs").replaceAll("\\", "/")}"` };
    const started = performance.now();
    let firstHandleMs = null;
    const result = await new Promise((resolve) => {
      let stdout = "", stderr = "";
      const child = spawn(process.execPath, args, { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => { child.kill(); }, 60000);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; if (firstHandleMs === null && /\[council\] provider=\w+ job=[a-z0-9]{16}/.test(stderr)) firstHandleMs = performance.now() - started; });
      child.on("error", (error) => { stderr += error.message; });
      child.once("close", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
    });
    const elapsedMs = performance.now() - started;
    if (![0, 10].includes(result.status)) throw new Error(`${arm}/${provider}/${workload}: ${result.status}: ${result.stdout}${result.stderr}; evidence: ${scratch}`);
    const footer = `${result.stdout.trimEnd().split("\n").at(-1)}\n`;
    const id = /\bjob ([a-z0-9]{16})\b/.exec(footer)?.[1];
    if (!id) throw new Error(`no recovery job in footer: ${footer}`);
    const metadata = JSON.parse(fs.readFileSync(path.join(state, "jobs", id, "meta.json"), "utf8"));
    if (!metadata.endedAt || metadata.cleanupPending) throw new Error(`${id}: final cleanup not confirmed`);
    const events = fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const queries = events.filter((event) => event.kind === "process-query");
    const storage = events.filter((event) => event.kind === "storage");
    const stored = (name) => storage.reduce((sum, event) => sum + event[name], 0);
    const launches = events.filter((event) => event.kind === "provider-input");
    if (launches.length !== 1) throw new Error(`expected one fake provider turn, found ${launches.length}`);
    const launched = launches[0];
    rows.push({ arm, provider, sample, workload, code: result.status, elapsedMs, framingBytes: bytes(result.stderr) + bytes(footer), startLineBytes: bytes(result.stderr), footerBytes: bytes(footer),
      answerBytes: bytes(result.stdout) - bytes(footer), providerInputBytes: launched.bytes, firstHandleMs,
      childStarts: events.filter((event) => !["fsync", "storage", "provider-input"].includes(event.kind)).length, fsyncs: events.filter((event) => event.kind === "fsync").length,
      inventoryReads: stored("inventoryReads"), metadataReads: stored("metadataReads"), preflightCacheWrites: stored("preflightCacheWrites"),
      processQueries: queries.length, processQueryMs: queries.reduce((sum, event) => sum + event.elapsedMs, 0),
      model: metadata.model, effort: metadata.effort, usage: metadata.usage ?? null, costUsd: metadata.costUsd ?? null });
    return id;
  };
  for (let sample = 0; sample < samples; sample++) for (const provider of PROVIDERS) {
    for (const arm of sample % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      const ask = await run(arm, provider, sample, "ask");
      const reply = await run(arm, provider, sample, "reply", ask);
      await run(arm, provider, sample, "review");
      await run(arm, provider, sample, "discussion", reply);
    }
    console.log(`sample ${sample + 1}/${samples}: ${provider} baseline/candidate complete`);
  }
  const report = { date: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version, samplesPerArmProviderWorkload: samples, retainedHistoryJobs: history,
    method: "Sequential paired workflows; arm order alternates; baseline's exact fake CLIs; same scratch Git change and default model/effort; ask cold, other turns warm; identical process/fsync tracing; nearest-rank median/p95. Discussion is a third ask-thread turn (reviews are not resumable here). Provider input is text plus separately carried contract/schema bytes; Codex native target-flag reviews carry zero wrapper prompt bytes and read their own diff, excluded from this count, excluding protocol envelopes and unobserved CLI context. No paid calls or tokenizer estimates.", sources, rows, summary: summarize(rows) };
  for (const arm of ["baseline", "candidate"]) if (sourceInfo(arm === "baseline" ? baseline : candidate).pluginSha256 !== sources[arm].pluginSha256) throw new Error(`${arm} plugin changed during measurement; discard this run`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const relative = path.relative(tempParent, fs.realpathSync(scratch));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("scratch cleanup escaped temp parent");
  fs.rmSync(scratch, { recursive: true, force: true });
  return report;
}
async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--baseline", "--candidate", "--samples", "--history", "--output"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("usage: benchmark.mjs --baseline <repo> --candidate <repo> [--samples 10] [--history 100] --output <json>");
    options[name.slice(2)] = args[index + 1];
  }
  if (!options.baseline || !options.candidate || !options.output) throw new Error("baseline, candidate and output are required");
  const samples = Number(options.samples ?? 10);
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error("samples must be 1..100");
  const history = Number(options.history ?? 100);
  if (!Number.isInteger(history) || history < 0 || history > 1000) throw new Error("history must be 0..1000");
  const report = await benchmark({ baseline: path.resolve(options.baseline), candidate: path.resolve(options.candidate), output: path.resolve(options.output), samples, history });
  console.log(`wrote ${report.rows.length} calls to ${path.resolve(options.output)}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
