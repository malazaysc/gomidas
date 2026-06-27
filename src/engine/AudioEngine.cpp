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

    juce::addDefaultFormatsToManager (pluginFormatManager);   // AU + VST3 hosts, with UI (JUCE 8 API)

    deviceManager.initialiseWithDefaultDevices (0, 2);
    deviceManager.addAudioCallback (this);
}

int AudioEngine::currentBlockSize() const
{
    if (auto* dev = deviceManager.getCurrentAudioDevice())
        return dev->getCurrentBufferSizeSamples();
    return 512;
}

bool AudioEngine::loadInputPlugin (const juce::File& file)
{
    juce::OwnedArray<juce::PluginDescription> descs;
    for (auto* fmt : pluginFormatManager.getFormats())
        fmt->findAllTypesForFile (descs, file.getFullPathName());
    if (descs.isEmpty())
        return false;

    juce::String err;
    const double sr = (sampleRate > 0.0 ? sampleRate : 44100.0);
    const int    bs = currentBlockSize();
    auto inst = pluginFormatManager.createPluginInstance (*descs[0], sr, bs, err);
    if (inst == nullptr)
    {
        juce::Logger::writeToLog ("plugin load failed: " + err);
        return false;
    }
    inst->setPlayConfigDetails (2, 2, sr, bs);
    inst->prepareToPlay (sr, bs);
    const juce::String name = descs[0]->name;

    // Swap under the lock so the audio thread (which only touches the plugin while
    // holding the lock) can never see the old instance being freed.
    const juce::SpinLock::ScopedLockType sl (pluginLock);
    activePluginPtr = nullptr;
    ownedPlugin = std::move (inst);       // frees the previous plugin here, under lock
    activePluginPtr = ownedPlugin.get();
    inputPluginDisplayName = name;
    return true;
}

void AudioEngine::clearInputPlugin()
{
    const juce::SpinLock::ScopedLockType sl (pluginLock);
    activePluginPtr = nullptr;
    ownedPlugin.reset();
    inputPluginDisplayName = {};
}

bool AudioEngine::startRecording (const juce::File& file)
{
    stopRecording();
    file.deleteFile();
    const double sr = (sampleRate > 0.0 ? sampleRate : 44100.0);
    if (auto stream = file.createOutputStream())
    {
        juce::WavAudioFormat wav;
        if (auto* writer = wav.createWriterFor (stream.get(), sr, 2, 24, {}, 0))
        {
            stream.release();   // the writer owns the stream now
            if (! recordThread.isThreadRunning())
                recordThread.startThread();
            threadedWriter.reset (new juce::AudioFormatWriter::ThreadedWriter (writer, recordThread, 32768));
            const juce::ScopedLock sl (writerLock);
            activeWriter = threadedWriter.get();
            return true;
        }
    }
    return false;
}

void AudioEngine::stopRecording()
{
    { const juce::ScopedLock sl (writerLock); activeWriter = nullptr; }
    threadedWriter.reset();   // flushes remaining samples to disk
}

void AudioEngine::shutdown()
{
    deviceManager.removeAudioCallback (this);
    deviceManager.closeAudioDevice();
}

bool AudioEngine::setLiveInput (bool enabled, float gain)
{
    inputGain.store (juce::jlimit (0.0f, 4.0f, gain));
    if (enabled == liveInputOn.load())
        return liveInputOn.load();

    // Reopen the device with (or without) an input bus. On macOS this triggers the mic
    // permission prompt the first time input is requested.
    deviceManager.removeAudioCallback (this);
    deviceManager.closeAudioDevice();
    auto err = deviceManager.initialiseWithDefaultDevices (enabled ? 2 : 0, 2);
    if (err.isNotEmpty() && enabled)
    {
        // Input failed (no device / permission denied) — fall back to output-only.
        juce::Logger::writeToLog ("live input failed: " + err);
        deviceManager.initialiseWithDefaultDevices (0, 2);
        liveInputOn.store (false);
    }
    else
    {
        liveInputOn.store (enabled);
    }
    deviceManager.addAudioCallback (this);
    return liveInputOn.load();
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

void AudioEngine::panic()
{
    playing.store (false);
    panicRequested.store (true);
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

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                                    int numInputChannels,
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

    if (panicRequested.exchange (false) && synth.isReady())
        synth.allNotesOff();

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
        const double ticksPerSample = tempoBpm.load() * playbackRate.load() / 60.0 * (double) kPPQ / sampleRate;
        const double startTick = positionTicks;
        double endTick = startTick + ticksPerSample * numSamples;

        const auto& events = activeSequence->events;
        while (nextEventIndex < events.size() && events[nextEventIndex].tick < endTick)
        {
            applyEvent (events[nextEventIndex]);
            ++nextEventIndex;
        }

        const double len = activeSequence->lengthTicks;
        // An A/B loop (when set) takes precedence over whole-sequence looping.
        const double aStart = loopStart.load();
        const double aEnd   = loopEnd.load();
        const bool   abActive = (aStart >= 0.0 && aEnd > aStart);
        const double wrapEnd = abActive ? aEnd   : len;
        const double wrapTo  = abActive ? aStart : 0.0;
        const bool   doLoop  = abActive ? true   : looping.load();

        if (wrapEnd > 0.0 && endTick >= wrapEnd)
        {
            if (doLoop)
            {
                synth.allNotesOff();
                endTick = wrapTo + (endTick - wrapEnd);
                nextEventIndex = 0;
                while (nextEventIndex < events.size() && events[nextEventIndex].tick < wrapTo)
                    ++nextEventIndex;
                // fire events that fall in the wrapped region [wrapTo, endTick)
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

    // Live input monitoring: capture the input into a stereo scratch buffer, run it
    // through the insert plugin (if any), then mix to the output (post-synth).
    if (liveInputOn.load() && inputChannelData != nullptr && numInputChannels > 0)
    {
        inputScratch.setSize (2, numSamples, false, false, true);
        for (int ch = 0; ch < 2; ++ch)
        {
            const int inCh = juce::jmin (ch, numInputChannels - 1);
            if (inputChannelData[inCh] != nullptr)
                inputScratch.copyFrom (ch, 0, inputChannelData[inCh], numSamples);
            else
                inputScratch.clear (ch, 0, numSamples);
        }

        // Only touch the plugin under the lock — the message thread holds it while
        // swapping/freeing, so we skip processing (dry) for that one block instead.
        if (pluginLock.tryEnter())
        {
            if (activePluginPtr != nullptr)
            {
                juce::MidiBuffer noMidi;
                activePluginPtr->processBlock (inputScratch, noMidi);
            }
            pluginLock.exit();
        }

        const float g = inputGain.load();
        for (int ch = 0; ch < numOutputChannels; ++ch)
            if (outputChannelData[ch] != nullptr)
                juce::FloatVectorOperations::addWithMultiply (outputChannelData[ch],
                                                              inputScratch.getReadPointer (juce::jmin (ch, 1)),
                                                              g, numSamples);
    }

    // Capture the output mix to disk (RT-safe: hand samples to the background writer).
    {
        const juce::ScopedLock sl (writerLock);
        if (auto* w = activeWriter.load())
        {
            const float* chans[2];
            chans[0] = numOutputChannels > 0 ? outputChannelData[0] : nullptr;
            chans[1] = numOutputChannels > 1 ? outputChannelData[1] : chans[0];
            if (chans[0] != nullptr)
                w->write (chans, numSamples);
        }
    }

    outputPeak.store (renderBuffer.getMagnitude (0, numSamples));
    reportedTicks.store (positionTicks);
}
} // namespace gomidas
