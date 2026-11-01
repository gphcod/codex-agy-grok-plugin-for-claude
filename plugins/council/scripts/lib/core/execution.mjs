// Ported from grok-build-plugin-cc 1.1.5 lib/execution.mjs (commit 9c66028). Changes (PLAN.md S2
// table): ownsExecution delegates to the adapter's ownsProcess and hasFlagOperand is exported over
// row.argv and row.raw; the darwin `ps` query adds `pgid=`; the empty-command-line binary list covers
// codex, agy, grok and node with .exe variants; the depth guard spans the four A5.1 variables, read on
// admission and set on every child; PowerShell strings stay inline (no .ps1 on disk). The group stop
// with SIGTERM → SIGKILL escalation comes from gemini-plugin-cc lib/process.mjs:154-186.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "./fs.mjs";
import { UsageError } from "./catalog.mjs";

const UNKNOWN = { state: "unknown", rows: [] };
// The first WMI query on a cold Windows machine can take several seconds; a query cut short reads as unknown.
export const QUERY_MS = 20000;
/** Grace between SIGTERM to the process group and SIGKILL of what is left. */
export const GRACE_MS = 1500;
const norm = (s, platform) => platform === "win32" ? String(s).replace(/\\/g, "/").toLowerCase() : String(s);
const decodeHex = (s) => /^(?:[0-9a-f]{4})*$/.test(s) ? (s.match(/.{4}/g) ?? []).map((c) => String.fromCharCode(parseInt(c, 16))).join("") : null;
/** A text field of the Windows query: "=" and printable ASCII as is, or "x" and UTF-16 code units in hex. */
export const decodeText = (s) => s[0] === "=" ? (/^[\x20-\x7e]*$/.test(s.slice(1)) ? s.slice(1) : null) : s[0] === "x" ? decodeHex(s.slice(1)) : null;
const psRun = (script, env, timeout = QUERY_MS) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
  env: { ...process.env, ...env }, encoding: "utf8", shell: false, windowsHide: true, timeout,
  maxBuffer: 16 * 1024 * 1024,
});

// --- depth guard (A5.1) ------------------------------------------------------------------------------

/** The replaced plugins read the last three; every council child receives all four. */
export const GUARD_VARS = ["COUNCIL_DEPTH", "CODEX_COMPANION_DEPTH", "GROK_BUILD_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH"];
/** The guard variable that marks this process as nested, or null. Read on admission. */
export function nestedBy(env = process.env) {
  return GUARD_VARS.find((name) => typeof env[name] === "string" && env[name] !== "") ?? null;
}
export function assertNotNested(env = process.env) {
  const by = nestedBy(env);
  if (by) throw new UsageError(`refusing a nested call: this process runs inside a provider turn started by a plugin (${by} is set)`);
}
/**
 * The child environment: the caller's, the adapter's additions, then all four guard variables. The
 * host's session id stays behind: whatever a provider starts is not that session.
 */
export function childEnv(base, extra = {}) {
  const env = { ...base, ...extra };
  delete env.CLAUDE_CODE_SESSION_ID;
  for (const name of GUARD_VARS) env[name] = "1";
  return env;
}

