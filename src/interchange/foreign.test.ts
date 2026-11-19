import { describe, expect, it } from 'vitest';
import { importTimeline } from './index';

const rt = (value: number, rate = 24) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
const range = (start: number, duration: number, rate = 24) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start, rate), duration: rt(duration, rate) });
const clip = (name: string, url: string, start: number, duration: number) => ({
  OTIO_SCHEMA: 'Clip.1',
  name,
  source_range: range(start, duration),
  media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: url, available_range: range(0, 240) },
  effects: [],
  markers: [],
  metadata: {},
});

describe('foreign timelines (no clip_stacker metadata)', () => {
  it('imports a Resolve-style OTIO at 24 fps: base track, linked audio dropped, gaps, a dissolve', () => {
    const doc = {
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Resolve cut',
      global_start_time: rt(86_400),
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            kind: 'Video',
            name: 'Video 1',
            children: [
              clip('A', 'file:///Volumes/Media/A%20Roll.mov', 24, 48),
              { OTIO_SCHEMA: 'Transition.1', name: 'Cross Dissolve', transition_type: 'SMPTE_Dissolve', in_offset: rt(6), out_offset: rt(6) },
              clip('B', 'file:///Volumes/Media/B.mov', 48, 72),
            ],
          },
          {
            OTIO_SCHEMA: 'Track.1',
            kind: 'Video',
            name: 'Video 2',
            children: [{ OTIO_SCHEMA: 'Gap.1', source_range: range(0, 12) }, clip('Logo', 'file:///Volumes/Media/logo.mov', 0, 24)],
          },
          {
            OTIO_SCHEMA: 'Track.1',
            kind: 'Audio',
            name: 'Audio 1',
            children: [clip('A', 'file:///Volumes/Media/A%20Roll.mov', 24, 48), clip('Music', 'file:///Volumes/Media/music.wav', 0, 120)],
          },
        ],
      },
    };
    const { project, media, format } = importTimeline(JSON.stringify(doc));
    expect(format).toBe('otio');
    expect(project.timecodeRate).toBe('24');
    // The default start is omitted, as a save omits it.
    expect(project.timecodeStart).toBeUndefined();
    const names = project.clips.map((c) => c.fileName);
    // A's own audio on Audio 1 is the video clip's sound: not imported twice.
    expect(names).toEqual(['A Roll.mov', 'B.mov', 'logo.mov', 'music.wav']);
    const [a, b, logo, music] = project.clips;
    expect([a!.trimStart, a!.trimEnd]).toEqual([1, 1 + 54 / 24]);
    expect([b!.trimStart, b!.trimEnd]).toEqual([48 / 24 - 6 / 24, 5]);
    expect(project.transitions).toEqual([{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }]);
    expect(logo!.kind).toBe('video');
    expect(project.tracks!.find((t) => t.items.some((i) => i.clipId === logo!.id))!.items[0]!.startTime).toBe(0.5);
    expect(music!.kind).toBe('audio');
    expect(media.get(a!.id)?.url).toBe('file:///Volumes/Media/A%20Roll.mov');
  });

  it('imports an FCP-written FCPXML with a retimed clip, a connected clip and a title', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat1080p2997" frameDuration="1001/30000s" width="1920" height="1080"/>
    <asset id="r2" name="Beach" start="0s" duration="300300/30000s" hasVideo="1" hasAudio="1" format="r1">
      <media-rep kind="original-media" src="file:///Users/me/Movies/Beach.mov"/>
    </asset>
    <asset id="r3" name="Bird" start="0s" duration="10s" hasVideo="1" hasAudio="0" format="r1">
      <media-rep kind="original-media" src="file:///Users/me/Movies/Bird%20Cam.mp4"/>
    </asset>
    <effect id="r4" name="Basic Title" uid=".../Basic Title.moti"/>
  </resources>
  <library>
    <event name="Trip">
      <project name="Trip cut">
        <sequence format="r1" duration="120120/30000s" tcStart="0s" tcFormat="NDF">
          <spine>
            <asset-clip ref="r2" offset="0s" name="Beach" start="30030/30000s" duration="120120/30000s">
              <timeMap>
                <timept time="30030/30000s" value="30030/30000s" interp="smooth2"/>
                <timept time="150150/30000s" value="270270/30000s" interp="smooth2"/>
              </timeMap>
              <adjust-volume amount="-6dB"/>
              <asset-clip ref="r3" lane="1" offset="60060/30000s" name="Bird" start="0s" duration="30030/30000s"/>
              <title ref="r4" lane="2" offset="30030/30000s" name="Hello" duration="60060/30000s">
                <text><text-style ref="ts1">Hello world</text-style></text>
              </title>
              <marker start="90090/30000s" duration="1001/30000s" value="Look"/>
            </asset-clip>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
    const { project, format } = importTimeline(xml);
    expect(format).toBe('fcpxml');
    expect(project.timecodeRate).toBe('29.97');
    expect(project.timecodeStart).toBe('00:00:00:00');
    const [beach, bird] = project.clips;
    expect(beach!.fileName).toBe('Beach');
    expect(beach!.playbackRate).toBeCloseTo(2, 6);
    expect(beach!.volume).toBeCloseTo(Math.pow(10, -6 / 20), 6);
    expect(bird!.title).toBe('Bird');
    const birdTrack = project.tracks!.find((t) => t.items.some((i) => i.clipId === bird!.id))!;
    expect(birdTrack.kind).toBe('video');
    expect(birdTrack.items[0]!.startTime).toBeCloseTo(1, 1);
    expect(project.textOverlays?.[0]?.text).toBe('Hello world');
    expect(project.tracks!.some((t) => t.kind === 'text')).toBe(true);
    expect(project.masterAudioMarkers?.[0]?.text).toBe('Look');
    expect(project.masterAudioMarkers?.[0]?.time).toBeCloseTo(2, 1);
  });

  it('rejects files that are not timelines', () => {
    expect(() => importTimeline('{"OTIO_SCHEMA": "Clip.2"}', { format: 'otio' })).toThrow(/Not an OpenTimelineIO timeline/);
    expect(() => importTimeline('<fcpxml version="1.11"><resources/></fcpxml>', { format: 'fcpxml' })).toThrow(/no project sequence/);
  });
});
