import { useState, useEffect } from 'react';
import { bootstrapSession } from './api';
import UploadFlow from './components/UploadFlow';
import EditorFlow from './components/EditorFlow';
import JobsFlow from './components/JobsFlow';
import ResultsFlow from './components/ResultsFlow';
import { Asset, Job, Result, Session } from './types';

type AppFlow = 'upload' | 'editor' | 'jobs' | 'results';

function App() {
  const [flow, setFlow] = useState<AppFlow>('upload');
  const [asset, setAsset] = useState<Asset | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (loading) {
    return <div className="container"><p>Initializing...</p></div>;
  }

  if (error) {
    return <div className="container"><p style={{ color: 'red' }}>Error: {error}</p></div>;
  }

  return (
    <div className="app">
      {flow === 'upload' && <UploadFlow onSuccess={handleUploadSuccess} />}
      {flow === 'editor' && asset && (
        <EditorFlow asset={asset} onSuccess={handleEditorSuccess} onCancel={handleReset} />
      )}
      {flow === 'jobs' && (
        <JobsFlow currentSessionId={session?.sessionId ?? null} activeJobId={activeJobId} onOpenResult={handleOpenResult} onReset={handleReset} />
      )}
      {flow === 'results' && result && job && (
        <ResultsFlow result={result} job={job} onReset={handleReset} />
      )}
    </div>
  );
}

export default App;
