# Kurt Urfel's MIDI Fixer

A small tool for **Space Station 14** musicians. It fixes MIDI files whose drums turn into a piano or a guitar on the DAW, drums that break after you played another song, and MIDIs that play too quietly.

It runs in your browser. Nothing gets uploaded anywhere.

**Use it:** TODO: GitHub Pages link. Or download `index.html` and open it in Chrome.

<br clear="right">

## What it fixes

| Problem | What you hear in SS14 | What the fix does |
|---|---|---|
| Bank select on the drum channel | Drums play as a piano, a guitar or something else | Removes `CC0`/`CC32` on channel 10 and sets bank 120 at the start |
| Broken song played right before | A clean song's drums suddenly play as a piano | Same fix. The file sets its own drum bank and kit at the start |
| Drum kit missing from the soundfont (e.g. TR-707) | The Standard kit instead | Swaps in the closest kit GeneralUser GS has (TR-707 → 808/909) |
| Drums on another channel (GS/XG rhythm part) | Drum notes played by a normal instrument | Moves that channel to channel 10 |
| More than 1000 events per second | Fine for you, lag and dropouts for everyone else | Drops messages SS14 ignores, repeated values and in-between controller steps. Notes stay untouched |
| Quiet file | Too quiet | Raises channel volume, expression and velocity together, so the mix stays balanced |

Every fix is a checkbox, so you can turn each one off. Under **Fixes for every file** you set the defaults for all loaded files at once: fix every drum problem right away, and how much to boost quiet files (Gentle: halfway to full, Loud: up to −2 dB, Max: up to 0 dB).

## How to use it

1. Open the tool and drop in one or more MIDI files.
2. Optional, for listening: click **Add soundfont** and pick `GeneralUser-GS.sf2` from the SS14 repo at `Resources/Audio/MidiCustom/`. Add `space-station-14.sf2` from the same folder too. The browser remembers them.
3. Read the problems the tool found, then compare **SS14 · original**, **SS14 · fixed** and **Intended**. The position stays the same when you switch. **Only channel 10** lets you hear the drums alone. **Start after a broken song** simulates the left-over state from a previous song.
4. Click **Save fixed file**. The fixed file is named `<name>_ss14.mid`.

Still too quiet after a boost? Then the file is already at full level. Raise **Options → Audio → MIDI (Instrument) Volume** in SS14. Every listener sets that for themselves.

The preview works best in Chrome. If you hear nothing, open **No sound?** and run the sound test. It tells you whether the browser, the soundfont or the synth is the problem. Feel free to list any issues. Im happy if i can find more things to improve your musician experience ig. 

## Why the drums turn into a piano

This only happens on instruments that allow program changes: the DAW and the super synthesizer. Every other instrument forces its own sound and ignores bank and program changes.

1. RobustToolbox starts FluidSynth with `synth.midi-bank-select = gm` (`Robust.Client/Audio/Midi/MidiManager.cs`). In GM mode FluidSynth ignores bank select on purpose.
2. To get bank select anyway, `MidiRenderer.SendMidiEvent` handles `CC0` itself and calls `_synth.BankSelect(channel, value)` (`Robust.Client/Audio/Midi/MidiRenderer.cs`). That call sets the bank directly and has no exception for the drum channel.
3. Lots of MIDIs send `CC0 = 0` and then a program change on channel 10. FluidSynth's `fluid_synth_program_change` looks for bank 0 / program N, finds a normal instrument (0 = piano, 25 = steel guitar) and plays that. It only falls back to the drum bank when bank 0 has nothing at that number.
4. SS14 does not reset the synth between songs (`player.reset-synth = 0`, no reset in `OpenMidi`). One broken song can break the next one.
5. The server passes at most `midi.max_events_per_second = 1000` on to other players. Files with heavy controller data go over that, and only the listeners notice.

The fix sets bank 120 on channel 10 at the start. GeneralUser GS has the same drum kits in bank 120 as in bank 128, and normal MIDI players either ignore it or read it as the GM2 drum bank. So the fixed file still plays fine outside SS14.

An engine-side fix would be small: skip `BankSelect` on the percussion channel, and reset the synth when a new MIDI opens. That belongs in RobustToolbox.

## How the preview works

The page loads FluidSynth 2.4.6 (compiled to WebAssembly, via [js-synthesizer](https://github.com/jet2jet/js-synthesizer)) with the same bank-select mode SS14 uses. A hook on the MIDI player handles every event the way `MidiRenderer` does. **Intended** plays the file the way a normal GM/GS player would, so you can compare what SS14 makes of it with what the author meant.

## How this came together

I play a lot of music in SS14, mostly on the DAW, and I got tired of MIDIs where the drums suddenly turn into a piano. I'm not a professional programmer, and I didn't have the knowledge to dig through the engine on my own.

So I worked through it with Claude (Anthropic's AI, the Opus model). We read RobustToolbox's MIDI code and FluidSynth's source, compared broken MIDIs with ones I had fixed by hand, and tested ideas until it was clear why it happens. **The code in this repo was written by Claude.** I tested it with my own MIDIs and decided what it should do and how it should look.

I know a lot of people in the SS14 community are wary of AI, and the codebases I contribute to don't accept AI-written code. I respect that with all of my heart. (Holy jeez, i love this game so much) That's why this is a standalone tool and not a pull request. Im simply not able to touch the robust toolbox (...yet! Im learning!) Nothing from here goes into Space Station 14, RobustToolbox or any server. It just fixes the files, for me and for anyone else who's had enough of piano drums.

## Building and testing

Everything the page needs is in `src/`:

- `src/core.js`: MIDI reader and writer, the SS14 model, the checks and the fixes
- `src/page.html`: the interface
- `src/presets.json`: preset names of GeneralUser GS and `space-station-14.sf2`, used when no soundfont is loaded

`python3 build.py` puts it all into the single file `index.html`. `node tests/test_core.js` runs the tests. They build their MIDI files in memory, so the repo doesn't ship anyone's songs.

## Credits

- **Kurt Urfel sprite** in the tool: built from Space Station 14 art, licensed [CC-BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
- **FluidSynth** (LGPL-2.1) and **js-synthesizer** (BSD-3-Clause) are loaded from jsDelivr when you listen. They are not part of this repo.
- **GeneralUser GS** by S. Christian Collins is the soundfont SS14 ships. It is not included here. You load your own copy.

Not affiliated with the Space Wizards Federation.

Special thanks to ss14 Server Carpmosia. This community means a lot to me and i thank you for infinite good times!


## License

The code is under the MIT License, see `LICENSE`. The artwork in `assets/` is not covered by it: the sprite is CC-BY-SA 3.0.