// ASCII framing avoids console code-page corruption. No Add-Type or static .NET calls.
// Text that is printable ASCII (no tab, CR or LF) is sent as is after "="; anything else, including
// non-ASCII, control characters and NUL, as "x" and its UTF-16 code units in hex. \z, not $, ends
// the test: $ would also match before a final newline. -cmatch: a case-insensitive range can match
// non-ASCII case variants (the Kelvin sign is a k). Hex costs a PowerShell loop step per character,
// so it is kept for the rare text that needs it. The rows go out as one string, not one pipeline
// output each. A null command line (another user or elevation) is reported as "-": the row stays in
// the table as inaccessible, so a relevant pid is unknown rather than absent. The thread count tells
// an exited process that an open handle keeps listed (no threads, no readable command line) from a
// live one; a missing count fails the whole query rather than reading as zero. The module-qualified
// name loads CimCmdlets directly instead of searching every module for the command.
// Windows PowerShell finds CimCmdlets only through its module path, which comes from the inherited
// PSModulePath and the machine's: one that lacks $PSHOME\Modules (an emptied machine value) or puts
// PowerShell 7's CimCmdlets first fails every query. So both scripts name their own module path.
export const MODULES = `$env:PSModulePath="$PSHOME\\Modules";`;
export const WINDOWS_LIST = `${MODULES}$ErrorActionPreference='Stop';
$props = 'ProcessId','ParentProcessId','CreationDate','CommandLine','Name','ThreadCount';
if ($env:CC_QUERY_PID) { $items = @(CimCmdlets\\Get-CimInstance Win32_Process -Property $props -Filter "ProcessId=$env:CC_QUERY_PID") } else { $items = @(CimCmdlets\\Get-CimInstance Win32_Process -Property $props) };
'ok'; $rows = @(foreach ($p in $items) {
  $cl = $p.CommandLine; $n = "$($p.Name)";
  $raw = if ($null -eq $cl) { '-' } elseif ($cl -cmatch '^[ -~]*\\z') { "=$cl" } else { 'x' + (-join $(foreach ($ch in [char[]]$cl) { '{0:x4}' -f [int]$ch })) };
  $name = if ($n -cmatch '^[ -~]*\\z') { "=$n" } else { 'x' + (-join $(foreach ($ch in [char[]]$n) { '{0:x4}' -f [int]$ch })) };
  $stamp = if ($p.CreationDate) { "$($p.CreationDate.ToUniversalTime().Ticks)" } else { "0" };
  "$($p.ProcessId)\t$($p.ParentProcessId)\t$stamp\t$raw\t$name\t$($p.ThreadCount)"
}); if ($rows.Count) { $rows -join "\n" }; 'complete'`;

