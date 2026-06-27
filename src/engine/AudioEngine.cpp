#include "AudioEngine.h"
#include "GomidasAssets.h" // embedded binary data (juce_add_binary_data)

namespace gomidas
{
AudioEngine::AudioEngine()
{
    for (auto& p : currentProgram) p = -1;
    for (int i = 0; i < 16; ++i) { channelGain[i].store (1.0f); channelPan[i].store (0.5f); }
}

AudioEngine::~AudioEngine()
{
    shutdown();
}

void AudioEngine::initialise()
{
    // Prefer the high-quality FluidR3 SoundFont bundled in Resources; fall back
    // to the small embedded sonivox bank if it isn't present.
    bool loaded = false;
    auto appFile = juce::File::getSpecialLocation (juce::File::currentApplicationFile);
    auto fluid = appFile.getChildFile ("Contents/Resources/FluidR3_GM.sf2");
    if (fluid.existsAsFile())
        loaded = synth.loadFromFile (fluid);
    if (! loaded)
    {
        int sfSize = 0;
        if (const char* sf = GomidasAssets::getNamedResource ("sonivox_sf2", sfSize))
            loaded = synth.loadFromMemory (sf, sfSize);
    }
    juce::Logger::writeToLog (loaded ? (fluid.existsAsFile() ? "SoundFont: FluidR3" : "SoundFont: sonivox")
                                     : "SoundFont: FAILED");

    deviceManager.initialiseWithDefaultDevices (0, 2);
    deviceManager.addAudioCallback (this);
}

void AudioEngine::shutdown()
{
    deviceManager.removeAudioCallback (this);
    deviceManager.closeAudioDevice();
}

void AudioEngine::setSequence (Sequence::Ptr newSequence)
{
    const juce::SpinLock::ScopedLockType sl (sequenceLock);
    incomingSequence = std::move (newSequence);
}

void AudioEngine::play()
{
    playing.store (true);
}

void AudioEngine::stop()
{
    playing.store (false);
    seekRequest.store (0.0);
    flushRequested.store (true);
}

void AudioEngine::seekTicks (double tick)
{
    seekRequest.store (juce::jmax (0.0, tick));
    flushRequested.store (true);
}

void AudioEngine::setChannelMix (int channel, float gain, float pan)
{
    if (channel < 0 || channel > 15) return;
    channelGain[channel].store (juce::jmax (0.0f, gain));
    channelPan[channel].store (juce::jlimit (0.0f, 1.0f, pan));
    mixDirty.store (true);
}

void AudioEngine::previewNotes (int channel, int program, bool percussion, std::vector<int> keys)
{
    const juce::SpinLock::ScopedLockType sl (previewLock);
    pendingPreview.channel = channel;
    pendingPreview.program = program;
    pendingPreview.percussion = percussion;
    pendingPreview.keys = std::move (keys);
    previewPending.store (true);
}

void AudioEngine::resetCursorForTick (double tick)
{
    positionTicks = tick;
    nextEventIndex = 0;
    if (activeSequence != nullptr)
        while (nextEventIndex < activeSequence->events.size()
               && activeSequence->events[nextEventIndex].tick < tick)
            ++nextEventIndex;
}

void AudioEngine::applyEvent (const NoteEvent& e)
{
    if (e.on)
    {
        if (currentProgram[e.channel] != e.program)
        {
            synth.programChange (e.channel, e.program, e.percussion);
            currentProgram[e.channel] = e.program;
        }
        synth.noteOn (e.channel, e.key, e.velocity);
    }
    else
    {
        synth.noteOff (e.channel, e.key);
    }
}

void AudioEngine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    sampleRate = device->getCurrentSampleRate();
    synth.prepare (sampleRate);
    renderBuffer.setSize (2, device->getCurrentBufferSizeSamples(), false, false, true);
}

