#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include "synth/SoundFontSynth.h"
#include <atomic>
#include <memory>
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
    void panic();   // stop + force all notes off (clears any stuck/ringing voices)
    void setLooping (bool shouldLoop) { looping.store (shouldLoop); }
    void setTempoBpm (double bpm)     { tempoBpm.store (juce::jlimit (20.0, 400.0, bpm)); }
    // Practice speed: scales playback tempo without changing the notated tempo (pitch is
    // unaffected — playback is re-sequenced MIDI, not time-stretched audio).
    void setPlaybackRate (double rate) { playbackRate.store (juce::jlimit (0.1, 4.0, rate)); }
    void seekTicks (double tick);
    // A/B loop: play [startTick, endTick) on repeat. start < 0 (or end <= start) disables it,
    // falling back to whole-sequence looping.
    void setLoopRange (double startTick, double endTick)
    {
        loopStart.store (startTick);
        loopEnd.store   (endTick);
    }

    // Per-track mixer: gain is a linear scale (1.0 = unity, 0.0 = silent → mute/solo),
    // pan is 0..1 (0.5 = centre). Keyed by MIDI channel; applied on the audio thread.
    void setChannelMix (int channel, float gain, float pan);

    // Live input monitoring: reopen the device with an input bus and mix the input into
    // the output. Reverts to output-only if the input device can't open (e.g. permission
    // denied). Message-thread only (reinitialises the device). Returns true if input is on.
    bool setLiveInput (bool enabled, float gain);
    bool isLiveInput() const noexcept { return liveInputOn.load(); }

    // Live-input plugin insert (one VST3/AU effect or instrument). Loaded on the message
    // thread and swapped to the audio thread under a SpinLock; processes the captured
    // input before it's mixed to the output. Returns false if the file isn't a plugin.
    bool loadInputPlugin (const juce::File& file);
    void clearInputPlugin();
    juce::String inputPluginName() const { return inputPluginDisplayName; }
    // The loaded plugin instance for building its editor (message thread only). Close
    // any open editor BEFORE load/clear — they free the instance under the plugin lock.
    juce::AudioPluginInstance* pluginForEditor() noexcept { return ownedPlugin.get(); }

    // Record the output mix (backing tracks + live input) to a .wav. RT-safe via a
    // background ThreadedWriter. Message-thread start/stop.
    bool startRecording (const juce::File& file);
    void stopRecording();
    bool isRecording() const noexcept { return activeWriter.load() != nullptr; }

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
    std::atomic<double> playbackRate { 1.0 };   // practice-speed multiplier
    std::atomic<double> reportedTicks { 0.0 };
    std::atomic<float>  outputPeak { 0.0f };
    std::atomic<bool>   flushRequested { false };
    std::atomic<double> seekRequest { -1.0 };
    std::atomic<bool>   panicRequested { false };
    std::atomic<double> loopStart { -1.0 };   // A/B loop start tick (-1 = disabled)
    std::atomic<double> loopEnd   { -1.0 };   // A/B loop end tick

    // mixer (per MIDI channel) — message thread writes, audio thread applies on dirty
    std::atomic<float>  channelGain[16];
    std::atomic<float>  channelPan[16];
    std::atomic<bool>   mixDirty { false };

    // live input monitoring (audio thread reads; message thread reopens the device)
    std::atomic<bool>   liveInputOn { false };
    std::atomic<float>  inputGain { 1.0f };

    // live-input plugin insert
    int currentBlockSize() const;
    juce::AudioPluginFormatManager pluginFormatManager;
    std::unique_ptr<juce::AudioPluginInstance> ownedPlugin;   // message-thread owned (also editor)
    juce::AudioPluginInstance* activePluginPtr = nullptr;     // audio thread reads (under pluginLock)
    juce::SpinLock      pluginLock;
    juce::AudioBuffer<float> inputScratch;
    juce::String        inputPluginDisplayName;

    // recording (output mix -> wav, background-thread writer)
    juce::TimeSliceThread recordThread { "gomidas-rec" };
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> threadedWriter;
    juce::CriticalSection writerLock;
    std::atomic<juce::AudioFormatWriter::ThreadedWriter*> activeWriter { nullptr };

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
