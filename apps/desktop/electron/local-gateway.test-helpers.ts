/**
 * Temp homes for the local-gateway suites that bind real AF_UNIX control sockets.
 *
 * sun_path is 104 bytes on macOS (108 on Linux). There os.tmpdir() is
 * /var/folders/xx/<28 chars>/T (~49 chars, /private/var/... once realpath'd),
 * and vitest.run-tmp.ts nests a vitest-XXXXXX root under it, so
 * `<home>/gateway.sock` and `<runtime>/hermes-gw-<16 hex>/control.sock` overflow.
 * On darwin the base is /tmp (/private/tmp); never the user's home.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * An interpreter that runs the ticket helper exactly as production spawns it.
 * The helper passes `-P` (3.11+, matching pyproject's requires-python floor);
 * macOS's /usr/bin/python3 is the Xcode 3.9 shim, which rejects it, so a bare
 * `python3` default made the bridge exit before answering. Probe with the real
 * flags instead of weakening them; fail loudly rather than skip when none fits.
 */
export function ticketHelperPython(): string {
  const explicit = process.env.HERMES_TEST_PYTHON
  const candidates = explicit ? [explicit] : ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11']

  const accepted = candidates.find(candidate => spawnSync(candidate, ['-P', '-u', '-c',
    'import sys; sys.exit(sys.version_info < (3, 11))'], { stdio: 'ignore' }).status === 0)

  if (!accepted) {
    throw new Error(`No Python >= 3.11 accepting -P among ${candidates.join(', ')}; set HERMES_TEST_PYTHON`)
  }

  return accepted
}

/** Canonical (realpath'd: the gateway canonicalises profile_id) temp dir with a short prefix. */
export async function shortSocketTmpDir(prefix: string): Promise<string> {
  // no-tmp: ok — macOS AF_UNIX sun_path is 104 bytes; os.tmpdir() there is too long for the socket.
  const base = os.platform() === 'darwin' ? '/tmp' : os.tmpdir()

  return fs.realpath(await fs.mkdtemp(path.join(base, prefix)))
}
