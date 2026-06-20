import fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { join, dirname, basename, resolve } from 'path';
import { readFile } from 'fs/promises';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import open from 'open';
import { WebSocket } from 'ws';
import { validateAndCheckPort, DASHBOARD_TEST_MESSAGE } from './utils.js';
import { parseTasksFromMarkdown, updateTaskStatus } from '../core/task-parser.js';
import { ProjectManager } from './project-manager.js';
import { JobScheduler } from './job-scheduler.js';
import { ImplementationLogManager } from './implementation-log-manager.js';
import { PathUtils } from '../core/path-utils.js';
import { DashboardSessionManager } from '../core/dashboard-session.js';
import {
  getSecurityConfig,
  RateLimiter,
  AuditLogger,
  createSecurityHeadersMiddleware,
  getCorsConfig,
  isLocalhostAddress,
  DEFAULT_SECURITY_CONFIG
} from '../core/security-utils.js';
import { SecurityConfig } from '../types.js';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WebSocketConnection {
  socket: WebSocket;
  projectId?: string;
  isAlive?: boolean;
}

export interface MultiDashboardOptions {
  autoOpen?: boolean;
  port?: number;
  bindAddress?: string; // Network binding address
  allowExternalAccess?: boolean; // Explicit opt-in for non-localhost binding
  security?: Partial<SecurityConfig>; // Security features configuration
}

export class MultiProjectDashboardServer {
  private app: FastifyInstance;
  private projectManager: ProjectManager;
  private jobScheduler: JobScheduler;
  private sessionManager: DashboardSessionManager;
  private options: MultiDashboardOptions;
  private bindAddress: string;
  private allowExternalAccess: boolean;
  private securityConfig: SecurityConfig;
  private rateLimiter?: RateLimiter;
  private auditLogger?: AuditLogger;
  private actualPort: number = 0;
  private clients: Set<WebSocketConnection> = new Set();
  private packageVersion: string = 'unknown';
  private heartbeatInterval?: NodeJS.Timeout;
  private readonly HEARTBEAT_INTERVAL_MS = 30000;
  private readonly HEARTBEAT_TIMEOUT_MS = 10000;
  // Debounce spec broadcasts to coalesce rapid updates
  private pendingSpecBroadcasts: Map<string, NodeJS.Timeout> = new Map();
  private readonly SPEC_BROADCAST_DEBOUNCE_MS = 300;

  constructor(options: MultiDashboardOptions = {}) {
    this.options = options;
    this.projectManager = new ProjectManager();
    this.jobScheduler = new JobScheduler(this.projectManager);
    this.sessionManager = new DashboardSessionManager();

    // Initialize network binding configuration
    this.bindAddress = options.bindAddress || '127.0.0.1';
    this.allowExternalAccess = options.allowExternalAccess || false;

    // Validate network binding security
    if (!isLocalhostAddress(this.bindAddress) && !this.allowExternalAccess) {
      throw new Error(
        `SECURITY ERROR: Binding to '${this.bindAddress}' (non-localhost) requires explicit allowExternalAccess=true. ` +
        'This exposes your dashboard to network access. Use 127.0.0.1 for localhost-only access.'
      );
    }

    // Initialize security features configuration with the actual port
    // This ensures CORS allowedOrigins and CSP are port-aware
    this.securityConfig = getSecurityConfig(options.security, options.port);

    this.app = fastify({ logger: false });
  }

