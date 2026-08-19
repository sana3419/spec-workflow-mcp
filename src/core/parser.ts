import { readFile, readdir, access, stat } from 'fs/promises';
import { join } from 'path';
import { PathUtils } from './path-utils.js';
import { SpecData, SteeringStatus } from '../types.js';
import { parseTaskProgress } from './task-parser.js';

export interface ParsedSpec extends SpecData {
  displayName: string;
}


export class SpecParser {
  private projectPath: string;
  private specsPath: string;
  private archiveSpecsPath: string;
  private steeringPath: string;

  constructor(projectPath: string) {
    // Path should already be translated by caller (ProjectManager)
    this.projectPath = projectPath;
    this.specsPath = PathUtils.getSpecPath(projectPath, '');
    this.archiveSpecsPath = PathUtils.getArchiveSpecsPath(projectPath);
    this.steeringPath = PathUtils.getSteeringPath(projectPath);
  }

  async getAllSpecs(): Promise<ParsedSpec[]> {
    return this.listSpecDirs(this.specsPath, name => this.getSpec(name));
  }

  async getAllArchivedSpecs(): Promise<ParsedSpec[]> {
    return this.listSpecDirs(this.archiveSpecsPath, name => this.getArchivedSpec(name));
  }

  async getSpec(name: string): Promise<ParsedSpec | null> {
    return this.readSpecDir(name, PathUtils.getSpecPath(this.projectPath, name));
  }

  async getArchivedSpec(name: string): Promise<ParsedSpec | null> {
    return this.readSpecDir(name, PathUtils.getArchiveSpecPath(this.projectPath, name));
  }

  private async listSpecDirs(
    root: string,
    read: (name: string) => Promise<ParsedSpec | null>
  ): Promise<ParsedSpec[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const specs: ParsedSpec[] = [];
      for (const dir of entries.filter(entry => entry.isDirectory())) {
        const spec = await read(dir.name);
        if (spec) {
          specs.push(spec);
        }
      }

      return specs.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  private async readSpecDir(name: string, specDir: string): Promise<ParsedSpec | null> {
    try {
      const dirStats = await stat(specDir);

      const spec: ParsedSpec = {
        name,
        displayName: this.formatDisplayName(name),
        createdAt: dirStats.birthtime.toISOString(),
        lastModified: dirStats.mtime.toISOString(),
        phases: {
          requirements: { exists: false },
          design: { exists: false },
          tasks: { exists: false },
          implementation: { exists: false }
        }
      };

      const phaseFiles = [
        ['requirements', 'requirements.md'],
        ['design', 'design.md'],
        ['tasks', 'tasks.md']
      ] as const;

      for (const [phase, file] of phaseFiles) {
        const filePath = join(specDir, file);
        try {
          const fileStats = await stat(filePath);
          spec.phases[phase].exists = true;
          spec.phases[phase].lastModified = fileStats.mtime.toISOString();

          // Update overall last modified if this is newer
          if (fileStats.mtime > new Date(spec.lastModified)) {
            spec.lastModified = fileStats.mtime.toISOString();
          }

          if (phase === 'tasks') {
            const taskProgress = parseTaskProgress(await readFile(filePath, 'utf-8'));
            spec.taskProgress = {
              total: taskProgress.total,
              completed: taskProgress.completed,
              pending: taskProgress.pending
            };
          }
        } catch {}
      }

      // Implementation phase is always considered "exists" since it's ongoing manual work
      spec.phases.implementation.exists = true;

      return spec;
    } catch {
      return null;
    }
  }


  async getProjectSteeringStatus(): Promise<SteeringStatus> {
    const status: SteeringStatus = {
      exists: false,
      documents: {
        product: false,
        tech: false,
        structure: false
      }
    };

    try {
      await access(this.steeringPath);
      status.exists = true;

      // Check each steering document
      try {
        await access(join(this.steeringPath, 'product.md'));
        status.documents.product = true;
      } catch {}

      try {
        await access(join(this.steeringPath, 'tech.md'));
        status.documents.tech = true;
      } catch {}

      try {
        await access(join(this.steeringPath, 'structure.md'));
        status.documents.structure = true;
      } catch {}

      // Get last modified time for steering directory
      const steeringStats = await stat(this.steeringPath);
      status.lastModified = steeringStats.mtime.toISOString();

    } catch {}

    return status;
  }


  private formatDisplayName(kebabCase: string): string {
    return kebabCase
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}