function linuxRow(proc, pid, boot) {
  const file = `${proc}/${pid}`;
  const stat = fs.readFileSync(`${file}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return null;
  const argv = fs.readFileSync(`${file}/cmdline`, "utf8").split("\0");
  if (argv.at(-1) === "") argv.pop();
  const check = fs.readFileSync(`${file}/stat`, "utf8"), again = check.slice(check.lastIndexOf(")") + 2).split(" ");
  if (again[19] !== fields[19]) throw new Error("process identity changed during query");
  const row = { pid, ppid: Number(fields[1]), group: Number(fields[2]), stamp: fields[19], boot, argv, raw: argv.join(" "),
    name: path.basename(argv[0] ?? ""), uid: fs.statSync(file).uid };
  // PF_EXITING (0x4), read after the command line: the process is still its children's parent until
  // the kernel reparents them, and its command line may already read empty.
  return Number(again[6]) & 4 ? { ...row, exiting: true } : row;
}

/**
 * Splits a Windows command line into arguments the way CommandLineToArgvW does:
 * - argv[0] is the program name: a quoted run up to the next quote, else up to whitespace, with no
 *   backslash processing.
 * - After it, whitespace outside quotes separates arguments.
 * - 2n backslashes before a quote give n backslashes, and the quote starts or ends a quoted run;
 *   2n+1 backslashes before a quote give n backslashes and a literal quote; backslashes that are
 *   not before a quote are literal.
 * - Inside a quoted run, two quotes in a row give one literal quote and the run ends (so a third
 *   quote right after them starts a new quoted run).
 */
export function parseWindowsCommandLine(line) {
  const isSpace = (char) => char === " " || char === "\t";
  let i = 0;
  while (isSpace(line[i])) i += 1;
  let programEnd = i;
  let program;
  if (line[i] === '"') {
    programEnd = line.indexOf('"', i + 1);
    programEnd = programEnd < 0 ? line.length : programEnd;
    program = line.slice(i + 1, programEnd);
    i = Math.min(programEnd + 1, line.length);
  } else {
    while (programEnd < line.length && !isSpace(line[programEnd])) programEnd += 1;
    program = line.slice(i, programEnd);
    i = programEnd;
  }
  const args = [program];
  let current = "", inArgument = false, inQuotes = false;
  while (i < line.length) {
    const char = line[i];
    if (char === "\\") {
      let backslashes = 0;
      while (line[i] === "\\") { backslashes += 1; i += 1; }
      inArgument = true;
      if (line[i] !== '"') current += "\\".repeat(backslashes);
      else {
        current += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) { current += '"'; i += 1; }
      }
    } else if (char === '"') {
      inArgument = true;
      if (inQuotes && line[i + 1] === '"') { current += '"'; inQuotes = false; i += 2; }
      else { inQuotes = !inQuotes; i += 1; }
    } else if (isSpace(char) && !inQuotes) {
      if (inArgument) { args.push(current); current = ""; inArgument = false; }
      i += 1;
    } else { current += char; inArgument = true; i += 1; }
  }
  if (inArgument) args.push(current);
  return args;
}

/**
 * A query process that failed: unknown, with the cause for the job's error and cancel's report.
 * PowerShell prints an error's message and then its position ("At line:"); only the message is kept.
 */
function queryFailed(r, timeout) {
  if (r.error) return { ...UNKNOWN, error: r.error.code === "ETIMEDOUT" ? `process query timed out after ${timeout / 1000} s` : `process query failed: ${r.error.message}` };
  const text = String(r.stderr ?? "").split(/\r?\n\s*At line:/)[0].replace(/\s+/g, " ").trim().slice(0, 300);
  return { ...UNKNOWN, error: `process query failed: ${text || `exit code ${r.status}`}` };
}

/** Complete scoped process snapshot; an unavailable query is never an empty table. */
export function processSnapshot({ pid = null, platform = process.platform, run = spawnSync, powershell = psRun, timeout = QUERY_MS, proc = "/proc" } = {}) {
  try {
    if (platform === "linux") {
      const ids = pid === null ? fs.readdirSync(proc).filter((p) => /^\d+$/.test(p)).map(Number) : [pid];
      const boot = fs.readFileSync(`${proc}/sys/kernel/random/boot_id`, "utf8").trim(), rows = [];
      const deadline = Date.now() + timeout;
      for (const id of ids) {
        if (Date.now() > deadline) return UNKNOWN;
        try {
          if (pid === null && fs.statSync(`${proc}/${id}`).uid !== process.getuid()) continue;
          const row = linuxRow(proc, id, boot);
          if (row) rows.push(row);
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ESRCH") return UNKNOWN;
        }
      }
      return { state: "ok", rows };
    }
    if (platform === "win32") {
      const r = powershell(WINDOWS_LIST, { CC_QUERY_PID: pid === null ? "" : String(pid) }, timeout);
      if (r.error || r.status !== 0) return queryFailed(r, timeout);
      const lines = r.stdout.trimEnd().split(/\r?\n/);
      if (lines.shift() !== "ok" || lines.pop() !== "complete") return UNKNOWN;
      const rows = [];
      for (const line of lines) {
        const fields = line.split("\t");
        if (fields.length !== 6 || ![...fields.slice(0, 3), fields[5]].every((s) => /^\d+$/.test(s))) return UNKNOWN;
        // An exited process held open by a handle has no threads: like a zombie elsewhere, it is not running.
        if (fields[5] === "0") continue;
        const inaccessible = fields[3] === "-";
        const raw = inaccessible ? null : decodeText(fields[3]);
        const name = decodeText(fields[4]);
        if ((!inaccessible && raw === null) || name === null) return UNKNOWN;
        rows.push({ pid: Number(fields[0]), ppid: Number(fields[1]), stamp: fields[2], raw, name, inaccessible,
          argv: raw ? parseWindowsCommandLine(raw) : null });
      }
      return { state: "ok", rows };
    }
    if (platform === "darwin") {
      // pgid= added (PLAN.md A7.5): a group member reparented to pid 1 is still found through its group.
      const r = run("ps", ["-ww", ...(pid === null ? ["-ax"] : ["-p", String(pid)]), "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart=,args="], {
        // TZ=UTC: lstart stamps are identity evidence compared across processes, so they must not depend
        // on the caller's time zone (a cancel run under another TZ would read a live owner as gone).
        encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8", TZ: "UTC" }, shell: false, timeout,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.error || (r.status !== 0 && !(pid !== null && r.status === 1 && !r.stdout.trim()))) return queryFailed(r, timeout);
      const rows = [];
      for (const line of r.stdout.split("\n").filter((s) => s.trim())) {
        // A uid can be negative (nobody is -2); one unmatched row would make the whole snapshot unknown.
        // process.getuid() reports that uid unsigned (4294967294), so compare it unsigned.
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(line);
        if (!m) return UNKNOWN;
        if (m[5].startsWith("Z") || (pid === null && Number(m[4]) >>> 0 !== process.getuid())) continue;
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), group: Number(m[3]), stamp: m[6].replace(/\s+/g, " "), raw: m[7], argv: null, name: m[7].split(" ")[0] });
      }
      return { state: "ok", rows };
    }
  } catch { return UNKNOWN; }
  return UNKNOWN;
}

export function sameIdentity(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.stamp && b.stamp === a.stamp && (a.boot ?? null) === (b.boot ?? null));
}
export function currentIdentity(pid = process.pid, options = {}) {
  const snapshot = processSnapshot({ ...options, pid });
  return snapshot.state === "ok" ? snapshot.rows[0] ?? null : null;
}

/**
 * Whether a process row carries `<flag> <value>` as a job-specific operand. On Linux and Windows the
 * row has argv and the operand is matched exactly. On macOS `ps` gives only the raw command line, so
 * the match needs the job's recorded argv: the raw line must end with the recorded argument suffix
 * (which contains the operand) and start with the recorded launcher or the bare provider binary,
 * never a path substring (grok-build lib/execution.mjs:229-240). `bins` are the provider's binary
 * names (`["grok"]`), which qualify even when the recorded launcher was a node script.
 */
export function hasFlagOperand(row, flag, value, job = null, platform = process.platform, bins = []) {
  if (typeof value !== "string" || !value) return false;
  if (Array.isArray(row.argv)) return row.argv.some((s, i) => s === flag && norm(row.argv[i + 1], platform) === norm(value, platform));
  if (typeof row.raw !== "string") return false;
  const recordedArgs = Array.isArray(job?.childArgs) ? job.childArgs : Array.isArray(job?.argv) && job.argv.length > 1 ? job.argv.slice(1) : null;
  if (recordedArgs) {
    const i = recordedArgs.indexOf(flag);
    if (i < 0 || recordedArgs[i + 1] !== value) return false;
    const suffix = recordedArgs.join(" ");
    if (!row.raw.endsWith(` ${suffix}`)) return false;
    const program = row.raw.slice(0, -suffix.length - 1);
    const launcherArgs = Array.isArray(job.argv) ? job.argv.slice(0, job.argv.length - recordedArgs.length) : [];
    const recorded = launcherArgs.join(" ");
    // The provider binary names come from the adapter: with `node /npm/grok` recorded, a native
    // `/vendor/grok` carrying the job's operand is still this job's (grok-build lib/execution.mjs:239).
    const names = [...new Set([...bins, path.basename(launcherArgs[0] ?? "")].filter(Boolean))];
    return program === recorded || names.some((bin) => new RegExp(`(?:^|/)${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(program));
  }
  // No recorded argv: whole-token match of the pair.
  return row.raw.includes(` ${flag} ${value} `) || row.raw.endsWith(` ${flag} ${value}`);
}

