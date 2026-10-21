// Own translation unit: JUCE's X11 window-system API is only declared with
// JUCE_GUI_BASICS_INCLUDE_XHEADERS, which also pulls in Xlib — whose macros (None, Bool,
// Status, …) must not leak into the rest of the app.
#define JUCE_GUI_BASICS_INCLUDE_XHEADERS 1
#include "X11WindowBounds.h"

namespace gomidas
{
#if JUCE_LINUX || JUCE_BSD
namespace
{
    // Physical, root-relative bounds the X server has for the peer's window, through JUCE's own
    // display and lock (no second connection; JUCE loads Xlib at runtime).
    std::optional<juce::Rectangle<int>> realPhysicalBounds (juce::ComponentPeer& peer)
    {
        auto* xws = juce::XWindowSystem::getInstanceWithoutCreating();
        const auto handle = (::Window) peer.getNativeHandle();
        if (xws == nullptr || handle == 0)
            return std::nullopt;

        const auto physical = xws->getWindowBounds (handle, 0);
        return physical.isEmpty() ? std::nullopt : std::optional (physical);
    }

    // The inverse of LinuxComponentPeer::forceSetBounds: the size is divided by the scale of the
    // display the bounds land on (what setBounds will multiply by), the position goes back
    // through the Displays mapping and the global scale factor.
    juce::Rectangle<int> physicalToPeerBounds (juce::Rectangle<int> physical)
    {
        auto& desktop = juce::Desktop::getInstance();
        const auto globalScale = desktop.getGlobalScaleFactor();
        const auto* display = desktop.getDisplays().getDisplayForRect (physical, true);
        const auto peerScale = display != nullptr ? display->scale / globalScale : 1.0;

        const auto size = (physical.toDouble() / (peerScale > 0 ? peerScale : 1.0)).toNearestInt();
        const auto position = desktop.getDisplays().physicalToLogical (physical.getPosition().toFloat()) * globalScale;
        return size.withPosition (position.roundToInt());
    }

    bool closeEnough (juce::Rectangle<int> a, juce::Rectangle<int> b)
    {
        constexpr int tolerance = 2;   // physical px; absorbs scale rounding both ways
        return std::abs (a.getX() - b.getX()) <= tolerance && std::abs (a.getY() - b.getY()) <= tolerance
            && std::abs (a.getWidth() - b.getWidth()) <= tolerance && std::abs (a.getHeight() - b.getHeight()) <= tolerance;
    }
}

void X11BoundsSync::start()
{
    ticks = 0;
    inSyncReads = 0;
    lastMismatch.reset();
    startTimer (kIntervalMs);
}

void X11BoundsSync::timerCallback()
{
    if (++ticks * kIntervalMs >= kWindowMs)
        stopTimer();

    auto* peer = window.getPeer();
    if (peer == nullptr || peer->isMinimised())
        return;

    const auto real = realPhysicalBounds (*peer);
    if (! real.has_value())
        return;

    // Compare in physical pixels: the peer's own bounds are physical / platform scale.
    const auto believed = (peer->getBounds().toDouble() * (double) peer->getPlatformScaleFactor()).toNearestInt();
    if (closeEnough (believed, *real))
    {
        lastMismatch.reset();
        if (++inSyncReads >= kInSyncToStop)
            stopTimer();
        return;
    }

    inSyncReads = 0;

    // Adopt only a mismatch read twice in a row, so a resize the user (or WM) is making right now
    // is never fought. Keep polling afterwards: if the WM re-tiles just after our request, JUCE
    // drops that older ConfigureNotify (its serial check), and the next reads correct it.
    if (lastMismatch == real)
    {
        peer->setBounds (physicalToPeerBounds (*real), peer->isFullScreen());
        lastMismatch.reset();
        return;
    }

    lastMismatch = real;
}
#else
void X11BoundsSync::start() {}
void X11BoundsSync::timerCallback() {}
#endif
}
