#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>

namespace sfz { class Sfizz; } // forward decl (sfizz engine)

namespace gomidas
{
// Per-channel SFZ sample engine (sfizz, BSD/ISC). Mirrors SoundFontSynth's per-channel
// model: ONE sfizz instance per MIDI channel, so a channel backed by an SFZ instrument
// flows through the exact same per-channel EQ / mix bus as a TinySoundFont channel.
//
// Threading (mirrors AudioEngine's pluginLock idiom):
//   * loadChannel/clearChannel run on the MESSAGE thread; they build+load a new sfizz
//     instance, then swap it in (freeing the old one) under sfzLock.
//   * The AUDIO thread touches sfizz instances ONLY between tryLock()/unlock().
//   * activeMask() is lock-free, so the audio thread can decide TSF-vs-SFZ routing
//     per channel WITHOUT dereferencing any instance — no data race on the pointers.
class SfzSynth
{
public:
    static constexpr int kNumChannels = 16;

    SfzSynth();
    ~SfzSynth();

    // Message thread. Safe to call before or after audio starts (re-applies to live
    // instances under the lock).
    void prepare (double sampleRate, int blockSize);

    // ---- message thread ----
    bool loadChannel (int channel, const juce::File& sfzFile);
    void clearChannel (int channel);

    // Bitmask of channels currently backed by an SFZ instrument. Lock-free; the audio
    // thread reads this to choose the render/route path without touching instances.
    std::uint16_t activeMask() const noexcept { return mask.load(); }

    // ---- audio thread: only between tryLock()/unlock() ----
    bool tryLock() noexcept { return sfzLock.tryEnter(); }
    void unlock()  noexcept { sfzLock.exit(); }

    void noteOn  (int channel, int key, float velocity);   // velocity 0..1
    void noteOff (int channel, int key);
    void pitchWheel    (int channel, int value14);          // 0..16383 (8192 = centre)
    void controlChange (int channel, int cc, int value);    // value 0..127
    void allNotesOff();

    // Render ONE channel's stereo output, OVERWRITING `stereo`. Returns false (buffer
    // untouched) when the channel has no SFZ instance or no active voices, so the engine
    // can skip silent channels cheaply.
    bool renderChannel (int channel, juce::AudioBuffer<float>& stereo, int numSamples);

private:
    double sampleRate = 44100.0;
    int    blockSize  = 512;

    juce::SpinLock sfzLock;
    std::array<std::unique_ptr<sfz::Sfizz>, kNumChannels> chan; // freed on the message thread, under sfzLock
    std::atomic<std::uint16_t> mask { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SfzSynth)
};
} // namespace gomidas