/** The adapter decides what evidence marks a process as this job's (A5 ownsProcess). */
export function ownsExecution(row, job, platform = process.platform, adapter = null) {
  if (adapter?.ownsProcess) return Boolean(adapter.ownsProcess(row, job, platform));
  return false;
}

// Windows creation times are .NET ticks (100 ns since year 1); this is the Unix epoch in them.
const EPOCH_TICKS = 621355968000000000n;

/** On Windows a PowerShell query costs most of a second per turn, so Node supplies the start time instead. */
export function selfIdentity(platform = process.platform, options = {}) {
  if (platform === "win32") return { pid: process.pid, startedMs: Math.round(Date.now() - process.uptime() * 1000) };
  return currentIdentity(process.pid, { platform, ...options });
}

/** The companion's identity, not its heartbeat, controls whether recovery can free a claim. */
export function companionState(job, snapshot) {
  if (snapshot.state !== "ok") return "unknown";
  const row = snapshot.rows.find((r) => r.pid === job.companionPid);
  if (!row) return "gone";
  const id = job.companionIdentity;
  if (!id) return "unknown"; // old record: a reused/live bare pid proves nothing
  if (id.startedMs === undefined) return sameIdentity(row, id) ? "live" : "gone";
  if (!/^[1-9]\d*$/.test(row.stamp ?? "")) return "unknown";
  // Node starts its clock a little after Windows creates the process. A pid reused within 5 s of
  // the companion's own start would read as live, which only delays recovery.
  return Math.abs(Number((BigInt(row.stamp) - EPOCH_TICKS) / 10000n) - id.startedMs) <= 5000 ? "live" : "gone";
}

