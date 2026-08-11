import { useCallback, useEffect, useRef, useState } from 'react';
import type { MasterAudio } from '../types';
import { editorActions } from '../store';
import { WaveformCanvas } from './WaveformCanvas';
import { extractWaveformPeaks } from '../utils/waveform';
import { getMediaInfo } from '../utils/media';

interface Props {
  masterAudio: MasterAudio | null;
  totalDuration: number;
  pixelsPerSecond: number;
  contentWidth: number;
}

export function MasterAudioTrack({
  masterAudio,
  totalDuration,
  pixelsPerSecond,
  contentWidth,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!masterAudio) {
      setPeaks(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    extractWaveformPeaks(masterAudio.objectUrl, 240)
      .then((data) => {
        if (!cancelled) setPeaks(data);
      })
      .catch(() => {
        if (!cancelled) setPeaks(new Float32Array(0));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [masterAudio?.objectUrl]);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) {
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const info = await getMediaInfo(file);
      editorActions.pushHistory();
      editorActions.setMasterAudio({
        file,
        objectUrl,
        fileName: file.name,
        duration: info.duration,
        startTime: 0,
      });
    } catch {
      URL.revokeObjectURL(objectUrl);
    }
  }, []);

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void handleFile(file);
      event.target.value = '';
    },
    [handleFile],
  );

  const handleRemove = useCallback(() => {
    editorActions.pushHistory();
    editorActions.setMasterAudio((prev) => {
      if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
  }, []);

  const trackWidth = Math.max(contentWidth, (masterAudio?.duration ?? 0) * pixelsPerSecond);
  const displayPeaks = peaks ?? new Float32Array(0);

  return (
    <div className="timeline-track-row timeline-track-row--master-audio" data-track-id="master-audio">
      <div className="timeline-track-label" title="External music reference for lip-sync timing">
        Master
      </div>
      <div className="timeline-track timeline-track--master-audio" style={{ width: contentWidth }}>
        <div className="master-audio-track-inner" style={{ width: trackWidth }}>
          {masterAudio ? (
            <div
              className="master-audio-block"
              style={{
                left: masterAudio.startTime * pixelsPerSecond,
                width: masterAudio.duration * pixelsPerSecond,
              }}
            >
              <div className={`master-audio-waveform${loading ? ' is-loading' : ''}`}>
                <WaveformCanvas peaks={displayPeaks} height={48} />
              </div>
              <div className="master-audio-footer">
                <span className="master-audio-label" title={masterAudio.fileName}>
                  ♫ {masterAudio.fileName}
                </span>
                <span className="master-audio-dur">{masterAudio.duration.toFixed(1)}s</span>
                <button
                  type="button"
                  className="master-audio-remove"
                  onClick={handleRemove}
                  title="Remove master audio"
                  aria-label="Remove master audio"
                >
                  ×
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="master-audio-add"
              onClick={() => fileInputRef.current?.click()}
              title="Load external MP3/WAV for lip-sync reference"
            >
              + Load master audio (MP3)
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
          className="sr-only"
          onChange={handleInputChange}
        />
      </div>
      {totalDuration > 0 && !masterAudio && (
        <span className="master-audio-hint muted">Visual sync anchor — not mixed in browser playback</span>
      )}
    </div>
  );
}
