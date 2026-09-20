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
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const tree = path.join(root, '.deploy')
const BRANCH = 'gh-pages'

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

try {
  await stat(path.join(dist, 'index.html'))
} catch {
  console.error('deploy: no dist/index.html - run `npm run build` first')
  process.exit(1)
}

// A worktree left behind by an interrupted deploy would make `worktree add`
// fail, and it holds no state worth keeping.
await rm(tree, { recursive: true, force: true })
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

execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: root, stdio: 'ignore' })