/** Immutable cancellation evidence survives a canceller dying after it killed the root process. */
export function recoveryEvidence(job) {
  const dir = path.join(job.dir, "cleanup-evidence");
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    if (record.ownerToken !== (job.ownerToken ?? null) || !Array.isArray(record.rows)) throw new Error("unreadable cleanup evidence");
    rows.push(...record.rows);
  }
  return rows;
}
export function recordRecoveryEvidence(job, rows) {
  if (!rows.length) return;
  const dir = path.join(job.dir, "cleanup-evidence");
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, `${randomUUID()}.json`), JSON.stringify({ ownerToken: job.ownerToken ?? null, rows }));
}

/** Binaries whose empty command line makes a snapshot unknown rather than clean. */
export const BARE_BINARIES = ["codex", "codex.exe", "agy", "agy.exe", "grok", "grok.exe", "node", "node.exe"];

/** Discover native backends behind dead launchers and retain separately grouped known descendants. */
/**
 * A creation time comparable within one platform's snapshot, or null: Linux start ticks and Windows
 * creation ticks are integers; a macOS `ps -o lstart=` stamp ("Sat Oct 31 12:26:47 2026") is parsed
 * to epoch seconds, never compared as text.
 */
export function startTime(stamp) {
  if (typeof stamp !== "string" || !stamp) return null;
  if (/^\d+$/.test(stamp)) return BigInt(stamp);
  const ms = Date.parse(`${stamp} UTC`); // queried with TZ=UTC
  return Number.isNaN(ms) ? null : BigInt(Math.floor(ms / 1000));
}
// Windows never reparents, so a process whose parent died can name a pid reused by an owned
// process; a real child is never older than its parent. Unparseable stamps do not decide.
function bornAfter(child, parent) {
  const c = startTime(child.stamp), p = startTime(parent.stamp);
  return c === null || p === null || c >= p;
}

