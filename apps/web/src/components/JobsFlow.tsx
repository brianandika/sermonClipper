import { useEffect, useMemo, useState } from 'react';
import { cancelJob, getJobs, getResult, getResultArtifact } from '../api';
import { Job, Result } from '../types';

interface JobsFlowProps {
  currentSessionId: string | null;
  activeJobId: string | null;
  onOpenResult: (job: Job, result: Result) => void;
  onOpenShorts: (job: Job) => void;
  onViewTranscribeResult: (job: Job) => void | Promise<void>;
  onAddSubtitles: (job: Job) => void;
  shortsBusy: boolean;
  onReset: () => void;
}

const jobKind = (job: Job): string => job.payload?.kind ?? 'sermon';

const ACTIVE_STATUSES = new Set([
  'queued',
  'preparing',
  'processing_audio',
  'encoding_video',
  'encoding_audio',
]);

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'expired']);

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatStatus(value: string) {
  return value.split('_').join(' ');
}

function getRequestedOutputName(job: Job) {
  const rawName = job.payload.outputAudioFilename ?? job.payload.outputVideoFilename ?? '';
  const trimmed = rawName.trim();

  if (!trimmed) {
    return 'result';
  }

  return trimmed.replace(/\.[^.]+$/, '');
}

function MiniBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div style={{ marginBottom: '0.4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#64748b', marginBottom: '0.15rem' }}>
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div style={{ height: '0.5rem', background: '#e2e8f0', borderRadius: '999px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}

export default function JobsFlow({ currentSessionId, activeJobId, onOpenResult, onOpenShorts, onViewTranscribeResult, onAddSubtitles, shortsBusy, onReset }: JobsFlowProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionJobId, setActionJobId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadJobs = async () => {
      try {
        const nextJobs = await getJobs();
        if (!active) {
          return;
        }
        setJobs(nextJobs);
        setError(null);
      } catch (err) {
        if (!active) {
          return;
        }
        setError(`Failed to load jobs: ${String(err)}`);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadJobs();
    const intervalId = window.setInterval(() => {
      void loadJobs();
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const activeCount = useMemo(
    () => jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length,
    [jobs],
  );

  // Group short jobs under their originating sermon/transcribe job so exported
  // shorts don't flood the queue. Shorts whose parent isn't in the current list
  // (e.g. another session's) fall back to their own top-level rows.
  const { topLevelJobs, childrenByParent, shortsCount } = useMemo(() => {
    const parents = jobs.filter((job) => jobKind(job) !== 'short');
    const parentIds = new Set(parents.map((job) => job.jobId));
    const byParent = new Map<string, Job[]>();
    const orphanShorts: Job[] = [];
    let shorts = 0;
    for (const job of jobs) {
      if (jobKind(job) !== 'short') continue;
      shorts += 1;
      const parentId = job.payload?.parentJobId;
      if (parentId && parentIds.has(parentId)) {
        const bucket = byParent.get(parentId) ?? [];
        bucket.push(job);
        byParent.set(parentId, bucket);
      } else {
        orphanShorts.push(job);
      }
    }
    return {
      topLevelJobs: [...parents, ...orphanShorts],
      childrenByParent: byParent,
      shortsCount: shorts,
    };
  }, [jobs]);

  const handleCancel = async (jobId: string) => {
    setActionJobId(jobId);
    try {
      const updatedJob = await cancelJob(jobId);
      setJobs((prev) => prev.map((job) => (job.jobId === jobId ? updatedJob : job)));
      setError(null);
    } catch (err) {
      setError(`Failed to cancel job: ${String(err)}`);
    } finally {
      setActionJobId(null);
    }
  };

  const handleViewResult = async (job: Job) => {
    setActionJobId(job.jobId);
    try {
      const result = await getResult(job.jobId);
      onOpenResult(job, result);
    } catch (err) {
      setError(`Failed to load result: ${String(err)}`);
    } finally {
      setActionJobId(null);
    }
  };

  const handleViewTranscribeResult = async (job: Job) => {
    setActionJobId(job.jobId);
    try {
      await onViewTranscribeResult(job);
    } catch (err) {
      setError(`Failed to open result: ${String(err)}`);
    } finally {
      setActionJobId(null);
    }
  };

  return (
    <div className="container" style={{ maxWidth: '1400px', width: 'min(1400px, calc(100vw - 2rem))' }}>
      <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ marginBottom: '0.5rem' }}>Job Queue</h1>
          <p style={{ margin: 0 }}>Track all queued jobs and progress across all clients here.</p>
        </div>
        <button type="button" className="btn" onClick={onReset} style={{ background: '#6b7280' }}>
          Process Another Video
        </button>
      </div>

      <div style={{ width: '100%', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
        <div style={{ padding: '1rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.75rem' }}>
          <strong>Total Jobs</strong>
          <div style={{ fontSize: '1.5rem', marginTop: '0.5rem' }}>{topLevelJobs.length}</div>
          {shortsCount > 0 ? <div style={{ fontSize: '0.8rem', color: '#64748b' }}>+ {shortsCount} short{shortsCount === 1 ? '' : 's'}</div> : null}
        </div>
        <div style={{ padding: '1rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.75rem' }}>
          <strong>Active Jobs</strong>
          <div style={{ fontSize: '1.5rem', marginTop: '0.5rem' }}>{activeCount}</div>
        </div>
      </div>

      {error ? <p style={{ width: '100%', color: '#b91c1c' }}>{error}</p> : null}
      {loading ? <p style={{ width: '100%' }}>Loading jobs...</p> : null}

      <div style={{ width: '100%' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ width: '12%', textAlign: 'left', padding: '0.75rem', borderBottom: '1px solid #e2e8f0' }}>Job</th>
              <th style={{ width: '13%', textAlign: 'left', padding: '0.75rem', borderBottom: '1px solid #e2e8f0' }}>Owner</th>
              <th style={{ width: '11%', textAlign: 'left', padding: '0.75rem', borderBottom: '1px solid #e2e8f0' }}>Status</th>
              <th style={{ width: '15%', textAlign: 'left', padding: '0.75rem', borderBottom: '1px solid #e2e8f0' }}>Progress</th>
              <th style={{ width: '24%', textAlign: 'left', padding: '0.75rem', borderBottom: '1px solid #e2e8f0' }}>Message</th>
              <th style={{ width: '13%', textAlign: 'left', padding: '0.75rem', borderBottom: '1px solid #e2e8f0' }}>Created</th>
              <th style={{ width: '12%', textAlign: 'left', padding: '0.75rem', borderBottom: '1px solid #e2e8f0' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {topLevelJobs.map((job) => {
              const isActiveRow = job.jobId === activeJobId;
              const isOwnedByCurrentSession = currentSessionId !== null && job.sessionId === currentSessionId;
              const isTranscribe = jobKind(job) === 'transcribeSource';
              const canCancel = isOwnedByCurrentSession && ACTIVE_STATUSES.has(job.status);
              // Sermon result (audio/video/transcript) — opened via getResult.
              const canOpenResult = isOwnedByCurrentSession && !isTranscribe && Boolean(job.result?.audioPath);
              // Transcribe-only job: no Result row, but a "View Result" page built
              // from the uploaded video + transcript once it completes.
              const canViewTranscribeResult = isOwnedByCurrentSession && isTranscribe && job.status === 'completed';
              // "Shorts" for a completed sermon (has a video) or a completed transcribe job.
              const canShorts = isOwnedByCurrentSession
                && job.status === 'completed'
                && ((jobKind(job) === 'sermon' && Boolean(job.result?.videoPath)) || isTranscribe);
              // Sermon with a finished video can have subtitles burned in.
              const canAddSubtitles = isOwnedByCurrentSession
                && jobKind(job) === 'sermon'
                && job.status === 'completed'
                && Boolean(job.result?.videoPath);
              // burnSubtitles jobs have no Result-page flow, just a direct download.
              const isBurnSubtitles = jobKind(job) === 'burnSubtitles';
              const canDownloadSubtitledVideo = isOwnedByCurrentSession && isBurnSubtitles
                && job.status === 'completed' && Boolean(job.result?.videoPath);
              const audioProgress = Math.max(0, Math.min(100, job.progress?.audioProgress ?? 0));
              const videoProgress = Math.max(0, Math.min(100, job.progress?.videoProgress ?? 0));
              const transcriptProgress = Math.max(0, Math.min(100, job.progress?.transcriptProgress ?? 0));
              const rowBusy = actionJobId === job.jobId;
              const requestedOutputName = getRequestedOutputName(job);
              const noActions = !canCancel && !canOpenResult && !canViewTranscribeResult && !canShorts && !canAddSubtitles && !canDownloadSubtitledVideo;

              const childShorts = childrenByParent.get(job.jobId) ?? [];
              const shortsDone = childShorts.filter((c) => c.status === 'completed' && Boolean(c.result?.videoPath)).length;

              return (
                <tr key={job.jobId} style={{ background: isActiveRow ? 'rgba(37, 99, 235, 0.06)' : 'transparent' }}>
                  <td style={{ padding: '0.75rem', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top', overflowWrap: 'anywhere' }}>
                    <div style={{ fontWeight: 600 }}>{job.jobId.slice(0, 8)}</div>
                    <div style={{ fontSize: '0.875rem', color: '#64748b' }}>{job.queueName}</div>
                  </td>
                  <td style={{ padding: '0.75rem', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top' }}>
                    <div style={{ fontWeight: 600 }}>{isOwnedByCurrentSession ? 'You' : `${job.sessionId.slice(0, 8)}...`}</div>
                    <div style={{ fontSize: '0.875rem', color: '#64748b' }}>{job.sessionId.slice(0, 12)}...</div>
                  </td>
                  <td style={{ padding: '0.75rem', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top', textTransform: 'capitalize' }}>
                    {formatStatus(job.status)}
                    {isActiveRow ? <div style={{ fontSize: '0.875rem', color: '#2563eb', marginTop: '0.25rem' }}>Newest submission</div> : null}
                  </td>
                  <td style={{ padding: '0.75rem', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top', minWidth: '180px' }}>
                    <MiniBar label="Audio" value={audioProgress} color="#2563eb" />
                    <MiniBar label="Video" value={videoProgress} color="#7c3aed" />
                    <MiniBar label="Transcript" value={transcriptProgress} color="#059669" />
                  </td>
                  <td style={{ padding: '0.75rem', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top', overflowWrap: 'anywhere' }}>
                    {job.progress?.message ?? job.failureReason ?? (TERMINAL_STATUSES.has(job.status) ? 'No active progress' : 'Queued')}
                    {childShorts.length > 0 ? (
                      <div style={{ marginTop: '0.5rem', color: '#0f766e', fontWeight: 600, fontSize: '0.85rem' }}>
                        Shorts: {shortsDone}/{childShorts.length} done
                      </div>
                    ) : null}
                  </td>
                  <td style={{ padding: '0.75rem', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top', fontSize: '0.875rem' }}>
                    <div>{formatDate(job.createdAt)}</div>
                    <div style={{ marginTop: '0.35rem', color: '#64748b', overflowWrap: 'anywhere' }}>
                      Output: {requestedOutputName}
                    </div>
                  </td>
                  <td style={{ padding: '0.75rem', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-start' }}>
                      {canCancel ? (
                        <button type="button" className="btn" onClick={() => handleCancel(job.jobId)} disabled={rowBusy} style={{ background: '#dc2626', minWidth: '88px' }}>
                          {rowBusy ? 'Working...' : 'Cancel'}
                        </button>
                      ) : null}
                      {canOpenResult ? (
                        <button type="button" className="btn" onClick={() => handleViewResult(job)} disabled={rowBusy} style={{ minWidth: '88px' }}>
                          {rowBusy ? 'Opening...' : (job.result?.videoPath ? 'View Result' : 'Open Audio')}
                        </button>
                      ) : null}
                      {canViewTranscribeResult ? (
                        <button type="button" className="btn" onClick={() => handleViewTranscribeResult(job)} disabled={rowBusy} style={{ minWidth: '88px' }}>
                          {rowBusy ? 'Opening...' : 'View Result'}
                        </button>
                      ) : null}
                      {canShorts ? (
                        <button type="button" className="btn" onClick={() => onOpenShorts(job)} disabled={shortsBusy} style={{ minWidth: '88px', background: '#0f766e' }}>
                          {shortsBusy ? 'Opening...' : 'Shorts'}
                        </button>
                      ) : null}
                      {canAddSubtitles ? (
                        <button type="button" className="btn" onClick={() => onAddSubtitles(job)} disabled={rowBusy} style={{ minWidth: '88px', background: '#7c3aed' }}>
                          Add Subtitles
                        </button>
                      ) : null}
                      {canDownloadSubtitledVideo && job.result ? (
                        <a
                          className="btn"
                          href={getResultArtifact(job.result.resultId, 'video')}
                          download
                          style={{ minWidth: '88px', background: '#7c3aed', textAlign: 'center' }}
                        >
                          Download
                        </a>
                      ) : null}
                      {noActions ? <span style={{ color: '#64748b' }}>{isOwnedByCurrentSession ? 'No actions' : 'Read only'}</span> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && topLevelJobs.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: '1rem', textAlign: 'center', color: '#64748b' }}>
                  No jobs submitted yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}