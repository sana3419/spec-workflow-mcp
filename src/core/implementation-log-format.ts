import { ImplementationLogEntry } from '../types.js';

/**
 * Render an implementation log entry as a markdown document.
 *
 * Single source of truth for the on-disk log format: both the manager (new
 * entries) and the migrator (legacy JSON entries) render through this, so the
 * two can no longer drift.
 */
export function entryToMarkdown(entry: ImplementationLogEntry): string {
  let markdown = `# Implementation Log: Task ${entry.taskId}\n\n`;
  markdown += `**Summary:** ${entry.summary}\n\n`;
  markdown += `**Timestamp:** ${entry.timestamp}\n`;
  markdown += `**Log ID:** ${entry.id}\n\n`;
  markdown += `---\n\n`;

  // Statistics
  markdown += `## Statistics\n\n`;
  markdown += `- **Lines Added:** +${entry.statistics.linesAdded}\n`;
  markdown += `- **Lines Removed:** -${entry.statistics.linesRemoved}\n`;
  markdown += `- **Files Changed:** ${entry.statistics.filesChanged}\n`;
  markdown += `- **Net Change:** ${entry.statistics.linesAdded - entry.statistics.linesRemoved}\n\n`;

  // Files
  markdown += `## Files Modified\n`;
  if (entry.filesModified.length > 0) {
    entry.filesModified.forEach(file => {
      markdown += `- ${file}\n`;
    });
  } else {
    markdown += `_No files modified_\n`;
  }
  markdown += `\n`;

  markdown += `## Files Created\n`;
  if (entry.filesCreated.length > 0) {
    entry.filesCreated.forEach(file => {
      markdown += `- ${file}\n`;
    });
  } else {
    markdown += `_No files created_\n`;
  }
  markdown += `\n`;

  // Artifacts
  markdown += `---\n\n## Artifacts\n\n`;

  if (!entry.artifacts || Object.keys(entry.artifacts).every(key => !entry.artifacts[key as keyof typeof entry.artifacts]?.length)) {
    markdown += `_No artifacts recorded_\n`;
    return markdown;
  }

  // API Endpoints
  if (entry.artifacts.apiEndpoints && entry.artifacts.apiEndpoints.length > 0) {
    markdown += `### API Endpoints\n\n`;
    entry.artifacts.apiEndpoints.forEach(api => {
      markdown += `#### ${api.method} ${api.path}\n`;
      markdown += `- **Purpose:** ${api.purpose}\n`;
      markdown += `- **Location:** ${api.location}\n`;
      if (api.requestFormat) markdown += `- **Request Format:** ${api.requestFormat}\n`;
      if (api.responseFormat) markdown += `- **Response Format:** ${api.responseFormat}\n`;
      markdown += `\n`;
    });
  }

  // Components
  if (entry.artifacts.components && entry.artifacts.components.length > 0) {
    markdown += `### Components\n\n`;
    entry.artifacts.components.forEach(comp => {
      markdown += `#### ${comp.name}\n`;
      markdown += `- **Type:** ${comp.type}\n`;
      markdown += `- **Purpose:** ${comp.purpose}\n`;
      markdown += `- **Location:** ${comp.location}\n`;
      if (comp.props) markdown += `- **Props:** ${comp.props}\n`;
      if (comp.exports && comp.exports.length > 0) markdown += `- **Exports:** ${comp.exports.join(', ')}\n`;
      markdown += `\n`;
    });
  }

  // Functions
  if (entry.artifacts.functions && entry.artifacts.functions.length > 0) {
    markdown += `### Functions\n\n`;
    entry.artifacts.functions.forEach(func => {
      markdown += `#### ${func.name}\n`;
      markdown += `- **Purpose:** ${func.purpose}\n`;
      markdown += `- **Location:** ${func.location}\n`;
      if (func.signature) markdown += `- **Signature:** ${func.signature}\n`;
      markdown += `- **Exported:** ${func.isExported ? 'Yes' : 'No'}\n`;
      markdown += `\n`;
    });
  }

  // Classes
  if (entry.artifacts.classes && entry.artifacts.classes.length > 0) {
    markdown += `### Classes\n\n`;
    entry.artifacts.classes.forEach(cls => {
      markdown += `#### ${cls.name}\n`;
      markdown += `- **Purpose:** ${cls.purpose}\n`;
      markdown += `- **Location:** ${cls.location}\n`;
      if (cls.methods && cls.methods.length > 0) markdown += `- **Methods:** ${cls.methods.join(', ')}\n`;
      markdown += `- **Exported:** ${cls.isExported ? 'Yes' : 'No'}\n`;
      markdown += `\n`;
    });
  }

  // Integrations
  if (entry.artifacts.integrations && entry.artifacts.integrations.length > 0) {
    markdown += `### Integrations\n\n`;
    entry.artifacts.integrations.forEach(intg => {
      markdown += `#### Integration\n`;
      markdown += `- **Description:** ${intg.description}\n`;
      markdown += `- **Frontend Component:** ${intg.frontendComponent}\n`;
      markdown += `- **Backend Endpoint:** ${intg.backendEndpoint}\n`;
      markdown += `- **Data Flow:** ${intg.dataFlow}\n`;
      markdown += `\n`;
    });
  }

  return markdown;
}
