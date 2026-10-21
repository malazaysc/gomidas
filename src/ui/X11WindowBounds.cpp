// Own translation unit: JUCE's X11 window-system API is only declared with
// JUCE_GUI_BASICS_INCLUDE_XHEADERS, which also pulls in Xlib — whose macros (None, Bool,
// Status, …) must not leak into the rest of the app.
#define JUCE_GUI_BASICS_INCLUDE_XHEADERS 1
#include "X11WindowBounds.h"

namespace gomidas
{
std::optional<juce::Rectangle<int>> realPeerBounds (juce::ComponentPeer& peer)
{
   #if JUCE_LINUX || JUCE_BSD
    auto* xws = juce::XWindowSystem::getInstanceWithoutCreating();
    const auto window = (::Window) peer.getNativeHandle();
    if (xws == nullptr || window == 0)
        return std::nullopt;

    // JUCE's own display and lock; physical pixels, root-relative for a top-level window.
    const auto physical = xws->getWindowBounds (window, 0);
    if (physical.isEmpty())
        return std::nullopt;

    // Invert JUCE's own conversions (juce_Windowing_linux.cpp forceSetBounds): the size is
    // scaled by the peer's platform scale, the position goes through the display mapping and
    // the global scale factor.
    const auto platformScale = (double) peer.getPlatformScaleFactor();
    const auto size = (physical.toDouble() / (platformScale > 0 ? platformScale : 1.0)).toNearestInt();
    const auto globalScale = juce::Desktop::getInstance().getGlobalScaleFactor();
    const auto position = juce::Desktop::getInstance().getDisplays()
                              .physicalToLogical (physical.getPosition().toFloat()) * globalScale;
    return size.withPosition (position.roundToInt());
   #else
    juce::ignoreUnused (peer);
    return std::nullopt;
   #endif
}
}
