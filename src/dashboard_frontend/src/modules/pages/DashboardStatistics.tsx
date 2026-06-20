import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/api';
import { useWs } from '../ws/WebSocketProvider';

function Content() {
  const { t } = useTranslation();
  const { initial } = useWs();
  const { specs, reloadAll } = useApi();
  const { info } = useApi();

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);
  useEffect(() => {
    if (!initial) reloadAll();
  }, [initial, reloadAll]);

  const totalSpecs = specs.length;
  const totalTasks = specs.reduce((acc, s) => acc + (s.taskProgress?.total || 0), 0);
  const completedTasks = specs.reduce((acc, s) => acc + (s.taskProgress?.completed || 0), 0);
  const taskCompletionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
  
  const taskSummary = totalSpecs > 0 
    ? t('stats.taskProgress.summary', { count: totalTasks, specs: totalSpecs })
    : t('stats.taskProgress.noActiveSpecs');

  return (
    <div className="space-y-8">
      {/* Project Header */}
      <div className="bg-[var(--surface-panel)] rounded-lg border border-[var(--border-default)] p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">
              {info?.projectName || t('projectNameDefault')}
            </h1>
            <p className="text-[var(--text-secondary)]">
              {t('projectDescription')}
            </p>
          </div>
        </div>
      </div>


      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Specs Card */}
        <div className="bg-[var(--surface-panel)] border border-[var(--border-default)] rounded-lg p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-md bg-[var(--surface-inset)] flex items-center justify-center">
              <svg className="w-4 h-4 text-[var(--text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{t('stats.specifications.title')}</div>
          </div>
          <div className="text-2xl font-semibold text-[var(--text-primary)] mb-1 font-mono tabular-nums">{totalSpecs}</div>
          <div className="text-sm text-[var(--text-muted)]">{t('stats.specifications.label')}</div>
        </div>

        {/* Tasks Card */}
        <div className="bg-[var(--surface-panel)] border border-[var(--border-default)] rounded-lg p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-md bg-[var(--surface-inset)] flex items-center justify-center">
              <svg className="w-4 h-4 text-[var(--text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{t('stats.taskProgress.title')}</div>
          </div>
          <div className="flex items-baseline gap-2 mb-2">
            <div className="text-2xl font-semibold text-[var(--text-primary)] font-mono tabular-nums">{completedTasks}</div>
            <div className="text-lg text-[var(--text-secondary)] font-mono tabular-nums">/ {totalTasks}</div>
          </div>
          <div className="text-sm text-[var(--text-muted)] mb-2">{taskSummary}</div>
          <div className="w-full bg-[var(--surface-inset)] rounded-md h-2">
            <div
              className="bg-[var(--interactive-primary)] h-2 rounded-md transition-all duration-300"
              style={{ width: `${taskCompletionRate}%` }}
            />
          </div>
        </div>
      </div>

      {/* Coming Soon Card */}
      <div className="bg-[var(--surface-panel)] border border-[var(--border-default)] rounded-lg p-4">
        <div className="text-center">
          <div className="w-16 h-16 bg-[var(--surface-inset)] rounded-lg flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-[var(--text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-[var(--text-primary)] mb-2">{t('comingSoon.title')}</h3>
          <p className="text-sm text-[var(--text-muted)] max-w-sm mx-auto mb-6">
            {t('comingSoon.description')}
          </p>

        </div>
      </div>

    </div>
  );
}

export function DashboardStatistics() {
  return <Content />;
}


