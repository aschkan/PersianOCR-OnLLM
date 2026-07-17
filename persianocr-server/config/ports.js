/**
 * Port reclaim — find and kill whatever is holding a TCP port so the app can bind
 * it. Used on startup so a stale/previous instance (EADDRINUSE) never blocks a
 * restart. Linux-first (lsof → fuser → ss), best-effort.
 */
const { execSync } = require('child_process');

function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return ''; }
}

/** Numeric PIDs listening on `port` (excluding this process). */
function findPidsOnPort(port) {
  const pids = new Set();
  const add = (s) => s.split(/\s+/).filter(Boolean).forEach((p) => { const n = Number(p); if (Number.isInteger(n) && n > 0) pids.add(n); });

  add(sh(`lsof -ti tcp:${port} -sTCP:LISTEN`));
  if (!pids.size) add(sh(`fuser ${port}/tcp`));
  if (!pids.size) {
    // ss prints "...users:(("node",pid=1234,fd=20))"
    const out = sh(`ss -ltnp sport = :${port}`);
    (out.match(/pid=(\d+)/g) || []).forEach((m) => { const n = Number(m.slice(4)); if (n) pids.add(n); });
  }
  pids.delete(process.pid);
  return [...pids];
}

/** SIGKILL a pid (falls back to `kill -9`). */
function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); return true; }
  catch { return !!sh(`kill -9 ${pid}`) || true; }
}

/**
 * Kill anything holding `port`. Returns the PIDs it killed. Disable with
 * RECLAIM_PORT=false.
 */
function reclaimPort(port, log = console) {
  if (/^(0|false|no)$/i.test(process.env.RECLAIM_PORT || 'true')) return [];
  let pids = [];
  try { pids = findPidsOnPort(port); } catch { return []; }
  if (pids.length) {
    log.warn?.(`⚠️  port ${port} is held by PID ${pids.join(', ')} — killing it to reclaim the port`);
    pids.forEach((p) => killPid(p));
  }
  return pids;
}

module.exports = { findPidsOnPort, killPid, reclaimPort };
