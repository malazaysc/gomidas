#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>
#include <vector>

struct tsf; // forward decl (TinySoundFont)

namespace gomidas
{
// Thin wrapper over TinySoundFont. After loadFromMemory()/prepare() on the
// message thread (before audio starts), all other methods are called ONLY from
// the audio thread. General MIDI: channel 9 is percussion.
class SoundFontSynth
{
public:
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
    void renderAdding (juce::AudioBuffer<float>& buffer, int startSample, int numSamples);

    bool isReady() const noexcept { return ready.load(); }

private:
    tsf* synth = nullptr;
    std::atomic<bool> ready { false };
    double currentSampleRate = 44100.0;
    std::vector<float> scratch; // interleaved stereo render target

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SoundFontSynth)
};
} // namespace gomidas
