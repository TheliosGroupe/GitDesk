// Which repository settings are risky, what they do in plain words, and what GitDesk
// does about them until the repository is trusted. Pure: unit-tested.

import { isAbsolute, relative } from 'path'
import type { TrustEffect, TrustFinding } from '../../shared/features/trust'
import { splitKey, type ConfigEntry } from './gitconfig'

export type Finding = TrustFinding

/**
 * A path on another computer: a Windows UNC or device path (\\host\share, //host/share,
 * \\?\UNC\…) or a file:// URL with a host. Opening one makes Windows connect to that
 * host and sign in with your account. Long local paths (\\?\C:\…) are local.
 */
export function isNetworkPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const v = p.trim()
  if (/^[\\/]{2}[?.][\\/][A-Za-z]:([\\/]|$)/.test(v)) return false
  if (/^[\\/]{2}/.test(v)) return true
  // file://host/path, file:////host/path (file:///C:/x and file://localhost/ are local).
  const m = /^file:(\/\/[^/]*)?(.*)$/i.exec(v)
  if (!m) return false
  const host = (m[1] ?? '//').slice(2).toLowerCase()
  return (host !== '' && host !== 'localhost') || /^[\\/]{2}/.test(m[2])
}

/** `child` is `parent` or inside it (case-insensitive on Windows, like path.relative). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** What `git lfs install --local` writes: runs the git-lfs you installed, nothing else. */
const LFS_DEFAULTS: Record<string, string> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process'
}

// A double-quoted shell string with no expansion in it ($, backquote) and only "\n" escapes.
const PLAIN_STRING = '"[^"$`\\\\]*(?:\\\\n[^"$`\\\\]*)*"'
const LFS_CHECK = new RegExp(
  String.raw`^command -v git-lfs >/dev/null 2>&1 \|\| \{ (?:printf >&2 ${PLAIN_STRING} ${PLAIN_STRING}|echo >&2 ${PLAIN_STRING}); exit 2; \}$`
)

/**
 * A hook exactly as Git LFS writes it ("git lfs <hook>" when git-lfs is installed, a
 * message otherwise): it only runs the git-lfs you installed. Without its pre-push hook a
 * push would send LFS pointers without the files, so these are not flagged.
 */
export function isLfsHook(name: string, text: string): boolean {
  if (!['pre-push', 'post-checkout', 'post-commit', 'post-merge'].includes(name)) return false
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
  return (
    lines.length === 3 &&
    lines[0] === '#!/bin/sh' &&
    LFS_CHECK.test(lines[1]) &&
    lines[2] === `git lfs ${name} "$@"`
  )
}

/** http.* settings that only tune performance. Everything else there changes security. */
const SAFE_HTTP = new Set([
  'postbuffer',
  'lowspeedlimit',
  'lowspeedtime',
  'maxrequests',
  'minsessions',
  'version',
  'noepsv',
  'useragent',
  'getanyfile',
  'uploadpack',
  'receivepack'
])

const BOOL = /^(true|false|yes|no|on|off|1|0)$/i

type Rule = { effect: TrustEffect; text: string }

