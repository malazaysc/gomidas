#pragma once
#include <juce_gui_basics/juce_gui_basics.h>
#include <optional>

namespace gomidas
{
// The bounds the X server actually has for a top-level window, converted to the peer's own
// coordinates (what ComponentPeer::getBounds/setBounds use). Linux/BSD only; std::nullopt
// elsewhere or if the window can't be queried (GOM-91).
std::optional<juce::Rectangle<int>> realPeerBounds (juce::ComponentPeer& peer);
}