  async start() {
    // Security warning if binding to non-localhost address
    if (!isLocalhostAddress(this.bindAddress)) {
      console.error('');
      console.error('⚠️  ═══════════════════════════════════════════════════════════');
      console.error(`⚠️  SECURITY WARNING: Dashboard binding to ${this.bindAddress}`);
      console.error('⚠️  This exposes your dashboard to network-based attacks!');
      console.error('⚠️  Recommendation: Use 127.0.0.1 for localhost-only access');
      console.error('⚠️  ═══════════════════════════════════════════════════════════');
      console.error('');
    }

    // Display security status
    console.error('🔒 Security Configuration:');
    console.error(`   - Bind Address: ${this.bindAddress}`);
    console.error(`   - Rate Limiting: ${this.securityConfig.rateLimitEnabled ? 'ENABLED ✓' : 'DISABLED ⚠️'}`);
    console.error(`   - Audit Logging: ${this.securityConfig.auditLogEnabled ? 'ENABLED ✓' : 'DISABLED ⚠️'}`);
    console.error(`   - CORS: ${this.securityConfig.corsEnabled ? 'ENABLED ✓' : 'DISABLED ⚠️'}`);
    console.error(`   - Allowed Origins: ${this.securityConfig.allowedOrigins.join(', ')}`);
    console.error('');

    // Fetch package version once at startup
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('https://registry.npmjs.org/@pimzino/spec-workflow-mcp/latest', { signal: controller.signal });
        if (response.ok) {
          const packageInfo = await response.json() as { version?: string };
          this.packageVersion = packageInfo.version || 'unknown';
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Fallback to local package.json version if npm request fails
      try {
        const packageJsonPath = join(__dirname, '..', '..', 'package.json');
        const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent) as { version?: string };
        this.packageVersion = packageJson.version || 'unknown';
      } catch {
        // Keep default 'unknown' if both npm and local package.json fail
      }
    }

    // Initialize security components
    if (this.securityConfig.rateLimitEnabled) {
      this.rateLimiter = new RateLimiter(this.securityConfig);
    }

    if (this.securityConfig.auditLogEnabled) {
      this.auditLogger = new AuditLogger(this.securityConfig);
      await this.auditLogger.initialize();
    }

    // Initialize project manager
    await this.projectManager.initialize();

    // Initialize job scheduler
    await this.jobScheduler.initialize();

    // Register CORS plugin if enabled
    const corsConfig = getCorsConfig(this.securityConfig);
    if (corsConfig !== false) {
      await this.app.register(fastifyCors, corsConfig as any);
    }

    // Register security middleware (apply to all routes)
    // Pass the actual port for CSP connect-src WebSocket configuration
    this.app.addHook('onRequest', createSecurityHeadersMiddleware(this.options.port));

    if (this.rateLimiter) {
      this.app.addHook('onRequest', this.rateLimiter.middleware());
    }

    if (this.auditLogger) {
      this.app.addHook('onRequest', this.auditLogger.middleware());
    }

    // Register plugins
    await this.app.register(fastifyStatic, {
      root: join(__dirname, 'public'),
      prefix: '/',
    });

    await this.app.register(fastifyWebsocket);

