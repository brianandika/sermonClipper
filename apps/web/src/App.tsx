import { useState, useEffect } from 'react';
import { bootstrapSession } from './api';
import UploadFlow from './components/UploadFlow';
import EditorFlow from './components/EditorFlow';
import ResultsFlow from './components/ResultsFlow';
import { Asset, Job, Result } from './types';

type AppFlow = 'upload' | 'editor' | 'results';

function App() {
  const [flow, setFlow] = useState<AppFlow>('upload');
  const [asset, setAsset] = useState<Asset | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize session on mount
  useEffect(() => {
    const init = async () => {
      try {
        await bootstrapSession();
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

  const handleEditorSuccess = (createdJob: Job, createdResult: Result) => {
    setJob(createdJob);
    setResult(createdResult);
    setFlow('results');
  };

  const handleReset = () => {
    setAsset(null);
    setJob(null);
    setResult(null);
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
      {flow === 'results' && result && job && (
        <ResultsFlow result={result} job={job} onReset={handleReset} />
      )}
    </div>
  );
}

export default App;
