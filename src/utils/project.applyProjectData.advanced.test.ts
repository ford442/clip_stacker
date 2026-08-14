import { describe, it, expect } from "vitest";
import type { Project } from "../types";
import { applyProjectData, getClipDuration, serializeProject } from "./project";
import { createTestClip } from "./project.test.helpers";

describe("utils/project - applyProjectData (advanced)", () => {
  it("should restore keyframes and stillImage from saved project", async () => {
    const sourceClips = [createTestClip("source1", 5, "photo.jpg")];
    sourceClips[0].file = new File([], "photo.jpg", { type: "image/jpeg" });

    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Photo",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "photo.jpg",
          stillImage: true,
          keyframes: {
            x: [
              { t: 0, value: 10 },
              { t: 2, value: 50 },
            ],
          },
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips[0].stillImage).toBe(true);
    expect(result.clips[0].keyframes?.x).toHaveLength(2);
  });

  it("should restore hasAudio from saved project", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: sourceClips[0].file.name,
          hasAudio: false,
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips[0].hasAudio).toBe(false);
  });

  it("should restore playbackRate from saved project", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: sourceClips[0].file.name,
          playbackRate: 2,
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips[0].playbackRate).toBe(2);
    expect(getClipDuration(result.clips[0])).toBe(2.5);
  });

  it("should restore automation lanes from saved project", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: sourceClips[0].file.name,
          volume: 0.75,
          automation: {
            volume: [
              { t: 0, value: 1 },
              { t: 1, value: 0.2 },
            ],
            pan: [{ t: 0, value: 0.5 }],
          },
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips[0].volume).toBe(0.75);
    expect(result.clips[0].automation?.volume).toEqual([
      { t: 0, value: 1 },
      { t: 1, value: 0.2 },
    ]);
    expect(result.clips[0].automation?.pan?.[0].value).toBe(0.5);
  });

  it("should clamp out-of-range automation values on load", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: sourceClips[0].file.name,
          automation: {
            volume: [{ t: 0, value: 9 }],
            pan: [{ t: 0, value: -3 }],
          },
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips[0].automation?.volume?.[0].value).toBe(2);
    expect(result.clips[0].automation?.pan?.[0].value).toBe(-1);
  });

  it("should restore color grade from saved project", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source1.mp4",
        },
      ],
      colorGrade: {
        lutId: "teal-orange",
        intensity: 0.6,
      },
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.finishing.lut?.lutId).toBe("teal-orange");
    expect(result.finishing.lut?.intensity).toBe(0.6);
    expect(result.colorGrade.lutId).toBe("teal-orange");
  });

  it("should roundtrip finishing settings", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const finishing = {
      lut: { enabled: true, lutId: "film", intensity: 0.55 },
      sharpen: {
        enabled: true,
        amount: 0.3,
        radius: 1.5,
        threshold: 0.04,
        midtoneDetail: 0.2,
      },
      grain: {
        enabled: true,
        amount: 0.4,
        size: 0.55,
        softness: 0.6,
        monochrome: true,
        bloomAmount: 0.08,
        vignette: {
          enabled: true,
          amount: 0.25,
          midpoint: 0.5,
          roundness: 0.3,
        },
        halation: {
          enabled: false,
          threshold: 0.7,
          amount: 0.2,
          radius: 8,
        },
      },
    };
    const serialized = serializeProject(sourceClips, [], [], [], finishing);
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source1.mp4",
        },
      ],
      finishing: serialized.finishing,
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.finishing.lut?.lutId).toBe("film");
    expect(result.finishing.lut?.intensity).toBe(0.55);
    expect(result.finishing.sharpen?.enabled).toBe(true);
    expect(result.finishing.sharpen?.amount).toBe(0.3);
    expect(result.finishing.sharpen?.radius).toBe(1.5);
    expect(result.finishing.sharpen?.threshold).toBe(0.04);
    expect(result.finishing.sharpen?.midtoneDetail).toBe(0.2);
    expect(result.finishing.grain?.enabled).toBe(true);
    expect(result.finishing.grain?.amount).toBe(0.4);
    expect(result.finishing.grain?.size).toBe(0.55);
    expect(result.finishing.grain?.softness).toBe(0.6);
    expect(result.finishing.grain?.monochrome).toBe(true);
    expect(result.finishing.grain?.vignette.enabled).toBe(true);
    expect(result.finishing.grain?.vignette.amount).toBe(0.25);
    expect(result.finishing.grain?.halation.enabled).toBe(false);
  });

  it("should roundtrip primary color finishing settings", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const finishing = {
      primaryColor: {
        enabled: true,
        amount: 0.9,
        exposure: -0.4,
        contrast: 1.2,
        saturation: 1.05,
        temperature: 0.35,
        tint: -0.15,
        lift: [0.01, -0.02, 0] as [number, number, number],
        gamma: [0.95, 1, 1.05] as [number, number, number],
        gain: [1.1, 1, 0.9] as [number, number, number],
      },
    };
    const serialized = serializeProject(sourceClips, [], [], [], finishing);
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source1.mp4",
        },
      ],
      finishing: serialized.finishing,
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.finishing.primaryColor?.enabled).toBe(true);
    expect(result.finishing.primaryColor?.exposure).toBe(-0.4);
    expect(result.finishing.primaryColor?.temperature).toBe(0.35);
    expect(result.finishing.primaryColor?.lift).toEqual([0.01, -0.02, 0]);
    expect(result.finishing.primaryColor?.gamma?.[2]).toBe(1.05);
    expect(result.finishing.primaryColor?.gain?.[0]).toBe(1.1);
  });

  it("should roundtrip secondary color finishing settings", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const finishing = {
      secondaryColor: {
        enabled: true,
        amount: 0.85,
        grades: [
          {
            enabled: true,
            maskType: "hue" as const,
            hueCenter: 210,
            hueWidth: 65,
            hueSoftness: 16,
            windowCenterX: 0.5,
            windowCenterY: 0.5,
            windowWidth: 0.5,
            windowHeight: 0.5,
            windowRotation: 0,
            windowFeather: 0.15,
            hueShift: 12,
            satScale: 0.6,
            lumOffset: -0.02,
            satOffset: 0.05,
            invertMask: false,
          },
          {
            enabled: true,
            maskType: "window" as const,
            hueCenter: 0,
            hueWidth: 60,
            hueSoftness: 15,
            windowCenterX: 0.3,
            windowCenterY: 0.7,
            windowWidth: 0.4,
            windowHeight: 0.35,
            windowRotation: -20,
            windowFeather: 0.25,
            hueShift: 0,
            satScale: 1,
            lumOffset: 0.08,
            satOffset: 0,
            invertMask: true,
          },
        ],
      },
    };
    const serialized = serializeProject(sourceClips, [], [], [], finishing);
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source1.mp4",
        },
      ],
      finishing: serialized.finishing,
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.finishing.secondaryColor?.enabled).toBe(true);
    expect(result.finishing.secondaryColor?.amount).toBe(0.85);
    expect(result.finishing.secondaryColor?.grades).toHaveLength(2);
    expect(result.finishing.secondaryColor?.grades?.[0].maskType).toBe("hue");
    expect(result.finishing.secondaryColor?.grades?.[0].satScale).toBe(0.6);
    expect(result.finishing.secondaryColor?.grades?.[1].maskType).toBe("window");
    expect(result.finishing.secondaryColor?.grades?.[1].invertMask).toBe(true);
    expect(result.finishing.secondaryColor?.grades?.[1].windowRotation).toBe(-20);
  });

  it("should fail-safe unknown secondary mask types on load", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source1.mp4",
        },
      ],
      finishing: {
        secondaryColor: {
          enabled: true,
          amount: 1,
          grades: [
            {
              enabled: true,
              maskType: "tracker" as never,
              hueCenter: 100,
              hueWidth: 40,
              hueSoftness: 10,
              windowCenterX: 0.5,
              windowCenterY: 0.5,
              windowWidth: 0.5,
              windowHeight: 0.5,
              windowRotation: 0,
              windowFeather: 0.1,
              hueShift: 0,
              satScale: 0.5,
              lumOffset: 0,
              satOffset: 0,
            },
          ],
        },
      },
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.finishing.secondaryColor?.grades?.[0].maskType).toBe("hue");
  });

  it("should roundtrip noise reduction finishing settings", async () => {
    const sourceClips = [createTestClip("source1", 5)];
    const finishing = {
      noiseReduction: {
        enabled: true,
        amount: 0.85,
        spatialStrength: 0.6,
        spatialRadius: 2.5,
        temporal: true,
        temporalStrength: 0.28,
        temporalMotionThreshold: 0.12,
        lumaOnly: true,
        draft: false,
      },
    };
    const serialized = serializeProject(sourceClips, [], [], [], finishing);
    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Clip",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source1.mp4",
        },
      ],
      finishing: serialized.finishing,
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.finishing.noiseReduction?.enabled).toBe(true);
    expect(result.finishing.noiseReduction?.spatialStrength).toBe(0.6);
    expect(result.finishing.noiseReduction?.spatialRadius).toBe(2.5);
    expect(result.finishing.noiseReduction?.temporal).toBe(true);
    expect(result.finishing.noiseReduction?.temporalStrength).toBe(0.28);
    expect(result.finishing.noiseReduction?.lumaOnly).toBe(true);
  });
});
