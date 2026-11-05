// check-exports.mjs — works on Windows (OneDrive) and Unix
// Packs to %TEMP% / /tmp to avoid OneDrive write-lock issues
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dest = tmpdir();
const json = execSync(`npm pack --pack-destination "${dest}" --json`, { encoding: 'utf8' });
const filename = JSON.parse(json)[0].filename;
const tgzPath = join(dest, filename);

try {
  // Run publint against local directory (no extra pack needed)
  execSync('npx publint --pack false', { stdio: 'inherit' });
  // Run attw against the temp tarball
  execSync(`npx @arethetypeswrong/cli "${tgzPath}"`, { stdio: 'inherit' });
} finally {
  rmSync(tgzPath, { force: true });
}
