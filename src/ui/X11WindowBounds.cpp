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

    bool sameSize (juce::Rectangle<int> a, juce::Rectangle<int> b)
    {
        constexpr int tolerance = 2;   // physical px; absorbs scale rounding both ways
        return std::abs (a.getWidth() - b.getWidth()) <= tolerance && std::abs (a.getHeight() - b.getHeight()) <= tolerance;
    }
}

void X11BoundsSync::start()
{
    ticks = 0;
    if (isTimerRunning())
        return;   // already watching (e.g. focus flapping): keep a pending mismatch, just extend

    corrections = 0;
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
        lastMismatch.reset();
        if (corrections >= kMaxCorrections)
            return;   // not converging: don't loop

        // Through Component::setSize, JUCE's normal path, so position and scale handling stay
        // JUCE's own. Scale physical -> component with the same ratios `believed` used.
        const auto peerBounds = peer->getBounds();
        auto toComponent = [] (int realPhysical, double platformScale, int peerSize, int componentSize)
        {
            const auto peerUnits = realPhysical / (platformScale > 0 ? platformScale : 1.0);
            return juce::roundToInt (peerSize > 0 ? peerUnits * componentSize / peerSize : peerUnits);
        };
        const auto scale = (double) peer->getPlatformScaleFactor();
        window.setSize (toComponent (real->getWidth(),  scale, peerBounds.getWidth(),  window.getWidth()),
                        toComponent (real->getHeight(), scale, peerBounds.getHeight(), window.getHeight()));
        ++corrections;
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