    // WebSocket endpoint for real-time updates
    const self = this;
    await this.app.register(async function (fastify) {
      fastify.get('/ws', { websocket: true }, (socket, req) => {
        const connection: WebSocketConnection = { socket, isAlive: true };

        // Get projectId from query parameter
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const projectId = url.searchParams.get('projectId') || undefined;

        connection.projectId = projectId;
        self.clients.add(connection);

        // Handle pong for heartbeat
        socket.on('pong', () => {
          connection.isAlive = true;
        });

        // Send initial state for the requested project
        if (projectId) {
          const project = self.projectManager.getProject(projectId);
          if (project) {
            project.parser.getAllSpecs()
              .then((specs) => {
                socket.send(
                  JSON.stringify({
                    type: 'initial',
                    projectId,
                    data: { specs },
                  })
                );
              })
              .catch((error) => {
                console.error('Error getting initial data:', error);
              });
          }
        }

        // Send projects list
        socket.send(
          JSON.stringify({
            type: 'projects-update',
            data: { projects: self.projectManager.getProjectsList() }
          })
        );

        // Handle client disconnect
        const cleanup = () => {
          self.clients.delete(connection);
          socket.removeAllListeners();
        };

        socket.on('close', cleanup);
        socket.on('error', cleanup);
        socket.on('disconnect', cleanup);
        socket.on('end', cleanup);

        // Handle subscription messages
        socket.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'subscribe' && msg.projectId) {
              connection.projectId = msg.projectId;

              // Send initial data for new subscription
              const project = self.projectManager.getProject(msg.projectId);
              if (project) {
                project.parser.getAllSpecs()
                  .then((specs) => {
                    socket.send(
                      JSON.stringify({
                        type: 'initial',
                        projectId: msg.projectId,
                        data: { specs },
                      })
                    );
                  })
                  .catch((error) => {
                    console.error('Error getting initial data:', error);
                  });
              }
            }
          } catch (error) {
            // Ignore invalid messages
          }
        });
      });
    });

    // Serve Claude icon as favicon
    this.app.get('/favicon.ico', async (request, reply) => {
      return reply.sendFile('claude-icon.svg');
    });

    // Setup project manager event handlers
    this.setupProjectManagerEvents();

    // Register API routes
    this.registerApiRoutes();

    // Validate and set port (always provided by caller)
    if (!this.options.port) {
      throw new Error('Dashboard port must be specified');
    }

    await validateAndCheckPort(this.options.port, this.bindAddress);
    this.actualPort = this.options.port;

    // Start server with configured network binding
    await this.app.listen({
      port: this.actualPort,
      host: this.bindAddress
    });

    // Start WebSocket heartbeat monitoring
    this.startHeartbeat();

    // Register dashboard in the session manager
    const dashboardUrl = `http://localhost:${this.actualPort}`;
    await this.sessionManager.registerDashboard(dashboardUrl, this.actualPort, process.pid);

    // Open browser if requested
    if (this.options.autoOpen) {
      await open(dashboardUrl);
    }

    return dashboardUrl;
  }

  private setupProjectManagerEvents() {
    // Broadcast projects update when projects change
    this.projectManager.on('projects-update', (projects) => {
      this.broadcastToAll({
        type: 'projects-update',
        data: { projects }
      });
    });

    // Broadcast spec changes (debounced per project to coalesce rapid updates)
    this.projectManager.on('spec-change', (event) => {
      const { projectId } = event;

      // Clear existing pending broadcast for this project
      const existingTimeout = this.pendingSpecBroadcasts.get(projectId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Schedule debounced broadcast
      const timeout = setTimeout(async () => {
        this.pendingSpecBroadcasts.delete(projectId);
        try {
          const project = this.projectManager.getProject(projectId);
          if (project) {
            const specs = await project.parser.getAllSpecs();
            const archivedSpecs = await project.parser.getAllArchivedSpecs();
            this.broadcastToProject(projectId, {
              type: 'spec-update',
              projectId,
              data: { specs, archivedSpecs }
            });
          }
        } catch (error) {
          console.error('Error broadcasting spec changes:', error);
          // Don't propagate error to prevent event system crash
        }
      }, this.SPEC_BROADCAST_DEBOUNCE_MS);

      this.pendingSpecBroadcasts.set(projectId, timeout);
    });

    // Broadcast task updates
    this.projectManager.on('task-update', (event) => {
      const { projectId, specName } = event;
      this.broadcastTaskUpdate(projectId, specName);
    });

    // Broadcast steering changes
    this.projectManager.on('steering-change', async (event) => {
      try {
        const { projectId, steeringStatus } = event;
        this.broadcastToProject(projectId, {
          type: 'steering-update',
          projectId,
          data: steeringStatus
        });
      } catch (error) {
        console.error('Error broadcasting steering changes:', error);
        // Don't propagate error to prevent event system crash
      }
    });
  }

  private registerApiRoutes() {
    // Health check / test endpoint (used by utils.ts to detect running dashboard)
    this.app.get('/api/test', async () => {
      return { message: DASHBOARD_TEST_MESSAGE };
    });

    // Projects list
    this.app.get('/api/projects/list', async () => {
      return this.projectManager.getProjectsList();
    });

    // Add project manually
    this.app.post('/api/projects/add', async (request, reply) => {
      const { projectPath } = request.body as { projectPath: string };
      if (!projectPath) {
        return reply.code(400).send({ error: 'projectPath is required' });
      }
      try {
        const projectId = await this.projectManager.addProjectByPath(projectPath);
        return { projectId, success: true };
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });

    // Remove project
    this.app.delete('/api/projects/:projectId', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      try {
        await this.projectManager.removeProjectById(projectId);
        return { success: true };
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });

    // Project info
    this.app.get('/api/projects/:projectId/info', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const steeringStatus = await project.parser.getProjectSteeringStatus();
      return {
        projectId,
        projectName: project.projectName,
        projectPath: project.originalProjectPath,  // Return original path for display
        steering: steeringStatus,
        version: this.packageVersion
      };
    });

    // Specs list
    this.app.get('/api/projects/:projectId/specs', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      return await project.parser.getAllSpecs();
    });

    // Archived specs list
    this.app.get('/api/projects/:projectId/specs/archived', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      return await project.parser.getAllArchivedSpecs();
    });

    // Get spec details
    this.app.get('/api/projects/:projectId/specs/:name', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      const spec = await project.parser.getSpec(name);
      if (!spec) {
        return reply.code(404).send({ error: 'Spec not found' });
      }
      return spec;
    });

    // Get all spec documents
    this.app.get('/api/projects/:projectId/specs/:name/all', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const specDir = join(project.projectPath, '.spec-workflow', 'specs', name);
      const documents = ['requirements', 'design', 'tasks'];
      const result: Record<string, { content: string; lastModified: string } | null> = {};

      for (const doc of documents) {
        const docPath = join(specDir, `${doc}.md`);
        try {
          const content = await readFile(docPath, 'utf-8');
          const stats = await fs.stat(docPath);
          result[doc] = {
            content,
            lastModified: stats.mtime.toISOString()
          };
        } catch {
          result[doc] = null;
        }
      }

      return result;
    });

    // Get all archived spec documents
    this.app.get('/api/projects/:projectId/specs/:name/all/archived', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      // Use archive path instead of active specs path
      const specDir = join(project.projectPath, '.spec-workflow', 'archive', 'specs', name);
      const documents = ['requirements', 'design', 'tasks'];
      const result: Record<string, { content: string; lastModified: string } | null> = {};

      for (const doc of documents) {
        const docPath = join(specDir, `${doc}.md`);
        try {
          const content = await readFile(docPath, 'utf-8');
          const stats = await fs.stat(docPath);
          result[doc] = {
            content,
            lastModified: stats.mtime.toISOString()
          };
        } catch {
          result[doc] = null;
        }
      }

      return result;
    });

    // Save spec document
    this.app.put('/api/projects/:projectId/specs/:name/:document', async (request, reply) => {
      const { projectId, name, document } = request.params as { projectId: string; name: string; document: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const { content } = request.body as { content: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const allowedDocs = ['requirements', 'design', 'tasks'];
      if (!allowedDocs.includes(document)) {
        return reply.code(400).send({ error: 'Invalid document type' });
      }

      if (typeof content !== 'string') {
        return reply.code(400).send({ error: 'Content must be a string' });
      }

      const docPath = join(project.projectPath, '.spec-workflow', 'specs', name, `${document}.md`);

      try {
        const specDir = join(project.projectPath, '.spec-workflow', 'specs', name);
        await fs.mkdir(specDir, { recursive: true });
        await fs.writeFile(docPath, content, 'utf-8');
        return { success: true, message: 'Document saved successfully' };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to save document: ${error.message}` });
      }
    });

    // Archive spec
    this.app.post('/api/projects/:projectId/specs/:name/archive', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        await project.archiveService.archiveSpec(name);
        return { success: true, message: `Spec '${name}' archived successfully` };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Unarchive spec
    this.app.post('/api/projects/:projectId/specs/:name/unarchive', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        await project.archiveService.unarchiveSpec(name);
        return { success: true, message: `Spec '${name}' unarchived successfully` };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Get steering document
    this.app.get('/api/projects/:projectId/steering/:name', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const allowedDocs = ['product', 'tech', 'structure'];
      if (!allowedDocs.includes(name)) {
        return reply.code(400).send({ error: 'Invalid steering document name' });
      }

      const docPath = join(project.projectPath, '.spec-workflow', 'steering', `${name}.md`);

      try {
        const content = await readFile(docPath, 'utf-8');
        const stats = await fs.stat(docPath);
        return {
          content,
          lastModified: stats.mtime.toISOString()
        };
      } catch {
        return {
          content: '',
          lastModified: new Date().toISOString()
        };
      }
    });

    // Save steering document
    this.app.put('/api/projects/:projectId/steering/:name', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const { content } = request.body as { content: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const allowedDocs = ['product', 'tech', 'structure'];
      if (!allowedDocs.includes(name)) {
        return reply.code(400).send({ error: 'Invalid steering document name' });
      }

      if (typeof content !== 'string') {
        return reply.code(400).send({ error: 'Content must be a string' });
      }

      const steeringDir = join(project.projectPath, '.spec-workflow', 'steering');
      const docPath = join(steeringDir, `${name}.md`);

      try {
        await fs.mkdir(steeringDir, { recursive: true });
        await fs.writeFile(docPath, content, 'utf-8');
        return { success: true, message: 'Steering document saved successfully' };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to save steering document: ${error.message}` });
      }
    });

    // Get task progress
    this.app.get('/api/projects/:projectId/specs/:name/tasks/progress', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        const spec = await project.parser.getSpec(name);
        if (!spec || !spec.phases.tasks.exists) {
          return reply.code(404).send({ error: 'Spec or tasks not found' });
        }

        const tasksPath = join(project.projectPath, '.spec-workflow', 'specs', name, 'tasks.md');
        const tasksContent = await readFile(tasksPath, 'utf-8');
        const parseResult = parseTasksFromMarkdown(tasksContent);

        const totalTasks = parseResult.summary.total;
        const completedTasks = parseResult.summary.completed;
        const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

        return {
          total: totalTasks,
          completed: completedTasks,
          inProgress: parseResult.inProgressTask,
          progress: progress,
          taskList: parseResult.tasks,
          lastModified: spec.phases.tasks.lastModified || spec.lastModified
        };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to get task progress: ${error.message}` });
      }
    });

    // Update task status
    this.app.put('/api/projects/:projectId/specs/:name/tasks/:taskId/status', async (request, reply) => {
      const { projectId, name, taskId } = request.params as { projectId: string; name: string; taskId: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const { status, reason } = request.body as { status: 'pending' | 'in-progress' | 'completed' | 'blocked'; reason?: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      if (!status || !['pending', 'in-progress', 'completed', 'blocked'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status. Must be pending, in-progress, completed, or blocked' });
      }

      try {
        const tasksPath = join(project.projectPath, '.spec-workflow', 'specs', name, 'tasks.md');

        let tasksContent: string;
        try {
          tasksContent = await readFile(tasksPath, 'utf-8');
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            return reply.code(404).send({ error: 'Tasks file not found' });
          }
          throw error;
        }

        const parseResult = parseTasksFromMarkdown(tasksContent);
        const task = parseResult.tasks.find(t => t.id === taskId);

        if (!task) {
          return reply.code(404).send({ error: `Task ${taskId} not found` });
        }

        if (task.status === status && !(status === 'blocked' && reason && reason !== task.blockedReason)) {
          return {
            success: true,
            message: `Task ${taskId} already has status ${status}`,
            task: { ...task, status }
          };
        }

        const updatedContent = updateTaskStatus(tasksContent, taskId, status, reason);

        if (updatedContent === tasksContent) {
          return reply.code(500).send({ error: `Failed to update task ${taskId} in markdown content` });
        }

        await fs.writeFile(tasksPath, updatedContent, 'utf-8');

        this.broadcastTaskUpdate(projectId, name);

        return {
          success: true,
          message: `Task ${taskId} status updated to ${status}`,
          task: { ...task, status }
        };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to update task status: ${error.message}` });
      }
    });

    // Add implementation log entry
    this.app.post('/api/projects/:projectId/specs/:name/implementation-log', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        const logData = request.body as any;

        // Validate artifacts are provided
        if (!logData.artifacts) {
          return reply.code(400).send({ error: 'artifacts field is REQUIRED. Include apiEndpoints, components, functions, classes, or integrations in the artifacts object.' });
        }

        const specPath = join(project.projectPath, '.spec-workflow', 'specs', name);
        const logManager = new ImplementationLogManager(specPath);
        const entry = await logManager.addLogEntry(logData);

        await this.broadcastImplementationLogUpdate(projectId, name);
        return entry;
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to add implementation log: ${error.message}` });
      }
    });

    // Get implementation logs
    this.app.get('/api/projects/:projectId/specs/:name/implementation-log', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }
      const query = request.query as { taskId?: string; search?: string };

      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        const specPath = join(project.projectPath, '.spec-workflow', 'specs', name);
        const logManager = new ImplementationLogManager(specPath);
        let logs = await logManager.getAllLogs();

        if (query.taskId) {
          logs = logs.filter(log => log.taskId === query.taskId);
        }
        if (query.search) {
          const searchResults = await logManager.searchLogs(query.search);
          if (query.taskId) {
            // Intersect: keep only search results that also match the taskId filter
            const filteredIds = new Set(logs.map(l => l.taskId + '_' + l.timestamp));
            logs = searchResults.filter(l => filteredIds.has(l.taskId + '_' + l.timestamp));
          } else {
            logs = searchResults;
          }
        }

        return { entries: logs };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to get implementation logs: ${error.message}` });
      }
    });

    // Get implementation log task stats
    this.app.get('/api/projects/:projectId/specs/:name/implementation-log/task/:taskId/stats', async (request, reply) => {
      const { projectId, name, taskId } = request.params as { projectId: string; name: string; taskId: string };
      try { PathUtils.validateSimplePathSegment(name, 'spec name'); } catch { return reply.code(400).send({ error: 'Invalid spec name' }); }

      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        const specPath = join(project.projectPath, '.spec-workflow', 'specs', name);
        const logManager = new ImplementationLogManager(specPath);
        const stats = await logManager.getTaskStats(taskId);

        return stats;
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to get implementation log stats: ${error.message}` });
      }
    });

    // Project-specific changelog endpoint
    this.app.get('/api/projects/:projectId/changelog/:version', async (request, reply) => {
      const { version } = request.params as { version: string };

      try {
        const changelogPath = join(__dirname, '..', '..', 'CHANGELOG.md');
        const content = await readFile(changelogPath, 'utf-8');

        // Extract the section for the requested version
        const versionRegex = new RegExp(`## \\[${escapeRegExp(version)}\\][^]*?(?=## \\[|$)`, 'i');
        const match = content.match(versionRegex);

        if (!match) {
          return reply.code(404).send({ error: `Changelog for version ${version} not found` });
        }

        return { content: match[0].trim() };
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return reply.code(404).send({ error: 'Changelog file not found' });
        }
        return reply.code(500).send({ error: `Failed to fetch changelog: ${error.message}` });
      }
    });

    // Global changelog endpoint
    this.app.get('/api/changelog/:version', async (request, reply) => {
      const { version } = request.params as { version: string };

      try {
        const changelogPath = join(__dirname, '..', '..', 'CHANGELOG.md');
        const content = await readFile(changelogPath, 'utf-8');

        // Extract the section for the requested version
        const versionRegex = new RegExp(`## \\[${escapeRegExp(version)}\\][^]*?(?=## \\[|$)`, 'i');
        const match = content.match(versionRegex);

        if (!match) {
          return reply.code(404).send({ error: `Changelog for version ${version} not found` });
        }

        return { content: match[0].trim() };
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return reply.code(404).send({ error: 'Changelog file not found' });
        }
        return reply.code(500).send({ error: `Failed to fetch changelog: ${error.message}` });
      }
    });

    // Global settings endpoints

    // Get all automation jobs
    this.app.get('/api/jobs', async () => {
      return await this.jobScheduler.getAllJobs();
    });

    // Create a new automation job
    this.app.post('/api/jobs', async (request, reply) => {
      const job = request.body as any;

      if (!job.id || !job.name || !job.type || job.config === undefined || !job.schedule) {
        return reply.code(400).send({ error: 'Missing required fields: id, name, type, config, schedule' });
      }

      try {
        await this.jobScheduler.addJob({
          id: job.id,
          name: job.name,
          type: job.type,
          enabled: job.enabled !== false,
          config: job.config,
          schedule: job.schedule,
          createdAt: new Date().toISOString()
        });
        return { success: true, message: 'Job created successfully' };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Get a specific automation job
    this.app.get('/api/jobs/:jobId', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const settingsManager = new (await import('./settings-manager.js')).SettingsManager();

      try {
        const job = await settingsManager.getJob(jobId);
        if (!job) {
          return reply.code(404).send({ error: 'Job not found' });
        }
        return job;
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });

    // Update an automation job
    this.app.put('/api/jobs/:jobId', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const updates = request.body as any;

      try {
        await this.jobScheduler.updateJob(jobId, updates);
        return { success: true, message: 'Job updated successfully' };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Delete an automation job
    this.app.delete('/api/jobs/:jobId', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      try {
        await this.jobScheduler.deleteJob(jobId);
        return { success: true, message: 'Job deleted successfully' };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Manually run a job
    this.app.post('/api/jobs/:jobId/run', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      try {
        const result = await this.jobScheduler.runJobManually(jobId);
        return result;
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Get job execution history
    this.app.get('/api/jobs/:jobId/history', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const { limit } = request.query as { limit?: string };

      try {
        const history = await this.jobScheduler.getJobExecutionHistory(jobId, parseInt(limit || '50'));
        return history;
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });

    // Get job statistics
    this.app.get('/api/jobs/:jobId/stats', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      try {
        const stats = await this.jobScheduler.getJobStats(jobId);
        return stats;
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });
  }

  private broadcastToAll(message: any) {
    const messageStr = JSON.stringify(message);
    this.clients.forEach((connection) => {
      try {
        if (connection.socket.readyState === WebSocket.OPEN) {
          connection.socket.send(messageStr);
        }
      } catch (error) {
        console.error('Error broadcasting to client:', error);
        this.scheduleConnectionCleanup(connection);
      }
    });
  }

  private broadcastToProject(projectId: string, message: any) {
    const messageStr = JSON.stringify(message);
    this.clients.forEach((connection) => {
      try {
        if (connection.socket.readyState === WebSocket.OPEN && connection.projectId === projectId) {
          connection.socket.send(messageStr);
        }
      } catch (error) {
        console.error('Error broadcasting to project client:', error);
        this.scheduleConnectionCleanup(connection);
      }
    });
  }

  private scheduleConnectionCleanup(connection: WebSocketConnection) {
    // Use setImmediate to avoid modifying Set during iteration
    setImmediate(() => {
      try {
        this.clients.delete(connection);
        connection.socket.removeAllListeners();
        if (connection.socket.readyState === WebSocket.OPEN) {
          connection.socket.close();
        }
      } catch {
        // Ignore cleanup errors
      }
    });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach((connection) => {
        if (connection.socket.readyState === WebSocket.OPEN) {
          try {
            // Mark as waiting for pong
            connection.isAlive = false;
            connection.socket.ping();
          } catch {
            this.scheduleConnectionCleanup(connection);
          }
        }
      });

      // Check for dead connections after timeout
      setTimeout(() => {
        this.clients.forEach((connection) => {
          if (connection.isAlive === false) {
            console.error('Connection did not respond to heartbeat, cleaning up');
            this.scheduleConnectionCleanup(connection);
          }
        });
      }, this.HEARTBEAT_TIMEOUT_MS);
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private async broadcastTaskUpdate(projectId: string, specName: string) {
    try {
      const project = this.projectManager.getProject(projectId);
      if (!project) return;

      const tasksPath = join(project.projectPath, '.spec-workflow', 'specs', specName, 'tasks.md');
      const tasksContent = await readFile(tasksPath, 'utf-8');
      const parseResult = parseTasksFromMarkdown(tasksContent);

      this.broadcastToProject(projectId, {
        type: 'task-status-update',
        projectId,
        data: {
          specName,
          taskList: parseResult.tasks,
          summary: parseResult.summary,
          inProgress: parseResult.inProgressTask
        }
      });
    } catch (error) {
      console.error('Error broadcasting task update:', error);
    }
  }

  private async broadcastImplementationLogUpdate(projectId: string, specName: string): Promise<void> {
    try {
      const project = this.projectManager.getProject(projectId);
      if (!project) return;

      const specPath = join(project.projectPath, '.spec-workflow', 'specs', specName);
      const logManager = new ImplementationLogManager(specPath);
      const logs = await logManager.getAllLogs();

      this.broadcastToProject(projectId, {
        type: 'implementation-log-update',
        projectId,
        data: {
          specName,
          entries: logs
        }
      });
    } catch (error) {
      console.error('Error broadcasting implementation log update:', error);
    }
  }

  async stop() {
    // Stop heartbeat monitoring
    this.stopHeartbeat();

    // Clear pending spec broadcasts
    for (const timeout of this.pendingSpecBroadcasts.values()) {
      clearTimeout(timeout);
    }
    this.pendingSpecBroadcasts.clear();

    // Close all WebSocket connections
    this.clients.forEach((connection) => {
      try {
        connection.socket.removeAllListeners();
        if (connection.socket.readyState === WebSocket.OPEN) {
          connection.socket.close();
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    });
    this.clients.clear();

    // Stop job scheduler
    await this.jobScheduler.shutdown();

    // Stop project manager
    await this.projectManager.stop();

    // Close the Fastify server
    await this.app.close();

    // Unregister from the session manager
    try {
      await this.sessionManager.unregisterDashboard();
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  getUrl(): string {
    return `http://localhost:${this.actualPort}`;
  }
}
