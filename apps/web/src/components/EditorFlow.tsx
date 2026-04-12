import { useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Asset, HardwareOption, Job, PeaksResponse } from '../types';
import {
  createJob,
  getAssetFps,
  getAssetPeaks,
  getAssetSourceUrl,
  getHardwareCapabilities,
  uploadAsset,
} from '../api';

interface EditorFlowProps {
  asset: Asset;
  onSuccess: (job: Job) => void;
  onCancel: () => void;
}

interface ClipRange {
  start: number;
  end: number;
}

const PLAYBACK_SPEEDS = [-4, -2, -1, 1, 2, 4];
const DEFAULT_PLAYBACK_INDEX = 3;

function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const ms = Math.floor((clamped % 1) * 1000);
  const totalSeconds = Math.floor(clamped);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function parseTimeInput(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function EditorFlow({ asset, onSuccess, onCancel }: EditorFlowProps) {
  const assetDuration = asset.duration ?? 0;
  const [resolvedDuration, setResolvedDuration] = useState(Math.max(0, assetDuration));

  const [startTimeText, setStartTimeText] = useState('0.000');
  const [endTimeText, setEndTimeText] = useState(Math.max(0, assetDuration).toFixed(3));
  const [clips, setClips] = useState<ClipRange[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [fps, setFps] = useState(30);
  const [peaks, setPeaks] = useState<PeaksResponse | null>(null);
  const [hardware, setHardware] = useState<HardwareOption>('auto');
  const [detectedHardware, setDetectedHardware] = useState<HardwareOption>('auto');
  const [availableHardware, setAvailableHardware] = useState<Set<HardwareOption>>(new Set<HardwareOption>(['auto', 'cpu']));
  const [coverImageFile, setCoverImageFile] = useState<File | null>(null);
  const [coverImageAssetId, setCoverImageAssetId] = useState<string | null>(null);
  const [coverImageUploading, setCoverImageUploading] = useState(false);
  const [playbackSpeedIndex, setPlaybackSpeedIndex] = useState(DEFAULT_PLAYBACK_INDEX);
  const [submittingJob, setSubmittingJob] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const backwardIntervalRef = useRef<number | null>(null);
  const videoSourceUrl = getAssetSourceUrl(asset.assetId);
  const effectiveDuration = Math.max(0, resolvedDuration, assetDuration);

  const startTime = parseTimeInput(startTimeText) ?? 0;
  const endTime = parseTimeInput(endTimeText) ?? effectiveDuration;
  const playbackSpeed = PLAYBACK_SPEEDS[playbackSpeedIndex] ?? 1;

  const playbackLabel = useMemo(() => {
    const direction = playbackSpeed < 0 ? 'Backward' : 'Forward';
    return `Speed: ${Math.abs(playbackSpeed)}x ${direction}`;
  }, [playbackSpeed]);

  useEffect(() => {
    let mounted = true;

    const loadEditorMetadata = async () => {
      const [fpsResult, peaksResult, hardwareResult] = await Promise.allSettled([
        getAssetFps(asset.assetId),
        getAssetPeaks(asset.assetId),
        getHardwareCapabilities(),
      ]);

      if (!mounted) {
        return;
      }

      if (fpsResult.status === 'fulfilled') {
        setFps(fpsResult.value.fps || 30);
        const durationFromMetadata = fpsResult.value.duration;
        if (Number.isFinite(durationFromMetadata) && durationFromMetadata > 0) {
          setResolvedDuration((prev) => Math.max(prev, durationFromMetadata));
          setEndTimeText((prev) => {
            const current = parseTimeInput(prev);
            if (current === null || current <= 0) {
              return durationFromMetadata.toFixed(3);
            }
            return prev;
          });
        }
      }

      if (peaksResult.status === 'fulfilled') {
        setPeaks(peaksResult.value);
      } else {
        setPeaks({
          data: new Array<number>(120).fill(0),
          length: 120,
          bits: 16,
          sampleRate: 16000,
        });
      }

      if (hardwareResult.status === 'fulfilled') {
        setDetectedHardware(hardwareResult.value.detected);
        setHardware(hardwareResult.value.detected || 'auto');
        setAvailableHardware(new Set<HardwareOption>(['auto', ...hardwareResult.value.available]));
      }

      if (
        fpsResult.status === 'rejected' &&
        peaksResult.status === 'rejected' &&
        hardwareResult.status === 'rejected'
      ) {
        setError('Failed to load editor metadata.');
      }
    };

    void loadEditorMetadata();

    return () => {
      mounted = false;
      if (backwardIntervalRef.current !== null) {
        window.clearInterval(backwardIntervalRef.current);
      }
    };
  }, [asset.assetId]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // Initialize WaveSurfer when peaks data is available
  useEffect(() => {
    if (!waveformContainerRef.current || !videoRef.current || !peaks?.data?.length) {
      return;
    }

    // Clean up previous instance
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
    }

    wavesurferRef.current = WaveSurfer.create({
      container: waveformContainerRef.current,
      waveColor: '#2563eb',
      progressColor: '#1d4ed8',
      cursorColor: '#ef4444',
      backend: 'MediaElement',
      mediaControls: false,
      height: 80,
      barWidth: 2,
      barRadius: 2,
      cursorWidth: 2,
      hideScrollbar: true,
      media: videoRef.current,
      peaks: [peaks.data],
    });

    return () => {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
  }, [peaks]);

  const stopCustomPlayback = () => {
    if (backwardIntervalRef.current !== null) {
      window.clearInterval(backwardIntervalRef.current);
      backwardIntervalRef.current = null;
    }
  };

  const stepBack = () => {
    if (!videoRef.current) {
      return;
    }
    stopCustomPlayback();
    videoRef.current.pause();
    videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 1 / fps);
  };

  const stepForward = () => {
    if (!videoRef.current) {
      return;
    }
    stopCustomPlayback();
    videoRef.current.pause();
    videoRef.current.currentTime = Math.min(effectiveDuration, videoRef.current.currentTime + 1 / fps);
  };

  const changePlaybackSpeed = (nextIndex: number) => {
    if (!videoRef.current) {
      return;
    }

    const clampedIndex = Math.max(0, Math.min(PLAYBACK_SPEEDS.length - 1, nextIndex));
    setPlaybackSpeedIndex(clampedIndex);
    const nextSpeed = PLAYBACK_SPEEDS[clampedIndex] ?? 1;

    stopCustomPlayback();

    if (nextSpeed < 0) {
      videoRef.current.pause();
      backwardIntervalRef.current = window.setInterval(() => {
        if (!videoRef.current) {
          return;
        }
        if (videoRef.current.currentTime <= 0) {
          stopCustomPlayback();
          return;
        }
        videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime + nextSpeed / fps);
      }, 1000 / fps);
      return;
    }

    videoRef.current.playbackRate = nextSpeed;
    void videoRef.current.play();
  };

  const setStartToCurrent = () => {
    if (!videoRef.current) {
      return;
    }
    setStartTimeText(videoRef.current.currentTime.toFixed(3));
  };

  const setEndToCurrent = () => {
    if (!videoRef.current) {
      return;
    }
    setEndTimeText(videoRef.current.currentTime.toFixed(3));
  };

  const addClip = () => {
    setClips((prev) => [...prev, { start: 0, end: 0 }]);
  };

  const removeClip = (index: number) => {
    setClips((prev) => prev.filter((_, i) => i !== index));
  };

  const setClipStartToCurrent = (index: number) => {
    if (!videoRef.current) {
      return;
    }
    const value = Number(videoRef.current.currentTime.toFixed(3));
    setClips((prev) => prev.map((clip, clipIndex) => (clipIndex === index ? { ...clip, start: value } : clip)));
  };

  const setClipEndToCurrent = (index: number) => {
    if (!videoRef.current) {
      return;
    }
    const value = Number(videoRef.current.currentTime.toFixed(3));
    setClips((prev) => prev.map((clip, clipIndex) => (clipIndex === index ? { ...clip, end: value } : clip)));
  };

  const updateClipField = (index: number, field: 'start' | 'end', value: string) => {
    const parsed = parseTimeInput(value);
    setClips((prev) =>
      prev.map((clip, clipIndex) => {
        if (clipIndex !== index) {
          return clip;
        }

        return {
          ...clip,
          [field]: parsed ?? 0,
        };
      })
    );
  };

  const jumpToClipTime = (index: number, field: 'start' | 'end') => {
    if (!videoRef.current) {
      return;
    }

    const clip = clips[index];
    if (!clip) {
      return;
    }

    const value = field === 'start' ? clip.start : clip.end;
    videoRef.current.currentTime = Math.max(0, Math.min(effectiveDuration, value));
  };

  const validateEditorState = () => {
    const issues: string[] = [];

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      issues.push('Start time and end time must be valid numbers.');
    }

    if (startTime < 0 || endTime < 0) {
      issues.push('Start time and end time must be 0 or greater.');
    }

    if (startTime >= endTime) {
      issues.push('Start time must be less than end time.');
    }

    if (effectiveDuration > 0 && endTime > effectiveDuration + 0.001) {
      issues.push('End time must be within the video duration.');
    }

    const sorted = [...clips]
      .filter((clip) => clip.start > 0 || clip.end > 0)
      .sort((a, b) => a.start - b.start);

    let previousEnd = startTime;
    for (const [index, clip] of sorted.entries()) {
      if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end)) {
        issues.push(`Clip ${index + 1} has invalid numeric values.`);
        continue;
      }
      if (clip.start >= clip.end) {
        issues.push(`Clip ${index + 1} start time must be less than end time.`);
      }
      if (clip.start < startTime || clip.end > endTime) {
        issues.push(`Clip ${index + 1} must be inside the start/end range.`);
      }
      if (clip.start < previousEnd) {
        issues.push(`Clip ${index + 1} overlaps a previous clip.`);
      }
      previousEnd = clip.end;
    }

    setValidationErrors(issues);
    return issues.length === 0;
  };

  const toCutRanges = () => {
    const validClips = [...clips]
      .filter((clip) => clip.start > 0 || clip.end > 0)
      .sort((a, b) => a.start - b.start);

    const clipStarts = validClips.map((clip) => Number(clip.start.toFixed(3)));
    const clipEnds = validClips.map((clip) => Number(clip.end.toFixed(3)));

    return { starts: clipStarts, ends: clipEnds };
  };

  const uploadCoverImage = async () => {
    if (!coverImageFile) {
      return null;
    }

    if (coverImageAssetId) {
      return coverImageAssetId;
    }

    setCoverImageUploading(true);
    try {
      const uploaded = await uploadAsset(coverImageFile);
      setCoverImageAssetId(uploaded.assetId);
      return uploaded.assetId;
    } finally {
      setCoverImageUploading(false);
    }
  };

  const handleProcess = async () => {
    if (!validateEditorState()) {
      return;
    }

    setSubmittingJob(true);
    setError(null);

    try {
      const { starts, ends } = toCutRanges();
      const introImageAssetId = await uploadCoverImage();

      const job = await createJob({
        assetId: asset.assetId,
        startTime,
        endTime,
        clipStarts: starts,
        clipEnds: ends,
        introImageAssetId: introImageAssetId ?? undefined,
        introDuration: introImageAssetId ? 5 : undefined,
        transitionDuration: 1,
        fps,
        hardware,
      });

      onSuccess(job);
    } catch (err) {
      setError(`Processing failed: ${String(err)}`);
    } finally {
      setSubmittingJob(false);
    }
  };

  const jumpToTime = (time: number) => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.currentTime = Math.max(0, Math.min(effectiveDuration, time));
  };

  const topStartPercent = effectiveDuration > 0 ? (Math.max(0, startTime) / effectiveDuration) * 100 : 0;
  const topEndPercent = effectiveDuration > 0 ? ((effectiveDuration - Math.max(startTime, endTime)) / effectiveDuration) * 100 : 0;

  const onVideoPlay = () => {
    if (!videoRef.current) {
      return;
    }
    stopCustomPlayback();
    videoRef.current.playbackRate = 1;
    setPlaybackSpeedIndex(DEFAULT_PLAYBACK_INDEX);
  };

  const onVideoPause = () => {
    stopCustomPlayback();
  };

  return (
    <div className="container">
      <h1>Edit Video: {asset.originalFilename}</h1>

      <div style={{ marginBottom: '2rem', width: '100%' }}>
        <video
          ref={videoRef}
          controls
          style={{ width: '100%', maxWidth: '800px', display: 'block', margin: '1rem auto' }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const loadedDuration = e.currentTarget.duration;
            if (Number.isFinite(loadedDuration) && loadedDuration > 0) {
              setResolvedDuration((prev) => Math.max(prev, loadedDuration));
              setEndTimeText((prev) => {
                const current = parseTimeInput(prev);
                if (current === null || current <= 0) {
                  return loadedDuration.toFixed(3);
                }
                return prev;
              });
            }
          }}
          onPlay={onVideoPlay}
          onPause={onVideoPause}
        >
          <source src={videoSourceUrl} type={asset.mimeType || 'video/mp4'} />
          Your browser doesn't support video playback.
        </video>

        <div className="video-utility-bar">
          <div id="current-timestamp" className="current-timestamp">{formatTimestamp(currentTime)}</div>
          <button type="button" id="step-back" className="btn" onClick={stepBack}>Step Back</button>
          <button type="button" id="step-forward" className="btn" onClick={stepForward}>Step Forward</button>
          <button type="button" id="play-backwards" className="btn" onClick={() => changePlaybackSpeed(playbackSpeedIndex - 1)}>
            Play Backwards
          </button>
          <button type="button" id="play-forwards" className="btn" onClick={() => changePlaybackSpeed(playbackSpeedIndex + 1)}>
            Play Forwards
          </button>
          <div id="playback-speed-indicator" className="playback-speed-indicator">{playbackLabel}</div>
        </div>

        <div
          className="timestamp-bar"
          onClick={(e) => {
            if (wavesurferRef.current) {
              const rect = e.currentTarget.getBoundingClientRect();
              const percent = (e.clientX - rect.left) / rect.width;
              const duration = wavesurferRef.current.getDuration();
              wavesurferRef.current.seekTo(percent);
              setCurrentTime(percent * duration);
            }
          }}
        >
          <div
            ref={waveformContainerRef}
            id="waveform"
            style={{
              position: 'absolute',
              inset: 0,
            }}
          />
          <div className="remove-indicator start" style={{ width: `${topStartPercent}%` }} />
          <div className="remove-indicator end" style={{ width: `${topEndPercent}%` }} />
          <div id="clip-indicators">
            {clips.map((clip, index) => {
              if (effectiveDuration <= 0 || clip.end <= clip.start) {
                return null;
              }
              const left = (clip.start / effectiveDuration) * 100;
              const width = ((clip.end - clip.start) / effectiveDuration) * 100;
              return (
                <div
                  key={`overlay-${index}`}
                  className="remove-indicator clip"
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="time-inputs flex" style={{ gap: '2rem', marginBottom: '1rem', width: '100%' }}>
        <div className="flex">
          <label htmlFor="start_time">Start Time (s):</label>
          <input id="start_time" type="text" value={startTimeText} onChange={(e) => setStartTimeText(e.target.value)} />
          <button type="button" className="btn set-start-time" onClick={setStartToCurrent}>Set</button>
          <button type="button" className="btn jump-to-start-time" onClick={() => jumpToTime(startTime)}>Jump</button>
        </div>
        <div className="flex">
          <label htmlFor="end_time">End Time (s):</label>
          <input id="end_time" type="text" value={endTimeText} onChange={(e) => setEndTimeText(e.target.value)} />
          <button type="button" className="btn set-end-time" onClick={setEndToCurrent}>Set</button>
          <button type="button" className="btn jump-to-end-time" onClick={() => jumpToTime(endTime)}>Jump</button>
        </div>
      </div>

      <div id="clips" className="grid" style={{ width: '100%', marginBottom: '1rem' }}>
        <label>Clips to Cut:</label>
        {clips.length === 0 ? (
          <div className="clip" />
        ) : (
          clips.map((clip, idx) => (
            <div key={`clip-${idx}`} className="clip flex centered" style={{ flexWrap: 'wrap' }}>
              <input
                type="text"
                name="clip_start[]"
                value={clip.start.toFixed(3)}
                placeholder="Start Time"
                onChange={(e) => updateClipField(idx, 'start', e.target.value)}
              />
              <button type="button" className="btn set-clip-start" onClick={() => setClipStartToCurrent(idx)}>Set</button>
              <button type="button" className="btn jump-to-clip-start" onClick={() => jumpToClipTime(idx, 'start')}>Jump</button>
              <input
                type="text"
                name="clip_end[]"
                value={clip.end.toFixed(3)}
                placeholder="End Time"
                onChange={(e) => updateClipField(idx, 'end', e.target.value)}
              />
              <button type="button" className="btn set-clip-end" onClick={() => setClipEndToCurrent(idx)}>Set</button>
              <button type="button" className="btn jump-to-clip-end" onClick={() => jumpToClipTime(idx, 'end')}>Jump</button>
              <button type="button" className="btn remove-clip" aria-label="Remove clip" onClick={() => removeClip(idx)}>
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <button type="button" className="btn add-clip" onClick={addClip} style={{ marginBottom: '1rem' }}>
        Add Another Clip
      </button>

      <div className="flex centered" style={{ width: '100%', marginBottom: '1rem' }}>
        <label htmlFor="image">Upload Cover Image:</label>
        <input
          type="file"
          id="image"
          name="image"
          accept="image/*"
          onChange={(e) => {
            const next = e.target.files?.[0] ?? null;
            setCoverImageFile(next);
            setCoverImageAssetId(null);
          }}
        />
        {coverImageUploading ? <span>Uploading cover...</span> : null}
      </div>

      <div className="hardware-selection">
        <label htmlFor="hardware_select">Hardware Acceleration</label>
        <div className="hardware-select-wrap">
          <select
            id="hardware_select"
            name="hardware_choice"
            value={hardware}
            onChange={(e) => setHardware(e.target.value as HardwareOption)}
            aria-describedby="hardware-help"
          >
            <option value="auto">Auto (Detect)</option>
            <option value="cpu">CPU</option>
            <option value="intel" disabled={!availableHardware.has('intel')}>Intel Quick Sync (QSV)</option>
            <option value="cuda" disabled={!availableHardware.has('cuda')}>NVIDIA CUDA (NVENC)</option>
            <option value="apple" disabled={!availableHardware.has('apple')}>Apple VideoToolbox</option>
            <option value="vaapi" disabled={!availableHardware.has('vaapi')}>VAAPI</option>
          </select>
          <small id="hardware-help">Choose an encoder. Non-available options are disabled.</small>
        </div>
        <div className="hardware-right">
          <span id="hardware-indicator" aria-live="polite">Detected: {detectedHardware}</span>
        </div>
      </div>

      {validationErrors.length > 0 ? (
        <div style={{ width: '100%', marginTop: '1rem', color: '#b91c1c' }}>
          {validationErrors.map((issue) => (
            <p key={issue} style={{ margin: '0.25rem 0' }}>{issue}</p>
          ))}
        </div>
      ) : null}

      {error ? <p style={{ color: 'red', marginBottom: '1rem' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', width: '100%' }}>
        <button type="button" className="btn" onClick={handleProcess} disabled={submittingJob || coverImageUploading} style={{ flex: 1 }}>
          {submittingJob ? 'Submitting Job...' : 'Process Video'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={submittingJob} style={{ flex: 1, background: '#6b7280' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
