#include "SfzSynth.h"
#include <sfizz.hpp>
#include <cmath>

namespace gomidas
{
SfzSynth::SfzSynth() = default;
SfzSynth::~SfzSynth() = default;

void SfzSynth::prepare (double sr, int bs)
{
    sampleRate = sr;
    blockSize  = bs;
    const juce::SpinLock::ScopedLockType sl (sfzLock);
    for (auto& s : chan)
        if (s != nullptr)
        {
            s->setSampleRate ((float) sampleRate);
            s->setSamplesPerBlock (blockSize);
        }
}

bool SfzSynth::loadChannel (int channel, const juce::File& sfzFile)
{
    if (channel < 0 || channel >= kNumChannels || ! sfzFile.existsAsFile())
        return false;

    // Build + load the new instance OFF the audio thread (loadSfzFile is not RT-safe).
    auto inst = std::make_unique<sfz::Sfizz>();
    inst->setSampleRate ((float) sampleRate);
    inst->setSamplesPerBlock (blockSize);
    if (! inst->loadSfzFile (sfzFile.getFullPathName().toStdString()))
        return false;

    // Swap under the lock so the audio thread (which only touches instances while
    // holding the lock) can never observe the old instance being freed.
    {
        const juce::SpinLock::ScopedLockType sl (sfzLock);
        chan[channel] = std::move (inst);   // frees the previous instance here, under lock
    }
    mask.fetch_or ((std::uint16_t) (1u << channel));
    return true;
}

void SfzSynth::clearChannel (int channel)
{
    if (channel < 0 || channel >= kNumChannels)
        return;
    mask.fetch_and ((std::uint16_t) ~(1u << channel));   // stop routing to it first
    const juce::SpinLock::ScopedLockType sl (sfzLock);
    chan[channel].reset();                               // freed on the message thread, under lock
}

void SfzSynth::noteOn (int channel, int key, float velocity)
{
    if (channel < 0 || channel >= kNumChannels) return;
    if (auto* s = chan[channel].get())
    {
        const int v = juce::jlimit (1, 127, (int) std::lround (velocity * 127.0f));
        s->noteOn (0, key, v);
    }
}

void SfzSynth::noteOff (int channel, int key)
{
    if (channel < 0 || channel >= kNumChannels) return;
    if (auto* s = chan[channel].get())
        s->noteOff (0, key, 0);
}

void SfzSynth::pitchWheel (int channel, int value14)
{
    if (channel < 0 || channel >= kNumChannels) return;
    if (auto* s = chan[channel].get())
        s->pitchWheel (0, juce::jlimit (-8192, 8191, value14 - 8192));
}

void SfzSynth::controlChange (int channel, int cc, int value)
{
    if (channel < 0 || channel >= kNumChannels) return;
    if (auto* s = chan[channel].get())
        s->cc (0, cc, juce::jlimit (0, 127, value));
}

void SfzSynth::allNotesOff()
{
    for (auto& s : chan)
        if (s != nullptr)
            s->allSoundOff();
}

bool SfzSynth::renderChannel (int channel, juce::AudioBuffer<float>& stereo, int numSamples, bool force)
{
    if (channel < 0 || channel >= kNumChannels) return false;
    auto* s = chan[channel].get();
    if (s == nullptr) return false;
    if (s->getNumActiveVoices() == 0 && ! force)
        return false;

    stereo.clear();
    float* ptrs[2] = { stereo.getWritePointer (0), stereo.getWritePointer (1) };
    s->renderBlock (ptrs, (size_t) numSamples, 1);   // numOutputs=1 → one stereo pair
    return true;
}
} // namespace gomidas