void AudioEngine::audioDeviceStopped() {}

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const*,
                                                    int,
                                                    float* const* outputChannelData,
                                                    int numOutputChannels,
                                                    int numSamples,
                                                    const juce::AudioIODeviceCallbackContext&)
{
    // Clear outputs.
    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr)
            juce::FloatVectorOperations::clear (outputChannelData[ch], numSamples);

    // Pick up a newly-built sequence without blocking the message thread.
    if (sequenceLock.tryEnter())
    {
        if (incomingSequence != nullptr)
        {
            activeSequence = incomingSequence;
            incomingSequence = nullptr;
            resetCursorForTick (positionTicks);
        }
        sequenceLock.exit();
    }

    if (flushRequested.exchange (false))
        synth.allNotesOff();

    // Editor audition: trigger a note/chord immediately, auto-release after ~0.8s.
    if (previewPending.load() && previewLock.tryEnter())
    {
        for (int k : previewActive) synth.noteOff (previewChannel, k);
        previewActive.clear();
        if (synth.isReady())
        {
            if (currentProgram[pendingPreview.channel] != pendingPreview.program)
            {
                synth.programChange (pendingPreview.channel, pendingPreview.program, pendingPreview.percussion);
                currentProgram[pendingPreview.channel] = pendingPreview.program;
            }
            previewChannel = pendingPreview.channel;
            for (int k : pendingPreview.keys)
            {
                synth.noteOn (previewChannel, k, 0.85f);
                previewActive.push_back (k);
            }
            previewSamplesLeft = (int) (sampleRate * 0.8);
        }
        previewPending.store (false);
        previewLock.exit();
    }
    if (previewSamplesLeft > 0)
    {
        previewSamplesLeft -= numSamples;
        if (previewSamplesLeft <= 0)
        {
            for (int k : previewActive) synth.noteOff (previewChannel, k);
            previewActive.clear();
        }
    }

    if (const double sr = seekRequest.exchange (-1.0); sr >= 0.0)
        resetCursorForTick (sr);

    // Push any pending per-track mixer changes into the synth (audio-thread only).
    if (synth.isReady() && mixDirty.exchange (false))
        for (int ch = 0; ch < 16; ++ch)
        {
            synth.setChannelVolume (ch, channelGain[ch].load());
            synth.setChannelPan (ch, channelPan[ch].load());
        }

    if (! synth.isReady())
    {
        reportedTicks.store (positionTicks);
        return;
    }

    if (playing.load() && activeSequence != nullptr)
    {
        const double ticksPerSample = tempoBpm.load() / 60.0 * (double) kPPQ / sampleRate;
        const double startTick = positionTicks;
        double endTick = startTick + ticksPerSample * numSamples;

        const auto& events = activeSequence->events;
        while (nextEventIndex < events.size() && events[nextEventIndex].tick < endTick)
        {
            applyEvent (events[nextEventIndex]);
            ++nextEventIndex;
        }

        const double len = activeSequence->lengthTicks;
        if (len > 0.0 && endTick >= len)
        {
            if (looping.load())
            {
                synth.allNotesOff();
                endTick -= len;
                nextEventIndex = 0;
                // fire events that fall in the wrapped region [0, endTick)
                while (nextEventIndex < events.size() && events[nextEventIndex].tick < endTick)
                {
                    applyEvent (events[nextEventIndex]);
                    ++nextEventIndex;
                }
            }
            else
            {
                playing.store (false);
                synth.allNotesOff();
                endTick = 0.0;
                nextEventIndex = 0;
            }
        }

        positionTicks = endTick;
    }

    // Render the synth into our stereo scratch buffer then copy to outputs.
    renderBuffer.setSize (2, numSamples, false, false, true);
    renderBuffer.clear();
    synth.renderAdding (renderBuffer, 0, numSamples);

    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr)
            juce::FloatVectorOperations::copy (outputChannelData[ch],
                                               renderBuffer.getReadPointer (juce::jmin (ch, 1)),
                                               numSamples);

    outputPeak.store (renderBuffer.getMagnitude (0, numSamples));
    reportedTicks.store (positionTicks);
}
} // namespace gomidas
