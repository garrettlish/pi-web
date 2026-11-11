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

const args = process.argv.slice(2);
const sessionArg = args.indexOf("--session");
const sessionFile = sessionArg >= 0 ? args[sessionArg + 1] : null;

let steering = [];
let followUp = [];

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
