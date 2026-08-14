import { describe, it, expect } from "vitest";
import type { ClipGroup, ClipTransition, TextOverlay } from "../types";
import { serializeProject } from "./project";
import { createTestClip } from "./project.test.helpers";

describe("utils/project - serializeProject", () => {
  it("should serialize clips without optional fields", () => {
    const clips = [createTestClip("clip1", 5)];
    const project = serializeProject(clips, [], [], []);
    expect(project.clips).toHaveLength(1);
    expect(project.clips[0]).toEqual({
      id: "clip1",
      title: "clip1",
      kind: "video",
      duration: 5,
      trimStart: 0,
      trimEnd: null,
      videoFadeIn: 0,
      videoFadeOut: 0,
      audioFadeIn: 0,
      audioFadeOut: 0,
      fileName: "clip1.mp4",
    });
  });

  it("should serialize clips with group info", () => {
    const clips = [createTestClip("clip1", 5, "clip1", "group1", "A")];
    const project = serializeProject(clips, [], [], []);
    expect(project.clips[0].groupId).toBe("group1");
    expect(project.clips[0].groupVariant).toBe("A");
  });

  it("should serialize non-default clip volume", () => {
    const clips = [createTestClip("clip1", 5)];
    clips[0].volume = 0.75;
    const project = serializeProject(clips, [], [], []);
    expect(project.clips[0].volume).toBe(0.75);
  });

  it("should serialize non-default playbackRate", () => {
    const clips = [createTestClip("clip1", 5)];
    clips[0].playbackRate = 2;
    const project = serializeProject(clips, [], [], []);
    expect(project.clips[0].playbackRate).toBe(2);
  });

  it("should omit default playbackRate from serialization", () => {
    const clips = [createTestClip("clip1", 5)];
    clips[0].playbackRate = 1;
    const project = serializeProject(clips, [], [], []);
    expect(project.clips[0].playbackRate).toBeUndefined();
  });

  it("should serialize transitions", () => {
    const clips = [createTestClip("a", 5), createTestClip("b", 3)];
    const transitions: ClipTransition[] = [
      { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
    ];
    const project = serializeProject(clips, transitions, [], []);
    expect(project.transitions).toHaveLength(1);
    expect(project.transitions![0]).toEqual({
      afterClipIndex: 1,
      type: "dissolve",
      duration: 0.5,
    });
  });

  it("should serialize text overlays", () => {
    const clips = [createTestClip("clip1", 5)];
    const textOverlays: TextOverlay[] = [
      {
        id: "text1",
        text: "Hello",
        fontsize: 40,
        fontcolor: "#ffffff",
        x: 50,
        y: 650,
        scrolling: false,
        scrollSpeed: 100,
        box: false,
        boxColor: "black@0.5",
      },
    ];
    const project = serializeProject(clips, [], textOverlays, []);
    expect(project.textOverlays).toBeDefined();
    expect(project.textOverlays).toHaveLength(1);
  });

  it("should round-trip an explicit font id through serialize", () => {
    const clips = [createTestClip("clip1", 5)];
    const textOverlays: TextOverlay[] = [
      {
        id: "text1",
        text: "Ticker",
        fontsize: 28,
        fontcolor: "white",
        x: 0,
        y: 0,
        scrolling: true,
        scrollSpeed: 30,
        box: false,
        boxColor: "black@0.5",
        font: "mono",
      },
    ];
    const project = serializeProject(clips, [], textOverlays, []);
    expect(project.textOverlays?.[0]?.font).toBe("mono");
  });

  it("should serialize clip groups", () => {
    const clips = [createTestClip("a", 5)];
    const clipGroups: ClipGroup[] = [
      {
        id: "group1",
        variants: { A: clips[0], B: null },
        activeVariant: "A",
      },
    ];
    const project = serializeProject(clips, [], [], clipGroups);
    expect(project.clipGroups).toBeDefined();
    expect(project.clipGroups).toHaveLength(1);
    expect(project.clipGroups![0].id).toBe("group1");
    expect(project.clipGroups![0].activeVariant).toBe("A");
  });

  it("should serialize PiP properties as normalized coordinates", () => {
    const clip = createTestClip("clip1", 5);
    clip.layerIndex = 1;
    clip.x = 100 / 1280;
    clip.y = 200 / 720;
    clip.width = 300 / 1280;
    clip.height = 400 / 720;
    clip.opacity = 0.8;
    const project = serializeProject([clip], [], [], []);
    expect(project.schemaVersion).toBe(2);
    expect(project.clips[0].layerIndex).toBe(1);
    expect(project.clips[0].x).toBeCloseTo(100 / 1280);
    expect(project.clips[0].y).toBeCloseTo(200 / 720);
    expect(project.clips[0].width).toBeCloseTo(300 / 1280);
    expect(project.clips[0].height).toBeCloseTo(400 / 720);
    expect(project.clips[0].opacity).toBe(0.8);
  });

  it("should serialize keyframes and stillImage flag", () => {
    const clip = createTestClip("clip1", 5);
    clip.stillImage = true;
    clip.keyframes = {
      uvScaleX: [
        { t: 0, value: 1, easing: { type: "linear" } },
        { t: 5, value: 0.86 },
      ],
      opacity: [{ t: 0, value: 1 }],
    };
    const project = serializeProject([clip], [], [], []);
    expect(project.clips[0].stillImage).toBe(true);
    expect(project.clips[0].keyframes?.uvScaleX).toHaveLength(2);
    expect(project.clips[0].keyframes?.opacity).toHaveLength(1);
  });

  it("should serialize volume and pan automation lanes", () => {
    const clip = createTestClip("clip1", 5);
    clip.volume = 0.9;
    clip.automation = {
      volume: [
        { t: 0, value: 1 },
        { t: 2, value: 0.2 },
        { t: 4, value: 1.5 },
      ],
      pan: [
        { t: 0, value: -1 },
        { t: 5, value: 1 },
      ],
    };
    const project = serializeProject([clip], [], [], []);
    expect(project.clips[0].automation?.volume).toHaveLength(3);
    expect(project.clips[0].automation?.pan?.[0].value).toBe(-1);
    expect(project.clips[0].volume).toBe(0.9);
  });

  it("should omit empty automation from serialization", () => {
    const clip = createTestClip("clip1", 5);
    clip.automation = { volume: [], pan: [] };
    const project = serializeProject([clip], [], [], []);
    expect(project.clips[0].automation).toBeUndefined();
  });

  it("should serialize hasAudio when known", () => {
    const silent = createTestClip("clip1", 5);
    silent.hasAudio = false;
    expect(serializeProject([silent], [], [], []).clips[0].hasAudio).toBe(false);

    const withAudio = createTestClip("clip2", 5);
    withAudio.hasAudio = true;
    expect(serializeProject([withAudio], [], [], []).clips[0].hasAudio).toBe(true);

    const unknown = createTestClip("clip3", 5);
    expect(serializeProject([unknown], [], [], []).clips[0].hasAudio).toBeUndefined();
  });

  it("should serialize beatTimestamps and bpmEstimate", () => {
    const clip = createTestClip("clip1", 5);
    clip.beatTimestamps = [0.5, 1.0, 1.5];
    clip.bpmEstimate = 120;
    const project = serializeProject([clip], [], [], []);
    expect(project.clips[0].beatTimestamps).toEqual([0.5, 1.0, 1.5]);
    expect(project.clips[0].bpmEstimate).toBe(120);
  });

  it("should serialize finishing settings", () => {
    const project = serializeProject([], [], [], [], {
      lut: { enabled: true, lutId: "film", intensity: 0.75 },
    });
    expect(project.finishing?.lut?.lutId).toBe("film");
    expect(project.finishing?.lut?.intensity).toBe(0.75);
  });

  it("should serialize secondary color finishing settings", () => {
    const project = serializeProject([], [], [], [], {
      secondaryColor: {
        enabled: true,
        amount: 0.9,
        grades: [
          {
            enabled: true,
            maskType: "hue+window",
            hueCenter: 205,
            hueWidth: 55,
            hueSoftness: 14,
            windowCenterX: 0.48,
            windowCenterY: 0.4,
            windowWidth: 0.55,
            windowHeight: 0.45,
            windowRotation: 10,
            windowFeather: 0.22,
            hueShift: -8,
            satScale: 0.75,
            lumOffset: 0.03,
            satOffset: -0.05,
            invertMask: false,
          },
        ],
      },
    });
    expect(project.finishing?.secondaryColor?.enabled).toBe(true);
    expect(project.finishing?.secondaryColor?.grades).toHaveLength(1);
    expect(project.finishing?.secondaryColor?.grades?.[0].maskType).toBe(
      "hue+window",
    );
    expect(project.finishing?.secondaryColor?.grades?.[0].hueCenter).toBe(205);
    expect(project.finishing?.secondaryColor?.grades?.[0].satScale).toBe(0.75);
  });

  it("should serialize primary color finishing settings", () => {
    const project = serializeProject([], [], [], [], {
      primaryColor: {
        enabled: true,
        amount: 1,
        exposure: 0.75,
        contrast: 1.1,
        saturation: 0.95,
        temperature: -0.2,
        tint: 0.1,
        lift: [0.02, 0, -0.01],
        gamma: [1, 1.05, 1],
        gain: [1.05, 1, 0.98],
      },
    });
    expect(project.finishing?.primaryColor?.enabled).toBe(true);
    expect(project.finishing?.primaryColor?.exposure).toBe(0.75);
    expect(project.finishing?.primaryColor?.lift).toEqual([0.02, 0, -0.01]);
    expect(project.finishing?.primaryColor?.gain?.[0]).toBe(1.05);
  });

  it("should serialize noise reduction finishing settings", () => {
    const project = serializeProject([], [], [], [], {
      noiseReduction: {
        enabled: true,
        amount: 1,
        spatialStrength: 0.55,
        spatialRadius: 3,
        temporal: true,
        temporalStrength: 0.3,
        temporalMotionThreshold: 0.1,
        lumaOnly: true,
        draft: false,
      },
    });
    expect(project.finishing?.noiseReduction?.enabled).toBe(true);
    expect(project.finishing?.noiseReduction?.spatialStrength).toBe(0.55);
    expect(project.finishing?.noiseReduction?.temporal).toBe(true);
    expect(project.finishing?.noiseReduction?.temporalStrength).toBe(0.3);
  });
});
