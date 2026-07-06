import { useState, useEffect } from 'react';
import { bootstrapSession } from './api';
import UploadFlow from './components/UploadFlow';
import EditorFlow from './components/EditorFlow';
import ShortsFlow from './components/ShortsFlow';
import JobsFlow from './components/JobsFlow';
import ResultsFlow from './components/ResultsFlow';
import { Asset, Job, Result, Session } from './types';

type AppFlow = 'upload' | 'editor' | 'shorts' | 'jobs' | 'results';

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

  const handleEditorSuccess = (createdJob: Job) => {
    setJob(createdJob);
    setActiveJobId(createdJob.jobId);
    setResult(null);
    setFlow('jobs');
  };

  const handleOpenResult = (selectedJob: Job, selectedResult: Result) => {
    setJob(selectedJob);
    setResult(selectedResult);
    setFlow('results');
  };

  const handleReset = () => {
    setAsset(null);
    setJob(null);
    setResult(null);
    setActiveJobId(null);
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
      key: 'shorts',
      label: 'Shorts',
      description: asset ? 'Make 9:16 vertical clips' : 'Upload media first',
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
      description: result ? 'Review finished output' : 'Available after completion',
      disabled: !result || !job,
    },
  ];

  const pendingFlowLabel = navItems.find((item) => item.key === pendingFlow)?.label ?? 'another page';

  const completeNavigation = (nextFlow: AppFlow) => {
    if ((nextFlow === 'editor' || nextFlow === 'shorts') && !asset) {
      return;
    }
    if (nextFlow === 'results' && (!result || !job)) {
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

        {flow === 'upload' && <UploadFlow onSuccess={handleUploadSuccess} />}
        {flow === 'editor' && asset && (
          <EditorFlow asset={asset} onSuccess={handleEditorSuccess} onCancel={handleEditorCancel} />
        )}
        {flow === 'shorts' && asset && (
          <ShortsFlow asset={asset} />
        )}
        {flow === 'jobs' && (
          <JobsFlow currentSessionId={session?.sessionId ?? null} activeJobId={activeJobId} onOpenResult={handleOpenResult} onReset={handleReset} />
        )}
        {flow === 'results' && result && job && (
          <ResultsFlow result={result} job={job} />
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