/** The rule for one repository setting, or null when it is harmless. */
export function ruleFor(key: string, value: string | null): Rule | null {
  const v = value ?? ''
  const { section, sub, name } = splitKey(key)
  const named = sub ? ` "${sub}"` : ''
  const ignored = (text: string): Rule => ({ effect: 'ignored', text })
  const network = (text: string): Rule => ({ effect: 'network', text })

  switch (key) {
    case 'core.fsmonitor':
      return BOOL.test(v) ? null : ignored('Runs a program to watch for file changes')
    case 'core.hookspath':
      return ignored(`Runs hook scripts from ${v || 'another folder'}`)
    case 'core.sshcommand':
      return ignored('Uses its own command to connect over SSH')
    case 'core.askpass':
      return ignored('Runs its own program to ask for passwords')
    case 'core.gitproxy':
      return ignored('Runs its own proxy program for git:// connections')
    case 'core.alternaterefscommand':
      return ignored('Runs a program while talking to remotes')
    case 'core.worktree':
      return ignored(
        `Puts its working files in another folder (${v}); GitDesk keeps using this folder`
      )
    case 'sequence.editor':
      return ignored('Opens its own editor program during a rebase')
    case 'diff.external':
      return ignored('Runs an external program to show differences')
    case 'gpg.program':
    case 'gpg.ssh.defaultkeycommand':
      return ignored('Runs its own program to sign commits')
  }
  if (section === 'credential' && name === 'helper')
    return v ? ignored('Runs its own program to provide passwords') : null
  if (section === 'diff' && sub && (name === 'textconv' || name === 'command'))
    return ignored(
      name === 'textconv'
        ? `Runs a program to convert files before showing differences (diff${named})`
        : `Runs an external program to show differences (diff${named})`
    )
  if (section === 'filter' && sub && ['clean', 'smudge', 'process'].includes(name))
    return LFS_DEFAULTS[key] === v
      ? null
      : ignored(`Runs a program on file contents when files are read or written (filter${named})`)
  if (section === 'merge' && sub && name === 'driver')
    return ignored(`Runs its own program to merge files (merge driver${named})`)
  if (section === 'gpg' && sub && name === 'program')
    return ignored('Runs its own program to sign commits')
  if (section === 'submodule' && sub && name === 'update' && v.startsWith('!'))
    return ignored(`Runs a command when submodule${named} is updated`)
  if (section === 'protocol' && name === 'allow')
    return ignored('Changes which kinds of connections git may use')
  if (section === 'remote' && sub && (name === 'uploadpack' || name === 'receivepack'))
    return network(`Runs its own git server program for remote${named}`)
  if (section === 'remote' && sub && (name === 'proxy' || name === 'proxyauthmethod'))
    return network(`Sends traffic for remote${named} through a proxy`)
  if (section === 'url' && sub && (name === 'insteadof' || name === 'pushinsteadof'))
    return network('Rewrites the addresses git connects to')
  if (section === 'http' && !SAFE_HTTP.has(name)) {
    if (name === 'sslverify' && /^(true|yes|on|1)$/i.test(v)) return null
    if (name.startsWith('ssl') || name.startsWith('schannel') || name === 'pinnedpubkey')
      return network('Changes how HTTPS certificates are checked')
    if (name.startsWith('proxy')) return network('Sends HTTPS traffic through a proxy')
    if (['extraheader', 'cookiefile', 'savecookies', 'emptyauth', 'delegation'].includes(name))
      return network('Adds its own headers, cookies or sign-in to HTTPS requests')
    return network('Changes how HTTPS connections are made')
  }
  return null
}

/** Keys whose value is a remote address: one on another computer only pauses the network. */
const ADDRESS_KEY = /^(remote\..+\.(url|pushurl)|url\..+\.(insteadof|pushinsteadof))$/

/** Findings for a list of repository settings (includes already followed). */
export function classifyEntries(
  entries: ConfigEntry[],
  repo: string,
  platform: NodeJS.Platform = process.platform
): Finding[] {
  const findings: Finding[] = []
  // A partial clone fetches missing files from its promisor remote while reading (log -p,
  // blame…): GIT_NO_LAZY_FETCH stops that only on git 2.44 or later.
  const partial = entries.some(
    (e) =>
      (e.key === 'extensions.partialclone' && e.value) ||
      (/^remote\..+\.promisor$/.test(e.key) && /^(true|yes|on|1)$/i.test(e.value ?? 'true')) ||
      (/^remote\..+\.partialclonefilter$/.test(e.key) && e.value)
  )
  for (const e of entries) {
    const value = e.value ?? ''
    // A url.<base>.insteadOf names the address in its subsection.
    const addresses = [value, ...(e.key.startsWith('url.') ? [splitKey(e.key).sub ?? ''] : [])]
    const remote = addresses.find((a) => isNetworkPath(a, platform) && !isInside(a, repo))
    if (remote !== undefined) {
      const address = ADDRESS_KEY.test(e.key)
      findings.push({
        key: e.key,
        value,
        file: e.file,
        // Not only the network for a partial clone: reading a file could open it.
        effect: address && !partial ? 'network' : 'blocked',
        text: !address
          ? `Points to a file on another computer (${remote})`
          : partial
            ? `Downloads missing files from a shared folder on another computer (${remote})`
            : `Fetches from or pushes to a shared folder on another computer (${remote})`
      })
      continue
    }
    const rule = ruleFor(e.key, e.value)
    if (rule) findings.push({ key: e.key, value, file: e.file, ...rule })
  }
  return findings
}
