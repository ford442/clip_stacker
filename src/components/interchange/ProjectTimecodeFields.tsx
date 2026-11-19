import { useState } from 'react';
import { useStore } from 'zustand';
import type { TimecodeRateId } from '../../types';
import { settingsStore } from '../../store/settingsStore';
import { TIMECODE_RATES, normalizeTimecode, timecodeRate } from '../../interchange/timecode';

/**
 * The project's timecode start and rate (Inspector → Export → Project, and
 * the Export stems dialog): where frame 0 sits in EDL / OTIO / FCPXML record
 * timecode and in a stem's BWF `TimeReference`. Project settings, not undoable.
 */
export function ProjectTimecodeFields() {
  const timecode = useStore(settingsStore, (s) => s.timecode);
  const [draft, setDraft] = useState(timecode.start);
  const [seen, setSeen] = useState(timecode.start);
  // Follow the store when the project changes underneath (a load, an import).
  if (seen !== timecode.start) {
    setSeen(timecode.start);
    setDraft(timecode.start);
  }
  const rate = timecodeRate(timecode.rate);
  const parsed = normalizeTimecode(draft, rate);
  const commit = () => {
    if (parsed && parsed !== timecode.start) settingsStore.getState().setTimecode({ ...timecode, start: parsed });
    else setDraft(timecode.start);
  };
  return (
    <>
      <label title="Timecode of the timeline's first frame: EDL / OTIO / FCPXML record timecode and the stems' BWF TimeReference start here.">
        Timecode start
        <input
          type="text"
          value={draft}
          spellCheck={false}
          aria-invalid={parsed === null}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </label>
      <label title="Frame rate timeline files count frames in (the export grid is 30).">
        Timecode rate
        <select
          value={timecode.rate}
          onChange={(e) => {
            const next = e.target.value as TimecodeRateId;
            const start = normalizeTimecode(timecode.start, timecodeRate(next)) ?? timecode.start;
            settingsStore.getState().setTimecode({ start, rate: next });
          }}
        >
          {TIMECODE_RATES.map((id) => (
            <option key={id} value={id}>
              {timecodeRate(id).label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
