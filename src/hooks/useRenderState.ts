import { useState } from "react";
import type { ExportSettings, RenderPlan } from "../types";
import { DEFAULT_EXPORT_SETTINGS } from "../types";

export function useRenderState() {
  const [exportSettings, setExportSettings] = useState<ExportSettings>(
    DEFAULT_EXPORT_SETTINGS,
  );
  const [forceFFmpeg, setForceFFmpeg] = useState(false);
  const [useCanvasRenderer, setUseCanvasRenderer] = useState(false);
  const [audioReactive, setAudioReactive] = useState(true);
  const [forceReencode, setForceReencode] = useState(false);

  const [status, setStatus] = useState("");
  const [progressStage, setProgressStage] = useState("");
  const [progressValue, setProgressValue] = useState<number | null>(null);
  const [progressIndeterminate, setProgressIndeterminate] = useState(false);

  const [isRendering, setIsRendering] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [ffmpegFailed, setFfmpegFailed] = useState(false);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [encoderPath, setEncoderPath] = useState<string>("");
  const [renderPlan, setRenderPlan] = useState<RenderPlan | null>(null);
  const [rifeProcessingClipId, setRifeProcessingClipId] = useState<
    string | null
  >(null);

  return {
    exportSettings,
    setExportSettings,
    forceFFmpeg,
    setForceFFmpeg,
    useCanvasRenderer,
    setUseCanvasRenderer,
    audioReactive,
    setAudioReactive,
    forceReencode,
    setForceReencode,
    status,
    setStatus,
    progressStage,
    setProgressStage,
    progressValue,
    setProgressValue,
    progressIndeterminate,
    setProgressIndeterminate,
    isRendering,
    setIsRendering,
    ffmpegLoading,
    setFfmpegLoading,
    ffmpegFailed,
    setFfmpegFailed,
    outputUrl,
    setOutputUrl,
    encoderPath,
    setEncoderPath,
    renderPlan,
    setRenderPlan,
    rifeProcessingClipId,
    setRifeProcessingClipId,
  };
}
