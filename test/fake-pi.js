#!/usr/bin/env node
/**
 * Minimal stand-in for `pi --mode rpc`, used by test/smoke.js.
 *
 * It answers get_state and keeps a steering/follow-up queue, which is enough
 * to exercise the server's queue snapshot: a tab that re-attaches has to learn
 * what the process still holds, and a real pi needs credentials and a model.
 * Everything it does is the smallest faithful subset of the RPC docs.
 */
import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const sessionArg = args.indexOf("--session");
const sessionFile = sessionArg >= 0 ? args[sessionArg + 1] : null;

let steering = [];
let followUp = [];
let toolSeq = 0;

/** Where to append the pid of each leftover child, so a test run that fails
 *  before reading the pid can still clean up. Precise on purpose: a sweep that
 *  matched command lines would also hit anything else mentioning the string. */
const PIDFILE = process.env.PI_WEB_SMOKE_PIDFILE || "";

/**
 * A bash tool call that leaves a process behind, shaped exactly like the real
 * failure: pi runs the command in a shell of its own, the command backgrounds a
 * child with `nohup … &`, and the shell exits. The child is reparented to init
 * and keeps the dead shell's process group — which is the signature the server's
 * diff relies on, so spawning the child directly here would test nothing.
 *
 * The marker in the prompt selects this; the queue checks still see plain replies.
 */
async function runFakeBash(message) {
  const toolCallId = `call_fake_${++toolSeq}`;
  emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: message } });
  // Echo the grandchild's pid so the test can assert on the exact process it
  // expects to be listed, and record it so a failed run cannot leak it.
  const command = `${process.execPath} -e 'setTimeout(()=>{}, 120000)' >/dev/null 2>&1 </dev/null & echo $!`;
  const shell = spawn("/bin/sh", ["-c", command], {
    // pi spawns the tool shell detached; the process group is what makes the
    // leftover identifiable after the shell is gone.
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  for await (const chunk of shell.stdout) out += chunk.toString("utf8");
  const pid = Number(out.trim().split("\n").pop());
  // Record the pid before the test can fail to receive it. A red run then still
  // knows what to kill, and the file is the only source — matching command lines
  // would also catch an innocent process that merely mentions the string.
  if (Number.isInteger(pid) && PIDFILE) {
    try {
      appendFileSync(PIDFILE, `${pid}\n`);
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  emit({ type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [] }, isError: false });
  emit({ type: "fake_child", pid: Number.isInteger(pid) ? pid : null });
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function emitQueue() {
  emit({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  const respond = (data, success = true) =>
    emit({ type: "response", id: cmd.id, command: cmd.type, success, data });

  switch (cmd.type) {
    case "get_state":
      respond({ sessionFile, isStreaming: false, isCompacting: false });
      break;
    case "prompt":
      // "LEAVE-A-PROCESS" selects the bash-call simulation; anything else is an
      // ordinary accepted prompt.
      if (String(cmd.message || "").includes("LEAVE-A-PROCESS")) {
        respond({ disposition: "started" });
        void runFakeBash(cmd.message);
      } else {
        respond({ disposition: "started" });
      }
      break;
    case "steer":
      steering.push(cmd.message);
      respond({ disposition: "queued" });
      emitQueue();
      break;
    case "follow_up":
      followUp.push(cmd.message);
      respond({ disposition: "queued" });
      emitQueue();
      break;
    case "clear_queue": {
      const cleared = { steering: [...steering], followUp: [...followUp] };
      steering = [];
      followUp = [];
      respond(cleared);
      emitQueue();
      break;
    }
    case "get_entries":
      respond({ entries: [], leafId: null });
      break;
    default:
      respond({});
      break;
  }
});

// The RPC client waits for the process to stay alive; an EOF on stdin means
// the server asked us to stop.
process.stdin.on("end", () => process.exit(0));
