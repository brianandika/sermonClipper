import { useState, useEffect } from 'react';
import { bootstrapSession, createShortsSourceFromJob, createTranscribeJob, getAsset } from './api';
import UploadFlow from './components/UploadFlow';
import EditorFlow from './components/EditorFlow';
import ShortsFlow from './components/ShortsFlow';
import ClipFlow from './components/ClipFlow';
import JobsFlow from './components/JobsFlow';
import ResultsFlow from './components/ResultsFlow';
import TranscribeResultsFlow from './components/TranscribeResultsFlow';
import { Asset, ClipDraft, Job, Result, Session } from './types';

function createClipDraft(source: Asset): ClipDraft {
  return {
    start: 0,
    end: source.duration ?? 0,
    fade: false,
    burnSubtitles: false,
    title: '',
    gaps: [],
    cues: [],
    preparedFor: null,
    preparingFor: null,
    prepJobId: null,
  };
}

type AppFlow = 'upload' | 'editor' | 'shorts' | 'clip' | 'jobs' | 'results';

interface NavItem {
  key: AppFlow;
  label: string;
  description: string;
  disabled?: boolean;
}

function App() {
  const [flow, setFlow] = useState<AppFlow>('upload');
  const [asset, setAsset] = useState<Asset | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  // Shorts source + in-flight transcription lifted here so switching tabs never
  // unmounts/re-triggers the Shorts flow (which used to spawn duplicate jobs).
  const [shortsSource, setShortsSource] = useState<Asset | null>(null);
  const [shortsPrepJobId, setShortsPrepJobId] = useState<string | null>(null);
  // The job that a short's exports should group under in the queue: the sermon
  // job (reuse path) or the transcribe job (standalone-upload-for-shorts path).
  const [shortsParentJobId, setShortsParentJobId] = useState<string | null>(null);
  const [shortsBusy, setShortsBusy] = useState(false);
  // Clip source + its whole draft (trim points, toggles, transcript-in-
  // progress), lifted for the same reason as the Shorts state above — see
  // ClipDraft's own comment for why ClipFlow needs so much more of its state
  // lifted than ShortsFlow does.
  const [clipSource, setClipSource] = useState<Asset | null>(null);
  const [clipDraft, setClipDraft] = useState<ClipDraft | null>(null);
  const patchClipDraft = (patch: Partial<ClipDraft>) => {
    setClipDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };
  // Asset backing a transcribe-only "View Result" page (no Result row exists for
  // transcribeSource jobs — the video + transcript come straight from the asset).
  const [transcribeAsset, setTranscribeAsset] = useState<Asset | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingFlow, setPendingFlow] = useState<AppFlow | null>(null);
  const [showLeaveEditorModal, setShowLeaveEditorModal] = useState(false);

  // Initialize session on mount
  useEffect(() => {
    const init = async () => {
      try {
        const nextSession = await bootstrapSession();
        setSession({
          sessionId: nextSession.sessionId,
          expiresAt: nextSession.expiresAt,
        });
        setLoading(false);
      } catch (err) {
        setError(`Failed to initialize session: ${err}`);
        setLoading(false);
      }
    };
    init();
  }, []);

  const handleUploadSuccess = (uploadedAsset: Asset) => {
    setAsset(uploadedAsset);
    setFlow('editor');
  };

  // "Upload for Shorts": skip the editor, queue a transcribe-only job, and land
  // on the Jobs tab where that job is visible. Shorts are entered later via the
  // job's "View Result"/"Shorts" actions once transcription completes.
  const handleUploadForShorts = async (uploadedAsset: Asset) => {
    try {
      const prepJob = await createTranscribeJob(uploadedAsset.assetId);
      setActiveJobId(prepJob.jobId);
      setFlow('jobs');
    } catch (err) {
      setError(`Could not start transcription: ${err}`);
    }
  };

  // "Upload to Clip": land directly on the Clip tab. Unlike Shorts, no job is
  // queued yet — whether a transcript is needed isn't known until the user
  // checks "Burn in subtitles".
  const handleUploadForClip = (uploadedAsset: Asset) => {
    setClipSource(uploadedAsset);
    setClipDraft(createClipDraft(uploadedAsset));
    setFlow('clip');
  };

  // Open a transcribe-only job's result page: the uploaded video + its transcript
  // (no audio, no Result row — sourced from the asset).
  const handleOpenTranscribeResult = async (sourceJob: Job) => {
    const source = await getAsset(sourceJob.assetId);
    setJob(sourceJob);
    setResult(null);
    setTranscribeAsset(source);
    setFlow('results');
  };

  // Open the Shorts editor from a completed transcribe-only job (queue row or its
  // result page). The asset is transcript-ready, so it opens straight into the
  // moment picker.
  const handleOpenShortsForAsset = async (sourceJob: Job) => {
    setShortsBusy(true);
    try {
      const source = await getAsset(sourceJob.assetId);
      setShortsSource(source);
      setShortsPrepJobId(null);
      setShortsParentJobId(sourceJob.jobId);
      setFlow('shorts');
    } catch (err) {
      setError(`Could not open Shorts for that transcription: ${err}`);
    } finally {
      setShortsBusy(false);
    }
  };

  const handleEditorSuccess = (createdJob: Job) => {
    setJob(createdJob);
    setActiveJobId(createdJob.jobId);
    setResult(null);
    setFlow('jobs');
  };

  const handleOpenResult = (selectedJob: Job, selectedResult: Result) => {
    setJob(selectedJob);
    setResult(selectedResult);
    setTranscribeAsset(null);
    setFlow('results');
  };

  // Single entry to the Shorts editor from any job: transcribe jobs reuse the
  // asset directly; sermon jobs derive a shorts source from the finished clip.
  const openShortsForJob = (sourceJob: Job) => {
    if ((sourceJob.payload?.kind ?? 'sermon') === 'transcribeSource') {
      void handleOpenShortsForAsset(sourceJob);
    } else {
      void handleCreateShortsFromJob(sourceJob);
    }
  };

  // Entry to Shorts from a finished sermon (Results page or a completed Jobs
  // row): reuse its MP4 + VTT as the source — no re-transcription.
  const handleCreateShortsFromJob = async (sourceJob: Job) => {
    setShortsBusy(true);
    try {
      const source = await createShortsSourceFromJob(sourceJob.jobId);
      setShortsSource(source);
      setShortsPrepJobId(null);
      setShortsParentJobId(sourceJob.jobId);
      setFlow('shorts');
    } catch (err) {
      setError(`Could not start Shorts from that clip: ${err}`);
    } finally {
      setShortsBusy(false);
    }
  };

  const handleReset = () => {
    setAsset(null);
    setJob(null);
    setResult(null);
    setActiveJobId(null);
    setShortsSource(null);
    setShortsPrepJobId(null);
    setShortsParentJobId(null);
    setClipSource(null);
    setClipDraft(null);
    setTranscribeAsset(null);
    setFlow('upload');
  };

  const navItems: NavItem[] = [
    {
      key: 'upload',
      label: 'Upload',
      description: 'Start a new session',
    },
    {
      key: 'editor',
      label: 'Edit',
      description: asset ? 'Trim clips and add an intro' : 'Upload media first',
      disabled: !asset,
    },
    {
      key: 'jobs',
      label: 'Jobs',
      description: 'Monitor queue activity',
    },
    {
      key: 'results',
      label: 'Results',
      description: result || transcribeAsset ? 'Review finished output' : 'Available after completion',
      disabled: !job || (!result && !transcribeAsset),
    },
    {
      key: 'shorts',
      label: 'Shorts',
      description: shortsSource ? 'Make 9:16 vertical clips' : 'Open from a job or result',
      disabled: !shortsSource,
    },
    {
      key: 'clip',
      label: 'Clip',
      description: clipSource ? 'Trim any video' : 'Upload a video to clip',
      disabled: !clipSource,
    },
  ];

  const pendingFlowLabel = navItems.find((item) => item.key === pendingFlow)?.label ?? 'another page';

  const completeNavigation = (nextFlow: AppFlow) => {
    if (nextFlow === 'editor' && !asset) {
      return;
    }
    if (nextFlow === 'results' && (!job || (!result && !transcribeAsset))) {
      return;
    }
    // Shorts is only reachable via a job's "Shorts" action or a result page's
    // "Open Shorts" — never by clicking the tab with no source.
    if (nextFlow === 'shorts' && !shortsSource) {
      return;
    }
    // Clip is only reachable via "Upload to Clip" — never by clicking the tab
    // with no source.
    if (nextFlow === 'clip' && (!clipSource || !clipDraft)) {
      return;
    }
    setFlow(nextFlow);
  };

  const requestFlowChange = (nextFlow: AppFlow) => {
    if (nextFlow === flow) {
      return;
    }

    if (flow === 'editor' && nextFlow !== 'editor') {
      setPendingFlow(nextFlow);
      setShowLeaveEditorModal(true);
      return;
    }

    completeNavigation(nextFlow);
  };

  const handleNavigate = (nextFlow: AppFlow) => {
    requestFlowChange(nextFlow);
  };

  const handleEditorCancel = () => {
    setPendingFlow('upload');
    setShowLeaveEditorModal(true);
  };

  const closeLeaveEditorModal = () => {
    setPendingFlow(null);
    setShowLeaveEditorModal(false);
  };

  const confirmLeaveEditor = () => {
    const nextFlow = pendingFlow ?? 'upload';
    setShowLeaveEditorModal(false);
    setPendingFlow(null);

    if (nextFlow === 'upload') {
      handleReset();
      return;
    }

    completeNavigation(nextFlow);
  };

  if (loading) {
    return <div className="container"><p>Initializing...</p></div>;
  }

  if (error) {
    return <div className="container"><p style={{ color: 'red' }}>Error: {error}</p></div>;
  }

  return (
    <div className="app">
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header-content">
            <div>
              <p className="app-eyebrow">Sermon Clipper</p>
              <h1 className="app-title">Clip builder and processing queue</h1>
            </div>
            <p className="app-subtitle">Move between upload, edit, jobs, and results without losing the workflow context.</p>
          </div>
          <nav className="app-nav" aria-label="Primary">
            {navItems.map((item, index) => (
              <button
                key={item.key}
                type="button"
                className={`app-nav-item${flow === item.key ? ' active' : ''}`}
                onClick={() => handleNavigate(item.key)}
                disabled={item.disabled}
                aria-current={flow === item.key ? 'page' : undefined}
              >
                <span className="app-nav-step" aria-hidden="true">{index + 1}</span>
                <span className="app-nav-label">{item.label}</span>
                <span className="app-nav-description">{item.description}</span>
              </button>
            ))}
          </nav>
        </header>

        {flow === 'upload' && (
          <UploadFlow
            onSuccess={handleUploadSuccess}
            onUploadForShorts={handleUploadForShorts}
            onUploadForClip={handleUploadForClip}
          />
        )}
        {flow === 'editor' && asset && (
          <EditorFlow asset={asset} onSuccess={handleEditorSuccess} onCancel={handleEditorCancel} />
        )}
        {flow === 'shorts' && shortsSource && (
          <ShortsFlow
            source={shortsSource}
            onSourceChange={setShortsSource}
            prepJobId={shortsPrepJobId}
            onPrepJobId={setShortsPrepJobId}
            parentJobId={shortsParentJobId}
          />
        )}
        {flow === 'clip' && clipSource && clipDraft && (
          <ClipFlow
            source={clipSource}
            draft={clipDraft}
            onDraftChange={patchClipDraft}
          />
        )}
        {flow === 'jobs' && (
          <JobsFlow currentSessionId={session?.sessionId ?? null} activeJobId={activeJobId} onOpenResult={handleOpenResult} onOpenShorts={openShortsForJob} onViewTranscribeResult={handleOpenTranscribeResult} shortsBusy={shortsBusy} onReset={handleReset} />
        )}
        {flow === 'results' && job && result && (
          <ResultsFlow result={result} job={job} onCreateShorts={openShortsForJob} shortsBusy={shortsBusy} />
        )}
        {flow === 'results' && job && !result && transcribeAsset && (
          <TranscribeResultsFlow job={job} asset={transcribeAsset} onOpenShorts={openShortsForJob} shortsBusy={shortsBusy} />
        )}
      </div>

      {showLeaveEditorModal ? (
        <div className="app-modal-backdrop" role="presentation">
          <div className="app-modal" role="dialog" aria-modal="true" aria-labelledby="leave-editor-title" aria-describedby="leave-editor-description">
            <div className="app-modal-badge">Unsaved edit</div>
            <h2 id="leave-editor-title" className="app-modal-title">Leave the edit page?</h2>
            <p id="leave-editor-description" className="app-modal-copy">
              If you switch to {pendingFlowLabel}, your current trim points, clip changes, and intro image selections will be discarded.
            </p>
            <div className="app-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={closeLeaveEditorModal}>
                Stay here
              </button>
              <button type="button" className="btn app-danger-button" onClick={confirmLeaveEditor}>
                Leave editor
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
