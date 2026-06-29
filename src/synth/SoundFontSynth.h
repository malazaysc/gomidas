#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>
#include <vector>

struct tsf; // forward decl (TinySoundFont)

namespace gomidas
{
// Thin wrapper over TinySoundFont. To give every track its own audio bus (so the
// engine can EQ each track independently), we keep ONE tsf instance per MIDI channel,
// created with tsf_copy() from a shared template (tsf_copy refcounts the soundfont
// sample data, so the 16 copies are cheap). After loadFromMemory()/prepare() on the
// message thread (before audio starts), all other methods are called ONLY from the
// audio thread. General MIDI: channel 9 is percussion.
class SoundFontSynth
{
public:
    static constexpr int kNumChannels = 16;

    SoundFontSynth();
    ~SoundFontSynth();

    // Message thread, before playback.
    bool loadFromMemory (const void* sf2Data, int numBytes);
    bool loadFromFile (const juce::File& sf2File);
    void prepare (double sampleRate);

    // Audio thread only.
    void programChange (int channel, int program, bool isPercussion);
    void noteOn (int channel, int key, float velocity);   // velocity 0..1
    void noteOff (int channel, int key);
    void setChannelVolume (int channel, float volume);    // linear gain (1.0 = full), affects ringing voices
    void setChannelPan (int channel, float pan);          // 0..1 (0.5 = centre)
    void allNotesOff();

    // Render ONE channel's audio into `stereo` (>=2 channels, numSamples), OVERWRITING
    // it. Returns false (leaving `stereo` untouched) when the channel has no active
    // voices, so the engine can skip silent tracks cheaply.
    bool renderChannel (int channel, juce::AudioBuffer<float>& stereo, int numSamples);

    bool isReady() const noexcept { return ready.load(); }

private:
    void closeAll();
    void configureInstance (tsf* inst);

    tsf* templateSynth = nullptr;        // shared soundfont source for the per-channel copies
    tsf* chan[kNumChannels] = {};        // one instance per MIDI channel
    std::atomic<bool> ready { false };
    double currentSampleRate = 44100.0;
    std::vector<float> scratch;          // interleaved stereo render target (reused per channel)

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SoundFontSynth)
};
} // namespace gomidas
