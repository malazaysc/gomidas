// Standalone smoke test: load an SFZ with sfizz, play a note, assert non-silent output.
// Verifies the core SFZ -> audio path (incl. FLAC decoding via sfizz's vendored loader)
// outside the GUI. Build with -DGOMIDAS_BUILD_TESTS=ON, then:
//   ./sfz_smoketest assets/instruments/classical-guitar/classical-guitar.sfz
#include <sfizz.hpp>
#include <cmath>
#include <cstdio>
#include <vector>

int main (int argc, char** argv)
{
    if (argc < 2) { std::printf ("usage: sfz_smoketest <file.sfz> [midiNote]\n"); return 2; }
    const int note = (argc >= 3) ? std::atoi (argv[2]) : 60;   // default middle C

    sfz::Sfizz s;
    s.setSampleRate (44100.0f);
    s.setSamplesPerBlock (512);
    if (! s.loadSfzFile (argv[1])) { std::printf ("FAIL: loadSfzFile('%s')\n", argv[1]); return 1; }

    s.noteOn (0, note, 100);

    double sumSq = 0.0; long n = 0; int peakVoices = 0;
    std::vector<float> L (512), R (512);
    for (int b = 0; b < 100; ++b)   // ~1.16 s at 44.1k/512
    {
        float* ptrs[2] = { L.data(), R.data() };
        s.renderBlock (ptrs, 512, 1);
        peakVoices = std::max (peakVoices, s.getNumActiveVoices());
        for (int i = 0; i < 512; ++i) { sumSq += (double) L[i]*L[i] + (double) R[i]*R[i]; n += 2; }
        if (b == 4) s.noteOff (0, note, 0);   // release partway so we also exercise the tail
    }

    const double rms = std::sqrt (sumSq / (double) n);
    std::printf ("peak active voices: %d, output RMS: %.6f\n", peakVoices, rms);
    if (rms > 1e-4) { std::printf ("PASS: instrument produced audio\n"); return 0; }
    std::printf ("FAIL: output was silent\n");
    return 1;
}
