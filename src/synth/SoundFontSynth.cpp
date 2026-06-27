#include "SoundFontSynth.h"

#define TSF_IMPLEMENTATION
#include "tsf/tsf.h"

namespace gomidas
{
SoundFontSynth::SoundFontSynth() = default;

SoundFontSynth::~SoundFontSynth()
{
    if (synth != nullptr)
        tsf_close (synth);
}

bool SoundFontSynth::loadFromMemory (const void* sf2Data, int numBytes)
{
    ready.store (false);

    if (synth != nullptr)
    {
        tsf_close (synth);
        synth = nullptr;
    }

    synth = tsf_load_memory (sf2Data, numBytes);
    if (synth == nullptr)
        return false;

    // Enable the MIDI bank/channel model so channel 9 maps to the percussion bank.
    tsf_channel_set_bank_preset (synth, 0, 0, 0);
    tsf_set_output (synth, TSF_STEREO_INTERLEAVED, (int) currentSampleRate, 0.0f);
    return true;
}

bool SoundFontSynth::loadFromFile (const juce::File& sf2File)
{
    if (! sf2File.existsAsFile())
        return false;

    ready.store (false);
    if (synth != nullptr) { tsf_close (synth); synth = nullptr; }

    synth = tsf_load_filename (sf2File.getFullPathName().toRawUTF8());
    if (synth == nullptr)
        return false;

    tsf_channel_set_bank_preset (synth, 0, 0, 0);
    tsf_set_output (synth, TSF_STEREO_INTERLEAVED, (int) currentSampleRate, 0.0f);
    return true;
}

void SoundFontSynth::prepare (double sampleRate)
{
    currentSampleRate = sampleRate;
    if (synth != nullptr)
    {
        tsf_set_output (synth, TSF_STEREO_INTERLEAVED, (int) sampleRate, 0.0f);
        tsf_set_volume (synth, 1.0f);
        ready.store (true);
    }
}

void SoundFontSynth::programChange (int channel, int program, bool isPercussion)
{
    if (synth == nullptr) return;
    // flag_mididrums != 0 selects the percussion bank (128) for this channel.
    tsf_channel_set_presetnumber (synth, channel, program, isPercussion ? 1 : 0);
}

void SoundFontSynth::noteOn (int channel, int key, float velocity)
{
    if (synth == nullptr) return;
    tsf_channel_note_on (synth, channel, key, velocity);
}

void SoundFontSynth::noteOff (int channel, int key)
{
    if (synth == nullptr) return;
    tsf_channel_note_off (synth, channel, key);
}

void SoundFontSynth::setChannelVolume (int channel, float volume)
{
    if (synth == nullptr) return;
    tsf_channel_set_volume (synth, channel, juce::jmax (0.0f, volume));
}

void SoundFontSynth::setChannelPan (int channel, float pan)
{
    if (synth == nullptr) return;
    tsf_channel_set_pan (synth, channel, juce::jlimit (0.0f, 1.0f, pan));
}

void SoundFontSynth::allNotesOff()
{
    if (synth == nullptr) return;
    tsf_note_off_all (synth);
}

void SoundFontSynth::renderAdding (juce::AudioBuffer<float>& buffer, int startSample, int numSamples)
{
    if (synth == nullptr || ! ready.load() || numSamples <= 0)
        return;

    const auto needed = (size_t) numSamples * 2;
    if (scratch.size() < needed)
        scratch.resize (needed);

    std::fill (scratch.begin(), scratch.begin() + (long) needed, 0.0f);
    // flag_mixing = 0 -> overwrite scratch with this synth's output.
    tsf_render_float (synth, scratch.data(), numSamples, 0);

    const int outChans = buffer.getNumChannels();
    auto* left  = buffer.getWritePointer (juce::jmin (0, outChans - 1), startSample);
    auto* right = buffer.getWritePointer (juce::jmin (1, outChans - 1), startSample);

    for (int i = 0; i < numSamples; ++i)
    {
        left[i]  += scratch[(size_t) i * 2];
        right[i] += scratch[(size_t) i * 2 + 1];
    }
}
} // namespace gomidas
