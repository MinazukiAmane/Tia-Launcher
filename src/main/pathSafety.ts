// Validate archive and manifest paths before filesystem access.
import { lstat } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'

// Reject absolute paths and parent traversal before resolving.
export function assertSafeRelativePath(
  relPath: string,
  label: string,
  onViolation: (reason: string) => never
): void {
  if (typeof relPath !== 'string' || !relPath || /[\x00-\x1f:]/.test(relPath) || /^[\\/]/.test(relPath) || isAbsolute(relPath)) {
    onViolation(`${label} must be a safe relative path: ${relPath}`)
  }
  const segments = relPath.split(/[\\/]+/).filter(Boolean)
  if (!segments.length || segments.some(part => part === '..' || part === '.' || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    onViolation(`${label} contains an unsafe path segment: ${relPath}`)
  }
}

// Use relative paths to support drive roots and UNC shares.
export function isWithinRoot(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target))
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path))
}

// Reject resolved paths outside the installation root.
export function resolveWithinRoot(
  root: string,
  relPath: string,
  label: string,
  onViolation: (reason: string) => never
): string {
  assertSafeRelativePath(relPath, label, onViolation)
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(resolvedRoot, relPath)
  if (!isWithinRoot(resolvedRoot, resolvedTarget)) {
    onViolation(`${label} resolves outside of its root directory: ${relPath}`)
  }
  return resolvedTarget
}


// Reject existing links before accessing package-controlled descendants.
export async function assertNoLinkedPath(root: string, target: string): Promise<void> {
  if (!isWithinRoot(root, target)) throw new Error('File path escapes the installation directory.')
  const parts = relative(resolve(root), resolve(target)).split(sep).filter(Boolean)
  let current = resolve(root)
  for (const part of parts) {
    current = resolve(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed in installation paths.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}
