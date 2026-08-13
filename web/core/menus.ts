// GENERATED FILE — do not edit by hand.
//
// Source of truth: src/ui/MainComponent.cpp (the `menus` table). Regenerate with:
//   cd web && node tools/extract-menus.mjs
// tests/menus.test.js re-parses the C++ and fails if this drifts.
//
// The desktop app builds a real macOS menu bar from the C++ table; the browser has no native
// menus (caps.nativeMenus === false) and renders its own from this copy. Both dispatch the same
// action strings through window.gomidasMenu.

// SCOPE NOTE: body wrapped in an IIFE — these emit as plain <script> files sharing one global scope.
(function () {

const GOMIDAS_MENUS = [
  {
    "name": "File",
    "items": [
      {
        "label": "New Guitar",
        "action": "new:guitar"
      },
      {
        "label": "New Bass",
        "action": "new:bass"
      },
      {
        "label": "New Drums",
        "action": "new:drums"
      },
      {
        "label": "New Full Band",
        "action": "new:band"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Open... (.gp / .gomidas / MusicXML)",
        "action": "open"
      },
      {
        "label": "Save...",
        "action": "save"
      },
      {
        "label": "Export Guitar Pro (.gp)...",
        "action": "exportgp"
      },
      {
        "label": "Print...",
        "action": "print"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Load Sample",
        "action": "sample"
      }
    ]
  },
  {
    "name": "Edit",
    "items": [
      {
        "label": "Undo",
        "action": "undo"
      },
      {
        "label": "Redo",
        "action": "redo"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Cut",
        "action": "cut"
      },
      {
        "label": "Copy",
        "action": "copy"
      },
      {
        "label": "Paste",
        "action": "paste"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Select All",
        "action": "selectall"
      }
    ]
  },
  {
    "name": "Track",
    "items": [
      {
        "label": "Add Guitar Track",
        "action": "addtrack:guitar"
      },
      {
        "label": "Add Bass Track",
        "action": "addtrack:bass"
      },
      {
        "label": "Add Drum Track",
        "action": "addtrack:drums"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Delete Track",
        "action": "deletetrack"
      }
    ]
  },
  {
    "name": "Bar",
    "items": [
      {
        "label": "Insert Bar",
        "action": "addbar"
      },
      {
        "label": "Delete Bar",
        "action": "deletebar"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Time Signature...",
        "action": "timesig"
      },
      {
        "label": "Key Signature...",
        "action": "keysig"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Open Repeat",
        "action": "repeatstart"
      },
      {
        "label": "Close Repeat",
        "action": "repeatend"
      }
    ]
  },
  {
    "name": "Note",
    "items": [
      {
        "label": "Whole",
        "action": "dur:1"
      },
      {
        "label": "Half",
        "action": "dur:2"
      },
      {
        "label": "Quarter",
        "action": "dur:4"
      },
      {
        "label": "Eighth",
        "action": "dur:8"
      },
      {
        "label": "Sixteenth",
        "action": "dur:16"
      },
      {
        "label": "Thirty-second",
        "action": "dur:32"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Triplet (3)",
        "action": "tuplet:3"
      },
      {
        "label": "Quintuplet (5)",
        "action": "tuplet:5"
      },
      {
        "label": "Sextuplet (6)",
        "action": "tuplet:6"
      },
      {
        "label": "Septuplet (7)",
        "action": "tuplet:7"
      },
      {
        "label": "Nonuplet (9)",
        "action": "tuplet:9"
      },
      {
        "label": "Triplet Feel (swing)",
        "action": "tripletfeel"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Dotted",
        "action": "dot"
      },
      {
        "label": "Tie",
        "action": "tie"
      },
      {
        "label": "Rest",
        "action": "rest"
      },
      {
        "label": "Dead Note",
        "action": "dead"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Voice 1",
        "action": "voice:1"
      },
      {
        "label": "Voice 2",
        "action": "voice:2"
      },
      {
        "label": "Voice 3",
        "action": "voice:3"
      },
      {
        "label": "Voice 4",
        "action": "voice:4"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Text...",
        "action": "text"
      },
      {
        "label": "Chord...",
        "action": "chord"
      }
    ]
  },
  {
    "name": "Effects",
    "items": [
      {
        "label": "Bend...",
        "action": "bend"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Palm Mute",
        "action": "fx:palmmute"
      },
      {
        "label": "Let Ring",
        "action": "fx:letring"
      },
      {
        "label": "Hammer-on / Pull-off",
        "action": "fx:hammer"
      },
      {
        "label": "Slide",
        "action": "fx:slide"
      },
      {
        "label": "Ghost Note",
        "action": "fx:ghost"
      },
      {
        "label": "Staccato",
        "action": "fx:staccato"
      },
      {
        "label": "Accent",
        "action": "fx:accent"
      },
      {
        "label": "Natural Harmonic",
        "action": "fx:harmonic"
      },
      {
        "label": "Artificial Harmonic",
        "action": "fx:artharmonic"
      },
      {
        "label": "Pinch Harmonic",
        "action": "fx:pinchharmonic"
      },
      {
        "label": "Vibrato",
        "action": "fx:vibrato"
      },
      {
        "label": "Wide Vibrato",
        "action": "fx:widevibrato"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Shift Slide",
        "action": "fx:shiftslide"
      },
      {
        "label": "Pick Slide Down",
        "action": "fx:pickslidedown"
      },
      {
        "label": "Pick Slide Up",
        "action": "fx:pickslideup"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Brush Up",
        "action": "fx:brushup"
      },
      {
        "label": "Brush Down",
        "action": "fx:brushdown"
      },
      {
        "label": "Arpeggio Up",
        "action": "fx:arpup"
      },
      {
        "label": "Arpeggio Down",
        "action": "fx:arpdown"
      },
      {
        "label": "Pick Stroke Up",
        "action": "fx:pickup"
      },
      {
        "label": "Pick Stroke Down",
        "action": "fx:pickdown"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Tremolo Picking",
        "action": "fx:tremolo"
      },
      {
        "label": "Trill",
        "action": "fx:trill"
      },
      {
        "label": "Grace Note (before)",
        "action": "fx:grace"
      },
      {
        "label": "Grace Note (on beat)",
        "action": "fx:graceon"
      },
      {
        "label": "Slap",
        "action": "fx:slap"
      },
      {
        "label": "Pop",
        "action": "fx:pop"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Fade In",
        "action": "fx:fadein"
      },
      {
        "label": "Fade Out",
        "action": "fx:fadeout"
      },
      {
        "label": "Volume Swell",
        "action": "fx:swell"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Tremolo Bar",
        "action": "fx:tremolobar"
      },
      {
        "label": "Wah Open",
        "action": "fx:wahopen"
      },
      {
        "label": "Wah Closed",
        "action": "fx:wahclosed"
      },
      {
        "label": "Rasgueado",
        "action": "fx:rasgueado"
      },
      {
        "label": "Left-Hand Tapping",
        "action": "fx:lefthandtap"
      },
      {
        "label": "Tapping",
        "action": "fx:tap"
      }
    ]
  },
  {
    "name": "Section",
    "items": [
      {
        "label": "Segno",
        "action": "dir:TargetSegno"
      },
      {
        "label": "Coda",
        "action": "dir:TargetCoda"
      },
      {
        "label": "Fine",
        "action": "dir:TargetFine"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Da Capo",
        "action": "dir:JumpDaCapo"
      },
      {
        "label": "Da Capo al Fine",
        "action": "dir:JumpDaCapoAlFine"
      },
      {
        "label": "Dal Segno",
        "action": "dir:JumpDalSegno"
      },
      {
        "label": "Dal Segno al Coda",
        "action": "dir:JumpDalSegnoAlCoda"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Fermata",
        "action": "fermata"
      }
    ]
  },
  {
    "name": "Tools",
    "items": [
      {
        "label": "Transpose...",
        "action": "transpose"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Metronome (toggle)",
        "action": "metronome"
      },
      {
        "label": "Count-in (toggle)",
        "action": "countin"
      },
      {
        "label": "Panic (All Notes Off)",
        "action": "panic"
      }
    ]
  },
  {
    "name": "Sound",
    "items": [
      {
        "label": "Play / Stop",
        "action": "play"
      },
      {
        "label": "Panic (All Notes Off)",
        "action": "panic"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Loop Selection",
        "action": "loopsel"
      },
      {
        "label": "Clear Loop",
        "action": "loopclear"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Metronome (toggle)",
        "action": "metronome"
      },
      {
        "label": "Count-in (toggle)",
        "action": "countin"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Live Input Monitor (toggle)",
        "action": "liveinput"
      },
      {
        "label": "Load Input Plugin (AU/VST3)...",
        "action": "loadplugin"
      },
      {
        "label": "Show Plugin Editor",
        "action": "showplugineditor"
      },
      {
        "label": "Clear Input Plugin",
        "action": "clearplugin"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Load SFZ Instrument for Track...",
        "action": "loadsfz"
      },
      {
        "label": "Clear SFZ Instrument for Track",
        "action": "clearsfz"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Record to WAV (toggle)...",
        "action": "record"
      }
    ]
  },
  {
    "name": "View",
    "items": [
      {
        "label": "Zoom In",
        "action": "zoom:in"
      },
      {
        "label": "Zoom Out",
        "action": "zoom:out"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Toggle Multitrack View",
        "action": "toggleview"
      },
      {
        "label": "Toggle Beat Grid",
        "action": "togglebeatgrid"
      },
      {
        "label": "Go To Bar...",
        "action": "gotobar"
      },
      {
        "label": "-",
        "action": ""
      },
      {
        "label": "Toggle Left Palette",
        "action": "toggle:palette"
      },
      {
        "label": "Toggle Right Inspector",
        "action": "toggle:inspector"
      },
      {
        "label": "Toggle Track List",
        "action": "toggle:tracks"
      },
      {
        "label": "Full View",
        "action": "fullscore"
      }
    ]
  },
  {
    "name": "Window",
    "items": [
      {
        "label": "Minimize",
        "action": "minimize"
      }
    ]
  },
  {
    "name": "Help",
    "items": [
      {
        "label": "About Gomidas",
        "action": "about"
      }
    ]
  }
];

  const api = { GOMIDAS_MENUS };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasMenus = api;
}());
