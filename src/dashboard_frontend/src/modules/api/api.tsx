import React, { createContext, useContext, useMemo, useState, useCallback, useEffect } from 'react';
import { useWs } from '../ws/WebSocketProvider';
import { ImplementationLogEntry } from '../../types';

export type SpecSummary = {
  name: string;
  displayName: string;
  status?: 'completed' | 'in-progress';
  lastModified?: string;
  taskProgress?: { total: number; completed: number; pending?: number };
  phases?: any;
};

export type ProjectInfo = {
  projectName: string;
  steering?: any;
  version?: string;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

async function postJson(url: string, body: any) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status };
}

async function postJsonWithData<T>(url: string, body: any): Promise<{ ok: boolean; status: number; data?: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = res.ok ? await res.json() : undefined;
  return { ok: res.ok, status: res.status, data };
}

async function putJson(url: string, body: any) {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null };
}

// Split into two contexts to prevent unnecessary re-renders
// Data context contains state that changes frequently
type ApiDataContextType = {
  specs: SpecSummary[];
  archivedSpecs: SpecSummary[];
  info?: ProjectInfo;
  steeringDocuments?: any;
  projectId: string | null;
};

// Actions context contains stable functions that rarely change
type ApiActionsContextType = {
  reloadAll: () => Promise<void>;
  getAllSpecDocuments: (name: string) => Promise<Record<string, { content: string; lastModified: string } | null>>;
  getAllArchivedSpecDocuments: (name: string) => Promise<Record<string, { content: string; lastModified: string } | null>>;
  getSpecTasksProgress: (name: string) => Promise<any>;
  updateTaskStatus: (specName: string, taskId: string, status: 'pending' | 'in-progress' | 'completed' | 'blocked', reason?: string) => Promise<{ ok: boolean; status: number; data?: any }>;
  saveSpecDocument: (name: string, document: string, content: string) => Promise<{ ok: boolean; status: number }>;
  saveArchivedSpecDocument: (name: string, document: string, content: string) => Promise<{ ok: boolean; status: number }>;
  archiveSpec: (name: string) => Promise<{ ok: boolean; status: number }>;
  unarchiveSpec: (name: string) => Promise<{ ok: boolean; status: number }>;
  getSteeringDocument: (name: string) => Promise<{ content: string; lastModified: string }>;
  saveSteeringDocument: (name: string, content: string) => Promise<{ ok: boolean; status: number }>;
  addImplementationLog: (specName: string, logData: any) => Promise<{ ok: boolean; status: number; data?: any }>;
  getImplementationLogs: (specName: string, query?: { taskId?: string; search?: string }) => Promise<{ entries: ImplementationLogEntry[] }>;
  getImplementationLogStats: (specName: string, taskId: string) => Promise<any>;
  getChangelog: (version: string) => Promise<{ content: string }>;
};

const ApiDataContext = createContext<ApiDataContextType | undefined>(undefined);
const ApiActionsContext = createContext<ApiActionsContextType | undefined>(undefined);

interface ApiProviderProps {
  initial?: { specs?: SpecSummary[]; archivedSpecs?: SpecSummary[] };
  projectId: string | null;
  children: React.ReactNode;
}

