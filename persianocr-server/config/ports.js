/**
 * Port reclaim — find and kill whatever is holding a TCP port so the app can bind
 * it. Used on startup so a stale/previous instance (EADDRINUSE) never blocks a
 * restart. Linux-first (lsof → fuser → ss), best-effort.
 */
const { execSync } = require('child_process');
const fs = require('fs');

function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return ''; }
}

// Primary detector: read /proc directly — no lsof/fuser/ss needed, so it works
// on a bare server. Find the socket inode(s) LISTENing on `port` in
// /proc/net/tcp{,6}, then find which process holds that inode via /proc/<pid>/fd.
function findPidsViaProc(port) {
  const hex = (port & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let data; try { data = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of data.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10) continue;
      const localPort = (c[1] || '').split(':')[1];
      if (localPort === hex && c[3] === '0A') inodes.add(c[9]); // 0A = LISTEN, c[9] = inode
    }
  }
  if (!inodes.size) return [];
  const pids = new Set();
  let dirs; try { dirs = fs.readdirSync('/proc'); } catch { return []; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    let fds; try { fds = fs.readdirSync(`/proc/${d}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link; try { link = fs.readlinkSync(`/proc/${d}/fd/${fd}`); } catch { continue; }
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && inodes.has(m[1])) { pids.add(Number(d)); break; }
    }
  }
  return [...pids];
}

/** Numeric PIDs listening on `port` (excluding this process). */
function findPidsOnPort(port) {
  const pids = new Set();
  const add = (s) => s.split(/\s+/).filter(Boolean).forEach((p) => { const n = Number(p); if (Number.isInteger(n) && n > 0) pids.add(n); });

  try { findPidsViaProc(port).forEach((p) => pids.add(p)); } catch { /* fall through */ }
  if (!pids.size) add(sh(`lsof -ti tcp:${port} -sTCP:LISTEN`));
  if (!pids.size) add(sh(`fuser ${port}/tcp`));
  if (!pids.size) {
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
