#!/usr/bin/env node
// Installs this fork's renderer (the view mod) into an installed Orgtree, or
// puts the stock one back. The installed engine serves the UI from
// <install>\resources\ui per request, so no reinstall or restart is needed:
// reload the window (or reopen the org) after `apply`.
//
//   node tools/viewmod-ui.mjs build   (into dist/renderer-viewmod only)
//   node tools/viewmod-ui.mjs apply   [--install D:\Orgtree] [--no-build]
//   node tools/viewmod-ui.mjs restore [--install D:\Orgtree]
//   node tools/viewmod-ui.mjs status  [--install D:\Orgtree]
//
// apply backs the stock UI up once per installed version, beside it, as
// resources\ui.stock-<version>. An Orgtree update replaces resources\ui with
// the new stock UI; run apply again afterwards, from a fork rebased onto the
// new version (the renderer must match the installed engine and main).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const [cmd = 'status', ...rest] = process.argv.slice(2)
const opt = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
const install = path.resolve(opt('--install') ?? 'D:\\Orgtree')
const resources = path.join(install, 'resources')
const ui = path.join(resources, 'ui')
const marker = path.join(ui, '.viewmod.json')
const out = path.resolve('dist/renderer-viewmod')

if (!fs.existsSync(path.join(ui, 'index.html'))) throw new Error(`no Orgtree UI at ${ui}`)
const installed = JSON.parse(fs.readFileSync(path.join(resources, 'build-info.json'), 'utf8'))
const backup = path.join(resources, `ui.stock-${installed.version}`)
const modded = () => fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null
const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim() } catch { return null } }

if (cmd === 'status') {
  const m = modded()
  console.log(`installed Orgtree ${installed.version} (${installed.commit?.slice(0, 9)}) at ${install}`)
  console.log(m ? `UI: view mod from ${m.commit?.slice(0, 9)}${m.dirty ? ' (uncommitted changes)' : ''}, applied ${m.at}` : 'UI: stock')
  console.log(`stock backup: ${fs.existsSync(backup) ? backup : 'none'}`)
} else if (cmd === 'build') {
  const { build } = await import('vite')
  await build({ root: 'apps/desktop/renderer', base: '/', logLevel: 'warn', build: { outDir: out, emptyOutDir: true } })
  fs.copyFileSync('apps/desktop/assets/orgtree-eye.svg', path.join(out, 'assets', 'orgtree-eye.svg'))
  console.log(`built ${out}`)
} else if (cmd === 'apply') {
  const base = git('merge-base', 'HEAD', `v${installed.version}`)
  const tag = git('rev-parse', `v${installed.version}^{commit}`)
  if (!tag) throw new Error(`no v${installed.version} tag here: fetch upstream tags first`)
  if (base !== tag) throw new Error(`this checkout is not based on v${installed.version}, which is installed: rebase the mod onto it first`)
  if (!rest.includes('--no-build')) {
    const { build } = await import('vite')
    await build({ root: 'apps/desktop/renderer', base: '/', logLevel: 'warn',
      build: { outDir: out, emptyOutDir: true } })
    fs.copyFileSync('apps/desktop/assets/orgtree-eye.svg', path.join(out, 'assets', 'orgtree-eye.svg'))
  }
  if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error(`no build at ${out}`)
  if (!modded() && !fs.existsSync(backup)) {
    fs.cpSync(ui, backup, { recursive: true })
    console.log(`backed up the stock UI to ${backup}`)
  }
  // assets first (new hashed names; old ones stay for windows still open), the page last
  fs.cpSync(path.join(out, 'assets'), path.join(ui, 'assets'), { recursive: true })
  for (const f of fs.readdirSync(out)) {
    if (f !== 'assets' && f !== 'index.html') fs.cpSync(path.join(out, f), path.join(ui, f), { recursive: true })
  }
  fs.copyFileSync(path.join(out, 'index.html'), path.join(ui, 'index.html'))
  const dirty = !!git('status', '--porcelain', '--untracked-files=no')
  fs.writeFileSync(marker, JSON.stringify({ commit: git('rev-parse', 'HEAD'), dirty, at: new Date().toISOString(),
    orgtree: installed.version }, null, 2))
  console.log(`view mod applied to ${ui}: reload the Orgtree window (Ctrl+R) or reopen the org`)
} else if (cmd === 'restore') {
  if (!fs.existsSync(backup)) throw new Error(`no stock backup for ${installed.version} at ${backup}`)
  fs.rmSync(ui, { recursive: true, force: true })
  fs.cpSync(backup, ui, { recursive: true })
  console.log(`stock UI restored from ${backup}: reload the Orgtree window`)
} else {
  throw new Error(`unknown command ${cmd}: apply, restore or status`)
}