export function ApiProvider({ initial, projectId, children }: ApiProviderProps) {
  const { subscribe, unsubscribe } = useWs();
  const [specs, setSpecs] = useState<SpecSummary[]>(initial?.specs || []);
  const [archivedSpecs, setArchivedSpecs] = useState<SpecSummary[]>(initial?.archivedSpecs || []);
  const [info, setInfo] = useState<ProjectInfo | undefined>(undefined);
  const [steeringDocuments, setSteeringDocuments] = useState<any>(undefined);

  const reloadAll = useCallback(async () => {
    if (!projectId) return;

    const [s, as, i] = await Promise.all([
      getJson<SpecSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/specs`),
      getJson<SpecSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/specs/archived`),
      getJson<ProjectInfo>(`/api/projects/${encodeURIComponent(projectId)}/info`).catch(() => ({ projectName: 'Project' } as ProjectInfo)),
    ]);
    setSpecs(s);
    setArchivedSpecs(as);
    setInfo(i);
    setSteeringDocuments(i.steering);
  }, [projectId]);

  // Load initial data when projectId changes
  useEffect(() => {
    if (projectId) {
      reloadAll();
    } else {
      // Clear data when no project selected
      setSpecs([]);
      setArchivedSpecs([]);
      setInfo(undefined);
      setSteeringDocuments(undefined);
    }
  }, [projectId, reloadAll]);

  // Update state when initial websocket data arrives
  useEffect(() => {
    if (initial?.specs) setSpecs(initial.specs);
    if (initial?.archivedSpecs) setArchivedSpecs(initial.archivedSpecs);
  }, [initial]);

  // Handle websocket updates for real-time data changes
  useEffect(() => {
    const handleSpecUpdate = (data: { specs?: SpecSummary[]; archivedSpecs?: SpecSummary[] }) => {
      // Only update if data actually changed (deep equality check)
      if (data.specs) {
        setSpecs(prevSpecs => {
          // Check if arrays are identical to avoid unnecessary updates
          if (prevSpecs.length !== data.specs!.length) return data.specs!;

          // Check if any spec changed by comparing key properties
          const hasChanges = data.specs!.some((newSpec, index) => {
            const prevSpec = prevSpecs[index];
            return !prevSpec ||
                   prevSpec.name !== newSpec.name ||
                   prevSpec.displayName !== newSpec.displayName ||
                   prevSpec.status !== newSpec.status ||
                   prevSpec.lastModified !== newSpec.lastModified ||
                   JSON.stringify(prevSpec.taskProgress) !== JSON.stringify(newSpec.taskProgress);
          });

          return hasChanges ? data.specs! : prevSpecs;
        });
      }

      if (data.archivedSpecs) {
        setArchivedSpecs(prevArchived => {
          if (prevArchived.length !== data.archivedSpecs!.length) return data.archivedSpecs!;

          const hasChanges = data.archivedSpecs!.some((newSpec, index) => {
            const prevSpec = prevArchived[index];
            return !prevSpec || prevSpec.name !== newSpec.name;
          });

          return hasChanges ? data.archivedSpecs! : prevArchived;
        });
      }
    };

    const handleSteeringUpdate = (data: any) => {
      setSteeringDocuments(prevDocs => {
        // Simple deep equality check for steering documents
        if (JSON.stringify(prevDocs) === JSON.stringify(data)) {
          return prevDocs;
        }
        return data;
      });
    };

    // Subscribe to websocket events that contain actual data
    subscribe('spec-update', handleSpecUpdate);
    subscribe('steering-update', handleSteeringUpdate);

    return () => {
      unsubscribe('spec-update', handleSpecUpdate);
      unsubscribe('steering-update', handleSteeringUpdate);
    };
  }, [subscribe, unsubscribe]);

  // Memoize data context - changes when state updates
  const dataValue = useMemo<ApiDataContextType>(() => ({
    specs,
    archivedSpecs,
    info,
    steeringDocuments,
    projectId,
  }), [specs, archivedSpecs, info, steeringDocuments, projectId]);

  // Memoize actions context - stable functions that rarely change
  const actionsValue = useMemo<ApiActionsContextType>(() => {
    if (!projectId) {
      // Return empty API functions when no project selected
      return {
        reloadAll: async () => {},
        getAllSpecDocuments: async () => ({}),
        getAllArchivedSpecDocuments: async () => ({}),
        getSpecTasksProgress: async () => ({}),
        updateTaskStatus: async () => ({ ok: false, status: 400 }),
        saveSpecDocument: async () => ({ ok: false, status: 400 }),
        saveArchivedSpecDocument: async () => ({ ok: false, status: 400 }),
        archiveSpec: async () => ({ ok: false, status: 400 }),
        unarchiveSpec: async () => ({ ok: false, status: 400 }),
        getSteeringDocument: async () => ({ content: '', lastModified: '' }),
        saveSteeringDocument: async () => ({ ok: false, status: 400 }),
        addImplementationLog: async () => ({ ok: false, status: 400 }),
        getImplementationLogs: async () => ({ entries: [] }),
        getImplementationLogStats: async () => ({}),
        getChangelog: async () => ({ content: '' }),
      };
    }

    const prefix = `/api/projects/${encodeURIComponent(projectId)}`;

    return {
      reloadAll,
      getAllSpecDocuments: (name: string) => getJson(`${prefix}/specs/${encodeURIComponent(name)}/all`),
      getAllArchivedSpecDocuments: (name: string) => getJson(`${prefix}/specs/${encodeURIComponent(name)}/all/archived`),
      getSpecTasksProgress: (name: string) => getJson(`${prefix}/specs/${encodeURIComponent(name)}/tasks/progress`),
      updateTaskStatus: (specName: string, taskId: string, status: 'pending' | 'in-progress' | 'completed' | 'blocked', reason?: string) =>
        putJson(`${prefix}/specs/${encodeURIComponent(specName)}/tasks/${encodeURIComponent(taskId)}/status`, { status, ...(reason && { reason }) }),
      saveSpecDocument: (name: string, document: string, content: string) =>
        putJson(`${prefix}/specs/${encodeURIComponent(name)}/${encodeURIComponent(document)}`, { content }),
      saveArchivedSpecDocument: (name: string, document: string, content: string) =>
        putJson(`${prefix}/specs/${encodeURIComponent(name)}/${encodeURIComponent(document)}/archived`, { content }),
      archiveSpec: (name: string) => postJson(`${prefix}/specs/${encodeURIComponent(name)}/archive`, {}),
      unarchiveSpec: (name: string) => postJson(`${prefix}/specs/${encodeURIComponent(name)}/unarchive`, {}),
      getSteeringDocument: (name: string) => getJson(`${prefix}/steering/${encodeURIComponent(name)}`),
      saveSteeringDocument: (name: string, content: string) => putJson(`${prefix}/steering/${encodeURIComponent(name)}`, { content }),
      addImplementationLog: (specName: string, logData: any) => postJson(`${prefix}/specs/${encodeURIComponent(specName)}/implementation-log`, logData),
      getImplementationLogs: (specName: string, query?: { taskId?: string; search?: string }) => {
        let url = `${prefix}/specs/${encodeURIComponent(specName)}/implementation-log`;
        const params = new URLSearchParams();
        if (query?.taskId) params.append('taskId', query.taskId);
        if (query?.search) params.append('search', query.search);
        if (params.toString()) url += `?${params.toString()}`;
        return getJson(url);
      },
      getImplementationLogStats: (specName: string, taskId: string) => getJson(`${prefix}/specs/${encodeURIComponent(specName)}/implementation-log/task/${encodeURIComponent(taskId)}/stats`),
      getChangelog: (version: string) => getJson(`${prefix}/changelog/${encodeURIComponent(version)}`),
    };
  }, [projectId, reloadAll]);

  return (
    <ApiActionsContext.Provider value={actionsValue}>
      <ApiDataContext.Provider value={dataValue}>
        {children}
      </ApiDataContext.Provider>
    </ApiActionsContext.Provider>
  );
}

// Hook for accessing API actions (stable, won't re-render when data changes)
export function useApiActions(): ApiActionsContextType {
  const ctx = useContext(ApiActionsContext);
  if (!ctx) throw new Error('useApiActions must be used within ApiProvider');
  return ctx;
}

// Hook for accessing API data (will re-render when data changes)
export function useApiData(): ApiDataContextType {
  const ctx = useContext(ApiDataContext);
  if (!ctx) throw new Error('useApiData must be used within ApiProvider');
  return ctx;
}

// Legacy hook for backward compatibility - returns both data and actions
// Components should migrate to using useApiActions() or useApiData() for better performance
export function useApi(): ApiDataContextType & ApiActionsContextType {
  const data = useApiData();
  const actions = useApiActions();
  return { ...data, ...actions };
}


