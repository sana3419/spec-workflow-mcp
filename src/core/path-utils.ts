import { join, normalize, sep, resolve, posix } from 'path';
import { access, stat } from 'fs/promises';
import { constants } from 'fs';

export class PathUtils {
  /** macOS and Windows are case-insensitive filesystems */
  private static readonly IS_CASE_INSENSITIVE =
    process.platform === 'darwin' || process.platform === 'win32';

  /** Cached path configuration (undefined = not checked, null = invalid/missing) */
  private static pathConfig: { hostPrefix: string; containerPrefix: string } | null | undefined;

  /**
   * Get cached path configuration from environment variables.
   * Caches result to prevent race conditions from env var changes mid-operation.
   */
  private static getPathConfig(): { hostPrefix: string; containerPrefix: string } | null {
    if (this.pathConfig !== undefined) {
      return this.pathConfig;
    }

    const hostPrefix = process.env.SPEC_WORKFLOW_HOST_PATH_PREFIX?.trim();
    const containerPrefix = process.env.SPEC_WORKFLOW_CONTAINER_PATH_PREFIX?.trim();

    if (!hostPrefix || !containerPrefix) {
      this.pathConfig = null;
      return null;
    }

    // Validate absolute paths
    if (!this.isAbsolutePath(hostPrefix) || !this.isAbsolutePath(containerPrefix)) {
      console.error('[PathUtils] Path prefixes must be absolute paths');
      this.pathConfig = null;
      return null;
    }

    // Security: Reject prefixes containing directory traversal
    if (hostPrefix.includes('..') || containerPrefix.includes('..')) {
      console.error('[PathUtils] Path prefixes must not contain directory traversal (..)');
      this.pathConfig = null;
      return null;
    }

    this.pathConfig = { hostPrefix, containerPrefix };
    return this.pathConfig;
  }

  /** Check if path is absolute (Unix or Windows style) */
  private static isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  }

  /** Reset cached config (for testing) */
  static resetPathConfig(): void {
    this.pathConfig = undefined;
  }

  /**
   * Normalize path for cross-platform comparison using built-in path.posix.
   * Converts backslashes to forward slashes, removes trailing slashes.
   */
  private static normalizeForComparison(p: string): string {
    // Convert to Unix-style, then use built-in posix.normalize
    const unixStyle = p.replace(/\\/g, '/');
    // posix.normalize handles /./, /../, and // but keeps trailing slash
    const normalized = posix.normalize(unixStyle);
    // Remove trailing slash for consistent comparison (except for root "/")
    return normalized.endsWith('/') && normalized.length > 1
      ? normalized.slice(0, -1)
      : normalized;
  }

  /**
   * Check if a path matches a prefix with proper boundary checking.
   * - Prevents partial matches like "/Users/dev" matching "/Users/developer"
   * - Handles case-insensitivity on macOS/Windows
   * - Normalizes path separators for cross-platform support
   */
  private static pathMatchesPrefix(path: string, prefix: string): boolean {
    let normalizedPath = this.normalizeForComparison(path);
    let normalizedPrefix = this.normalizeForComparison(prefix);

    if (this.IS_CASE_INSENSITIVE) {
      normalizedPath = normalizedPath.toLowerCase();
      normalizedPrefix = normalizedPrefix.toLowerCase();
    }

    if (normalizedPath === normalizedPrefix) return true;

    // Special case: root prefix "/" matches any absolute path
    if (normalizedPrefix === '/') {
      return normalizedPath.startsWith('/');
    }

    return normalizedPath.startsWith(normalizedPrefix + '/');
  }

  /**
   * Translate a host path to container path if running in Docker with path mapping configured.
   *
   * Environment variables:
   * - SPEC_WORKFLOW_HOST_PATH_PREFIX: Path prefix on the host (e.g., /Users/username)
   * - SPEC_WORKFLOW_CONTAINER_PATH_PREFIX: Corresponding path in container (e.g., /projects)
   *
   * Example: If host prefix is "/Users/dev" and container prefix is "/projects",
   * then "/Users/dev/myapp" becomes "/projects/myapp"
   */
  static translatePath(hostPath: string): string {
    const config = this.getPathConfig();
    if (!config) return hostPath;
    // Already a container path: nothing to do. This makes translation idempotent,
    // which is what lets the path accessors below translate unconditionally.
    // With nested prefixes (e.g. a "/" host prefix) a host path that genuinely sits
    // under the container prefix is indistinguishable from an already-translated
    // one; treating it as translated is the safe reading, since double-translation
    // silently produces a path that exists nowhere.
    if (this.pathMatchesPrefix(hostPath, config.containerPrefix)) return hostPath;
    return this.remapPrefix(hostPath, config.hostPrefix, config.containerPrefix);
  }

  /**
   * Reverse translation: container path back to host path (for display/registry)
   */
  static reverseTranslatePath(containerPath: string): string {
    const config = this.getPathConfig();
    return config ? this.remapPrefix(containerPath, config.containerPrefix, config.hostPrefix) : containerPath;
  }

  /**
   * Swap one path prefix for another, preserving the structure below it.
   * Shared by both translation directions so the two can never diverge.
   */
  private static remapPrefix(path: string, from: string, to: string): string {
    if (!this.pathMatchesPrefix(path, from)) return path;

    const normalizedFrom = this.normalizeForComparison(from);
    const normalizedPath = this.normalizeForComparison(path);

    // Get relative path preserving structure
    let relativePath = normalizedPath.substring(normalizedFrom.length);
    // Ensure relative path starts with separator (needed for root prefix case)
    if (relativePath && !relativePath.startsWith('/')) {
      relativePath = '/' + relativePath;
    }
    const result = this.normalizeForComparison(to) + relativePath;

    // Security: Validate no directory traversal in result
    if (result.includes('/../') || result.endsWith('/..')) {
      throw new Error('Path translation resulted in directory traversal attempt');
    }

    return result;
  }

  /**
   * Validate a single path segment that must not contain traversal or separators.
   */
  static validateSimplePathSegment(pathSegment: string, label: string = 'path segment'): void {
    if (!pathSegment || typeof pathSegment !== 'string') {
      throw new Error(`Invalid ${label}`);
    }

    if (
      pathSegment === '.' ||
      pathSegment.includes('..') ||
      pathSegment.includes('/') ||
      pathSegment.includes('\\') ||
      pathSegment.includes('\0')
    ) {
      throw new Error(
        `Security error: ${label} must be a simple name without path traversal or directory separators`
      );
    }
  }

  /**
   * Safely join paths ensuring no directory traversal
   */
  static safeJoin(basePath: string, ...paths: string[]): string {
    // Validate base path
    if (!basePath || typeof basePath !== 'string') {
      throw new Error('Invalid base path');
    }
    
    // Check each path segment for traversal attempts
    for (const pathSegment of paths) {
      if (pathSegment && (pathSegment.includes('..') || pathSegment.startsWith('/'))) {
        throw new Error(`Invalid path segment: ${pathSegment}`);
      }
    }
    
    const joined = normalize(join(basePath, ...paths));
    const resolvedBase = resolve(basePath);
    const resolvedJoined = resolve(joined);
    
    // Ensure the joined path is within the base path (with separator boundary check)
    if (resolvedJoined !== resolvedBase && !resolvedJoined.startsWith(resolvedBase + sep)) {
      throw new Error('Path traversal detected in join operation');
    }
    
    return joined;
  }
  
  static getWorkflowRoot(projectPath: string): string {
    return this.workflowJoin(projectPath);
  }

  /**
   * The single door to every .spec-workflow path. Callers pass the project path as
   * they received it — a host path in Docker mode — and translation happens here,
   * once, so no call site can forget it.
   */
  private static workflowJoin(projectPath: string, ...segments: string[]): string {
    return this.safeJoin(this.translatePath(projectPath), '.spec-workflow', ...segments);
  }

  static getSpecPath(projectPath: string, specName: string): string {
    return this.workflowJoin(projectPath, 'specs', specName);
  }

  static getArchiveSpecPath(projectPath: string, specName: string): string {
    return this.workflowJoin(projectPath, 'archive', 'specs', specName);
  }

  static getArchiveSpecsPath(projectPath: string): string {
    return this.workflowJoin(projectPath, 'archive', 'specs');
  }

  static getSteeringPath(projectPath: string): string {
    return this.workflowJoin(projectPath, 'steering');
  }


  // Ensure paths work across Windows, macOS, Linux
  // Get relative path from project root
}