export function ownedExecution(job, snapshot, platform = process.platform, evidence = [], adapter = null) {
  if (snapshot.state !== "ok") return { state: "unknown", rows: [], ...(snapshot.error && { error: snapshot.error }) };
  // Without the provider's ownsProcess nothing can be told apart: unknown, never `gone` (no stop, no release).
  if (typeof adapter?.ownsProcess !== "function") return { state: "unknown", rows: [], error: `ownership of job ${job.id ?? "?"} cannot be checked without its provider module` };
  const rows = snapshot.rows;
  const known = [...(job.execution ?? []), ...evidence];
  const owned = new Map();
  let unknown = false;
  const names = new Set([...BARE_BINARIES, path.basename(job.argv?.[0] ?? "").toLowerCase()].filter(Boolean));
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    if (ownsExecution(row, job, platform, adapter) || known.some((p) => sameIdentity(p, row))) owned.set(row.pid, row);
    if (!row.raw && !row.inaccessible && names.has(String(row.name ?? "").toLowerCase())) unknown = true;
  }
  // A7.5 (S2.9): a member of the child's process group is adopted through the group only while the
  // recorded leader is alive with its recorded creation time, and only when born at or after it.
  // Once the leader is gone, absence of a conflicting leader is no evidence: a member is ours only
  // when its pid and creation time match a descendant identity persisted while the job ran (the
  // `known` set above, refreshed at every heartbeat and stop snapshot). Any other member is never
  // signalled; it is reported as unverified, which keeps the outcome from reading as `gone`.
  const recorded = job.pid ? (job.leader?.pid === job.pid ? job.leader : known.find((p) => p.pid === job.pid)) ?? null : null;
  const leaderStart = recorded ? startTime(recorded.stamp) : null;
  const liveLeader = job.pid ? rows.find((r) => r.pid === job.pid) : null;
  const leaderVerified = Boolean(liveLeader && leaderStart !== null && startTime(liveLeader.stamp) === leaderStart);
  const unverified = [];
  for (const row of rows) {
    if (owned.has(row.pid) || row.pid === process.pid || row.pid === job.companionPid || row.group === undefined || !job.pid || row.group !== job.pid) continue;
    const born = startTime(row.stamp);
    if (leaderVerified && born !== null && born >= leaderStart) owned.set(row.pid, row);
    // A live leader with a recorded identity and another creation time owns a reused group: provably
    // not ours. Everything else is ambiguous — including a missing leader record (the identification
    // at spawn can fail) — so it is unverified: never signalled, and cleanup never reads as gone.
    else if (!(liveLeader && recorded && !leaderVerified)) unverified.push(row);
  }
  // Snapshot all descendants before any parent is killed, including descendants in other groups.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.pid) && owned.has(row.ppid) && bornAfter(row, owned.get(row.ppid))) { owned.set(row.pid, row); changed = true; }
    }
  }
  // An inaccessible process matters only as the launched pid, a known identity or an owned descendant.
  if (rows.some((r) => r.inaccessible && (r.pid === job.pid || owned.has(r.pid) || known.some((p) => sameIdentity(p, r))))) unknown = true;
  // An exiting process's command line can read empty before it becomes a zombie; it is still owned.
  if ([...owned.values()].some((r) => !r.stamp || r.stamp === "0" || (!r.raw && !r.exiting))) unknown = true;
  const pending = unverified.filter((r) => !owned.has(r.pid));
  if (pending.length) {
    return { state: "unknown", rows: [...owned.values()], unverified: pending,
      error: `unverified: ${pending.length} process(es) in the job's process group (${pending.map((r) => r.pid).join(", ")}) match no identity recorded while it ran; not signalled` };
  }
  return { state: unknown ? "unknown" : owned.size ? "owned" : "gone", rows: [...owned.values()] };
}

export const WINDOWS_KILL = `${MODULES}$ErrorActionPreference='Stop';
try { $p=Get-Process -Id $env:CC_KILL_PID -ErrorAction Stop; $h=$p.Handle } catch { 'unknown'; exit };
if ($p.HasExited) { 'gone'; exit };
$q=Get-CimInstance Win32_Process -Filter "ProcessId=$env:CC_KILL_PID";
if (-not $q -or -not $q.CommandLine) { 'unknown'; exit };
if ("$($q.CreationDate.ToUniversalTime().Ticks)" -ne $env:CC_KILL_STAMP -or $q.CommandLine -cne $env:CC_KILL_RAW) { 'mismatch'; exit };
taskkill /T /F /PID $env:CC_KILL_PID | Out-Null;
if ($LASTEXITCODE -eq 0 -or $p.HasExited) { 'sent' } else { 'unknown' }`;

/**
 * Signal delivery is not confirmation. Callers must rescan before declaring cleanup complete.
 * `signal` defaults to SIGKILL (the escalation); the first attempt on a group is SIGTERM through
 * stopProcessGroup. → sent | gone | mismatch | unknown
 */
