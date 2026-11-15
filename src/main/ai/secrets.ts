// Files and contents that look like secrets (keys, tokens, credentials): their content is
// never put in a prompt, only their path with SECRET_REASON. Pure, so it is unit-tested.
// Every pattern is linear: literal prefixes, no nested quantifiers.

export const SECRET_REASON = 'possible secret, not shown'

const SECRET_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  '.pgpass',
  'credentials',
  '.dockercfg',
  '.envrc',
  'kubeconfig'
])

/** Example files that hold placeholders, not secrets. */
const EXAMPLE = /\.(example|sample|template|dist|defaults?)$/

/** True for a file name that usually holds secrets (.env, private keys, credential files). */
export function isSecretPath(path: string): boolean {
  const lower = path.toLowerCase() // git paths use '/'
  const name = lower.split('/').pop() ?? ''
  if (SECRET_NAMES.has(name)) return true
  // .env, .env.local, prod.env (Docker env_file)…
  if ((name.endsWith('.env') || name.startsWith('.env.')) && !EXAMPLE.test(name)) return true
  if (/\.(pem|key|p8|p12|pfx|keystore|jks|ppk|kdbx|age)$/.test(name)) return true
  if (/\.tfvars(\.json)?$/.test(name) || name.startsWith('terraform.tfstate')) return true
  if (/(^|\/)\.(docker\/config\.json|kube\/config)$/.test(lower)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name) && !name.endsWith('.pub')) return true
  if (/^(credentials|service-account|client_secret)[\w.-]*\.json$/.test(name)) return true
  if (/^secrets?\.(json|ya?ml|toml|env)$/.test(name)) return true
  return false
}

const SECRET_CONTENT = new RegExp(
  [
    // PEM / OpenSSH / PGP private keys
    '-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----',
    // cloud access key ids
    '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
    '\\bAIza[0-9A-Za-z_-]{35}',
    // GitHub, GitLab, Slack, npm tokens
    '\\bgh[pousr]_[A-Za-z0-9]{36}',
    '\\bgithub_pat_[A-Za-z0-9_]{40}',
    '\\bglpat-[A-Za-z0-9_-]{20}',
    '\\bxox[abprs]-[A-Za-z0-9-]{10}',
    '\\bnpm_[A-Za-z0-9]{36}',
    // AI provider and payment API keys
    '\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32}',
    '\\b[rs]k_live_[0-9A-Za-z]{20}'
  ].join('|')
)

/** True when the text holds something that looks like a private key or an access token. */
export function hasSecretContent(text: string): boolean {
  return SECRET_CONTENT.test(text)
}

/** SECRET_REASON when the path or the content looks like a secret, else null. */
export function secretReason(path: string, content?: string | null): string | null {
  return isSecretPath(path) || (content ? hasSecretContent(content) : false) ? SECRET_REASON : null
}
