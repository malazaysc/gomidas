#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include "synth/SoundFontSynth.h"
#include <atomic>
#include <vector>

namespace gomidas
{
// One scheduled MIDI note boundary, in ticks at 960 PPQ (matches alphaTab).
struct NoteEvent
{
    double tick = 0.0;
    int    channel = 0;
    int    key = 0;
    float  velocity = 0.0f; // 0..1, ignored for note-off
    bool   on = false;
    int    program = 0;
    bool   percussion = false;
};

struct Sequence : public juce::ReferenceCountedObject
{
    using Ptr = juce::ReferenceCountedObjectPtr<Sequence>;
    std::vector<NoteEvent> events;   // sorted ascending by tick
    double lengthTicks = 0.0;
};

// Owns the audio device, the SoundFont synth, the transport clock and the
// playback scheduler. The active Sequence is produced on the message thread
// (from alphaTab's score model) and swapped in lock-free on the audio thread.
class AudioEngine : private juce::AudioIODeviceCallback
{
public:
    static constexpr int kPPQ = 960;

    AudioEngine();
    ~AudioEngine() override;

    void initialise();           // opens the default audio device
    void shutdown();

    // ---- message thread control ----
    void setSequence (Sequence::Ptr newSequence);
    void play();
    void stop();
    void setLooping (bool shouldLoop) { looping.store (shouldLoop); }
    void setTempoBpm (double bpm)     { tempoBpm.store (juce::jlimit (20.0, 400.0, bpm)); }
    void seekTicks (double tick);

    // Per-track mixer: gain is a linear scale (1.0 = unity, 0.0 = silent → mute/solo),
    // pan is 0..1 (0.5 = centre). Keyed by MIDI channel; applied on the audio thread.
    void setChannelMix (int channel, float gain, float pan);

    // Audition a note/chord immediately (editor feedback), independent of transport.
    void previewNotes (int channel, int program, bool percussion, std::vector<int> keys);

    bool   isPlaying() const noexcept       { return playing.load(); }
    double getPositionTicks() const noexcept { return reportedTicks.load(); }
    double getTempoBpm() const noexcept      { return tempoBpm.load(); }
    float  getOutputPeak() const noexcept    { return outputPeak.load(); }

private:
    // AudioIODeviceCallback
    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;

    void applyEvent (const NoteEvent& e);

    juce::AudioDeviceManager deviceManager;
    SoundFontSynth synth;

    // transport (positionTicks/cursor are audio-thread owned)
    std::atomic<bool>   playing { false };
    std::atomic<bool>   looping { true };
    std::atomic<double> tempoBpm { 120.0 };
    std::atomic<double> reportedTicks { 0.0 };
    std::atomic<float>  outputPeak { 0.0f };
    std::atomic<bool>   flushRequested { false };
    std::atomic<double> seekRequest { -1.0 };

    // mixer (per MIDI channel) — message thread writes, audio thread applies on dirty
    std::atomic<float>  channelGain[16];
    std::atomic<float>  channelPan[16];
    std::atomic<bool>   mixDirty { false };

    double sampleRate = 44100.0;
    double positionTicks = 0.0;
    size_t nextEventIndex = 0;
    int currentProgram[16];

    // sequence hand-off
    juce::SpinLock sequenceLock;
    Sequence::Ptr incomingSequence; // guarded by sequenceLock
    Sequence::Ptr activeSequence;   // audio-thread only

    // preview/audition (editor feedback)
    struct PreviewReq { int channel = 0; int program = 0; bool percussion = false; std::vector<int> keys; };
    juce::SpinLock previewLock;
    PreviewReq pendingPreview;        // guarded by previewLock
    std::atomic<bool> previewPending { false };
    std::vector<int> previewActive;   // audio-thread only
    int previewChannel = 0;
    int previewSamplesLeft = 0;

    juce::AudioBuffer<float> renderBuffer;

    void resetCursorForTick (double tick);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AudioEngine)
};
} // namespace gomidas
