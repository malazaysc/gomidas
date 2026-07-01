// Standalone smoke test for SoundFontSynth (TinySoundFont): load the bundled GM bank,
// play a note on a channel, render that channel's bus, assert non-silent output. Mirrors
// sfz_smoketest.cpp but for the DEFAULT MIDI sound path every track uses out of the box.
// Build with -DGOMIDAS_BUILD_TESTS=ON, then:
//   ./sf_smoketest assets/soundfont/sonivox.sf2 [key] [program]
#include "synth/SoundFontSynth.h"
#include <juce_audio_basics/juce_audio_basics.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>

int main (int argc, char** argv)
{
    if (argc < 2) { std::printf ("usage: sf_smoketest <file.sf2> [key] [program]\n"); return 2; }
    const int key     = (argc >= 3) ? std::atoi (argv[2]) : 60;   // middle C
    const int program = (argc >= 4) ? std::atoi (argv[3]) : 24;   // GM acoustic guitar (nylon)

    gomidas::SoundFontSynth synth;
    if (! synth.loadFromFile (juce::File (juce::String (argv[1])))) { std::printf ("FAIL: loadFromFile('%s')\n", argv[1]); return 1; }
    synth.prepare (44100.0);
    synth.programChange (0, program, false);
    synth.noteOn (0, key, 1.0f);

    juce::AudioBuffer<float> buf (2, 512);
    double sumSq = 0.0; long n = 0;
    for (int b = 0; b < 100; ++b)   // ~1.16 s at 44.1k / 512
    {
        buf.clear();
        // renderChannel overwrites the buffer when the channel has active voices, and
        // returns false (leaving it cleared) once the voice has finished.
        if (synth.renderChannel (0, buf, 512))
            for (int ch = 0; ch < 2; ++ch)
            {
                const float* d = buf.getReadPointer (ch);
                for (int i = 0; i < 512; ++i) { sumSq += (double) d[i] * d[i]; ++n; }
            }
        if (b == 4) synth.noteOff (0, key);   // release partway so we exercise the tail too
    }

    const double rms = n ? std::sqrt (sumSq / (double) n) : 0.0;
    std::printf ("output RMS: %.6f\n", rms);
    if (rms > 1e-4) { std::printf ("PASS: GM instrument produced audio\n"); return 0; }
    std::printf ("FAIL: output was silent\n");
    return 1;
}
