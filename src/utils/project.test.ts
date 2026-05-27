import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Clip, ClipGroup, ClipTransition, Project, TextOverlay } from '../types';
import {
  getClipDuration,
  sanitizeClipAdjustments,
  serializeProject,
  applyProjectData,
} from './project';

// Helper to create a minimal test clip
function createTestClip(
  id: string,
  duration: number,
  title = id,
  groupId?: string,
  groupVariant?: 'A' | 'B',
): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title,
    kind: 'video',
    duration,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    groupId,
    groupVariant,
  };
}

describe('utils/project', () => {
  // =========================================================================
  // getClipDuration
  // =========================================================================
  describe('getClipDuration', () => {
    it('should return duration - trimStart when trimEnd is not set', () => {
      const clip = createTestClip('test', 10);
      clip.trimStart = 2;
      const duration = getClipDuration(clip);
      expect(duration).toBe(8); // 10 - 2
    });

    it('should return trimEnd - trimStart when both are set', () => {
      const clip = createTestClip('test', 10);
      clip.trimStart = 1;
      clip.trimEnd = 6;
      const duration = getClipDuration(clip);
      expect(duration).toBe(5); // 6 - 1
    });

    it('should enforce MIN_CLIP_DURATION', () => {
      const clip = createTestClip('test', 10);
      clip.trimStart = 5;
      clip.trimEnd = 5.05; // Very short
      const duration = getClipDuration(clip);
      expect(duration).toBe(0.1); // MIN_CLIP_DURATION
    });
  });

  // =========================================================================
  // sanitizeClipAdjustments
  // =========================================================================
  describe('sanitizeClipAdjustments', () => {
    it('should clamp trimStart to 0', () => {
      const clip = createTestClip('test', 10);
      clip.trimStart = -5;
      sanitizeClipAdjustments(clip);
      expect(clip.trimStart).toBe(0);
    });

    it('should ensure trimEnd >= trimStart + MIN_CLIP_DURATION', () => {
      const clip = createTestClip('test', 10);
      clip.trimStart = 5;
      clip.trimEnd = 5; // Violates minimum
      sanitizeClipAdjustments(clip);
      expect(clip.trimEnd).toBe(5.1); // trimStart + MIN_CLIP_DURATION
    });

    it('should clamp fades to valid range', () => {
      const clip = createTestClip('test', 1);
      clip.videoFadeIn = 10; // Too large
      clip.videoFadeOut = -5; // Negative
      sanitizeClipAdjustments(clip);
      expect(clip.videoFadeIn).toBeLessThanOrEqual(0.49); // Safe margin
      expect(clip.videoFadeOut).toBe(0);
    });
  });

  // =========================================================================
  // serializeProject
  // =========================================================================
  describe('serializeProject', () => {
    it('should serialize clips without optional fields', () => {
      const clips = [createTestClip('clip1', 5)];
      const project = serializeProject(clips, [], [], []);
      expect(project.clips).toHaveLength(1);
      expect(project.clips[0]).toEqual({
        id: 'clip1',
        title: 'clip1',
        kind: 'video',
        duration: 5,
        trimStart: 0,
        trimEnd: null,
        videoFadeIn: 0,
        videoFadeOut: 0,
        audioFadeIn: 0,
        audioFadeOut: 0,
        fileName: 'clip1.mp4',
      });
    });

    it('should serialize clips with group info', () => {
      const clips = [createTestClip('clip1', 5, 'clip1', 'group1', 'A')];
      const project = serializeProject(clips, [], [], []);
      expect(project.clips[0].groupId).toBe('group1');
      expect(project.clips[0].groupVariant).toBe('A');
    });

    it('should serialize transitions', () => {
      const clips = [createTestClip('a', 5), createTestClip('b', 3)];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
      ];
      const project = serializeProject(clips, transitions, [], []);
      expect(project.transitions).toHaveLength(1);
      expect(project.transitions[0]).toEqual({
        afterClipIndex: 1,
        type: 'dissolve',
        duration: 0.5,
      });
    });

    it('should serialize text overlays', () => {
      const clips = [createTestClip('clip1', 5)];
      const textOverlays: TextOverlay[] = [
        {
          id: 'text1',
          text: 'Hello',
          fontsize: 40,
          fontcolor: '#ffffff',
          x: 50,
          y: 650,
          scrolling: false,
          scrollSpeed: 100,
          box: false,
          boxColor: 'black@0.5',
        },
      ];
      const project = serializeProject(clips, [], textOverlays, []);
      expect(project.textOverlays).toBeDefined();
      expect(project.textOverlays).toHaveLength(1);
    });

    it('should serialize clip groups', () => {
      const clips = [createTestClip('a', 5)];
      const clipGroups: ClipGroup[] = [
        {
          id: 'group1',
          variants: { A: clips[0], B: null },
          activeVariant: 'A',
        },
      ];
      const project = serializeProject(clips, [], [], clipGroups);
      expect(project.clipGroups).toBeDefined();
      expect(project.clipGroups).toHaveLength(1);
      expect(project.clipGroups![0].id).toBe('group1');
      expect(project.clipGroups![0].activeVariant).toBe('A');
    });

    it('should serialize PiP properties', () => {
      const clip = createTestClip('clip1', 5);
      clip.layerIndex = 1;
      clip.x = 100;
      clip.y = 200;
      clip.width = 300;
      clip.height = 400;
      clip.opacity = 0.8;
      const project = serializeProject([clip], [], [], []);
      expect(project.clips[0].layerIndex).toBe(1);
      expect(project.clips[0].x).toBe(100);
      expect(project.clips[0].y).toBe(200);
      expect(project.clips[0].width).toBe(300);
      expect(project.clips[0].height).toBe(400);
      expect(project.clips[0].opacity).toBe(0.8);
    });
  });

  // =========================================================================
  // applyProjectData
  // =========================================================================
  describe('applyProjectData', () => {
    it('should restore clips when files are available by name', async () => {
      const sourceClips = [
        createTestClip('source1', 10, 'Source Clip 1'),
      ];

      const project: Project = {
        clips: [
          {
            id: 'saved1',
            title: 'Saved Clip',
            kind: 'video',
            duration: 10,
            trimStart: 1,
            trimEnd: 8,
            videoFadeIn: 0.2,
            videoFadeOut: 0.1,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'source1.mp4',
          },
        ],
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.clips).toHaveLength(1);
      expect(result.clips[0].title).toBe('Saved Clip');
      expect(result.clips[0].trimStart).toBe(1);
      expect(result.clips[0].trimEnd).toBe(8);
    });

    it('should restore A/B groups from saved project', async () => {
      const clipA = createTestClip('a', 5, 'Clip A', 'group1', 'A');
      const clipB = createTestClip('b', 5, 'Clip B', 'group1', 'B');
      const sourceClips = [clipA, clipB];

      const project: Project = {
        clips: [
          {
            id: 'a',
            title: 'Clip A',
            kind: 'video',
            duration: 5,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'a.mp4',
            groupId: 'group1',
            groupVariant: 'A',
          },
          {
            id: 'b',
            title: 'Clip B',
            kind: 'video',
            duration: 5,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'b.mp4',
            groupId: 'group1',
            groupVariant: 'B',
          },
        ],
        clipGroups: [
          {
            id: 'group1',
            activeVariant: 'B',
          },
        ],
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.clipGroups).toHaveLength(1);
      expect(result.clipGroups[0].id).toBe('group1');
      expect(result.clipGroups[0].activeVariant).toBe('B');
      expect(result.clipGroups[0].variants.A).not.toBeNull();
      expect(result.clipGroups[0].variants.B).not.toBeNull();
    });

    it('should skip clips that cannot be restored', async () => {
      const sourceClips: Clip[] = []; // No source clips

      const project: Project = {
        clips: [
          {
            id: 'missing',
            title: 'Missing Clip',
            kind: 'video',
            duration: 10,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'missing.mp4',
          },
        ],
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.clips).toHaveLength(0);
      expect(result.skippedClipCount).toBe(1);
      expect(result.skippedClipFileNames).toContain('missing.mp4');
    });

    it('should restore transitions from project', async () => {
      const sourceClips = [
        createTestClip('a', 5),
        createTestClip('b', 3),
      ];

      const project: Project = {
        clips: [
          {
            id: 'a',
            title: 'Clip A',
            kind: 'video',
            duration: 5,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'a.mp4',
          },
          {
            id: 'b',
            title: 'Clip B',
            kind: 'video',
            duration: 3,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'b.mp4',
          },
        ],
        transitions: [
          {
            afterClipIndex: 1,
            type: 'dissolve',
            duration: 0.5,
          },
        ],
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0].afterClipIndex).toBe(1);
      expect(result.transitions[0].type).toBe('dissolve');
      expect(result.transitions[0].duration).toBe(0.5);
    });

    it('should throw error if project is invalid', async () => {
      const sourceClips = [createTestClip('a', 5)];
      const invalidProject = { clips: null } as unknown as Project;
      await expect(applyProjectData(invalidProject, sourceClips)).rejects.toThrow(
        'Project file is invalid',
      );
    });

    it('should apply clip adjustments (trim, fade) when restoring', async () => {
      const sourceClips = [
        createTestClip('source', 10),
      ];

      const project: Project = {
        clips: [
          {
            id: 'saved',
            title: 'Saved',
            kind: 'video',
            duration: 10,
            trimStart: 2,
            trimEnd: 8,
            videoFadeIn: 0.3,
            videoFadeOut: 0.2,
            audioFadeIn: 0.1,
            audioFadeOut: 0.15,
            fileName: 'source.mp4',
          },
        ],
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.clips[0].trimStart).toBe(2);
      expect(result.clips[0].trimEnd).toBe(8);
      expect(result.clips[0].videoFadeIn).toBe(0.3);
      expect(result.clips[0].videoFadeOut).toBe(0.2);
      expect(result.clips[0].audioFadeIn).toBe(0.1);
      expect(result.clips[0].audioFadeOut).toBe(0.15);
    });

    it('should apply PiP properties when restoring', async () => {
      const sourceClips = [
        createTestClip('source', 10),
      ];

      const project: Project = {
        clips: [
          {
            id: 'saved',
            title: 'Saved',
            kind: 'video',
            duration: 10,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'source.mp4',
            layerIndex: 1,
            x: 100,
            y: 150,
            width: 300,
            height: 200,
            opacity: 0.7,
          },
        ],
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.clips[0].layerIndex).toBe(1);
      expect(result.clips[0].x).toBe(100);
      expect(result.clips[0].y).toBe(150);
      expect(result.clips[0].width).toBe(300);
      expect(result.clips[0].height).toBe(200);
      expect(result.clips[0].opacity).toBe(0.7);
    });
  });

  // =========================================================================
  // Integration: Serialize/Apply Roundtrip
  // =========================================================================
  describe('Serialize/Apply Roundtrip', () => {
    it('should roundtrip simple project: serialize then apply', async () => {
      // Create original project
      const originalClips = [
        createTestClip('a', 5, 'Clip A'),
        createTestClip('b', 3, 'Clip B'),
      ];
      const originalTransitions: ClipTransition[] = [
        { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
      ];

      // Serialize
      const serialized = serializeProject(originalClips, originalTransitions, [], []);

      // Apply (simulate loading)
      const result = await applyProjectData(serialized, originalClips);

      // Verify roundtrip
      expect(result.clips).toHaveLength(2);
      expect(result.clips[0].title).toBe('Clip A');
      expect(result.clips[1].title).toBe('Clip B');
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0].type).toBe('dissolve');
    });

    it('should roundtrip complex project with A/B groups', async () => {
      // Create original project with A/B groups
      const clipA = createTestClip('a', 5, 'Version A', 'group1', 'A');
      const clipB = createTestClip('b', 5, 'Version B', 'group1', 'B');
      const clipGroups: ClipGroup[] = [
        {
          id: 'group1',
          variants: { A: clipA, B: clipB },
          activeVariant: 'B',
        },
      ];

      // Serialize
      const serialized = serializeProject([clipA, clipB], [], [], clipGroups);

      // Apply
      const result = await applyProjectData(serialized, [clipA, clipB]);

      // Verify roundtrip
      expect(result.clipGroups).toHaveLength(1);
      expect(result.clipGroups[0].activeVariant).toBe('B');
    });
  });
});
