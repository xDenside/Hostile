const FORBIDDEN_PATHS = [
  { kind: 'environment file', re: /(^|\/)\.env(\.[^/]+)?$/, except: /\.example$/ },
  { kind: 'local state directory', re: /(^|\/)\.local\// },
  { kind: 'database dump', re: /\.(dump|pgdump|sql\.gz)$/i },
  { kind: 'private key file', re: /\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ecdsa|ed25519)$/i },
];

const SECRET_PATTERNS = [
  { kind: 'PEM private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'Slack token', re: /\bxox[abeoprs]-[A-Za-z0-9-]{20,}\b/ },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: 'AI provider key', re: /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/ },
];

export function forbiddenPath(path) {
  for (const { kind, re, except } of FORBIDDEN_PATHS) {
    if (re.test(path) && !except?.test(path)) return kind;
  }
  return null;
}

export function findSecrets(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const { kind, re } of SECRET_PATTERNS) {
      if (re.test(line)) found.push({ kind, line: index + 1 });
    }
  });
  return found;
}