export async function validateProjectPath(projectPath: string): Promise<string> {
  try {
    // Validate input
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error('Invalid project path: path must be a non-empty string');
    }
    
    // Check for dangerous path patterns before resolving
    if (projectPath.includes('..') || projectPath.includes('~')) {
      // Normalize the path first to check if it's actually traversing
      const normalized = normalize(projectPath);
      const resolved = resolve(normalized);
      
      // Get the current working directory for comparison
      const cwd = process.cwd();
      
      // Additional check: ensure the resolved path doesn't contain parent directory references
      if (normalized.includes('..') && !resolved.startsWith(cwd)) {
        throw new Error(`Path traversal detected: ${projectPath}`);
      }
    }
    
    // Resolve to absolute path
    const absolutePath = resolve(projectPath);
    
    // Security check: Ensure the path doesn't escape to system directories
    const systemPaths = ['/etc', '/usr', '/bin', '/sbin', '/var', '/sys', '/proc'];
    const windowsSystemPaths = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
    const allSystemPaths = process.platform === 'win32' ? windowsSystemPaths : systemPaths;
    
    for (const sysPath of allSystemPaths) {
      if (absolutePath.toLowerCase().startsWith(sysPath.toLowerCase())) {
        throw new Error(`Access to system directory not allowed: ${absolutePath}`);
      }
    }
    
    // Check if path exists
    await access(absolutePath, constants.F_OK);
    
    // Ensure it's a directory
    const stats = await stat(absolutePath);
    if (!stats.isDirectory()) {
      throw new Error(`Project path is not a directory: ${absolutePath}`);
    }
    
    // Final security check: ensure we can actually access this directory
    await access(absolutePath, constants.R_OK | constants.W_OK);
    
    return absolutePath;
  } catch (error) {
    if (error instanceof Error) {
      if ((error as any).code === 'ENOENT') {
        throw new Error(`Project path does not exist: ${projectPath}`);
      } else if ((error as any).code === 'EACCES') {
        throw new Error(`Permission denied accessing project path: ${projectPath}`);
      }
      throw error;
    }
    throw new Error(`Unknown error validating project path: ${String(error)}`);
  }
}
