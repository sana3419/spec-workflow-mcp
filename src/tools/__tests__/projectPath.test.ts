import { describe, it, expect } from 'vitest';
import { specStatusHandler } from '../spec-status.js';
import { logImplementationHandler } from '../log-implementation.js';
import { ToolContext } from '../../types.js';

describe('Tool projectPath fallback behavior', () => {
  const mockContext: ToolContext = {
    projectPath: '/test/project/from/context',
    dashboardUrl: 'http://localhost:5000'
  };

  describe('spec-status tool', () => {
    it('should use context.projectPath when args.projectPath is not provided', async () => {
      const result = await specStatusHandler(
        { specName: 'test-spec' },
        mockContext
      );
      
      // Should not fail due to missing projectPath
      // The actual implementation will fail because the spec doesn't exist,
      // but we can verify the error is not about missing projectPath
      expect(result.success).toBe(false);
      expect(result.message).not.toContain('Project path is required but not provided');
    });

    it('should use args.projectPath when explicitly provided', async () => {
      const result = await specStatusHandler(
        { specName: 'test-spec', projectPath: '/override/path' },
        mockContext
      );
      
      // Should not fail due to missing projectPath
      expect(result.success).toBe(false);
      expect(result.message).not.toContain('Project path is required but not provided');
    });

    it('should fail if neither args.projectPath nor context.projectPath is provided', async () => {
      const emptyContext: ToolContext = { projectPath: '' };
      
      const result = await specStatusHandler(
        { specName: 'test-spec' },
        emptyContext
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Project path is required but not provided');
    });
  });

  describe('log-implementation tool', () => {
    it('should use context.projectPath when args.projectPath is not provided', async () => {
      const result = await logImplementationHandler(
        {
          specName: 'test-spec',
          taskId: '1.1',
          summary: 'Test implementation',
          filesModified: [],
          filesCreated: [],
          statistics: { linesAdded: 10, linesRemoved: 5 },
          artifacts: { functions: [] }
        },
        mockContext
      );
      
      // Should not fail due to missing projectPath
      expect(result.success).toBe(false);
      expect(result.message).not.toContain('Project path is required but not provided');
    });

    it('should fail if neither args.projectPath nor context.projectPath is provided', async () => {
      const emptyContext: ToolContext = { projectPath: '' };
      
      const result = await logImplementationHandler(
        {
          specName: 'test-spec',
          taskId: '1.1',
          summary: 'Test implementation',
          filesModified: [],
          filesCreated: [],
          statistics: { linesAdded: 10, linesRemoved: 5 },
          artifacts: { functions: [] }
        },
        emptyContext
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Project path is required but not provided');
    });
  });
});