export function stopIdentity(row, { platform = process.platform, snapshot = processSnapshot, kill = process.kill.bind(process), powershell = psRun, timeout = QUERY_MS, signal = "SIGKILL" } = {}) {
  if (row.pid === process.pid) return "unknown";
  if (platform === "win32") {
    const r = powershell(WINDOWS_KILL, { CC_KILL_PID: String(row.pid), CC_KILL_STAMP: row.stamp, CC_KILL_RAW: row.raw }, timeout);
    const result = r.stdout?.trim().split(/\s+/).at(-1);
    return r.status === 0 && ["sent", "gone", "mismatch"].includes(result) ? result : "unknown";
  }
  const now = snapshot({ pid: row.pid, platform, timeout });
  if (now.state !== "ok") return "unknown";
  const current = now.rows.find((r) => r.pid === row.pid);
  if (!current) return "gone";
  if (!sameIdentity(row, current)) return "mismatch";
  if (platform === "darwin" && current.raw !== row.raw) return "unknown"; // ps birth stamps have only second precision.
  try { kill(row.pid, signal); return "sent"; }
  catch (e) { return e.code === "ESRCH" ? "gone" : "unknown"; }
}

/** Whether any process of the group `pgid` is still alive (POSIX). */
export function isProcessGroupAlive(pgid, { kill = process.kill.bind(process) } = {}) {
  try { kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * gemini-plugin-cc lib/process.mjs:154-186: SIGTERM to the process group (falling back to the pid),
 * then SIGKILL for whatever is left after `graceMs`. Windows has no group signal; the per-row
 * taskkill /T /F of stopIdentity is the whole stop there.
 */
export async function stopProcessGroup(pid, { platform = process.platform, graceMs = GRACE_MS, kill = process.kill.bind(process), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), escalate = true } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || platform === "win32") return { attempted: false, delivered: false, escalated: false };
  const signal = (name) => {
    try { kill(-pid, name); return true; }
    catch { try { kill(pid, name); return true; } catch { return false; } }
  };
  const delivered = signal("SIGTERM");
  if (!escalate) return { attempted: true, delivered, escalated: false };
  const deadline = Date.now() + graceMs;
  while (isProcessGroupAlive(pid, { kill }) && Date.now() < deadline) await sleep(50);
  let escalated = false;
  if (isProcessGroupAlive(pid, { kill })) escalated = signal("SIGKILL");
  return { attempted: true, delivered, escalated };
}

/** The controller the lifecycle and cancel use; `adapter` supplies ownsProcess (or null for wait). */
export function executionController(options = {}) {
  const platform = options.platform ?? process.platform;
  const snapshot = options.snapshot ?? processSnapshot;
  const adapter = options.adapter ?? null;
  return {
    platform,
    snapshot: (timeout = QUERY_MS) => snapshot({ platform, timeout, powershell: options.powershell, run: options.run, proc: options.proc }),
    self: () => selfIdentity(platform, { snapshot, powershell: options.powershell, run: options.run }),
    /** The identity of one pid (a scoped query), used to record the child as its group's leader right after the spawn. */
    identify: (pid, timeout = QUERY_MS) => { const r = snapshot({ pid, platform, timeout, powershell: options.powershell, run: options.run, proc: options.proc }); return r.state === "ok" ? r.rows.find((row) => row.pid === pid) ?? null : null; },
    inspect: (job, snap) => ownedExecution(job, snap, platform, recoveryEvidence(job), adapter),
    stop: (row, timeout = QUERY_MS, signal = "SIGKILL") => stopIdentity(row, { ...options, platform, snapshot, timeout, signal }),
    // The lifecycle's group stop is SIGTERM only: the escalation to SIGKILL goes through stop(), which
    // verifies each process's identity first, never to a bare group id that may have been reused.
    stopGroup: (pid) => stopProcessGroup(pid, { platform, kill: options.kill, sleep: options.sleep, escalate: false }),
  };
}
