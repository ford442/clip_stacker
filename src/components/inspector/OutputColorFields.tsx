import { useEffect, useState } from 'react';
import { parseOutputResolution } from '../../utils/resolution';
import {
  probeOutputColorSupport,
  resolveEncoderBitrate,
} from '../../utils/webcodecs-codec';
import {
  type ColorManagementSettings,
  type OutputColor,
  type WorkingSpace,
} from '../../utils/colorManagement';
import type { ExportSettings } from '../../types';

interface OutputColorFieldsProps {
  colorManagement: ColorManagementSettings;
  exportSettings: ExportSettings;
  onChange: (settings: ColorManagementSettings) => void;
}

interface ProbeState {
  displayP3: { supported: boolean; reason: string };
  hdr10: { supported: boolean; reason: string };
}

const SUPPORTED: ProbeState = {
  displayP3: { supported: true, reason: '' },
  hdr10: { supported: true, reason: '' },
};

export function OutputColorFields({
  colorManagement,
  exportSettings,
  onChange,
}: OutputColorFieldsProps) {
  const [probe, setProbe] = useState<ProbeState>(SUPPORTED);

  useEffect(() => {
    let cancelled = false;
    const { width, height } = parseOutputResolution(exportSettings.outputResolution);
    const bitrate = resolveEncoderBitrate(exportSettings, width, height);
    void (async () => {
      const [displayP3, hdr10] = await Promise.all([
        probeOutputColorSupport('display-p3', width, height, bitrate, exportSettings.videoCodec),
        probeOutputColorSupport('hdr10', width, height, bitrate, exportSettings.videoCodec),
      ]);
      if (!cancelled) setProbe({ displayP3, hdr10 });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    exportSettings.outputResolution,
    exportSettings.videoBitrate,
    exportSettings.crf,
    exportSettings.videoCodec,
  ]);

  const p3Reason = probe.displayP3.supported ? '' : probe.displayP3.reason;
  const hdrReason = probe.hdr10.supported ? '' : probe.hdr10.reason;
  const selectedReason =
    colorManagement.outputColor === 'display-p3'
      ? p3Reason
      : colorManagement.outputColor === 'hdr10'
        ? hdrReason
        : '';

  return (
    <>
      <div className="inspector-group-label">Output color</div>
      <label title="Swapchain and encoder tags. Rec.709 SDR is the default and matches the existing grade.">
        Output color
        <select
          value={colorManagement.outputColor}
          onChange={(e) =>
            onChange({ ...colorManagement, outputColor: e.target.value as OutputColor })
          }
        >
          <option value="rec709-sdr">Rec.709 SDR</option>
          <option value="display-p3" disabled={!probe.displayP3.supported}>
            Display P3
          </option>
          <option value="hdr10" disabled={!probe.hdr10.supported}>
            HDR10 (PQ Rec.2020)
          </option>
        </select>
      </label>
      <p className="inspector-hint">
        {selectedReason ||
          'A P3 display stays Rec.709 until you choose Display P3 or HDR10. Those exports are GPU-only.'}
      </p>
      <details>
        <summary>Working space</summary>
        <label title="Scene-linear Rec.2020 grades exposure and lift/gamma/gain in linear light. Rec.709 keeps the current display-referred chain.">
          Working space
          <select
            value={colorManagement.workingSpace}
            onChange={(e) =>
              onChange({ ...colorManagement, workingSpace: e.target.value as WorkingSpace })
            }
          >
            <option value="rec709">Rec.709 (current)</option>
            <option value="rec2020-linear">Scene-linear Rec.2020</option>
          </select>
        </label>
        <p className="inspector-hint">
          Scene-linear Rec.2020 is the grade space for Display P3 and HDR10. Grain stays
          on the output encoding, after the output transform.
        </p>
      </details>
    </>
  );
}
