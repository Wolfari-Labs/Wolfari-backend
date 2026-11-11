// Export the reviewed working trees, including deployment patches not yet committed.
// Does not commit, stage or copy ignored files, secrets, build outputs or local databases.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function exportable(path) {
  return (
    !/(^|\/)(\.git|\.local|node_modules|dist[^/]*|coverage|playwright-report|test-results)(\/|$)/.test(
      path,
    ) &&
    !/(^|\/)\.env(?!\.example$|\.sample$|\.template$)[^/]*(\/|$)/.test(path) &&
    !/\.(pem|key|p12|pfx|age|dump|backup)$/i.test(path) &&
    !path.includes('..') &&
    !path.startsWith('/')
  );
}
export async function exportRelease(workspace, output) {
  if (!isAbsolute(output) || !output.endsWith('.tar.gz'))
    throw new Error('Use a new absolute .tar.gz path');
  try {
    await access(output);
    throw new Error('Output already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const scratch = await mkdtemp(resolve(tmpdir(), 'wolfari-release-'));
  const manifest = {
    createdAt: new Date().toISOString(),
    kind: 'reviewed-working-tree',
    repositories: {},
    files: {},
  };
  try {
    for (const name of ['Wolfari-backend', 'Wolfari-web']) {
      const cwd = resolve(workspace, name);
      const git = (args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
      const branch = git(['branch', '--show-current']);
      if (branch !== 'feat/single-host-trial-deploy') throw new Error(`Wrong branch: ${name}`);
      manifest.repositories[name] = {
        branch,
        base: git(['rev-parse', 'HEAD']),
        status: git(['status', '--porcelain']),
      };
      const paths = [
        ...new Set(
          git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
            .split('\0')
            .filter(Boolean),
        ),
      ].sort();
      for (const path of paths) {
        if (!exportable(path)) continue;
        const source = resolve(cwd, path);
        let stat;
        try {
          stat = await lstat(source);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (!stat.isFile()) throw new Error(`Refusing non-regular file: ${name}/${path}`);
        let bytes = await readFile(source);
        // Linux scripts must never receive Windows CRLF; SQL checksums are untouched.
        if (/\.(sh|service|target|timer)$/.test(path))
          bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
        const relative = `${name}/${path}`;
        const destination = resolve(scratch, relative);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
        await chmod(destination, path.endsWith('.sh') ? 0o755 : 0o644);
        manifest.files[relative] = createHash('sha256').update(bytes).digest('hex');
      }
    }
    const guide = 'HUONG_DAN_DEPLOY_WOLFARI_GOOGLE_CLOUD.md';
    const bytes = await readFile(resolve(workspace, guide));
    await writeFile(resolve(scratch, guide), bytes);
    manifest.files[guide] = createHash('sha256').update(bytes).digest('hex');
    await writeFile(
      resolve(scratch, 'release-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    execFileSync('tar', ['-czf', output, '-C', scratch, '.'], { stdio: 'inherit' });
    console.log(
      `Exported ${Object.keys(manifest.files).length} files. Review archive inventory before transfer.`,
    );
    console.log(
      `SHA256 ${createHash('sha256')
        .update(await readFile(output))
        .digest('hex')}`,
    );
  } finally {
    // Only the exact directory created above is removed. No repository/user paths.
    await rm(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  exportRelease(workspace, process.argv[2] ?? '').catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
