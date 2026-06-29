#include "SoundFontSynth.h"

#define TSF_IMPLEMENTATION
#include "tsf/tsf.h"

namespace gomidas
{
SoundFontSynth::SoundFontSynth() = default;

SoundFontSynth::~SoundFontSynth()
{
    closeAll();
}

void SoundFontSynth::closeAll()
{
    // Close the per-channel copies first, then the template. tsf_close refcounts the
    // shared soundfont data and frees it only when the last holder closes (order-safe).
    for (auto*& c : chan)
        if (c != nullptr) { tsf_close (c); c = nullptr; }
    if (templateSynth != nullptr) { tsf_close (templateSynth); templateSynth = nullptr; }
}

void SoundFontSynth::configureInstance (tsf* inst)
{
    if (inst == nullptr) return;
    // Enable the MIDI bank/channel model so channel 9 maps to the percussion bank.
    tsf_channel_set_bank_preset (inst, 0, 0, 0);
    tsf_set_output (inst, TSF_STEREO_INTERLEAVED, (int) currentSampleRate, 0.0f);
    tsf_set_volume (inst, 1.0f);
}

bool SoundFontSynth::loadFromMemory (const void* sf2Data, int numBytes)
{
    ready.store (false);
    closeAll();

    templateSynth = tsf_load_memory (sf2Data, numBytes);
    if (templateSynth == nullptr)
        return false;

    configureInstance (templateSynth);
    for (int i = 0; i < kNumChannels; ++i)
    {
        chan[i] = tsf_copy (templateSynth);   // shares samples; own voice/channel state
        configureInstance (chan[i]);
    }
    return true;
}

bool SoundFontSynth::loadFromFile (const juce::File& sf2File)
{
    if (! sf2File.existsAsFile())
        return false;

    ready.store (false);
    closeAll();

    templateSynth = tsf_load_filename (sf2File.getFullPathName().toRawUTF8());
    if (templateSynth == nullptr)
        return false;

    configureInstance (templateSynth);
    for (int i = 0; i < kNumChannels; ++i)
    {
        chan[i] = tsf_copy (templateSynth);
        configureInstance (chan[i]);
    }
    return true;
}

void SoundFontSynth::prepare (double sampleRate)
{
    currentSampleRate = sampleRate;
    if (templateSynth == nullptr)
        return;
    for (int i = 0; i < kNumChannels; ++i)
        if (chan[i] != nullptr)
        {
            tsf_set_output (chan[i], TSF_STEREO_INTERLEAVED, (int) sampleRate, 0.0f);
            tsf_set_volume (chan[i], 1.0f);
        }
    ready.store (true);
}

void SoundFontSynth::programChange (int channel, int program, bool isPercussion)
{
    if (channel < 0 || channel >= kNumChannels || chan[channel] == nullptr) return;
    // flag_mididrums != 0 selects the percussion bank (128) for this channel.
    tsf_channel_set_presetnumber (chan[channel], channel, program, isPercussion ? 1 : 0);
}

void SoundFontSynth::noteOn (int channel, int key, float velocity)
{
    if (channel < 0 || channel >= kNumChannels || chan[channel] == nullptr) return;
    tsf_channel_note_on (chan[channel], channel, key, velocity);
}

void SoundFontSynth::noteOff (int channel, int key)
{
    if (channel < 0 || channel >= kNumChannels || chan[channel] == nullptr) return;
    tsf_channel_note_off (chan[channel], channel, key);
}

void SoundFontSynth::setChannelVolume (int channel, float volume)
{
    if (channel < 0 || channel >= kNumChannels || chan[channel] == nullptr) return;
    tsf_channel_set_volume (chan[channel], channel, juce::jmax (0.0f, volume));
}

void SoundFontSynth::setChannelPan (int channel, float pan)
{
    if (channel < 0 || channel >= kNumChannels || chan[channel] == nullptr) return;
    tsf_channel_set_pan (chan[channel], channel, juce::jlimit (0.0f, 1.0f, pan));
}

void SoundFontSynth::allNotesOff()
{
    for (int i = 0; i < kNumChannels; ++i)
        if (chan[i] != nullptr) tsf_note_off_all (chan[i]);
}

bool SoundFontSynth::renderChannel (int channel, juce::AudioBuffer<float>& stereo, int numSamples)
{
    if (channel < 0 || channel >= kNumChannels || chan[channel] == nullptr
        || ! ready.load() || numSamples <= 0)
        return false;

    // Skip channels with nothing sounding (note: a released note's decay tail still
    // counts as an active voice, so the tail renders correctly).
    if (tsf_active_voice_count (chan[channel]) <= 0)
        return false;

    const auto needed = (size_t) numSamples * 2;
    if (scratch.size() < needed)
        scratch.resize (needed);

    // flag_mixing = 0 -> overwrite scratch with this channel's output.
    tsf_render_float (chan[channel], scratch.data(), numSamples, 0);

    const int outChans = stereo.getNumChannels();
    auto* left  = stereo.getWritePointer (juce::jmin (0, outChans - 1));
    auto* right = stereo.getWritePointer (juce::jmin (1, outChans - 1));
    for (int i = 0; i < numSamples; ++i)
    {
        left[i]  = scratch[(size_t) i * 2];
        right[i] = scratch[(size_t) i * 2 + 1];
    }
    return true;
}
} // namespace gomidas
