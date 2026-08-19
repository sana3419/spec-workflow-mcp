import { promises as fs } from 'fs';
import { join } from 'path';
import { ImplementationLog, ImplementationLogEntry } from '../types.js';
import { entryToMarkdown } from './implementation-log-format.js';
import { appendFileSync, existsSync } from 'fs';

/**
 * Migrates implementation logs from JSON format to individual markdown files
 * This utility class handles the automatic migration when the MCP server starts
 */
export class ImplementationLogMigrator {
  private migrationLogPath: string;

  constructor(userDataDir: string) {
    this.migrationLogPath = join(userDataDir, 'migration.log');
  }

  /**
   * Log migration events
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    appendFileSync(this.migrationLogPath, logMessage, 'utf-8');
  }

  /**
   * Sanitize taskId for use in filenames (e.g., "1.2" → "1-2")
   */
  private sanitizeTaskId(taskId: string): string {
    return taskId.replace(/[/.]/g, '-');
  }

  /**
   * Generate markdown filename for a log entry
   */
  private generateFileName(entry: ImplementationLogEntry): string {
    const sanitizedTaskId = this.sanitizeTaskId(entry.taskId);
    const dateObj = new Date(entry.timestamp);
    const timestamp = dateObj.toISOString().replace(/[:.]/g, '').split('T')[0] +
                      dateObj.toISOString().split('T')[1].replace(/[:.Z]/g, '').substring(0, 6);
    const idPrefix = entry.id.substring(0, 8);
    return `task-${sanitizedTaskId}_${timestamp}_${idPrefix}.md`;
  }

  /**
   * Migrate a single JSON file to markdown files
   */
  private async migrateJsonFile(jsonPath: string, outputDir: string): Promise<{ success: boolean; count: number; error?: string }> {
    try {
      // Read the JSON file
      const content = await fs.readFile(jsonPath, 'utf-8');
      const log: ImplementationLog = JSON.parse(content);

      // Ensure output directory exists
      await fs.mkdir(outputDir, { recursive: true });

      // Convert each entry to a markdown file
      let count = 0;
      for (const entry of log.entries) {
        const fileName = this.generateFileName(entry);
        const filePath = join(outputDir, fileName);
        const markdown = entryToMarkdown(entry);

        await fs.writeFile(filePath, markdown, 'utf-8');
        count++;
      }

      this.log(`✓ Migrated ${count} entries from ${jsonPath} to ${outputDir}`);
      return { success: true, count };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`✗ Failed to migrate ${jsonPath}: ${errorMsg}`);
      return { success: false, count: 0, error: errorMsg };
    }
  }

  /**
   * Scan all specs and migrate their implementation logs
   */
  async migrateAllSpecs(specsDir: string): Promise<{
    totalSpecs: number;
    migratedSpecs: number;
    totalEntries: number;
    errors: Array<{ spec: string; error: string }>;
  }> {
    this.log('='.repeat(80));
    this.log('Starting implementation logs migration from JSON to Markdown format');
    this.log(`Specs directory: ${specsDir}`);
    this.log('='.repeat(80));

    const result = {
      totalSpecs: 0,
      migratedSpecs: 0,
      totalEntries: 0,
      errors: [] as Array<{ spec: string; error: string }>
    };

    try {
      // Check if specs directory exists
      if (!existsSync(specsDir)) {
        this.log('Specs directory does not exist. Skipping migration.');
        return result;
      }

      // List all spec directories
      const entries = await fs.readdir(specsDir, { withFileTypes: true });
      const specDirs = entries.filter(e => e.isDirectory());

      result.totalSpecs = specDirs.length;

      // Process each spec
      for (const specDir of specDirs) {
        const specPath = join(specsDir, specDir.name);
        const jsonPath = join(specPath, 'implementation-log.json');
        const outputDir = join(specPath, 'Implementation Logs');

        // Check if JSON file exists
        if (!existsSync(jsonPath)) {
          this.log(`⊘ Spec "${specDir.name}": No implementation-log.json found. Skipping.`);
          continue;
        }

        // Migrate this spec's JSON file
        const migrationResult = await this.migrateJsonFile(jsonPath, outputDir);

        if (migrationResult.success) {
          result.migratedSpecs++;
          result.totalEntries += migrationResult.count;

          // Delete the JSON file after successful migration
          try {
            await fs.unlink(jsonPath);
            this.log(`→ Deleted original JSON file: ${jsonPath}`);
          } catch (error: any) {
            this.log(`⚠ Warning: Could not delete ${jsonPath}: ${error.message}`);
          }
        } else {
          result.errors.push({
            spec: specDir.name,
            error: migrationResult.error || 'Unknown error'
          });
        }
      }

      // Summary
      this.log('='.repeat(80));
      this.log(`Migration Summary:`);
      this.log(`  Total specs found: ${result.totalSpecs}`);
      this.log(`  Successfully migrated: ${result.migratedSpecs}`);
      this.log(`  Total entries migrated: ${result.totalEntries}`);
      this.log(`  Errors: ${result.errors.length}`);

      if (result.errors.length > 0) {
        this.log('Errors encountered:');
        result.errors.forEach(err => {
          this.log(`  - ${err.spec}: ${err.error}`);
        });
      }

      this.log('='.repeat(80));
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`Fatal error during migration: ${errorMsg}`);
      result.errors.push({
        spec: 'migration-process',
        error: errorMsg
      });
    }

    return result;
  }
}
