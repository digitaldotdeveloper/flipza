/**
 * Publishes `dist/` to the `gh-pages` branch.
 *
 *   npm run deploy
 *
 * A branch rather than a GitHub Actions build, for one reason: the build needs
 * sharp to key and pack 120-odd source images, and what it produces is exactly
 * what was checked locally. Pushing the checked bytes is one less thing that
 * can differ between what was approved and what is live.
 *
 * The branch is built in a worktree rather than by checking it out, so the
 * working tree is never switched - a half-finished edit in src/ cannot end up
 * on gh-pages, and nothing has to be stashed to deploy.
 *
 * `.nojekyll` matters: without it GitHub Pages runs the output through Jekyll,
 * which ignores every file and directory whose name starts with an underscore.
 * Vite names its output directory `assets`, so nothing breaks today - but it
 * costs one empty file to never think about it again.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

/**
 * The worktree is built outside the project, and under a fresh name each run.
 *
 * Inside it, a directory Windows has marked delete-pending - which is what a
 * lingering file handle on a freshly deleted tree looks like - cannot be
 * removed *or* recreated, and every later deploy fails on the leftover. A path
 * nothing else will ever touch sidesteps the whole class of problem.
 */
const tree = path.join(os.tmpdir(), `flipza-deploy-${Date.now().toString(36)}`)
const BRANCH = 'gh-pages'

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

try {
  await stat(path.join(dist, 'index.html'))
} catch {
  console.error('deploy: no dist/index.html - run `npm run build` first')
  process.exit(1)
}

// Worktrees from interrupted runs are registered but gone; git refuses to add
// a new one while it still believes in them.
try {
  git('worktree', 'prune')
} catch {
  // nothing to prune
}

const hasBranch = (() => {
  try {
    git('rev-parse', '--verify', BRANCH)
    return true
  } catch {
    return false
  }
})()

if (hasBranch) {
  git('worktree', 'add', tree, BRANCH)
} else {
  // Orphan: the site has no history in common with the source, and does not
  // want the source's history dragged along behind it.
  git('worktree', 'add', '--detach', tree)
  execFileSync('git', ['checkout', '--orphan', BRANCH], { cwd: tree, stdio: 'ignore' })
}

// Everything except .git, so a file deleted from the build is deleted from the
// branch too rather than lingering on the live site.
for (const name of await readdir(tree)) {
  if (name === '.git') continue
  await rm(path.join(tree, name), { recursive: true, force: true })
}

await mkdir(tree, { recursive: true })
await cp(dist, tree, { recursive: true })
await writeFile(path.join(tree, '.nojekyll'), '')

execFileSync('git', ['add', '-A'], { cwd: tree, stdio: 'ignore' })
const changed = execFileSync('git', ['status', '--porcelain'], { cwd: tree, encoding: 'utf8' }).trim()

if (!changed) {
  console.log('deploy: gh-pages already matches dist/, nothing to push')
} else {
  const rev = git('rev-parse', '--short', 'HEAD')
  execFileSync('git', ['commit', '-m', `Deploy ${rev}`], { cwd: tree, stdio: 'ignore' })
  execFileSync('git', ['push', '-u', 'origin', BRANCH], { cwd: tree, stdio: 'inherit' })
  console.log(`deploy: pushed ${BRANCH} from ${rev}`)
}

try {
  execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: root, stdio: 'ignore' })
} catch {
  // The push is what mattered and it is done. A worktree that will not go
  // quietly is left for `git worktree prune` to forget about next time.
}
