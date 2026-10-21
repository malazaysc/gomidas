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

    // The peer-coordinate size that LinuxComponentPeer::forceSetBounds turns into `physicalSize`
    // when placed at `peerPosition`. forceSetBounds picks the scale from the display its
    // (logical) bounds land on, so pick the same one: try the display under the physical
    // bounds, then re-check against the display under the converted bounds.
    juce::Rectangle<int> peerBoundsForSize (juce::Rectangle<int> physicalBounds, juce::Point<int> peerPosition)
    {
        auto& desktop = juce::Desktop::getInstance();
        const auto& displays = desktop.getDisplays();
        const auto globalScale = (double) desktop.getGlobalScaleFactor();

        auto convert = [&] (const juce::Displays::Display* display)
        {
            const auto peerScale = display != nullptr && display->scale > 0 ? display->scale / globalScale : 1.0;
            return (physicalBounds.toDouble() / peerScale).toNearestInt().withPosition (peerPosition);
        };

        const auto first = convert (displays.getDisplayForRect (physicalBounds, true));
        return convert (displays.getDisplayForRect (first, false));
    }

    bool sameSize (juce::Rectangle<int> a, juce::Rectangle<int> b)
    {
        constexpr int tolerance = 2;   // physical px; absorbs scale rounding both ways
        return std::abs (a.getWidth() - b.getWidth()) <= tolerance && std::abs (a.getHeight() - b.getHeight()) <= tolerance;
    }
}

void X11BoundsSync::start()
{
    ticks = 0;
    lastMismatch.reset();
    startTimer (kIntervalMs);
}

void X11BoundsSync::timerCallback()
{
    ++ticks;
    check();

    // Stop after the window — but give a mismatch awaiting its confirming read one more tick.
    const auto elapsed = ticks * kIntervalMs;
    if (elapsed >= kWindowMs + (lastMismatch.has_value() ? kIntervalMs : 0))
        stopTimer();
}

void X11BoundsSync::check()
{
    auto* peer = window.getPeer();
    if (peer == nullptr || peer->isMinimised())
        return;

    const auto real = realPhysicalBounds (*peer);
    if (! real.has_value())
        return;

    // Compare in physical pixels: the peer's own bounds are physical / platform scale.
    const auto believed = (peer->getBounds().toDouble() * (double) peer->getPlatformScaleFactor()).toNearestInt();
    if (sameSize (believed, *real))
    {
        lastMismatch.reset();
        return;
    }

    // Adopt only a size mismatch read twice in a row, so a resize the user (or WM) is making right
    // now is never fought. Then watch a full window again: our request raises JUCE's
    // moveResizeSerial, so a re-tile the WM sends meanwhile is dropped and must be caught here.
    if (lastMismatch.has_value() && sameSize (*lastMismatch, *real))
    {
        peer->setBounds (peerBoundsForSize (*real, peer->getBounds().getPosition()), peer->isFullScreen());
        lastMismatch.reset();
        ticks = 0;
        return;
    }

    lastMismatch = real;
}
#else
void X11BoundsSync::start() {}
void X11BoundsSync::timerCallback() {}
void X11BoundsSync::check() {}
#endif
}
