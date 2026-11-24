# SKFE | Stickman Keyframe Editor

Stickman keyframe animation editor — For the Alan Becker stick figure fandom.

**Author**: binvwvnid　│　**QQ group**: 1121039855　│　**Version**: v7.9.3

- Web app: https://binvwvnid.github.io/SKFE-StickmanKeyframeEditor/
- Installers (Windows / Android): https://github.com/binvwvnid/SKFE-StickmanKeyframeEditor/releases
- Shared project: https://pan.baidu.com/s/1ZvGXP3Vy35UuSx63sPvYTw?pwd=176y

> **Copyright and License Notice**: SKFE is a **non-open-source** work by author **binvwvnid**. Without the author's explicit written authorization, **packaging it for sale or offering it as a standalone service is prohibited**; **deleting, hiding or removing the author's credit, QQ group or version watermark is prohibited**. This project permits only two cases: (1) custom modifications authorized by the author; (2) integrating / developing plugins through the official plugin interface.
> Plugins must be published under the plugin author's own name.

> For usage questions, see this guide; plugin authors, see `插件API参考.md` in the repository.

# SKFE User Guide

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Canvas, Panels and Basic Operations](#2-canvas-panels-and-basic-operations)
3. [Adding and Editing Elements](#3-adding-and-editing-elements)
4. [Advanced Stickman Settings](#4-advanced-stickman-settings)
5. [Timeline and Keyframe Animation](#5-timeline-and-keyframe-animation)
6. [Track Panel and Clip Elements](#6-track-panel-and-clip-elements)
7. [Media, Masks and Drag-and-Drop Import](#7-media-masks-and-drag-and-drop-import)
8. [Projects, Actions and Plugins](#8-projects-actions-and-plugins)
9. [Export](#9-export)
10. [Shortcuts and FAQ](#10-shortcuts-and-faq)

---

## 1. Quick Start

### 1.1 Where to use

- **Web app**: open the web address to start. Data is saved in the current browser by default.
- **Windows / Android installers**: download the matching installer from the Releases page. The Android build shares the same editor UI as the web app.

### 1.2 Interface overview

- **Canvas**: the main creation area in the center of the screen, where stickmen, images, videos, shapes and other elements are placed.
- **Bottom bar / side panel**: contains entries for properties, elements, pen, canvas, advanced, projects, export, theme and plugins. Click an entry to open its panel; click the same entry again to collapse everything.
- **Timeline**: click the frame animation panel at the lower right to enter, used for frame-by-frame / keyframe animation.
- **Track button**: in the timeline control bar, click `🎞 Track` to switch the frame-block view to a multi-track view similar to video editing software.
- **Undo / Redo**: available at the upper right corner.

### 1.3 Where projects are saved

- Media such as images, videos and audio inside a project is saved together with the `.json` file.
- The editor keeps an automatic backup inside the browser / app, so a refresh will not immediately lose your work.
- The project library is stored locally in the current browser / app and is not automatically synced to another device.

---

## 2. Canvas, Panels and Basic Operations

### 2.1 View control

- **Computer**: scroll wheel to zoom; drag empty space with the mouse to pan.
- **Phone / tablet**: pinch with two fingers to zoom; drag with two fingers to pan.
- **Boundary protection**: at least 5% of the canvas stays on screen while zooming, so the canvas can never be dragged completely out of view.
- **Fixed view**: once canvas bounds are enabled and the view is fixed, the canvas XY position no longer changes, preventing accidental displacement.

### 2.2 Panel operations

- Drag a panel's top bar to move it.
- With free resize enabled, drag a panel's lower-right corner to resize it; the browser remembers that toggle.
- A panel can be locked in place to avoid accidental dragging.
- Properties, elements and more-settings areas use full-width title bars; the scrollbar on the right is thin, so content is never covered by the thumb.
- The element list follows the current frame's layer order from top to bottom; dragging a row changes the order and writes it to the current frame's layers. With global property editing enabled, the order is synced to all frames of that element.
- `Guide` to the right of the global property editing note opens a closable floating window covering the screen, showing the full text of the active README.

### 2.3 Canvas settings

- Editing background, grid and ground guide lines can be adjusted. These only affect the editing view, not the exported image.
- Canvas bounds can be enabled with an export ratio such as 1:1, 9:16 or 16:9.
- With canvas bounds enabled, only content inside the canvas frame is exported.

### 2.4 Theme settings

- Panel background, button colors, text colors and more can be adjusted.
- The current palette can be saved as a theme preset for reuse across projects.

---

## 3. Adding and Editing Elements

### 3.1 Elements you can add

Under `＋ Add object` you can add:

- **Stickman**: the main creation object, with full animation features including joints, proportions, glow, IK and head types.
- **Image / Accessory**: import a local image as a prop or accessory. It can be bound to a stickman joint, or have its own position, scale, rotation, distortion and keyframes. All bitmaps are imported through this entry.
- **Import video**: a genuinely editable video element. It can be resized, positioned, rotated, made transparent, four-corner distorted and keyframed like an image, and can also be bound to a stickman. It is not the same thing as a `Reference video`.
- **Import audio**: an element that carries sound only. It accepts audio files and video files. Importing a video as audio acts as "video to audio", but no real transcoding or real sampled waveform is generated.
- **Dialogue bubble**: speech balloon text with editable text, color, gradient, size and tail direction.
- **Camera**: controls the export framing and ratio and can be animated too.
- **Built-in shapes**: circle, square and triangle.

### 3.2 Basic properties

After selecting an element you can adjust:

- **Name**: rename the element for easier identification in layers and tracks.
- **Color / stroke**: change the appearance of stickmen or shapes.
- **Position X / Y**: type numbers directly or drag the handles on the canvas.
- **Scale / opacity**: quickly change size and visibility.
- **Rotation**: supports multiple turns beyond 360°, and can also be turned with a handle on the canvas.
- **Horizontal mirror**: flip left and right.
- **Layer**: `+1 layer`, `-1 layer`, `Bring to front`, `Send to back`.

### 3.3 Stickman-only properties

- **Head type**: switch between round head, Vic, TCO, TDL, TSC and more. Hand-drawn heads follow the stickman's color, rotation, mirror and fill settings.
- **Proportions**: adjust head size, arm length, leg length and torso ratio; independent limbs, small hands / feet and independent head translation are available.
- **Joints**: drag the blue joint points on the canvas to pose, or rotate precisely with sliders.
- **IK**: after pinning feet, hands or other joints, limbs adapt automatically when the torso moves.
- **Glow / shadow**: outline shadow, side light, hand gradient, ground shadow and darkening can be saved per element and take part in keyframes.

### 3.4 Video elements

- **Role**: `Import video` is an editable element; `Import reference video` is only a canvas reference and is not listed as an element, not exported and not selectable for transforms.
- **Default length**: a video fills the project's total track length when imported, and can then be stretched, shortened, moved or split in the track.
- **Playback range**: picture and sound play only within the frame range covered by the current track segment; outside the segment the picture freezes and sound is muted.
- **Continuous playback**: playback inside a segment is continuous and is not repeatedly dragged by the frame rate, so looping is smoother.
- **Deletion cleanup**: deleting a video element also releases its audio source, so no orphan sound is left behind.
- **Export**: video elements take part in live rendering and video export; still frame / sequence export uses the current frame.

### 3.5 Audio elements

- **Import**: accepts audio files and video files; a video imported as audio plays its sound only.
- **Track position**: audio is not shown in the element list and always sits at the bottom of the track panel.
- **Waveform display**: the track bar shows a deterministic placeholder waveform, not a real sampled waveform.
- **Property limits**: audio exposes only name and volume; no position, scale, color, mask or other picture properties are provided.
- **Playback rule**: like video elements, audio sounds only within the frame range covered by its own track segment and is muted outside it.
- **Operations**: it can be moved, stretched, shortened and split in the track; its audio source is released on deletion.

---

## 4. Advanced Stickman Settings

### 4.1 Proportions and body shape

- Head size, arm length, leg length and torso ratio can be adjusted.
- With independent limbs enabled, the left and right arms and legs can be set separately.
- Pseudo perspective (thickness variation) creates a sense of depth by changing the thickness ratio at both ends of a limb, without changing the limb's actual length.
- Small hands and feet can be set separately as a percentage of palm and sole size.
- Independent head translation allows tilted heads and head offsets.

### 4.2 Joints and IK

- Blue dots are joints; drag them directly to change the pose.
- Joint rotation sliders allow precise angle adjustment.
- With joint stretching enabled, dragging a joint also changes the limb length.
- Joint points can be hidden for cleaner screenshots or previews.
- Once IK is pinned, the joint stays in place and limbs stretch automatically when the torso moves.

### 4.3 Glow and effects

- **Outline shadow**: color, opacity, feather, spread and XY offset can be set, and can also apply together with bound accessories.
- **Side highlight**: adds depth, with adjustable thickness and direction.
- **Hand gradient**: makes the end of an arm a gradient color.
- **Ground shadow**: set independently for each stickman and can be keyframed on its own.
- **Darkening**: automatically darkens limbs behind, enhancing the sense of depth.

### 4.4 Pen and eraser

- Pen strokes are saved as vector objects and can follow an object's movement, rotation and scale.
- The eraser only affects the currently selected object, and erasures are also saved as vectors.
- Straight-line mode and end snapping are supported; stopping at the end of a stroke can snap it into a standard shape.
- Undo, clear erasures of the current frame and clear all erasures are available.

---

## 5. Timeline and Keyframe Animation

Click the `Frame animation panel` at the lower right to open the timeline.

### 5.1 Basic frame operations

- `＋ Frame`: insert a frame after the current one.
- `⧉ Copy frame`: copy the current frame.
- `🗑 Delete frame`: delete the current frame.
- **Multi-select**: select several frames at once for batch tweening, deletion and export.
- **Drag to reorder**: hold and drag a frame block to reorder; on touch screens, long-press and then drag.

### 5.2 Keyframes and derived frames

The timeline uses a "keyframe + derived frame" system: you only need to set the key poses and the in-between pictures are calculated automatically.

1. Move the playhead to a frame and click `◆ Set keyframe` or press `K` to lock the current pose as a keyframe.
2. Move to another frame, change the pose and set another keyframe.
3. Derived frames are generated automatically between two keyframes, with no need to draw frame by frame.
4. Pressing `K` on the main track only sets keyframes for elements that actually changed; switch to an element's sub-track for precise per-element control.
5. Deleting a middle keyframe merges the segments before and after it; deleting a first or last keyframe lets the neighboring pose continue.
6. Copying a keyframe produces a new keyframe, not a normal frame.

### 5.3 Segment curves and tweening

- The curve dropdown changes the easing of the current keyframe segment, for example linear, ease-in, ease-out, ease-in-out or custom Bezier.
- A curve only applies to the current segment of the current element, not to other segments or elements.
- The older `Tween` flow is still available: set the first and last frames, select the start frame, choose Tween and enter the number of frames.
- Partial easing is supported, with separate curves for position, scale, rotation and joints.

### 5.4 Advanced settings

- **FPS**: adjust the playback frame rate.
- **Onion skin**: show semi-transparent ghost frames before and after for motion correction.
- **Global property editing**: when enabled, changing an element property syncs to all frames of that element; it takes priority over clip-wide editing and automatic keying.
- **Frame thumbnails**: show a small picture on each cell of a track bar.
- **Clear all frames / Clear non-current frames**: quickly reset project content.

---

## 6. Track Panel and Clip Elements

### 6.1 Entering track mode

Click `🎞 Track` in the timeline control bar to switch views:

- Each element occupies one row, and the frames in which it appears merge into one long bar.
- The track panel sits below the control panel; opening the control panel overlays the track panel.
- Click `🎞 Track` again to return to the frame-block view; both views share the same project data.
- Track mode is not opened by default on phones; enable it manually when needed.

### 6.2 Clip mindset

A continuous run of frames in a track can be understood as a single clip in video editing software:

- **Clip with no keyframes**: like an image occupying a period of time. With global property editing off, changing any frame syncs to the whole run and does not automatically break it into keyframes.
- **Clip with any keyframe**: becomes an animated segment. After that, changes to the element on other frames automatically set keyframes.
- **Global property editing**: highest priority. When enabled, global property rules apply and clip detection is ignored.
- **Imported actions**: left as-is; importing never automatically fills the run with keyframes.
- **Camera**: supports clip-wide editing like any other element; a newly added camera fills the whole track length by default.
- **Delete / Copy**: the element list's trash button and the track delete button delete the entire clip containing the current frame; the copy button copies the entire clip, preserving keyframes, curves, segment data and derived frames and changing only its name and ID.
- **Split**: a run is only cut into two by clicking `✂ Split`.

### 6.3 Basic track operations

- **Stretch / shrink**: drag either end of a bar. Stretching copies the edge frame as a normal frame; shrinking clears the vacated frames.
- **Move whole clip**: hold the middle of a bar and drag; it will not push into neighboring bars.
- **Select**: clicking a bar or track row selects that element; clicking empty space only moves the playhead and does not clear the selection.
- **Eye button**: shows or hides the element on all frames.
- **Playhead**: the red vertical line marks the current frame; click empty track space to jump to a frame.
- **Keyframe button**: a diamond with `＋` in the middle means a keyframe can be added; `−` means the current frame is already a keyframe.
- **Keyframe dragging**: drag a white diamond to move a keyframe; hold `Alt` while dragging to copy it.
- **Keyframe multi-select**: `Ctrl / ⌘ / Shift` click to add to the selection; double-click to select all keyframes on the whole track.
- **Group operations**: dragging selected keyframes moves them together; `Alt` drag copies the group.
- **Copy keyframes / Paste keyframes**: the two buttons on the track toolbar only copy / paste the selected keyframes. Pasting at the target frame preserves the original relative spacing. The frame panel's `⧉ Copy frame` is the command that duplicates the current normal frame.
- **Loop**: select a clip and click `⟳ Loop`. Stretching repeats the original segment, copying keyframes and curves by period. The loop period is saved from the original segment; shrinking only trims the visible range and never cuts the period. For example, frames 1–9 shrunk to 1–5 show only the first five frames; stretching again to frame 17 shows 1–9 + 1–8. With loop off, stretching duplicates the edge frame as before.
- **Group loop**: loop applies to the whole group. Toggle it on the group clip outside the group; members repeat with the same group period. Inside the group, members remain editable as-is and do not get a separate stacked loop. Deleting a group deletes its members as well.
- **Box select**: drag on empty track space to box-select several bars for group move, stretch / shrink and deletion.
- **One gesture, one undo**: dragging, box selection, batch paste and batch delete are each recorded as a single operation.

### 6.4 Track zoom

- **Computer**: hover the mouse over the top blue ruler row and scroll to zoom.
- **Phone / tablet**: keep a finger on the ruler row and pinch with two fingers to zoom.
- Scrolling below the track panel still scrolls up and down and will not accidentally zoom.
- When zoomed far out, ticks are displayed as `minutes:seconds`.
- When zooming in, the anchor stays at the left edge of the visible area, so left-side content is not pushed away.

### 6.5 Audio tracks

- Audio tracks are always at the very bottom.
- Bars show a placeholder waveform, not a picture thumbnail.
- Audio tracks can be moved, stretched, shortened and split.
- Audio sounds only inside its own segment and is muted outside it, unaffected by FPS dragging.

---

## 7. Media, Masks and Drag-and-Drop Import

### 7.1 Reference video

- A reference video is used to compare motion and is only shown on the canvas as a reference.
- It is not listed as an element, not exported and cannot be selected or transformed.
- Reference videos and `Import video` are two different types, with separate icons and names.

### 7.2 Masks and chroma key

After selecting an image, shape, dialogue bubble, pen stroke or video element under `More settings`, open `Mask`:

- **Basic mask**: rectangle / ellipse, with horizontal position, vertical position, width, height, feather and invert.
- **Chroma key**: key color, similarity, smoothness, hue tolerance, saturation tolerance, lightness tolerance, spill suppression, edge feather and keep-only-keyed-color.
- Basic mask and chroma key are stacked vertically, each with its own switch, and both can be enabled at the same time.
- Parameter changes are saved with the element and take part in preview and export; audio elements have no mask entry.

### 7.3 Drag-and-drop import

Files can be dragged directly onto the SKFE window and are recognized automatically:

- **Image**: imported as an image / accessory.
- **Video**: imported as a video element.
- **Audio**: imported as an audio element.
- **JSON**: recognized as a project file, action file or plugin manifest.
- **ZIP**: imported as a plugin package.
- Large files prompt for confirmation before import; plugin import keeps its risk confirmation step.

---

## 8. Projects, Actions and Plugins

### 8.1 Project library

- In the project section, click `Export and save project` and enter a name. This will at the same time:
  - download a `.json` project file with that name;
  - save the project into the current browser's project library.
- The project library shows the project name, frame count and FPS.
- Click a project entry or its open button in the library to reopen it.
- Background auto-save remains in place; to clear the picture, use `Clear all frames` in advanced settings.

### 8.2 Project and action FPS

- Project files record FPS and it is displayed in the project library.
- Saving / exporting an action records the action FPS and it is displayed in the action library.
- Action FPS is metadata only and does not automatically override the frame duration already set in the current project.

### 8.3 Action library

- Enter an action name in advanced settings to save the current action to the action library.
- Actions in the library can be applied to other stickmen.
- Imported actions keep their original frame content and keyframe information and are not rewritten automatically.

### 8.4 Plugins

- The plugin entry in the bottom bar manages local plugins.
- Data-type and code-type plugins developed against the official interface are supported, as well as ZIP plugin packages imported by dragging them in.
- Code-type plugins show a risk notice and are only loaded after confirmation.
- On the Android client, "Download all (ZIP)" now uses native save / system share instead of relying on WebView `<a download>`.
- Since v7.8.4, plugins use `window.SKFE.api` for full access: project data, runtime state, DOM UI, events, media, groups, loops, history and export. MCP plugins can call `api.mcp.call()` to operate the entire interface and dataset.
- This is a fully trusted model with no sandbox. Only import plugins you trust.
- Plugin authors should read `插件API参考.md` in the repository; the internal design draft is not published with the repository.

---

## 9. Export

The export panel is grouped by purpose: **still images / video / sequences and GIF / export options**.

### 9.1 Still images and sequences

- **PNG / JPG**: export the current frame with an optional high-resolution multiplier.
- **PNG sequence**: pack multiple frames into a ZIP.
- **SVG sequence**: exports vector content only, including stickmen, built-in shapes and vector pen / eraser results; text, bitmaps, video, glow, distortion and other non-vector content are not exported.
- In multi-select mode, only the selected frames are exported.

### 9.2 GIF

- Transparent-background GIF can be exported.
- High-resolution multipliers are supported.
- On phones, the exported file can be saved to the album following the on-screen prompt.

### 9.3 Video

- **WebM**: supports transparent background.
- **MP4**: better compatibility, no transparent background, with a configurable background color.
- Both formats mix audio clips and the audio of video clips into the exported file according to their track segments; projects without audio stay silent. Audio is aligned to real frame durations and is not affected by FPS dragging.
- On devices without an AAC encoder, MP4 export prefers browser recording so audio is kept. If the device can neither encode AAC nor record MP4 with audio, video-only export is used.
- If high-resolution encoding fails on mobile, the editor automatically tries a lower setting; if an encoding notice appears, first turn off 1080p / high-resolution multiplier and retry with a smaller size.

### 9.4 Export options

- Export range, canvas ratio, background color, transparent background and quality can be set.
- When a camera exists, export uses the camera's framing first.
- Without canvas bounds, framing is calculated from the content or the default ratio.

---

## 10. Shortcuts and FAQ

### 10.1 Shortcuts

| Key | Function |
| --- | --- |
| `C` | Copy the current selection |
| `Delete` / `Backspace` | Delete the current selection |
| `Space` | Play / pause the animation |
| `←` / `→` | Previous frame / next frame |
| `R` | Reset the current selection's pose |
| `Ctrl + Z` / `Cmd + Z` | Undo |
| `Ctrl + Y` / `Cmd + Shift + Z` | Redo |
| `Escape` | Close a menu or dialog |

### 10.2 FAQ

**I refreshed the page and can't see the new features?**

The browser may still be using an old script from the offline cache. Force-refresh the page; if that does not help, unregister the Service Worker in developer tools, or open the app in a private window.

**Why isn't the audio track a real waveform?**

What is shown is a deterministic placeholder waveform used to represent the segment and the rhythm of the sound, not a real sampled waveform.

**Why does video / audio only play in a short section?**

Video and audio elements both play only within the frame range covered by their own track segment. Check the segment range, playhead position and whether it is muted / hidden in the track.

**The project file is huge and slow to open?**

Projects with video or audio write media data into the `.json`, so the file can be large. The first open needs to decode media, so please wait; do not manually edit the internal content of the project file.

**The Android upgrade reports a signature conflict?**

The old installer has a different signature, so uninstall the old version before installing. Uninstalling clears the app's internal backup, so export a `.json` backup first.

---

> Made by **binvwvnid** · [SKFE-StickmanKeyframeEditor](https://github.com/binvwvnid/SKFE-StickmanKeyframeEditor) · QQ group 1121039855
